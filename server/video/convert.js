'use strict';
/**
 * The compression engine: turn any video into another format, a smaller size, or a file under a size limit
 * (e.g. under 20 MB for an upload). Used by Studio's Export (format, quality, size), the "Compress a video" tool
 * (SEO lab page and the job `video.convert`), and Claude through the connector.
 *
 * Formats: video MP4, MOV, WebM, MKV, MTS (AVCHD-style MPEG-TS), AVI, M4V, WMV, FLV, 3GP, GIF, MP4 (HEVC/H.265);
 * sound only MP3, M4A, WAV, FLAC, OGG. Quality: high / balanced / small, or a target size in MB (the bitrate is worked
 * out from the length, the size picked to suit it, and the file re-made 15% smaller if it still came out too big).
 */
const fs = require('fs');
const path = require('path');
const ff = require('./ffmpeg');

const H264 = (crf) => ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(crf), '-pix_fmt', 'yuv420p'];
const FORMATS = {
  mp4: { label: 'MP4 (H.264)', ext: 'mp4', kind: 'video', about: 'Plays everywhere: phones, TikTok, YouTube, Instagram.', v: H264, a: ['-c:a', 'aac'], extra: ['-movflags', '+faststart'] },
  mov: { label: 'MOV (QuickTime)', ext: 'mov', kind: 'video', about: 'Apple, Final Cut, Premiere.', v: H264, a: ['-c:a', 'aac'], extra: ['-movflags', '+faststart'] },
  webm: { label: 'WebM (VP9)', ext: 'webm', kind: 'video', about: 'Web pages and browsers; small files.', v: (crf) => ['-c:v', 'libvpx-vp9', '-crf', String(crf + 12), '-b:v', '0', '-row-mt', '1', '-deadline', 'good', '-cpu-used', '4', '-pix_fmt', 'yuv420p'], a: ['-c:a', 'libopus'], rate: (k) => ['-c:v', 'libvpx-vp9', '-b:v', `${k}k`, '-row-mt', '1', '-deadline', 'good', '-cpu-used', '4', '-pix_fmt', 'yuv420p'] },
  mkv: { label: 'MKV (Matroska)', ext: 'mkv', kind: 'video', about: 'Keeps everything; good for archiving.', v: H264, a: ['-c:a', 'aac'] },
  mts: { label: 'MTS (AVCHD / MPEG-TS)', ext: 'mts', kind: 'video', about: 'Camcorder format; broadcast tools.', v: H264, a: ['-c:a', 'ac3'], extra: ['-f', 'mpegts'] },
  avi: { label: 'AVI', ext: 'avi', kind: 'video', about: 'Older Windows editors and players.', v: (crf) => ['-c:v', 'mpeg4', '-q:v', String(Math.max(2, Math.round(crf / 6))), '-vtag', 'xvid', '-pix_fmt', 'yuv420p'], a: ['-c:a', 'libmp3lame'], rate: (k) => ['-c:v', 'mpeg4', '-b:v', `${k}k`, '-vtag', 'xvid', '-pix_fmt', 'yuv420p'] },
  m4v: { label: 'M4V (iTunes)', ext: 'm4v', kind: 'video', about: 'Apple TV, iTunes, iPhone.', v: H264, a: ['-c:a', 'aac'], extra: ['-movflags', '+faststart'] },
  wmv: { label: 'WMV (Windows Media)', ext: 'wmv', kind: 'video', about: 'Old Windows software and PowerPoint.', v: (crf) => ['-c:v', 'wmv2', '-q:v', String(Math.max(2, Math.round(crf / 6)))], a: ['-c:a', 'wmav2'], rate: (k) => ['-c:v', 'wmv2', '-b:v', `${k}k`] },
  flv: { label: 'FLV (Flash video)', ext: 'flv', kind: 'video', about: 'Old streaming tools.', v: H264, a: ['-c:a', 'aac', '-ar', '44100'] },
  '3gp': { label: '3GP (small phone video)', ext: '3gp', kind: 'video', about: 'Very small files for old phones and texts.', v: (crf) => ['-c:v', 'libx264', '-profile:v', 'baseline', '-preset', 'veryfast', '-crf', String(crf + 4), '-pix_fmt', 'yuv420p'], a: ['-c:a', 'aac', '-ac', '1', '-ar', '22050'], maxH: 480 },
  hevc: { label: 'MP4 (HEVC / H.265)', ext: 'mp4', kind: 'video', about: 'About half the size of H.264 at the same quality; newer phones.', v: (crf) => ['-c:v', 'libx265', '-preset', 'fast', '-crf', String(crf + 4), '-tag:v', 'hvc1', '-pix_fmt', 'yuv420p'], a: ['-c:a', 'aac'], extra: ['-movflags', '+faststart'], rate: (k) => ['-c:v', 'libx265', '-preset', 'fast', '-b:v', `${k}k`, '-tag:v', 'hvc1', '-pix_fmt', 'yuv420p'] },
  gif: { label: 'GIF (no sound)', ext: 'gif', kind: 'gif', about: 'A looping picture for chats and pages; keep it short.', maxH: 480 },
  mp3: { label: 'MP3 (sound only)', ext: 'mp3', kind: 'audio', about: 'Just the sound.', a: ['-c:a', 'libmp3lame'] },
  m4a: { label: 'M4A (sound only, AAC)', ext: 'm4a', kind: 'audio', about: 'Just the sound, Apple-friendly.', a: ['-c:a', 'aac'] },
  wav: { label: 'WAV (sound only, uncompressed)', ext: 'wav', kind: 'audio', about: 'Full quality sound for editing.', a: ['-c:a', 'pcm_s16le'] },
  flac: { label: 'FLAC (sound only, lossless)', ext: 'flac', kind: 'audio', about: 'Lossless sound, smaller than WAV.', a: ['-c:a', 'flac'] },
  ogg: { label: 'OGG (sound only, Vorbis)', ext: 'ogg', kind: 'audio', about: 'Open sound format.', a: ['-c:a', 'libvorbis'] },
};
const QUALITY = { high: { crf: 18, ab: 192 }, balanced: { crf: 23, ab: 128 }, small: { crf: 28, ab: 96 } };
const AUDIO_RATE = { mp3: { high: '-b:a 256k', balanced: '-b:a 192k', small: '-b:a 128k' }, m4a: { high: '-b:a 256k', balanced: '-b:a 160k', small: '-b:a 96k' }, ogg: { high: '-q:a 7', balanced: '-q:a 5', small: '-q:a 3' } };

function formats() { return Object.entries(FORMATS).map(([id, f]) => ({ id, label: f.label, ext: f.ext, kind: f.kind, about: f.about })); }

const even = (n) => Math.max(2, Math.round(n / 2) * 2);
/** Scale filter keeping the shape: fit inside `h` lines for landscape (or `h` columns for portrait), never upscaled. */
function scaleTo(info, h) {
  if (!h || !info?.width || !info?.height) return null;
  const portrait = info.height > info.width; const short = Math.min(info.width, info.height);
  if (short <= h) return null;
  const k = h / short; return `scale=${even(info.width * k)}:${even(info.height * k)}${portrait ? '' : ''}:flags=lanczos`;
}

/** The size the video should come down to for a bitrate (kbps): enough pixels per bit to look clean. */
function heightFor(kbps) { return kbps >= 4500 ? 1080 : kbps >= 2200 ? 720 : kbps >= 1100 ? 540 : kbps >= 600 ? 480 : 360; }

function outPathFor(input, outDir, name, ext) {
  const dir = outDir || path.dirname(input);
  fs.mkdirSync(dir, { recursive: true });
  const base = String(name || `${path.basename(input, path.extname(input))}`).replace(/[<>:"/\\|?*]+/g, '').replace(/\.[a-z0-9]{2,4}$/i, '').trim().slice(0, 120) || 'video';
  let out = path.join(dir, `${base}.${ext}`); let n = 2;
  while (fs.existsSync(out) || path.resolve(out) === path.resolve(input)) out = path.join(dir, `${base} (${n++}).${ext}`);
  return out;
}

/**
 * Convert one file. opts: format (id above), quality (high|balanced|small), height (max short side, e.g. 720),
 * targetMB (fit under this size), fps (for GIF), outDir, name, signal, onProgress(frac).
 */
async function convert(input, opts = {}) {
  const fmtId = FORMATS[opts.format] ? opts.format : 'mp4'; const fmt = FORMATS[fmtId];
  if (!fs.existsSync(input)) throw new Error('That file is no longer there.');
  const info = await ff.probe(input);
  const dur = Number(info.duration) || 0;
  if (!dur) throw new Error("Euclidean can't read that file's length. Is it a video or sound file?");
  if (fmt.kind !== 'audio' && !info.hasVideo) throw new Error('This file has no picture. Pick a sound format (MP3, M4A, WAV...) instead.');
  if (fmt.kind === 'audio' && !info.hasAudio) throw new Error('This file has no sound to save.');
  const q = QUALITY[opts.quality] || QUALITY.balanced;
  const out = outPathFor(input, opts.outDir, opts.name || (Number(opts.targetMB) ? `${path.basename(input, path.extname(input))} (compressed)` : null), fmt.ext);
  const targetMB = Number(opts.targetMB) || 0;
  const run = (args) => ff.ffmpegWithProgress(['-i', input, ...args, out], { totalSec: dur, onProgress: opts.onProgress, signal: opts.signal });

  if (fmt.kind === 'audio') {
    let a = [...fmt.a]; const r = AUDIO_RATE[fmtId]?.[opts.quality || 'balanced']; if (r) a.push(...r.split(' '));
    if (targetMB && ['mp3', 'm4a', 'ogg'].includes(fmtId)) { const k = Math.max(32, Math.min(320, Math.floor(targetMB * 8 * 1024 * 0.95 / dur))); a = [...fmt.a, '-b:a', `${k}k`]; }
    await run(['-vn', ...a]);
  } else if (fmt.kind === 'gif') {
    const fps = Math.max(5, Math.min(30, Number(opts.fps) || 12));
    let h = Math.min(Number(opts.height) || 480, fmt.maxH);
    for (let pass = 0; pass < 4; pass++) {
      const sc = scaleTo(info, h) || 'scale=iw:ih';
      await run(['-an', '-vf', `fps=${fps},${sc},split[a][b];[a]palettegen=max_colors=${opts.quality === 'small' ? 96 : 192}:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4`, '-loop', '0']);
      if (!targetMB || fs.statSync(out).size <= targetMB * 1048576) break;
      h = Math.max(160, Math.round(h * 0.75));
    }
  } else {
    const aArgs = info.hasAudio ? [...fmt.a, '-b:a', `${q.ab}k`] : ['-an'];
    const extra = fmt.extra || [];
    if (!targetMB) {
      const h = Math.min(Number(opts.height) || 99999, fmt.maxH || 99999); const sc = scaleTo(info, h === 99999 ? 0 : h);
      await run([...(sc ? ['-vf', sc] : []), ...fmt.v(q.crf), ...aArgs, ...extra]);
    } else {
      // Fit under the size: total bits / length, minus the sound, split for the picture. Re-made 15% smaller if over.
      const ab = info.hasAudio ? (targetMB <= 10 ? 64 : 96) : 0;
      let kbps = Math.floor((targetMB * 8 * 1024 * 0.93) / dur) - ab;
      // Never bigger than it was: a file already under the limit is kept at most at its own bitrate (a little under).
      const srcK = info.bitrate ? Math.floor(info.bitrate / 1000) - (info.hasAudio ? 128 : 0) : 0;
      if (srcK > 300) kbps = Math.min(kbps, Math.floor(srcK * 0.85));
      if (kbps < 120) throw new Error(`${Math.round(dur / 60)} minutes is too long to fit under ${targetMB} MB and still be watchable. Cut it shorter first (Quick cut), or choose a bigger size.`);
      for (let pass = 0; pass < 3; pass++) {
        const h = Math.min(Number(opts.height) || 99999, heightFor(kbps), fmt.maxH || 99999); const sc = scaleTo(info, h);
        const vArgs = fmt.rate ? fmt.rate(kbps) : ['-c:v', 'libx264', '-preset', 'medium', '-b:v', `${kbps}k`, '-pix_fmt', 'yuv420p', ...(fmtId === '3gp' ? ['-profile:v', 'baseline'] : [])];
        await run([...(sc ? ['-vf', sc] : []), ...vArgs, '-maxrate', `${Math.round(kbps * 1.25)}k`, '-bufsize', `${Math.round(kbps * 2)}k`, ...(info.hasAudio ? [...fmt.a, '-b:a', `${ab}k`] : ['-an']), ...extra]);
        if (fs.statSync(out).size <= targetMB * 1048576) break;
        kbps = Math.floor(kbps * 0.85 * (targetMB * 1048576) / fs.statSync(out).size);
        if (kbps < 100) throw new Error(`It wouldn't fit under ${targetMB} MB. Cut it shorter first, or choose a bigger size.`);
      }
    }
  }
  const size = fs.statSync(out).size;
  const outInfo = await ff.probe(out).catch(() => ({}));
  return { path: out, format: fmtId, bytes: size, mb: Math.round(size / 10485.76) / 100, inMb: Math.round(fs.statSync(input).size / 10485.76) / 100, width: outInfo.width || null, height: outInfo.height || null, duration: outInfo.duration || dur, underTarget: targetMB ? size <= targetMB * 1048576 : null };
}

module.exports = { convert, formats, FORMATS, QUALITY, heightFor };
