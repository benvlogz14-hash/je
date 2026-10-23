'use strict';
/**
 * Look through a video: FFmpeg splits it into shots (scene cuts, long takes
 * split every ~10s), grabs a still from the middle of each shot, measures
 * brightness, sharpness and motion, counts faces, and (when an AI that can see
 * pictures is connected) describes every shot: what's in it, what kind of shot
 * it is, and how usable it is.
 *
 * The shot list feeds clip discovery, B-roll picking for the speech ads and
 * anything else that needs to know what's on screen. Cached per file.
 */
const fs = require('fs');
const path = require('path');
const ff = require('./ffmpeg');
const ai = require('../integrations/ai');
const { run } = require('../core/util');

const KINDS = ['speaker', 'interview', 'crowd', 'aerial', 'broll', 'graphic', 'text', 'other'];

/** Shot boundaries from FFmpeg's scene detection, with long takes split and tiny shots merged. */
async function shotList(file, duration, { maxShots = 48, signal } = {}) {
  const r = await run(ff.bin('ffmpeg'), ['-hide_banner', '-nostats', '-i', file, '-an', '-vf', "fps=5,scale=256:-2,select='gt(scene\\,0.3)',showinfo", '-f', 'null', '-'], { timeoutMs: 4 * 3600000, priority: ff.priorityValue(), signal });
  const cuts = [...String(r.err).matchAll(/pts_time:([\d.]+)/g)].map((m) => Number(m[1])).filter((t) => t > 0.5 && t < duration - 0.5);
  let shots = []; let prev = 0;
  for (const t of [...cuts, duration]) { if (t - prev >= 1) { shots.push({ s: prev, e: t }); prev = t; } else if (shots.length) shots[shots.length - 1].e = t; else prev = 0; }
  if (!shots.length) shots = [{ s: 0, e: duration }];
  shots = shots.flatMap((x) => { const n = Math.ceil((x.e - x.s) / 12); return Array.from({ length: n }, (_, i) => ({ s: x.s + ((x.e - x.s) * i) / n, e: x.s + ((x.e - x.s) * (i + 1)) / n })); });
  if (shots.length > maxShots) { const step = shots.length / maxShots; shots = Array.from({ length: maxShots }, (_, i) => shots[Math.floor(i * step)]); }
  return shots.map((x) => ({ s: Math.round(x.s * 100) / 100, e: Math.round(x.e * 100) / 100 }));
}

/** Brightness (0-255), sharpness and motion for one shot, measured by FFmpeg. */
async function measure(file, shot) {
  const len = Math.min(2, shot.e - shot.s); const at = shot.s + (shot.e - shot.s - len) / 2;
  try {
    const r = await run(ff.bin('ffmpeg'), ['-hide_banner', '-nostats', '-ss', at.toFixed(2), '-t', len.toFixed(2), '-i', file, '-an', '-vf', 'fps=4,scale=320:-2,signalstats,metadata=print', '-f', 'null', '-'], { timeoutMs: 120000 });
    const y = [...r.err.matchAll(/lavfi\.signalstats\.YAVG=([\d.]+)/g)].map((m) => Number(m[1]));
    const d = [...r.err.matchAll(/lavfi\.signalstats\.YDIF=([\d.]+)/g)].map((m) => Number(m[1]));
    const avg = (a) => (a.length ? a.reduce((x, z) => x + z, 0) / a.length : 0);
    return { bright: Math.round(avg(y)), motion: Math.round(avg(d.slice(1)) * 10) / 10 };
  } catch { return { bright: null, motion: null }; }
}

async function sharpness(frame) {
  try {
    // Edge energy: a blurry frame has little left after edge detection.
    const r = await run(ff.bin('ffmpeg'), ['-hide_banner', '-nostats', '-i', frame, '-vf', 'edgedetect=low=0.1:high=0.3,signalstats,metadata=print', '-f', 'null', '-'], { timeoutMs: 30000 });
    const m = /YAVG=([\d.]+)/.exec(r.err); return m ? Math.round(Number(m[1]) * 10) / 10 : null;
  } catch { return null; }
}

function cacheKey(file) { const st = fs.statSync(file); return `${st.size}:${Math.round(st.mtimeMs)}`; }

/**
 * Look through a video file. Returns { duration, engine, shots: [{ s, e, frame, faces, bright, motion, sharp, kind, what, quality, usable }] }.
 */
async function look(file, { workDir, maxShots = 0, onProgress = () => {}, signal, jobId, clientId, purpose = '' } = {}) {
  workDir = workDir || path.dirname(file);
  const base = path.join(workDir, `${path.basename(file).replace(/\.[^.]+$/, '')}.vision`);
  const cacheFile = `${base}.json`;
  try { const c = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); if (c.key === cacheKey(file) && (c.engine !== 'measured' || !ai.canSee())) return c; } catch { /* look again */ }
  const info = await ff.probe(file);
  if (!info.hasVideo || !info.duration) return { duration: info.duration || 0, shots: [], engine: 'none' };
  if (!maxShots) maxShots = Math.max(48, Math.min(120, Math.round(info.duration / 18))); // long videos get more shots logged
  onProgress(0.05, 'Finding the shots');
  const shots = await shotList(file, info.duration, { maxShots, signal });
  const dir = `${base}_frames`; fs.mkdirSync(dir, { recursive: true });
  let faceMod = null; try { const ft = require('./facetrack'); if (await ft.available()) faceMod = ft; } catch { /* no faces */ }
  for (let i = 0; i < shots.length; i++) {
    const x = shots[i]; x.frame = path.join(dir, `shot${i + 1}.jpg`);
    await run(ff.bin('ffmpeg'), ['-hide_banner', '-y', '-ss', ((x.s + x.e) / 2).toFixed(2), '-i', file, '-frames:v', '1', '-vf', 'scale=512:-2', '-q:v', '4', x.frame], { timeoutMs: 60000 }).catch(() => {});
    Object.assign(x, await measure(file, x));
    if (fs.existsSync(x.frame)) {
      x.sharp = await sharpness(x.frame);
      if (faceMod) { const f = await faceMod.facesInImage(x.frame); x.faces = f ? f.length : null; x.faceSize = f?.length ? Math.round(Math.max(...f.map((b) => (b.x2 - b.x1) * (b.y2 - b.y1))) * 100) / 100 : 0; }
    }
    onProgress(0.05 + 0.5 * ((i + 1) / shots.length), `Looking at shot ${i + 1} of ${shots.length}`);
  }
  let engine = 'measured';
  if (ai.canSee()) {
    for (let i = 0; i < shots.length; i += 10) {
      const batch = shots.slice(i, i + 10).filter((x) => fs.existsSync(x.frame || ''));
      if (!batch.length) continue;
      onProgress(0.55 + 0.4 * (i / shots.length), 'Describing what is on screen');
      try {
        const r = await ai.ask({ role: 'analysis', json: true, maxTokens: 1800, jobId, clientId, images: batch.map((x) => x.frame),
          system: 'You are a video editor logging footage. Describe each still plainly and briefly. Never guess names of people unless their name is written on screen.',
          prompt: `${purpose ? `Purpose: ${purpose}\n` : ''}These ${batch.length} images are stills from consecutive shots of one video, in order: ${batch.map((x, k) => `image ${k + 1} = shot at ${x.s.toFixed(1)}-${x.e.toFixed(1)}s`).join('; ')}.\nReturn JSON: {"shots":[{"image":1,"what":"under 15 words: who/what is visible and where","kind":"one of ${KINDS.join(', ')} (speaker = one person talking to camera or crowd; aerial = drone or aerial view from above; broll = scenery, places, activity, details with no one talking)","text":"any words written on screen, else empty","quality":1-5 (5 = sharp, well lit, well framed),"usable":true or false (false for black frames, blur, logos, ads, screens of other videos)}]}` });
        for (const y of r.json?.shots || []) {
          const x = batch[Number(y.image) - 1]; if (!x) continue;
          x.what = String(y.what || '').slice(0, 120); x.kind = KINDS.includes(y.kind) ? y.kind : 'other'; x.text = String(y.text || '').slice(0, 120);
          x.quality = Math.max(1, Math.min(5, Number(y.quality) || 3)); x.usable = y.usable !== false;
        }
        engine = `${r.provider}:${r.model}`;
      } catch { /* keep the measured guesses */ }
    }
  }
  // Without a picture-reading AI (or for shots it skipped): a guess from faces, sharpness and brightness.
  for (const x of shots) {
    if (!x.kind) x.kind = x.faces === 1 && x.faceSize > 0.04 ? 'speaker' : x.faces > 2 ? 'crowd' : x.faces === 0 ? 'broll' : 'other';
    if (!x.quality) x.quality = x.bright != null && (x.bright < 35 || x.bright > 235) ? 1 : x.sharp != null && x.sharp < 2 ? 2 : 3;
    if (x.usable == null) x.usable = x.quality >= 2;
  }
  const out = { key: cacheKey(file), duration: info.duration, engine, at: new Date().toISOString(), shots };
  fs.writeFileSync(cacheFile, JSON.stringify(out));
  onProgress(1, 'Done looking');
  return out;
}

/** The saved shot list for a file, if it has been looked through (never starts a new look). */
function cached(file, workDir) {
  const f = path.join(workDir || path.dirname(file), `${path.basename(file).replace(/\.[^.]+$/, '')}.vision.json`);
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; }
}

/** Shot list as prompt lines. */
function summarize(v, { max = 60 } = {}) {
  if (!v?.shots?.length) return '';
  return `WHAT'S ON SCREEN (shot list${v.engine && v.engine !== 'measured' ? '' : ', estimated from faces and image quality'}):\n${v.shots.slice(0, max).map((x) => `[${x.s.toFixed(1)}-${x.e.toFixed(1)}] ${x.kind}${x.what ? `: ${x.what}` : ''}${x.text ? ` (on-screen text: "${x.text}")` : ''} q${x.quality}${x.usable ? '' : ' UNUSABLE'}`).join('\n')}`;
}

/** The shot covering time t. */
function shotAt(v, t) { return (v?.shots || []).find((x) => t >= x.s && t < x.e) || null; }

module.exports = { cached, look, summarize, shotAt, shotList, KINDS };
