'use strict';
/**
 * The editor gets better with every decision: each approve, reject or "change this" on a clip is remembered per
 * client (what kind of moment it was, how long, montage or straight cut, its style, the title, and your note), and the
 * next time clips are picked from that client's footage
 *  - the scores lean toward the kinds of moments you approve and away from the ones you reject (`nudge`), and
 *  - the AI choosing clips is shown your recent approvals, rejections and change notes (`promptBlock`).
 * Only kicks in after a few decisions, and never by more than a nudge: it can't overrule a clearly better moment.
 */
const ctx = require('../core/ctx');

const KEEP = 200; // decisions remembered per client
const all = () => ctx.store.settings._clipTaste || {};

/** What a clip was, in features the scorer can compare. */
function features(c) {
  const len = c.keep?.length ? c.keep.reduce((n, [a, b]) => n + (b - a), 0) : (c.end || 0) - (c.start || 0);
  const f = [`len:${len < 25 ? 'short' : len < 40 ? 'mid' : 'long'}`, c.keep?.length ? 'montage' : 'straight'];
  if (c.videoStyle) f.push(`style:${c.videoStyle}`);
  for (const w of c.why || []) f.push(`why:${String(w).replace(/\d+\s*/g, '').replace(/^montage of.*/, 'montage').trim()}`);
  if (c.kind) f.push(`kind:${c.kind}`);
  return [...new Set(f)];
}

/** Remember a decision (called from pipeline.decideClip). */
function record(clip, decision, note = '') {
  if (!clip?.clientId || !['approve', 'reject', 'changes'].includes(decision)) return;
  const t = all(); const list = t[clip.clientId] || [];
  list.push({ d: decision, at: new Date().toISOString(), f: features(clip), title: String(clip.title || '').slice(0, 90), hook: String(clip.hook || '').slice(0, 60), note: String(note || '').slice(0, 240), len: Math.round(((clip.keep?.length ? clip.keep.reduce((n, [a, b]) => n + (b - a), 0) : clip.end - clip.start) || 0)) });
  t[clip.clientId] = list.slice(-KEEP); ctx.store.settings._clipTaste = t; ctx.store.touch();
}

/** Approval rate per feature for a client: { feature: { yes, no } }. Changes count as half a no. */
function stats(clientId) {
  const s = {};
  for (const r of all()[clientId] || []) for (const f of r.f) { const x = s[f] || (s[f] = { yes: 0, no: 0 }); if (r.d === 'approve') x.yes++; else x.no += r.d === 'reject' ? 1 : 0.5; }
  return s;
}

/** Lean candidate scores toward what this client's editor approves (at most about ±10 points). */
function nudge(cands, clientId) {
  const st = stats(clientId); const n = (all()[clientId] || []).length;
  if (n < 4) return;
  for (const c of cands) {
    let d = 0; const hits = [];
    for (const f of features(c)) {
      const x = st[f]; if (!x || x.yes + x.no < 2) continue;
      const rate = (x.yes + 1) / (x.yes + x.no + 2); // smoothed
      d += (rate - 0.5) * 8; if (Math.abs(rate - 0.5) > 0.2) hits.push(f);
    }
    d = Math.max(-10, Math.min(10, d));
    if (Math.abs(d) >= 1) { c.score = Math.round((c.score + d) * 10) / 10; if (d > 0) c.why = [...(c.why || []), 'like ones you approved']; }
  }
  cands.sort((a, b) => b.score - a.score);
}

/** A short block for the clip-picking AI: what this client's editor approved, rejected and asked to change. */
function promptBlock(clientId) {
  const list = (all()[clientId] || []).slice(-40); if (list.length < 3) return '';
  const fmt = (r) => `- "${r.title}" (${r.len}s, ${r.f.filter((f) => !f.startsWith('len:')).join(', ')})${r.note ? `: ${r.note}` : ''}`;
  const yes = list.filter((r) => r.d === 'approve').slice(-6); const no = list.filter((r) => r.d === 'reject').slice(-5); const ch = list.filter((r) => r.d === 'changes' && r.note).slice(-5);
  return `\n\nWHAT THIS EDITOR DECIDED BEFORE (learn their taste; pick more like the approved ones):${yes.length ? `\nApproved:\n${yes.map(fmt).join('\n')}` : ''}${no.length ? `\nRejected:\n${no.map(fmt).join('\n')}` : ''}${ch.length ? `\nAsked to change:\n${ch.map(fmt).join('\n')}` : ''}`;
}

/** For the clip panel / HAL: how many decisions it has learned from. */
const summary = (clientId) => { const list = all()[clientId] || []; return { decisions: list.length, approved: list.filter((r) => r.d === 'approve').length, rejected: list.filter((r) => r.d === 'reject').length, changes: list.filter((r) => r.d === 'changes').length }; };

module.exports = { record, nudge, promptBlock, features, stats, summary };
