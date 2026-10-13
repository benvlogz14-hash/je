'use strict';
/**
 * Studio export: renders a Velo-format project (the same JSON Velo saves)
 * through one FFmpeg filter graph. Supports multi-track video/images with
 * position, scale, rotation, opacity, speed, Velo's effects, fades/dissolves,
 * text clips (via libass) and a mixed multi-track audio bed.
 * Keyframed animation is exported at its base value and reported as a
 * warning; open the project in Velo for frame-accurate keyframes.
 */
const fs = require('fs');
const path = require('path');
const paths = require('../core/paths');
const ff = require('./ffmpeg');
const render = require('./render');

const base = (p, d) => (p && typeof p === 'object' ? (p.base ?? d) : (p ?? d));
const hasKeys = (p) => p && typeof p === 'object' && Array.isArray(p.keys) && p.keys.length > 0;
const num = (v) => (Math.round(v * 1000) / 1000).toString();

function effectFilters(effects, warnings) {
  const out = [];
  for (const e of effects || []) {
    if (e.enabled === false) continue;
    const p = Object.fromEntries(Object.entries(e.params || {}).map(([k, v]) => { if (hasKeys(v)) warnings.add(`Keyframed ${e.effectId} exported at its base value`); return [k, base(v, 0)]; }));
    switch (e.effectId) {
      case 'gaussian_blur': if (p.radius > 0) out.push(`gblur=sigma=${num(p.radius / 2)}`); break;
      case 'color_correction': {
        out.push(`eq=brightness=${num((p.brightness || 0) / 200)}:contrast=${num(1 + (p.contrast || 0) / 100)}:saturation=${num((p.saturation ?? 100) / 100)}`);
        if (p.temperature) out.push(`colorbalance=rm=${num(p.temperature / 400)}:bm=${num(-p.temperature / 400)}`);
        break;
      }
      case 'color_grade': {
        if (p.exposure) out.push(`exposure=exposure=${num(p.exposure)}`);
        out.push(`eq=contrast=${num(1 + (p.contrast || 0) / 100)}:saturation=${num(((p.saturation ?? 100) / 100) * (1 + (p.vibrance || 0) / 300))}:gamma=${num(Math.max(0.1, 1 + (p.gamma || 0) / 100))}`);
        if (p.hue) out.push(`hue=h=${num(p.hue)}`);
        if (p.temperature || p.tint) out.push(`colorbalance=rm=${num((p.temperature || 0) / 400)}:gm=${num(-(p.tint || 0) / 400)}:bm=${num(-(p.temperature || 0) / 400)}`);
        if (p.shadows || p.highlights || p.lift || p.gain) out.push(`colorlevels=rimin=${num(-(p.lift || 0) / 400)}:gimin=${num(-(p.lift || 0) / 400)}:bimin=${num(-(p.lift || 0) / 400)}:rimax=${num(1 - (p.gain || 0) / 400)}:gimax=${num(1 - (p.gain || 0) / 400)}:bimax=${num(1 - (p.gain || 0) / 400)}`);
        if (p.whites || p.blacks || p.shadows || p.highlights) warnings.add('Color Grade whites/blacks/shadows/highlights are approximated in Studio export');
        break;
      }
      case 'sharpen': if (p.amount > 0) out.push(`unsharp=5:5:${num(Math.min(5, p.amount / 60))}`); break;
      case 'black_white': out.push(`hue=s=${num(1 - (p.mix ?? 100) / 100)}`); break;
      case 'crop': if (p.left + p.right + p.top + p.bottom > 0.01) out.push(`crop=iw*${num(1 - (p.left + p.right) / 100)}:ih*${num(1 - (p.top + p.bottom) / 100)}:iw*${num(p.left / 100)}:ih*${num(p.top / 100)}`); break;
      case 'vignette': if (p.amount > 0) out.push(`vignette=angle=${num(0.2 + (p.amount / 100) * 0.9)}`); break;
      case 'flip': if (p.horizontal >= 0.5) out.push('hflip'); if (p.vertical >= 0.5) out.push('vflip'); break;
      case 'gain': break; // audio effect, handled in the audio chain
      default: warnings.add(`Effect "${e.effectId}" is not supported in Studio export`);
    }
  }
  return out;
}

function atempoChain(speed) {
  const parts = []; let s = speed;
  while (s > 2) { parts.push('atempo=2'); s /= 2; }
  while (s < 0.5) { parts.push('atempo=0.5'); s /= 0.5; }
  if (Math.abs(s - 1) > 0.001) parts.push(`atempo=${num(s)}`);
  return parts;
}

function colTag(hex) { const h = String(hex).replace('#', '').padEnd(6, '0'); return `&H${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}&`.toUpperCase(); }

function transDur(t) { return t && t.type ? Math.max(0.04, t.duration || 1) : 0; }

async function exportProject(project, outPath, { signal, onProgress } = {}) {
  render.ensureFonts();
  const seq = project.sequences.find((s) => s.id === project.activeSequence) || project.sequences[0];
  if (!seq) throw new Error('Project has no sequence');
  const media = Object.fromEntries((project.media || []).map((m) => [m.id, m]));
  const W = seq.width & ~1, H = seq.height & ~1, fps = seq.fps || 30;
  const all = [...seq.videoTracks, ...seq.audioTracks].flatMap((t) => t.clips);
  const dur = Math.max(0.5, ...all.map((c) => c.start + c.duration));
  const warnings = new Set();
  const args = ['-f', 'lavfi', '-i', `color=c=black:s=${W}x${H}:r=${fps}:d=${num(dur)}`, '-f', 'lavfi', '-t', num(dur), '-i', 'anullsrc=r=48000:cl=stereo'];
  let idx = 2; const f = []; let last = '0:v'; const audio = ['1:a']; const texts = [];

  seq.videoTracks.forEach((track, ti) => {
    if (track.muted) return; // hidden track
    for (const c of track.clips) {
      if (c.enabled === false) continue;
      for (const k of ['posX', 'posY', 'scaleX', 'scaleY', 'rotation', 'opacity']) if (hasKeys(c[k])) warnings.add('Keyframed transforms exported at their base value (open in Velo for animation)');
      if (c.type === 3) { texts.push({ c, layer: ti }); continue; }
      if (c.type === 4) { warnings.add('Nested sequences are skipped in Studio export (open in Velo)'); continue; }
      const m = media[c.mediaId];
      if (!m || !fs.existsSync(m.path)) { warnings.add(`Missing media: ${m ? m.name : c.mediaId}`); continue; }
      const speed = c.speed || 1;
      if (c.type === 2 || m.kind === 2 || m.kind === 3) args.push('-loop', '1', '-t', num(c.duration), '-i', m.path);
      else args.push('-ss', num(c.in || 0), '-t', num(c.duration * Math.abs(speed) + 0.1), '-i', m.path);
      const i = idx++;
      const sx = base(c.scaleX, 1), sy = c.uniformScale === false ? base(c.scaleY, 1) : sx;
      const nw = Math.max(2, Math.round(((m.width || W) * Math.abs(sx)) / 2) * 2), nh = Math.max(2, Math.round(((m.height || H) * Math.abs(sy)) / 2) * 2);
      const chain = [`setpts=(PTS-STARTPTS)/${num(Math.abs(speed))}`, `fps=${fps}`, `scale=${nw}:${nh}`, ...effectFilters(c.effects, warnings), 'format=yuva420p'];
      const rot = base(c.rotation, 0);
      if (rot) chain.push(`rotate=${num((rot * Math.PI) / 180)}:c=none:ow=rotw(${num((rot * Math.PI) / 180)}):oh=roth(${num((rot * Math.PI) / 180)})`);
      const op = base(c.opacity, 1);
      if (op < 0.999) chain.push(`colorchannelmixer=aa=${num(op)}`);
      const ti_ = transDur(c.transIn), to = transDur(c.transOut);
      if (ti_) chain.push(`fade=t=in:st=0:d=${num(ti_)}:alpha=${c.transIn.type === 3 ? 0 : 1}`);
      if (to) chain.push(`fade=t=out:st=${num(Math.max(0, c.duration - to))}:d=${num(to)}:alpha=${c.transOut.type === 3 ? 0 : 1}`);
      chain.push(`trim=duration=${num(c.duration)}`, `setpts=PTS+${num(c.start)}/TB`);
      f.push(`[${i}:v]${chain.join(',')}[c${i}]`);
      const x = `(W-w)/2+${num(base(c.posX, 0))}`, y = `(H-h)/2+${num(base(c.posY, 0))}`;
      f.push(`[${last}][c${i}]overlay=x='${x}':y='${y}':enable='between(t,${num(c.start)},${num(c.start + c.duration)})':eof_action=pass[o${i}]`);
      last = `o${i}`;
    }
  });

  // Text clips → one ASS layer composited on top.
  if (texts.length) {
    const assFile = path.join(path.dirname(outPath), `${path.basename(outPath, '.mp4')}.titles.ass`);
    const lines = ['[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${W}`, `PlayResY: ${H}`, 'WrapStyle: 2', 'ScaledBorderAndShadow: yes', '', '[V4+ Styles]',
      'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
      'Style: T,Montserrat,96,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,0,0,5,0,0,0,1', '', '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text'];
    const t2 = (t) => { const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = Math.floor(t % 60), cs = Math.floor((t * 100) % 100); return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`; };
    const argb = (s, d) => { const h = String(s || d).replace('#', ''); return h.length === 8 ? { a: 255 - parseInt(h.slice(0, 2), 16), rgb: '#' + h.slice(2) } : { a: 0, rgb: '#' + h }; };
    for (const { c, layer } of texts) {
      const st = c.text || {}; const col = argb(st.color, 'ffffffff'); const oc = argb(st.outlineColor, 'ff000000');
      const sc = base(c.scaleX, 1); const op = base(c.opacity, 1);
      const alpha = Math.round(255 - (255 - col.a) * op).toString(16).padStart(2, '0');
      const fad = (transDur(c.transIn) || transDur(c.transOut)) ? `\\fad(${Math.round(transDur(c.transIn) * 1000)},${Math.round(transDur(c.transOut) * 1000)})` : '';
      const tags = `{\\an5\\pos(${Math.round(W / 2 + base(c.posX, 0))},${Math.round(H / 2 + base(c.posY, 0))})\\fn${(st.family || 'Montserrat').replace(/[{}\\,]/g, '')}\\fs${Math.round((st.pixelSize || 96) * sc)}\\b${st.bold === false ? 0 : 1}\\i${st.italic ? 1 : 0}\\c${colTag(col.rgb)}\\alpha&H${alpha.toUpperCase()}&\\3c${colTag(oc.rgb)}\\bord${st.outlineWidth || 0}\\frz${-base(c.rotation, 0)}${fad}}`;
      lines.push(`Dialogue: ${layer},${t2(c.start)},${t2(c.start + c.duration)},T,,0,0,0,,${tags}${String(st.text || '').replace(/[{}\\]/g, '').replace(/\n/g, '\\N')}`);
    }
    fs.writeFileSync(assFile, lines.join('\n') + '\n');
    f.push(`[${last}]subtitles=filename='${path.relative(paths.root, assFile).split(path.sep).join('/')}':fontsdir='fonts'[vt]`);
    last = 'vt';
  }
  f.push(`[${last}]format=yuv420p[vout]`);

  seq.audioTracks.forEach((track) => {
    if (track.muted) return;
    for (const c of track.clips) {
      if (c.enabled === false) continue;
      const m = media[c.mediaId];
      if (!m || !fs.existsSync(m.path) || m.hasAudio === false) continue;
      const speed = Math.abs(c.speed || 1);
      args.push('-ss', num(c.in || 0), '-t', num(c.duration * speed + 0.1), '-i', m.path);
      const i = idx++;
      if (hasKeys(c.volume) || hasKeys(track.volume)) warnings.add('Volume keyframes exported at their base value');
      const gainDb = (c.effects || []).filter((e) => e.effectId === 'gain' && e.enabled !== false).reduce((s, e) => s + base(e.params?.gain ?? e.params?.db, 0), 0);
      const chain = ['aresample=48000', 'aformat=channel_layouts=stereo', ...atempoChain(speed), `volume=${num(base(c.volume, 1) * base(track.volume, 1) * 10 ** (gainDb / 20))}`, `atrim=duration=${num(c.duration)}`];
      const ti_ = transDur(c.transIn), to = transDur(c.transOut);
      if (ti_) chain.push(`afade=t=in:st=0:d=${num(ti_)}`);
      if (to) chain.push(`afade=t=out:st=${num(Math.max(0, c.duration - to))}:d=${num(to)}`);
      const ms = Math.round(c.start * 1000);
      chain.push(`adelay=${ms}|${ms}`);
      f.push(`[${i}:a]${chain.join(',')}[a${i}]`);
      audio.push(`a${i}`);
    }
  });
  f.push(`${audio.map((a) => `[${a}]`).join('')}amix=inputs=${audio.length}:duration=first:dropout_transition=0:normalize=0,alimiter=limit=0.95[aout]`);

  const enc = ff.pickEncoder();
  args.push('-filter_complex', f.join(';'), '-map', '[vout]', '-map', '[aout]', '-t', num(dur), '-r', String(fps), ...ff.encoderArgs(enc, 18), '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', outPath);
  await ff.ffmpegWithProgress(args, { totalSec: dur, onProgress, cwd: paths.root, signal });
  return { outPath, duration: dur, warnings: [...warnings] };
}

module.exports = { exportProject };
