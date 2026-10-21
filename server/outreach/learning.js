'use strict';
/**
 * What the outreach system learns from you. Every approval, edit, skip, reply
 * and opt-out is recorded per lane. The writers get your recent edits as
 * examples and the lane's lessons; the scout gets your skip reasons, so it
 * stops finding leads like the ones you turn down.
 */
const ctx = require('../core/ctx');
const { now } = require('../core/util');

function record(kind, { lane, prospectId, name, before, after, reason }) {
  ctx.store.insert('outreachFeedback', { kind, lane, prospectId, name: name || null, before: before || null, after: after || null, reason: reason || null, at: now() });
  const all = ctx.store.data.outreachFeedback; if (all.length > 5000) all.splice(0, all.length - 4000);
}

const recent = (lane, kinds, n) => ctx.store.all('outreachFeedback', (f) => f.lane === lane && kinds.includes(f.kind)).slice(-n);

/** How the drafts are doing lately: share approved without changes, edits, skips, replies. */
function stats(lane, window = 25) {
  const reviewed = recent(lane, ['approved', 'edited', 'skipped'], window);
  const approved = reviewed.filter((f) => f.kind === 'approved').length;
  const edited = reviewed.filter((f) => f.kind === 'edited').length;
  const skipped = reviewed.filter((f) => f.kind === 'skipped').length;
  const sent = ctx.store.all('outreachFeedback', (f) => f.lane === lane && ['approved', 'edited', 'auto_sent'].includes(f.kind)).length;
  const replies = ctx.store.all('outreachFeedback', (f) => f.lane === lane && f.kind === 'replied').length;
  const optOuts = ctx.store.all('outreachFeedback', (f) => f.lane === lane && f.kind === 'opted_out').length;
  return { reviewed: reviewed.length, approvedUnchanged: approved, edited, skipped, unchangedRate: reviewed.length ? approved / reviewed.length : null, sent, replies, replyRate: sent ? replies / sent : null, optOuts };
}

/** Prompt block for the email/ad writers: lessons plus your latest edits. */
function writerBlock(lane) {
  const lessons = String(ctx.setting(`outreach.${lane}.lessons`, '') || '').trim();
  const edits = recent(lane, ['edited'], 4).filter((f) => f.before?.body && f.after?.body);
  if (!lessons && !edits.length) return '';
  return ['', 'LEARN FROM THE FOUNDERS (follow these over the defaults):',
    lessons ? `Lessons:\n${lessons}` : '',
    ...edits.map((f, i) => `Example ${i + 1}: the founders changed your draft\nFROM:\n${f.before.subject ? `Subject: ${f.before.subject}\n` : ''}${String(f.before.body).slice(0, 900)}\nTO:\n${f.after.subject ? `Subject: ${f.after.subject}\n` : ''}${String(f.after.body).slice(0, 900)}`)].filter(Boolean).join('\n');
}

/** Prompt block for the scout: who the founders keep skipping, and lessons. */
function scoutBlock(lane) {
  const lessons = String(ctx.setting(`outreach.${lane}.lessons`, '') || '').trim();
  const skips = recent(lane, ['skipped'], 15).map((f) => `- ${f.name || 'lead'}${f.reason ? `: ${f.reason}` : ''}`);
  const liked = ctx.store.all('prospects', (p) => ['replied', 'meeting', 'proposal', 'won'].includes(p.stage) && (lane === 'political' ? p.type === 'political' : p.type !== 'political')).slice(-10).map((p) => `- ${p.name}${p.location ? ` (${p.location})` : ''}`);
  if (!lessons && !skips.length && !liked.length) return '';
  return ['', lessons ? `Lessons from the founders:\n${lessons}` : '', liked.length ? `Leads that responded well (find more like these):\n${liked.join('\n')}` : '', skips.length ? `Leads the founders skipped (avoid similar ones):\n${skips.join('\n')}` : ''].filter(Boolean).join('\n');
}

module.exports = { record, stats, writerBlock, scoutBlock };
