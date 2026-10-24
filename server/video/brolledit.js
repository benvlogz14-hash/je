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
 * Pick the shots: the strongest ones, never two from the same moment or described the same way, then put back
 * in story order. Returns [{ src, dur }] (source seconds).
 */
function plan({ shots = [], scenes = [], duration, length = 20, black = [], per = 2.4 }) {
  const pool = (shots.length ? shots : sceneShots(scenes, duration))
    .filter((x) => x.usable !== false && x.e - x.s >= 1.8 && !(x.bright != null && x.bright < 35))
    .map((x) => ({ ...x, q: shots.length ? montage.shotScore(x) + (montage.isDrone(x) ? 0.2 : 0) : 0.5 + Math.random() * 0.1 }))
    .sort((a, b) => b.q - a.q);
  const want = Math.max(4, Math.min(16, Math.round((length + FADE) / (per - FADE))));
  const norm = (w) => String(w || '').toLowerCase().replace(/[^a-z ]/g, '').trim();
  const touchesBlack = (a, b) => black.some(([x, y]) => x < b + 0.15 && y > a - 0.15);
  const gap = shots.length ? 3 : -0.05; // looked-through shots: never the same moment twice; scene pieces just mustn't overlap
  const picked = [];
  for (const x of pool) {
    if (picked.length >= want) break;
    if (picked.some((p) => (x.s < p.e + gap && x.e > p.s - gap) || (x.what && p.what && norm(x.what) === norm(p.what)))) continue;
    const dur = Math.min(per, x.e - x.s - 0.5); const mid = (x.s + x.e) / 2; const src = Math.max(x.s + 0.25, mid - dur / 2);
    if (dur < 1.4 || touchesBlack(src, src + dur)) continue;
    picked.push({ ...x, src: Math.round(src * 100) / 100, dur: Math.round(dur * 100) / 100 });
  }
  return picked.sort((a, b) => a.src - b.src).map(({ src, dur }) => ({ src, dur }));
}

/** Render the edit: vertical, slow push-ins, crossfades, moody grade, music only. */
async function render({ source, segs, music, out, volume = 0.9, signal }) {
  if (segs.length < 2) throw new Error('Not enough good shots in this video for a B-roll edit');
  const args = ['-hide_banner', '-y'];
  segs.forEach((s) => args.push('-ss', s.src.toFixed(3), '-t', (s.dur + 0.2).toFixed(3), '-an', '-i', source));
  if (music) args.push('-stream_loop', '-1', '-i', music);
  const f = [];
  segs.forEach((s, i) => {
    const frames = Math.round(s.dur * FPS);
    f.push(`[${i}:v]fps=${FPS},scale=${W}:${H}:force_original_aspect_ratio=increase:flags=lanczos,crop=${W}:${H},setsar=1,`
      + `zoompan=z='min(1+0.0016*on,1.1)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${W}x${H}:fps=${FPS},`
      + `trim=end_frame=${frames},setpts=PTS-STARTPTS,eq=contrast=1.1:saturation=0.85:brightness=-0.03,vignette=PI/5,format=yuv420p[v${i}]`);
  });
  let last = 'v0'; let t = segs[0].dur;
  for (let i = 1; i < segs.length; i++) {
    const o = `x${i}`; f.push(`[${last}][v${i}]xfade=transition=fade:duration=${FADE}:offset=${(t - FADE).toFixed(3)}[${o}]`);
    last = o; t += segs[i].dur - FADE;
  }
  const total = Math.round(t * 1000) / 1000;
  f.push(`[${last}]fade=t=in:st=0:d=0.3,fade=t=out:st=${Math.max(0, total - 0.6).toFixed(3)}:d=0.6[vout]`);
  if (music) f.push(`[${segs.length}:a]atrim=duration=${total.toFixed(3)},asetpts=PTS-STARTPTS,aresample=48000,volume=${volume},loudnorm=I=-14:TP=-1.5:LRA=11,afade=t=in:d=0.5,afade=t=out:st=${Math.max(0, total - 1.5).toFixed(3)}:d=1.5[aout]`);
  else f.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${total.toFixed(3)}[aout]`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  args.push('-filter_complex', f.join(';'), '-map', '[vout]', '-map', '[aout]', '-t', total.toFixed(3), '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', out);
  await run(ff.bin('ffmpeg'), args, { timeoutMs: 1800000, signal, priority: ff.priorityValue() });
  return { outPath: out, duration: total };
}

module.exports = { plan, render, sceneShots };
