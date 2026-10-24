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
const keysOf = (p) => (p && typeof p === 'object' && Array.isArray(p.keys) ? p.keys.filter((k) => Array.isArray(k) && k.length >= 2).map(([t, v]) => [Number(t), Number(v)]).sort((a, b) => a[0] - b[0]) : []);
/**
 * A keyframed value as an FFmpeg expression of time T (clip-local seconds), with the same
 * smoothstep easing Velo and the Studio preview use. `mul`/`add` transform the value.
 */
function kexpr(p, d, T = 't', { mul = 1, add = 0 } = {}) {
  const ks = keysOf(p);
  const v = (x) => num(x * mul + add);
  if (!ks.length) return v(base(p, d));
  let e = v(ks[ks.length - 1][1]);
  for (let i = ks.length - 1; i >= 1; i--) {
    const [t0, v0] = ks[i - 1], [t1, v1] = ks[i]; const span = t1 - t0;
    if (span <= 1e-9) continue;
    const f = `((${T}-${num(t0)})/${num(span)})`;
    e = `if(lt(${T},${num(t1)}),${v(v0)}+${num((v1 - v0) * mul)}*${f}*${f}*(3-2*${f}),${e})`;
  }
  return `if(lt(${T},${num(ks[0][0])}),${v(ks[0][1])},${e})`;
}
/** Value at clip-local time t, same smoothstep easing as the preview and Velo. */
function keyAt(p, t, d) {
  const k = keysOf(p); if (!k.length) return base(p, d);
  if (t <= k[0][0]) return k[0][1];
  for (let i = 1; i < k.length; i++) if (t < k[i][0]) { const [t0, v0] = k[i - 1], [t1, v1] = k[i]; const span = t1 - t0; if (span <= 1e-9) return v1; const f = (t - t0) / span; return v0 + (v1 - v0) * f * f * (3 - 2 * f); }
  return k[k.length - 1][1];
}
const maxAbs = (p, d) => Math.max(Math.abs(base(p, d)), ...keysOf(p).map((k) => Math.abs(k[1])));
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

// Studio transition types → FFmpeg xfade names (types 1–3 are Velo's and use the plain fade filter).
const XFADE = {
  4: 'fadewhite', 5: 'dissolve', 6: 'fadegrays', 7: 'hblur', 8: 'pixelize',
  10: 'wipeleft', 11: 'wiperight', 12: 'wipeup', 13: 'wipedown', 14: 'smoothleft', 15: 'smoothright', 16: 'smoothup', 17: 'smoothdown',
  18: 'wipetl', 19: 'wipetr', 20: 'wipebl', 21: 'wipebr', 22: 'diagtl', 23: 'diagtr', 24: 'diagbl', 25: 'diagbr',
  26: 'radial', 27: 'hlslice', 28: 'hrslice', 29: 'vuslice', 30: 'vdslice', 31: 'circleopen', 32: 'circleclose',
  33: 'horzopen', 34: 'horzclose', 35: 'vertopen', 36: 'vertclose', 40: 'slideleft', 41: 'slideright', 42: 'slideup', 43: 'slidedown',
  44: 'coverleft', 45: 'coverright', 46: 'coverup', 47: 'coverdown', 48: 'squeezeh', 49: 'squeezev',
};
const normWord = (w) => String(w).toLowerCase().replace(/[^a-z0-9$%']/g, '');
/** Start/end of each word in a caption: its own timings, or (text edited, or no timings) spread over the caption by length. */
function hlTimes(st, flat, dur) {
  const ws = Array.isArray(st.words) ? st.words : [];
  if (ws.length && ws.length === flat.length) return ws;
  const total = flat.reduce((n, w) => n + w.length + 1, 0) || 1; let at = 0;
  return flat.map((w) => { const s = at; at += (dur * (w.length + 1)) / total; return { s, e: at }; });
}

let xfadeNames = null;
/** Which xfade transitions this FFmpeg build has (older builds lack some; those fall back to a dissolve). */
async function xfadeSupport() {
  if (xfadeNames) return xfadeNames;
  try {
    const { run } = require('../core/util');
    const r = await run(require('./ffmpeg').bin('ffmpeg'), ['-hide_banner', '-h', 'filter=xfade'], { timeoutMs: 15000 });
    xfadeNames = new Set((r.out.match(/^\s{5,}(\w+)\s+-?\d+/gm) || []).map((l) => l.trim().split(/\s+/)[0]));
  } catch { xfadeNames = new Set(); }
  return xfadeNames;
}

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
  const xf = await xfadeSupport();
  /** xfade against a transparent frame: an In edge brings the clip in, an Out edge takes it out. */
  const xfadeEdge = (label, trans, d, cdur, isOut, w, h, n) => {
    let name = XFADE[trans.type];
    if (!xf.has(name)) { warnings.add(`Transition "${name}" needs a newer FFmpeg; exported as a dissolve`); name = 'fade'; }
    const z = `z${n}`; const outL = `${label}${isOut ? 'o' : 'i'}`;
    f.push(`color=c=black@0.0:s=${w}x${h}:r=${fps}:d=${num(d + 0.1)},format=yuva420p,settb=AVTB[${z}]`);
    f.push(isOut ? `[${label}][${z}]xfade=transition=${name}:duration=${num(d)}:offset=${num(Math.max(0, cdur - d))}[${outL}]` : `[${z}][${label}]xfade=transition=${name}:duration=${num(d)}:offset=0[${outL}]`);
    return outL;
  };

  seq.videoTracks.forEach((track, ti) => {
    if (track.muted) return; // hidden track
    for (const c of track.clips) {
      if (c.enabled === false) continue;
      if (c.type === 3) { texts.push({ c, layer: ti }); continue; }
      if (c.type === 4) { warnings.add('Nested sequences are skipped in Studio export (open in Velo)'); continue; }
      const m = media[c.mediaId];
      if (!m || !fs.existsSync(m.path)) { warnings.add(`Missing media: ${m ? m.name : c.mediaId}`); continue; }
      const speed = c.speed || 1;
      if (c.type === 2 || m.kind === 2 || m.kind === 3) args.push('-loop', '1', '-t', num(c.duration), '-i', m.path);
      else args.push('-ss', num(c.in || 0), '-t', num(c.duration * Math.abs(speed) + 0.1), '-i', m.path);
      const i = idx++;
      const keyed = { scale: hasKeys(c.scaleX) || (c.uniformScale === false && hasKeys(c.scaleY)), pos: hasKeys(c.posX) || hasKeys(c.posY), rot: hasKeys(c.rotation), op: hasKeys(c.opacity) };
      // Keyframed scale renders at its largest size, then shrinks frame by frame (sharp at every size).
      const sx = keyed.scale ? maxAbs(c.scaleX, 1) : base(c.scaleX, 1); const sy = c.uniformScale === false ? (keyed.scale ? maxAbs(c.scaleY, 1) : base(c.scaleY, 1)) : sx;
      const nw = Math.max(2, Math.round(((m.width || W) * Math.abs(sx)) / 2) * 2), nh = Math.max(2, Math.round(((m.height || H) * Math.abs(sy)) / 2) * 2);
      // xfade transitions work in the clip's own frame, right after scaling (the preview does the same).
      const xin = c.transIn?.type && XFADE[c.transIn.type], xout = c.transOut?.type && XFADE[c.transOut.type];
      let src = `${i}:v`;
      if (xin || xout) {
        f.push(`[${i}:v]setpts=(PTS-STARTPTS)/${num(Math.abs(speed))},fps=${fps},scale=${nw}:${nh},format=yuva420p,settb=AVTB,trim=duration=${num(c.duration)}[p${i}]`);
        src = `p${i}`;
        if (xin) src = xfadeEdge(src, c.transIn, Math.min(transDur(c.transIn), c.duration), c.duration, false, nw, nh, `${i}a`);
        if (xout) src = xfadeEdge(src, c.transOut, Math.min(transDur(c.transOut), c.duration), c.duration, true, nw, nh, `${i}b`);
      }
      const chain = [...(src === `${i}:v` ? [`setpts=(PTS-STARTPTS)/${num(Math.abs(speed))}`, `fps=${fps}`, `scale=${nw}:${nh}`] : []), ...effectFilters(c.effects, warnings), 'format=yuva420p'];
      const rot = base(c.rotation, 0);
      if (keyed.rot) chain.push(`rotate=a='${kexpr(c.rotation, 0, 't', { mul: Math.PI / 180 })}':c=none:ow='hypot(iw,ih)':oh='hypot(iw,ih)'`);
      else if (rot) chain.push(`rotate=${num((rot * Math.PI) / 180)}:c=none:ow=rotw(${num((rot * Math.PI) / 180)}):oh=roth(${num((rot * Math.PI) / 180)})`);
      const op = base(c.opacity, 1);
      if (keyed.op) chain.push(`geq=lum='lum(X,Y)':cb='cb(X,Y)':cr='cr(X,Y)':a='alpha(X,Y)*clip(${kexpr(c.opacity, 1, 'T')},0,1)'`);
      else if (op < 0.999) chain.push(`colorchannelmixer=aa=${num(op)}`);
      // Scale animates last (after rotation and opacity, which need a fixed frame size): the rotated frame is sized once at full scale, then shrunk per frame.
      if (keyed.scale) {
        const fx = kexpr(c.scaleX, 1, 't', { mul: 1 / (Math.abs(sx) || 1) }), fy = c.uniformScale === false ? kexpr(c.scaleY, 1, 't', { mul: 1 / (Math.abs(sy) || 1) }) : fx;
        chain.push(`scale=w='max(2,trunc(iw*abs(${fx})/2)*2)':h='max(2,trunc(ih*abs(${fy})/2)*2)':eval=frame`);
      }
      const ti_ = transDur(c.transIn), to = transDur(c.transOut);
      if (ti_ && !xin) chain.push(`fade=t=in:st=0:d=${num(ti_)}:alpha=${c.transIn.type === 3 ? 0 : 1}`);
      if (to && !xout) chain.push(`fade=t=out:st=${num(Math.max(0, c.duration - to))}:d=${num(to)}:alpha=${c.transOut.type === 3 ? 0 : 1}`);
      chain.push(`trim=duration=${num(c.duration)}`, `setpts=PTS+${num(c.start)}/TB`);
      f.push(`[${src}]${chain.join(',')}[c${i}]`);
      // Overlay positions run on the sequence clock, so keyframes (clip-local) are offset by the clip start.
      const lt = `(t-${num(c.start)})`;
      const x = `(W-w)/2+${keyed.pos ? kexpr(c.posX, 0, lt) : num(base(c.posX, 0))}`, y = `(H-h)/2+${keyed.pos ? kexpr(c.posY, 0, lt) : num(base(c.posY, 0))}`;
      f.push(`[${last}][c${i}]overlay=x='${x}':y='${y}':enable='between(t,${num(c.start)},${num(c.start + c.duration)})':eof_action=pass[o${i}]`);
      last = `o${i}`;
    }
  });

  // Text clips → one ASS layer composited on top.
  if (texts.length) {
    const assFile = path.join(path.dirname(outPath), `${path.basename(outPath, '.mp4')}.titles.ass`);
    const lines = ['[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${W}`, `PlayResY: ${H}`, 'WrapStyle: 2', 'ScaledBorderAndShadow: yes', '', '[V4+ Styles]',
      'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
      'Style: T,Montserrat,96,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,0,0,5,0,0,0,1',
      // B = titles with a background box (BorderStyle 3: the outline colour fills an opaque box, \\bord is the padding)
      'Style: B,Montserrat,96,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,3,0,0,5,0,0,0,1', '', '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text'];
    const t2 = (t) => { const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = Math.floor(t % 60), cs = Math.floor((t * 100) % 100); return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`; };
    const argb = (s, d) => { const h = String(s || d).replace('#', ''); return h.length === 8 ? { a: 255 - parseInt(h.slice(0, 2), 16), rgb: '#' + h.slice(2) } : { a: 0, rgb: '#' + h }; };
    const easeOut = (f) => 1 - (1 - f) ** 3;
    for (const { c, layer } of texts) {
      const st = c.text || {}; const fc = require('./fontnames').face(st.family || 'Montserrat', st.bold !== false && require('./captions').HEAVY.has(st.family || 'Montserrat')); const col = argb(st.color, 'ffffffff'); const oc = argb(st.outlineColor, 'ff000000');
      const keyed = ['posX', 'posY', 'scaleX', 'rotation', 'opacity'].some((k) => hasKeys(c[k]));
      // Rounded boxes (TikTok / Instagram titles) are drawn as shapes behind the text; libass boxes are square.
      const round = st.box && (st.boxRadius || 0) > 0 && !keyed;
      const box = st.box && !round ? argb(st.boxColor, 'cc000000') : null;
      const shad = st.shadow ? argb(st.shadowColor, 'b3000000') : null;
      const raw = (st.uppercase ? String(st.text || '').toUpperCase() : String(st.text || '')).replace(/[{}\\]/g, '');
      // Highlight: the word being said ('word', timed by st.words) or chosen keywords, in the highlight colour.
      const mode = ['word', 'keywords'].includes(st.hlMode) ? st.hlMode : null; const hl = argb(st.hlColor, 'fff2c14e');
      const flat = raw.split(/\s+/).filter(Boolean); const times = hlTimes(st, flat, c.duration);
      const kw = new Set((st.keywords || []).map(normWord));
      const bodyAt = (active) => {
        if (!mode) return raw.replace(/\n/g, '\\N');
        let k = 0;
        return raw.split('\n').map((line) => line.split(/\s+/).filter(Boolean).map((w) => { const i = k++; const on = mode === 'word' ? i === active : kw.has(normWord(w)); return on ? `{\\c${colTag(hl.rgb)}}${w}{\\c${colTag(col.rgb)}}` : w; }).join(' ')).join('\\N');
      };
      const activeAt = (lt) => { let a = -1; for (let i = 0; i < times.length; i++) if (lt >= times[i].s) a = i; return a; };
      /** One subtitle event: either the whole title (ASS animates fades/pop/slide), or one frame of a keyframed title. */
      const event = ({ from, to, px, py, sc, op, rot, place, pop = '', fad = '', body = bodyAt(-1) }) => {
        const alpha = Math.round(255 - (255 - col.a) * Math.max(0, Math.min(1, op))).toString(16).padStart(2, '0');
        const look = box ? `\\3c${colTag(box.rgb)}\\3a&H${box.a.toString(16).padStart(2, '0').toUpperCase()}&\\bord${Math.round((st.boxPad ?? 18) * sc)}` : round ? '\\bord0' : `\\3c${colTag(oc.rgb)}\\bord${Math.round((st.outlineWidth || 0) * sc)}`;
        const tags = `{\\an5${place || `\\pos(${Math.round(px)},${Math.round(py)})`}\\fn${fc.name.replace(/[{}\\,]/g, '')}\\fs${Math.max(1, Math.round((st.pixelSize || 96) * sc))}\\fsp${Math.round((st.letterSpacing || 0) * sc)}\\b${fc.bold ? 1 : 0}\\i${st.italic ? 1 : 0}\\c${colTag(col.rgb)}\\alpha&H${alpha.toUpperCase()}&${look}${shad ? `\\shad${Math.round(st.shadow * sc)}\\4c${colTag(shad.rgb)}\\4a&H${shad.a.toString(16).padStart(2, '0').toUpperCase()}&` : '\\shad0'}\\frz${-rot}${pop}${fad}}`;
        lines.push(`Dialogue: ${layer},${t2(from)},${t2(to)},${box ? 'B' : 'T'},,0,0,0,,${tags}${body}`);
      };
      if (round) {
        const sc = base(c.scaleX, 1); const px = W / 2 + base(c.posX, 0), py = H / 2 + base(c.posY, 0); const fsz = Math.max(1, (st.pixelSize || 96) * sc);
        const tl = raw.split('\n'); const m = require('./fontnames').measure(st.family || 'Montserrat', st.bold !== false && require('./captions').HEAVY.has(st.family || 'Montserrat'), fsz, tl);
        const top = py - (tl.length * fsz) / 2; const pad = m.capH * 0.55, padX = m.capH * 0.6; const bc = argb(st.boxColor, 'ffffffff');
        const shapes = tl.map((l, i) => { const bl = top + i * fsz + m.asc; return require('./captions').roundRect(px - m.widths[i] / 2 - padX, bl - m.capH - pad, px + m.widths[i] / 2 + padX, bl + pad * 0.95, st.boxRadius * sc); }).join(' ');
        const fi = transDur(c.transIn), fo = transDur(c.transOut);
        lines.push(`Dialogue: ${layer},${t2(c.start)},${t2(c.start + c.duration)},T,,0,0,0,,{\\an7\\pos(0,0)\\org(${Math.round(px)},${Math.round(py)})\\frz${-base(c.rotation, 0)}${fi || fo ? `\\fad(${Math.round(fi * 1000)},${Math.round(fo * 1000)})` : ''}\\bord0\\shad0\\1c${colTag(bc.rgb)}\\1a&H${bc.a.toString(16).padStart(2, '0').toUpperCase()}&\\p1}${shapes}{\\p0}`);
      }
      if (!keyed) {
        const sc = base(c.scaleX, 1); const px = Math.round(W / 2 + base(c.posX, 0)), py = Math.round(H / 2 + base(c.posY, 0));
        // Spoken-word highlight: one piece per word (the coloured word moves on as it is said); the entrance plays on the first piece, the fade-out on the last.
        const cutsAt = mode === 'word' ? [...new Set(times.map((x) => Math.max(0, Math.min(c.duration, x.s))))].filter((x) => x > 0.01 && x < c.duration - 0.01).sort((a, b) => a - b) : [];
        const edges = [0, ...cutsAt, c.duration];
        for (let k = 0; k < edges.length - 1; k++) {
          const first = k === 0, last = k === edges.length - 2; const fi = first ? transDur(c.transIn) : 0, fo = last ? transDur(c.transOut) : 0;
          event({ from: c.start + edges[k], to: c.start + edges[k + 1], px, py, sc, op: base(c.opacity, 1), rot: base(c.rotation, 0),
            place: first && st.animIn === 'slide' ? `\\move(${px},${py + Math.round(70 * sc)},${px},${py},0,350)` : null,
            pop: first && st.animIn === 'pop' ? '\\fscx60\\fscy60\\t(0,250,\\fscx100\\fscy100)' : '',
            fad: (fi || fo) ? `\\fad(${Math.round(fi * 1000)},${Math.round(fo * 1000)})` : '',
            body: bodyAt(mode === 'word' ? activeAt(edges[k] + 0.001) : -1) });
        }
        continue;
      }
      // Keyframed title: written frame by frame with the same easing as the preview (subtitles can't ease on their own).
      const n = Math.max(1, Math.round(c.duration * fps)); const ti = transDur(c.transIn), to = transDur(c.transOut);
      for (let fr = 0; fr < n; fr++) {
        const lt = fr / fps;
        let sc = keyAt(c.scaleX, lt, 1), op = keyAt(c.opacity, lt, 1); let py = H / 2 + keyAt(c.posY, lt, 0);
        if (ti && lt < ti) op *= lt / ti; if (to && lt > c.duration - to) op *= Math.max(0, (c.duration - lt) / to);
        if (st.animIn === 'pop') sc *= 0.6 + 0.4 * easeOut(Math.min(1, lt / 0.25));
        if (st.animIn === 'slide') py += 70 * sc * (1 - easeOut(Math.min(1, lt / 0.35)));
        event({ from: c.start + lt, to: c.start + (fr + 1) / fps, px: W / 2 + keyAt(c.posX, lt, 0), py, sc, op, rot: Math.round(keyAt(c.rotation, lt, 0) * 10) / 10, body: bodyAt(activeAt(lt)) });
      }
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
      if (hasKeys(track.volume)) warnings.add('Track volume keyframes are exported at their base value');
      const gainDb = (c.effects || []).filter((e) => e.effectId === 'gain' && e.enabled !== false).reduce((s, e) => s + base(e.params?.gain ?? e.params?.db, 0), 0);
      const chain = ['aresample=48000', 'aformat=channel_layouts=stereo', ...atempoChain(speed), (hasKeys(c.volume) ? `volume=volume='${kexpr(c.volume, 1, 't', { mul: base(track.volume, 1) * 10 ** (gainDb / 20) })}':eval=frame` : `volume=${num(base(c.volume, 1) * base(track.volume, 1) * 10 ** (gainDb / 20))}`), `atrim=duration=${num(c.duration)}`];
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

module.exports = { exportProject, xfadeSupport };
