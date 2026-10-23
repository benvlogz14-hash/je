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
const HOOK = /\b(never|nobody|no one|secret|hidden|abandoned|inside|why|how|what|imagine|biggest|craziest|insane|first|last|only|million|billion|\d+)\b|\?/i;
/**
 * Score one candidate window. sig = { sents, shots, scenes, peaks, lv }.
 * Returns { score, why[] } where why lists what made it good, for the clip card.
 */
function scoreWindow(s, e, sig) {
  const len = e - s; const why = [];
  const inS = sig.sents.filter((x) => x.s >= s - 0.05 && x.e <= e + 0.05);
  const speech = inS.reduce((n, x) => n + (x.e - x.s), 0) / len;
  const vo = inS.filter((x) => x.vo).reduce((n, x) => n + (x.e - x.s), 0) / len;
  const sh = sig.shots.filter((x) => x.s < e && x.e > s);
  const cover = (f) => sh.filter(f).reduce((n, x) => n + Math.min(e, x.e) - Math.max(s, x.s), 0) / len;
  const drone = cover(isDrone); const strong = sh.length ? sh.reduce((n, x) => n + shotScore(x) * (Math.min(e, x.e) - Math.max(s, x.s)), 0) / len : 0.3;
  const bad = cover((x) => x.usable === false || (x.bright != null && x.bright < 35));
  const cuts = sig.scenes.filter((t) => t > s && t < e).length / (len / 10); // cuts per 10 s
  const peaks = sig.peaks.filter((t) => t > s && t < e).length;
  const hook = inS[0] && HOOK.test(inS[0].t) ? 1 : 0;
  // Filler and outros lose viewers: "um, so yeah, I mean, anyway", "thanks for watching, subscribe".
  const filler = inS.filter((x) => FILLER.test(x.t)).reduce((n, x) => n + (x.e - x.s), 0) / len;
  const outro = inS.some((x) => OUTRO.test(x.t));
  let score = -25 * filler - (outro ? 15 : 0) + 30 * Math.min(1, speech / 0.75) + 25 * vo + 18 * drone + 20 * strong + 6 * Math.min(cuts, 3) + 4 * Math.min(peaks, 3) + 10 * hook - 30 * bad;
  // Dead air at the start loses viewers in the first second.
  const firstWord = inS[0]?.s ?? e; if (firstWord - s > 1.2) score -= 10;
  if (vo > 0.4) why.push('voiceover');
  if (drone > 0.15) why.push('drone shots');
  if (strong > 0.55) why.push('strong visuals');
  if (cuts >= 1.5) why.push('fast cuts');
  if (peaks) why.push(`${peaks} energy peak${peaks > 1 ? 's' : ''}`);
  if (hook) why.push('hook in the first line');
  return { score: Math.round(score * 10) / 10, why };
}

/** Candidate windows that start and end on whole sentences, within min..max seconds. */
function candidates(sig, { minSec, maxSec, duration, exclude = [], limit = 40 }) {
  const out = []; const S = sig.sents;
  for (let i = 0; i < S.length; i++) {
    for (let j = i; j < S.length; j++) {
      const s = Math.max(0, S[i].s - 0.15); const e = Math.min(duration, S[j].e + 0.25); const len = e - s;
      if (len > maxSec) break;
      if (len < minSec) continue;
      if (exclude.some((x) => Math.min(x.end, e) - Math.max(x.start, s) > 0.2 * len)) continue;
      out.push({ start: Math.round(s * 100) / 100, end: Math.round(e * 100) / 100, ...scoreWindow(s, e, sig), text: S.slice(i, j + 1).map((x) => x.t).join(' ') });
    }
  }
  out.sort((a, b) => b.score - a.score);
  const picked = [];
  for (const c of out) { if (picked.every((p) => Math.min(p.end, c.end) - Math.max(p.start, c.start) < 0.15 * (c.end - c.start))) picked.push(c); if (picked.length >= limit) break; }
  return picked;
}

/** Everything the scorer needs for one footage file. */
async function signals({ asset, transcript, vision, analysis }) {
  const shots = (vision?.shots || []).map((x) => ({ ...x }));
  let lv = null; try { lv = asset.info?.hasAudio ? await levels(asset.path, asset.workDir) : null; } catch { /* no level map */ }
  const sents = tagVoiceover(sentences(transcript?.words || []), lv, shots);
  return { sents, shots, scenes: analysis?.scenes || [], peaks: analysis?.peaks || [], lv };
}

// ---------------------------------------------------------------- visual cuts
/**
 * Picture-only cut-aways for one clip range (source seconds): weak or static stretches get the
 * best shots from elsewhere for 2-3 s each while the voice keeps playing.
 * Returns [{ at, dur, src }] with at/src in source seconds.
 */
function planCovers({ start, end, shots, sents = [], avoid = [], gap = 1.5 }) {
  if (!shots.length) return [];
  const len = end - start;
  const pool = shots.filter((x) => (x.e <= start || x.s >= end) && shotScore(x) >= 0.45 && x.e - x.s >= 2.2 && !avoid.some((a) => x.s < a.end && x.e > a.start))
    .sort((a, b) => shotScore(b) - shotScore(a));
  if (!pool.length) return [];
  const here = shots.filter((x) => x.s < end && x.e > start);
  // Weak: a poor or static shot, someone talking with little movement, or any shot held too long (strong ones may run longer).
  const weak = (t) => { const s = here.find((x) => t >= x.s && t < x.e); if (!s) return true; const q = shotScore(s); return q < 0.4 || (s.kind === 'speaker' && (s.motion ?? 5) < 3) || (t - Math.max(s.s, start)) > (q >= 0.7 ? 9 : 5); };
  const out = []; let used = 0; let tries = 0; let t = start + 2.5; // keep the first 2.5 s on the real moment: that's the hook
  while (t < end - 2.5 && used < pool.length * 2) {
    // Voiceover is always fine to cover; someone talking on camera gets fewer cut-aways (about 3 in 5).
    const sentNow = sents.find((x) => t >= x.s && t < x.e);
    if (weak(t) && (!sentNow || sentNow.vo || (tries++ % 5) < 3)) {
      const src = pool[used++ % pool.length]; const dur = Math.min(3, Math.max(2, src.e - src.s - 0.4), end - 1 - t);
      if (dur >= 1.6) { out.push({ at: Math.round(t * 100) / 100, dur: Math.round(dur * 100) / 100, src: Math.round((src.s + 0.2) * 100) / 100 }); t += dur + gap; continue; }
    }
    t += 1.5;
  }
  return out.filter((c) => c.at + c.dur <= start + len - 0.5);
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

module.exports = { levels, sentences, tagVoiceover, isDrone, shotScore, scoreWindow, candidates, signals, planCovers, assemble };
