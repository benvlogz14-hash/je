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
async function exportCut({ id, start, end, crop = null, aspect = null, size = 'original', name = '', folder = '', signal, onProgress }) {
  const e = get(id); if (!e) throw new Error('Open the video again: it is no longer in the list.');
  const D = e.info.duration;
  start = Math.max(0, Math.min(D, Number(start) || 0)); end = Math.max(start + 0.1, Math.min(D, Number(end) || D));
  const outDir = folder || ctx.setting('studio.exportFolder', '') || path.join(os.homedir(), 'Videos', 'Euclidean');
  fs.mkdirSync(outDir, { recursive: true });
  const base = (String(name || '').replace(/[<>:"/\\|?*]+/g, '').trim() || `${e.name.replace(/\.[^.]+$/, '')} ${stamp(start)}-${stamp(end)}`).slice(0, 120);
  let out = path.join(outDir, `${base}.mp4`); let n = 2;
  while (fs.existsSync(out)) out = path.join(outDir, `${base} (${n++}).mp4`);
  const vf = [];
  // A picked shape (9:16, 1:1, 4:5, 16:9) comes out exactly that shape: the box is worked out in whole pixels from the
  // video's real size (rounding each side on its own gave 1080x1924 for a 9:16 cut).
  const R = { '9:16': 9 / 16, '1:1': 1, '4:5': 4 / 5, '16:9': 16 / 9 }[aspect] || null;
  const W = e.info.width, H = e.info.height; const even = (v) => Math.max(2, Math.floor(v / 2) * 2);
  let outW = W, outH = H;
  if (crop && crop.w > 0 && crop.h > 0 && (crop.w < 0.999 || crop.h < 0.999 || R)) {
    const c = { x: Math.max(0, Math.min(1, crop.x)), y: Math.max(0, Math.min(1, crop.y)), w: Math.max(0.05, Math.min(1, crop.w)), h: Math.max(0.05, Math.min(1, crop.h)) };
    let cw = c.w * W, ch = c.h * H;
    if (R) { if (cw / ch > R) cw = ch * R; else ch = cw / R; }
    if (R) {
      // Whole steps of the shape (9:16 → 18x32 pixels), so the box is exactly that shape and both sides are even.
      const [a, b2] = { '9:16': [9, 16], '1:1': [1, 1], '4:5': [4, 5], '16:9': [16, 9] }[aspect];
      const k = Math.max(1, Math.floor(Math.min(Math.min(cw, W) / (2 * a), Math.min(ch, H) / (2 * b2)))); cw = 2 * a * k; ch = 2 * b2 * k;
    } else { cw = even(Math.min(cw, W)); ch = even(Math.min(ch, H)); }
    const cx = Math.max(0, Math.min(W - cw, Math.round(c.x * W / 2) * 2)), cy = Math.max(0, Math.min(H - ch, Math.round(c.y * H / 2) * 2));
    vf.push(`crop=${cw}:${ch}:${cx}:${cy}`); outW = cw; outH = ch;
  }
  if (size === '1080' || size === '720') {
    const s = Number(size); const short = Math.min(outW, outH);
    if (short > s || R) {
      // Exact sizes for the picked shapes (1080x1920, 1080x1350, 1080x1080, 1920x1080), else short side to the size.
      const sw = R ? (R < 1 ? s : Math.round((s * R) / 2) * 2) : outW < outH ? s : even((outW * s) / outH);
      const sh = R ? (R < 1 ? Math.round(s / R / 2) * 2 : s) : outW < outH ? even((outH * s) / outW) : s;
      vf.push(`scale=${sw}:${sh}`);
    }
  }
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
  try { fs.unlinkSync(path.join(dir(), 'tx', `qc_${e.id}.transcript.json`)); } catch { /* none */ }
  save(list().filter((x) => x.id !== id));
}


// ------------------------------------------------------------------ the searchable transcript
const txDir = () => { const d = path.join(dir(), 'tx'); fs.mkdirSync(d, { recursive: true }); return d; };
/** The file as an "asset" for the speech-to-text step (its own folder, never mixed with Production's). */
const asAsset = (e) => ({ id: `qc_${e.id}`, workDir: txDir(), path: e.path, name: e.name, info: e.info, clientId: null });
const txFile = (e) => path.join(txDir(), `qc_${e.id}.transcript.json`);

/** Transcribe the whole video (fast mode: rough word times are plenty for searching). Run as a job. */
async function transcribe(id, { jobId, onProgress } = {}) {
  const e = get(id); if (!e) return null;
  if (!e.info.hasAudio) { update(id, { tx: { status: 'none', note: 'This video has no sound.' } }); return null; }
  update(id, { tx: { status: 'working', at: new Date().toISOString() } });
  // No speech-to-text on this PC yet: install the free Whisper first (like Production's transcribe), instead of failing.
  try {
    const ai = require('../integrations/ai'); const wh = require('../setup/whisper');
    if (!ai.connected('openai') && !wh.status().ready) await wh.install({ progress: (f, t) => onProgress?.(f * 0.2, `Installing free speech-to-text (one time): ${t || ''}`) });
  } catch { /* the transcribe step below says what's missing */ }
  try {
    const t = await require('./intelligence').transcribe(asAsset(e), { jobId, fast: true, onProgress });
    update(id, { tx: { status: 'ready', words: (t.words || []).length, at: new Date().toISOString() } });
    return t;
  } catch (err) { update(id, { tx: { status: 'failed', note: String(err.message || err).slice(0, 200) } }); throw err; }
}

/**
 * The transcript in paragraphs for reading and searching: a new paragraph after a pause of 1.2 s+, or at a sentence
 * end once a paragraph is 12 s+ long, or at 25 s. Words go out as [text, start] pairs (small, even for 2.5 hours).
 */
function transcript(id) {
  const e = get(id); if (!e) return null;
  let t = null; try { t = JSON.parse(fs.readFileSync(txFile(e), 'utf8')); } catch { /* not yet */ }
  if (!t?.words?.length) return { status: e.tx?.status || 'none', note: e.tx?.note || null, paras: [] };
  const paras = []; let cur = null;
  t.words.forEach((w, i) => {
    const prev = t.words[i - 1];
    const brk = !cur || w.s - prev.e > 1.2 || (w.s - cur.s > 12 && /[.!?]["']?$/.test(prev.w)) || w.s - cur.s > 25;
    if (brk) { cur = { s: w.s, e: w.e, w: [] }; paras.push(cur); }
    cur.w.push([w.w, Math.round(w.s * 100) / 100]); cur.e = w.e;
  });
  return { status: 'ready', paras, words: t.words.length };
}

// ------------------------------------------------------------------ YouTube (or any yt-dlp) links
/** Download a video from a link (up to 1080p, mp4) into the Quick cut folder, with progress. Returns the file. */
async function download(url, { onProgress, signal } = {}) {
  if (!/^https?:\/\/\S+$/i.test(url)) throw new Error('Paste a full link, like https://www.youtube.com/watch?v=...');
  if (!ctx.capabilities.ytdlp) { await ff.detect().catch(() => {}); if (!ctx.capabilities.ytdlp) throw new Error("The YouTube downloader (yt-dlp) isn't installed yet. Open Production and press the fix button for FFmpeg and yt-dlp, then try again."); }
  const d = path.join(dir(), 'links'); fs.mkdirSync(d, { recursive: true });
  const key = crypto.createHash('sha1').update(url.replace(/[&?](si|feature|pp|t)=[^&]*/g, '')).digest('hex').slice(0, 12);
  const had = fs.readdirSync(d).find((f) => f.includes(`[${key}]`) && /\.(mp4|mkv|webm)$/i.test(f)); if (had) return path.join(d, had);
  const ffb = ff.bin('ffmpeg');
  const args = ['-f', 'bv*[height<=1080][ext=mp4]+ba[ext=m4a]/b[height<=1080][ext=mp4]/bv*[height<=1080]+ba/b', '--merge-output-format', 'mp4', '--no-playlist', '--newline',
    ...(path.isAbsolute(ffb) ? ['--ffmpeg-location', path.dirname(ffb)] : []), '-o', path.join(d, `%(title).80B [${key}].%(ext)s`), '--print', 'after_move:%(filepath)s', '--', url];
  let got = ''; let part = 0;
  try {
    const r = await run(ff.ytdlpBin(), args, { signal, timeoutMs: 6 * 3600000, onLine: (l) => {
      const m = /\[download\]\s+([\d.]+)%/.exec(l); if (m && onProgress) { const v = Number(m[1]) / 100; if (v < part - 0.5) part = 0; part = v; onProgress(v, 'Downloading'); }
      if (/^\[Merger\]/.test(l) && onProgress) onProgress(0.99, 'Putting the picture and sound together');
    } });
    got = String(r.out || '').trim().split('\n').filter((x) => x && fs.existsSync(x.trim())).pop()?.trim() || '';
  } catch (e) { throw new Error(`Couldn't download that link. Check it opens in a browser and isn't private. (${String(e.message || e).split('\n').pop().slice(0, 160)})`); }
  if (!got) got = (fs.readdirSync(d).filter((f) => f.includes(`[${key}]`) && /\.(mp4|mkv|webm)$/i.test(f)).map((f) => path.join(d, f)))[0] || '';
  if (!got) throw new Error("Couldn't download that link.");
  return got;
}

module.exports = { list, get, open, makeProxy, strip, wave, exportCut, forget, allowed, dir, transcribe, transcript, download };
