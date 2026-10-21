'use strict';
/**
 * Automatic face tracking for vertical reframing.
 * Samples frames with FFmpeg, detects faces with UltraFace (MIT, 1.2 MB) running
 * on onnxruntime-web (pure WebAssembly, no native build), follows the primary
 * speaker, and turns the detections into a smoothed "virtual camera" path:
 * small movements are ignored, pans are eased and speed-limited so the crop
 * never jitters. The renderer turns the path into an FFmpeg crop expression.
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const ff = require('./ffmpeg');

const MODEL = path.join(__dirname, 'models', 'ultraface-rfb-320.onnx');
const IW = 320, IH = 240;
let session = null; let ort = null; let loadError = null;

async function load() {
  if (session || loadError) return session;
  try {
    if (!fs.existsSync(MODEL)) throw new Error('Face model file is missing');
    ort = require('onnxruntime-web');
    ort.env.logLevel = 'error';
    ort.env.wasm.numThreads = 1;
    session = await ort.InferenceSession.create(MODEL, { logSeverityLevel: 3 });
  } catch (e) { loadError = e; session = null; }
  return session;
}
async function available() { return !!(await load()); }

/** Stream letterboxed 320×240 RGB frames at `fps` for [start, end). */
function frames(file, start, end, fps, onFrame) {
  return new Promise((resolve, reject) => {
    const args = ['-hide_banner', '-loglevel', 'error', '-ss', String(start), '-t', String(end - start), '-i', file, '-an',
      '-vf', `fps=${fps},scale=${IW}:${IH}:force_original_aspect_ratio=decrease,pad=${IW}:${IH}:(ow-iw)/2:(oh-ih)/2`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'];
    const p = spawn(ff.bin('ffmpeg'), args, { windowsHide: true });
    try { require('os').setPriority(p.pid, ff.priorityValue()); } catch { /* ignore */ }
    const size = IW * IH * 3; let buf = Buffer.alloc(0); let idx = 0; let chain = Promise.resolve();
    p.stdout.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= size) { const f = buf.subarray(0, size); buf = buf.subarray(size); const i = idx++; chain = chain.then(() => onFrame(Buffer.from(f), start + i / fps)); }
    });
    p.on('error', reject);
    p.on('close', (code) => chain.then(() => (code === 0 ? resolve(idx) : reject(new Error(`ffmpeg exited ${code}`)))));
  });
}

function iou(a, b) {
  const x1 = Math.max(a[0], b[0]), y1 = Math.max(a[1], b[1]), x2 = Math.min(a[2], b[2]), y2 = Math.min(a[3], b[3]);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  return inter / ((a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter || 1);
}

async function detect(rgb) {
  const f = new Float32Array(3 * IW * IH); const n = IW * IH;
  for (let i = 0; i < n; i++) { f[i] = (rgb[i * 3] - 127) / 128; f[n + i] = (rgb[i * 3 + 1] - 127) / 128; f[2 * n + i] = (rgb[i * 3 + 2] - 127) / 128; }
  const out = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', f, [1, 3, IH, IW]) });
  const scores = out.scores.data, boxes = out.boxes.data;
  const cand = [];
  for (let i = 0; i < scores.length / 2; i++) { const s = scores[i * 2 + 1]; if (s > 0.75) cand.push([boxes[i * 4], boxes[i * 4 + 1], boxes[i * 4 + 2], boxes[i * 4 + 3], s]); }
  cand.sort((a, b) => b[4] - a[4]);
  const keep = [];
  for (const c of cand) if (!keep.some((k) => iou(k, c) > 0.35)) keep.push(c);
  return keep.slice(0, 6);
}

/**
 * Track the primary face in [start, end) of a file.
 * @returns {{ path: [{t, x}], coverage: number }}  t = source seconds, x = face centre as a fraction of source width
 */
async function track(file, info, start, end, { fps = 3 } = {}) {
  if (!(await load())) throw Object.assign(new Error(`Face tracking unavailable: ${loadError?.message || 'model failed to load'}`), { notConnected: true });
  const srcAspect = info.width / info.height; // letterbox geometry inside 320×240
  const contentW = srcAspect >= IW / IH ? IW : IH * srcAspect, contentH = srcAspect >= IW / IH ? IW / srcAspect : IH;
  const offX = (IW - contentW) / 2, offY = (IH - contentH) / 2;
  const samples = []; let prev = null;
  await frames(file, start, end, fps, async (rgb, t) => {
    const faces = (await detect(rgb)).map((b) => {
      const cx = ((b[0] + b[2]) / 2 * IW - offX) / contentW; const w = (b[2] - b[0]) * IW / contentW; const h = (b[3] - b[1]) * IH / contentH;
      return { cx, w, area: w * h, s: b[4] };
    }).filter((f) => f.cx > -0.05 && f.cx < 1.05);
    if (!faces.length) { samples.push({ t, x: null }); return; }
    // Primary speaker: biggest face, with a strong preference for staying on the same person.
    const pick = faces.reduce((best, f) => { const score = f.area * (prev == null ? 1 : Math.max(0.25, 1 - Math.abs(f.cx - prev) * 2.5)); return score > best.score ? { f, score } : best; }, { f: null, score: -1 }).f;
    prev = pick.cx; samples.push({ t, x: Math.min(1, Math.max(0, pick.cx)) });
  });
  const coverage = samples.filter((s) => s.x != null).length / Math.max(1, samples.length);
  return { path: smooth(samples), coverage, samples: samples.length };
}

/** Virtual camera: hold through gaps, ignore small moves, ease and rate-limit pans. */
function smooth(samples, { deadzone = 0.07, maxSpeed = 0.35 } = {}) {
  if (!samples.length) return [];
  const firstX = samples.find((s) => s.x != null)?.x ?? 0.5;
  // Fill gaps with the last known position (or the first seen one).
  let last = firstX; const filled = samples.map((s) => { if (s.x != null) last = s.x; return { t: s.t, x: last }; });
  // Median filter (5) to remove single-frame mis-detections.
  const med = filled.map((s, i) => { const w = filled.slice(Math.max(0, i - 2), i + 3).map((x) => x.x).sort((a, b) => a - b); return { t: s.t, x: w[Math.floor(w.length / 2)] }; });
  const out = [{ t: med[0].t, x: med[0].x }]; let cam = med[0].x;
  for (let i = 1; i < med.length; i++) {
    const dt = med[i].t - med[i - 1].t; const target = med[i].x;
    if (Math.abs(target - cam) > deadzone) {
      const step = Math.sign(target - cam) * Math.min(Math.abs(target - cam), maxSpeed * dt);
      cam += step;
    }
    out.push({ t: med[i].t, x: cam });
  }
  // Keep only points where the camera moves, so the FFmpeg expression stays small.
  const key = [out[0]];
  for (let i = 1; i < out.length - 1; i++) {
    const a = key[key.length - 1], b = out[i], c = out[i + 1];
    const lin = a.x + (c.x - a.x) * ((b.t - a.t) / (c.t - a.t || 1));
    if (Math.abs(lin - b.x) > 0.004) key.push(b);
  }
  if (out.length > 1) key.push(out[out.length - 1]);
  return key.map((k) => ({ t: Math.round(k.t * 100) / 100, x: Math.round(k.x * 1000) / 1000 }));
}

/**
 * Build a piecewise-linear FFmpeg expression for the crop x offset.
 * @param pathPts [{t,x}] with t already in the output timeline, x = 0..1 face centre in source
 * @param scaledW width of the scaled source frame, cropW output crop width
 */
function cropExpr(pathPts, scaledW, cropW) {
  const off = (x) => Math.max(0, Math.min(scaledW - cropW, x * scaledW - cropW / 2)).toFixed(1);
  if (!pathPts.length) return String(Math.round((scaledW - cropW) / 2));
  if (pathPts.length === 1) return off(pathPts[0].x);
  const pts = pathPts.slice(0, 120);
  let expr = off(pts[pts.length - 1].x);
  for (let i = pts.length - 2; i >= 0; i--) {
    const a = pts[i], b = pts[i + 1]; const xa = off(a.x), xb = off(b.x);
    const seg = xa === xb ? xa : `${xa}+(${xb}-${xa})*(t-${a.t.toFixed(2)})/${Math.max(0.01, b.t - a.t).toFixed(2)}`;
    expr = `if(lt(t\\,${b.t.toFixed(2)})\\,${seg}\\,${expr})`;
  }
  return expr;
}

/** Faces in a still image: [{x1,y1,x2,y2,score}] as fractions of the frame (letterboxed to 4:3). Empty if the model can't load. */
async function facesInImage(file) {
  if (!(await load())) return null;
  const found = [];
  await frames(file, 0, 1, 1, async (rgb) => { if (!found.length) for (const b of await detect(rgb)) found.push({ x1: b[0], y1: b[1], x2: b[2], y2: b[3], score: b[4] }); });
  return found;
}

module.exports = { track, smooth, cropExpr, available, load, facesInImage };
