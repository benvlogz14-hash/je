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

// ------------------------------------------------------------------ learning from Studio edits
/**
 * When a clip opened in Studio is exported, the editor's version is compared with the machine's cut (`project.origSegs`):
 *  - lines they took out and lines they put back (whole sentences, by how much of each is in each version),
 *  - how far they moved each cut point that still matches one of the machine's (later than the machine = it cut a word
 *    off; earlier = it left in too much).
 * The next clips for that client use their cut margins (`editLessons().pads`), score lines like the ones they keep
 * removing lower, avoid opening lines on the words they keep cutting, and the AI re-cutting montages sees examples.
 */
const EDITS = 60;
const lessonsAll = () => ctx.store.settings._editLessons || {};
function merge(r) { return [...r].sort((a, b) => a[0] - b[0]).reduce((acc, x) => { const l = acc[acc.length - 1]; if (l && x[0] <= l[1] + 0.05) l[1] = Math.max(l[1], x[1]); else acc.push([...x]); return acc; }, []); }
const inside = (r, a, b) => r.reduce((n, [x, y]) => n + Math.max(0, Math.min(b, y) - Math.max(a, x)), 0);

/** The footage pieces a Studio project keeps (source seconds), from its sound (or picture) of the clip's footage. */
function projectRanges(data) {
  const seq = (data?.sequences || []).find((q) => q.id === data.activeSequence) || data?.sequences?.[0]; if (!seq) return [];
  const m = (data.media || [])[0]; if (!m) return [];
  const pick = (tracks) => tracks.flatMap((t) => t.clips || []).filter((c) => c.mediaId === m.id && c.enabled !== false).map((c) => [Number(c.in) || 0, (Number(c.in) || 0) + (Number(c.duration) || 0) * (Number(c.speed) || 1)]);
  const a = pick(seq.audioTracks || []); return merge(a.length ? a : pick((seq.videoTracks || []).filter((t) => !/b-?roll|captions|hook/i.test(t.name || ''))));
}

function learnEdit({ project, clip, words }) {
  if (!clip?.clientId || !project?.origSegs?.length || !words?.length) return null;
  const before = merge(project.origSegs); const after = projectRanges(project.data);
  if (!after.length) return null;
  const lo = Math.min(before[0][0], after[0][0]) - 1, hi = Math.max(before[before.length - 1][1], after[after.length - 1][1]) + 1;
  const sents = require('./montage').sentences(words.filter((w) => w.e > lo && w.s < hi));
  const removed = [], added = [], kept = [];
  for (const x of sents) {
    const len = Math.max(0.1, x.e - x.s); const b = inside(before, x.s, x.e) / len, a = inside(after, x.s, x.e) / len;
    if (b >= 0.7 && a <= 0.3) removed.push(x.t); else if (b <= 0.3 && a >= 0.7) added.push(x.t); else if (b >= 0.7 && a >= 0.7) kept.push(x.t);
  }
  // Cut points: each of the editor's starts/ends near one of the machine's (within 0.8 s) is a sample of how they like it.
  const dStart = [], dEnd = [];
  for (const [a, b] of after) {
    const ns = before.map(([x]) => x).sort((p, q) => Math.abs(p - a) - Math.abs(q - a))[0]; if (ns != null && Math.abs(ns - a) <= 0.8) dStart.push(Math.round((ns - a) * 100) / 100); // + = editor starts earlier
    const ne = before.map(([, y]) => y).sort((p, q) => Math.abs(p - b) - Math.abs(q - b))[0]; if (ne != null && Math.abs(ne - b) <= 0.8) dEnd.push(Math.round((b - ne) * 100) / 100); // + = editor ends later
  }
  const changed = removed.length || added.length || dStart.some((d) => Math.abs(d) >= 0.04) || dEnd.some((d) => Math.abs(d) >= 0.04);
  const rec = { projectId: project.id, clipId: clip.id, at: new Date().toISOString(), removed: removed.slice(0, 20), added: added.slice(0, 20), kept: kept.map((t) => firstWord(t)).slice(0, 40), dStart, dEnd, changed: !!changed };
  const t = lessonsAll(); const list = (t[clip.clientId] || []).filter((r) => r.projectId !== project.id);
  list.push(rec); t[clip.clientId] = list.slice(-EDITS); ctx.store.settings._editLessons = t; ctx.store.touch();
  return rec;
}
const firstWord = (t) => String(t || '').trim().split(/\s+/)[0]?.toLowerCase().replace(/[^a-z']/g, '') || '';
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };

/** What this client's Studio edits taught it: cut-margin shifts, lines to avoid, opening words to avoid. */
function editLessons(clientId) {
  const list = lessonsAll()[clientId] || []; if (!list.length) return {};
  const dS = list.flatMap((r) => r.dStart).slice(-200), dE = list.flatMap((r) => r.dEnd).slice(-200);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const pads = {};
  if (dE.length >= 5) pads.endShift = clamp(median(dE), -0.25, 0.4);
  if (dS.length >= 5) pads.startShift = clamp(median(dS), -0.2, 0.3);
  const cutLines = list.flatMap((r) => r.removed).slice(-80);
  const rm = {}, kp = {};
  for (const t of cutLines) { const w = firstWord(t); if (w) rm[w] = (rm[w] || 0) + 1; }
  for (const r of list) for (const w of r.kept || []) if (w) kp[w] = (kp[w] || 0) + 1;
  const avoidStarts = Object.keys(rm).filter((w) => rm[w] >= 3 && rm[w] / (rm[w] + (kp[w] || 0)) >= 0.5);
  return { pads, cutLines, avoidStarts, edits: list.length, changed: list.filter((r) => r.changed).length };
}

/** For the AI re-cutting montages: lines this editor took out and put back in Studio. */
function editBlock(clientId) {
  const list = (lessonsAll()[clientId] || []).slice(-12); const uniq = (xs) => [...new Set(xs)]; const rm = uniq(list.flatMap((r) => r.removed)).slice(-8), ad = uniq(list.flatMap((r) => r.added)).slice(-6);
  if (!rm.length && !ad.length) return '';
  return `\nWhen this editor fixed clips by hand they${rm.length ? ` cut lines like these out:\n${rm.map((t) => `- "${t.slice(0, 140)}"`).join('\n')}` : ''}${ad.length ? `${rm.length ? '\nand' : ''} put lines like these back in:\n${ad.map((t) => `- "${t.slice(0, 140)}"`).join('\n')}` : ''}\nCut the way they would.`;
}

module.exports = { record, nudge, promptBlock, features, stats, summary, learnEdit, editLessons, editBlock, projectRanges };

