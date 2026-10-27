'use strict';
/**
 * Find the beat of a music track: tempo (BPM) and the time of every beat, so B-roll edits can cut on the beat.
 * The track is decoded to a low sample rate, its bass energy (kicks) and full-band energy give an onset curve,
 * the tempo is the strongest repeat in that curve (60-180 BPM), and the beat phase is where onsets line up best.
 * Cached next to the track as <file>.beats.json.
 */
const fs = require('fs');
const { spawn } = require('child_process');
const ff = require('./ffmpeg');

const SR = 11025, HOP = 256; // ~23 ms per frame

function decode(file, filter) {
  return new Promise((resolve, reject) => {
    const p = spawn(ff.bin('ffmpeg'), ['-hide_banner', '-v', 'error', '-i', file, '-t', '240', '-ac', '1', '-ar', String(SR), ...(filter ? ['-af', filter] : []), '-f', 's16le', '-'], { windowsHide: true });
    const chunks = []; p.stdout.on('data', (d) => chunks.push(d)); p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error('Could not read the music track'))));
  });
}

function energy(buf) {
  const n = Math.floor(buf.length / 2 / HOP); const e = new Float64Array(n);
  for (let i = 0; i < n; i++) { let s = 0; for (let k = 0; k < HOP; k++) { const v = buf.readInt16LE((i * HOP + k) * 2) / 32768; s += v * v; } e[i] = Math.log(1e-6 + s / HOP); }
  return e;
}

/** Onset strength: how much louder each frame is than the one before (only rises count). */
function onsets(e) { const o = new Float64Array(e.length); for (let i = 1; i < e.length; i++) o[i] = Math.max(0, e[i] - e[i - 1]); return o; }

async function detect(file) {
  const cache = `${file}.beats.json`;
  try { const c = JSON.parse(fs.readFileSync(cache, 'utf8')); if (c.v === 1) return c; } catch { /* measure */ }
  const [full, low] = await Promise.all([decode(file, null), decode(file, 'lowpass=f=160')]);
  const a = onsets(energy(full)), b = onsets(energy(low));
  const o = a.map((v, i) => v + 1.5 * (b[i] || 0));
  const fps = SR / HOP; const n = o.length;
  // Tempo: autocorrelation of the onset curve over 60-180 BPM, with a gentle preference for 80-140.
  let best = { lag: 0, s: -1 };
  for (let lag = Math.round((fps * 60) / 180); lag <= Math.round((fps * 60) / 60); lag++) {
    let s = 0; for (let i = lag; i < n; i++) s += o[i] * o[i - lag];
    const bpm = (60 * fps) / lag; s *= bpm >= 80 && bpm <= 140 ? 1.1 : 1;
    if (s > best.s) best = { lag, s };
  }
  const period = best.lag / fps; const bpm = Math.round((60 / period) * 10) / 10;
  // Phase: the offset where onsets line up with the beat grid best.
  let ph = { off: 0, s: -1 };
  for (let off = 0; off < best.lag; off++) { let s = 0; for (let i = off; i < n; i += best.lag) s += o[i] + 0.5 * (o[i - 1] || 0) + 0.5 * (o[i + 1] || 0); if (s > ph.s) ph = { off, s }; }
  const duration = n / fps; const beats = [];
  for (let t = ph.off / fps; t < duration; t += period) beats.push(Math.round(t * 1000) / 1000);
  const out = { v: 1, bpm, period: Math.round(period * 10000) / 10000, beats, duration: Math.round(duration * 100) / 100 };
  try { fs.writeFileSync(cache, JSON.stringify(out)); } catch { /* read-only */ }
  return out;
}

/**
 * Cut times on the beat for an edit of about `length` seconds: a cut every few beats (about 1.4-2.6 s per shot),
 * starting from the first beat. Returns { start (where the music starts), cuts: [output seconds], total }.
 */
function cutGrid({ beats, period }, length = 20, perShot = null) {
  if (!beats?.length || !period) return null;
  // Beats per shot: 1, 2, 4 or 8 (musical groupings), nearest to ~2 s per shot (or perShot seconds); every 4th shot is a quick double cut.
  const ideal = (perShot || 2) / period; const per = [1, 2, 4, 8].reduce((a, b) => (Math.abs(Math.log(b / ideal)) < Math.abs(Math.log(a / ideal)) ? b : a));
  const pattern = per >= 2 ? [per, per, per, per / 2, per / 2] : [per];
  const start = beats[0]; const cuts = []; let k = 0; let i = 0;
  for (;;) { k += pattern[i++ % pattern.length]; if (k >= beats.length) break; const t = beats[k] - start; if (t >= length - 0.5) break; cuts.push(Math.round(t * 1000) / 1000); }
  const total = k < beats.length ? Math.round((beats[k] - start) * 1000) / 1000 : length;
  return { start, cuts, total, perBeats: per };
}

module.exports = { detect, cutGrid };
