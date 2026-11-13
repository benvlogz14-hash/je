'use strict';
/**
 * The edit of a political ad's voice: natural cuts, level, master and a check of the finished file.
 * (Political ads only. The clip machine for creators has its own cutting in server/video and is not touched by this.)
 *
 *   snapLine   every line starts and ends in the quiet between words, found in the sound itself (transcript times drift
 *              0.1-0.5 s); long pauses inside a line are closed up; the line's speech level is measured
 *   cutLine    the line cut to those times, picture and sound together, every line at the same loudness
 *   master     the finished mix brought to -14 LUFS / -1.5 dBTP (measured, then set: two passes)
 *   qa         the finished file measured: loudness, peak, black frames, dead air, length
 *   faceBox    where the speaker's face is in a shot (so full-screen text never sits on it)
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const ff = require('../video/ffmpeg');

const STEP = 0.01; // seconds per loudness reading
const LEAD = 0.04; // a breath before the first word
const TAIL = 0.11; // the voice's natural decay after the last
const PAUSE = 0.55; // pauses inside a line longer than this are closed up...
const PAUSE_KEEP = 0.2; // ...to this

function collect(args, { timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(ff.bin('ffmpeg'), ['-hide_banner', '-nostdin', ...args], { windowsHide: true });
    const out = []; let err = '';
    const timer = setTimeout(() => { try { p.kill(); } catch { /* gone */ } }, timeoutMs);
    p.stdout.on('data', (d) => out.push(d)); p.stderr.on('data', (d) => { err = (err + d).slice(-60000); });
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.on('close', (code) => { clearTimeout(timer); resolve({ code, out: Buffer.concat(out), err }); });
  });
}

/** Loudness of the voice band every 10 ms between two times (dB, 0 = full scale). */
async function energy(file, from, to) {
  from = Math.max(0, from);
  const r = await collect(['-loglevel', 'error', '-ss', from.toFixed(3), '-t', Math.max(0.1, to - from).toFixed(3), '-i', file, '-vn', '-ac', '1', '-ar', '16000', '-af', 'highpass=f=120,lowpass=f=5000', '-f', 's16le', '-']);
  const n = Math.floor(r.out.length / 2); const per = Math.round(16000 * STEP); const frames = Math.floor(n / per);
  const db = new Float32Array(frames);
  for (let i = 0; i < frames; i++) { let s = 0; for (let k = 0; k < per; k++) { const v = r.out.readInt16LE((i * per + k) * 2) / 32768; s += v * v; } db[i] = 10 * Math.log10(s / per + 1e-10); }
  return { from, db };
}

const pct = (arr, p) => { const a = Array.from(arr).sort((x, y) => x - y); return a.length ? a[Math.min(a.length - 1, Math.floor(a.length * p))] : -90; };

/**
 * Natural in and out points for one line. b = { s, e, words } in the video's own seconds.
 * Returns { keep: [[from, to], ...] (source seconds, pauses closed), level (speech RMS, dB), clean: { in, out } }.
 */
async function snapLine(file, b, duration = Infinity) {
  const w0 = Math.max(0, b.s - 0.7); const w1 = Math.min(duration, b.e + 0.9);
  let E;
  try { E = await energy(file, w0, w1); } catch { E = null; }
  if (!E || E.db.length < 20) return { keep: [[Math.max(0, b.s - 0.1), Math.min(duration, b.e + 0.25)]], level: null, clean: { in: false, out: false }, measured: false };
  const db = E.db; const at = (t) => Math.max(0, Math.min(db.length - 1, Math.round((t - E.from) / STEP))); const time = (i) => E.from + i * STEP;
  const inside = db.subarray(at(b.s), at(b.e) + 1);
  const floor = pct(db, 0.08); const loud = pct(inside, 0.85);
  const thr = Math.min(loud - 9, floor + Math.max(6, (loud - floor) * 0.35));
  const quiet = (i) => db[i] < thr;
  // Runs of quiet (at least 50 ms) across the window.
  const runs = []; let a = -1;
  for (let i = 0; i <= db.length; i++) { const q = i < db.length && quiet(i); if (q && a < 0) a = i; if (!q && a >= 0) { if (i - a >= 5) runs.push([a, i]); a = -1; } }
  const minAt = (t0, t1) => { let best = at(t0); for (let i = at(t0); i <= at(t1); i++) if (db[i] < db[best]) best = i; return best; };

  // In: the quiet right before their first word (the run that ends nearest the transcript's start).
  let start; let cleanIn = true;
  const before = runs.filter(([, e]) => time(e) >= b.s - 0.4 && time(e) <= b.s + 0.3).sort((x, y) => Math.abs(time(x[1]) - b.s) - Math.abs(time(y[1]) - b.s))[0];
  if (before) start = Math.max(time(before[0]), time(before[1]) - LEAD);
  else { start = time(minAt(b.s - 0.2, b.s + 0.08)); cleanIn = false; }
  // Out: the first real quiet after their last word (a stop consonant's 50-70 ms gap is not the end).
  let end; let cleanOut = true;
  const after = runs.filter(([s, e]) => time(e) > b.e - 0.12 && time(s) <= b.e + 0.55 && e - s >= 8)[0];
  if (after) end = Math.min(time(after[1]) - 0.02, Math.max(time(after[0]), b.e - 0.12) + TAIL);
  else { end = time(minAt(b.e - 0.05, b.e + 0.35)); cleanOut = false; }
  start = Math.max(0, start); end = Math.min(duration, Math.max(end, start + 0.6));

  // Long pauses inside the line are closed up (a breath is kept), each side of the cut in the quiet.
  const keep = []; let cur = start;
  for (const [s, e] of runs) {
    const ts = time(s); const te = time(e);
    if (ts <= start + 0.25 || te >= end - 0.25 || te - ts < PAUSE) continue;
    keep.push([cur, ts + PAUSE_KEEP / 2]); cur = te - PAUSE_KEEP / 2;
  }
  keep.push([cur, end]);
  // Speech level: the loud readings only (so pauses don't count).
  let sum = 0; let cnt = 0; for (let i = at(start); i <= at(end); i++) if (db[i] > thr) { sum += 10 ** (db[i] / 10); cnt++; }
  return { keep: keep.filter(([x, y]) => y - x > 0.08), level: cnt ? 10 * Math.log10(sum / cnt) : null, clean: { in: cleanIn, out: cleanOut }, measured: true };
}

/** Where a moment of the source lands in the cut line (seconds from the cut's start). */
function mapper(keep) {
  const at = []; let t = 0; for (const [a, b] of keep) { at.push(t); t += b - a; }
  const total = t;
  const map = (src) => { for (let i = 0; i < keep.length; i++) { const [a, b] = keep[i]; if (src < a) return at[i]; if (src <= b) return at[i] + (src - a); } return total; };
  return { map, total, jumps: at.slice(1) };
}

const even = (n) => Math.round(n / 2) * 2;
const VOICE_TARGET = -21; // dB RMS of the speech itself, before the master

/** Cut one line: the kept pieces joined (picture and sound from the same times), the voice cleaned and set to one level. */
async function cutLine(c, keep, out, { level = null, fps = 30, first = false } = {}) {
  const scale = c.width >= c.height ? `scale=${even(Math.min(1280, c.width))}:-2` : `scale=-2:${even(Math.min(1280, c.height))}`;
  const inputs = []; const f = []; const n = keep.length;
  keep.forEach(([a, b], i) => {
    const d = b - a;
    inputs.push('-ss', a.toFixed(3), '-t', (d + 0.08).toFixed(3), '-i', c.file);
    f.push(`[${i}:v]trim=0:${d.toFixed(3)},setpts=PTS-STARTPTS,${scale},fps=${fps},setsar=1[v${i}]`);
    const fin = i === 0 ? (first ? 0.05 : 0.03) : 0.012; const fout = i === n - 1 ? 0.09 : 0.012;
    f.push(`[${i}:a]atrim=0:${d.toFixed(3)},asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,afade=t=in:d=${fin},afade=t=out:st=${Math.max(0, d - fout).toFixed(3)}:d=${fout}[a${i}]`);
  });
  f.push(`${keep.map((_, i) => `[v${i}][a${i}]`).join('')}concat=n=${n}:v=1:a=1[vc][ac]`);
  f.push('[vc]eq=contrast=1.05:saturation=1.1,unsharp=5:5:0.5:5:5:0[v]');
  const gain = level == null ? 0 : Math.max(-12, Math.min(18, VOICE_TARGET - level));
  f.push(`[ac]highpass=f=80,volume=${gain.toFixed(2)}dB,acompressor=threshold=-20dB:ratio=3:attack=5:release=60:makeup=1,equalizer=f=3000:t=q:w=1:g=2.5,alimiter=limit=0.9:level=disabled[a]`);
  const dur = keep.reduce((s, [a, b]) => s + (b - a), 0);
  await ff.ffmpegWithProgress([...inputs, '-filter_complex', f.join(';'), '-map', '[v]', '-map', '[a]', '-t', dur.toFixed(3), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16', '-pix_fmt', 'yuv420p', '-g', '15', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', out], { totalSec: dur });
  return dur;
}

/** Bring a finished mix to -14 LUFS / -1.5 dBTP: measure the whole thing, then set it (no pumping). `graph` must end in [pre]. */
async function master({ inputs, graph, video = '0:v', out, total }) {
  let m = null;
  try {
    const r = await collect([...inputs, '-filter_complex', `${graph};[pre]loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json[a]`, '-map', '[a]', '-t', total.toFixed(3), '-f', 'null', '-'], { timeoutMs: 300000 });
    const j = /\{[^{}]*"input_i"[^{}]*\}/.exec(r.err); if (j) m = JSON.parse(j[0]);
  } catch { /* single pass below */ }
  const ok = m && [m.input_i, m.input_tp, m.input_lra, m.input_thresh].every((x) => Number.isFinite(Number(x)));
  const ln = ok ? `loudnorm=I=-14:TP=-1.5:LRA=11:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true` : 'loudnorm=I=-14:TP=-1.5:LRA=11';
  await ff.ffmpegWithProgress([...inputs, '-filter_complex', `${graph};[pre]${ln},aresample=48000,alimiter=limit=0.84:level=disabled[a]`, '-map', video, '-map', '[a]', '-t', total.toFixed(3), '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', out], { totalSec: total });
  return { measured: ok ? Number(m.input_i) : null };
}

/** Measure a finished ad. Returns { ok, loudness, peak, black, gaps, duration, notes } (notes = plain-English problems). */
async function qa(file, { total = null, voiceEnd = null, cuts = null } = {}) {
  const r = await collect(['-i', file, '-filter_complex', '[0:a]ebur128=peak=true[a];[0:v]blackdetect=d=0.2:pix_th=0.08[v]', '-map', '[a]', '-map', '[v]', '-f', 'null', '-'], { timeoutMs: 300000 });
  const sum = r.err.slice(r.err.lastIndexOf('Summary:'));
  const loudness = Number((/I:\s+(-?[\d.]+) LUFS/.exec(sum) || [])[1]); const peak = Number((/Peak:\s+(-?[\d.]+) dBFS/.exec(sum) || [])[1]);
  const black = [...r.err.matchAll(/black_start:([\d.]+) black_end:([\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])]).filter(([a]) => voiceEnd == null || a < voiceEnd - 0.05); // a dark end card is not a fault
  const s = await collect(['-i', file, '-vn', '-af', 'silencedetect=noise=-48dB:d=0.7', '-f', 'null', '-'], { timeoutMs: 300000 });
  const gaps = [...s.err.matchAll(/silence_start: ([\d.]+)[\s\S]*?silence_end: ([\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])]).filter(([a]) => voiceEnd == null || a < voiceEnd - 0.3);
  const duration = Number((/Duration: (\d+):(\d+):([\d.]+)/.exec(r.err) || []).slice(1).reduce((a, x) => a * 60 + Number(x), 0)) || null;
  const notes = [];
  if (Number.isFinite(loudness) && Math.abs(loudness + 14) > 1.5) notes.push(`Loudness is ${loudness.toFixed(1)} LUFS (the target is -14).`);
  if (Number.isFinite(peak) && peak > -0.9) notes.push(`The sound peaks at ${peak.toFixed(1)} dB (should stay under -1).`);
  if (black.length) notes.push(`${black.length} black stretch${black.length === 1 ? '' : 'es'} in the picture (first at ${black[0][0].toFixed(1)} s).`);
  if (gaps.length) notes.push(`${gaps.length} stretch${gaps.length === 1 ? '' : 'es'} of dead air (first at ${gaps[0][0].toFixed(1)} s).`);
  if (total && duration && Math.abs(duration - total) > 0.4) notes.push(`The file is ${duration.toFixed(1)} s but the plan was ${total.toFixed(1)} s.`);
  if (cuts && cuts.total && cuts.clean < cuts.total) notes.push(`${cuts.total - cuts.clean} of ${cuts.total} cut points had no clear pause (cut at the quietest moment instead).`);
  return { ok: !notes.length, loudness: Number.isFinite(loudness) ? loudness : null, peak: Number.isFinite(peak) ? peak : null, black, gaps, duration, cuts, notes, at: new Date().toISOString() };
}

/** The speaker's face in a shot: { x, y, h } as fractions of the picture (centre and height), or null. */
async function faceBox(c, times, work) {
  try {
    const ft = require('../video/facetrack');
    if (!(await ft.available())) return null;
    const IW = 320; const IH = 240; const asp = c.width / c.height;
    const cw = asp >= IW / IH ? IW : IH * asp; const ch = asp >= IW / IH ? IW / asp : IH; const ox = (IW - cw) / 2; const oy = (IH - ch) / 2;
    const found = [];
    for (const t of times) {
      const still = path.join(work, `face-${Math.round(t * 100)}.jpg`);
      try {
        await ff.thumbnail(c.file, still, t, 640);
        const faces = (await ft.facesInImage(still)) || [];
        const big = faces.map((b) => ({ x: ((b.x1 + b.x2) / 2 * IW - ox) / cw, y: ((b.y1 + b.y2) / 2 * IH - oy) / ch, h: (b.y2 - b.y1) * IH / ch })).filter((b) => b.x > 0 && b.x < 1 && b.y > 0 && b.y < 1).sort((p, q) => q.h - p.h)[0];
        if (big) found.push(big);
      } catch { /* next still */ } finally { fs.rmSync(still, { force: true }); }
    }
    if (!found.length) return null;
    const med = (k) => found.map((b) => b[k]).sort((p, q) => p - q)[found.length >> 1];
    return { x: Math.max(0.12, Math.min(0.88, med('x'))), y: med('y'), h: med('h') };
  } catch { return null; }
}

module.exports = { energy, snapLine, mapper, cutLine, master, qa, faceBox, LEAD, TAIL };
