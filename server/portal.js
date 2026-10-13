'use strict';
/**
 * Client portal: a deliberately simple page each client reaches with their
 * private link. Clients upload footage, watch drafts, leave timestamped
 * feedback, approve, and see their posting schedule and basic results.
 * Every request is scoped to the one client the token belongs to.
 */
const path = require('path');
const ctx = require('./core/ctx');
const paths = require('./core/paths');
const audit = require('./core/audit');
const events = require('./core/events');
const { Router, send, serveFile, serveStatic, receiveUpload } = require('./core/http');
const { HttpError, now, id: makeId } = require('./core/util');
const pipeline = require('./automation/pipeline');
const messaging = require('./automation/messaging');

const r = new Router();
const PORTAL_DIR = path.join(__dirname, '..', 'portal');

function clientFor(token) {
  const c = ctx.store.find('clients', (x) => x.portalToken === token && x.status !== 'churned');
  if (!c) throw new HttpError(404, 'This link is no longer active');
  return c;
}
function ownClip(client, id) { const c = ctx.store.get('clips', id); if (!c || c.clientId !== client.id) throw new HttpError(404, 'Not found'); return c; }

r.get('/portal/:token', (req, res) => serveStatic(req, res, PORTAL_DIR, 'index.html'), { stream: true });
r.get('/portal/:token/assets/*', (req, res, p) => serveStatic(req, res, PORTAL_DIR, p.rest), { stream: true });

r.get('/portal/:token/api/data', (req, b, p) => {
  const c = clientFor(p.token);
  const clips = ctx.store.all('clips', (x) => x.clientId === c.id && ['client_review', 'approved', 'scheduled', 'published', 'revising'].includes(x.status) && x.versions?.length)
    .slice(-60).reverse().map((x) => ({ id: x.id, ref: x.ref, title: x.title, caption: x.caption, status: x.status, version: x.currentVersion, duration: x.versions[x.currentVersion - 1]?.duration, comments: ctx.store.all('portalComments', (m) => m.clipId === x.id).map((m) => ({ t: m.t, text: m.text, at: m.createdAt, from: m.from })) }));
  const posts = ctx.store.all('posts', (x) => x.clientId === c.id && ['scheduled', 'published'].includes(x.status)).sort((a, b2) => a.scheduledAt.localeCompare(b2.scheduledAt));
  const published = posts.filter((x) => x.status === 'published');
  const views = published.reduce((t, x) => t + Object.values(x.stats || {}).reduce((s, v) => s + (v.views || 0), 0), 0);
  return {
    client: { name: c.name, perDay: c.schedule?.shortsPerDay, platforms: c.schedule?.platforms || [] },
    agency: ctx.setting('agency.name', 'Euclidean Media'),
    review: clips.filter((x) => x.status === 'client_review'), library: clips.filter((x) => x.status !== 'client_review'),
    upcoming: posts.filter((x) => x.status === 'scheduled').slice(0, 30).map((x) => ({ title: x.title, at: x.scheduledAt, platforms: x.platforms })),
    stats: { published: published.length, views, last30: published.filter((x) => x.publishedAt > new Date(Date.now() - 30 * 864e5).toISOString()).length },
    uploads: ctx.store.all('assets', (a) => a.clientId === c.id && a.source === 'client portal').slice(-10).reverse().map((a) => ({ name: a.name, at: a.createdAt, status: a.status })),
  };
});
r.get('/portal/:token/api/clips/:id/video', (req, res, p) => { const c = clientFor(p.token); const clip = ownClip(c, p.id); const v = clip.versions[clip.currentVersion - 1]; return v ? serveFile(req, res, v.path) : send(res, 404, {}); }, { stream: true });
r.get('/portal/:token/api/clips/:id/thumb', (req, res, p) => { const c = clientFor(p.token); const clip = ownClip(c, p.id); const v = clip.versions[clip.currentVersion - 1]; return v ? serveFile(req, res, v.thumb, { cache: true }) : send(res, 404, {}); }, { stream: true });
r.post('/portal/:token/api/clips/:id/comment', (req, b, p) => {
  const c = clientFor(p.token); const clip = ownClip(c, p.id);
  const text = String(b.text || '').trim().slice(0, 2000); if (!text) throw new HttpError(400, 'Comment is empty');
  const cm = ctx.store.insert('portalComments', { clientId: c.id, clipId: clip.id, t: Math.max(0, Number(b.t) || 0), text, from: 'client', version: clip.currentVersion });
  events.publish('clips', { id: clip.id });
  return cm;
});
r.post('/portal/:token/api/clips/:id/decision', (req, b, p) => {
  const c = clientFor(p.token); const clip = ownClip(c, p.id);
  if (clip.status !== 'client_review') throw new HttpError(400, 'This video is not waiting for your review');
  const comments = ctx.store.all('portalComments', (m) => m.clipId === clip.id && m.version === clip.currentVersion);
  const fmt = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
  const note = [String(b.note || '').trim(), ...comments.map((m) => `At ${fmt(m.t)}: ${m.text}`)].filter(Boolean).join('\n');
  if (b.decision === 'changes' && !note) throw new HttpError(400, 'Tell us what to change');
  pipeline.decideClip(clip.id, b.decision === 'approve' ? 'approve' : 'changes', { actor: `portal:${c.id}`, note, stage: 'client' });
  audit.log(`portal:${c.id}`, `portal.${b.decision}`, { clientId: c.id, clipId: clip.id });
  // Mirror the decision into the client's conversation so the team sees it in the inbox.
  const contact = ctx.store.get('contacts', c.primaryContactId || (c.contactIds || [])[0]);
  if (contact) { const conv = messaging.ensureConversation(contact); messaging.addMessage(conv, { direction: 'internal', channel: 'note', status: 'note', body: `Portal: ${contact.name} ${b.decision === 'approve' ? 'approved' : 'requested changes on'} #${clip.ref} "${clip.title}"${note && b.decision !== 'approve' ? `\n${note}` : ''}` }); }
  return { ok: true };
});
r.post('/portal/:token/api/upload', async (req, b, p) => {
  const c = clientFor(p.token);
  const { files, fields } = await receiveUpload(req, paths.clientDir(c.id, 'footage'), { maxBytes: 20 * 1024 ** 3 });
  const out = [];
  for (const f of files) {
    if (!/\.(mp4|mov|m4v|mkv|webm|avi|mts|mxf|mp3|wav|m4a)$/i.test(f.name)) continue;
    const a = pipeline.addAsset({ clientId: c.id, filePath: f.path, source: 'client portal', actor: `portal:${c.id}` });
    const j = ctx.store.find('jobs', (x) => x.dedupeKey === `ingest:${a.id}`); if (j) ctx.store.update('jobs', j.id, (x) => ({ payload: { ...x.payload, autoProcess: true } }));
    out.push({ name: a.name });
  }
  if (fields.note) {
    const contact = ctx.store.get('contacts', c.primaryContactId || (c.contactIds || [])[0]);
    if (contact) messaging.addMessage(messaging.ensureConversation(contact), { direction: 'internal', channel: 'note', status: 'note', body: `Portal upload note from ${c.name}: ${String(fields.note).slice(0, 1000)}` });
  }
  events.publish('notify', { title: `${c.name} uploaded footage`, body: out.map((x) => x.name).join(', ') });
  return { uploaded: out };
}, { raw: true });

module.exports = { router: r };
