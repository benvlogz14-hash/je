'use strict';
/**
 * What makes a short worth watching, measured from the footage itself:
 *
 *  - Voiceover: a studio narration is close-miked, so the gaps between its words are almost
 *    silent; talking on location has room noise or wind in those gaps. Each sentence gets the
 *    noise floor of its gaps, and clean ones (or speech over shots with nobody on screen) are
 *    marked as voiceover.
 *  - Strong pictures: drone and aerial shots, sharp, bright, moving, well-framed shots
 *    (from "Look through it"), and how often the picture changes.
 *  - Story: windows start and end on whole sentences, with a hook in the first line.
 *
 * Also plans "visual cuts": while the voice keeps going, a static or weak stretch is covered
 * with the best shots from elsewhere in the footage for a couple of seconds at a time.
 */
const fs = require('fs');
const path = require('path');
const ff = require('./ffmpeg');
const { run } = require('../core/util');

// ---------------------------------------------------------------- audio level map
/** Loudness (dB RMS) every 0.25 s of the whole file, cached next to the footage. */
async function levels(file, workDir) {
  const cache = path.join(workDir || path.dirname(file), `${path.basename(file).replace(/\.[^.]+$/, '')}.levels.json`);
  try { return JSON.parse(fs.readFileSync(cache, 'utf8')); } catch { /* measure */ }
  const r = await run(ff.bin('ffmpeg'), ['-hide_banner', '-nostats', '-i', file, '-vn', '-ac', '1', '-af', 'aresample=8000,asetnsamples=n=2000:p=0,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level', '-f', 'null', '-'], { timeoutMs: 1800000, priority: ff.priorityValue() });
  const out = String(r.err || '') + String(r.out || '');
  const vals = [...out.matchAll(/RMS_level=(-?[\d.]+|-inf)/g)].map((m) => (m[1] === '-inf' ? -90 : Math.max(-90, Number(m[1]))));
  const lv = { step: 0.25, db: vals.map((v) => Math.round(v * 10) / 10) };
  try { fs.writeFileSync(cache, JSON.stringify(lv)); } catch { /* read-only */ }
  return lv;
}
const at = (lv, t) => (lv?.db?.length ? lv.db[Math.max(0, Math.min(lv.db.length - 1, Math.floor(t / lv.step)))] : null);

/**
 * Reaction bursts: moments clearly louder than the ~20 s around them (a laugh, a shout, a crowd,
 * a big reveal), measured against that local level rather than the whole video, so a quiet vlog
 * and a loud one both get their own highlights. Robust: median and median deviation of the
 * neighbourhood; a burst is at least 0.5 s at 3+ deviations above it. Returns burst times in seconds.
 */
function reactionBursts(lv, { win = 10, z = 3, minSec = 0.5 } = {}) {
  const db = lv?.db; if (!db?.length) return [];
  const step = lv.step; const half = Math.round(win / step); const need = Math.ceil(minSec / step);
  const med = (a) => { const b = a.slice().sort((x, y) => x - y); return b[Math.floor(b.length / 2)]; };
  const out = []; let run = 0; let peakAt = 0; let peakZ = 0;
  for (let i = 0; i < db.length; i += 1) {
    const nb = db.slice(Math.max(0, i - half), i + half + 1).filter((v) => v > -80);
    let zi = 0;
    if (nb.length >= 8 && db[i] > -80) { const m = med(nb); const mad = med(nb.map((v) => Math.abs(v - m))) * 1.4826 || 1; zi = (db[i] - m) / Math.max(1.5, mad); }
    if (zi >= z) { run += 1; if (zi > peakZ) { peakZ = zi; peakAt = i; } } else { if (run >= need) out.push(Math.round(peakAt * step * 100) / 100); run = 0; peakZ = 0; }
  }
  if (run >= need) out.push(Math.round(peakAt * step * 100) / 100);
  return out;
}

/** Sentences with timing, from transcript words. */
function sentences(words) {
  const out = []; let cur = null;
  for (const w of words) {
    if (!cur || w.s - cur.e > 1.2) { if (cur) out.push(cur); cur = { s: w.s, e: w.e, words: [w] }; } else { cur.e = w.e; cur.words.push(w); }
    if (/[.!?]["']?$/.test(w.w) && cur.words.length >= 3) { out.push(cur); cur = null; }
  }
  if (cur) out.push(cur);
  return out.map((x) => ({ s: x.s, e: x.e, t: x.words.map((w) => w.w).join(' '), words: x.words }));
}

/** Mark voiceover sentences: quiet gaps between words, or speech over shots with nobody on screen. */
function tagVoiceover(sents, lv, shots = []) {
  for (const x of sents) {
    const gaps = []; const voice = [];
    for (let i = 0; i < x.words.length; i++) {
      const w = x.words[i]; voice.push(at(lv, (w.s + w.e) / 2));
      const nx = x.words[i + 1]; if (nx && nx.s - w.e > 0.12) gaps.push(at(lv, (w.e + nx.s) / 2));
    }
    const avg = (a) => { const v = a.filter((y) => y != null); return v.length ? v.reduce((p, q) => p + q, 0) / v.length : null; };
    const floor = gaps.length ? Math.min(...gaps.filter((y) => y != null)) : null; const loud = avg(voice);
    x.snr = floor != null && loud != null ? Math.round(loud - floor) : null;
    const nobody = shots.filter((s) => s.s < x.e && s.e > x.s).every((s) => s.faces === 0 || ['broll', 'aerial', 'graphic'].includes(s.kind));
    x.vo = (floor != null && floor < -52 && x.snr >= 22) || (nobody && shots.some((s) => s.s < x.e && s.e > x.s));
  }
  return sents;
}

// ---------------------------------------------------------------- shots
const isDrone = (s) => s.kind === 'aerial' || /\b(aerial|drone|overhead|bird'?s[- ]eye|from above|skyline)\b/i.test(`${s.what || ''}`);
/** How good a shot looks on its own, 0..1. */
function shotScore(s) {
  if (s.usable === false) return 0;
  let v = ((s.quality || 3) - 1) / 4 * 0.45;
  if (isDrone(s)) v += 0.35;
  if (s.kind === 'broll') v += 0.1;
  if (s.motion != null) v += Math.min(0.15, s.motion / 60);
  if (s.bright != null && (s.bright < 40 || s.bright > 235)) v -= 0.25;
  if (s.sharp != null && s.sharp < 2) v -= 0.2;
  return Math.max(0, Math.min(1, v));
}

// ---------------------------------------------------------------- window scoring
const FILLER = /\b(um+|uh+|so yeah|i mean|kind of|sort of|you know|anyway|i guess|whatever)\b/i;
const OUTRO = /\b(thanks for watching|subscribe|like and|see you (next|in the)|that'?s (it|all) for)\b/i;
const END_HOOK = /\b(look at (this|that)|check this|watch this|wait|open(ed|ing)?|door|behind|inside|found|discover|reveal|you won'?t believe|no way|what (is|was|we)|turns out|and then|but then|until)\b|\?\s*$|!\s*$/i;
const HOOK = /\b(never|nobody|no one|secret|hidden|abandoned|inside|why|how|what|imagine|biggest|craziest|insane|first|last|only|million|billion|\d+)\b|\?/i;
/**
 * Score one candidate window. sig = { sents, shots, scenes, peaks, lv }.
 * Returns { score, why[] } where why lists what made it good, for the clip card.
 */
function scoreWindow(s, e, sig, kept = null) {
  const why = [];
  const inS = kept || sig.sents.filter((x) => x.s >= s - 0.05 && x.e <= e + 0.05);
  const len = kept ? kept.reduce((n, x) => n + (x.e - x.s) + 0.3, 0) : e - s;
  const speech = inS.reduce((n, x) => n + (x.e - x.s), 0) / len;
  const vo = inS.filter((x) => x.vo).reduce((n, x) => n + (x.e - x.s), 0) / len;
  const sh = sig.shots.filter((x) => x.s < e && x.e > s);
  const cover = (f) => sh.filter(f).reduce((n, x) => n + Math.min(e, x.e) - Math.max(s, x.s), 0) / len;
  const drone = cover(isDrone); const strong = sh.length ? sh.reduce((n, x) => n + shotScore(x) * (Math.min(e, x.e) - Math.max(s, x.s)), 0) / len : 0.3;
  const bad = cover((x) => x.usable === false || (x.bright != null && x.bright < 35));
  const cuts = sig.scenes.filter((t) => t > s && t < e).length / (len / 10); // cuts per 10 s
  const peaks = sig.peaks.filter((t) => t > s && t < e).length;
  const bursts = (sig.bursts || []).filter((t) => t > s && t < e).length;
  const hook = inS[0] && HOOK.test(inS[0].t) ? 1 : 0;
  // Filler and outros lose viewers: "um, so yeah, I mean, anyway", "thanks for watching, subscribe".
  const filler = inS.filter((x) => FILLER.test(x.t)).reduce((n, x) => n + (x.e - x.s), 0) / len;
  const outro = inS.some((x) => OUTRO.test(x.t));
  let score = -25 * filler - (outro ? 15 : 0) + 30 * Math.min(1, speech / 0.75) + 25 * vo + 18 * drone + 20 * strong + 6 * Math.min(cuts, 3) + 4 * Math.min(peaks, 3) + 3 * Math.min(bursts, 2) + 10 * hook - 30 * bad;
  // Dead air at the start loses viewers in the first second.
  const firstWord = inS[0]?.s ?? e; if (firstWord - s > 1.2) score -= 10;
  const endHook = inS.length > 1 && END_HOOK.test(inS[inS.length - 1].t);
  if (endHook) { score += 12; why.push('ends on a hook'); }
  if (kept) why.push('story cut');
  if (vo > 0.4) why.push('voiceover');
  if (drone > 0.15) why.push('drone shots');
  if (strong > 0.55) why.push('strong visuals');
  if (cuts >= 1.5) why.push('fast cuts');
  if (peaks) why.push(`${peaks} energy peak${peaks > 1 ? 's' : ''}`);
  if (bursts) why.push('big reaction');
  if (hook) why.push('hook in the first line');
  return { score: Math.round(score * 10) / 10, why };
}

/** The parts of a clip that are actually in it: its kept sentences for a montage cut, else its whole range. */
const piecesOf = (c) => (c.keep?.length ? c.keep.map(([a, b]) => ({ start: a, end: b })) : [{ start: c.start, end: c.end }]);
/** Seconds two clips share, by their real pieces (a montage cut spans minutes but uses only ~30 s of them). */
function sharedSec(a, b) { let n = 0; for (const x of piecesOf(a)) for (const y of piecesOf(b)) n += Math.max(0, Math.min(x.end, y.end) - Math.max(x.start, y.start)); return n; }
const lengthOf = (c) => piecesOf(c).reduce((n, x) => n + (x.end - x.start), 0);

/** Candidate windows that start and end on whole sentences, within min..max seconds, plus montage cuts (storyCuts). */
function candidates(sig, { minSec, maxSec, duration, exclude = [], limit = 40, storyCuts = false, endHook = false }) {
  const out = []; const S = sig.sents;
  const blocked = (c) => exclude.some((x) => sharedSec(x, c) > 0.2 * Math.min(lengthOf(c), maxSec));
  for (let i = 0; i < S.length; i++) {
    for (let j = i; j < S.length; j++) {
      const s = Math.max(0, S[i].s - 0.15); const e = Math.min(duration, S[j].e + 0.25); const len = e - s;
      if (len > maxSec) break;
      if (len < minSec) continue;
      if (blocked({ start: s, end: e })) continue;
      // Highlights: the clip must end on a hook (a reveal, a question, "and then we opened the door...").
      if (endHook && !END_HOOK.test(S[j].t)) continue;
      out.push({ start: Math.round(s * 100) / 100, end: Math.round(e * 100) / 100, ...scoreWindow(s, e, sig), text: S.slice(i, j + 1).map((x) => x.t).join(' ') });
    }
  }
  if (storyCuts) for (const c of montageCuts(sig, { minSec, maxSec, duration, exclude })) if (!blocked(c)) out.push(c);
  out.sort((a, b) => b.score - a.score);
  const picked = [];
  for (const c of out) { if (picked.every((p) => sharedSec(p, c) < 0.15 * lengthOf(c))) picked.push(c); if (picked.length >= limit) break; }
  return picked;
}

// ---------------------------------------------------------------- montage cuts (the usual Shorts edit)
const DANGLING = /^["'(]?(and|but|so|or|because|cause|which|then|also|plus|like|that'?s why|anyway)\b/i;
const REFERS = /^["'(]?(it|that|this|they|them|he|she|those|these|there|i picked (it|one)|one of them)\b/i;
/** A montage ends on an open loop: the viewer wants the next line. Stricter than END_HOOK (which also scores windows). */
const OPEN_LOOP = /\?\s*["']?$|\.\.\.\s*["']?$|\b(and then|but then|until|suddenly|all of a sudden|what we (found|saw|heard)|you won'?t believe|turns out|look at (this|that)|wait|no way|we heard|we saw|i heard|i saw|something (was )?(moving|there|inside|behind)|about to|what (is|was) (that|this|inside|behind)|behind (that|the) door|never (seen|expected))\b/i;
/** Seconds a sentence lasts once the render's pause cuts take out gaps over ~0.55 s. */
function spoken(x) { let n = 0; for (let i = 0; i < x.words.length; i++) { const w = x.words[i]; n += w.e - w.s; const nx = x.words[i + 1]; if (nx) n += Math.min(0.55, Math.max(0, nx.s - w.e)); } return n + 0.24; }
function sentValue(x, sig) {
  return (FILLER.test(x.t) || OUTRO.test(x.t) || x.ex ? -10 : 0) + (x.vo ? 3 : 0) + (HOOK.test(x.t) ? 2 : 0) + Math.min(2, x.words.length / 8)
    + sig.shots.filter((sh) => sh.s < x.e && sh.e > x.s).reduce((n, sh) => Math.max(n, shotScore(sh) * 3), 0)
    + (sig.peaks || []).filter((t) => t >= x.s && t <= x.e).length * 0.8 + (sig.bursts || []).filter((t) => t >= x.s && t <= x.e).length;
}

/**
 * One montage cut from a section of whole sentences (chronological, the last one is the ending): the opening line,
 * the strongest lines in between in their original order (neighbours of kept lines are preferred so it reads as a
 * story, not a jumble), and the ending, an open hook ("and then we opened the door..."), so the clip stops before the
 * payoff. Never cuts inside a sentence. Returns the kept sentences, or null if it can't land between tmin and tmax.
 */
function narrative(sec, sig, { tmin, tmax }) {
  if (sec.length < 3) return null;
  const end = sec.length - 1;
  // Opening: one of the first lines that stands on its own (not "and...", "so..."), a hook if there is one.
  let open = -1;
  for (let k = 0; k < Math.min(4, end); k++) {
    const x = sec[k]; if (x.ex || DANGLING.test(x.t) || REFERS.test(x.t) || FILLER.test(x.t) || x.words.length < 4) continue;
    if (open < 0 || (HOOK.test(x.t) && !HOOK.test(sec[open].t))) open = k;
    if (HOOK.test(x.t)) break;
  }
  if (open < 0) return null;
  const keep = new Set([open, end]); let total = spoken(sec[open]) + spoken(sec[end]);
  if (total > tmax) return null;
  const val = sec.map((x) => sentValue(x, sig));
  // The lines just before the ending set it up: keep the one before it whenever it fits, and the one before that too
  // when it leans on it ("It says...", "But..."), up to three lines.
  for (let k = end - 1, n = 0; k > open && n < 3; k--, n++) {
    if (val[k] <= -5 || total + spoken(sec[k]) > tmax) { if (n) return null; break; }
    keep.add(k); total += spoken(sec[k]);
    if (!(DANGLING.test(sec[k].t) || REFERS.test(sec[k].t))) break;
  }
  // A tease in the middle gives the ending away: only the last line opens a loop.
  for (let k = open + 1; k < end; k++) if (OPEN_LOOP.test(sec[k].t) && !keep.has(k)) val[k] -= 3;
  for (;;) {
    let best = -1; let bestV = -Infinity;
    for (let k = open + 1; k < end; k++) {
      if (keep.has(k) || val[k] <= -5 || total + spoken(sec[k]) > tmax) continue;
      const v = val[k] + (keep.has(k - 1) ? 1.5 : 0) + (keep.has(k + 1) ? 1.5 : 0);
      if (v > bestV) { bestV = v; best = k; }
    }
    if (best < 0) break;
    keep.add(best); total += spoken(sec[best]);
    if (total >= tmax - 1.5) break;
  }
  // A middle line that leans on the one before it ("But...", "It was...") needs that line too, or it goes.
  for (let k = end - 1; k > open; k--) {
    if (!keep.has(k) || keep.has(k - 1) || !(DANGLING.test(sec[k].t) || REFERS.test(sec[k].t))) continue;
    if (k - 1 > open && val[k - 1] > -5 && total + spoken(sec[k - 1]) <= tmax) { keep.add(k - 1); total += spoken(sec[k - 1]); } else { keep.delete(k); total -= spoken(sec[k]); }
  }
  if (total < tmin) return null;
  return [...keep].sort((p, q) => p - q).map((k) => sec[k]);
}

/**
 * Montage cuts across the footage: sections of 45 s to 5 min that start on a line that stands alone and end on an
 * open hook, each condensed by `narrative` to the clip length (20-30 s for the usual 20-59 s setting).
 */
function montageCuts(sig, { minSec, maxSec, duration, exclude = [] }) {
  const S = sig.sents; const out = [];
  // Lines inside ad reads or moments other clips already use are never taken.
  for (const x of S) x.ex = exclude.some((r) => sharedSec(r, { start: x.s, end: x.e }) > 0.3 * (x.e - x.s));
  const tmax = Math.min(maxSec, Math.max(minSec + 10, Number(require('../core/ctx').setting('production.montageMaxSec', 30)) || 30)); const tmin = minSec;
  const starts = []; const ends = [];
  for (let i = 0; i < S.length; i++) {
    const x = S[i];
    if (x.ex) continue;
    if (!DANGLING.test(x.t) && !REFERS.test(x.t) && !FILLER.test(x.t) && x.words.length >= 4 && (i === 0 || x.s - S[i - 1].e > 0.6 || HOOK.test(x.t))) starts.push(i);
    if (OPEN_LOOP.test(x.t) && !OUTRO.test(x.t) && x.words.length >= 3) ends.push(i);
  }
  for (const i of starts) {
    const reach = ends.filter((j) => j > i + 2 && S[j].e - S[i].s >= Math.max(45, tmax + 10) && S[j].e - S[i].s <= 300);
    // A handful of section lengths per start, spread out (short, medium, long).
    const step = Math.max(1, Math.ceil(reach.length / 6));
    for (let r = 0; r < reach.length; r += step) {
      const j = reach[r]; const sec = S.slice(i, j + 1);
      const kept = narrative(sec, sig, { tmin, tmax }); if (!kept) continue;
      const s = Math.max(0, S[i].s - 0.15); const e = Math.min(duration, S[j].e + 0.25);
      const sc = scoreWindow(s, e, sig, kept);
      const keepR = kept.map((x) => [Math.round(Math.max(0, x.s - 0.12) * 100) / 100, Math.round((x.e + 0.18) * 100) / 100]);
      const pieces = keepR.reduce((n, [a], k) => n + (k === 0 || a > keepR[k - 1][1] + 0.35 ? 1 : 0), 0);
      // Montage cuts are the house style: a small lift over plain windows, less when it's chopped into many pieces.
      out.push({ start: Math.round(s * 100) / 100, end: Math.round(e * 100) / 100, keep: keepR, score: Math.round((sc.score + 6 - 1.5 * Math.max(0, pieces - 5)) * 10) / 10, why: [...sc.why.filter((w) => w !== 'story cut'), `montage of ${Math.round(e - s)} s`], text: kept.map((x) => x.t).join(' '), lines: kept.length, span: [i, j] });
    }
  }
  return out;
}

/** Whole sentences to keep for a story cut of at most maxSec: first and last always stay; filler goes first, then the weakest. */
function condense(sents, maxSec, sig) {
  const value = (x) => (FILLER.test(x.t) || OUTRO.test(x.t) ? -10 : 0) + (x.vo ? 3 : 0) + (HOOK.test(x.t) ? 2 : 0) + (END_HOOK.test(x.t) ? 2 : 0) + Math.min(2, x.words.length / 8)
    + sig.shots.filter((sh) => sh.s < x.e && sh.e > x.s).reduce((n, sh) => Math.max(n, shotScore(sh) * 3), 0);
  let kept = sents.slice(); const dur = () => kept.reduce((n, x) => n + (x.e - x.s) + 0.3, 0);
  while (dur() > maxSec && kept.length > 2) {
    let worst = 1; for (let k = 2; k < kept.length - 1; k++) if (value(kept[k]) < value(kept[worst])) worst = k;
    kept.splice(worst, 1);
  }
  if (dur() > maxSec || OUTRO.test(kept[kept.length - 1].t) || FILLER.test(kept[0].t)) return null;
  return kept;
}

/** Everything the scorer needs for one footage file. */
async function signals({ asset, transcript, vision, analysis }) {
  const shots = (vision?.shots || []).map((x) => ({ ...x }));
  let lv = null; try { lv = asset.info?.hasAudio ? await levels(asset.path, asset.workDir) : null; } catch { /* no level map */ }
  const sents = tagVoiceover(sentences(transcript?.words || []), lv, shots);
  return { sents, shots, scenes: analysis?.scenes || [], peaks: analysis?.peaks || [], bursts: reactionBursts(lv), lv };
}

// ---------------------------------------------------------------- visual cuts
/**
 * Picture-only cut-aways for one clip range (source seconds): weak or static stretches get the
 * best shots from elsewhere for 2-3 s each while the voice keeps playing.
 * Returns [{ at, dur, src }] with at/src in source seconds.
 */
function planCovers({ start, end, shots, sents = [], avoid = [], gap = 1.5, black = [], elsewhere = [], mine = null }) {
  if (!shots.length) return [];
  const len = end - start;
  const touchesBlack = (a, b) => black.some(([x, y]) => x < b + 0.15 && y > a - 0.15);
  // Variety across clips: elsewhere = [src, src+dur] cut-aways the video's other clips already use. Shots no other clip
  // has used come first (best first), then the least-used ones, so the same drone shot doesn't open every clip.
  const usedCount = (x) => elsewhere.filter(([a, b]) => a < x.e && b > x.s).length;
  const pool = shots.filter((x) => (x.e <= start || x.s >= end) && shotScore(x) >= 0.45 && x.e - x.s >= 2.2 && !avoid.some((a) => x.s < a.end && x.e > a.start))
    .map((x) => ({ x, n: usedCount(x), q: shotScore(x), m: mine && !mine.has(`${x.s}`) ? 1 : 0 })).sort((a, b) => a.m - b.m || a.n - b.n || b.q - a.q).map((o) => o.x);
  if (!pool.length) return [];
  // A cut-away comes from the middle of its shot (shot starts are often fades from black) and never touches black frames.
  // A shot another clip already used gives a different stretch of itself (the part farthest from what was used), when it's long enough.
  const take = (src, dur) => {
    const lo = src.s + 0.3, hi = src.e - 0.3 - dur; const mid = Math.max(lo, (src.s + src.e) / 2 - dur / 2);
    const prior = elsewhere.filter(([a, b]) => a < src.e && b > src.s);
    let best = null;
    for (const a of prior.length && hi > lo ? [mid, ...Array.from({ length: 9 }, (_, i) => lo + ((hi - lo) * i) / 8)] : [mid]) {
      if (a < lo - 1e-6 || touchesBlack(a, a + dur)) continue;
      const clash = prior.reduce((m, [p, q]) => m + Math.max(0, Math.min(q, a + dur) - Math.max(p, a)), 0);
      const dist = prior.length ? Math.min(...prior.map(([p, q]) => Math.abs((p + q) / 2 - (a + dur / 2)))) : 0;
      const score = -clash * 10 + dist * 0.1 - Math.abs(a - mid) * 0.01;
      if (!best || score > best.score) best = { a, score };
    }
    return best ? Math.round(best.a * 100) / 100 : null;
  };
  // Every cut-away in a clip is a different shot: never the same shot twice, nor its neighbour (a few seconds away in the
  // footage, usually the same scene), nor a shot described the same way. When the good shots run out, the cut-aways stop.
  const out = []; const used = [];
  const sameAs = (x, u) => x === u || (x.s < u.e + 3 && x.e > u.s - 3) || (x.what && u.what && norm(x.what) === norm(u.what));
  const norm = (w) => String(w).toLowerCase().replace(/[^a-z ]/g, '').trim();
  const place = (at, dur) => {
    for (const src of pool) {
      if (used.some((u) => sameAs(src, u))) continue;
      const d = Math.min(dur, src.e - src.s - 0.6); if (d < 1.2) continue; const a = take(src, d); if (a == null) continue;
      used.push(src); out.push({ at: Math.round(at * 100) / 100, dur: Math.round(d * 100) / 100, src: a }); return true;
    }
    return false;
  };
  const left = () => pool.some((x) => !used.some((u) => sameAs(x, u)));
  // 1. Black fades inside the clip (the voice keeps going): always covered with a good shot.
  // Only true black fades (short), at most two per clip: dark scenes are not black and stay as they are.
  for (const [x, y] of black.filter(([a, b]) => b > start + 0.1 && a < end - 0.1 && b - a <= 2.5).slice(0, 2)) { const at = Math.max(start, x - 0.3); place(at, Math.min(end - at, Math.max(1.5, y - x + 0.6))); }
  const busy = (a, b) => out.some((c) => c.at < b + gap && c.at + c.dur > a - gap);
  const here = shots.filter((x) => x.s < end && x.e > start);
  // 2. Weak stretches: a poor or static shot, someone talking with little movement, or any shot held too long (strong ones may run longer).
  const weak = (t) => { const s = here.find((x) => t >= x.s && t < x.e); if (!s) return true; const q = shotScore(s); return q < 0.4 || (s.kind === 'speaker' && (s.motion ?? 5) < 3) || (t - Math.max(s.s, start)) > (q >= 0.7 ? 9 : 5); };
  let tries = 0; let t = start + 2.5; // keep the first 2.5 s on the real moment: that's the hook
  while (t < end - 2.5 && left()) {
    // Voiceover is always fine to cover; someone talking on camera gets fewer cut-aways (about 3 in 5).
    const sentNow = sents.find((x) => t >= x.s && t < x.e); const dur = Math.min(3, end - 1 - t);
    if (dur >= 1.6 && !busy(t, t + dur) && weak(t) && (!sentNow || sentNow.vo || (tries++ % 5) < 3) && place(t, dur)) { t += out[out.length - 1].dur + gap; continue; }
    t += 1.5;
  }
  return out.filter((c) => c.at + c.dur <= start + len - 0.2).sort((a, b) => a.at - b.at);
}

/** Black frames in the footage (fades, flashes), cached: [[start, end], ...] in seconds. */
async function blackIntervals(file, workDir, { loose = false, cache: useCache = true, cachedOnly = false } = {}) {
  const cache = path.join(workDir || path.dirname(file), `${path.basename(file).replace(/\.[^.]+$/, '')}.${loose ? 'black3' : 'black2'}.json`);
  if (useCache) { try { return JSON.parse(fs.readFileSync(cache, 'utf8')); } catch { if (cachedOnly) return []; } }
  // loose: near-black too (dark fades, black with a little text on it), for checking finished clips.
  const det = loose ? 'blackdetect=d=0.25:pix_th=0.10:pic_th=0.90' : 'blackdetect=d=0.12:pix_th=0.04:pic_th=0.98';
  const r = await run(ff.bin('ffmpeg'), ['-hide_banner', '-nostats', '-i', file, '-an', '-vf', `fps=10,scale=240:-2,${det}`, '-f', 'null', '-'], { timeoutMs: 3600000, priority: ff.priorityValue() });
  const out = [...String(r.err || '').matchAll(/black_start:([\d.]+) black_end:([\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
  if (useCache) { try { fs.writeFileSync(cache, JSON.stringify(out)); } catch { /* read-only */ } }
  return out;
}

/**
 * Cover every forced stretch (black found in a finished clip, in source seconds) with good picture from elsewhere,
 * at any length (split into pieces of up to 3 s). Shots come from "Look through it" when there are any, else from
 * pieces of the footage between scene cuts; never dark ones, never one already used. Returns [{ at, dur, src }].
 */
async function coverBlack({ forced, start, end, duration, shots = [], scenes = [], black = [], used = [], isDark = null, elsewhere = [] }) {
  const pieces = shots.length ? shots.filter((x) => x.usable !== false && shotScore(x) >= 0.3) : require('./brolledit').sceneShots(scenes, duration);
  const dark = (a, b) => black.some(([x, y]) => x < b + 0.2 && y > a - 0.2);
  const taken = [...used];
  const outside = (x) => x.e <= start || x.s >= end; const seen = (x) => elsewhere.filter(([p, q]) => p < x.e && q > x.s).length;
  // Outside the clip first, then shots the video's other clips haven't used, then the best.
  const pool = pieces.filter((x) => x.e - x.s >= 1.4).sort((a, b) => (outside(a) === outside(b) ? seen(a) - seen(b) || (shots.length ? shotScore(b) - shotScore(a) : 0) : outside(a) ? -1 : 1));
  const out = [];
  for (const [fa, fb] of forced) {
    const a0 = Math.max(start, fa - 0.15), b0 = Math.min(end, fb + 0.15);
    for (let at = a0; at < b0 - 0.05; at += 3) {
      const dur = Math.min(3, b0 - at); let ok = false;
      for (const x of pool) {
        if (x.s < at + dur && x.e > at) continue; // not the black stretch itself
        const mid = (x.s + x.e) / 2; const src = Math.max(x.s + 0.2, Math.min(duration - dur - 0.1, mid - dur / 2));
        if (dark(src, src + dur) || taken.some(([p, q]) => src < q + 3 && src + dur > p - 3)) continue; // never the same shot (or its moment) twice in a clip
        if (isDark && await isDark(src, dur)) { black.push([src, src + dur]); continue; } // checked on the spot, no whole-video scan
        out.push({ at: Math.round(at * 100) / 100, dur: Math.round(dur * 100) / 100, src: Math.round(src * 100) / 100 }); taken.push([src, src + dur]); ok = true; break;
      }
      if (!ok) break;
    }
  }
  return out;
}

/** Turn stretches of a finished clip (output seconds) back into source seconds, through its jump-cut segments. */
function outputToSource(intervals, segments, offset = 0) {
  const out = [];
  for (const [a, b] of intervals) {
    let acc = 0;
    for (const [s, e] of segments) {
      const len = e - s; const x = Math.max(a, acc), y = Math.min(b, acc + len);
      if (y > x) out.push([offset + s + (x - acc), offset + s + (y - acc)]);
      acc += len;
    }
  }
  return out;
}

/**
 * Build the clip's picture with the cut-aways laid in (sound untouched), as a short high-quality
 * file the normal renderer then frames, captions and finishes. Returns the file path.
 */
async function assemble({ source, info, start, end, covers, out, signal }) {
  const len = end - start; const W = info.width || 1920; const H = info.height || 1080; const FPS = require('./render').outFps(info.fps);
  const args = ['-hide_banner', '-y', '-ss', start.toFixed(3), '-t', len.toFixed(3), '-i', source];
  covers.forEach((c) => args.push('-ss', c.src.toFixed(3), '-t', (c.dur + 0.1).toFixed(3), '-an', '-i', source));
  const f = [`[0:v]setpts=PTS-STARTPTS,fps=${FPS},scale=${W}:${H}:flags=bicubic,setsar=1,format=yuv420p[b0]`];
  covers.forEach((c, i) => {
    const off = c.at - start;
    f.push(`[${i + 1}:v]setpts=PTS-STARTPTS+${off.toFixed(3)}/TB,fps=${FPS},scale=${W}:${H}:force_original_aspect_ratio=increase:flags=bicubic,crop=${W}:${H},setsar=1,format=yuv420p[c${i}]`);
    f.push(`[b${i}][c${i}]overlay=enable='between(t,${off.toFixed(3)},${(off + c.dur).toFixed(3)})':eof_action=pass[b${i + 1}]`);
  });
  args.push('-filter_complex', f.join(';'), '-map', `[b${covers.length}]`, '-map', '0:a?', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '15', '-c:a', 'aac', '-b:a', '192k', '-t', len.toFixed(3), out);
  await run(ff.bin('ffmpeg'), args, { timeoutMs: 1800000, signal });
  return out;
}

/** Quick look at just a few frames of one stretch: is it (near) black? Much faster than scanning a whole video. */
async function darkAt(file, src, dur) {
  const r = await run(ff.bin('ffmpeg'), ['-hide_banner', '-nostats', '-ss', src.toFixed(2), '-t', dur.toFixed(2), '-i', file, '-an', '-vf', 'fps=3,scale=96:-2,signalstats,metadata=print:key=lavfi.signalstats.YAVG', '-f', 'null', '-'], { timeoutMs: 60000, priority: ff.priorityValue() });
  const ys = [...String(r.err || '').matchAll(/YAVG=([\d.]+)/g)].map((m) => Number(m[1]));
  return !ys.length || ys.some((y) => y < 28);
}

/**
 * Black, near-black and fading stretches inside one part of a video (source seconds); only that part is decoded
 * (small and at 10 fps), so it takes a second or two. Brightness is measured for every frame and compared with the
 * ~3 s around it: frames that are nearly black count, and each stretch is widened to cover the whole fade down to it
 * and back up (frames clearly darker than their surroundings next to it). Dark scenes that never reach black (a dark
 * room, a dark reveal shot) are left alone, and anything over 6 s is a scene, not a fade.
 */
async function blackInRange(file, start, end) {
  const r = await run(ff.bin('ffmpeg'), ['-hide_banner', '-nostats', '-ss', Math.max(0, start).toFixed(2), '-t', Math.max(0.5, end - start).toFixed(2), '-i', file, '-an', '-vf', 'fps=10,scale=160:-2,signalstats,metadata=print:key=lavfi.signalstats.YAVG', '-f', 'null', '-'], { timeoutMs: 300000, priority: ff.priorityValue() });
  const ys = [...String(r.err || '').matchAll(/YAVG=([\d.]+)/g)].map((m) => Number(m[1]));
  return dips(ys, 10).map(([a, b]) => [Math.max(0, start) + a, Math.max(0, start) + b]);
}

/** Dips to black in a brightness curve (one value per frame at fps): [[start, end], ...] seconds from the curve's start. */
function dips(ys, fps = 10) {
  const n = ys.length; if (!n) return [];
  const W = Math.round(fps * 3); const med = new Array(n);
  for (let i = 0; i < n; i++) { const w = ys.slice(Math.max(0, i - W), Math.min(n, i + W + 1)).sort((a, b) => a - b); med[i] = w[Math.floor(w.length * 0.6)]; }
  // Only a stretch that really reaches black counts (black is ~16; a dark room or a dark reveal shot stays above ~40),
  // then the fade down to it and back up is added.
  const bad = ys.map((y) => y < 24);
  // Widen each dip over the whole fade: neighbours still clearly darker than their surroundings belong to it.
  for (let grew = true; grew;) { grew = false; for (let i = 0; i < n; i++) if (!bad[i] && (bad[i - 1] || bad[i + 1]) && ys[i] < med[i] * 0.9) { bad[i] = true; grew = true; } }
  const out = []; let s = -1;
  for (let i = 0; i <= n; i++) {
    if (i < n && bad[i]) { if (s < 0) s = i; continue; }
    if (s >= 0) { const a = s / fps, b = i / fps; const last = out[out.length - 1]; if (last && a - last[1] < 0.3) last[1] = b; else out.push([a, b]); s = -1; }
  }
  return out.filter(([a, b]) => b - a >= 0.15 && b - a <= 6).map(([a, b]) => [Math.round(Math.max(0, a - 0.1) * 100) / 100, Math.round((b + 0.1) * 100) / 100]);
}

module.exports = { OPEN_LOOP, REFERS, narrative, montageCuts, sharedSec, piecesOf, spoken, DANGLING, END_HOOK, HOOK, FILLER, OUTRO, dips, blackInRange, darkAt, coverBlack, outputToSource, reactionBursts, blackIntervals, condense, levels, sentences, tagVoiceover, isDrone, shotScore, scoreWindow, candidates, signals, planCovers, assemble };
