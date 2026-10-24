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
 * durs: how long each shot plays (from the beat grid); returns [{ src, dur }] (source seconds).
 */
function plan({ shots = [], scenes = [], duration, durs, black = [], avoid = [] }) {
  const pool = (shots.length ? shots : sceneShots(scenes, duration))
    .filter((x) => x.usable !== false && x.e - x.s >= 1.2 && !(x.bright != null && x.bright < 35))
    .map((x) => ({ ...x, q: shots.length ? montage.shotScore(x) + (montage.isDrone(x) ? 0.2 : 0) : 0.5 + Math.random() * 0.1 }))
    .sort((a, b) => b.q - a.q);
  const want = durs.length; const longest = Math.max(...durs);
  const norm = (w) => String(w || '').toLowerCase().replace(/[^a-z ]/g, '').trim();
  const touchesBlack = (a, b) => black.some(([x, y]) => x < b + 0.15 && y > a - 0.15);
  const usedBefore = (x) => avoid.some(([a, b]) => x.s < b && x.e > a);
  const gap = shots.length ? 3 : -0.05; // looked-through shots: never the same moment twice; scene pieces just mustn't overlap
  const pick = (skipUsed) => {
    const picked = [];
    for (const x of pool) {
      if (picked.length >= want) break;
      if (skipUsed && usedBefore(x)) continue;
      if (picked.some((p) => (x.s < p.e + gap && x.e > p.s - gap) || (x.what && p.what && norm(x.what) === norm(p.what)))) continue;
      const mid = (x.s + x.e) / 2; const src = Math.max(0, Math.min(duration - longest - 0.1, Math.max(x.s + 0.2, mid - longest / 2)));
      if (touchesBlack(src, src + longest)) continue;
      picked.push({ ...x, src: Math.round(src * 100) / 100 });
    }
    return picked;
  };
  let picked = pick(true); if (picked.length < Math.min(want, 4)) picked = pick(false);
  // Fewer good shots than beats: reuse the strongest ones from a later point inside them rather than stop early.
  for (let i = 0; picked.length && picked.length < want; i++) { const p = picked[i % picked.length]; picked.push({ ...p, src: Math.min(duration - longest - 0.1, p.src + 1.1 * (1 + Math.floor(i / picked.length))) }); }
  return picked.sort((a, b) => a.src - b.src).map((p, i) => ({ src: p.src, dur: durs[i] }));
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
async function render({ source, segs, grid, music, out, volume = 0.9, signal }) {
  if (segs.length < 2) throw new Error('Not enough good shots in this video for a B-roll edit');
  const args = ['-hide_banner', '-y'];
  segs.forEach((s) => args.push('-ss', s.src.toFixed(3), '-t', (s.dur + 0.2).toFixed(3), '-an', '-i', source));
  if (music) args.push('-ss', (grid.start || 0).toFixed(3), '-stream_loop', '-1', '-i', music);
  const f = [];
  segs.forEach((s, i) => {
    const frames = Math.max(2, Math.round(s.dur * FPS)); const zin = i % 2 === 0;
    const z = zin ? `min(1+${(0.1 / frames).toFixed(5)}*on,1.1)` : `max(1.1-${(0.1 / frames).toFixed(5)}*on,1)`;
    f.push(`[${i}:v]fps=${FPS},scale=${W}:${H}:force_original_aspect_ratio=increase:flags=lanczos,crop=${W}:${H},setsar=1,`
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
  f.push(`[${last}]fade=t=in:st=0:d=0.25,fade=t=out:st=${Math.max(0, total - 0.6).toFixed(3)}:d=0.6[vout]`);
  if (music) f.push(`[${segs.length}:a]atrim=duration=${total.toFixed(3)},asetpts=PTS-STARTPTS,aresample=48000,volume=${volume},loudnorm=I=-14:TP=-1.5:LRA=11,afade=t=in:d=0.08,afade=t=out:st=${Math.max(0, total - 1.5).toFixed(3)}:d=1.5[aout]`);
  else f.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${total.toFixed(3)}[aout]`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  args.push('-filter_complex', f.join(';'), '-map', '[vout]', '-map', '[aout]', '-t', total.toFixed(3), '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', out);
  await run(ff.bin('ffmpeg'), args, { timeoutMs: 1800000, signal, priority: ff.priorityValue() });
  return { outPath: out, duration: total };
}

/**
 * Plan and render a whole edit. With music, the cuts land on its beats (beats.js); without, soft crossfades every ~2.4 s.
 */
async function make({ source, duration, shots, scenes, black, avoid, music, length = 20, out, volume, signal }) {
  let grid = null; let bpm = null;
  if (music) { try { const bt = await require('./beats').detect(music); const g = require('./beats').cutGrid(bt, length); if (g && g.cuts.length >= 2) { const avail = await require('./studio').xfadeSupport().catch(() => null); grid = { ...g, trans: beatTransitions(g.cuts, avail && avail.size ? avail : null) }; bpm = bt.bpm; } } catch { /* no beat: plain grid */ } }
  if (!grid) grid = plainGrid(length);
  const segs = plan({ shots, scenes, duration, durs: durations(grid), black, avoid });
  const r = await render({ source, segs, grid, music, out, volume, signal });
  return { ...r, segs, bpm, cuts: grid.cuts.length, synced: !!bpm };
}

module.exports = { make, plan, render, durations, plainGrid, beatTransitions, sceneShots };
