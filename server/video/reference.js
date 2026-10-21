'use strict';
/**
 * Study a reference reel/ad: download it (yt-dlp) or read a local file, find
 * every cut with FFmpeg's scene detection, and build a contact sheet. The
 * pacing (seconds per shot) is then used for the ads Euclidean makes.
 * Idea from reel-room by Eli Colussi (MIT); this is an FFmpeg implementation.
 */
const fs = require('fs');
const path = require('path');
const ff = require('./ffmpeg');
const { run } = require('../core/util');

async function fetchSource(src, dir) {
  fs.mkdirSync(dir, { recursive: true });
  if (fs.existsSync(src)) return src;
  if (!/^https?:\/\//i.test(src)) throw new Error('Paste a video link (YouTube, TikTok, Instagram, X) or choose a file.');
  const out = path.join(dir, 'reference.mp4');
  try { fs.unlinkSync(out); } catch { /* none */ }
  await run(ff.ytdlpBin(), ['-f', 'bv*[height<=720][ext=mp4]+ba[ext=m4a]/b[height<=720]/b', '--merge-output-format', 'mp4', '--max-filesize', '200M', '--no-playlist', '-o', out, '--', src], { timeoutMs: 600000 });
  if (!fs.existsSync(out)) throw new Error("Couldn't download that video.");
  return out;
}

async function analyze(src, dir, onStep = () => {}) {
  onStep('Getting the video');
  const file = await fetchSource(src, dir);
  const info = await ff.probe(file);
  const duration = Math.min(info.duration || 0, 600);
  if (!duration) throw new Error("Couldn't read that video.");
  onStep('Finding the cuts');
  const r = await run(ff.bin('ffmpeg'), ['-hide_banner', '-t', String(duration), '-i', file, '-an', '-vf', "scale=320:-2,select='gt(scene,0.3)',showinfo", '-f', 'null', '-'], { timeoutMs: 600000 });
  const cuts = [...String(r.err).matchAll(/pts_time:([\d.]+)/g)].map((m) => Number(m[1])).filter((t, i, a) => i === 0 || t - a[i - 1] > 0.25);
  const shots = cuts.length + 1;
  onStep('Making a contact sheet');
  const sheet = path.join(dir, 'reference-sheet.jpg');
  await run(ff.bin('ffmpeg'), ['-hide_banner', '-y', '-i', file, '-vf', `fps=12/${duration.toFixed(2)},scale=320:-2,tile=4x3:padding=6:color=white`, '-frames:v', '1', sheet], { timeoutMs: 300000 }).catch(() => {});
  return {
    src, duration: Math.round(duration * 10) / 10, cuts: cuts.length, avgShot: Math.round((duration / shots) * 100) / 100,
    cutsPerMinute: Math.round((cuts.length / duration) * 600) / 10, sheet: fs.existsSync(sheet) ? sheet : null, vertical: (info.height || 0) > (info.width || 0), at: new Date().toISOString(),
  };
}

module.exports = { analyze };
