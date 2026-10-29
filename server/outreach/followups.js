'use strict';
/**
 * Follow-up emails for leads who haven't replied.
 *
 * Off until a founder switches it on per lane. A few days after the last email
 * (outreach.<lane>.followUpDays, e.g. "4, 10") a short, polite follow-up is
 * written in the same email thread. It sends on its own only when that lane's
 * auto-send is on and every safety check passes; otherwise it waits in
 * Approvals. Anyone who replied, opted out, was skipped or booked never gets one.
 */
const ctx = require('../core/ctx');
const audit = require('../core/audit');
const events = require('../core/events');
const ai = require('../integrations/ai');
const messaging = require('../automation/messaging');
const { isGov, excluded, mailingAddress, noDashes, withFooter } = require('./common');
const { now } = require('../core/util');
const learning = require('./learning');

const cfg = (lane) => ctx.setting(`outreach.${lane}`, {}) || {};
const days = (lane) => lane === 'political' ? [4] : String(cfg(lane).followUpDays ?? '4, 10').split(/[,\s]+/).map(Number).filter((n) => n > 0).slice(0, 5);
const DONE_STAGES = ['replied', 'meeting', 'won', 'lost', 'client'];

/** The thread for this lead: our sent emails, and whether they ever wrote back. */
function thread(p) {
  const first = p.type === 'political' ? p.kit?.messageId || p.pkg?.messageId : p.outreach?.messageId;
  const m = first && ctx.store.get('messages', first);
  if (!m) return null;
  const all = ctx.store.all('messages', (x) => x.conversationId === m.conversationId);
  return { first: m, sent: all.filter((x) => x.direction === 'out' && x.status === 'sent'), pending: all.find((x) => x.direction === 'out' && ['pending_approval', 'queued', 'scheduled'].includes(x.status)), replied: all.some((x) => x.direction === 'in') };
}

/** Is a follow-up due for this lead? Returns the follow-up number (1, 2...) or 0. */
function due(p, lane) {
  if (!cfg(lane).followUps || DONE_STAGES.includes(p.stage)) return 0;
  const t = thread(p); if (!t || t.replied || t.pending || !t.sent.length || t.first.status !== 'sent') return 0;
  const n = (p.followUps || []).length; const gaps = days(lane);
  if (n >= gaps.length) return 0;
  const last = t.sent[t.sent.length - 1];
  const waited = (Date.now() - new Date(last.sentAt || last.createdAt).getTime()) / 864e5;
  const need = n === 0 ? gaps[0] : gaps[n] - gaps[n - 1];
  return waited >= need ? n + 1 : 0;
}

async function write(p, lane, n, t) {
  // Politics: the outreach guide's one line, in the same thread, once (day 4). Then stop.
  if (lane === 'political') return `${p.name.split(/\s+/)[0]}, bumping this once. Even pointing me to the right person helps. Ben`;
  const first = p.name.split(/\s+/)[0]; const agency = ctx.setting('agency.name', 'Euclidean Media');
  const sender = (lane === 'political' ? ctx.setting('political.senderName', '') : ctx.setting('creatorOffers.senderName', '')) || ctx.setting('agency.founders', [])[0]?.name || agency;
  const booking = (lane === 'political' ? ctx.setting('political.bookingUrl', '') : ctx.setting('creatorOffers.bookingUrl', '')) || '';
  const fallback = n === 1
    ? `Hi ${first}${lane === 'political' ? ' team' : ''},\n\nJust floating this back up in case it got buried. ${lane === 'political' ? 'The ads we made are still yours to look at.' : 'Happy to send over a couple of examples of what we would make for you.'} Could you give us 20 minutes this week?${booking ? `\n\nPick a time: ${booking}` : ''}\n\nThanks,\n${sender}`
    : `Hi ${first}${lane === 'political' ? ' team' : ''},\n\nLast note from me on this. If the timing isn't right, no problem at all. If it is, we'd love 20 minutes.${booking ? `\n\n${booking}` : ''}\n\nThanks,\n${sender}`;
  if (!ai.anyConnected()) return fallback;
  try {
    const r = await ai.ask({ role: 'writing', maxTokens: 500, system: `You write short follow-up emails for ${agency}. Under 70 words, friendly, no pressure, no guilt, no invented facts or new claims, one ask (20 minutes), plain text, no subject line, no sign-off block beyond the name, never use em dashes. ${n >= days(lane).length ? 'This is the last follow-up: say so kindly.' : ''}${learning.writerBlock(lane)}`, prompt: `ORIGINAL EMAIL WE SENT:\nSubject: ${t.first.subject}\n${String(t.first.body).slice(0, 2000)}\n\nWrite follow-up number ${n} to ${p.name}. Sign as ${sender}.${booking ? ` Booking link: ${booking}` : ''}` });
    const body = String(r.text || '').trim();
    return body.length > 40 ? body : fallback;
  } catch { return fallback; }
}

/** Reasons a follow-up can't send by itself (empty = safe). */
function blockers(p, lane, contact) {
  const why = []; const c = cfg(lane);
  const autoOn = !!c.autoSend || require('./autopilot').graduated(lane);
  if (lane === 'political') why.push('Political outreach is drafts only: Ben sends it by hand');
  else if (!autoOn) why.push('Auto-send is off');
  if (!mailingAddress()) why.push('No mailing address');
  const to = contact?.emails?.[0] || '';
  if (!to || isGov(to)) why.push('No usable email');
  if (contact?.optedOut?.email) why.push('Opted out');
  if (excluded({ name: p.name, email: to, handle: p.handle })) why.push('Excluded');
  const counters = ctx.store.settings._outreach || {};
  if ((counters.sent?.[lane] || 0) >= require('./autopilot').capToday(lane)) why.push("Today's limit reached");
  return why;
}

let busy = false; let lastRun = 0;
/** Called from the autopilot tick; does real work at most every 10 minutes. */
async function tick() {
  if (busy || Date.now() - lastRun < 10 * 60000) return;
  busy = true; lastRun = Date.now();
  try {
    for (const lane of ['political', 'creators']) {
      if (!cfg(lane).followUps) continue;
      const list = ctx.store.all('prospects', (p) => require('./autopilot').laneOf(p) === lane && p.stage === 'contacted').slice(0, 400);
      let made = 0;
      for (const p of list) {
        if (made >= 20) break;
        const n = due(p, lane); if (!n) continue;
        const t = thread(p); const contact = ctx.store.get('contacts', t.first.contactId);
        if (!contact || contact.optedOut?.email) continue;
        const body = withFooter(noDashes(await write(p, lane, n, t)));
        const subject = /^re:/i.test(t.first.subject || '') ? t.first.subject : `Re: ${t.first.subject || ctx.setting('agency.name', 'Euclidean Media')}`;
        let msg;
        try { msg = messaging.createOutbound({ conversationId: t.first.conversationId, contactId: contact.id, channel: 'email', subject, body, aiGenerated: true, category: 'prospecting', actor: 'autopilot' }); }
        catch (e) { audit.log('autopilot', 'outreach.followup_failed', { prospectId: p.id, error: e.message }, 'warn'); continue; }
        const why = blockers(p, lane, contact);
        if (!why.length && msg.status === 'pending_approval') {
          messaging.approveMessage(msg.id, 'autopilot');
          const c = ctx.store.settings._outreach || {}; c.sent = c.sent || {}; c.sent[lane] = (c.sent[lane] || 0) + 1; ctx.store.touch();
        }
        ctx.store.update('prospects', p.id, (cur) => ({ followUps: [...(cur.followUps || []), { n, messageId: msg.id, at: now(), auto: !why.length }] }));
        audit.log('autopilot', 'outreach.followup', { prospectId: p.id, lane, n, sent: !why.length });
        made++;
      }
      if (made) { events.publish('prospects', {}); events.publish('notify', { title: `${made} follow-up${made === 1 ? '' : 's'} ${lane === 'political' ? '(politics)' : '(creators)'}`, body: 'Written for leads who have not replied. Any that could not send on their own are in Approvals.', route: '/approvals' }); }
    }
  } finally { busy = false; }
}

module.exports = { tick, due, thread, days, write };
