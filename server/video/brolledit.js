'use strict';
/**
 * B-roll edit: a dramatic, music-only cut-through of a video's best-looking shots (no original audio),
 * like a TikTok "edit". Shots come from "Look through it" (vision) when available, else from the scene cuts.
 * Each shot is taken from its middle (away from fades), gets a slow push-in and a moody grade, and shots are
 * joined with short crossfades so it flows instead of chopping. A mood track (suspense, creepy, intense...) plays under it.
 */
const fs = require('fs');
const path = require('path');
const ff = require('./ffmpeg');
const { run } = require('../core/util');
const montage = require('./montage');

const W = 1080, H = 1920, FPS = 30, FADE = 0.4;

/** Shots between the scene cuts, when the video hasn't been looked through. */
function sceneShots(scenes = [], duration = 0) {
  const cuts = [0, ...scenes.filter((t) => t > 0.5 && t < duration - 0.5).sort((a, b) => a - b), duration];
  const out = []; for (let i = 0; i < cuts.length - 1; i++) out.push({ s: cuts[i], e: cuts[i + 1] });
  // Long stretches without a cut are split into ~3.5 s pieces, so a single long take still gives several shots.
  return out.flatMap((x) => { const n = Math.max(1, Math.floor((x.e - x.s) / 3.5)); return Array.from({ length: n }, (_, k) => ({ s: x.s + (k * (x.e - x.s)) / n, e: x.s + ((k + 1) * (x.e - x.s)) / n })); });
}

/**
 * Pick the shots: the strongest ones, never two from the same moment or described the same way (and, for a daily
 * edit, not the ones used before when there are enough others), then put back in story order.
 * Footage never repeats: each shot is split into separate pieces that don't overlap, the middle piece of every shot is
 * tried first, a second piece of the same shot only comes from a clearly different moment of it, and when the good
 * footage runs out the plan is simply shorter (make() then ends the edit early) instead of showing a moment twice.
 * durs: how long each shot plays (from the beat grid); returns [{ src, dur }] (source seconds).
 */
function plan({ shots = [], scenes = [], duration, durs, black = [], avoid = [], window = null, strict = false }) {
  const inWin = (x) => !window || (x.s >= window[0] - 0.01 && x.e <= window[1] + 0.01);
  const longest = Math.max(...durs); const need = longest + 0.04;
  const base = (shots.length ? shots : sceneShots(scenes, duration))
    .filter(inWin).filter((x) => x.usable !== false && x.e - x.s >= Math.min(1.2, need) && !(x.bright != null && x.bright < 35))
    .map((x) => ({ ...x, q: shots.length ? montage.shotScore(x) + (montage.isDrone(x) ? 0.2 : 0) : 0.5 }));
  const touchesBlack = (a, b) => black.some(([x, y]) => x < b + 0.15 && y > a - 0.15);
  const usedBefore = (a, b) => avoid.some(([x, y]) => a < y && b > x);
  // Pieces: every shot cut into back-to-back slots of the longest shot length (away from its first/last 0.2 s).
  const pieces = [];
  base.forEach((x, si) => {
    const lo = x.s + 0.08, hi = Math.min(x.e, duration) - 0.08; const n = Math.max(1, Math.floor((hi - lo) / need));
    const mid = (lo + hi) / 2; const span = n * need; const start0 = Math.max(lo, mid - span / 2);
    for (let k = 0; k < n; k++) { const a = start0 + k * need; if (a + longest > hi + 1e-6) continue; pieces.push({ si, a, q: x.q, mid: Math.abs(a + longest / 2 - mid), what: x.what }); }
  });
  const norm = (w) => String(w || '').toLowerCase().replace(/[^a-z ]/g, '').trim();
  pieces.sort((p, q) => q.q - p.q || p.mid - q.mid);
  const picked = [];
  const clash = (p, gap) => picked.some((o) => p.a < o.a + longest + gap && p.a + longest + gap > o.a);
  const pass = (rule) => {
    for (const p of pieces) {
      if (picked.length >= durs.length) return;
      if (picked.includes(p) || touchesBlack(p.a, p.a + longest)) continue;
      if (rule.fresh && usedBefore(p.a, p.a + longest)) continue;
      if (rule.oneEach && picked.some((o) => o.si === p.si || (p.what && o.what && norm(p.what) === norm(o.what)))) continue;
      if (clash(p, rule.gap)) continue;
      picked.push(p);
    }
  };
  pass({ fresh: true, oneEach: true, gap: shots.length ? 3 : 0.3 }); // different shots, not used by earlier edits
  if (!strict) pass({ fresh: false, oneEach: true, gap: shots.length ? 3 : 0.3 }); // different shots, even if an earlier edit used them
  pass({ fresh: !!strict, oneEach: false, gap: 1.5 }); // another moment of a shot already in (at least 1.5 s away)
  return picked.sort((a, b) => a.a - b.a).map((p, i) => ({ src: Math.round(p.a * 100) / 100, dur: durs[i] }));
}

/** Cut times every ~2.4 s with soft crossfades (no beat grid: no music, or the beat couldn't be found). */
function plainGrid(length = 20, per = 2.4) {
  const cuts = []; for (let t = per; t < length - 1; t += per) cuts.push(Math.round(t * 100) / 100);
  return { start: 0, cuts, total: length, trans: cuts.map(() => ({ type: 'fade', d: FADE })) };
}

/** Transitions on the beat: mostly hard cuts (punchy), every third one a flash, zoom, slide or blur. */
function beatTransitions(cuts, available) {
  const fancy = [['fadewhite', 0.18], ['zoomin', 0.3], ['slideleft', 0.25], ['hblur', 0.25], ['circleopen', 0.3], ['smoothup', 0.25]].filter(([n]) => !available || available.has(n));
  return cuts.map((c, i) => (fancy.length && i % 3 === 2 ? { type: fancy[Math.floor(i / 3) % fancy.length][0], d: fancy[Math.floor(i / 3) % fancy.length][1] } : { type: 'fade', d: 0.04 }));
}

/** How long each shot must be so every transition is centred on its cut time. */
function durations({ cuts, total, trans }) {
  const c = [0, ...cuts, total]; const T = [0, ...trans.map((x) => x.d), 0];
  return c.slice(0, -1).map((t, i) => Math.round((c[i + 1] - t + T[i] / 2 + T[i + 1] / 2) * 1000) / 1000);
}

/** Render the edit: vertical, slow push-ins (alternating in and out), cuts/transitions on the grid, moody grade, music only. */
async function render({ source, segs, grid, music, out, volume = 0.9, signal, raw = false, ass = null }) {
  if (segs.length < 2) throw new Error('Not enough good shots in this video for a B-roll edit');
  const args = ['-hide_banner', '-y'];
  segs.forEach((s) => args.push('-ss', s.src.toFixed(3), '-t', (s.dur + 0.2).toFixed(3), '-an', '-i', source));
  if (music) args.push('-ss', (grid.start || 0).toFixed(3), '-stream_loop', '-1', '-i', music);
  const f = [];
  segs.forEach((s, i) => {
    const frames = Math.max(2, Math.round(s.dur * FPS)); const zin = i % 2 === 0;
    const z = zin ? `min(1+${(0.1 / frames).toFixed(5)}*on,1.1)` : `max(1.1-${(0.1 / frames).toFixed(5)}*on,1)`;
    // raw (story edits): the footage as filmed, like a phone video; otherwise slow push-ins and a moody grade.
    f.push(raw
      ? `[${i}:v]fps=${FPS},scale=${W}:${H}:force_original_aspect_ratio=increase:flags=lanczos,crop=${W}:${H},setsar=1,trim=end_frame=${frames},setpts=PTS-STARTPTS,format=yuv420p[v${i}]`
      : `[${i}:v]fps=${FPS},scale=${W}:${H}:force_original_aspect_ratio=increase:flags=lanczos,crop=${W}:${H},setsar=1,`
      + `zoompan=z='${z}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${W}x${H}:fps=${FPS},`
      + `trim=end_frame=${frames},setpts=PTS-STARTPTS,eq=contrast=1.12:saturation=0.82:brightness=-0.035,vignette=PI/5,format=yuv420p[v${i}]`);
  });
  let last = 'v0';
  for (let i = 1; i < segs.length; i++) {
    const tr = grid.trans[i - 1]; const o = `x${i}`;
    f.push(`[${last}][v${i}]xfade=transition=${tr.type}:duration=${tr.d}:offset=${Math.max(0, grid.cuts[i - 1] - tr.d / 2).toFixed(3)}[${o}]`);
    last = o;
  }
  const total = grid.total;
  // Story edits start on a full frame (the first frame is the cover) and carry their text lines (ASS) on top.
  const sub = ass ? `,subtitles=filename='${require('./render').rel(ass)}':fontsdir='fonts'` : '';
  f.push(raw ? `[${last}]fade=t=out:st=${Math.max(0, total - 0.4).toFixed(3)}:d=0.4${sub}[vout]` : `[${last}]fade=t=in:st=0:d=0.25,fade=t=out:st=${Math.max(0, total - 0.6).toFixed(3)}:d=0.6${sub}[vout]`);
  if (music) f.push(`[${segs.length}:a]atrim=duration=${total.toFixed(3)},asetpts=PTS-STARTPTS,aresample=48000,volume=${volume},loudnorm=I=-14:TP=-1.5:LRA=11,afade=t=in:d=0.08,afade=t=out:st=${Math.max(0, total - 1.5).toFixed(3)}:d=1.5[aout]`);
  else f.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${total.toFixed(3)}[aout]`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  args.push('-filter_complex', f.join(';'), '-map', '[vout]', '-map', '[aout]', '-t', total.toFixed(3), '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', out);
  if (ass) require('./render').ensureFonts();
  await run(ff.bin('ffmpeg'), args, { timeoutMs: 1800000, signal, priority: ff.priorityValue(), cwd: require('../core/paths').root });
  return { outPath: out, duration: total };
}

/**
 * Plan and render a whole edit. With music, the cuts land on its beats (beats.js); without, soft crossfades every ~2.4 s.
 */
async function make({ source, duration, shots, scenes, black, avoid, music, length = 20, out, volume, signal, raw = false, window = null, cutBeats = null, texts = null, strict = false }) {
  let grid = null; let bpm = null;
  if (music) { try { const bt = await require('./beats').detect(music); const g = require('./beats').cutGrid(bt, length, cutBeats); if (g && g.cuts.length >= 2) { const avail = await require('./studio').xfadeSupport().catch(() => null); grid = { ...g, trans: beatTransitions(g.cuts, avail && avail.size ? avail : null) }; bpm = bt.bpm; } } catch { /* no beat: plain grid */ } }
  if (!grid) grid = plainGrid(length, raw ? 2.6 : 2.4);
  if (raw) grid.trans = grid.cuts.map(() => ({ type: 'fade', d: 0.04 })); // story edits: straight cuts, like a phone edit
  let segs = plan({ shots, scenes, duration, durs: durations(grid), black, avoid, window, strict });
  // Too few shots in this part: widen it step by step (still never reusing another edit's shots when strict).
  for (let k = 1; window && k <= 3 && segs.length < Math.min(grid.cuts.length + 1, 8); k++) {
    const pad = ((window[1] - window[0]) * k) / 2; const more = plan({ shots, scenes, duration, durs: durations(grid), black, avoid, window: [Math.max(0, window[0] - pad), Math.min(duration, window[1] + pad)], strict });
    if (more.length > segs.length) segs = more;
  }
  // Not enough different footage for the whole length: end the edit at the last fresh shot rather than repeat one.
  if (segs.length >= 2 && segs.length < grid.cuts.length + 1) {
    const k = segs.length; grid = { ...grid, total: grid.cuts[k - 1], cuts: grid.cuts.slice(0, k - 1), trans: grid.trans.slice(0, k - 1) };
    const d = durations(grid); segs = segs.map((x, i) => ({ ...x, dur: d[i] }));
  }
  // texts(grid) -> an ASS file with the story lines, timed to the cuts.
  const ass = typeof texts === 'function' ? await texts(grid) : null;
  const r = await render({ source, segs, grid, music, out, volume, signal, raw, ass });
  return { ...r, segs, bpm, cuts: grid.cuts.length, synced: !!bpm };
}

module.exports = { make, plan, render, durations, plainGrid, beatTransitions, sceneShots };
