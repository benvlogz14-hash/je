'use strict';
/**
 * Euclidean's notebook (HAL's memory): what the app learns as it works, kept as short dated notes with where each one
 * came from, so it keeps growing and HAL (and the outreach writer, and Claude through the connector) can use it.
 *
 * Where notes come from, without anyone typing them:
 *  - the app's own events (the audit log, live): scouts and imports and how many leads they found, finished ads,
 *    clip approvals/rejections with the reason, replies and emails, published posts, stages, and everything Claude
 *    starts through the connector (video production for a client, ads, scouts...).
 *  - a sweep of the database every minute (from the scheduler): one living note per lead and per client (newer
 *    replaces older), a note when a lead changes stage or is marked lost, new leads as they arrive.
 *  - HAL's watch (news and possible leads, with links) and his web lookups.
 *  - people: "HAL, remember that ...", and Claude (POST /api/hal/memory).
 * Notes have a kind (fact, event, lesson, news, lookup, note), an optional key (one living note per thing: newer
 * wins, the old text kept in history), an expiry for passing news, and a pin to keep one forever. Nothing here
 * invents anything: every note is something the app saw or someone said, and says so.
 */
const ctx = require('../core/ctx');
const events = require('../core/events');

const COL = 'halNotes';
const MAX = 6000;
const DAY = 86400000;
const now = () => new Date().toISOString();
const clean = (s, n = 600) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
const STOP = new Set('the a an and or of to in on for with at by from is are was were be been it its this that what who how about do does did you your me my we our us they them he she his her i hal know remember tell any anything there here have has had can could would should will just please'.split(' '));
const words = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9$#@.\- ]+/g, ' ').split(/\s+/).filter((w) => w.length > 1 && !STOP.has(w));

function all() { return ctx.store ? ctx.store.all(COL) : []; }
function live(n, t = Date.now()) { return !n.expiresAt || Date.parse(n.expiresAt) > t; }

/** Add or update a note. Same key (or same words) = the same note: newer text wins, the old one goes to history. */
function add({ text, about = [], kind = 'fact', source = 'app', by = null, link = null, key = null, ttlDays = null, pinned = false, meta = null } = {}) {
  if (!ctx.store) return null;
  const t = clean(text); if (!t) return null;
  const ab = [...new Set([].concat(about || []).map((a) => clean(a, 80)).filter(Boolean))].slice(0, 8);
  const expiresAt = ttlDays ? new Date(Date.now() + ttlDays * DAY).toISOString() : null;
  const same = key ? ctx.store.find(COL, (n) => n.key === key) : ctx.store.find(COL, (n) => n.text.toLowerCase() === t.toLowerCase());
  let n;
  if (same) {
    if (same.text === t && JSON.stringify(same.meta || null) === JSON.stringify(meta || same.meta || null)) { ctx.store.update(COL, same.id, { seenAt: now() }); return same; }
    n = ctx.store.update(COL, same.id, (cur) => ({ text: t, about: ab.length ? ab : cur.about, kind, source, by: by || cur.by, link: link || cur.link, expiresAt: expiresAt || cur.expiresAt, meta: meta || cur.meta, at: now(), history: [...(cur.history || []), { text: cur.text, at: cur.at }].slice(-4) }));
  } else {
    n = ctx.store.insert(COL, { text: t, about: ab, kind, source, by, link, key, expiresAt, pinned: !!pinned, meta, at: now() });
    prune();
  }
  events.publish('hal-memory', { id: n.id });
  return n;
}

/** Keep the notebook under MAX: expired notes go first, then the oldest passing ones (news, lookups, events). */
function prune() {
  const list = all(); if (list.length <= MAX) return;
  const t = Date.now();
  const order = list.filter((n) => !n.pinned).sort((a, b) => (live(a, t) - live(b, t)) || (rank(a.kind) - rank(b.kind)) || String(a.at).localeCompare(String(b.at)));
  for (const n of order.slice(0, list.length - MAX)) ctx.store.remove(COL, n.id);
}
const rank = (k) => ({ news: 0, lookup: 1, event: 2, note: 3, lesson: 4, fact: 5 }[k] ?? 3);

/** The notes most about this question or name: word overlap (names count most), newer first, pinned and facts weigh more. */
function recall(query, { limit = 12, about = null, kinds = null } = {}) {
  const q = words(query); const ab = about ? String(about).toLowerCase() : null; const t = Date.now();
  if (!q.length && !ab) return [];
  const scored = [];
  for (const n of all()) {
    if (!live(n, t) || (kinds && !kinds.includes(n.kind))) continue;
    const abLow = (n.about || []).map((a) => a.toLowerCase());
    let s = 0;
    if (ab && abLow.some((a) => a.includes(ab) || ab.includes(a))) s += 6;
    if (q.length) {
      const w = new Set(words(`${n.text} ${(n.about || []).join(' ')}`));
      const hits = q.filter((x) => w.has(x)).length; if (!hits && !s) continue;
      s += hits * 2 + (abLow.some((a) => q.some((x) => a.split(/\s+/).includes(x))) ? 3 : 0);
    }
    if (!s) continue;
    const ageDays = (t - Date.parse(n.at || n.createdAt)) / DAY;
    s += (n.pinned ? 2 : 0) + (n.kind === 'fact' || n.kind === 'note' ? 1 : 0) + Math.max(0, 2 - ageDays / 15);
    scored.push([s, n]);
  }
  return scored.sort((a, b) => b[0] - a[0]).slice(0, limit).map(([, n]) => n);
}

function list({ q = '', about = '', kind = '', limit = 100 } = {}) {
  if (q || about) return recall(q || about, { limit, about: about || null, kinds: kind ? [kind] : null });
  const t = Date.now();
  return all().filter((n) => live(n, t) && (!kind || n.kind === kind)).sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, limit);
}

function update(id, patch = {}) {
  const ok = {}; for (const k of ['text', 'about', 'kind', 'link', 'pinned', 'ttlDays']) if (patch[k] !== undefined) ok[k] = patch[k];
  if (ok.text != null) ok.text = clean(ok.text);
  if (ok.ttlDays !== undefined) { ok.expiresAt = ok.ttlDays ? new Date(Date.now() + Number(ok.ttlDays) * DAY).toISOString() : null; delete ok.ttlDays; }
  const n = ctx.store.update(COL, id, (cur) => ({ ...ok, at: now(), history: ok.text && ok.text !== cur.text ? [...(cur.history || []), { text: cur.text, at: cur.at }].slice(-4) : cur.history }));
  events.publish('hal-memory', { id }); return n;
}
function remove(id) { const n = ctx.store.get(COL, id); if (n) { ctx.store.remove(COL, id); events.publish('hal-memory', { id }); } return !!n; }

const fmtDate = (s) => { const d = new Date(s); return isNaN(d) ? '' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); };
/** Notes as lines for an AI prompt: dated, with their source. */
function block(notes) { return notes.map((n) => `- [${fmtDate(n.at)}${n.source ? `, ${n.source}` : ''}] ${n.text}${n.link ? ` (${n.link})` : ''}`).join('\n'); }
/** What the notebook knows about this question, ready for a prompt (empty when nothing matches). */
function context(question, opts) { const n = recall(question, { limit: 10, ...opts }); return n.length ? block(n) : ''; }

// ------------------------------------------------------------------ learning from the app's own events
const nameOfClient = (id) => (id && ctx.store.get('clients', id)?.name) || null;
const nameOfProspect = (id) => (id && ctx.store.get('prospects', id)?.name) || null;
const clipTitle = (id) => { const c = id && ctx.store.get('clips', id); return c ? `"${clean(c.title || c.hook || `#${c.ref}`, 80)}"` : 'a clip'; };
const PRODUCTION = [
  [/^\/api\/assets\/([^/]+)\/process$/, 'started making clips', 'asset'], [/^\/api\/clients\/([^/]+)\/upload$/, 'uploaded footage', 'client'],
  [/^\/api\/clips\/([^/]+)\/render$/, 're-rendered', 'clip'], [/^\/api\/clips\/([^/]+)\/version$/, 'asked for a new version of', 'clip'], [/^\/api\/clients\/([^/]+)\/broll$/, 'started a B-roll edit', 'client'],
  [/^\/api\/assets\/([^/]+)\/broll$/, 'started a B-roll edit', 'asset'], [/^\/api\/clients\/([^/]+)\/video-style$/, 'changed the video style', 'client'], [/^\/api\/clients\/([^/]+)\/autopilot-now$/, 'ran autopilot', 'client'],
  [/^\/api\/prospects\/([^/]+)\/(package|look)$/, 'started the ads', 'prospect'], [/^\/api\/prospects\/([^/]+)\/kit$/, 'drafted the outreach kit', 'prospect'], [/^\/api\/prospects\/([^/]+)\/footage\/upload$/, 'uploaded footage', 'prospect'],
  [/^\/api\/political\/scout$/, 'ran a political scout', null], [/^\/api\/outreach\/creators\/scout$/, 'ran a creator scout', null], [/^\/api\/political\/packages$/, 'started ad packages', null], [/^\/api\/political\/kits$/, 'drafted the outreach batch', null],
  [/^\/api\/projects\/([^/]+)\/export$/, 'exported a Studio project', 'project'], [/^\/api\/projects\/([^/]+)\/ai-edit$/, 'edited a Studio project', 'project'], [/^\/api\/clipper\/[^/]+\/export$/, 'exported a Quick cut', null],
  [/^\/api\/prospects$/, 'added a lead', null], [/^\/api\/clients$/, 'added a client', null],
];
function whoFor(type, id) {
  if (type === 'client') return nameOfClient(id);
  if (type === 'prospect') return nameOfProspect(id);
  if (type === 'asset') { const a = ctx.store.get('assets', id); return a ? `${nameOfClient(a.clientId) || 'a client'}'s "${clean(a.name || a.title || 'video', 60)}"` : null; }
  if (type === 'clip') { const c = ctx.store.get('clips', id); return c ? `${nameOfClient(c.clientId) || 'a client'}'s clip ${clipTitle(id)}` : null; }
  if (type === 'project') { const p = ctx.store.get('projects', id); return p ? `"${clean(p.name, 60)}"` : null; }
  return null;
}

function fromAudit(e) {
  const d = e.detail || {}; const a = e.action;
  try {
    if (a === 'claude.action') {
      const hit = PRODUCTION.find(([rx]) => rx.test(d.path)); if (!hit) return;
      const [rx, what, type] = hit; const m = rx.exec(d.path); const who = type ? whoFor(type, m[1]) : null;
      return add({ text: `Claude ${what}${who ? ` for ${who}` : ''} through the connector.`, about: who ? [who.replace(/'s .*/, '')] : [], kind: 'event', source: 'Claude', ttlDays: 120 });
    }
    if (a === 'political.scouted' || a === 'creators.scouted' || a === 'prospects.researched') return add({ text: `${a.startsWith('creators') ? 'Creator' : 'Political'} scout "${clean(d.query, 120)}" found ${d.count || 0} new lead${d.count === 1 ? '' : 's'}.`, kind: 'event', source: 'scout', ttlDays: 120 });
    if (a === 'leads.imported' || a === 'leads.grokbot_imported' || a === 'hal.leads_added') return add({ text: `Leads imported: ${d.added ?? d.count ?? d.created ?? '?'} added${d.updated ? `, ${d.updated} updated` : ''}${d.lane ? ` (${d.lane})` : ''}${a === 'leads.grokbot_imported' ? ' from the GrokBot pack' : a === 'hal.leads_added' ? ' from my watch' : ''}.`, kind: 'event', source: 'leads', ttlDays: 120 });
    if (a === 'political.package_ready') return add({ text: `Ads finished for ${d.name || nameOfProspect(d.prospectId) || 'a candidate'}.`, about: [d.name || nameOfProspect(d.prospectId)], kind: 'event', source: 'ad machine', ttlDays: 180 });
    if (a === 'political.pro_ad_failed') return add({ text: `A pro ad failed for ${nameOfProspect(d.prospectId) || 'a candidate'}: ${clean(d.error, 200)}`, about: [nameOfProspect(d.prospectId)], kind: 'event', source: 'ad machine', ttlDays: 30 });
    if (a === 'clip.approved' || a === 'clip.rejected' || a === 'clip.changes_requested') {
      const cl = nameOfClient(d.clientId) || 'a client'; const verb = { 'clip.approved': 'approved', 'clip.rejected': 'rejected', 'clip.changes_requested': 'asked for changes on' }[a];
      return add({ text: `${e.actor && !/^(system|agent)/.test(e.actor) ? e.actor[0].toUpperCase() + e.actor.slice(1) : 'Someone'} ${verb} ${cl}'s clip ${clipTitle(d.clipId)}${d.note ? `: "${clean(d.note, 200)}"` : ''}.`, about: [cl], kind: 'lesson', source: 'approvals', ttlDays: 365 });
    }
    if (a === 'message.received') {
      const m = ctx.store.get('messages', d.messageId); const who = d.from || 'Someone';
      const pr = ctx.store.find('prospects', (p) => p.name && who && p.name.toLowerCase() === String(who).toLowerCase());
      return add({ text: `${who} wrote in (${d.channel || 'message'})${m?.body ? `: "${clean(m.body, 220)}"` : '.'}`, about: [who, nameOfClient(d.clientId)].filter(Boolean), kind: 'event', source: 'inbox', ttlDays: 365, meta: pr ? { prospectId: pr.id } : null });
    }
    if (a === 'message.sent' && !d.test) return add({ text: `Sent a ${d.channel || 'message'} to ${d.to || 'a contact'}.`, about: [d.to, nameOfClient(d.clientId)].filter(Boolean), kind: 'event', source: 'outbox', ttlDays: 365 });
    if (a === 'outreach.guide_drafted') return add({ text: `Drafted the outreach email for ${d.name} (${d.framing || 'standard'}${d.tier ? `, ${d.tier}` : ''})${d.queued ? ', waiting in Approvals' : ''}.`, about: [d.name], kind: 'event', source: 'outreach', ttlDays: 180 });
    if (a === 'post.published') return add({ text: `Posted a clip for ${nameOfClient(d.clientId) || 'a client'} on ${[].concat(d.platforms || []).join(', ') || 'social'}.`, about: [nameOfClient(d.clientId)], kind: 'event', source: 'publishing', ttlDays: 365 });
    if (a === 'client.created') return add({ text: `New client: ${d.name}.`, about: [d.name], kind: 'event', source: 'clients' });
    if (a === 'hal.stage') return add({ text: `${d.prospect} moved to ${d.stage}.`, about: [d.prospect], kind: 'event', source: 'pipeline', ttlDays: 365 });
  } catch { /* a note is never worth breaking the app */ }
}

// ------------------------------------------------------------------ the living notes: one per lead and client
const STAGE = { new: 'NEW', contacted: 'CONTACTED', replied: 'REPLIED', meeting: 'CALL BOOKED', won: 'CLIENT', lost: 'PASSED' };
function leadNote(p) {
  const bits = [`${p.name}${p.office ? `, ${p.office}` : p.location ? `, ${p.location}` : ''}`, `${p.type === 'political' ? 'political lead' : 'creator lead'}, stage ${STAGE[p.stage] || p.stage || 'NEW'}`];
  if (p.electionResult) bits.push(p.electionResult === 'lost' ? 'lost their race' : 'won their race');
  if (p.hold) bits.push('on HOLD');
  const email = p.publicContact || p.kit?.card?.email; if (email) bits.push(`email ${email}`);
  const hook = p.kit?.card?.hook_email || p.grok?.hook; if (hook) bits.push(`hook: ${clean(hook, 160)}`);
  if (p.kit?.tier) bits.push(`tier ${p.kit.tier}`);
  if (p.pkg?.status === 'done' || Object.keys(p.pkg?.files || {}).some((k) => ['v', 'h'].includes(k))) bits.push('ads made');
  if (p.pkg?.noAds) bits.push(`no ads: ${clean(p.pkg.noAds, 100)}`);
  if (p.videoLink) bits.push('video link saved');
  if (p.listSource || p.source) bits.push(`from ${p.listSource || p.source}`);
  const lastNote = String(p.notes || '').trim().split('\n').pop(); if (lastNote) bits.push(`last note: ${clean(lastNote, 160)}`);
  return bits.join('; ') + '.';
}
function clientNote(c) {
  const pr = c.production || {}; const bits = [`${c.name}: client, ${c.status || 'active'}`];
  if (pr.styleMix && Object.keys(pr.styleMix).length) bits.push(`makes ${Object.entries(pr.styleMix).filter(([, n]) => n).map(([k, n]) => `${n} ${k}`).join(' + ')} per video`);
  else if (pr.videoStyle) bits.push(`style ${pr.videoStyle}`);
  if (pr.minClipSec || pr.maxClipSec) bits.push(`clips ${pr.minClipSec || '?'}-${pr.maxClipSec || '?'} s`);
  if (pr.aiTips) bits.push(`tips: ${clean(pr.aiTips, 160)}`);
  try { const m = require('../automation/finance').monthly(c.retainer); if (m) bits.push(`$${Math.round(m)}/month`); } catch { /* no finance */ }
  return bits.join('; ') + '.';
}

let sweeping = false;
/** Every minute: what changed in the database since the last sweep becomes notes. */
function sweep() {
  if (!ctx.store || sweeping) return; sweeping = true;
  try {
    const since = ctx.store.settings._halMemAt || ''; const stamp = now();
    for (const p of ctx.store.all('prospects')) {
      if (since && String(p.updatedAt || p.createdAt) <= since) continue;
      const key = `lead:${p.id}`; const prev = ctx.store.find(COL, (n) => n.key === key);
      if (!prev && since && String(p.createdAt) > since) add({ text: `New ${p.type === 'political' ? 'political' : 'creator'} lead: ${p.name}${p.office ? `, ${p.office}` : ''}${p.listSource || p.source ? ` (from ${p.listSource || p.source})` : ''}.`, about: [p.name], kind: 'event', source: 'leads', ttlDays: 120 });
      if (prev?.meta?.stage && p.stage && prev.meta.stage !== p.stage) add({ text: `${p.name} moved from ${STAGE[prev.meta.stage] || prev.meta.stage} to ${STAGE[p.stage] || p.stage}.`, about: [p.name], kind: 'event', source: 'pipeline', ttlDays: 365 });
      if (prev?.meta && prev.meta.result !== (p.electionResult || null) && p.electionResult) add({ text: `${p.name} ${p.electionResult === 'lost' ? 'lost' : 'won'} their race.`, about: [p.name], kind: 'fact', source: 'pipeline' });
      add({ text: leadNote(p), about: [p.name, p.office].filter(Boolean), kind: 'fact', source: 'lead board', key, meta: { stage: p.stage || 'new', result: p.electionResult || null, prospectId: p.id } });
    }
    for (const c of ctx.store.all('clients')) {
      if (since && String(c.updatedAt || c.createdAt) <= since) continue;
      add({ text: clientNote(c), about: [c.name], kind: 'fact', source: 'clients', key: `client:${c.id}`, meta: { clientId: c.id } });
    }
    ctx.store.settings._halMemAt = stamp; ctx.store.touch();
    digestIfDue();
  } finally { sweeping = false; }
}

// ------------------------------------------------------------------ the morning note
function learnedSince(ms) { const t = Date.now() - ms; return all().filter((n) => Date.parse(n.at) >= t && !n.key).sort((a, b) => String(a.at).localeCompare(String(b.at))); }
function digest(hours = 24) {
  const ns = learnedSince(hours * 3600000); if (!ns.length) return null;
  const groups = [['Leads and scouts', (n) => /scout|leads|pipeline/.test(n.source)], ['Outreach and replies', (n) => /outreach|inbox|outbox/.test(n.source)], ['Ads and video', (n) => /ad machine|approvals|publishing/.test(n.source) || (n.source === 'Claude' && n.kind === 'event')], ['News', (n) => n.kind === 'news'], ['Notes and lookups', () => true]];
  const used = new Set(); const out = [];
  for (const [title, test] of groups) {
    const g = ns.filter((n) => !used.has(n.id) && test(n)); if (!g.length) continue;
    g.forEach((n) => used.add(n.id));
    out.push(`${title} (${g.length}):`, ...g.slice(-6).map((n) => `- ${n.text}`), ...(g.length > 6 ? [`- and ${g.length - 6} more`] : []));
  }
  return { count: ns.length, text: out.join('\n') };
}
function digestIfDue() {
  const d = new Date(); const today = d.toISOString().slice(0, 10);
  if (d.getHours() < 7 || ctx.store.settings._halDigestDay === today) return;
  ctx.store.settings._halDigestDay = today; ctx.store.touch();
  const g = digest(24); if (!g) return;
  const m = ctx.store.insert('halMessages', { who: 'hal', text: `What I learned in the last day (${g.count} new note${g.count === 1 ? '' : 's'} in my notebook):\n${g.text}`, by: 'notebook' });
  events.publish('hal', { id: m.id });
}

let listening = false;
function start() { if (listening) return; listening = true; events.bus.on('audit', (e) => setImmediate(() => fromAudit(e))); }
start();

/** How much of the question's words this note contains (0-1): for "forget that ...", so only the meant note goes. */
function overlap(query, n) { const q = words(query); if (!q.length) return 0; const w = new Set(words(`${n.text} ${(n.about || []).join(' ')}`)); return q.filter((x) => w.has(x)).length / q.length; }

module.exports = { overlap, add, recall, list, update, remove, context, block, sweep, digest, fromAudit, start, COL };
