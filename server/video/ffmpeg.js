'use strict';
/** FFmpeg/FFprobe wrappers: probing, audio extraction, thumbnails, encoder detection, progress parsing. */
const fs = require('fs');
const path = require('path');
const os = require('os');
const ctx = require('../core/ctx');
const { run, safeJson } = require('../core/util');

function bin(name) {
  const custom = ctx.setting(`tools.${name}Path`, '');
  if (custom) return custom;
  // Packaged builds ship ffmpeg in resources/bin when it was placed in build/bin before packaging.
  const res = process.resourcesPath ? path.join(process.resourcesPath, 'bin', process.platform === 'win32' ? `${name}.exe` : name) : null;
  if (res && fs.existsSync(res)) return res;
  return findInstalled(name) || name;
}

/** yt-dlp: a path set in Settings, else wherever it was installed (winget, pip, Scoop…), else PATH. */
function ytdlpBin() { return ctx.setting('tools.ytdlpPath', '') || findInstalled('yt-dlp') || 'yt-dlp'; }

/**
 * Windows doesn't refresh PATH for programs that were already running when FFmpeg was installed,
 * so look in the places winget, Chocolatey, Scoop and manual installs put it.
 */
const found = {};
function findInstalled(name) {
  if (name in found) return found[name];
  found[name] = null;
  if (process.platform !== 'win32') {
    for (const d of ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin']) { const p = path.join(d, name); if (fs.existsSync(p)) return (found[name] = p); }
    return null;
  }
  const exe = `${name}.exe`;
  const la = process.env.LOCALAPPDATA || path.join(require('os').homedir(), 'AppData', 'Local');
  const dirs = (process.env.PATH || process.env.Path || '').split(path.delimiter).filter(Boolean);
  dirs.push(path.join(la, 'Microsoft', 'WinGet', 'Links'), 'C:\\ffmpeg\\bin', path.join(process.env.ProgramFiles || 'C:\\Program Files', 'ffmpeg', 'bin'),
    'C:\\ProgramData\\chocolatey\\bin', path.join(require('os').homedir(), 'scoop', 'shims'));
  // winget's Gyan.FFmpeg package: ...\WinGet\Packages\Gyan.FFmpeg_*\ffmpeg-*\bin
  try {
    const pk = path.join(la, 'Microsoft', 'WinGet', 'Packages');
    for (const a of fs.readdirSync(pk).filter((x) => /ffmpeg/i.test(x))) for (const b of fs.readdirSync(path.join(pk, a))) dirs.push(path.join(pk, a, b, 'bin'));
  } catch { /* winget not used */ }
  for (const d of dirs) { const p = path.join(d, exe); if (fs.existsSync(p)) return (found[name] = p); }
  return null;
}

async function detect() {
  for (const k of Object.keys(found)) delete found[k]; // look again: tools may have been installed since
  const caps = { ffmpeg: false, ffprobe: false, libass: false, encoders: [], ytdlp: false, whisper: false };
  try {
    const v = await run(bin('ffmpeg'), ['-hide_banner', '-version'], { timeoutMs: 10000 });
    caps.ffmpeg = true; caps.ffmpegVersion = (v.out.split('\n')[0] || '').replace('ffmpeg version ', '').split(' ')[0];
    const f = await run(bin('ffmpeg'), ['-hide_banner', '-filters'], { timeoutMs: 10000 });
    caps.libass = / subtitles /.test(f.out);
    const e = await run(bin('ffmpeg'), ['-hide_banner', '-encoders'], { timeoutMs: 10000 });
    caps.encoders = ['libx264', 'h264_nvenc', 'h264_qsv', 'h264_amf', 'h264_videotoolbox'].filter((x) => e.out.includes(` ${x} `));
  } catch { /* ffmpeg missing */ }
  try { await run(bin('ffprobe'), ['-version'], { timeoutMs: 10000 }); caps.ffprobe = true; } catch { /* missing */ }
  try { const y = await run(ytdlpBin(), ['--version'], { timeoutMs: 10000 }); caps.ytdlp = true; caps.ytdlpVersion = y.out.trim(); } catch { /* missing */ }
  const wp = ctx.setting('ai.transcription.localWhisperPath', '');
  caps.whisper = !!(wp && fs.existsSync(wp) && ctx.setting('ai.transcription.localWhisperModel', ''));
  // Hardware encoders are listed even when no GPU is present; verify with a one-frame encode.
  const verified = [];
  for (const enc of caps.encoders) {
    if (enc === 'libx264') { verified.push(enc); continue; }
    try { await run(bin('ffmpeg'), ['-hide_banner', '-f', 'lavfi', '-i', 'color=c=black:s=256x256:d=0.1', '-frames:v', '1', '-c:v', enc, '-f', 'null', '-'], { timeoutMs: 15000 }); verified.push(enc); } catch { /* not usable */ }
  }
  caps.encoders = verified;
  return caps;
}

async function probe(file) {
  const r = await run(bin('ffprobe'), ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { timeoutMs: 60000 });
  const j = safeJson(r.out, {});
  const v = (j.streams || []).find((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1);
  const a = (j.streams || []).find((s) => s.codec_type === 'audio');
  const fpsStr = v?.avg_frame_rate || v?.r_frame_rate || '0/1';
  const [n, d] = fpsStr.split('/').map(Number);
  let width = v?.width || 0, height = v?.height || 0;
  const rot = Number(v?.tags?.rotate || (v?.side_data_list || []).find((s) => s.rotation != null)?.rotation || 0);
  if (Math.abs(rot) === 90 || Math.abs(rot) === 270) [width, height] = [height, width];
  return {
    duration: Number(j.format?.duration || v?.duration || a?.duration || 0),
    width, height, fps: d ? Math.round((n / d) * 100) / 100 : 0,
    hasVideo: !!v && width > 0 && height > 0, hasAudio: !!a, // a 0x0 stream (cover art, broken track) is not a picture vcodec: v?.codec_name || null, acodec: a?.codec_name || null,
    size: Number(j.format?.size || 0), bitrate: Number(j.format?.bit_rate || 0),
    // Where the sound starts on the file's timeline (downloads often start the audio a little after the picture).
    // Speech-to-text times are counted from the first sound, so they get this added to line up with the picture.
    audioOffset: a ? Math.max(0, Math.round(((Number(a.start_time) || 0) - (Number(j.format?.start_time) || 0)) * 1000) / 1000) : 0,
  };
}

async function extractAudio(file, out, { start, duration } = {}) {
  const args = ['-hide_banner', '-y'];
  if (start) args.push('-ss', String(start));
  args.push('-i', file);
  if (duration) args.push('-t', String(duration));
  args.push('-vn', '-ac', '1', '-ar', '16000', '-c:a', 'libmp3lame', '-b:a', '48k', out);
  await run(bin('ffmpeg'), args, { timeoutMs: 3600000, priority: os.constants.priority.PRIORITY_BELOW_NORMAL });
  return out;
}

async function extractWav(file, out) {
  await run(bin('ffmpeg'), ['-hide_banner', '-y', '-i', file, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', out], { timeoutMs: 3600000 });
  return out;
}

async function thumbnail(file, out, atSec = 1, width = 360) {
  await run(bin('ffmpeg'), ['-hide_banner', '-y', '-ss', String(Math.max(0, atSec)), '-i', file, '-frames:v', '1', '-vf', `scale=${width}:-2`, '-q:v', '4', out], { timeoutMs: 60000 });
  return out;
}

/** Filmstrip sprite for the Studio timeline: N frames side by side. */
async function filmstrip(file, out, duration, frames = 20, height = 60) {
  const fps = Math.max(0.01, frames / Math.max(1, duration));
  // Keyframes only: fast even on hour-long 4K files.
  await run(bin('ffmpeg'), ['-hide_banner', '-y', '-skip_frame', 'nokey', '-i', file, '-vf', `fps=${fps.toFixed(4)},scale=-2:${height},tile=${frames}x1`, '-frames:v', '1', '-q:v', '5', out], { timeoutMs: 300000, priority: os.constants.priority.PRIORITY_BELOW_NORMAL });
  return out;
}

/** Peak waveform for the Studio timeline (normalized 0..1 values). */
async function waveform(file, points = 800) {
  const r = await new Promise((resolve, reject) => {
    const { spawn } = require('child_process');
    const p = spawn(bin('ffmpeg'), ['-hide_banner', '-i', file, '-vn', '-ac', '1', '-ar', '2000', '-f', 's16le', '-'], { windowsHide: true });
    const chunks = []; p.stdout.on('data', (d) => chunks.push(d)); p.on('error', reject); p.on('close', () => resolve(Buffer.concat(chunks)));
  });
  const samples = r.length / 2; if (!samples) return [];
  const per = Math.max(1, Math.floor(samples / points)); const out = [];
  for (let i = 0; i < samples; i += per) {
    let peak = 0; for (let j = i; j < Math.min(samples, i + per); j++) { const v = Math.abs(r.readInt16LE(j * 2)); if (v > peak) peak = v; }
    out.push(Math.round((peak / 32768) * 1000) / 1000);
  }
  return out;
}

function pickEncoder() {
  const pref = ctx.setting('production.encoder', 'auto');
  const avail = ctx.capabilities.encoders || ['libx264'];
  if (pref !== 'auto' && avail.includes(pref)) return pref;
  for (const e of ['h264_nvenc', 'h264_qsv', 'h264_amf', 'h264_videotoolbox']) if (avail.includes(e)) return e;
  return 'libx264';
}

function encoderArgs(enc, crf) {
  switch (enc) {
    case 'h264_nvenc': return ['-c:v', 'h264_nvenc', '-preset', 'p5', '-rc', 'vbr', '-cq', String(crf + 2), '-b:v', '0'];
    case 'h264_qsv': return ['-c:v', 'h264_qsv', '-global_quality', String(crf + 2)];
    case 'h264_amf': return ['-c:v', 'h264_amf', '-quality', 'quality', '-rc', 'cqp', '-qp_i', String(crf), '-qp_p', String(crf + 2)];
    case 'h264_videotoolbox': return ['-c:v', 'h264_videotoolbox', '-q:v', '62'];
    default: return ['-c:v', 'libx264', '-preset', 'medium', '-crf', String(crf)];
  }
}

function priorityValue() {
  const p = ctx.setting('resources.renderPriority', 'below_normal');
  const P = os.constants.priority;
  return { low: P.PRIORITY_LOW, below_normal: P.PRIORITY_BELOW_NORMAL, normal: P.PRIORITY_NORMAL }[p] ?? P.PRIORITY_BELOW_NORMAL;
}

/** Run ffmpeg with -progress parsing. onProgress receives 0..1. */
function ffmpegWithProgress(args, { totalSec, onProgress, cwd, signal }) {
  const threads = ctx.setting('resources.renderThreads', 0);
  const full = ['-hide_banner', '-y', '-nostats', '-progress', 'pipe:1', ...(threads ? ['-threads', String(threads)] : []), ...args];
  return run(bin('ffmpeg'), full, {
    cwd, signal, priority: priorityValue(), timeoutMs: 4 * 3600000,
    onLine: (l) => {
      if (!onProgress || !totalSec) return;
      const m = /^out_time_(?:us|ms)=(\d+)/.exec(l);
      if (m) onProgress(Math.min(0.999, Number(m[1]) / 1e6 / totalSec));
    },
  });
}

/** Technical QC: duration, dimensions, audio presence, black frames, long silences. */
async function qualityCheck(file, { expectWidth, expectHeight, minSec = 3, maxSec = 180 } = {}) {
  const issues = []; const info = await probe(file);
  if (!info.hasVideo) issues.push({ level: 'error', code: 'no_video', text: 'No video stream' });
  if (!info.hasAudio) issues.push({ level: 'warn', code: 'no_audio', text: 'No audio track' });
  if (expectWidth && (info.width !== expectWidth || info.height !== expectHeight)) issues.push({ level: 'error', code: 'dimensions', text: `Expected ${expectWidth}×${expectHeight}, got ${info.width}×${info.height}` });
  if (info.duration < minSec) issues.push({ level: 'error', code: 'too_short', text: `Only ${info.duration.toFixed(1)}s long` });
  if (info.duration > maxSec) issues.push({ level: 'warn', code: 'too_long', text: `${info.duration.toFixed(1)}s exceeds ${maxSec}s` });
  try {
    const r = await run(bin('ffmpeg'), ['-hide_banner', '-i', file, '-vf', 'blackdetect=d=0.8:pix_th=0.08', '-af', 'silencedetect=n=-45dB:d=2.5', '-f', 'null', '-'], { timeoutMs: 600000, priority: os.constants.priority.PRIORITY_BELOW_NORMAL });
    const blacks = (r.err.match(/black_start:[\d.]+ black_end:[\d.]+/g) || []).length;
    const silences = (r.err.match(/silence_start: [\d.]+/g) || []).length;
    if (blacks) issues.push({ level: 'warn', code: 'black', text: `${blacks} black segment${blacks > 1 ? 's' : ''} detected` });
    if (silences) issues.push({ level: 'warn', code: 'silence', text: `${silences} silent gap${silences > 1 ? 's' : ''} over 2.5s` });
  } catch (e) { issues.push({ level: 'warn', code: 'qc_scan', text: `Scan incomplete: ${e.message.slice(0, 120)}` }); }
  return { passed: !issues.some((i) => i.level === 'error'), issues, info };
}

/** Speech-activity windows from silencedetect; used for heuristic clip discovery when no AI is connected. */
async function speechWindows(file) {
  const r = await run(bin('ffmpeg'), ['-hide_banner', '-i', file, '-vn', '-af', 'silencedetect=n=-35dB:d=0.6', '-f', 'null', '-'], { timeoutMs: 1800000, priority: os.constants.priority.PRIORITY_BELOW_NORMAL });
  const starts = [...r.err.matchAll(/silence_start: ([\d.]+)/g)].map((m) => +m[1]);
  const ends = [...r.err.matchAll(/silence_end: ([\d.]+)/g)].map((m) => +m[1]);
  return { silences: starts.map((s, i) => [s, ends[i] ?? s]) };
}

module.exports = { bin, ytdlpBin, detect, probe, extractAudio, extractWav, thumbnail, filmstrip, waveform, pickEncoder, encoderArgs, ffmpegWithProgress, qualityCheck, speechWindows, priorityValue };
