'use strict';
/**
 * Autopilot. Once a minute it keeps every client on autopilot fed to their
 * daily quota (e.g. Stringer Media: 6 shorts/day to every platform):
 *   open slots in the next N days − (in review + in production + approved)
 *   = clips to make now → discover from unused footage → render → review.
 * It schedules approved clips into free slots, asks for footage when a
 * client runs dry, posts a daily digest, and runs periodic maintenance.
 */
const ctx = require('../core/ctx');
const events = require('../core/events');
const audit = require('../core/audit');
const queue = require('../jobs/queue');
const pipeline = require('./pipeline');
const messaging = require('./messaging');
const { now } = require('../core/util');

let timer = null;
const lastRun = {};
const every = (key, ms) => { if (Date.now() - (lastRun[key] || 0) < ms) return false; lastRun[key] = Date.now(); return true; };
const activeJob = (pred) => ctx.store.find('jobs', (j) => ['queued', 'running'].includes(j.status) && pred(j));

function feedClient(client) {
  // Schedule anything approved but not yet slotted.
  for (const c of ctx.store.all('clips', (x) => x.clientId === client.id && x.status === 'approved' && !x.postId)) pipeline.scheduleClip(c.id);
  const q = pipeline.quotaStatus(client);
  const pipelineCount = q.inReview + q.inProduction + q.approvedUnscheduled;
  const need = q.open - pipelineCount;
  if (need <= 0) return { client: client.name, need: 0 };
  if (activeJob((j) => j.clientId === client.id && ['discover', 'transcribe', 'analyze', 'ingest.file', 'ingest.url'].includes(j.type))) return { client: client.name, need, waiting: 'intake in progress' };
  const assets = ctx.store.all('assets', (a) => a.clientId === client.id && a.status === 'ready' && !a.exhausted && a.info?.hasVideo !== false).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const untranscribed = assets.find((a) => a.info?.hasAudio && !a.transcript);
  if (untranscribed) {
    queue.enqueue('transcribe', { assetId: untranscribed.id, thenDiscover: true }, { clientId: client.id, dedupeKey: `transcribe:${untranscribed.id}`, title: `Transcribe ${untranscribed.name}` });
    return { client: client.name, need, action: 'transcribe' };
  }
  const asset = assets[0];
  if (asset) {
    queue.enqueue('discover', { assetId: asset.id, count: Math.min(need + 1, 8) }, { clientId: client.id, dedupeKey: `discover:${asset.id}:${Math.floor(Date.now() / 600000)}`, title: `Find ${Math.min(need + 1, 8)} clips for ${client.name}` });
    return { client: client.name, need, action: 'discover' };
  }
  // Out of footage: alert once a day and prepare (not send) a footage request for approval.
  const key = `dry:${client.id}`;
  if (every(key, 24 * 3600000)) {
    events.publish('alert', { level: 'warn', title: `${client.name} needs footage`, text: `${q.open} open posting slots in the next ${client.schedule.bufferDays || 2} days and no unused footage.` });
    audit.log('system', 'autopilot.out_of_footage', { clientId: client.id, open: q.open }, 'warn');
    const contact = ctx.store.get('contacts', client.primaryContactId || (client.contactIds || [])[0]);
    if (contact) {
      try {
        messaging.createOutbound({ contactId: contact.id, body: `Hi ${contact.name.split(' ')[0]}, we're almost through the footage we have for your next round of shorts. Could you send over any new long-form videos, streams or raw clips? A link or upload to your portal works: ${pipeline.portalUrl(client)}`, aiGenerated: true, agent: 'autopilot', category: 'routine', actor: 'system' });
      } catch (e) { audit.log('system', 'autopilot.footage_request_failed', { clientId: client.id, error: e.message }, 'warn'); }
    }
  }
  return { client: client.name, need, action: 'needs footage' };
}

function digest() {
  const clients = ctx.store.all('clients', (c) => c.status === 'active');
  const rows = clients.map((c) => ({ id: c.id, name: c.name, ...pipeline.quotaStatus(c) }));
  const pendingApprovals = ctx.store.all('approvals', (a) => a.status === 'pending').length;
  const failed = ctx.store.all('jobs', (j) => j.status === 'failed' && (j.finishedAt || '') > new Date(Date.now() - 864e5).toISOString()).length;
  const conv = messaging.commandConversation();
  messaging.addMessage(conv, { direction: 'in', channel: 'system', status: 'received', body: `Good morning. ${pendingApprovals} item${pendingApprovals === 1 ? '' : 's'} waiting for approval${failed ? `, ${failed} failed job${failed === 1 ? '' : 's'} to look at` : ''}.`, card: { type: 'digest', data: { rows, pendingApprovals, failed } } });
}

/** One B-roll edit per day per client: from the footage with the fewest B-roll edits so far (newest first on a tie). */
function dailyBroll(client) {
  const tz = ctx.setting('agency.timezone', 'America/New_York'); const day = pipeline.localDate(new Date(), tz);
  if ((client.production || {})._brollDay === day) return;
  const assets = ctx.store.all('assets', (a) => a.clientId === client.id && ['ready', 'waiting'].includes(a.status) && a.info?.hasVideo !== false && a.info?.duration > 20);
  if (!assets.length) return;
  const count = (a) => ctx.store.all('clips', (c) => c.assetId === a.id && c.kind === 'broll').length;
  const a = assets.sort((x, y) => count(x) - count(y) || String(y.createdAt).localeCompare(String(x.createdAt)))[0];
  ctx.store.update('clients', client.id, (c) => ({ production: { ...(c.production || {}), _brollDay: day } }));
  pipeline.createBrollClip(a);
  audit.log('system', 'broll.daily', { clientId: client.id, assetId: a.id });
}

function tick() {
  if (queue.paused) return;
  const lite = ctx.setting('resources.mode', 'full') === 'lite';
  for (const client of ctx.store.all('clients', (c) => c.status === 'active' && c.schedule?.autopilot)) {
    try { feedClient(client); } catch (e) { audit.log('system', 'autopilot.error', { clientId: client.id, error: e.message }, 'error'); }
  }
  // B-roll edit of the day: clients with "one per day" get a fresh one from their footage (it goes to review like any clip).
  for (const client of ctx.store.all('clients', (c) => c.status === 'active' && c.production?.brollDaily)) {
    try { dailyBroll(client); } catch (e) { audit.log('system', 'broll.daily_error', { clientId: client.id, error: e.message }, 'error'); }
  }
  require('../integrations/elevenlabs').pollCalls().catch(() => {});
  try { require('../outreach/autopilot').tick(); } catch (e) { audit.log('system', 'outreach.autopilot_error', { error: e.message }, 'error'); }
  const tz = ctx.setting('agency.timezone', 'America/New_York');
  const hour = Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: tz }).format(new Date()));
  const day = pipeline.localDate(new Date(), tz);
  if (hour === ctx.setting('schedule.dailyDigestHour', 8) && ctx.store.settings._digestDay !== day) { ctx.store.settings._digestDay = day; ctx.store.touch(); digest(); }
  if (hour === 3 && ctx.store.settings._backupDay !== day) { ctx.store.settings._backupDay = day; ctx.store.touch(); queue.enqueue('backup', {}, { dedupeKey: `backup:${day}` }); }
  if (!lite && every('sources', 30 * 60000) && ctx.store.all('clients', (c) => (c.sources || []).some((s) => s.auto)).length) queue.enqueue('source.check', {}, { dedupeKey: `sources:${Math.floor(Date.now() / 1800000)}` });
  if (!lite && every('analytics', 6 * 3600000) && ctx.store.all('posts', (p) => p.status === 'published').length) queue.enqueue('analytics.sync', {}, { dedupeKey: `analytics:${Math.floor(Date.now() / 21600000)}` });
  if (every('renewals', 12 * 3600000)) {
    const soon = new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10);
    for (const c of ctx.store.all('clients', (x) => x.status === 'active' && x.retainer?.renewalDate && x.retainer.renewalDate <= soon && x.retainer.renewalDate >= now().slice(0, 10))) {
      events.publish('alert', { level: 'info', title: `${c.name} renews ${c.retainer.renewalDate}`, text: 'Contract renewal within 7 days.' });
    }
  }
}

function start() { timer = setInterval(tick, 60000); setTimeout(tick, 5000); }
function stop() { clearInterval(timer); }

module.exports = { start, stop, tick, feedClient, digest };
