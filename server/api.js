'use strict';
/** REST API for the desktop UI, computer-use agents, remote workers and the client portal. */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const ctx = require('./core/ctx');
const paths = require('./core/paths');
const events = require('./core/events');
const audit = require('./core/audit');
const secrets = require('./core/secrets');
const { Router, send, serveFile, receiveUpload, parseBody } = require('./core/http');
const studioProxy = require('./video/proxy');
const { HttpError, now, id: makeId, monthKey } = require('./core/util');
const queue = require('./jobs/queue');
const ai = require('./integrations/ai');
const twilio = require('./integrations/twilio');
const email = require('./integrations/email');
const publishing = require('./integrations/publishing');
const pipeline = require('./automation/pipeline');
const messaging = require('./automation/messaging');
const resources = require('./automation/resources');
const health = require('./automation/health');
const finance = require('./automation/finance');
const handoff = require('./automation/handoff');
const commands = require('./commands');
const exporters = require('./video/exporters');
const ff = require('./video/ffmpeg');
const captions = require('./video/captions');

const r = new Router();
const OWNER = ['owner'];
const STAFF = ['owner', 'contractor'];
const AGENT = ['owner', 'agent'];
const WORKER = ['owner', 'worker'];

const must = (v, msg = 'Not found', code = 404) => { if (!v) throw new HttpError(code, msg); return v; };
const actorOf = (req) => req.user?.id || 'unknown';

// Secrets the UI may set. Values are write-only: the API never returns them.
const SECRET_KEYS = new Set([
  'global.anthropic.apiKey', 'global.openai.apiKey', 'global.xai.apiKey',
  ...Object.values(twilio.K), ...Object.values(email.K),
  'global.ayrshare.apiKey', 'global.google.clientId', 'global.google.clientSecret',
  ...Object.values(require('./political/sources').KEYS),
]);

// ------------------------------------------------------------ bootstrap & settings
function publicSettings() {
  const s = JSON.parse(JSON.stringify(ctx.store.settings));
  for (const k of Object.keys(s)) if (k.startsWith('_')) delete s[k];
  return s;
}
function connections() {
  return {
    ai: Object.fromEntries(Object.keys(ai.PROVIDERS).map((k) => [k, ai.connected(k)])),
    twilio: twilio.configured(), email: email.configured(), ayrshare: publishing.ayrConfigured(), google: publishing.ytConfigured(),
    secrets: secrets.status([...SECRET_KEYS]),
  };
}

r.get('/api/bootstrap', (req) => ({
  user: { id: req.user.id, name: req.user.name, role: req.user.role },
  version: ctx.version, settings: publicSettings(), capabilities: ctx.capabilities, connections: connections(),
  queue: queue.stats(), resources: resources.last, health: health.last ? health.last.summary : null, paused: queue.paused,
  commands: commands.catalog(), platforms: publishing.PLATFORMS, captionPresets: Object.keys(captions.PRESETS), captionDefaults: captions.DEFAULT_STYLE,
  dataDir: paths.root, electron: !!ctx.electron, lan: ctx.lanAddress || null,
  emailPresets: email.PRESETS,
}), { roles: ['owner', 'contractor'] });

r.get('/api/settings', () => publicSettings(), { roles: OWNER });
r.patch('/api/settings', (req, body) => {
  const clean = { ...body }; for (const k of Object.keys(clean)) if (k.startsWith('_')) delete clean[k];
  if (clean.environment && !['test', 'production'].includes(clean.environment)) throw new HttpError(400, 'Invalid environment');
  ctx.store.setSettings(clean);
  if (clean.outreach) require('./outreach/autopilot').noteSettings(clean);
  if (clean.resources?.mode) resources.setMode(clean.resources.mode, actorOf(req));
  audit.log(actorOf(req), 'settings.updated', { keys: Object.keys(clean) });
  events.publish('settings', {});
  return publicSettings();
}, { roles: OWNER });

r.get('/api/secrets/status', () => connections(), { roles: OWNER });
r.post('/api/secrets', (req, body) => {
  const changed = [];
  for (const [k, v] of Object.entries(body || {})) {
    if (!SECRET_KEYS.has(k)) throw new HttpError(400, `Unknown credential ${k}`);
    secrets.set(k, typeof v === 'string' ? v.trim() : v); changed.push(k);
  }
  audit.log(actorOf(req), 'credentials.updated', { keys: changed });
  events.publish('connections', connections());
  return connections();
}, { roles: OWNER });

r.post('/api/connections/test/:name', async (req, b, p) => {
  const n = p.name;
  if (ai.PROVIDERS[n]) return ai.test(n);
  if (n === 'twilio') return twilio.test();
  if (n === 'email') return email.test();
  if (n === 'ayrshare') return publishing.ayrTest();
  throw new HttpError(404, 'Unknown connection');
}, { roles: OWNER });

// ------------------------------------------------------------ users / tokens
r.get('/api/users', () => ctx.store.all('users').map(({ token, ...u }) => ({ ...u, tokenHint: token.slice(-4) })), { roles: OWNER });
r.post('/api/users', (req, b) => {
  if (!['owner', 'contractor', 'agent', 'worker'].includes(b.role)) throw new HttpError(400, 'Role must be owner, contractor, agent or worker');
  const token = 'eu_' + crypto.randomBytes(24).toString('base64url');
  const u = ctx.store.insert('users', { id: makeId('u_'), name: String(b.name || 'User').slice(0, 60), role: b.role, token });
  audit.log(actorOf(req), 'user.created', { userId: u.id, role: u.role });
  return { ...u };
}, { roles: OWNER });
r.del('/api/users/:id', (req, b, p) => {
  const u = must(ctx.store.get('users', p.id));
  if (u.role === 'owner' && ctx.store.all('users', (x) => x.role === 'owner').length <= 1) throw new HttpError(400, 'Keep at least one owner');
  ctx.store.remove('users', p.id); audit.log(actorOf(req), 'user.revoked', { userId: p.id });
  return { ok: true };
}, { roles: OWNER });

// ------------------------------------------------------------ command center
r.get('/api/commands', () => commands.catalog());
r.post('/api/command', async (req, b) => {
  const text = String(b.text || '').trim();
  if (!text) throw new HttpError(400, 'Empty command');
  const conv = b.conversationId ? ctx.store.get('conversations', b.conversationId) : messaging.commandConversation();
  const isCommandThread = !conv || conv.kind === 'command';
  const thread = isCommandThread ? messaging.commandConversation() : conv;
  if (isCommandThread) messaging.addMessage(thread, { direction: 'out', channel: 'command', body: text, status: 'sent', createdBy: actorOf(req) });
  events.publish('typing', { conversationId: thread.id, on: true });
  let res;
  try { res = await commands.execute(text, { actor: actorOf(req), conversationId: thread.id, clientId: b.clientId || conv?.clientId || null }); }
  finally { events.publish('typing', { conversationId: thread.id, on: false }); }
  if (isCommandThread || !res.silent) {
    messaging.addMessage(thread, { direction: isCommandThread ? 'in' : 'internal', channel: isCommandThread ? 'system' : 'note', body: res.text, status: isCommandThread ? 'received' : 'note', card: res.card || null, navigate: res.navigate || null, error: !!res.error, agent: res.agent || null });
  }
  if (isCommandThread) ctx.store.update('conversations', thread.id, { unread: 0 });
  return res;
});

// ------------------------------------------------------------ conversations & messages
r.get('/api/conversations', (req) => {
  messaging.commandConversation();
  return ctx.store.all('conversations', (c) => !c.archived || req.query.archived).map((c) => {
    const contact = c.contactId ? ctx.store.get('contacts', c.contactId) : null;
    return { ...c, contact: contact ? { id: contact.id, name: contact.name, role: contact.role, phones: contact.phones, emails: contact.emails, clientId: contact.clientId, optedOut: contact.optedOut } : null, pendingApprovals: ctx.store.all('messages', (m) => m.conversationId === c.id && m.status === 'pending_approval').length };
  }).sort((a, b) => (b.pinned - a.pinned) || b.lastMessageAt.localeCompare(a.lastMessageAt));
});
r.get('/api/conversations/:id/messages', (req, b, p) => {
  must(ctx.store.get('conversations', p.id));
  const all = ctx.store.all('messages', (m) => m.conversationId === p.id);
  const before = req.query.before; const list = before ? all.filter((m) => m.createdAt < before) : all;
  return list.slice(-Number(req.query.limit || 150));
});
r.post('/api/conversations/:id/read', (req, b, p) => { const c = must(ctx.store.get('conversations', p.id)); ctx.store.update('conversations', c.id, { unread: 0 }); events.publish('conversation', ctx.store.get('conversations', c.id)); return { ok: true }; });
r.patch('/api/conversations/:id', (req, b, p) => { must(ctx.store.get('conversations', p.id)); const patch = {}; for (const k of ['pinned', 'archived', 'title']) if (b[k] !== undefined) patch[k] = b[k]; const c = ctx.store.update('conversations', p.id, patch); events.publish('conversation', c); return c; });
r.post('/api/conversations/:id/messages', (req, b, p) => {
  const conv = must(ctx.store.get('conversations', p.id));
  if (b.internal) return messaging.addMessage(conv, { direction: 'internal', channel: 'note', body: String(b.body || ''), status: 'note', createdBy: actorOf(req) });
  return messaging.createOutbound({ conversationId: conv.id, channel: b.channel, subject: b.subject, body: String(b.body || '').trim() || (() => { throw new HttpError(400, 'Message is empty'); })(), sendAt: b.sendAt, actor: actorOf(req) });
});
r.post('/api/conversations/:id/ai-draft', async (req, b, p) => {
  const conv = must(ctx.store.get('conversations', p.id)); const contact = must(ctx.store.get('contacts', conv.contactId));
  const history = ctx.store.all('messages', (m) => m.conversationId === conv.id && m.direction !== 'internal').slice(-14).map((m) => `${m.direction === 'in' ? contact.name : 'Agency'}: ${m.body}`).join('\n');
  const res = await ai.ask({ role: 'writing', clientId: contact.clientId, json: true, system: 'You draft replies for Euclidean Media founders: plain, warm, direct, short. Never invent prices, dates or promises.', prompt: `Thread with ${contact.name} (${contact.role}). ${b.instruction ? `Instruction: ${b.instruction}` : 'Write the best next reply.'}\n\n${history}\n\nReturn {"body":"..."}` });
  return { body: res.json.body, agent: `${res.provider}:${res.model}` };
});
r.post('/api/messages/:id/approve', (req, b, p) => { messaging.approveMessage(p.id, actorOf(req), b.body); return ctx.store.get('messages', p.id); }, { roles: OWNER });
r.post('/api/messages/:id/discard', (req, b, p) => { messaging.rejectMessage(p.id, actorOf(req)); return ctx.store.get('messages', p.id); });
r.get('/api/search', (req) => {
  const q = String(req.query.q || '').toLowerCase().trim(); if (q.length < 2) return [];
  return ctx.store.all('messages', (m) => (m.body || '').toLowerCase().includes(q) || (m.subject || '').toLowerCase().includes(q)).slice(-40).reverse()
    .map((m) => ({ id: m.id, conversationId: m.conversationId, body: m.body.slice(0, 200), at: m.createdAt, title: ctx.store.get('conversations', m.conversationId)?.title }));
});

// ------------------------------------------------------------ contacts
r.get('/api/contacts', () => ctx.store.all('contacts'));
r.post('/api/contacts', (req, b) => {
  const phones = (b.phones || (b.phone ? [b.phone] : [])).map(twilio.normalize).filter(Boolean);
  const emails = (b.emails || (b.email ? [b.email] : [])).map((e) => String(e).trim().toLowerCase()).filter(Boolean);
  if (!b.name) throw new HttpError(400, 'Name is required');
  const c = ctx.store.insert('contacts', { name: b.name, phones, emails, role: b.role || (b.clientId ? 'client' : 'other'), clientId: b.clientId || null, optedOut: {}, title: b.title || '', preferredChannel: b.preferredChannel || null, notes: b.notes || '' });
  if (c.clientId) ctx.store.update('clients', c.clientId, (cl) => ({ contactIds: [...new Set([...(cl.contactIds || []), c.id])], primaryContactId: cl.primaryContactId || c.id }));
  messaging.ensureConversation(c);
  events.publish('contacts', c);
  return c;
});
r.patch('/api/contacts/:id', (req, b, p) => {
  const prev = must(ctx.store.get('contacts', p.id)); const patch = {};
  for (const k of ['name', 'role', 'clientId', 'title', 'preferredChannel', 'notes', 'optedOut']) if (b[k] !== undefined) patch[k] = b[k];
  if (b.phones) patch.phones = b.phones.map(twilio.normalize).filter(Boolean);
  if (b.emails) patch.emails = b.emails.map((e) => String(e).trim().toLowerCase()).filter(Boolean);
  const c = ctx.store.update('contacts', p.id, patch);
  if (patch.clientId && patch.clientId !== prev.clientId) ctx.store.update('clients', patch.clientId, (cl) => ({ contactIds: [...new Set([...(cl.contactIds || []), c.id])], primaryContactId: cl.primaryContactId || c.id }));
  const conv = ctx.store.find('conversations', (x) => x.contactId === c.id); if (conv) ctx.store.update('conversations', conv.id, { title: c.name, clientId: c.clientId || null });
  events.publish('contacts', c);
  return c;
});

// ------------------------------------------------------------ clients
function clientView(c, full = false) {
  const v = { ...c, quota: c.status === 'active' ? pipeline.quotaStatus(c) : null, monthly: finance.monthly(c.retainer), portalUrl: pipeline.portalUrl(c), hasAyrshareProfile: secrets.has(`client.${c.id}.ayrshare.profileKey`), youtubeConnected: secrets.has(`client.${c.id}.youtube.token`) };
  if (!full) { delete v.portalToken; }
  return v;
}
r.get('/api/clients', () => ctx.store.all('clients').map((c) => clientView(c)));
r.post('/api/clients', (req, b) => { if (!b.name) throw new HttpError(400, 'Name is required'); return clientView(pipeline.createClient(b, actorOf(req))); }, { roles: OWNER });
r.get('/api/clients/:id', (req, b, p) => {
  const c = must(ctx.store.get('clients', p.id));
  return { ...clientView(c, true), contacts: ctx.store.all('contacts', (x) => x.clientId === c.id), assets: ctx.store.all('assets', (a) => a.clientId === c.id).slice(-40).reverse(), upcomingSlots: pipeline.upcomingSlots(c, 2) };
});
r.patch('/api/clients/:id', (req, b, p) => {
  const c = must(ctx.store.get('clients', p.id));
  const patch = {};
  for (const k of ['name', 'type', 'status', 'package', 'notes', 'primaryContactId']) if (b[k] !== undefined) patch[k] = b[k];
  for (const k of ['retainer', 'profile', 'production', 'schedule', 'approval']) if (b[k]) patch[k] = { ...(c[k] || {}), ...b[k] };
  if (b.style) patch.style = { ...(c.style || {}), ...pipeline.sanitizeStyle(b.style) };
  if (b.graphics) patch.graphics = captions.resolveGraphics({ ...(c.graphics || {}), ...b.graphics });
  if (b.sources) patch.sources = b.sources;
  if (patch.status === 'churned' && c.status !== 'churned') patch.churnedAt = now();
  const u = ctx.store.update('clients', c.id, patch);
  pipeline.enforceApprovalPolicy(u);
  audit.log(actorOf(req), 'client.updated', { clientId: c.id, keys: Object.keys(patch) });
  events.publish('clients', { id: c.id });
  return clientView(ctx.store.get('clients', c.id), true);
}, { roles: OWNER });
r.post('/api/clients/:id/memory', (req, b, p) => { must(ctx.store.get('clients', p.id)); return pipeline.remember(p.id, [{ text: b.text, style: b.style ? pipeline.sanitizeStyle(b.style) : null }], { source: 'manual', actor: actorOf(req) }); });
r.patch('/api/clients/:id/memory/:mid', (req, b, p) => {
  ctx.store.update('clients', p.id, (c) => ({ memory: (c.memory || []).map((m) => (m.id === p.mid ? { ...m, active: b.active ?? m.active, text: b.text ?? m.text } : m)) }));
  return { ok: true };
});
r.del('/api/clients/:id/memory/:mid', (req, b, p) => { ctx.store.update('clients', p.id, (c) => ({ memory: (c.memory || []).filter((m) => m.id !== p.mid) })); audit.log(actorOf(req), 'client.memory_removed', { clientId: p.id }); return { ok: true }; });
r.post('/api/clients/:id/credentials', (req, b, p) => {
  must(ctx.store.get('clients', p.id));
  if (b.ayrshareProfileKey !== undefined) secrets.set(`client.${p.id}.ayrshare.profileKey`, b.ayrshareProfileKey);
  audit.log(actorOf(req), 'client.credentials_updated', { clientId: p.id });
  return { ok: true };
}, { roles: OWNER });
r.post('/api/clients/:id/youtube/connect', async (req, b, p) => { must(ctx.store.get('clients', p.id)); const url = await publishing.ytBeginAuth(p.id); if (ctx.openExternal) ctx.openExternal(url); return { url }; }, { roles: OWNER });
r.post('/api/clients/:id/upload', async (req, b, p) => {
  const c = must(ctx.store.get('clients', p.id));
  const { files, fields } = await receiveUpload(req, paths.clientDir(c.id, 'footage'));
  const out = [];
  for (const f of files) {
    if (fields.kind === 'logo') { ctx.store.update('clients', c.id, (x) => ({ production: { ...x.production, logoPath: f.path } })); out.push({ logo: f.path }); continue; }
    out.push(pipeline.addAsset({ clientId: c.id, filePath: f.path, source: 'upload', actor: actorOf(req) }));
    if (fields.autoProcess === 'true') { const j = ctx.store.find('jobs', (x) => x.dedupeKey === `ingest:${out[out.length - 1].id}`); if (j) ctx.store.update('jobs', j.id, (x) => ({ payload: { ...x.payload, autoProcess: true } })); }
  }
  return out;
}, { raw: true });
r.post('/api/clients/:id/autopilot-now', (req, b, p) => { const c = must(ctx.store.get('clients', p.id)); return require('./automation/scheduler').feedClient(c); });

// ------------------------------------------------------------ assets (footage)
r.get('/api/assets', (req) => ctx.store.all('assets', (a) => !req.query.clientId || a.clientId === req.query.clientId).reverse());
r.post('/api/assets', (req, b) => {
  if (b.url) return queue.enqueue('ingest.url', { url: b.url, clientId: b.clientId, autoProcess: !!b.autoProcess }, { clientId: b.clientId, actor: actorOf(req) });
  const a = pipeline.addAsset({ clientId: b.clientId, filePath: b.path, source: 'local file', actor: actorOf(req) });
  if (b.autoProcess) { const j = ctx.store.find('jobs', (x) => x.dedupeKey === `ingest:${a.id}`); if (j) ctx.store.update('jobs', j.id, (x) => ({ payload: { ...x.payload, autoProcess: true } })); }
  return a;
});
r.post('/api/assets/:id/process', (req, b, p) => {
  const a = must(ctx.store.get('assets', p.id));
  if (!a.transcript && a.info?.hasAudio) return queue.enqueue('transcribe', { assetId: a.id, thenDiscover: true }, { clientId: a.clientId, actor: actorOf(req), dedupeKey: `transcribe:${a.id}` });
  return queue.enqueue('discover', { assetId: a.id, count: b.count }, { clientId: a.clientId, actor: actorOf(req) });
});
r.get('/api/assets/:id/media', (req, res, p) => serveFile(req, res, must(ctx.store.get('assets', p.id)).path), { stream: true });
r.get('/api/assets/:id/thumb', (req, res, p) => { const a = must(ctx.store.get('assets', p.id)); return a.thumb ? serveFile(req, res, a.thumb, { cache: true }) : send(res, 404, {}); }, { stream: true });
r.get('/api/assets/:id/filmstrip', (req, res, p) => { const a = must(ctx.store.get('assets', p.id)); return a.filmstrip ? serveFile(req, res, a.filmstrip, { cache: true }) : send(res, 404, {}); }, { stream: true });
r.get('/api/assets/:id/waveform', (req, b, p) => { const a = must(ctx.store.get('assets', p.id)); const f = path.join(a.workDir, 'waveform.json'); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : []; });
r.get('/api/assets/:id/transcript', (req, b, p) => { const a = must(ctx.store.get('assets', p.id)); return require('./jobs/handlers').loadTranscript(a) || { words: [], segments: [] }; });
r.del('/api/assets/:id', (req, b, p) => { const a = must(ctx.store.get('assets', p.id)); ctx.store.remove('assets', a.id); audit.log(actorOf(req), 'footage.removed', { clientId: a.clientId, assetId: a.id }); return { ok: true }; }, { roles: OWNER });

// ------------------------------------------------------------ clips
function clipView(c) {
  const v = c.versions?.[c.currentVersion - 1];
  return { ...c, client: ctx.store.get('clients', c.clientId)?.name, asset: ctx.store.get('assets', c.assetId)?.name, current: v ? { n: v.n, duration: v.duration, qc: v.qc, renderedAt: v.renderedAt, captioned: v.captioned, encoder: v.encoder } : null, post: c.postId ? ctx.store.get('posts', c.postId) : null };
}
r.get('/api/clips', (req) => ctx.store.all('clips', (c) => (!req.query.clientId || c.clientId === req.query.clientId) && (!req.query.status || req.query.status.split(',').includes(c.status))).slice(-Number(req.query.limit || 200)).reverse().map(clipView));
r.get('/api/clips/:id', (req, b, p) => clipView(must(ctx.store.get('clips', p.id))));
r.patch('/api/clips/:id', (req, b, p) => {
  const c = must(ctx.store.get('clips', p.id)); const patch = {};
  for (const k of ['title', 'hook', 'caption', 'hashtags', 'start', 'end', 'reframe', 'focusX', 'silenceCut', 'punchIns']) if (b[k] !== undefined) patch[k] = b[k];
  const u = ctx.store.update('clips', c.id, patch);
  if (c.postId && (patch.title || patch.caption || patch.hashtags)) ctx.store.update('posts', c.postId, { title: u.title, caption: u.caption, hashtags: u.hashtags });
  events.publish('clips', { id: c.id });
  return clipView(u);
});
r.post('/api/clips/:id/render', (req, b, p) => { const c = must(ctx.store.get('clips', p.id)); return pipeline.requestRender(c, { reason: 'manual' }); });
r.post('/api/clips/:id/decide', (req, b, p) => clipView(pipeline.decideClip(p.id, b.decision, { actor: actorOf(req), note: b.note || '', stage: b.stage })));
r.post('/api/clips/:id/version', (req, b, p) => { const c = must(ctx.store.get('clips', p.id)); const n = Number(b.n); if (!c.versions[n - 1]) throw new HttpError(400, 'No such version'); return clipView(ctx.store.update('clips', c.id, { currentVersion: n })); });
function versionFile(c, req, kind) {
  const n = Number(req.query.v || c.currentVersion); const v = must(c.versions?.[n - 1], 'Not rendered yet');
  return { mp4: v.path, thumb: v.thumb, srt: v.srt, velo: v.velo, xml: v.xml }[kind];
}
r.get('/api/clips/:id/video', (req, res, p) => serveFile(req, res, versionFile(must(ctx.store.get('clips', p.id)), req, 'mp4')), { stream: true });
r.get('/api/clips/:id/thumb', (req, res, p) => serveFile(req, res, versionFile(must(ctx.store.get('clips', p.id)), req, 'thumb'), { cache: true }), { stream: true });
r.get('/api/clips/:id/download/:kind', (req, res, p) => { const c = must(ctx.store.get('clips', p.id)); const f = must(versionFile(c, req, p.kind), 'No such file'); return serveFile(req, res, f, { download: `${c.ref}-${path.basename(f)}` }); }, { stream: true });
r.post('/api/clips/:id/premiere', (req, b, p) => { const c = must(ctx.store.get('clips', p.id)); return queue.enqueue('premiere.handoff', { clipId: c.id, reason: 'manual' }, { clientId: c.clientId, actor: actorOf(req), title: `Premiere edit: ${c.title}` }); });
r.post('/api/clips/:id/open-velo', (req, b, p) => {
  const c = must(ctx.store.get('clips', p.id)); const f = versionFile(c, req, 'velo');
  const velo = ctx.setting('tools.veloPath', '');
  if (velo && fs.existsSync(velo)) { spawn(velo, [f], { detached: true, stdio: 'ignore' }).unref(); return { ok: true, opened: 'velo' }; }
  if (ctx.openPath) { ctx.openPath(f); return { ok: true, opened: 'default' }; }
  throw new HttpError(400, 'Set the Velo executable path in Settings → System to open projects in Velo');
});
r.post('/api/clips/:id/studio', (req, b, p) => {
  const c = must(ctx.store.get('clips', p.id)); const a = ctx.store.get('assets', c.assetId); const client = ctx.store.get('clients', c.clientId);
  const words = require('./jobs/handlers').loadTranscript(a)?.words || [];
  const data = exporters.toVelo({ name: c.title, source: a.path, info: a.info, range: { start: c.start, end: c.end }, words, style: client.style, hook: c.hook, focusX: c.focusX });
  return ctx.store.insert('projects', { name: `#${c.ref} ${c.title}`, clientId: c.clientId, clipId: c.id, data, exports: [] });
});

// ------------------------------------------------------------ approvals
r.get('/api/approvals', (req) => {
  const status = req.query.status || 'pending';
  return ctx.store.all('approvals', (a) => status === 'all' || a.status === status).reverse().map((a) => {
    const ref = a.kind === 'clip' ? ctx.store.get('clips', a.refId) : a.kind === 'message' ? ctx.store.get('messages', a.refId) : null;
    const extra = a.kind === 'message' && ref ? { contact: ctx.store.get('contacts', ref.contactId)?.name, channel: ref.channel, body: ref.body, subject: ref.subject } : {};
    return { ...a, client: a.clientId ? ctx.store.get('clients', a.clientId)?.name : null, ref: ref ? (a.kind === 'clip' ? clipView(ref) : ref) : null, ...extra };
  }).filter((a) => a.ref);
});

// ------------------------------------------------------------ posts
r.get('/api/posts', (req) => ctx.store.all('posts', (p) => (!req.query.clientId || p.clientId === req.query.clientId) && (!req.query.status || req.query.status.split(',').includes(p.status))).map((p) => ({ ...p, client: ctx.store.get('clients', p.clientId)?.name, ref: ctx.store.get('clips', p.clipId)?.ref })));
r.post('/api/posts/:id/unschedule', (req, b, p) => { pipeline.unschedule(p.id, actorOf(req)); return { ok: true }; });
r.post('/api/posts/:id/reschedule', (req, b, p) => {
  const post = must(ctx.store.get('posts', p.id)); if (post.status !== 'scheduled') throw new HttpError(400, 'Only scheduled posts can move');
  const at = new Date(b.at); if (isNaN(at) || at < new Date()) throw new HttpError(400, 'Pick a future time');
  ctx.store.update('posts', post.id, { scheduledAt: at.toISOString(), platforms: b.platforms || post.platforms });
  const job = ctx.store.find('jobs', (j) => j.dedupeKey === `publish:${post.id}` && j.status === 'queued');
  if (job) ctx.store.update('jobs', job.id, { runAt: new Date(at.getTime() - 15 * 60000).toISOString() });
  audit.log(actorOf(req), 'post.rescheduled', { postId: post.id, clientId: post.clientId, at: at.toISOString() });
  events.publish('posts', { id: post.id });
  return ctx.store.get('posts', post.id);
});
r.get('/api/posts/:id/package', (req, res, p) => { const post = must(ctx.store.get('posts', p.id)); if (post.packagePath && ctx.revealFile) ctx.revealFile(post.packagePath); return send(res, 200, { path: post.packagePath || null }); }, { stream: true });

// ------------------------------------------------------------ jobs / queue
r.get('/api/jobs', (req) => ctx.store.all('jobs', (j) => (!req.query.status || req.query.status.split(',').includes(j.status)) && (!req.query.clientId || j.clientId === req.query.clientId)).slice(-Number(req.query.limit || 300)).reverse().map(queue.slim));
r.get('/api/jobs/:id', (req, b, p) => must(ctx.store.get('jobs', p.id)));
r.post('/api/jobs/:id/cancel', (req, b, p) => must(queue.cancel(p.id, actorOf(req))));
r.post('/api/jobs/:id/retry', (req, b, p) => must(queue.retry(p.id)));
r.post('/api/queue/pause', (req) => { queue.setPaused(true); ctx.store.setSettings({ _paused: true }); audit.log(actorOf(req), 'automation.paused', {}, 'warn'); return queue.stats(); });
r.post('/api/queue/resume', (req) => { queue.setPaused(false); ctx.store.setSettings({ _paused: false }); audit.log(actorOf(req), 'automation.resumed', {}); return queue.stats(); });
r.get('/api/queue/stats', () => queue.stats());

// ------------------------------------------------------------ computer-use agents (Astra)
function workOrder(job) {
  const clip = ctx.store.get('clips', job.payload.clipId); const asset = clip && ctx.store.get('assets', clip.assetId); const client = clip && ctx.store.get('clients', clip.clientId);
  if (!clip) return null;
  const dir = paths.clientDir(client.id, 'premiere', job.id);
  const words = require('./jobs/handlers').loadTranscript(asset)?.words || [];
  const range = { start: clip.start, end: clip.end };
  const xml = path.join(dir, 'sequence.xml'); const srt = path.join(dir, 'captions.srt'); const brief = path.join(dir, 'brief.txt');
  if (!fs.existsSync(xml)) {
    fs.writeFileSync(xml, exporters.toFcpXml({ name: `${client.name} #${clip.ref}`, source: asset.path, info: asset.info, range }));
    fs.writeFileSync(srt, captions.buildSrt({ words, range, style: client.style }));
    const mem = (client.memory || []).filter((m) => m.active !== false).map((m) => `- ${m.text}`).join('\n');
    fs.writeFileSync(brief, [`CLIENT: ${client.name} (${client.type})`, `CLIP #${clip.ref}: ${clip.title}`, `HOOK (on-screen, first 3s): ${clip.hook || '(none)'}`, `SOURCE: ${asset.path}`, `RANGE: ${range.start.toFixed(2)}s – ${range.end.toFixed(2)}s`, `FORMAT: 1080×1920, 30 fps, H.264, -14 LUFS`,
      `CAPTIONS: import captions.srt; style ${client.style.uppercase ? 'UPPERCASE' : 'sentence case'}, ${client.style.wordsPerLine} words/line, highlight ${client.style.highlight}`, `CLIENT PREFERENCES:\n${mem || '- none recorded'}`,
      clip.feedback?.length ? `LATEST FEEDBACK: ${clip.feedback[clip.feedback.length - 1].text}` : '', `EXPORT TO: ${path.join(dir, 'output.mp4')}`].filter(Boolean).join('\n'));
  }
  const files = ['sequence.xml', 'captions.srt', 'brief.txt'].map((n) => ({ name: n, path: path.join(dir, n), url: `/api/agent/jobs/${job.id}/files/${n}` }));
  return { jobId: job.id, clipId: clip.id, ref: clip.ref, client: client.name, title: clip.title, source: asset.path, range, files, outputPath: path.join(dir, 'output.mp4'), brief: fs.readFileSync(brief, 'utf8'), instructions: 'In Premiere Pro: File → Import sequence.xml, open the sequence, import captions.srt onto a caption track, apply the brief, then File → Export → Media (H.264, Match Source 1080×1920) to outputPath. Call /complete when the file is written.' };
}
r.get('/api/agent/next', (req) => {
  const cap = req.query.capability || 'premiere';
  handoff.touch(req.user.name, cap);
  const job = ctx.store.all('jobs', (j) => j.status === 'waiting_agent' && j.type === 'premiere.handoff').sort((a, b) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt))[0];
  if (!job) return { job: null };
  ctx.store.update('jobs', job.id, { status: 'running', workerId: `agent:${req.user.name}`, startedAt: now(), attempts: job.attempts + 1, note: `Claimed by ${req.user.name}` });
  queue.publish(ctx.store.get('jobs', job.id));
  audit.log(`agent:${req.user.name}`, 'agent.claimed', { jobId: job.id, clientId: job.clientId });
  return { job: workOrder(job) };
}, { roles: AGENT });
r.get('/api/agent/jobs/:id/files/:name', (req, res, p) => {
  const job = must(ctx.store.get('jobs', p.id)); const clip = ctx.store.get('clips', job.payload.clipId);
  const f = path.join(paths.clientDir(clip.clientId, 'premiere', job.id), path.basename(p.name));
  return serveFile(req, res, f, { download: path.basename(f) });
}, { roles: AGENT, stream: true });
r.post('/api/agent/jobs/:id/progress', (req, b, p) => { const j = must(ctx.store.get('jobs', p.id)); handoff.touch(req.user.name, 'premiere'); j.progress = Math.max(0, Math.min(1, Number(b.progress) || 0)); j.note = String(b.note || '').slice(0, 200); queue.publish(j); return { ok: true }; }, { roles: AGENT });
r.post('/api/agent/jobs/:id/complete', async (req, b, p) => {
  const job = must(ctx.store.get('jobs', p.id)); const clip = must(ctx.store.get('clips', job.payload.clipId));
  const out = b.outputPath; if (!out || !fs.existsSync(out)) throw new HttpError(400, `Output file not found: ${out}`);
  const qc = await ff.qualityCheck(out, { expectWidth: 1080, expectHeight: 1920, minSec: 3, maxSec: 180 });
  const dir = paths.clientDir(clip.clientId, 'renders', clip.id); const n = (clip.versions || []).length + 1;
  const dest = path.join(dir, `v${n}-premiere.mp4`); fs.copyFileSync(out, dest);
  const thumb = path.join(dir, `v${n}.jpg`); await ff.thumbnail(dest, thumb, 1.5, 405);
  const wo = path.join(paths.clientDir(clip.clientId, 'premiere', job.id));
  ctx.store.update('clips', clip.id, (c) => ({ versions: [...(c.versions || []), { n, path: dest, thumb, duration: qc.info.duration, renderedAt: now(), encoder: 'Adobe Premiere Pro', qc: { passed: qc.passed, issues: qc.issues }, srt: path.join(wo, 'captions.srt'), xml: path.join(wo, 'sequence.xml'), velo: null, editedBy: req.user.name, captioned: true }], currentVersion: n }));
  ctx.store.update('jobs', job.id, { status: 'done', progress: 1, finishedAt: now(), result: { outputPath: dest, qc: qc.passed }, note: 'Completed in Premiere' });
  queue.publish(ctx.store.get('jobs', job.id));
  audit.log(`agent:${req.user.name}`, 'agent.completed', { jobId: job.id, clientId: clip.clientId, clipId: clip.id });
  pipeline.afterQc(clip.id, qc);
  return { ok: true, qc };
}, { roles: AGENT });
r.post('/api/agent/jobs/:id/fail', (req, b, p) => {
  const job = must(ctx.store.get('jobs', p.id));
  const retry = job.attempts < job.maxAttempts;
  ctx.store.update('jobs', job.id, { status: retry ? 'waiting_agent' : 'failed', error: String(b.error || 'Agent reported failure'), note: retry ? 'Returned to the agent queue' : 'Failed', finishedAt: retry ? null : now() });
  if (!retry) { const clip = ctx.store.get('clips', job.payload.clipId); if (clip) { ctx.store.update('clips', clip.id, { status: 'review' }); } }
  queue.publish(ctx.store.get('jobs', job.id));
  audit.log(`agent:${req.user.name}`, 'agent.failed', { jobId: job.id, error: b.error }, 'warn');
  return { ok: true };
}, { roles: AGENT });
// Any agent can drive Euclidean with the same command list people use.
r.post('/api/agent/command', async (req, b) => { handoff.touch(req.user.name, 'command'); return commands.execute(String(b.text || ''), { actor: `agent:${req.user.name}`, viaAgent: true, clientId: b.clientId || null }); }, { roles: AGENT });
r.get('/api/agent/commands', () => commands.catalog(), { roles: AGENT });

// ------------------------------------------------------------ remote workers (editing desktop)
r.post('/api/workers/register', (req, b) => {
  const name = String(b.name || req.user.name).slice(0, 60);
  let w = ctx.store.find('workers', (x) => x.name === name);
  const data = { name, capabilities: b.capabilities || ['render.short'], specs: b.specs || {}, lastSeen: now(), userId: req.user.id };
  w = w ? ctx.store.update('workers', w.id, data) : ctx.store.insert('workers', data);
  return { workerId: w.id };
}, { roles: WORKER });
r.post('/api/workers/lease', (req, b) => {
  const w = must(ctx.store.get('workers', b.workerId), 'Unknown worker'); ctx.store.update('workers', w.id, { lastSeen: now(), resources: b.resources || null });
  const job = queue.lease(w.name, w.capabilities);
  if (!job) return { job: null };
  return { job: { id: job.id, type: job.type, spec: renderSpec(job) } };
}, { roles: WORKER });
function renderSpec(job) {
  const clip = ctx.store.get('clips', job.payload.clipId); const asset = ctx.store.get('assets', clip.assetId); const client = ctx.store.get('clients', clip.clientId);
  const t = require('./jobs/handlers').loadTranscript(asset);
  return { clipId: clip.id, title: clip.title, assetId: asset.id, sourceName: path.basename(asset.path), sourceSize: fs.statSync(asset.path).size, sourceUrl: `/api/workers/jobs/${job.id}/source`, info: asset.info, range: { start: clip.start, end: clip.end }, words: t?.words || [], style: client.style, hook: clip.hook, reframe: clip.reframe, focusX: clip.focusX, facePath: clip.faceTrack && clip.faceTrack.start === clip.start && clip.faceTrack.end === clip.end && clip.faceTrack.coverage >= 0.15 ? clip.faceTrack.path : null, graphics: client.graphics, plan: { silenceCut: clip.silenceCut && !!t, punchIns: clip.punchIns }, crf: ctx.setting('production.crf', 20), loudness: ctx.setting('production.loudnessLufs', -14) };
}
r.get('/api/workers/jobs/:id/source', (req, res, p) => { const job = must(ctx.store.get('jobs', p.id)); const clip = ctx.store.get('clips', job.payload.clipId); return serveFile(req, res, ctx.store.get('assets', clip.assetId).path); }, { roles: WORKER, stream: true });
r.post('/api/workers/jobs/:id/heartbeat', (req, b, p) => ({ ok: queue.heartbeat(p.id, b.worker, b.progress, b.note) }), { roles: WORKER });
r.post('/api/workers/jobs/:id/result', async (req, b, p) => {
  const job = must(ctx.store.get('jobs', p.id)); const clip = must(ctx.store.get('clips', job.payload.clipId));
  const dir = paths.clientDir(clip.clientId, 'renders', clip.id);
  const { files, fields } = await receiveUpload(req, dir);
  const mp4 = files.find((f) => f.name.endsWith('.mp4')); if (!mp4) throw new HttpError(400, 'No video uploaded');
  const n = (clip.versions || []).length + 1; const dest = path.join(dir, `v${n}-${fields.worker || 'worker'}.mp4`); fs.renameSync(mp4.path, dest);
  const srt = files.find((f) => f.name.endsWith('.srt'));
  const qc = await ff.qualityCheck(dest, { expectWidth: 1080, expectHeight: 1920, minSec: 5, maxSec: 180 });
  const thumb = path.join(dir, `v${n}.jpg`); await ff.thumbnail(dest, thumb, 1.5, 405);
  const asset = ctx.store.get('assets', clip.assetId); const client = ctx.store.get('clients', clip.clientId);
  const velo = path.join(dir, `v${n}.velo`); fs.writeFileSync(velo, JSON.stringify(exporters.toVelo({ name: clip.title, source: asset.path, info: asset.info, range: { start: clip.start, end: clip.end }, words: require('./jobs/handlers').loadTranscript(asset)?.words || [], style: client.style, hook: clip.hook, focusX: clip.focusX })));
  const xml = path.join(dir, `v${n}.premiere.xml`); fs.writeFileSync(xml, exporters.toFcpXml({ name: clip.title, source: asset.path, info: asset.info, range: { start: clip.start, end: clip.end } }));
  ctx.store.update('clips', clip.id, (c) => ({ versions: [...(c.versions || []), { n, path: dest, thumb, duration: qc.info.duration, renderedAt: now(), encoder: fields.encoder || 'worker', qc: { passed: qc.passed, issues: qc.issues }, srt: srt?.path || null, velo, xml, renderedBy: fields.worker, changes: c.pendingChanges || null, captioned: fields.captioned === 'true' }], currentVersion: n, pendingChanges: null }));
  ctx.store.update('jobs', job.id, { status: 'done', progress: 1, finishedAt: now(), result: { version: n, worker: fields.worker }, note: `Rendered on ${fields.worker}` });
  queue.publish(ctx.store.get('jobs', job.id));
  pipeline.afterQc(clip.id, qc);
  return { ok: true };
}, { roles: WORKER, raw: true });
r.post('/api/workers/jobs/:id/fail', (req, b, p) => {
  const job = must(ctx.store.get('jobs', p.id)); const retry = job.attempts < job.maxAttempts;
  ctx.store.update('jobs', job.id, { status: retry ? 'queued' : 'failed', error: b.error, workerId: null, leaseUntil: null, runAt: new Date(Date.now() + 30000).toISOString(), note: retry ? 'Worker failed; retrying' : 'Failed on worker' });
  queue.publish(ctx.store.get('jobs', job.id)); return { ok: true };
}, { roles: WORKER });
r.get('/api/workers', () => ctx.store.all('workers').map((w) => ({ ...w, online: Date.now() - new Date(w.lastSeen).getTime() < 120000 })), { roles: OWNER });

// ------------------------------------------------------------ prospects (growth)
r.get('/api/prospects', () => ctx.store.all('prospects').reverse());
r.post('/api/prospects', (req, b) => ctx.store.insert('prospects', { name: b.name, type: b.type || 'creator', handle: b.handle || '', platforms: b.platforms || [], why: b.why || '', angle: b.angle || '', publicContact: b.publicContact || '', stage: 'new', verified: true, source: 'manual' }));
r.patch('/api/prospects/:id', (req, b, p) => { must(ctx.store.get('prospects', p.id)); const patch = {}; for (const k of ['name', 'type', 'handle', 'stage', 'why', 'angle', 'publicContact', 'verified', 'notes', 'followers', 'location']) if (b[k] !== undefined) patch[k] = b[k]; events.publish('prospects', {}); return ctx.store.update('prospects', p.id, patch); });
r.del('/api/prospects/:id', (req, b, p) => ({ ok: ctx.store.remove('prospects', p.id) }));
r.post('/api/prospects/:id/audit', (req, b, p) => queue.enqueue('prospect.audit', { prospectId: must(ctx.store.get('prospects', p.id)).id }, { actor: actorOf(req) }));
r.post('/api/prospects/:id/outreach', async (req, b, p) => {
  const pr = must(ctx.store.get('prospects', p.id));
  let contact = pr.contactId ? ctx.store.get('contacts', pr.contactId) : null;
  const emailAddr = b.email || (/@/.test(pr.publicContact || '') ? pr.publicContact.trim() : null);
  if (!contact) {
    if (!emailAddr && !b.phone) throw new HttpError(400, 'Add a public business email or phone for this prospect first');
    contact = ctx.store.insert('contacts', { name: pr.name, phones: b.phone ? [twilio.normalize(b.phone)] : [], emails: emailAddr ? [emailAddr.toLowerCase()] : [], role: 'prospect', clientId: null, optedOut: {}, source: 'prospecting' });
    ctx.store.update('prospects', pr.id, { contactId: contact.id });
  }
  const res = await ai.ask({ role: 'writing', json: true, maxTokens: 900, system: `You write first-touch outreach for Euclidean Media (founders Ryan Rosario and Ben Gingold), a short-form video agency for ${pr.type === 'political' ? 'political campaigns' : 'creators'}. Personal, specific, under 140 words, one clear ask (a 15-minute call). No hype, no fake familiarity, no invented results. Include a simple opt-out line.`, prompt: `Prospect: ${pr.name} (${pr.handle || ''}). Why they need us: ${pr.why || 'n/a'}. Angle: ${pr.angle || 'n/a'}.${pr.audit ? `\nAudit notes: ${pr.audit.slice(0, 1500)}` : ''}\nReturn {"subject":"...","body":"..."}` });
  const m = messaging.createOutbound({ contactId: contact.id, channel: contact.emails.length ? 'email' : 'sms', subject: res.json.subject, body: res.json.body, aiGenerated: true, agent: `${res.provider}:${res.model}`, category: 'prospecting', actor: actorOf(req) });
  ctx.store.update('prospects', pr.id, { stage: pr.stage === 'new' ? 'drafted' : pr.stage });
  return { message: m, conversationId: m.conversationId };
});
// ---- Political outreach packages: research → brief → videos → sheet → email draft (waits in Approvals)
const polPkg = require('./political/package');
r.post('/api/political/packages', (req, b) => {
  const names = (Array.isArray(b.names) ? b.names : String(b.names || '').split(/\r?\n|;/)).map((x) => String(x).trim()).filter(Boolean).slice(0, 200);
  if (!names.length) throw new HttpError(400, 'Add at least one name, one per line.');
  const out = [];
  for (const line of names) {
    // "Name — office/state" or "Name, office" lines give the lookup a hint.
    const [name, ...rest] = line.split(/\s+[—–-]\s+|,\s*/); const hint = rest.join(', ');
    let pr = ctx.store.find('prospects', (x) => x.name.toLowerCase() === name.toLowerCase());
    if (!pr) pr = ctx.store.insert('prospects', { name, type: 'political', handle: '', platforms: [], why: '', angle: '', publicContact: '', location: hint, stage: 'new', verified: true, source: 'manual' });
    else if (pr.type !== 'political') pr = ctx.store.update('prospects', pr.id, { type: 'political' });
    queue.enqueue('political.package', { prospectId: pr.id, name: pr.name }, { actor: actorOf(req), priority: 4, dedupeKey: `polpkg:${pr.id}` });
    out.push(pr.id);
  }
  events.publish('prospects', {});
  audit.log(actorOf(req), 'political.packages_queued', { count: out.length });
  return { queued: out.length, ids: out };
});
r.post('/api/political/scout', (req, b) => {
  const query = String(b.query || '').trim(); if (query.length < 4) throw new HttpError(400, 'Describe who you want to find.');
  return queue.enqueue('political.scout', { query, count: Math.max(1, Math.min(100, Number(b.count) || 10)), autoPackage: !!b.autoPackage }, { actor: actorOf(req) });
});
r.post('/api/prospects/:id/package', (req, b, p) => {
  const pr = must(ctx.store.get('prospects', p.id));
  const steps = polPkg.STEPS.map((s) => s[0]);
  if (b.from && !steps.includes(b.from)) throw new HttpError(400, 'Unknown step');
  if (b.only && !steps.includes(b.only)) throw new HttpError(400, 'Unknown step');
  return queue.enqueue('political.package', { prospectId: pr.id, name: pr.name, from: b.from || 'research', only: b.only || null }, { actor: actorOf(req), priority: 4, dedupeKey: `polpkg:${pr.id}` });
});
r.post('/api/political/approve', (req, b) => require('./outreach/autopilot').approve(b.ids, actorOf(req)), { roles: OWNER });
r.get('/api/political/steps', () => polPkg.STEPS.map(([key, label]) => ({ key, label })));
r.get('/api/prospects/:id/file/:kind', (req, res, p) => {
  const pr = ctx.store.get('prospects', p.id); if (!pr) return send(res, 404, { error: 'Not found' });
  const f = p.kind === 'photo' ? pr.pkg?.profile?.photo : pr.pkg?.files?.[p.kind];
  if (!f || !paths.inside(path.join(paths.root, 'political'), f)) return send(res, 404, { error: 'Not made yet' });
  if (req.query.reveal && ctx.revealFile) { ctx.revealFile(f); return send(res, 200, { ok: true }); }
  return serveFile(req, res, f, { download: req.query.download ? path.basename(f) : null });
}, { stream: true });
// ---- Outreach lanes (creators + political): autopilot status, review queue, approve/skip, leads in/out
const autopilot = require('./outreach/autopilot');
const leads = require('./outreach/leads');
const laneOk = (l) => { if (!autopilot.LANES.includes(l)) throw new HttpError(400, 'Unknown lane'); return l; };
r.get('/api/outreach/status', () => autopilot.status());
const scoutChat = require('./outreach/chat');
const learningSvc = require('./outreach/learning');
r.get('/api/outreach/:lane/chat', (req, b, p) => scoutChat.history(laneOk(p.lane), 80));
r.post('/api/outreach/:lane/chat', async (req, b, p) => { try { return await scoutChat.send(laneOk(p.lane), b.text, actorOf(req)); } catch (e) { throw new HttpError(400, e.message); } });
r.get('/api/outreach/:lane/learning', (req, b, p) => ({ stats: learningSvc.stats(laneOk(p.lane)), lessons: ctx.setting(`outreach.${p.lane}.lessons`, ''), recent: ctx.store.all('outreachFeedback', (f) => f.lane === p.lane).slice(-30).reverse() }));
r.get('/api/outreach/:lane/review', (req, b, p) => autopilot.reviewQueue(laneOk(p.lane)));
r.post('/api/outreach/approve', (req, b) => autopilot.approve(b.ids, actorOf(req), b.edits || {}), { roles: OWNER });
r.post('/api/outreach/skip', (req, b) => autopilot.skip(b.ids, actorOf(req), b.reason));
r.post('/api/outreach/:lane/import', (req, b, p) => { try { return leads.importCsv({ lane: laneOk(p.lane), csv: b.csv, actor: actorOf(req) }); } catch (e) { throw new HttpError(400, e.message); } });
r.post('/api/outreach/:lane/start', (req, b, p) => {
  const lane = laneOk(p.lane); const ids = (b.ids && b.ids.length ? b.ids : ctx.store.all('prospects', (x) => autopilot.laneOf(x) === lane && (x.stage || 'new') === 'new' && !(lane === 'political' ? x.pkg : x.outreach)).map((x) => x.id)).slice(0, 500);
  for (const id of ids) { const pr = ctx.store.get('prospects', id); if (!pr) continue; queue.enqueue(lane === 'political' ? 'political.package' : 'creator.outreach', { prospectId: id, name: pr.name }, { actor: actorOf(req), priority: 5, dedupeKey: `${lane === 'political' ? 'polpkg' : 'crout'}:${id}` }); }
  return { started: ids.length };
});
r.post('/api/outreach/creators/scout', (req, b) => {
  const query = String(b.query || '').trim(); if (query.length < 4) throw new HttpError(400, 'Describe who you want to find.');
  return queue.enqueue('creator.scout', { query, count: Math.max(1, Math.min(100, Number(b.count) || 10)), autoPackage: b.autoPackage !== false }, { actor: actorOf(req) });
});
r.post('/api/prospects/:id/redo', (req, b, p) => { const pr = must(ctx.store.get('prospects', p.id)); return queue.enqueue(pr.type === 'political' ? 'political.package' : 'creator.outreach', { prospectId: pr.id, name: pr.name }, { actor: actorOf(req), dedupeKey: `${pr.type === 'political' ? 'polpkg' : 'crout'}:${pr.id}` }); });
r.get('/api/outreach/:lane/export.csv', (req, res, p) => {
  if (!autopilot.LANES.includes(p.lane)) return send(res, 404, { error: 'Unknown lane' });
  return send(res, 200, leads.exportCsv(p.lane), { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${p.lane === 'political' ? 'Political' : 'Creator'} leads.csv"` });
}, { stream: true });

r.post('/api/prospects/:id/convert', (req, b, p) => {
  const pr = must(ctx.store.get('prospects', p.id));
  const c = pipeline.createClient({ name: pr.name, type: pr.type === 'political' ? 'political' : 'creator', profile: { about: pr.why || '' } }, actorOf(req));
  if (pr.contactId) { ctx.store.update('contacts', pr.contactId, { role: 'client', clientId: c.id }); ctx.store.update('clients', c.id, { contactIds: [pr.contactId], primaryContactId: pr.contactId }); }
  ctx.store.update('prospects', pr.id, { stage: 'won', clientId: c.id });
  return clientView(ctx.store.get('clients', c.id));
}, { roles: OWNER });

// ------------------------------------------------------------ finance, analytics
r.get('/api/finance', (req) => finance.summary(req.query.month || monthKey()), { roles: OWNER });
r.get('/api/invoices', () => ctx.store.all('invoices').reverse().map((i) => ({ ...i, client: ctx.store.get('clients', i.clientId)?.name })), { roles: OWNER });
r.post('/api/invoices/draft', (req) => finance.draftInvoices(actorOf(req)), { roles: OWNER });
r.patch('/api/invoices/:id', (req, b, p) => { must(ctx.store.get('invoices', p.id)); const patch = {}; for (const k of ['status', 'amount', 'dueDate', 'notes']) if (b[k] !== undefined) patch[k] = b[k]; if (patch.status === 'paid') patch.paidAt = now().slice(0, 10); audit.log(actorOf(req), 'invoice.updated', { invoiceId: p.id, ...patch }); return ctx.store.update('invoices', p.id, patch); }, { roles: OWNER });
r.get('/api/expenses', () => ctx.store.all('expenses').reverse(), { roles: OWNER });
r.post('/api/expenses', (req, b) => ctx.store.insert('expenses', { label: b.label, amount: Number(b.amount) || 0, category: b.category || 'other', date: b.date || now().slice(0, 10), recurring: !!b.recurring, clientId: b.clientId || null }), { roles: OWNER });
r.del('/api/expenses/:id', (req, b, p) => ({ ok: ctx.store.remove('expenses', p.id) }), { roles: OWNER });
r.post('/api/timelogs', (req, b) => ctx.store.insert('timelogs', { userId: actorOf(req), clientId: b.clientId || null, minutes: Number(b.minutes) || 0, note: b.note || '', date: b.date || now().slice(0, 10) }));
r.post('/api/analytics/sync', () => queue.enqueue('analytics.sync', {}, { dedupeKey: `analytics:manual:${Math.floor(Date.now() / 60000)}` }));
// ------------------------------------------------------------ tracked creators (Analytics → Creators)
const creatorsSvc = require('./integrations/creators');
const PLATFORMS_C = ['youtube', 'tiktok', 'instagram', 'x', 'facebook', 'twitch', 'other'];
// The list leaves out each creator's upload list (it can be thousands long) but includes the monthly breakdown.
r.get('/api/creators', () => {
  const list = ctx.store.all('creators').slice().sort((a, b) => (b.followers || 0) - (a.followers || 0));
  return list.map(({ videos, ...c }, i) => { const rep = creatorsSvc.report({ ...c, videos }); return { ...c, rank: c.followers != null ? i + 1 : null, stats: rep.summary, months: creatorsSvc.monthly(videos || [], c.history || []).map(({ top, ...m }) => m) }; });
});
r.get('/api/creators/search', async (req) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) throw new HttpError(400, 'Type at least 2 characters');
  const lc = q.toLowerCase();
  const tracked = ctx.store.all('creators');
  const isTracked = (x) => tracked.find((c) => (x.url && c.url === x.url) || (x.channelId && c.channelId === x.channelId) || (x.handle && c.handle && c.handle.toLowerCase() === x.handle.toLowerCase() && c.platform === x.platform));
  const results = []; const errors = [];
  const direct = creatorsSvc.classify(q);
  if (direct) results.push({ ...direct, name: direct.handle || q, verified: false, direct: true });
  // Clients and prospects you already have
  for (const c of ctx.store.all('clients', (x) => x.name.toLowerCase().includes(lc))) results.push({ platform: 'client', name: c.name, clientId: c.id, source: 'Your client', verified: true });
  for (const p of ctx.store.all('prospects', (x) => `${x.name} ${x.handle}`.toLowerCase().includes(lc))) results.push({ platform: (p.platforms || [])[0] || 'other', name: p.name, handle: p.handle || '', prospectId: p.id, source: 'Prospect', verified: true });
  if (!direct || direct.maybeOther) {
    try { results.push(...(await creatorsSvc.searchYouTube(q)).slice(0, 10)); } catch (e) { errors.push(`YouTube: ${e.message}`); }
  }
  if (req.query.ai === '1') { try { results.push(...await creatorsSvc.searchWithAI(q)); } catch (e) { errors.push(e.message); } }
  return { results: results.map((x) => ({ ...x, trackedId: isTracked(x)?.id || null })), errors };
});
r.get('/api/creators/:id', (req, b, p) => { const c = must(ctx.store.get('creators', p.id)); return { ...c, months: creatorsSvc.monthly(c.videos || [], c.history || []) }; });
/** CSV for spreadsheets: ?of=months (default) or ?of=uploads */
/** Social Blade-style report: daily and monthly gains, projections, grade, earnings estimates. ?format=csv&of=daily for spreadsheets. */
r.get('/api/creators/:id/report', (req, b, p) => { const c = must(ctx.store.get('creators', p.id)); return { creator: { id: c.id, name: c.name, platform: c.platform, handle: c.handle, url: c.url }, ...creatorsSvc.report(c) }; });
r.get('/api/creators/:id/export.csv', (req, res, p) => {
  const c = ctx.store.get('creators', p.id); if (!c) return send(res, 404, { error: 'Not found' });
  const q = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  let rows;
  if (req.query.of === 'daily') { const rep = creatorsSvc.report(c); rows = [['date', 'followers', 'followers_change', 'views_tracked_uploads', 'views_change', 'uploads_tracked', 'est_earnings_low_usd', 'est_earnings_high_usd'], ...rep.daily.map((d) => [d.date, d.followers, d.followersDelta, d.views, d.viewsDelta, d.uploads, d.earningsLow, d.earningsHigh])]; }
  else if (req.query.of === 'projections') { const rep = creatorsSvc.report(c); rows = [['in', 'date', 'followers', 'views'], ...rep.projections.map((x) => [x.label, x.date, x.followers, x.views])]; }
  else if (req.query.of === 'uploads') rows = [['date', 'date_estimated', 'type', 'title', 'views', 'likes', 'comments', 'shares', 'length_seconds', 'url'], ...(c.videos || []).map((v) => [v.date, v.dateApprox ? 'yes' : 'no', v.kind, v.title, v.views, v.likes, v.comments, v.shares, v.durationSec, v.url])];
  else rows = [['month', 'uploads', 'long_form', 'shorts', 'live', 'views_to_date', 'avg_views', 'median_views', 'likes', 'comments', 'shares', 'engagement_pct', 'avg_length_seconds', 'followers_end_of_month', 'followers_change', 'top_upload', 'top_upload_views'], ...creatorsSvc.monthly(c.videos || [], c.history || []).map((m) => [m.month, m.uploads, m.videos, m.shorts, m.lives, m.views, m.avgViews, m.medianViews, m.likes, m.comments, m.shares, m.engagementPct, m.avgDurationSec, m.followers, m.followersDelta, m.top?.title, m.top?.views])];
  const name = `${String(c.name).replace(/[^\w\- ]+/g, '').trim() || 'creator'} - ${{ uploads: 'uploads', daily: 'daily', projections: 'projections' }[req.query.of] || 'by month'}.csv`;
  return send(res, 200, '\ufeff' + rows.map((r) => r.map(q).join(',')).join('\r\n'), { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}"` });
}, { stream: true });
r.post('/api/creators', (req, b) => {
  const platform = PLATFORMS_C.includes(b.platform) ? b.platform : 'other';
  if (!b.name && !b.handle && !b.url) throw new HttpError(400, 'Give the creator a name, handle or profile link');
  const h = String(b.handle || '').replace(/^@/, '');
  const fromHandle = h ? { youtube: `https://www.youtube.com/@${h}`, tiktok: `https://www.tiktok.com/@${h}`, instagram: `https://www.instagram.com/${h}/`, x: `https://x.com/${h}` }[platform] : null;
  const url = (b.url && /^https?:\/\//.test(b.url) ? b.url : null) || fromHandle || null;
  const dup = ctx.store.find('creators', (c) => (url && c.url === url) || (b.channelId && c.channelId === b.channelId));
  if (dup) return dup;
  const c = ctx.store.insert('creators', {
    platform, name: String(b.name || b.handle || url).slice(0, 80), handle: String(b.handle || '').slice(0, 60), url, channelId: b.channelId || null, avatar: b.avatar || null,
    about: String(b.about || '').slice(0, 300), followers: typeof b.followers === 'number' ? b.followers : null, followersSource: typeof b.followers === 'number' ? 'search' : null,
    clientId: b.clientId || null, prospectId: b.prospectId || null, tags: [], notes: '', verified: !!b.verified, videos: [], metrics: {}, history: typeof b.followers === 'number' ? [{ at: now(), followers: b.followers, avgViews: null }] : [], addedBy: actorOf(req),
  });
  audit.log(actorOf(req), 'creator.tracked', { creatorId: c.id, name: c.name, platform });
  if (url && ['youtube', 'tiktok'].includes(platform)) queue.enqueue('creator.sync', { creatorId: c.id, full: true }, { dedupeKey: `creator:${c.id}:full` });
  events.publish('creators', {});
  return c;
});
r.patch('/api/creators/:id', (req, b, p) => {
  must(ctx.store.get('creators', p.id)); const patch = {};
  for (const k of ['name', 'handle', 'url', 'notes', 'tags', 'about']) if (b[k] !== undefined) patch[k] = b[k];
  if (b.name !== undefined) patch.nameLocked = true;
  if (b.followers !== undefined) { patch.followers = b.followers === '' || b.followers == null ? null : Math.max(0, Math.round(Number(b.followers))); patch.followersSource = 'manual'; }
  const c = ctx.store.update('creators', p.id, patch);
  if (b.followers !== undefined) ctx.store.update('creators', p.id, (x) => ({ history: [...(x.history || []), { at: now(), followers: patch.followers, avgViews: x.metrics?.avgViews ?? null }].slice(-180) }));
  events.publish('creators', {});
  return c;
});
r.post('/api/creators/:id/sync', (req, b, p) => queue.enqueue('creator.sync', { creatorId: must(ctx.store.get('creators', p.id)).id, full: !!b.full }, { dedupeKey: `creator:${p.id}${b.full ? ':full' : ''}`, actor: actorOf(req), title: b.full ? 'Collect full upload history' : undefined }));
r.post('/api/creators/sync-all', (req) => ctx.store.all('creators').map((c) => queue.enqueue('creator.sync', { creatorId: c.id }, { dedupeKey: `creator:${c.id}`, actor: actorOf(req) }).id));
r.del('/api/creators/:id', (req, b, p) => { const c = must(ctx.store.get('creators', p.id)); ctx.store.remove('creators', c.id); audit.log(actorOf(req), 'creator.untracked', { creatorId: c.id, name: c.name }); events.publish('creators', {}); return { ok: true }; });
r.post('/api/creators/:id/prospect', (req, b, p) => {
  const c = must(ctx.store.get('creators', p.id));
  if (c.prospectId && ctx.store.get('prospects', c.prospectId)) return ctx.store.get('prospects', c.prospectId);
  const pr = ctx.store.insert('prospects', { name: c.name, type: 'creator', handle: c.handle || '', platforms: [c.platform], why: c.about || '', angle: '', publicContact: '', stage: 'new', verified: !!c.verified, source: 'analytics', followers: c.followers || null });
  ctx.store.update('creators', c.id, { prospectId: pr.id }); events.publish('prospects', {}); events.publish('creators', {});
  audit.log(actorOf(req), 'prospect.created', { prospectId: pr.id, from: 'creator' });
  return pr;
});

r.get('/api/analytics', () => {
  const posts = ctx.store.all('posts', (p) => p.status === 'published');
  const sum = (p) => Object.values(p.stats || {}).reduce((t, s) => ({ views: t.views + (s.views || 0), likes: t.likes + (s.likes || 0), comments: t.comments + (s.comments || 0), shares: t.shares + (s.shares || 0) }), { views: 0, likes: 0, comments: 0, shares: 0 });
  const byClient = {}; const byPlatform = {}; const byDay = {};
  for (const p of posts) {
    const s = sum(p); const c = ctx.store.get('clients', p.clientId)?.name || 'Unknown';
    byClient[c] = byClient[c] || { posts: 0, views: 0, likes: 0 }; byClient[c].posts++; byClient[c].views += s.views; byClient[c].likes += s.likes;
    for (const [plat, st] of Object.entries(p.stats || {})) { byPlatform[plat] = byPlatform[plat] || { views: 0, likes: 0, posts: 0 }; byPlatform[plat].views += st.views || 0; byPlatform[plat].likes += st.likes || 0; byPlatform[plat].posts++; }
    const d = (p.publishedAt || '').slice(0, 10); byDay[d] = byDay[d] || { posts: 0, views: 0 }; byDay[d].posts++; byDay[d].views += s.views;
  }
  const top = posts.map((p) => ({ id: p.id, title: p.title, client: ctx.store.get('clients', p.clientId)?.name, publishedAt: p.publishedAt, ...sum(p), clipId: p.clipId })).sort((a, b) => b.views - a.views).slice(0, 12);
  return { total: posts.length, tracked: posts.filter((p) => p.stats).length, byClient, byPlatform, byDay, top, lastSync: posts.map((p) => p.statsAt).filter(Boolean).sort().pop() || null };
});

// ------------------------------------------------------------ agents
r.get('/api/agents', () => ({ ...ai.agentStatus(), usage: ctx.store.all('usage', (u) => u.month === monthKey()).slice(-200).reverse() }));
r.post('/api/agents/test/:provider', (req, b, p) => ai.test(p.provider), { roles: OWNER });
r.post('/api/agents/ask', async (req, b) => { const res = await ai.ask({ role: b.role || 'operations', prompt: String(b.prompt || ''), provider: b.provider, maxTokens: 800 }); return res; }, { roles: OWNER });

// ------------------------------------------------------------ system
r.get('/api/health', () => health.check());
r.get('/api/resources', () => ({ current: resources.last, history: resources.history(), gate: resources.heavyGate() }));
r.post('/api/mode', (req, b) => ({ mode: resources.setMode(b.mode, actorOf(req)) }), { roles: STAFF });
r.get('/api/logs', (req) => audit.query({ q: req.query.q, level: req.query.level, clientId: req.query.clientId, limit: Number(req.query.limit || 300) }));
r.post('/api/backup', () => ({ file: ctx.store.backup(paths.backups()) }), { roles: OWNER });
r.get('/api/backups', () => fs.readdirSync(paths.backups()).filter((f) => f.endsWith('.json')).sort().reverse().map((f) => ({ name: f, size: fs.statSync(path.join(paths.backups(), f)).size })), { roles: OWNER });
r.post('/api/restore', (req, b) => {
  const f = path.join(paths.backups(), path.basename(String(b.name || '')));
  if (!fs.existsSync(f)) throw new HttpError(404, 'Backup not found');
  ctx.store.backup(paths.backups()); ctx.store.restore(f);
  audit.log(actorOf(req), 'backup.restored', { file: b.name }, 'warn');
  return { ok: true };
}, { roles: OWNER });
r.post('/api/system/redetect', async () => { Object.assign(ctx.capabilities, await ff.detect()); return ctx.capabilities; }, { roles: OWNER });
r.post('/api/system/open', (req, b) => {
  if (b.url && ctx.openExternal && /^https?:\/\//.test(b.url)) { ctx.openExternal(b.url); return { ok: true }; }
  if (b.path && fs.existsSync(b.path)) { if (b.reveal && ctx.revealFile) ctx.revealFile(b.path); else if (ctx.openPath) ctx.openPath(b.path); return { ok: true }; }
  throw new HttpError(400, ctx.electron ? 'Nothing to open' : 'Opening files is only available in the desktop app');
}, { roles: STAFF });
// ---- Use on your iPhone: the engine serves the app to the phone over Wi-Fi (or a public URL)
function phoneUser(owner, create) {
  let u = ctx.store.find('users', (x) => x.device === 'phone' && x.forUser === owner.id);
  if (!u && create) u = ctx.store.insert('users', { id: makeId('u_'), name: `${owner.name}'s phone`, role: owner.role, token: 'eu_' + crypto.randomBytes(24).toString('base64url'), device: 'phone', forUser: owner.id });
  return u;
}
r.get('/api/phone', async (req) => {
  const lanOn = !!ctx.setting('server.lan', false); const pub = String(ctx.setting('server.publicUrl', '') || '').replace(/\/$/, '');
  const host = pub || (ctx.lanAddress ? `http://${ctx.lanAddress}:${ctx.port}` : null);
  const u = phoneUser(req.user, false);
  const url = host && u ? `${host}/?token=${u.token}` : null;
  return { lanOn, lanActive: !!ctx.lanAddress, publicUrl: pub || null, host, url, qr: url ? await require('qrcode').toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }) : null, canRestart: !!ctx.relaunch };
}, { roles: OWNER });
r.post('/api/phone/link', (req) => { const u = phoneUser(req.user, true); audit.log(actorOf(req), 'phone.linked', { userId: u.id }); return { ok: true }; }, { roles: OWNER });
r.post('/api/phone/unlink', (req) => { const u = phoneUser(req.user, false); if (u) ctx.store.remove('users', u.id); audit.log(actorOf(req), 'phone.unlinked', {}); return { ok: true }; }, { roles: OWNER });
r.post('/api/system/restart', (req) => { if (!ctx.relaunch) throw new HttpError(400, 'Restart Euclidean by closing it from the tray and opening it again.'); audit.log(actorOf(req), 'system.restart', {}); setTimeout(() => ctx.relaunch(), 300); return { ok: true }; }, { roles: OWNER });
r.post('/api/system/pick-folder', async (req, b) => { if (!ctx.pickFolder) throw new HttpError(400, 'Choosing a folder is only available in the desktop app'); return { path: await ctx.pickFolder(b) }; });
r.post('/api/system/pick', async (req, b) => { if (!ctx.pickFiles) throw new HttpError(400, 'File picker is only available in the desktop app'); return { paths: await ctx.pickFiles(b) }; });
r.post('/api/sandbox/simulate-inbound', (req, b) => {
  // Test environment only: lets you rehearse the inbound → triage → revision flow without a phone.
  if (ctx.setting('environment') === 'production') throw new HttpError(400, 'Only available in the test environment');
  const contact = must(ctx.store.get('contacts', b.contactId), 'Contact not found');
  const channel = b.channel || (contact.phones.length ? 'sms' : 'email');
  return messaging.receive({ channel, providerId: `sim-${Date.now()}`, from: channel === 'sms' ? contact.phones[0] : contact.emails[0], fromName: contact.name, subject: b.subject, body: String(b.body || ''), at: now() });
}, { roles: OWNER });

// ------------------------------------------------------------ Studio projects
r.get('/api/projects', (req) => ctx.store.all('projects', (p) => !req.query.clientId || p.clientId === req.query.clientId).map(({ data, ...p }) => ({ ...p, sequences: data?.sequences?.length || 0, media: data?.media?.length || 0 })).reverse());
r.post('/api/projects', (req, b) => ctx.store.insert('projects', { name: b.name || 'Untitled', clientId: b.clientId || null, data: b.data || emptyProject(b), exports: [] }));
function emptyProject(b) {
  const W = b.width || 1080, H = b.height || 1920;
  const track = (type, name) => ({ type, name, muted: false, locked: false, volume: { base: 1 }, clips: [] });
  return { app: 'velo', version: 1, media: [], sequences: [{ id: 's1', name: 'Sequence 1', width: W, height: H, fps: b.fps || 30, videoTracks: [track(0, 'V1'), track(0, 'V2'), track(0, 'V3')], audioTracks: [track(1, 'A1'), track(1, 'A2')] }], openTabs: ['s1'], activeSequence: 's1', nextClipId: '1' };
}
r.get('/api/projects/:id', (req, b, p) => must(ctx.store.get('projects', p.id)));
// ---- AI editing (Studio's AI box, agents, and anything with an agent token)
const editOps = require('./video/edit-ops');
r.get('/api/projects/:id/summary', (req, b, p) => ({ text: editOps.summarize(must(ctx.store.get('projects', p.id))) }));
r.post('/api/projects/:id/ai-edit', async (req, b, p) => {
  let pr = must(ctx.store.get('projects', p.id));
  const instruction = String(b.instruction || '').trim(); if (!instruction) throw new HttpError(400, 'Tell the AI what to change.');
  if (b.data?.sequences) pr = ctx.store.update('projects', pr.id, { data: b.data }); // edit what's on screen, unsaved changes included
  const r = await editOps.aiEdit({ project: pr, instruction, actor: actorOf(req), provider: b.provider || undefined });
  return { done: r.done, errors: r.errors, say: r.say, provider: r.provider, changed: r.changed, data: ctx.store.get('projects', pr.id).data };
});
r.post('/api/projects/:id/ops', (req, b, p) => {
  let pr = must(ctx.store.get('projects', p.id));
  if (b.data?.sequences) pr = ctx.store.update('projects', pr.id, { data: b.data });
  const r = editOps.commit(pr, b.ops || [], { actor: actorOf(req), via: 'api' });
  return { done: r.done, errors: r.errors, changed: r.changed, data: ctx.store.get('projects', pr.id).data };
});
r.post('/api/projects/:id/ai-undo', (req, b, p) => ({ ...editOps.undo(must(ctx.store.get('projects', p.id)), actorOf(req)), data: ctx.store.get('projects', p.id).data }));
r.get('/api/projects/:id/ai-history', (req, b, p) => (must(ctx.store.get('projects', p.id)).aiHistory || []).map(({ before, ...h }) => h).reverse());
// Agents (Astra, external agents with a token) can edit Studio projects with the same operations.
r.get('/api/agent/projects', () => ctx.store.all('projects').map((x) => ({ id: x.id, name: x.name, clientId: x.clientId, updatedAt: x.updatedAt })), { roles: AGENT });
r.get('/api/agent/projects/:id/summary', (req, b, p) => ({ text: editOps.summarize(must(ctx.store.get('projects', p.id))), operations: editOps.OPS_DOC }), { roles: AGENT });
r.post('/api/agent/projects/:id/ops', (req, b, p) => { const r = editOps.commit(must(ctx.store.get('projects', p.id)), b.ops || [], { actor: `agent:${req.user.name}`, via: `agent:${req.user.agentId || req.user.name}` }); return { done: r.done, errors: r.errors, changed: r.changed }; }, { roles: AGENT });
r.post('/api/agent/projects/:id/edit', async (req, b, p) => { const r = await editOps.aiEdit({ project: must(ctx.store.get('projects', p.id)), instruction: String(b.instruction || ''), actor: `agent:${req.user.name}`, agent: req.user.agentId || req.user.name }); return { done: r.done, errors: r.errors, say: r.say }; }, { roles: AGENT });
r.put('/api/projects/:id', (req, b, p) => {
  const pr = must(ctx.store.get('projects', p.id));
  // Keep preview-proxy fields the engine filled in after the editor last loaded the project.
  const known = Object.fromEntries((pr.data?.media || []).map((m) => [m.id, m]));
  for (const m of b.data?.media || []) { const k = known[m.id]; if (k && k.proxy && !m.proxy) { m.proxy = k.proxy; m.proxyPending = false; } }
  // Only touch the name when one is sent (autosaves send data only; an undefined name used to wipe it).
  return ctx.store.update('projects', p.id, { data: b.data, ...(b.name ? { name: String(b.name).slice(0, 120) } : {}) });
});
r.del('/api/projects/:id', (req, b, p) => ({ ok: ctx.store.remove('projects', p.id) }));
r.get('/api/projects/:id/export-defaults', (req, b, p) => {
  const pr = must(ctx.store.get('projects', p.id));
  const folder = ctx.setting('studio.exportFolder', '') || path.join(require('os').homedir(), 'Videos', 'Euclidean');
  return { folder, fileName: `${String(pr.name || '').replace(/[^\w\- ]+/g, '').trim() || 'Untitled edit'}.mp4`, desktop: !!ctx.pickFolder };
});
r.post('/api/projects/:id/export', (req, b, p) => {
  const pr = must(ctx.store.get('projects', p.id));
  let outDir = null; let fileName = null;
  if (b.folder) {
    outDir = path.resolve(String(b.folder));
    try { fs.mkdirSync(outDir, { recursive: true }); fs.accessSync(outDir, fs.constants.W_OK); } catch { throw new HttpError(400, `Euclidean can't save into ${outDir}. Choose another folder.`); }
    ctx.store.setSettings({ studio: { exportFolder: outDir } });
  }
  if (b.fileName) fileName = path.basename(String(b.fileName)).replace(/[<>:"/\\|?*]+/g, '').replace(/\.mp4$/i, '').trim().slice(0, 120) || null;
  return queue.enqueue('studio.export', { projectId: pr.id, outDir, fileName, reveal: b.reveal !== false }, { clientId: pr.clientId, actor: actorOf(req), title: `Export ${pr.name}` });
});
r.get('/api/projects/:id/velo', (req, res, p) => { const pr = must(ctx.store.get('projects', p.id)); const f = path.join(paths.tmp('velo'), `${pr.id}.velo`); fs.writeFileSync(f, JSON.stringify(pr.data, null, 1)); return serveFile(req, res, f, { download: `${pr.name.replace(/[^\w\- ]/g, '')}.velo` }); }, { stream: true });
r.post('/api/projects/:id/open-velo', (req, b, p) => {
  const pr = must(ctx.store.get('projects', p.id)); const f = path.join(paths.tmp('velo'), `${pr.id}.velo`); fs.writeFileSync(f, JSON.stringify(pr.data, null, 1));
  const velo = ctx.setting('tools.veloPath', '');
  if (velo && fs.existsSync(velo)) { spawn(velo, [f], { detached: true, stdio: 'ignore' }).unref(); return { ok: true }; }
  throw new HttpError(400, 'Set the Velo executable path in Settings → System');
});
r.post('/api/projects/:id/import-velo', (req, b, p) => { must(ctx.store.get('projects', p.id)); const data = JSON.parse(fs.readFileSync(String(b.path), 'utf8')); if (data.app !== 'velo') throw new HttpError(400, 'Not a Velo project'); return ctx.store.update('projects', p.id, { data }); });
r.post('/api/projects/:id/media', async (req, b, p) => {
  const pr = must(ctx.store.get('projects', p.id));
  let files = [];
  // Uploads (browser) arrive as multipart; the desktop app sends the files' own paths so nothing is copied.
  if ((req.headers['content-type'] || '').startsWith('multipart/')) files = (await receiveUpload(req, pr.clientId ? paths.clientDir(pr.clientId, 'studio-media') : paths.tmp('studio-media'))).files.map((f) => f.path);
  else files = ((await parseBody(req))?.paths || []).map(String);
  const added = []; const problems = [];
  for (const f of files) {
    if (!fs.existsSync(f)) { problems.push(`${path.basename(f)}: file not found`); continue; }
    const ext = path.extname(f).toLowerCase();
    const isImage = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.tif', '.tiff'].includes(ext);
    let info;
    try { info = await ff.probe(f); } catch (e) { problems.push(`${path.basename(f)}: not a video, audio or image file FFmpeg can read`); continue; }
    if (!info.hasVideo && !info.hasAudio && !isImage && ext !== '.svg') { problems.push(`${path.basename(f)}: no video or audio inside`); continue; }
    const kind = isImage ? 2 : ext === '.svg' ? 3 : info.hasVideo ? 0 : 1;
    const m = { id: makeId('m'), path: f, name: path.basename(f), kind, duration: kind >= 2 ? 5 : info.duration, width: info.width, height: info.height, fps: info.fps, hasVideo: info.hasVideo && kind !== 1, hasAudio: info.hasAudio && kind < 2, vcodec: info.vcodec, srcIn: 0, srcOut: -1 };
    if (kind === 0 && studioProxy.needsProxy(f, info)) { m.proxy = null; m.proxyPending = true; studioProxy.make(pr.id, m); }
    added.push(m);
  }
  if (!added.length && problems.length) throw new HttpError(400, `Nothing imported. ${problems.join(' · ')}`);
  // Re-read the project: an autosave may have replaced its data while files were being probed.
  const cur = ctx.store.get('projects', pr.id);
  const data = cur.data; data.media = [...(data.media || []), ...added];
  ctx.store.update('projects', pr.id, { data });
  return problems.length ? { media: added, problems } : added;
}, { raw: true });
/** Studio → right-click → Extract Audio: writes the clip's sound to its own file and adds it to the bin. */
r.post('/api/projects/:id/extract-audio', async (req, b, p) => {
  const pr = must(ctx.store.get('projects', p.id));
  const m = must((pr.data.media || []).find((x) => x.id === b.mediaId), 'That clip\'s media is not in this project');
  if (!m.hasAudio) throw new HttpError(400, `${m.name} has no audio to extract`);
  const dir = pr.clientId ? paths.clientDir(pr.clientId, 'studio-media') : paths.tmp('studio-media');
  let out = path.join(dir, `${path.basename(m.path, path.extname(m.path))} (audio).m4a`); let n = 2;
  while (fs.existsSync(out)) out = path.join(dir, `${path.basename(m.path, path.extname(m.path))} (audio ${n++}).m4a`);
  await require('./core/util').run(ff.bin('ffmpeg'), ['-hide_banner', '-y', '-i', m.path, '-map', '0:a:0', '-vn', '-c:a', 'aac', '-b:a', '256k', out], { timeoutMs: 3600000 });
  const info = await ff.probe(out);
  const item = { id: makeId('m'), path: out, name: path.basename(out), kind: 1, duration: info.duration, hasVideo: false, hasAudio: true, srcIn: 0, srcOut: -1, extractedFrom: m.id };
  const cur = ctx.store.get('projects', pr.id); const data = cur.data; data.media = [...(data.media || []), item];
  ctx.store.update('projects', pr.id, { data });
  return item;
});
/** Media preview for Studio: only files referenced by a project or an asset can be served. */
r.get('/api/media', (req, res) => {
  const f = String(req.query.path || '');
  const allowed = ctx.store.all('projects').some((p) => (p.data?.media || []).some((m) => m.path === f || m.proxy === f)) || ctx.store.find('assets', (a) => a.path === f);
  if (!allowed) return send(res, 403, { error: 'File is not part of any project' });
  return serveFile(req, res, f);
}, { stream: true });
r.get('/api/media/thumb', async (req, res) => {
  const f = String(req.query.path || ''); const still = /\.(png|jpe?g|webp|gif|bmp|tiff?)$/i.test(f); const t = still ? 0 : Number(req.query.t || 1);
  const allowed = ctx.store.all('projects').some((p) => (p.data?.media || []).some((m) => m.path === f));
  if (!allowed) return send(res, 403, {});
  const out = path.join(paths.tmp('thumbs'), crypto.createHash('md5').update(f + t).digest('hex') + '.jpg');
  if (!fs.existsSync(out)) { try { await ff.thumbnail(f, out, t, 240); } catch { /* retry from the first frame below */ } }
  if (!fs.existsSync(out)) { try { await ff.thumbnail(f, out, 0, 240); } catch { /* unreadable */ } }
  if (!fs.existsSync(out)) return send(res, 404, {});
  return serveFile(req, res, out, { cache: true });
}, { stream: true });

// Settings → Agent Connections and the Agent Conversations panel (peer-to-peer agent messaging).
require('./agents/routes')(r);

module.exports = { router: r, SECRET_KEYS };
