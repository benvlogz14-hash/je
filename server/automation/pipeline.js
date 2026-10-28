'use strict';
/**
 * The production pipeline, one complete workflow end to end:
 * footage in → transcript → clip candidates → renders → QC → approval
 * (founder, then optionally the client) → revisions from feedback →
 * scheduled into the client's posting slots → published → analytics.
 */
const fs = require('fs');
const path = require('path');
const ctx = require('../core/ctx');
const events = require('../core/events');
const audit = require('../core/audit');
const paths = require('../core/paths');
const queue = require('../jobs/queue');
const captions = require('../video/captions');
const { now, id: makeId } = require('../core/util');

// ------------------------------------------------------------ client defaults
function clientDefaults(type = 'creator') {
  return {
    status: 'active', type,
    retainer: { amount: 0, interval: 'monthly', billingDay: 1, startDate: now().slice(0, 10) },
    profile: { about: '', audience: '', voice: '', topics: '', avoid: '', hashtags: '' },
    style: { ...captions.DEFAULT_STYLE },
    graphics: JSON.parse(JSON.stringify(captions.DEFAULT_GRAPHICS)),
    production: { reframe: ctx.setting('production.reframe', 'face'), silenceCut: true, retakeCut: true, punchIns: true, focusX: 0.5, logoPath: '', clipsPerFootage: ctx.setting('production.defaultClipCount', 6) },
    schedule: { autopilot: false, shortsPerDay: 3, slots: ['10:00', '14:00', '19:00'], platforms: ['tiktok', 'instagram', 'youtube'], timezone: ctx.setting('agency.timezone', 'America/New_York'), bufferDays: 2 },
    approval: { mode: type === 'political' ? 'founder+client' : 'founder', clientChannel: 'sms' },
    sources: [], accounts: {}, memory: [], contactIds: [],
    portalToken: makeId('pt_') + makeId(''),
  };
}

function createClient(data, actor = 'user') {
  const base = clientDefaults(data.type);
  const c = ctx.store.insert('clients', { ...base, ...data, profile: { ...base.profile, ...(data.profile || {}) }, style: { ...base.style, ...(data.style || {}) }, production: { ...base.production, ...(data.production || {}) }, schedule: { ...base.schedule, ...(data.schedule || {}) }, approval: { ...base.approval, ...(data.approval || {}) } });
  enforceApprovalPolicy(c);
  paths.clientDir(c.id, 'footage');
  audit.log(actor, 'client.created', { clientId: c.id, name: c.name });
  events.publish('clients', c);
  return c;
}

/** Political content is never auto-approved, whatever the settings say. */
function enforceApprovalPolicy(c) {
  if (c.type === 'political' && c.approval?.mode === 'auto') ctx.store.update('clients', c.id, { approval: { ...c.approval, mode: 'founder+client' } });
}

// ------------------------------------------------------------ assets
function addAsset({ clientId, filePath, source = 'manual', actor = 'user', name }) {
  const client = ctx.store.get('clients', clientId);
  if (!client) throw new Error('Client not found');
  if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
  const dupe = ctx.store.find('assets', (a) => a.clientId === clientId && a.path === filePath);
  if (dupe) return dupe;
  const asset = ctx.store.insert('assets', { clientId, name: name || path.basename(filePath), path: filePath, source, status: 'importing', info: null, createdBy: actor });
  const workDir = paths.clientDir(clientId, 'work', asset.id);
  ctx.store.update('assets', asset.id, { workDir });
  audit.log(actor, 'footage.added', { clientId, assetId: asset.id, name: asset.name, source });
  queue.enqueue('ingest.file', { assetId: asset.id }, { clientId, title: `Import ${asset.name}`, dedupeKey: `ingest:${asset.id}`, priority: 6 });
  events.publish('assets', ctx.store.get('assets', asset.id));
  return ctx.store.get('assets', asset.id);
}

function usedRanges(assetId) { return ctx.store.all('clips', (c) => c.assetId === assetId && c.status !== 'rejected').map((c) => ({ start: c.start, end: c.end })); }

// ------------------------------------------------------------ clips
function createClips(asset, discovered) {
  const client = ctx.store.get('clients', asset.clientId);
  const prod = client.production || {};
  const created = [];
  for (const d of discovered.clips) {
    const clip = ctx.store.insert('clips', {
      ref: nextRef(), clientId: asset.clientId, assetId: asset.id, start: d.start, end: d.end, title: d.title || 'Untitled clip', hook: d.hook || '', caption: d.caption || '',
      hashtags: (d.hashtags || []).map((h) => String(h).replace(/^#/, '')).slice(0, 12), score: d.score ?? null, keep: Array.isArray(d.keep) ? d.keep : null, reason: d.reason || '', method: discovered.method, agent: d.agent || null,
      // Style mix: this clip's own look (a preset's captions and title over the client's), set before it renders.
      ...(d.style ? { style: d.style } : {}), ...(d.videoStyle ? { videoStyle: d.videoStyle } : {}), ...(d.tightCuts ? { tightCuts: true } : {}),
      wide: !!prod.wide, punchIns: prod.punchIns ? (d.punchIns || []) : [], reframe: d.reframe || prod.reframe || 'smart-blur', focusX: prod.focusX ?? 0.5, silenceCut: prod.silenceCut !== false, retakeCut: prod.retakeCut !== false,
      trials: (d.trials || []).filter((t) => t && t.hook && t.hook !== d.hook).slice(0, 3).map((t) => ({ name: String(t.name || 'Trial').slice(0, 30), test: String(t.test || '').slice(0, 160), hook: String(t.hook).slice(0, 80), start: Number(t.start) >= d.start && Number(t.start) < d.end - 8 ? Number(t.start) : d.start })),
      status: 'queued', versions: [], currentVersion: 0, feedback: [], approvalId: null, postId: null,
    });
    created.push(clip);
    requestRender(clip, { reason: 'initial' });
  }
  events.publish('clips', { assetId: asset.id });
  return created;
}

/** The extra B-roll edit for a video (music-only cut-through of its best shots), when the client has it switched on. */
function createBrollClip(asset) {
  const client = ctx.store.get('clients', asset.clientId); const prod = client?.production || {};
  const len = Math.max(8, Math.min(60, Number(prod.brollSeconds) || 20)); const day = new Date().toISOString().slice(0, 10);
  const clip = ctx.store.insert('clips', {
    ref: nextRef(), clientId: asset.clientId, assetId: asset.id, kind: 'broll', start: 0, end: len, title: `B-roll edit: ${String(asset.name || 'video').replace(/\.[^.]+$/, '')}`.slice(0, 80), brollDay: day, hook: '', caption: '', hashtags: [],
    method: 'broll', reason: 'A dramatic, music-only cut-through of the best shots', music: prod.brollMood || 'darkbeat', status: 'queued', versions: [], currentVersion: 0, feedback: [], approvalId: null, postId: null,
  });
  requestRender(clip, { reason: 'initial' });
  events.publish('clips', { assetId: asset.id });
  return clip;
}

/**
 * Story text edits for one video (client video style "story"): n edits, each drawing its shots from its own part of the
 * video in order (so the six edits tell six different stretches and never share shots), with its own text lines.
 */
function createStoryClips(asset, n) {
  const client = ctx.store.get('clients', asset.clientId); const prod = client?.production || {};
  const len = Math.max(15, Math.min(90, Number(prod.storySeconds) || 45)); const dur = asset.info?.duration || 0;
  const have = ctx.store.all('clips', (c) => c.assetId === asset.id && c.kind === 'story').length;
  const total = have + n; const out = [];
  for (let i = have; i < total; i++) {
    const a = dur ? (dur * i) / total : 0, b = dur ? (dur * (i + 1)) / total : 0;
    out.push(ctx.store.insert('clips', {
      ref: nextRef(), clientId: asset.clientId, assetId: asset.id, kind: 'story', start: 0, end: len, window: dur ? [Math.round(a * 10) / 10, Math.round(b * 10) / 10] : null, part: i + 1,
      title: `Story ${i + 1}: ${String(asset.name || 'video').replace(/\.[^.]+$/, '')}`.slice(0, 80), hook: '', caption: '', hashtags: [],
      method: 'story', reason: 'Text lines tell the story over the best shots of this part of the video, to intense music', music: prod.storyMood || 'suspense', status: 'queued', versions: [], currentVersion: 0, feedback: [], approvalId: null, postId: null,
    }));
    requestRender(out[out.length - 1], { reason: 'initial' });
  }
  events.publish('clips', { assetId: asset.id });
  return out;
}

function nextRef() { const n = (ctx.store.settings._clipSeq || 100) + 1; ctx.store.settings._clipSeq = n; ctx.store.touch(); return n; }

function requestRender(clip, { reason = 'render', changes = null } = {}) {
  ctx.store.update('clips', clip.id, { status: 'rendering', pendingChanges: changes });
  if (ctx.setting('production.preferPremiere', false)) {
    return queue.enqueue('premiere.handoff', { clipId: clip.id, reason }, { clientId: clip.clientId, title: `Premiere edit: ${clip.title}`, dedupeKey: `premiere:${clip.id}:${(clip.versions || []).length + 1}` });
  }
  // A render already running started before this change, so it won't include it: queue a fresh one after it.
  // (A render that is still waiting reads the clip when it starts, so joining that one is fine.)
  let key = `render:${clip.id}:${(clip.versions || []).length + 1}`;
  if (ctx.store.find('jobs', (j) => j.dedupeKey === key && j.status === 'running')) key += `:again:${Date.now()}`;
  return queue.enqueue('render.short', { clipId: clip.id, reason }, { clientId: clip.clientId, title: `Render: ${clip.title}`, dedupeKey: key, priority: 5 });
}

/** Called after QC. Opens the right approval or auto-approves for creator clients on autopilot. */
function afterQc(clipId, qc) {
  const clip = ctx.store.get('clips', clipId); const client = ctx.store.get('clients', clip.clientId);
  const mode = client.type === 'political' && client.approval.mode === 'auto' ? 'founder+client' : client.approval.mode;
  if (mode === 'auto' && qc.passed) {
    ctx.store.update('clips', clipId, { status: 'approved', approvedBy: 'auto-qc', approvedAt: now() });
    audit.log('system', 'clip.auto_approved', { clipId, clientId: client.id });
    return scheduleClip(clipId);
  }
  const existing = clip.approvalId && ctx.store.get('approvals', clip.approvalId);
  if (existing && existing.status === 'pending') ctx.store.update('approvals', existing.id, { version: clip.currentVersion, qc: { passed: qc.passed, issues: qc.issues } });
  else {
    const a = ctx.store.insert('approvals', { kind: 'clip', refId: clipId, clientId: client.id, title: clip.title, summary: clip.hook || clip.caption, status: 'pending', stage: 'internal', version: clip.currentVersion, qc: { passed: qc.passed, issues: qc.issues }, createdBy: 'system' });
    ctx.store.update('clips', clipId, { approvalId: a.id });
    events.publish('approval', a);
  }
  ctx.store.update('clips', clipId, { status: 'review' });
  events.publish('clips', { id: clipId });
}

/**
 * Decide on a clip. stage 'internal' = founder/contractor review; 'client' = client review.
 * decision: 'approve' | 'changes' | 'reject'
 */
function decideClip(clipId, decision, { actor = 'user', note = '', stage } = {}) {
  const clip = ctx.store.get('clips', clipId); if (!clip) throw new Error('Clip not found');
  const client = ctx.store.get('clients', clip.clientId);
  const appr = clip.approvalId ? ctx.store.get('approvals', clip.approvalId) : null;
  stage = stage || appr?.stage || 'internal';
  const decidedAt = now();
  if (decision === 'reject') {
    ctx.store.update('clips', clipId, { status: 'rejected' });
    if (appr) ctx.store.update('approvals', appr.id, { status: 'rejected', decidedBy: actor, decidedAt, note });
    audit.log(actor, 'clip.rejected', { clipId, clientId: client.id, stage, note });
  } else if (decision === 'changes') {
    const fb = { id: makeId('fb_'), at: decidedAt, from: actor, stage, text: note };
    ctx.store.update('clips', clipId, (c) => ({ status: 'revising', feedback: [...(c.feedback || []), fb] }));
    if (appr) ctx.store.update('approvals', appr.id, { status: 'changes', decidedBy: actor, decidedAt, note });
    queue.enqueue('clip.revise', { clipId, feedback: note, source: stage === 'client' ? 'client' : 'internal' }, { clientId: client.id, title: `Revise: ${clip.title}`, priority: 7 });
    audit.log(actor, 'clip.changes_requested', { clipId, clientId: client.id, stage, note });
  } else if (decision === 'approve') {
    if (stage === 'internal' && client.approval.mode === 'founder+client') {
      if (appr) ctx.store.update('approvals', appr.id, { status: 'approved', decidedBy: actor, decidedAt });
      const ca = ctx.store.insert('approvals', { kind: 'clip', refId: clipId, clientId: client.id, title: clip.title, summary: clip.hook, status: 'pending', stage: 'client', version: clip.currentVersion, createdBy: actor });
      ctx.store.update('clips', clipId, { status: 'client_review', approvalId: ca.id });
      notifyClientReview(client);
      audit.log(actor, 'clip.sent_to_client', { clipId, clientId: client.id });
    } else {
      if (appr) ctx.store.update('approvals', appr.id, { status: 'approved', decidedBy: actor, decidedAt });
      ctx.store.update('clips', clipId, { status: 'approved', approvedBy: actor, approvedAt: decidedAt });
      audit.log(actor, 'clip.approved', { clipId, clientId: client.id, stage });
      scheduleClip(clipId);
    }
  }
  events.publish('clips', { id: clipId });
  events.publish('approval', { id: clip.approvalId });
  return ctx.store.get('clips', clipId);
}

/** Batch the client notification: one message per review round, sent after a short delay to collect clips. */
let notifyTimers = {};
function notifyClientReview(client) {
  clearTimeout(notifyTimers[client.id]);
  notifyTimers[client.id] = setTimeout(() => {
    try {
      const pending = ctx.store.all('clips', (c) => c.clientId === client.id && c.status === 'client_review');
      if (!pending.length) return;
      const contact = ctx.store.get('contacts', client.primaryContactId || (client.contactIds || [])[0]);
      if (!contact) return audit.log('system', 'client_review.no_contact', { clientId: client.id }, 'warn');
      const url = portalUrl(client);
      const list = pending.slice(0, 8).map((c, i) => `${i + 1}. ${c.title}`).join('\n');
      const body = `Hi ${contact.name.split(' ')[0]}, ${pending.length} new video${pending.length > 1 ? 's are' : ' is'} ready for your review:\n${list}\n\nWatch and approve here: ${url}\nOr just reply "approve all", or tell us what to change.`;
      require('./messaging').createOutbound({ contactId: contact.id, channel: client.approval.clientChannel === 'email' ? 'email' : undefined, body, subject: `${pending.length} video${pending.length > 1 ? 's' : ''} ready for review`, aiGenerated: false, category: 'routine', actor: 'system', skipApproval: true });
    } catch (e) { audit.log('system', 'client_review.notify_failed', { clientId: client.id, error: e.message }, 'warn'); }
  }, 60000);
}

function portalUrl(client) {
  const base = ctx.setting('server.publicUrl', '') || `http://${ctx.lanAddress || '127.0.0.1'}:${ctx.setting('server.port', 4870)}`;
  return `${base.replace(/\/$/, '')}/portal/${client.portalToken}`;
}

// ------------------------------------------------------------ client memory
/** Store durable preferences and apply any style changes to all future renders. */
function remember(clientId, items, { source = 'feedback', actor = 'system' } = {}) {
  const client = ctx.store.get('clients', clientId); if (!client) return;
  const added = [];
  for (const it of items || []) {
    if (!it?.text) continue;
    const m = { id: makeId('me_'), text: String(it.text).slice(0, 400), at: now(), source, style: it.style || null, active: true, by: actor };
    added.push(m);
  }
  if (!added.length) return [];
  const styleMerge = Object.assign({}, ...added.map((m) => m.style || {}));
  ctx.store.update('clients', clientId, (c) => ({ memory: [...(c.memory || []), ...added], style: { ...(c.style || {}), ...sanitizeStyle(styleMerge) } }));
  audit.log(actor, 'client.memory_updated', { clientId, items: added.map((m) => m.text) });
  events.publish('clients', { id: clientId });
  return added;
}

const STYLE_KEYS = { hookSeconds: 'n', preset: 's', font: 's', size: 'n', uppercase: 'b', wordsPerLine: 'n', primary: 'c', highlight: 'c', outline: 'c', outlineWidth: 'n', position: 's', animation: 's', highlightMode: 's', box: 'b', hook: 'b', hookBg: 'c', hookColor: 'c', punctuation: 'b', shadow: 'n', hookFont: 's', hookSize: 'n', hookPosition: 's', hookBox: 'b', hookOutline: 'c', hookOutlineWidth: 'n', hookTilt: 'n', hookRadius: 'n', hookShadow: 'n', hookAnim: 's', hookText: 't', rotate: 'n', hookUpper: 'b', hookCapsFirst: 'b' };
function sanitizeStyle(s) {
  const o = {};
  for (const [k, t] of Object.entries(STYLE_KEYS)) {
    if (s[k] === undefined) continue;
    const v = s[k];
    if (t === 'n' && Number.isFinite(+v)) o[k] = +v;
    else if (t === 'b') o[k] = !!v;
    else if (t === 'c' && /^#[0-9a-f]{6}$/i.test(v)) o[k] = v;
    else if (t === 's' && typeof v === 'string') o[k] = v.slice(0, 40);
    else if (t === 't' && typeof v === 'string') o[k] = v.replace(/[{}\\]/g, '').slice(0, 160);
  }
  if (o.wordsPerLine) o.wordsPerLine = Math.max(1, Math.min(8, Math.round(o.wordsPerLine)));
  if (o.size) o.size = Math.max(30, Math.min(220, o.size));
  if (o.hookSeconds != null) o.hookSeconds = Math.max(0, Math.min(15, o.hookSeconds));
  if (o.outlineWidth != null) o.outlineWidth = Math.max(0, Math.min(30, o.outlineWidth));
  if (o.hookSize) o.hookSize = Math.max(30, Math.min(260, o.hookSize));
  if (o.hookOutlineWidth != null) o.hookOutlineWidth = Math.max(0, Math.min(30, o.hookOutlineWidth));
  if (o.hookTilt != null) o.hookTilt = Math.max(-30, Math.min(30, o.hookTilt));
  if (o.rotate != null) o.rotate = Math.max(-30, Math.min(30, o.rotate));
  if (o.shadow != null) o.shadow = Math.max(0, Math.min(12, o.shadow));
  return o;
}

// ------------------------------------------------------------ scheduling
function tzOffsetMs(date, tz) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(date).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute, +parts.second);
  return asUtc - date.getTime();
}
/** Convert a wall-clock time in a timezone to a UTC Date. */
function zoned(dateStr, timeStr, tz) {
  const [y, m, d] = dateStr.split('-').map(Number); const [hh, mm] = timeStr.split(':').map(Number);
  let guess = new Date(Date.UTC(y, m - 1, d, hh, mm));
  guess = new Date(guess.getTime() - tzOffsetMs(guess, tz));
  return new Date(Date.UTC(y, m - 1, d, hh, mm) - tzOffsetMs(guess, tz));
}
function localDate(d, tz) { return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d); }

/** Upcoming posting slots for a client (UTC ISO strings). */
function upcomingSlots(client, days = 3) {
  const s = client.schedule || {}; const tz = s.timezone || 'America/New_York';
  const slots = (s.slots || []).slice(0, s.shortsPerDay || s.slots.length).sort();
  const out = []; const start = Date.now() + 20 * 60000;
  for (let i = 0; i < days; i++) {
    const day = localDate(new Date(Date.now() + i * 864e5), tz);
    for (const t of slots) { const at = zoned(day, t, tz); if (at.getTime() > start) out.push(at.toISOString()); }
  }
  return out;
}

function scheduleClip(clipId) {
  const clip = ctx.store.get('clips', clipId); const client = ctx.store.get('clients', clip.clientId);
  if (clip.postId) return ctx.store.get('posts', clip.postId);
  const taken = new Set(ctx.store.all('posts', (p) => p.clientId === client.id && ['scheduled', 'publishing', 'published'].includes(p.status)).map((p) => p.scheduledAt));
  const slot = upcomingSlots(client, 21).find((s) => !taken.has(s));
  if (!slot) { audit.log('system', 'schedule.no_slot', { clipId, clientId: client.id }, 'warn'); return null; }
  const v = (clip.versions || [])[clip.currentVersion - 1];
  const post = ctx.store.insert('posts', {
    clientId: client.id, clipId, title: clip.title, caption: clip.caption, hashtags: [...(clip.hashtags || []), ...String(client.profile?.hashtags || '').split(/[\s,]+/).filter(Boolean).map((h) => h.replace(/^#/, ''))].filter((h, i, a) => a.indexOf(h) === i).slice(0, 15),
    platforms: client.schedule.platforms || [], scheduledAt: slot, status: 'scheduled', videoPath: v?.path || null, results: {}, version: clip.currentVersion,
  });
  ctx.store.update('clips', clipId, { status: 'scheduled', postId: post.id });
  queue.enqueue('publish.post', { postId: post.id }, { clientId: client.id, runAt: new Date(new Date(slot).getTime() - 15 * 60000).toISOString(), title: `Publish: ${clip.title}`, dedupeKey: `publish:${post.id}`, priority: 9 });
  audit.log('system', 'post.scheduled', { postId: post.id, clipId, clientId: client.id, at: slot, platforms: post.platforms });
  events.publish('posts', post);
  return post;
}

function unschedule(postId, actor = 'user') {
  const post = ctx.store.get('posts', postId); if (!post || post.status !== 'scheduled') throw new Error('Only scheduled posts can be pulled');
  const job = ctx.store.find('jobs', (j) => j.dedupeKey === `publish:${postId}` && j.status === 'queued');
  if (job) queue.cancel(job.id, actor);
  ctx.store.update('posts', postId, { status: 'canceled' });
  ctx.store.update('clips', post.clipId, { status: 'approved', postId: null });
  audit.log(actor, 'post.unscheduled', { postId, clientId: post.clientId });
  events.publish('posts', post);
}

/** Production pacing for a client: what the next few days look like against the daily quota. */
function quotaStatus(client) {
  const slots = upcomingSlots(client, client.schedule.bufferDays || 2);
  const scheduled = ctx.store.all('posts', (p) => p.clientId === client.id && p.status === 'scheduled' && slots.includes(p.scheduledAt)).length;
  const inReview = ctx.store.all('clips', (c) => c.clientId === client.id && ['review', 'client_review'].includes(c.status)).length;
  const inProduction = ctx.store.all('clips', (c) => c.clientId === client.id && ['queued', 'rendering', 'revising'].includes(c.status)).length;
  const approvedUnscheduled = ctx.store.all('clips', (c) => c.clientId === client.id && c.status === 'approved').length;
  const unusedFootage = ctx.store.all('assets', (a) => a.clientId === client.id && a.status === 'ready' && !a.exhausted).length;
  const today = localDate(new Date(), client.schedule.timezone);
  const postedToday = ctx.store.all('posts', (p) => p.clientId === client.id && p.status === 'published' && localDate(new Date(p.scheduledAt), client.schedule.timezone) === today).length;
  return { slotsAhead: slots.length, scheduled, open: Math.max(0, slots.length - scheduled), inReview, inProduction, approvedUnscheduled, unusedFootage, perDay: client.schedule.shortsPerDay, postedToday };
}

module.exports = { createStoryClips, createBrollClip, nextRef, clientDefaults, createClient, enforceApprovalPolicy, addAsset, usedRanges, createClips, requestRender, afterQc, decideClip, remember, sanitizeStyle, upcomingSlots, scheduleClip, unschedule, quotaStatus, portalUrl, zoned, localDate };
