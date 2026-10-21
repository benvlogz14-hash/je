'use strict';
/**
 * Outreach autopilot, one lane per audience ('political' and 'creators').
 *
 *  - Daily scout: at the lane's scout hour, run the next saved search and
 *    build outreach for every new lead.
 *  - Auto-send (off until a founder switches it on): a finished draft is
 *    approved automatically only when every safety check passes; anything
 *    else waits in the review queue with the reason shown.
 *  - Daily limit with warm-up: a new inbox starts low and climbs each day,
 *    so mail providers don't flag the sending address.
 *
 * Sending itself still goes through messaging.deliver, which re-checks
 * opt-outs, quiet hours, the hourly cap and Test mode at send time.
 */
const ctx = require('../core/ctx');
const audit = require('../core/audit');
const events = require('../core/events');
const queue = require('../jobs/queue');
const messaging = require('../automation/messaging');
const { isGov, excluded, mailingAddress, noDashes, withFooter } = require('./common');
const { now } = require('../core/util');

const LANES = ['political', 'creators'];
const cfg = (lane) => ctx.setting(`outreach.${lane}`, {}) || {};
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: ctx.setting('agency.timezone', 'America/New_York') });

function counters() {
  const c = ctx.store.settings._outreach || {};
  if (c.day !== today()) { c.day = today(); c.sent = {}; c.scouted = {}; }
  ctx.store.settings._outreach = c; return c;
}

/** Today's sending limit: warm-up start + step per day since auto-send was switched on, up to the daily limit. */
function capToday(lane) {
  const c = cfg(lane); const since = ctx.store.settings._outreachSince?.[lane];
  const days = since ? Math.max(0, Math.floor((Date.now() - new Date(since).getTime()) / 864e5)) : 0;
  return Math.max(1, Math.min(Number(c.sendPerDay) || 50, (Number(c.warmupStart) || 15) + days * (Number(c.warmupStep) || 10)));
}

function laneOf(p) { return p.type === 'political' ? 'political' : 'creators'; }
function draftOf(p) { const id = p.type === 'political' ? p.pkg?.messageId : p.outreach?.messageId; return id ? ctx.store.get('messages', id) : null; }

/** Reasons a draft can't go out on its own. Empty list = safe to send. */
function checks(p, { ignoreCap = false } = {}) {
  const lane = laneOf(p); const c = cfg(lane); const why = [];
  const msg = draftOf(p);
  if (!c.autoSend) why.push('Auto-send is off');
  if (!msg || msg.status !== 'pending_approval') why.push('No draft waiting');
  if (!mailingAddress()) why.push('Add your mailing address (Outreach settings); the law requires it in every email');
  const contact = msg && ctx.store.get('contacts', msg.contactId);
  const to = contact?.emails?.[0] || '';
  if (!to) why.push('No email address');
  if (to && isGov(to)) why.push('Government address');
  if (contact?.optedOut?.email) why.push('Opted out');
  const ex = excluded({ name: p.name, email: to, handle: p.handle }); if (ex) why.push(`On the exclusions list (${ex})`);
  if (!p.contactVerified) why.push('Email not confirmed on their own pages or your imported list');
  if (ctx.store.find('messages', (m) => m.contactId === contact?.id && m.direction === 'in')) why.push('They have already written to us');
  if (lane === 'political') {
    if (p.pkg?.status !== 'ready') why.push('Package not finished');
    if (p.pkg?.creative?.hasContrast) why.push('Contrast ad: a person must review it');
    if ((p.pkg?.sources || []).length < 2 && !p.imported) why.push('Too little research');
  } else if (p.outreach?.status !== 'ready') why.push('Email not finished');
  if (!ignoreCap && (counters().sent[lane] || 0) >= capToday(lane)) why.push(`Today's limit reached (${capToday(lane)}); sends tomorrow`);
  return why;
}

/** Called when a lead's outreach is finished. Sends it if every check passes, else records why it waits. */
function maybeAutoSend(prospectId) {
  const p = ctx.store.get('prospects', prospectId); if (!p) return false;
  const lane = laneOf(p); const why = checks(p);
  const patchKey = p.type === 'political' ? 'pkg' : 'outreach';
  if (why.length) { ctx.store.update('prospects', p.id, (cur) => ({ [patchKey]: { ...(cur[patchKey] || {}), autoBlock: why } })); events.publish('prospects', { id: p.id }); return false; }
  const msg = draftOf(p);
  messaging.approveMessage(msg.id, 'autopilot');
  const c = counters(); c.sent[lane] = (c.sent[lane] || 0) + 1; ctx.store.touch();
  ctx.store.update('prospects', p.id, (cur) => ({ stage: 'contacted', [patchKey]: { ...(cur[patchKey] || {}), autoBlock: null, autoSent: true, sentAt: now() } }));
  audit.log('autopilot', 'outreach.auto_sent', { prospectId: p.id, lane, name: p.name });
  events.publish('prospects', { id: p.id });
  return true;
}

/** Founder approves drafts from the review queue (one or many). */
function approve(ids, actor, edits = {}) {
  const done = []; const errors = [];
  for (const id of (ids || []).slice(0, 500)) {
    const p = ctx.store.get('prospects', id); const msg = p && draftOf(p);
    try {
      if (!msg || msg.status !== 'pending_approval') throw new Error('no draft waiting');
      const ed = edits[id];
      if (ed?.subject) ctx.store.update('messages', msg.id, { subject: noDashes(ed.subject) });
      messaging.approveMessage(msg.id, actor, ed?.body ? withFooter(ed.body) : undefined);
      const key = p.type === 'political' ? 'pkg' : 'outreach';
      ctx.store.update('prospects', id, (cur) => ({ stage: 'contacted', [key]: { ...(cur[key] || {}), autoBlock: null, sentAt: now() } }));
      done.push(id);
    } catch (e) { errors.push(`${p?.name || id}: ${e.message}`); }
  }
  audit.log(actor, 'outreach.approved', { count: done.length });
  events.publish('prospects', {});
  return { approved: done.length, errors };
}

function skip(ids, actor) {
  let n = 0;
  for (const id of (ids || []).slice(0, 500)) {
    const p = ctx.store.get('prospects', id); const msg = p && draftOf(p);
    if (msg?.status === 'pending_approval') messaging.rejectMessage(msg.id, actor);
    if (p) { ctx.store.update('prospects', id, { stage: 'lost', skippedAt: now() }); n++; }
  }
  events.publish('prospects', {});
  return { skipped: n };
}

/** Everything waiting for a founder, newest first, with why autopilot held it. */
function reviewQueue(lane) {
  return ctx.store.all('prospects', (p) => laneOf(p) === lane && draftOf(p)?.status === 'pending_approval').map((p) => {
    const msg = draftOf(p); const contact = ctx.store.get('contacts', msg.contactId);
    return { id: p.id, name: p.name, type: p.type, office: p.pkg?.profile?.office || p.location || '', handle: p.handle, followers: p.followers, to: contact?.emails?.[0] || '', subject: msg.subject, body: msg.body, messageId: msg.id, attachments: (msg.attachments || []).map((a) => ({ name: a.name, size: a.size })), files: p.pkg?.files ? Object.keys(p.pkg.files) : [], hasContrast: !!p.pkg?.creative?.hasContrast, why: checks(p, { ignoreCap: true }).filter((w) => w !== 'Auto-send is off'), createdAt: msg.createdAt };
  }).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

function status() {
  const c = counters();
  return Object.fromEntries(LANES.map((l) => [l, { ...cfg(l), sentToday: c.sent[l] || 0, capToday: capToday(l), scoutedToday: c.scouted[l] || 0, waiting: reviewQueue(l).length, autoSendSince: ctx.store.settings._outreachSince?.[l] || null, lastScout: ctx.store.settings._outreachScout?.[l] || null }]));
}

/** Remember when auto-send was switched on, for the warm-up ramp. */
function noteSettings(patch) {
  const since = { ...(ctx.store.settings._outreachSince || {}) };
  for (const l of LANES) {
    const on = patch?.outreach?.[l]?.autoSend;
    if (on === true && !since[l]) since[l] = now();
    if (on === false) delete since[l];
  }
  ctx.store.settings._outreachSince = since; ctx.store.touch();
}

/** Runs every minute from the scheduler. */
function tick() {
  if (queue.paused) return;
  const tz = ctx.setting('agency.timezone', 'America/New_York');
  const hour = Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: tz }).format(new Date()));
  const c = counters(); const last = ctx.store.settings._outreachScout || {};
  for (const lane of LANES) {
    const l = cfg(lane);
    // Daily scout, once a day at the chosen hour, rotating through the saved searches.
    if (l.scout && hour >= (Number(l.scoutHour) || 7) && last[lane]?.day !== c.day) {
      const queries = String(l.scoutQueries || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
      if (queries.length) {
        const i = ((last[lane]?.i ?? -1) + 1) % queries.length;
        queue.enqueue(lane === 'political' ? 'political.scout' : 'creator.scout', { query: queries[i], count: Math.max(1, Math.min(100, Number(l.scoutPerDay) || 15)), autoPackage: true, daily: true }, { actor: 'autopilot', dedupeKey: `scout:${lane}:${c.day}` });
        last[lane] = { day: c.day, i, query: queries[i], at: now() };
        ctx.store.settings._outreachScout = last; ctx.store.touch();
        c.scouted[lane] = (c.scouted[lane] || 0) + 1;
      }
    }
    // Drafts held back by yesterday's limit go out first thing today.
    if (l.autoSend && (c.sent[lane] || 0) < capToday(lane)) {
      for (const p of ctx.store.all('prospects', (x) => laneOf(x) === lane && (x.pkg?.autoBlock || x.outreach?.autoBlock || []).some((w) => /limit reached/.test(w))).slice(0, 25)) {
        if ((counters().sent[lane] || 0) >= capToday(lane)) break;
        maybeAutoSend(p.id);
      }
    }
  }
}

module.exports = { LANES, checks, maybeAutoSend, approve, skip, reviewQueue, status, tick, noteSettings, capToday, laneOf };
