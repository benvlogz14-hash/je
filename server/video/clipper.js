'use strict';
/**
 * Quick cut: open any video (a big one for a video essay), pick a stretch with two handles, crop it, export. No
 * timeline, no tracks. Separate from the clip machine: nothing here changes how clips are picked or rendered.
 *
 * Opened files are remembered in settings._clipper (newest first). Each gets a filmstrip (keyframes only, fast on
 * hour-long files), a waveform, and, when the player can't play it smoothly (HEVC phone footage, ProRes, 4K), a light
 * H.264 preview copy. Exports always come from the original file.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const ctx = require('../core/ctx');
const paths = require('../core/paths');
const { run } = require('../core/util');
const ff = require('./ffmpeg');
const proxy = require('./proxy');

const KEEP = 30;
const list = () => ctx.store.settings._clipper || [];
const save = (l) => { ctx.store.settings._clipper = l.slice(0, KEEP); ctx.store.touch(); };
const dir = () => { const d = path.join(paths.root, 'clipper'); fs.mkdirSync(d, { recursive: true }); return d; };
const keyOf = (file) => { let st = { size: 0, mtimeMs: 0 }; try { st = fs.statSync(file); } catch { /* gone */ } return crypto.createHash('md5').update(`${file}|${st.size}|${st.mtimeMs}`).digest('hex').slice(0, 16); };

function get(id) { return list().find((x) => x.id === id) || null; }
function update(id, patch) { save(list().map((x) => (x.id === id ? { ...x, ...patch } : x))); }
/** Every path the player may load (originals and their preview copies). */
function allowed(file) { return list().some((x) => x.path === file || x.proxy === file); }

/** Open a file: probe it, remember it, and start its filmstrip, waveform and (if needed) preview copy. */
async function open(file, { uploaded = false } = {}) {
  if (!file || !fs.existsSync(file)) throw new Error('That file is gone.');
  const info = await ff.probe(file);
  if (!info.hasVideo || !info.duration) throw new Error(`${path.basename(file)} isn't a video FFmpeg can read.`);
  const id = keyOf(file);
  const prev = get(id);
  const entry = { ...(prev || {}), id, path: file, name: path.basename(file), uploaded: prev?.uploaded || uploaded, openedAt: new Date().toISOString(),
    info: { duration: info.duration, width: info.width, height: info.height, fps: info.fps, hasAudio: info.hasAudio, vcodec: info.vcodec } };
  // A light 720p copy with frequent keyframes makes scrubbing smooth on long videos; until it's ready the original plays
  // (when the player can play it: H.264/VP9 up to 2.5K; phone HEVC, ProRes and 4K wait for the copy).
  const pp = proxy.proxyPath(file);
  entry.playable = !proxy.needsProxy(file, info);
  entry.proxy = fs.existsSync(pp) ? pp : null; entry.proxyPending = !entry.proxy;
  save([entry, ...list().filter((x) => x.id !== id)]);
  return entry;
}

/** The light preview copy for a file the player can't handle (run as a job, with progress). */
async function makeProxy(id, onProgress) {
  const e = get(id); if (!e) return null;
  const out = proxy.proxyPath(e.path); if (fs.existsSync(out)) { update(id, { proxy: out, proxyPending: false }); return out; }
  const tmp = out.replace(/\.mp4$/, '.part.mp4');
  await ff.ffmpegWithProgress(['-y', '-i', e.path, '-map', '0:v:0', '-map', '0:a:0?', '-vf', "scale='if(gt(iw,ih),-2,min(720,iw))':'if(gt(iw,ih),min(720,ih),-2)'", '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-pix_fmt', 'yuv420p', '-g', '15', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', tmp], { totalSec: e.info.duration, onProgress });
  fs.renameSync(tmp, out); update(id, { proxy: out, proxyPending: false });
  return out;
}

/** Filmstrip image (one row of frames across the whole video) for the ruler. */
async function strip(id) {
  const e = get(id); if (!e) return null;
  const out = path.join(paths.tmp('clipper'), `${id}.strip.jpg`);
  if (!fs.existsSync(out)) { fs.mkdirSync(path.dirname(out), { recursive: true }); await ff.filmstrip(e.path, out, e.info.duration, 60, 90); }
  return out;
}
/** Waveform (1,200 points, 0-1) for the ruler. */
async function wave(id) {
  const e = get(id); if (!e) return [];
  const out = path.join(paths.tmp('clipper'), `${id}.wave.json`);
  try { return JSON.parse(fs.readFileSync(out, 'utf8')); } catch { /* measure */ }
  if (!e.info.hasAudio) return [];
  const w = await ff.waveform(e.path, 1200); try { fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, JSON.stringify(w)); } catch { /* fine */ }
  return w;
}

const stamp = (s) => { const m = Math.floor(s / 60); const r = Math.floor(s % 60); return `${m}.${String(r).padStart(2, '0')}`; };

/**
 * Export the stretch [start, end] (seconds), cropped to crop = { x, y, w, h } (0-1 of the frame) if given, optionally
 * scaled (size: 'original' | '1080' (the short side to 1080) | '720'). Frame-accurate (re-encoded from the original).
 */
async function exportCut({ id, start, end, crop = null, size = 'original', name = '', folder = '', signal, onProgress }) {
  const e = get(id); if (!e) throw new Error('Open the video again: it is no longer in the list.');
  const D = e.info.duration;
  start = Math.max(0, Math.min(D, Number(start) || 0)); end = Math.max(start + 0.1, Math.min(D, Number(end) || D));
  const outDir = folder || ctx.setting('studio.exportFolder', '') || path.join(os.homedir(), 'Videos', 'Euclidean');
  fs.mkdirSync(outDir, { recursive: true });
  const base = (String(name || '').replace(/[<>:"/\\|?*]+/g, '').trim() || `${e.name.replace(/\.[^.]+$/, '')} ${stamp(start)}-${stamp(end)}`).slice(0, 120);
  let out = path.join(outDir, `${base}.mp4`); let n = 2;
  while (fs.existsSync(out)) out = path.join(outDir, `${base} (${n++}).mp4`);
  const vf = [];
  if (crop && crop.w > 0 && crop.h > 0 && (crop.w < 0.999 || crop.h < 0.999)) {
    const c = { x: Math.max(0, Math.min(1, crop.x)), y: Math.max(0, Math.min(1, crop.y)), w: Math.max(0.05, Math.min(1, crop.w)), h: Math.max(0.05, Math.min(1, crop.h)) };
    vf.push(`crop=trunc(iw*${c.w.toFixed(5)}/2)*2:trunc(ih*${c.h.toFixed(5)}/2)*2:trunc(iw*${c.x.toFixed(5)}/2)*2:trunc(ih*${c.y.toFixed(5)}/2)*2`);
  }
  if (size === '1080' || size === '720') { const s = Number(size); vf.push(`scale='if(lt(iw,ih),${s},-2)':'if(lt(iw,ih),-2,${s})'`); }
  vf.push('format=yuv420p');
  const enc = await ff.pickEncoder();
  const args = ['-y', '-ss', start.toFixed(3), '-i', e.path, '-t', (end - start).toFixed(3), '-map', '0:v:0', '-map', '0:a:0?', '-vf', vf.join(','), ...ff.encoderArgs(enc, 18), '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', out];
  await ff.ffmpegWithProgress(args, { totalSec: end - start, onProgress, signal });
  return { path: out, seconds: Math.round((end - start) * 10) / 10 };
}

/** Forget a file (an uploaded copy is deleted; a file opened from your disk is left where it is). */
function forget(id) {
  const e = get(id); if (!e) return;
  if (e.uploaded && e.path.startsWith(dir())) { try { fs.unlinkSync(e.path); } catch { /* gone */ } }
  save(list().filter((x) => x.id !== id));
}

module.exports = { list, get, open, makeProxy, strip, wave, exportCut, forget, allowed, dir };
