'use strict';
/**
 * Native short-form renderer. Builds one FFmpeg filter graph per short:
 * jump-cut silence removal → 9:16 reframe (crop / blurred fill / fit) →
 * punch-in zooms → burned-in word-highlight captions + hook → logo →
 * loudness normalisation → H.264 (hardware encoder when available).
 */
const fs = require('fs');
const path = require('path');
const paths = require('../core/paths');
const ff = require('./ffmpeg');
const captions = require('./captions');

const W = 1080, H = 1920;

/** Copy bundled caption fonts next to the data root once so FFmpeg can use a relative fontsdir. */
function ensureFonts() {
  const dst = path.join(paths.root, 'fonts');
  const src = path.join(__dirname, 'fonts');
  fs.mkdirSync(dst, { recursive: true });
  // Copy new or updated fonts (size differs) so every bundled font is there for the captions.
  // Remove fonts we no longer ship (e.g. lighter weights that the renderer would pick instead of the one in the preview).
  for (const f of fs.readdirSync(dst)) if (f.endsWith('.ttf') && !fs.existsSync(path.join(src, f))) { try { fs.unlinkSync(path.join(dst, f)); } catch { /* in use */ } }
  for (const f of fs.readdirSync(src)) if (f.endsWith('.ttf')) { const d = path.join(dst, f); try { if (!fs.existsSync(d) || fs.statSync(d).size !== fs.statSync(path.join(src, f)).size) fs.copyFileSync(path.join(src, f), d); } catch { /* in use */ } }
  // FFmpeg's caption renderer finds fonts through fontconfig. On Windows it often has no config file and falls back to a
  // plain font, so give it one that lists Euclidean's fonts first (then the system fonts). All FFmpeg runs inherit it.
  try {
    const conf = path.join(paths.root, 'fonts.conf'); const cache = path.join(paths.root, 'fontcache'); fs.mkdirSync(cache, { recursive: true });
    const x = (p) => p.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    const sys = process.platform === 'win32' ? '<dir>WINDOWSFONTDIR</dir>' : process.platform === 'darwin' ? '<dir>/System/Library/Fonts</dir><dir>/Library/Fonts</dir>' : '<dir>/usr/share/fonts</dir>';
    const xml = `<?xml version="1.0"?>\n<!DOCTYPE fontconfig SYSTEM "fonts.dtd">\n<fontconfig>\n  <dir>${x(dst)}</dir>\n  ${sys}\n  <cachedir>${x(cache)}</cachedir>\n</fontconfig>\n`;
    if (!fs.existsSync(conf) || fs.readFileSync(conf, 'utf8') !== xml) fs.writeFileSync(conf, xml);
    process.env.FONTCONFIG_FILE = conf; process.env.FONTCONFIG_PATH = paths.root;
  } catch { /* fonts dir still passed to FFmpeg directly */ }
  return dst;
}
function rel(p) { return path.relative(paths.root, p).split(path.sep).join('/').replace(/'/g, ''); }

/**
 * Compute kept segments inside [start,end] by removing pauses between words
 * longer than `maxGap`. Returns absolute source segments.
 */
function keptSegments(words, start, end, maxGap = 0.55, pad = 0.12, silences = null) {
  const inRange = words.filter((w) => w.e > start && w.s < end);
  if (inRange.length < 3) return [[start, end]];
  const segs = []; let segStart = start;
  for (let i = 1; i < inRange.length; i++) {
    let gapStart = inRange[i - 1].e, gapEnd = inRange[i].s;
    if (gapEnd - gapStart > maxGap) {
      // Only cut where the sound really is quiet: word times can be off, and cutting through speech chops sentences.
      if (silences) {
        const quiet = silences.filter(([a, b]) => a < gapEnd && b > gapStart);
        if (!quiet.length) continue;
        gapStart = Math.max(gapStart, Math.min(...quiet.map(([a]) => a))); gapEnd = Math.min(gapEnd, Math.max(...quiet.map(([, b]) => b)));
        if (gapEnd - gapStart < maxGap * 0.8) continue;
      }
      segs.push([segStart, Math.min(end, gapStart + pad)]);
      segStart = Math.max(start, gapEnd - pad);
    }
  }
  segs.push([segStart, end]);
  return segs.filter(([a, b]) => b - a > 0.08);
}

/** Jump cuts without a transcript: drop the pauses FFmpeg heard (silences [[a,b]] in source seconds). */
function cutPauses(silences, start, end, minGap = 0.6, pad = 0.15) {
  const segs = []; let cur = start;
  for (const [a, b] of silences) {
    if (b <= start || a >= end || b - a < minGap) continue;
    const cutA = Math.max(start, a + pad), cutB = Math.min(end, b - pad);
    if (cutB - cutA < 0.3) continue;
    if (cutA > cur) segs.push([cur, cutA]);
    cur = cutB;
  }
  if (end > cur) segs.push([cur, end]);
  const out = segs.filter(([a, b]) => b - a > 0.25);
  return out.length && out.reduce((n, [a, b]) => n + b - a, 0) > (end - start) * 0.35 ? out : [[start, end]];
}

/** Output frame rate: the source's, snapped to 24/25/30/50/60 (NTSC rates kept exact). */
function outFps(src) {
  const f = Number(src) || 30;
  const std = [[23.976, '24000/1001'], [24, '24'], [25, '25'], [29.97, '30000/1001'], [30, '30'], [50, '50'], [59.94, '60000/1001'], [60, '60']];
  let best = std[4]; for (const x of std) if (Math.abs(x[0] - f) < Math.abs(best[0] - f)) best = x;
  return Math.abs(best[0] - f) < 1.5 ? best[1] : f > 60 ? '60' : '30';
}

/** Map an absolute source time into the cut timeline (relative to clip start). */
function remap(t, segs) {
  let acc = 0;
  for (const [a, b] of segs) {
    if (t < a) return acc;
    if (t <= b) return acc + (t - a);
    acc += b - a;
  }
  return acc;
}

/**
 * @param o.source     absolute path of the source media
 * @param o.range      {start,end} source seconds
 * @param o.words      transcript words [{w,s,e}] (absolute source times) or []
 * @param o.style      caption style (client memory)
 * @param o.hook       headline text for the opening seconds
 * @param o.reframe    'crop' | 'smart-blur' | 'fit'
 * @param o.focusX     0..1 horizontal crop focus
 * @param o.plan       { silenceCut, retakeCut, punchIns:[{at,dur,zoom}] } with clip-relative times
 * @param o.logo       optional absolute path to a PNG logo
 * @param o.outPath    output mp4
 */
async function renderShort(o) {
  ensureFonts();
  const outDir = path.dirname(o.outPath);
  fs.mkdirSync(outDir, { recursive: true });
  const info = o.info || await ff.probe(o.source);
  const start = Math.max(0, o.range.start), end = Math.min(info.duration || o.range.end, o.range.end);
  const plan = o.plan || {};
  // Story cuts: only the kept sentences (whole sentences, in order), each with its pauses trimmed.
  const parts = [];
  for (const [a, b] of (plan.keep || []).map(([x, y]) => [Math.max(start, x), Math.min(end, y)]).filter(([x, y]) => y - x > 0.3).sort((x, y) => x[0] - y[0])) {
    const last = parts[parts.length - 1];
    if (last && a <= last[1] + 0.35) last[1] = Math.max(last[1], b); else parts.push([a, b]); // overlapping or touching pieces become one, so captions stay in sync
  }
  const ranges = parts.length ? parts : [[start, end]];
  let segs = ranges.flatMap(([a, b]) => (plan.silenceCut && o.words?.length ? keptSegments(o.words, a, b, 0.55, 0.12, plan.silences?.length ? plan.silences : null) : plan.silenceCut && plan.silences?.length ? cutPauses(plan.silences, a, b) : [[a, b]]));
  // Cut repeated takes and false starts (keeps the last take of each line).
  if (plan.retakeCut !== false && o.words?.length) {
    const rt = require('./retakes'); const inRange = o.words.filter((w) => w.e > start && w.s < end);
    const ranges = rt.retakeRanges(inRange); if (ranges.length) segs = rt.subtract(segs, ranges);
  }
  const outDur = segs.reduce((s, [a, b]) => s + (b - a), 0);

  // Captions are generated in the cut timeline so they stay in sync after jump cuts.
  const cutWords = (o.words || []).filter((w) => w.e > start && w.s < end && segs.some(([a, b]) => w.s < b && w.e > a))
    .map((w) => ({ w: w.w, s: remap(Math.max(w.s, start), segs), e: remap(Math.min(w.e, end), segs) }));
  const assPath = path.join(outDir, path.basename(o.outPath, '.mp4') + '.ass');
  fs.writeFileSync(assPath, captions.buildAss({ words: cutWords, range: { start: 0, end: outDur }, style: o.style, hook: o.hook, graphics: o.graphics, width: W, height: H, keywords: o.keywords }));
  const gr = captions.resolveGraphics(o.graphics);
  const srtPath = path.join(outDir, path.basename(o.outPath, '.mp4') + '.srt');
  fs.writeFileSync(srtPath, captions.buildSrt({ words: cutWords, range: { start: 0, end: outDur }, style: o.style }));

  const args = ['-ss', start.toFixed(3), '-t', (end - start + 0.05).toFixed(3), '-i', o.source];
  const hasLogo = o.logo && fs.existsSync(o.logo);
  if (hasLogo) args.push('-i', o.logo);
  if (!info.hasAudio) args.push('-f', 'lavfi', '-t', outDur.toFixed(3), '-i', 'anullsrc=r=48000:cl=stereo');
  const audioIdx = info.hasAudio ? 0 : (hasLogo ? 2 : 1);

  const f = [];
  // Keep the footage's own frame rate (rounded to a standard one). Forcing everything to 30 repeats or drops
  // frames every so often with 24/25/60 fps footage, which looks choppy on smooth pans and drone shots.
  const FPS = outFps(info.fps);
  // 1. Jump cuts (times relative to the input seek point). Steady the frame timing first so cuts land cleanly.
  let v = '0:v', a = `${audioIdx}:a`;
  if (segs.length > 1) {
    const expr = segs.map(([s, e]) => `between(t,${(s - start).toFixed(3)},${(e - start).toFixed(3)})`).join('+');
    f.push(`[0:v]fps=${FPS},select='${expr}',setpts=N/(${FPS})/TB[vcut]`);
    v = 'vcut';
    if (info.hasAudio) { f.push(`[0:a]aselect='${expr}',asetpts=N/SR/TB[acut]`); a = 'acut'; }
  }
  // 2. Reframe to 9:16. With a face path the crop follows the speaker (virtual camera).
  const fx = Math.min(1, Math.max(0, o.focusX ?? 0.5));
  const mode = o.reframe || 'smart-blur';
  const srcAspect = info.width && info.height ? info.width / info.height : 16 / 9;
  const face = (o.facePath || []).map((p) => ({ t: remap(Math.min(end, Math.max(start, p.t)), segs), x: p.x })).filter((p, i, a) => i === 0 || p.t > a[i - 1].t + 0.02);
  const facefx = face.length ? null : fx;
  if (mode === 'face' || mode === 'crop' || srcAspect <= 0.6) {
    const sw = srcAspect > W / H ? Math.round((H * srcAspect) / 2) * 2 : W; const sh = srcAspect > W / H ? H : Math.round((W / srcAspect) / 2) * 2;
    const x = face.length && mode !== 'crop' ? require('./facetrack').cropExpr(face, sw, W) : String(Math.round((sw - W) * (facefx ?? fx)));
    f.push(`[${v}]scale=${sw}:${sh}:flags=lanczos,crop=${W}:${H}:${x}:${Math.round((sh - H) / 2)},setsar=1[vr]`);
  } else if (mode === 'fit') {
    f.push(`[${v}]scale=${W}:${H}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=0x101010,setsar=1[vr]`);
  } else {
    // Blurred fill: a soft, darkened copy behind the full-width foreground, zoomed slightly so the subject reads on phones.
    const fgW = Math.round(W * 1.18 / 2) * 2; const fgH = Math.round(fgW / srcAspect / 2) * 2;
    const fgx = face.length ? require('./facetrack').cropExpr(face, fgW, W) : String(Math.round((fgW - W) * fx));
    f.push(`[${v}]split=2[bgsrc][fgsrc]`);
    f.push(`[bgsrc]scale=270:480:force_original_aspect_ratio=increase,crop=270:480,gblur=sigma=12,eq=brightness=-0.08:saturation=1.1,scale=${W}:${H},setsar=1[bg]`);
    f.push(`[fgsrc]scale=${fgW}:${fgH}:flags=lanczos,crop=${W}:${fgH}:${fgx}:0,setsar=1[fg]`);
    f.push(`[bg][fg]overlay=(W-w)/2:(H-h)/2-${Math.round(H * 0.03)}[vr]`);
  }
  v = 'vr';
  // 3. Punch-in zooms (clip-relative times in the cut timeline).
  const punches = (plan.punchIns || []).filter((p) => p.at >= 0 && p.at < outDur).slice(0, 12);
  if (punches.length) {
    const z = punches.map((p) => `between(t,${p.at.toFixed(2)},${(p.at + (p.dur || 1.2)).toFixed(2)})*${((p.zoom || 1.12) - 1).toFixed(3)}`).join('+');
    f.push(`[${v}]scale=w='trunc(iw*(1+${z})/2)*2':h='trunc(ih*(1+${z})/2)*2':eval=frame,crop=${W}:${H}:(iw-${W})/2:(ih-${H})/2[vz]`);
    v = 'vz';
  }
  // 4. Captions + hook (libass). Paths are relative to the data root (FFmpeg cwd) to avoid drive-letter escaping.
  f.push(`[${v}]subtitles=filename='${rel(assPath)}':fontsdir='fonts'[vs]`);
  v = 'vs';
  // 5. Logo bug.
  if (hasLogo) {
    const pos = { 'top-right': 'W-w-56:96', 'top-left': '56:96', 'bottom-right': 'W-w-56:H-h-140', 'bottom-left': '56:H-h-140' }[gr.logo.position] || 'W-w-56:96';
    f.push(`[1:v]scale=${Math.round(gr.logo.size || 150)}:-1,format=rgba,colorchannelmixer=aa=${(gr.logo.opacity ?? 0.9).toFixed(2)}[lg]`);
    f.push(`[${v}][lg]overlay=${pos}[vl]`);
    v = 'vl';
  }
  // Progress bar along the bottom edge (client template).
  if (gr.progressBar.enabled) {
    const col = String(gr.progressBar.color || '#6CC3B8').replace('#', '0x');
    f.push(`[${v}]drawbox=x=0:y=ih-14:w=iw*t/${outDur.toFixed(3)}:h=14:color=${col}@0.95:t=fill[vp]`);
    v = 'vp';
  }
  f.push(`[${v}]fps=${FPS},format=yuv420p[vout]`);
  // 6. Audio: loudness normalisation and click-free edges.
  const lufs = o.loudness ?? -14;
  f.push(`[${a}]aresample=48000,loudnorm=I=${lufs}:TP=-1.5:LRA=11,afade=t=in:d=0.03,afade=t=out:st=${Math.max(0, outDur - 0.08).toFixed(3)}:d=0.08[aout]`);

  const enc = ff.pickEncoder();
  args.push('-filter_complex', f.join(';'), '-map', '[vout]', '-map', '[aout]', '-t', outDur.toFixed(3),
    ...ff.encoderArgs(enc, o.crf || 20), '-profile:v', 'high', '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-movflags', '+faststart', o.outPath);
  try {
    await ff.ffmpegWithProgress(args, { totalSec: outDur, onProgress: o.onProgress, cwd: paths.root, signal: o.signal });
  } catch (e) {
    // Hardware encoders can fail mid-session (driver busy); retry once in software.
    if (enc !== 'libx264' && !e.canceled) {
      const i = args.indexOf('-c:v'); args.splice(i, enc === 'h264_nvenc' ? 8 : enc === 'h264_amf' ? 10 : enc === 'h264_qsv' ? 4 : 4, ...ff.encoderArgs('libx264', o.crf || 20));
      await ff.ffmpegWithProgress(args, { totalSec: outDur, onProgress: o.onProgress, cwd: paths.root, signal: o.signal });
    } else throw e;
  }
  return { outPath: o.outPath, assPath, srtPath, duration: outDur, segments: segs, encoder: enc, cutWords };
}

module.exports = { renderShort, outFps, cutPauses, keptSegments, remap, ensureFonts, W, H };
