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
const retro = require('./retro');

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

function effectFilters(effects, warnings, w = 1080, h = 1920, view = null) {
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
      default:
        if (retro.IDS.includes(e.effectId)) {
          // Intensity (1-100%): the look laid over the untouched picture at that strength (blended below in the clip's chain).
          const mix = Math.max(0.01, Math.min(1, (p.mix ?? 100) / 100)); const fl = retro.filters(e.effectId, p, w, h, view);
          if (mix < 0.995) out.push({ blend: fl, mix }); else out.push(...fl);
        }
        else warnings.add(`Effect "${e.effectId}" is not supported in Studio export`);
    }
  }
  return out;
}

/** The part of a clip's frame (nw x nh, placed at posX/posY in a W x H sequence) that's on screen, in the clip's pixels. */
function onScreen(nw, nh, px, py, W, H) {
  const left = (W - nw) / 2 + px, top = (H - nh) / 2 + py;
  const x0 = Math.max(0, -left), y0 = Math.max(0, -top), x1 = Math.min(nw, W - left), y1 = Math.min(nh, H - top);
  return x1 - x0 > 16 && y1 - y0 > 16 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
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
/** In and Out lengths that fit inside a clip (the preview's fitTrans in renderer/js/lib/transitions.js). */
function fitTrans(dIn, dOut, dur, keepIn = false) {
  let a = Math.min(dIn, dur), b = Math.min(dOut, dur);
  if (a + b > dur) { if (keepIn) b = Math.max(0, dur - a); else { const k = dur / (a + b); a *= k; b *= k; } }
  return [a, b];
}

// Studio transition types → FFmpeg xfade names. Types 1-2 are plain fades and 3-4 dips (the picture fades to black /
// white; on titles they're fades); the rest are made with xfade against a see-through copy of the clip itself.
// The preview draws the same (renderer/js/lib/transitions.js).
const DIP = { 3: 'black', 4: 'white' };
const shaped = (type) => !!type && type > 4 && !!XFADE[type];
const isPush = (type) => /^slide/.test(XFADE[type] || '');
/**
 * Cuts with a transition: clip A ends where clip B starts on the same video track and B has an In transition (or A an
 * Out one). B's transition plays over A, which carries on under it for that long (more of its footage, or its last
 * frame held), like Premiere's handles; A's own Out is not used. Same as the preview's cutPairs.
 */
function cutPairs(seq) {
  const inOf = new Map(); const tailOf = new Map(); const half = 0.5 / (seq.fps || 30);
  for (const tr of seq.videoTracks || []) {
    if (tr.muted) continue;
    const cs = tr.clips.filter((c) => c.enabled !== false && (c.type === 0 || c.type === 2)).sort((a, b) => a.start - b.start);
    for (let k = 1; k < cs.length; k++) {
      const A = cs[k - 1], B = cs[k];
      if (Math.abs(A.start + A.duration - B.start) > half) continue;
      const t = B.transIn?.type ? B.transIn : A.transOut?.type ? A.transOut : null; if (!t) continue;
      const d = Math.min(transDur(t), B.duration); if (d < 0.04) continue;
      inOf.set(B.id, { type: t.type, duration: d });
      tailOf.set(A.id, { type: t.type, duration: d, ext: DIP[t.type] ? d / 2 : d });
    }
  }
  return { inOf, tailOf };
}
/** A title's transition frame: its box plus room for outlines, shadows and the Slide up / Drop in moves (as the preview). */
function titleFrame(boxW, boxH, size, scale) {
  const w = boxW + 2 * Math.max(0.25 * size, 12 * scale), h = boxH + 2 * Math.max(0.25 * size, 76 * scale);
  return { w: Math.ceil(w / 2) * 2, h: Math.ceil(h / 2) * 2 };
}
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

/**
 * The typewriter's key sound, made here (no sound files): each letter a short click with a low "thock", slightly
 * different every time like a real keyboard; letters typed away (deleting) are softer. Written as one WAV per title.
 */
function typingTrack(hits, dur, file) {
  const sr = 48000; const n = Math.max(1, Math.ceil((dur + 0.2) * sr)); const pcm = new Float32Array(n);
  let seed = 7; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (const { t, soft } of hits) {
    const at = Math.round(t * sr); const g = (soft ? 0.35 : 0.7) * (0.75 + rnd() * 0.5); const f = 150 + rnd() * 90; const nlen = Math.round(0.045 * sr);
    let lp = 0;
    for (let i = 0; i < nlen && at + i < n; i++) {
      const x = i / sr; lp += 0.55 * ((rnd() * 2 - 1) - lp); // a little filtered noise: the click
      pcm[at + i] += g * (lp * Math.exp(-x * 160) * 0.9 + Math.sin(2 * Math.PI * f * x) * Math.exp(-x * 70) * 0.5);
    }
  }
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVEfmt ', 8); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(pcm[i] * 32767))), 44 + i * 2);
  fs.writeFileSync(file, buf);
  return file;
}
/**
 * Title entrances and exits at a moment (lt seconds into a dur-second title): scale, vertical shift (x size), opacity
 * and blur. Same numbers as the Studio preview (renderer/js/modules/studio.js textAnim).
 * In: pop, slide (up), drop (down), zoom, blur, type (fade in is the title's fade).  Out: fadeout, popout, slideout, zoomout, blurout, untype.
 */
const IN_S = { pop: 0.25, slide: 0.35, drop: 0.35, zoom: 0.3, blur: 0.35 }; const OUT_S = 0.3;
/** How long the entrance and exit take (animInDur / animOutDur, fitted so both fit in the title's length). */
function animLens(st, dur) {
  const ai = IN_S[st.animIn] ? Math.max(0.05, Number(st.animInDur) || IN_S[st.animIn]) : 0;
  const ao = st.animOut && st.animOut !== 'none' && st.animOut !== 'untype' ? Math.max(0.05, Number(st.animOutDur) || OUT_S) : 0;
  const k = dur && ai + ao > dur ? dur / (ai + ao) : 1; return [ai * k, ao * k];
}
const animDist = (st) => (st.animDist != null && st.animDist !== '' && Number.isFinite(Number(st.animDist)) ? Number(st.animDist) : 70);
const animAmt = (st) => (Number(st.animAmt) > 0 ? Number(st.animAmt) : 1);
function textAnim(st, lt, dur) {
  const eo = (f) => 1 - (1 - f) ** 3; const r = { sc: 1, dy: 0, op: 1, blur: 0 }; const [li, lo] = animLens(st, dur); const dist = animDist(st), amt = animAmt(st);
  const ai = st.animIn; const pi = li ? eo(Math.min(1, Math.max(0, lt) / li)) : 1;
  if (ai === 'pop') r.sc *= Math.max(0.02, 1 - 0.4 * amt) + Math.min(0.98, 0.4 * amt) * pi; if (ai === 'slide') r.dy += dist * (1 - pi); if (ai === 'drop') r.dy -= dist * (1 - pi);
  if (ai === 'zoom') { r.sc *= 1 + 0.6 * amt * (1 - pi); r.op *= pi; } if (ai === 'blur') { r.blur += 18 * amt * (1 - pi); r.op *= pi; }
  const ao = st.animOut; if (lo && dur) {
    const po = Math.min(1, Math.max(0, (lt - (dur - lo)) / lo)); const e = po * po;
    if (ao === 'popout') r.sc *= 1 - Math.min(0.98, 0.7 * amt) * e; if (ao === 'zoomout') r.sc *= 1 + 0.7 * amt * e; if (ao === 'slideout') r.dy += dist * e; if (ao === 'blurout') r.blur += 18 * amt * e;
    r.op *= 1 - po;
  }
  return r;
}
/** The same as ASS tags for a whole subtitle piece (first piece: entrance; last piece: exit; L = piece length in ms; dur = the title's length). */
function animTags(st, first, last, L, px, py, sc, dur) {
  let place = null, tags = '', fi = 0, fo = 0; const [li, lo] = animLens(st, dur); const dist = Math.round(animDist(st) * sc), amt = animAmt(st);
  const I = Math.round(li * 1000), pct = (v) => Math.max(1, Math.round(v * 100));
  if (first && li) {
    if (st.animIn === 'slide') place = `\\move(${px},${py + dist},${px},${py},0,${I})`;
    if (st.animIn === 'drop') place = `\\move(${px},${py - dist},${px},${py},0,${I})`;
    if (st.animIn === 'pop') { const v = pct(Math.max(0.02, 1 - 0.4 * amt)); tags += `\\fscx${v}\\fscy${v}\\t(0,${I},\\fscx100\\fscy100)`; }
    if (st.animIn === 'zoom') { const v = pct(1 + 0.6 * amt); tags += `\\fscx${v}\\fscy${v}\\t(0,${I},\\fscx100\\fscy100)`; fi = li; }
    if (st.animIn === 'blur') { tags += `\\blur${Math.round(18 * amt)}\\t(0,${I},\\blur0)`; fi = li; }
  }
  if (last && lo) {
    const O = Math.round(lo * 1000); const a = Math.max(0, L - O); fo = lo;
    if (st.animOut === 'popout') { const v = pct(1 - Math.min(0.98, 0.7 * amt)); tags += `\\t(${a},${L},\\fscx${v}\\fscy${v})`; }
    if (st.animOut === 'zoomout') { const v = pct(1 + 0.7 * amt); tags += `\\t(${a},${L},\\fscx${v}\\fscy${v})`; }
    if (st.animOut === 'blurout') tags += `\\t(${a},${L},\\blur${Math.round(18 * amt)})`;
    if (st.animOut === 'slideout' && !place) place = `\\move(${px},${py},${px},${py + dist},${a},${L})`;
  }
  return { place, tags, fi, fo };
}

/** When each letter appears (typing in) and goes (typing away), the same timing as the picture. */
function typeHits(st, dur, nChars, cps, chars) {
  const hits = [];
  if (st.animIn === 'type') for (let k = 0; k < nChars; k++) if (/\S/.test(chars[k] || '')) hits.push({ t: k / cps + 1 / cps, soft: false });
  if (st.animOut === 'untype') for (let k = 0; k < nChars; k++) if (/\S/.test(chars[nChars - 1 - k] || '')) hits.push({ t: dur - (k + 1) / cps, soft: true });
  return hits.filter((h) => h.t >= 0 && h.t <= dur);
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
  const scratch = []; // title and typing-sound files made for this export, removed when it's done
  const scratchFile = (name) => { const f = path.join(path.dirname(outPath), `${path.basename(outPath, '.mp4')}.${name}`); scratch.push(f); return f; };
  const args = ['-f', 'lavfi', '-i', `color=c=black:s=${W}x${H}:r=${fps}:d=${num(dur)}`, '-f', 'lavfi', '-t', num(dur), '-i', 'anullsrc=r=48000:cl=stereo'];
  let idx = 2; const f = []; let last = '0:v'; const audio = ['1:a']; const texts = []; const typeSounds = [];
  const xf = await xfadeSupport();
  /**
   * xfade against a see-through copy of the clip itself (the same frames, alpha 0): an In edge brings the clip in, an
   * Out edge takes it out, and only how much of it shows changes. (Against see-through black, soft edges, dissolves and
   * the gray fade went dark.) cdur = the stream's length; the Out copy is cut from the same moment so colours line up.
   */
  const xfadeEdge = (label, type, d, cdur, isOut, n) => {
    let name = XFADE[type];
    if (!xf.has(name)) { warnings.add(`Transition "${name}" needs a newer FFmpeg; exported as a dissolve`); name = 'fade'; }
    const a = `x${n}a`, z0 = `x${n}b`, z = `x${n}z`; const outL = `${label}${isOut ? 'o' : 'i'}`;
    f.push(`[${label}]split[${a}][${z0}]`);
    f.push(isOut ? `[${z0}]trim=start=${num(Math.max(0, cdur - d))},setpts=PTS-STARTPTS,lutyuv=a=0[${z}]` : `[${z0}]trim=duration=${num(d)},lutyuv=a=0[${z}]`);
    f.push(isOut ? `[${a}][${z}]xfade=transition=${name}:duration=${num(d)}:offset=${num(Math.max(0, cdur - d))}[${outL}]` : `[${z}][${a}]xfade=transition=${name}:duration=${num(d)}:offset=0[${outL}]`);
    return outL;
  };
  const pairs = cutPairs(seq);

  // Effect layers (like Premiere's adjustment layer): the picture built so far (every track below) is copied for the
  // layer's time, run through its effects, and laid back over the top at the layer's opacity (times each retro look's
  // intensity). Titles are burned in last, so they're never affected. Effect times run from the layer's start, as in
  // the preview.
  let fxN = 0;
  const fxLayer = (c) => {
    const fl = effectFilters(c.effects, warnings, W, H, null);
    let mix = Math.max(0, Math.min(1, base(c.opacity, 1))); const chain = [];
    for (const x of fl) { if (typeof x === 'string') chain.push(x); else { chain.push(...x.blend); mix *= x.mix; } }
    if (!chain.length || mix <= 0.001 || !(c.duration > 0)) return;
    const n = fxN++; const s0 = num(c.start), e0 = num(c.start + c.duration);
    f.push(`[${last}]split[fx${n}a][fx${n}b]`);
    f.push(`[fx${n}b]trim=start=${s0}:end=${e0},setpts=PTS-STARTPTS,${chain.join(',')},scale=${W}:${H},format=yuva420p${mix < 0.999 ? `,colorchannelmixer=aa=${num(mix)}` : ''},setpts=PTS+${s0}/TB[fx${n}c]`);
    f.push(`[fx${n}a][fx${n}c]overlay=0:0:enable='between(t,${s0},${e0})':eof_action=pass[fx${n}o]`);
    last = `fx${n}o`;
  };
  seq.videoTracks.forEach((track, ti) => {
    if (track.muted) return; // hidden track
    // In time order, so the clip before a cut is laid down before the clip whose transition plays over it.
    for (const c of [...track.clips].sort((a, b) => a.start - b.start)) {
      if (c.enabled === false) continue;
      if (c.type === 3) { texts.push({ c, layer: ti }); continue; }
      if (c.type === 5) { fxLayer(c); continue; }
      if (c.type === 4) { warnings.add('Nested sequences are skipped in Studio export (open in Velo)'); continue; }
      const m = media[c.mediaId];
      if (!m || !fs.existsSync(m.path)) { warnings.add(`Missing media: ${m ? m.name : c.mediaId}`); continue; }
      const speed = c.speed || 1;
      // Transitions: B's In at a cut (pin) plays over A, which carries on for `tail.ext` (its Out then isn't used).
      const pin = pairs.inOf.get(c.id), tail = pairs.tailOf.get(c.id);
      const tin = pin || (c.transIn?.type ? c.transIn : null), tout = tail ? null : (c.transOut?.type ? c.transOut : null);
      const [dIn, dOut] = fitTrans(tin ? transDur(tin) : 0, tout ? transDur(tout) : 0, c.duration, !!pin);
      const ext = tail ? tail.ext : 0; const total = c.duration + ext; // how long this clip is on screen
      const still = c.type === 2 || m.kind === 2 || m.kind === 3;
      if (still) args.push('-loop', '1', '-t', num(total), '-i', m.path);
      else args.push('-ss', num(c.in || 0), '-t', num(total * Math.abs(speed) + 0.1), '-i', m.path);
      // Footage that runs out during a tail holds its last frame.
      const hold = ext && !still ? [`tpad=stop_mode=clone:stop_duration=${num(ext + 0.1)}`] : [];
      const i = idx++;
      const keyed = { scale: hasKeys(c.scaleX) || (c.uniformScale === false && hasKeys(c.scaleY)), pos: hasKeys(c.posX) || hasKeys(c.posY), rot: hasKeys(c.rotation), op: hasKeys(c.opacity) };
      // Keyframed scale renders at its largest size, then shrinks frame by frame (sharp at every size).
      const sx = keyed.scale ? maxAbs(c.scaleX, 1) : base(c.scaleX, 1); const sy = c.uniformScale === false ? (keyed.scale ? maxAbs(c.scaleY, 1) : base(c.scaleY, 1)) : sx;
      const nw = Math.max(2, Math.round(((m.width || W) * Math.abs(sx)) / 2) * 2), nh = Math.max(2, Math.round(((m.height || H) * Math.abs(sy)) / 2) * 2);
      // xfade transitions work in the clip's own frame, right after scaling (the preview does the same).
      const xin = tin && shaped(tin.type), xout = (tout && shaped(tout.type)) || (tail && isPush(tail.type)); // a push moves A out too
      let src = `${i}:v`;
      if (xin || xout) {
        f.push(`[${i}:v]setpts=(PTS-STARTPTS)/${num(Math.abs(speed))},fps=${fps},${hold.map((x) => x + ',').join('')}scale=${nw}:${nh},format=yuva420p,settb=AVTB,trim=duration=${num(total)}[p${i}]`);
        src = `p${i}`;
        if (xin) src = xfadeEdge(src, tin.type, dIn, total, false, `${i}a`);
        if (xout) src = tail ? xfadeEdge(src, tail.type, tail.duration, total, true, `${i}b`) : xfadeEdge(src, tout.type, dOut, total, true, `${i}b`);
      }
      // Effects; a retro look below 100% intensity is made on a copy and blended over the untouched picture.
      let chain = [...(src === `${i}:v` ? [`setpts=(PTS-STARTPTS)/${num(Math.abs(speed))}`, `fps=${fps}`, ...hold, `scale=${nw}:${nh}`] : [])];
      effectFilters(c.effects, warnings, nw, nh, onScreen(nw, nh, base(c.posX, 0), base(c.posY, 0), W, H)).forEach((x, n) => {
        if (typeof x === 'string') { chain.push(x); return; }
        const L = `${i}m${n}`;
        f.push(`[${src}]${[...chain, 'format=yuv420p'].join(',')},split[${L}a][${L}b]`);
        f.push(`[${L}b]${x.blend.join(',')},format=yuv420p[${L}c]`);
        f.push(`[${L}a][${L}c]blend=all_expr='A*${num(1 - x.mix)}+B*${num(x.mix)}'[${L}d]`);
        src = `${L}d`; chain = [];
      });
      chain.push('format=yuva420p');
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
      // Fades see through to what's below; dips fade the picture to black or white. At a cut, a dip takes A to the
      // colour in the first half (its tail) and brings B out of it in the second (B starts showing half way).
      if (tin && !xin) chain.push(DIP[tin.type] ? (pin ? `fade=t=in:st=${num(dIn / 2)}:d=${num(dIn / 2)}:color=${DIP[tin.type]}` : `fade=t=in:st=0:d=${num(dIn)}:color=${DIP[tin.type]}`) : `fade=t=in:st=0:d=${num(dIn)}:alpha=1`);
      if (tail && DIP[tail.type]) chain.push(`fade=t=out:st=${num(c.duration)}:d=${num(ext)}:color=${DIP[tail.type]}`);
      if (tout && !shaped(tout.type)) chain.push(DIP[tout.type] ? `fade=t=out:st=${num(c.duration - dOut)}:d=${num(dOut)}:color=${DIP[tout.type]}` : `fade=t=out:st=${num(c.duration - dOut)}:d=${num(dOut)}:alpha=1`);
      chain.push(`trim=duration=${num(total)}`, `setpts=PTS+${num(c.start)}/TB`);
      f.push(`[${src}]${chain.join(',')}[c${i}]`);
      // Overlay positions run on the sequence clock, so keyframes (clip-local) are offset by the clip start.
      const lt = `(t-${num(c.start)})`;
      const x = `(W-w)/2+${keyed.pos ? kexpr(c.posX, 0, lt) : num(base(c.posX, 0))}`, y = `(H-h)/2+${keyed.pos ? kexpr(c.posY, 0, lt) : num(base(c.posY, 0))}`;
      const from = pin && DIP[pin.type] ? c.start + dIn / 2 : c.start;
      f.push(`[${last}][c${i}]overlay=x='${x}':y='${y}':enable='between(t,${num(from)},${num(c.start + total)})':eof_action=pass[o${i}]`);
      last = `o${i}`;
    }
  });

  // Text clips → one ASS layer composited on top.
  if (texts.length) {
    const assFile = scratchFile('titles.ass');
    const header = (pw, ph) => ['[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${pw}`, `PlayResY: ${ph}`, 'WrapStyle: 2', 'ScaledBorderAndShadow: yes', '', '[V4+ Styles]',
      'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
      'Style: T,Montserrat,96,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,0,0,5,0,0,0,1',
      // B = titles with a background box (BorderStyle 3: the outline colour fills an opaque box, \\bord is the padding)
      'Style: B,Montserrat,96,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,3,0,0,5,0,0,0,1', '', '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text'];
    const lines = header(W, H); const head = lines.length;
    // Titles with a wipe, slide, iris... (not a fade) each get their own see-through layer: drawn by libass on a canvas
    // the size of the title's transition frame (its box, or the whole picture when it's keyframed), given the
    // transition like a picture clip, turned, and laid on top before the other titles.
    const own = [];
    const t2 = (t) => { const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = Math.floor(t % 60), cs = Math.floor((t * 100) % 100); return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`; };
    const argb = (s, d) => { const h = String(s || d).replace('#', ''); return h.length === 8 ? { a: 255 - parseInt(h.slice(0, 2), 16), rgb: '#' + h.slice(2) } : { a: 0, rgb: '#' + h }; };
    const easeOut = (f) => 1 - (1 - f) ** 3;
    for (const { c, layer } of texts) {
      const st = c.text || {}; const heavy = st.bold !== false && require('./captions').HEAVY.has(st.family || 'Montserrat');
      const fc = require('./fontnames').face(st.family || 'Montserrat', heavy);
      // The preview's size is the em; libass's is the Windows line height, so scale it up (fit.k) and line the baseline up (fit.dy).
      const fit = require('./fontnames').emFit(st.family || 'Montserrat', heavy); const col = argb(st.color, 'ffffffff'); const oc = argb(st.outlineColor, 'ff000000');
      const keyed = ['posX', 'posY', 'scaleX', 'rotation', 'opacity'].some((k) => hasKeys(c[k]));
      // Rounded boxes (TikTok / Instagram titles) are drawn as shapes behind the text; libass boxes are square.
      // Boxes are drawn as shapes the same size as the preview's (rounded or square); keyframed titles keep libass boxes.
      const round = st.box && !keyed;
      const box = st.box && !round ? argb(st.boxColor, 'cc000000') : null;
      const shad = st.shadow ? argb(st.shadowColor, 'b3000000') : null;
      const raw = (st.uppercase ? String(st.text || '').toUpperCase() : String(st.text || '')).replace(/[{}\\]/g, '');
      const shIn = shaped(c.transIn?.type) ? c.transIn : null, shOut = shaped(c.transOut?.type) ? c.transOut : null;
      const [tIn, tOut] = fitTrans(transDur(c.transIn), transDur(c.transOut), c.duration); // fitted inside the title
      const fadeIn = shIn ? 0 : tIn, fadeOut = shOut ? 0 : tOut; // types 1-4 fade a title
      let frame = null; // a title with its own layer: { w, h, ox, oy } (ox/oy move its positions onto that canvas)
      if (shIn || shOut) {
        if (keyed) frame = { w: W, h: H, ox: 0, oy: 0, full: true };
        else {
          const sc = base(c.scaleX, 1); const size = Math.max(1, (st.pixelSize || 96) * sc); const tl = raw.split('\n');
          const m = require('./fontnames').measure(st.family || 'Montserrat', heavy, size * fit.k, tl);
          const ls = (st.letterSpacing || 0) * sc; const pad = st.box ? (st.boxPad ?? 18) * sc : (st.outlineWidth || 0) * sc;
          const bw = Math.max(size, ...tl.map((l, i) => (m.widths[i] || 0) + ls * [...l].length)) + pad * 2, bh = tl.length * size * 1.15 + pad * 1.2;
          const tf = titleFrame(bw, bh, size, sc); const px0 = W / 2 + base(c.posX, 0), py0 = H / 2 + base(c.posY, 0);
          frame = { ...tf, ox: tf.w / 2 - px0, oy: tf.h / 2 - py0, px0, py0 };
        }
      }
      const out = frame ? [] : lines; const shift = frame ? c.start : 0; const OX = frame ? frame.ox : 0, OY = frame ? frame.oy : 0;
      if (frame) own.push({ c, frame, events: out, shIn, shOut, tIn, tOut, rot: frame.full ? 0 : base(c.rotation, 0) });
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
      // Typewriter: letters appear one by one (animIn 'type') and/or delete back out at the end (animOut 'untype'). The
      // whole title is laid out and the letters not typed (yet) are see-through, so every letter sits where it ends up.
      const nChars = [...raw.replace(/\n/g, '')].length;
      // Typing in and out of a short clip speeds up so the whole title is still up for at least ~30% of its time.
      const cps = Math.max(Math.max(4, Math.min(60, Number(st.typeSpeed) || 18)), (nChars * ((st.animIn === 'type' ? 1 : 0) + (st.animOut === 'untype' ? 1 : 0))) / Math.max(0.2, c.duration * 0.7));
      const typing = st.animIn === 'type' || st.animOut === 'untype';
      // The typing sound (on unless switched off in the title designer), mixed in with the rest of the sound below.
      if (typing && st.typeSound !== false) {
        const chars = [...raw.replace(/\n/g, '')]; const hits = typeHits(st, c.duration, nChars, cps, chars);
        if (hits.length) typeSounds.push({ file: typingTrack(hits, c.duration, scratchFile(`type${typeSounds.length}.wav`)), start: c.start, vol: Math.max(0, Math.min(2, st.typeVol ?? 0.7)) });
      }
      const shownAt = (lt) => Math.max(0, Math.min(nChars, st.animIn === 'type' ? Math.floor(lt * cps + 1e-6) : nChars, st.animOut === 'untype' ? Math.floor((c.duration - lt) * cps + 1e-6) : nChars));
      /** One line of the body with only its first n letters showing; returns [text, letters left for the next lines]. */
      const typedPart = (part, n) => {
        let out = ''; let seen = 0; let hidden = n <= 0;
        if (hidden) return [`{\\alpha&HFF&}${part}`, n];
        for (let i = 0; i < part.length; i++) {
          if (part[i] === '{') { const j = part.indexOf('}', i); out += part.slice(i, j + 1); i = j; continue; }
          if (!hidden && seen === n) { out += '{\\alpha&HFF&}'; hidden = true; }
          out += part[i]; seen++;
        }
        return [out, n - seen];
      };
      /** One subtitle event: either the whole title (ASS animates fades/pop/slide), or one frame of a keyframed title. */
      const event = ({ from, to, px, py, sc, op, rot, place, pop = '', fad = '', body = bodyAt(-1), shown = null }) => {
        const alpha = Math.round(255 - (255 - col.a) * Math.max(0, Math.min(1, op))).toString(16).padStart(2, '0');
        const look = box ? `\\3c${colTag(box.rgb)}\\3a&H${box.a.toString(16).padStart(2, '0').toUpperCase()}&\\bord${Math.round((st.boxPad ?? 18) * sc)}` : round ? '\\bord0' : `\\3c${colTag(oc.rgb)}\\bord${Math.round((st.outlineWidth || 0) * sc)}`;
        const size = (st.pixelSize || 96) * sc; const parts = body.split('\\N'); const lh = size * 1.15;
        // Boxed lines: every line's box first, then the text on top (otherwise a lower line's box covers the line above).
        for (const pass of box ? ['box', 'text'] : ['text']) { let left = shown; parts.forEach((part0, i) => {
        let part = part0; if (pass === 'text' && shown != null) [part, left] = typedPart(part0, left);
        // One event per line, spaced like the preview (1.15 x size), turned around the title's centre.
        const off = (i - (parts.length - 1) / 2) * lh + fit.dy * size;
        const at = place ? place.replace(/\\move\(([-\d.]+),([-\d.]+),([-\d.]+),([-\d.]+)/, (_, a, b, c2, d) => `\\move(${a},${Math.round(+b + off)},${c2},${Math.round(+d + off)}`) : `\\pos(${Math.round(px)},${Math.round(py + off)})`;
        const tags = `{\\an5${at}\\org(${Math.round(px)},${Math.round(py)})\\fn${fc.name.replace(/[{}\\,]/g, '')}\\fs${Math.max(1, Math.round(size * fit.k))}\\fsp${Math.round((st.letterSpacing || 0) * sc)}\\b${fc.bold ? 1 : 0}\\i${st.italic ? 1 : 0}\\c${colTag(col.rgb)}${pass === 'box' ? `\\1a&HFF&\\3a&H${box.a.toString(16).padStart(2, '0').toUpperCase()}&` : `\\alpha&H${alpha.toUpperCase()}&`}${pass === 'box' ? look : box ? '\\bord0' : look}${shad ? `\\shad${Math.round(st.shadow * sc)}\\4c${colTag(shad.rgb)}\\4a&H${shad.a.toString(16).padStart(2, '0').toUpperCase()}&` : '\\shad0'}\\frz${-rot}${pop}${fad}}`;
        out.push(`Dialogue: ${layer},${t2(from - shift)},${t2(to - shift)},${pass === 'box' ? 'B' : 'T'},,0,0,0,,${tags}${part}`);
        }); }
      };
      if (round) {
        // Same geometry as the preview (drawText): rounded = one box per line, square = one box around all lines.
        const sc = base(c.scaleX, 1); const px = W / 2 + base(c.posX, 0) + OX, py = H / 2 + base(c.posY, 0) + OY; const size = Math.max(1, (st.pixelSize || 96) * sc);
        const tl = raw.split('\n'); const m = require('./fontnames').measure(st.family || 'Montserrat', heavy, size * fit.k, tl);
        const ls = (st.letterSpacing || 0) * sc; const wOf = (i) => m.widths[i] + ls * [...tl[i]].length;
        const lh = size * 1.15; const pad = (st.boxPad ?? 18) * sc; const bc = argb(st.boxColor, (st.boxRadius || 0) > 0 ? 'ffffffff' : 'cc000000');
        const shapes = (st.boxRadius || 0) > 0
          ? tl.map((l, i) => { const y = py + (i - (tl.length - 1) / 2) * lh; return require('./captions').roundRect(px - wOf(i) / 2 - pad, y - lh / 2, px + wOf(i) / 2 + pad, y + lh / 2, st.boxRadius * sc); }).join(' ')
          : (() => { const w = Math.max(...tl.map((l, i) => wOf(i))); const hh = (tl.length * lh) / 2 + pad * 0.6; const r = (v) => Math.round(v); return `m ${r(px - w / 2 - pad)} ${r(py - hh)} l ${r(px + w / 2 + pad)} ${r(py - hh)} ${r(px + w / 2 + pad)} ${r(py + hh)} ${r(px - w / 2 - pad)} ${r(py + hh)}`; })();
        const fi = fadeIn, fo = fadeOut;
        out.push(`Dialogue: ${layer},${t2(c.start - shift)},${t2(c.start + c.duration - shift)},T,,0,0,0,,{\\an7\\pos(0,0)\\org(${Math.round(px)},${Math.round(py)})\\frz${-(frame ? 0 : base(c.rotation, 0))}${fi || fo ? `\\fad(${Math.round(fi * 1000)},${Math.round(fo * 1000)})` : ''}\\bord0\\shad0\\1c${colTag(bc.rgb)}\\1a&H${bc.a.toString(16).padStart(2, '0').toUpperCase()}&\\p1}${shapes}{\\p0}`);
      }
      if (!keyed) {
        const sc = base(c.scaleX, 1); const px = Math.round(W / 2 + base(c.posX, 0) + OX), py = Math.round(H / 2 + base(c.posY, 0) + OY);
        // Spoken-word highlight: one piece per word (the coloured word moves on as it is said); the entrance plays on the first piece, the fade-out on the last.
        // (and with the typewriter, one piece per letter typed)
        const typeCuts = typing ? Array.from({ length: nChars }, (_, k) => [st.animIn === 'type' ? (k + 1) / cps : -1, st.animOut === 'untype' ? c.duration - (k + 1) / cps : -1]).flat() : [];
        const cutsAt = [...new Set([...(mode === 'word' ? times.map((x) => Math.max(0, Math.min(c.duration, x.s))) : []), ...typeCuts].map((x) => Math.round(x * 1000) / 1000))].filter((x) => x > 0.01 && x < c.duration - 0.01).sort((a, b) => a - b);
        // An exit gets its own last piece (its last 0.3 s), so it plays at the end even when the words highlight before it.
        const outLen = animLens(st, c.duration)[1]; const outCut = outLen && c.duration > outLen + 0.05 ? [Math.round((c.duration - outLen) * 1000) / 1000] : [];
        const edges = [0, ...[...new Set([...cutsAt, ...outCut])].sort((a, b) => a - b), c.duration];
        for (let k = 0; k < edges.length - 1; k++) {
          const first = k === 0, last = k === edges.length - 2;
          const an = animTags(st, first, last, Math.round((edges[k + 1] - edges[k]) * 1000), px, py, sc, c.duration);
          const fi = first ? Math.max(fadeIn, an.fi) : 0, fo = last ? Math.max(fadeOut, an.fo) : 0;
          event({ from: c.start + edges[k], to: c.start + edges[k + 1], px, py, sc, op: base(c.opacity, 1), rot: frame ? 0 : base(c.rotation, 0),
            place: an.place, pop: an.tags,
            fad: (fi || fo) ? `\\fad(${Math.round(fi * 1000)},${Math.round(fo * 1000)})` : '',
            body: bodyAt(mode === 'word' ? activeAt(edges[k] + 0.001) : -1), shown: typing ? shownAt(edges[k] + 0.001) : null });
        }
        continue;
      }
      // Keyframed title: written frame by frame with the same easing as the preview (subtitles can't ease on their own).
      const n = Math.max(1, Math.round(c.duration * fps)); const ti = fadeIn, to = fadeOut;
      for (let fr = 0; fr < n; fr++) {
        const lt = fr / fps;
        let sc = keyAt(c.scaleX, lt, 1), op = keyAt(c.opacity, lt, 1); let py = H / 2 + keyAt(c.posY, lt, 0);
        if (ti && lt < ti) op *= lt / ti; if (to && lt > c.duration - to) op *= Math.max(0, (c.duration - lt) / to);
        const an = textAnim(st, lt, c.duration); sc *= an.sc; op *= an.op; py += an.dy * sc;
        event({ from: c.start + lt, to: c.start + (fr + 1) / fps, px: W / 2 + keyAt(c.posX, lt, 0), py, sc, op, rot: Math.round(keyAt(c.rotation, lt, 0) * 10) / 10, body: bodyAt(activeAt(lt)), shown: typing ? shownAt(lt) : null });
      }
    }
    const rel = (file) => path.relative(paths.root, file).split(path.sep).join('/');
    own.forEach(({ c, frame, events: ev, shIn, shOut, tIn, tOut, rot }, n) => {
      const file = scratchFile(`title${n}.ass`);
      fs.writeFileSync(file, [...header(frame.w, frame.h), ...ev].join('\n') + '\n');
      let s = `tt${n}`;
      f.push(`color=c=black@0.0:s=${frame.w}x${frame.h}:r=${fps}:d=${num(c.duration)},format=yuva420p,subtitles=filename='${rel(file)}':fontsdir='fonts':alpha=1,settb=AVTB[${s}]`);
      if (shIn) s = xfadeEdge(s, shIn.type, tIn, c.duration, false, `t${n}a`);
      if (shOut) s = xfadeEdge(s, shOut.type, tOut, c.duration, true, `t${n}b`);
      const r = (rot * Math.PI) / 180; const ch = [];
      if (Math.abs(rot) > 0.01) ch.push(`rotate=${num(r)}:c=none:ow=rotw(${num(r)}):oh=roth(${num(r)})`);
      ch.push(`trim=duration=${num(c.duration)}`, `setpts=PTS+${num(c.start)}/TB`);
      f.push(`[${s}]${ch.join(',')}[tc${n}]`);
      const x = frame.full ? '0' : `${num(frame.px0)}-w/2`, y = frame.full ? '0' : `${num(frame.py0)}-h/2`;
      f.push(`[${last}][tc${n}]overlay=x='${x}':y='${y}':enable='between(t,${num(c.start)},${num(c.start + c.duration)})':eof_action=pass[to${n}]`);
      last = `to${n}`;
    });
    if (lines.length > head) {
      fs.writeFileSync(assFile, lines.join('\n') + '\n');
      f.push(`[${last}]subtitles=filename='${rel(assFile)}':fontsdir='fonts'[vt]`);
      last = 'vt';
    }
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
      const [ti_, to] = fitTrans(transDur(c.transIn), transDur(c.transOut), c.duration);
      if (ti_) chain.push(`afade=t=in:st=0:d=${num(ti_)}`);
      if (to) chain.push(`afade=t=out:st=${num(Math.max(0, c.duration - to))}:d=${num(to)}`);
      const ms = Math.round(c.start * 1000);
      chain.push(`adelay=${ms}|${ms}`);
      f.push(`[${i}:a]${chain.join(',')}[a${i}]`);
      audio.push(`a${i}`);
    }
  });
  for (const ts of typeSounds) {
    args.push('-i', ts.file); const i = idx++; const ms = Math.round(ts.start * 1000);
    f.push(`[${i}:a]aresample=48000,aformat=channel_layouts=stereo,volume=${num(ts.vol)},adelay=${ms}|${ms}[ty${i}]`); audio.push(`ty${i}`);
  }
  f.push(`${audio.map((a) => `[${a}]`).join('')}amix=inputs=${audio.length}:duration=first:dropout_transition=0:normalize=0,alimiter=limit=0.95[aout]`);

  const enc = ff.pickEncoder();
  const run = (e) => ff.ffmpegWithProgress([...args, '-filter_complex', f.join(';'), '-map', '[vout]', '-map', '[aout]', '-t', num(dur), '-r', String(fps), ...ff.encoderArgs(e, 18), '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', outPath], { totalSec: dur, onProgress, cwd: paths.root, signal });
  try {
    try { await run(enc); } catch (err) {
      // The graphics card's encoder (NVENC/QSV/AMF) can refuse a job now and then (busy with a render, a driver hiccup).
      // Only then is the export made again on the computer's own encoder; exports that work are unchanged.
      if (enc === 'libx264' || signal?.aborted || err.canceled) throw err;
      warnings.add(`The graphics card's encoder stopped (${require('../jobs/queue').ffmpegReason(err.message).slice(0, 140)}), so this export was made with the computer's own encoder.`);
      await run('libx264');
    }
  } finally { for (const x of scratch) fs.rm(x, { force: true }, () => {}); }
  return { outPath, duration: dur, warnings: [...warnings] };
}

module.exports = { exportProject, xfadeSupport };
