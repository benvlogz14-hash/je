// Studio transitions, preview side (Nov 14, Ryan: "fully fix the transition features ... so they work flawlessly on
// text and video"). The export (server/video/studio.js) makes each transition with FFmpeg's xfade between the clip and
// a see-through copy of itself, so only how much of the clip shows changes (before, xfade mixed the clip with see-through
// black, which darkened soft edges); this draws the same thing on the canvas with xfade's own formulas (xfade counts
// P = 1 - elapsed, from 1 down to 0). Fades are plain fades; Dip to Black / White fade the picture to that colour.
// A cut with a transition (clip A ends where clip B starts on the same track) plays B's transition over A, which carries
// on underneath for that long, like Premiere's handles (cutPairs). Titles get the same transitions inside their own box.

export const TRANSITIONS = [
  { type: 1, name: 'Cross Dissolve', cat: 'Dissolve', x: 'fade' }, { type: 2, name: 'Fade', cat: 'Dissolve', x: 'fade' }, { type: 3, name: 'Dip to Black', cat: 'Dissolve', x: 'fadeblack' },
  { type: 4, name: 'Dip to White', cat: 'Dissolve', x: 'fadewhite' }, { type: 5, name: 'Dither Dissolve', cat: 'Dissolve', x: 'dissolve' }, { type: 6, name: 'Fade Through Gray', cat: 'Dissolve', x: 'fadegrays' },
  { type: 7, name: 'Blur Dissolve', cat: 'Dissolve', x: 'hblur' }, { type: 8, name: 'Pixelate', cat: 'Dissolve', x: 'pixelize' },
  { type: 10, name: 'Wipe Left', cat: 'Wipe', x: 'wipeleft' }, { type: 11, name: 'Wipe Right', cat: 'Wipe', x: 'wiperight' }, { type: 12, name: 'Wipe Up', cat: 'Wipe', x: 'wipeup' }, { type: 13, name: 'Wipe Down', cat: 'Wipe', x: 'wipedown' },
  { type: 14, name: 'Soft Wipe Left', cat: 'Wipe', x: 'smoothleft' }, { type: 15, name: 'Soft Wipe Right', cat: 'Wipe', x: 'smoothright' }, { type: 16, name: 'Soft Wipe Up', cat: 'Wipe', x: 'smoothup' }, { type: 17, name: 'Soft Wipe Down', cat: 'Wipe', x: 'smoothdown' },
  { type: 18, name: 'Corner Wipe ↘', cat: 'Wipe', x: 'wipetl' }, { type: 19, name: 'Corner Wipe ↙', cat: 'Wipe', x: 'wipetr' }, { type: 20, name: 'Corner Wipe ↗', cat: 'Wipe', x: 'wipebl' }, { type: 21, name: 'Corner Wipe ↖', cat: 'Wipe', x: 'wipebr' },
  { type: 22, name: 'Diagonal ↖', cat: 'Wipe', x: 'diagtl' }, { type: 23, name: 'Diagonal ↗', cat: 'Wipe', x: 'diagtr' }, { type: 24, name: 'Diagonal ↙', cat: 'Wipe', x: 'diagbl' }, { type: 25, name: 'Diagonal ↘', cat: 'Wipe', x: 'diagbr' },
  { type: 26, name: 'Clock Wipe', cat: 'Wipe', x: 'radial' }, { type: 27, name: 'Slats Left', cat: 'Wipe', x: 'hlslice' }, { type: 28, name: 'Slats Right', cat: 'Wipe', x: 'hrslice' }, { type: 29, name: 'Slats Up', cat: 'Wipe', x: 'vuslice' }, { type: 30, name: 'Slats Down', cat: 'Wipe', x: 'vdslice' },
  { type: 31, name: 'Iris Round', cat: 'Iris', x: 'circleopen' }, { type: 32, name: 'Iris Round Close', cat: 'Iris', x: 'circleclose' }, { type: 33, name: 'Split Open', cat: 'Iris', x: 'horzopen' }, { type: 34, name: 'Split Close', cat: 'Iris', x: 'horzclose' },
  { type: 35, name: 'Barn Doors Open', cat: 'Iris', x: 'vertopen' }, { type: 36, name: 'Barn Doors Close', cat: 'Iris', x: 'vertclose' },
  { type: 40, name: 'Push Left', cat: 'Slide', x: 'slideleft' }, { type: 41, name: 'Push Right', cat: 'Slide', x: 'slideright' }, { type: 42, name: 'Push Up', cat: 'Slide', x: 'slideup' }, { type: 43, name: 'Push Down', cat: 'Slide', x: 'slidedown' },
  { type: 44, name: 'Slide Left', cat: 'Slide', x: 'coverleft' }, { type: 45, name: 'Slide Right', cat: 'Slide', x: 'coverright' }, { type: 46, name: 'Slide Up', cat: 'Slide', x: 'coverup' }, { type: 47, name: 'Slide Down', cat: 'Slide', x: 'coverdown' },
  { type: 48, name: 'Squeeze Horizontal', cat: 'Slide', x: 'squeezeh' }, { type: 49, name: 'Squeeze Vertical', cat: 'Slide', x: 'squeezev' },
];
export const TRANS_BY_TYPE = Object.fromEntries(TRANSITIONS.map((t) => [t.type, t]));
/** Dip to Black / White: the picture fades to that colour (on titles they're plain fades). */
export const DIPS = { 3: '#000000', 4: '#ffffff' };
/** Types made with xfade (everything but the plain fades and dips). */
export const shaped = (type) => !!type && !!TRANS_BY_TYPE[type] && type > 4;
export const isPush = (type) => /^slide/.test(TRANS_BY_TYPE[type]?.x || '');
export const transDur = (t) => (t && t.type ? Math.max(0.04, t.duration || 1) : 0);
/** In and Out lengths that fit inside a clip (a 1 s In and Out on a half-second caption used to overlap and hide it):
 *  shared out in proportion, or, when the In is a cut's (keepIn, it's tied to the clip before), the Out gets what's left. */
export const fitTrans = (dIn, dOut, dur, keepIn = false) => {
  let a = Math.min(dIn, dur), b = Math.min(dOut, dur);
  if (a + b > dur) { if (keepIn) b = Math.max(0, dur - a); else { const k = dur / (a + b); a *= k; b *= k; } }
  return [a, b];
};

const sstep = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const fract = (a) => a - Math.floor(a);
const frand = (x, y) => fract(Math.sin(x * 12.9898 + y * 78.233) * 43758.545);
// How much of the incoming clip shows at (x, y) of a w×h frame, as xfade has it (P: 1 → 0). The outgoing side is 1 - this.
const XW = {
  dissolve: (x, y, w, h, P) => (frand(x, y) < 1 - P ? 1 : 0),
  smoothleft: (x, y, w, h, P) => sstep(0, 1, 1 + x / w - 2 * P),
  smoothright: (x, y, w, h, P) => sstep(0, 1, 1 + (w - 1 - x) / w - 2 * P),
  smoothup: (x, y, w, h, P) => sstep(0, 1, 1 + y / h - 2 * P),
  smoothdown: (x, y, w, h, P) => sstep(0, 1, 1 + (h - 1 - y) / h - 2 * P),
  diagtl: (x, y, w, h, P) => sstep(0, 1, 1 + (x / w) * (y / h) - 2 * P),
  diagtr: (x, y, w, h, P) => sstep(0, 1, 1 + ((w - 1 - x) / w) * (y / h) - 2 * P),
  diagbl: (x, y, w, h, P) => sstep(0, 1, 1 + (x / w) * ((h - 1 - y) / h) - 2 * P),
  diagbr: (x, y, w, h, P) => sstep(0, 1, 1 + ((w - 1 - x) / w) * ((h - 1 - y) / h) - 2 * P),
  radial: (x, y, w, h, P) => sstep(0, 1, Math.atan2(x - Math.floor(w / 2), y - Math.floor(h / 2)) - (P - 0.5) * Math.PI * 2.5),
  hlslice: (x, y, w, h, P) => (sstep(-0.5, 0, x / w - P * 1.5) <= fract((10 * x) / w) ? 0 : 1),
  hrslice: (x, y, w, h, P) => { const xx = (w - 1 - x) / w; return sstep(-0.5, 0, xx - P * 1.5) <= fract(10 * xx) ? 0 : 1; },
  vuslice: (x, y, w, h, P) => (sstep(-0.5, 0, y / h - P * 1.5) <= fract((10 * y) / h) ? 0 : 1),
  vdslice: (x, y, w, h, P) => { const yy = (h - 1 - y) / h; return sstep(-0.5, 0, yy - P * 1.5) <= fract(10 * yy) ? 0 : 1; },
  circleopen: (x, y, w, h, P) => 1 - sstep(0, 1, Math.hypot(x - Math.floor(w / 2), y - Math.floor(h / 2)) / Math.hypot(Math.floor(w / 2), Math.floor(h / 2)) + (P - 0.5) * 3),
  circleclose: (x, y, w, h, P) => sstep(0, 1, Math.hypot(x - Math.floor(w / 2), y - Math.floor(h / 2)) / Math.hypot(Math.floor(w / 2), Math.floor(h / 2)) + (0.5 - P) * 3),
  horzopen: (x, y, w, h, P) => sstep(0, 1, 2 - Math.abs((y - h / 2) / (h / 2)) - 2 * P),
  horzclose: (x, y, w, h, P) => sstep(0, 1, 1 + Math.abs((y - h / 2) / (h / 2)) - 2 * P),
  vertopen: (x, y, w, h, P) => sstep(0, 1, 2 - Math.abs((x - w / 2) / (w / 2)) - 2 * P),
  vertclose: (x, y, w, h, P) => sstep(0, 1, 1 + Math.abs((x - w / 2) / (w / 2)) - 2 * P),
};
/**
 * Colour kept at s (0 = grey): the grey is the picture's brightness the way the export measures it (BT.601, the
 * video's own luma; CSS grayscale() uses other weights and came out darker). An SVG filter the canvas can use.
 */
const grays = new Set();
function grayTo(s) {
  const k = Math.round(Math.max(0, Math.min(1, s)) * 50) / 50; if (k >= 1) return ''; const id = `eu-gray-${Math.round(k * 50)}`;
  if (!grays.has(id) && typeof document !== 'undefined') {
    let svg = document.getElementById('eu-trans-svg');
    if (!svg) { svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.id = 'eu-trans-svg'; svg.setAttribute('width', '0'); svg.setAttribute('height', '0'); svg.style.position = 'absolute'; document.body.appendChild(svg); }
    const [r, g, b] = [0.299, 0.587, 0.114]; const row = (i) => [r, g, b].map((w, j) => ((1 - k) * w + (i === j ? k : 0)).toFixed(4)).join(' ');
    svg.insertAdjacentHTML('beforeend', `<filter id="${id}" color-interpolation-filters="sRGB"><feColorMatrix type="matrix" values="${row(0)} 0 0  ${row(1)} 0 0  ${row(2)} 0 0  0 0 0 1 0" /></filter>`);
    grays.add(id);
  }
  return `url(#${id})`;
}
// The soft masks are drawn by Euclidean's Rust module (native/visual, compiled to renderer/vendor/visual.wasm: 9-70x
// faster on soft wipes, splits, slats, irises and the dither); the formulas above stay as the fallback, used until it
// has loaded or if it can't (the masks come out the same, the dither's speckles in another random pattern).
const MASK_KIND = { dissolve: 1, smoothleft: 2, smoothright: 3, smoothup: 4, smoothdown: 5, diagtl: 6, diagtr: 7, diagbl: 8, diagbr: 9, radial: 10, hlslice: 11, hrslice: 12, vuslice: 13, vdslice: 14, circleopen: 15, circleclose: 16, horzopen: 17, horzclose: 18, vertopen: 19, vertclose: 20 };
let V = null; let vBuf = { ptr: 0, cap: 0 };
export const visualReady = (async () => {
  try {
    if (typeof WebAssembly === 'undefined' || typeof fetch === 'undefined') return false;
    const r = await fetch(new URL('../../vendor/visual.wasm', import.meta.url)); if (!r.ok) return false;
    V = (await WebAssembly.instantiate(await r.arrayBuffer(), {})).instance.exports; return true;
  } catch { V = null; return false; }
})();
/** The mask in Rust: an ImageData (black, alpha = how much shows), or null to use the JavaScript formulas. */
function rustMask(f, mw, mh) {
  if (!V || !f.maskKind) return null;
  try {
    const n = mw * mh * 4;
    if (n > vBuf.cap) { if (vBuf.cap) V.dealloc(vBuf.ptr, vBuf.cap); vBuf = { ptr: V.alloc(n), cap: n }; }
    V.mask(f.maskKind, f.maskP, f.maskOut ? 1 : 0, mw, mh, vBuf.ptr);
    return new ImageData(new Uint8ClampedArray(V.memory.buffer, vBuf.ptr, n), mw, mh);
  } catch { V = null; return null; }
}
const PUSH = { slideleft: [-1, 0], slideright: [1, 0], slideup: [0, -1], slidedown: [0, 1] };
const COVER = { coverleft: [-1, 0], coverright: [1, 0], coverup: [0, -1], coverdown: [0, 1] };

/**
 * What a transition does to one clip at elapsed fraction e (0 → 1), in the clip's own w×h frame (origin top-left).
 * out: the clip is leaving (Out edge) rather than arriving. pair: the clip is one side of a cut with a transition.
 * Returns { alpha, dx, dy, sx, sy, clip: Path2D|null, mask: fn|null, filter, dip: {color, a}|null, pixel, hblur }.
 */
export function transitionFx(type, e, w, h, out, pair = false) {
  const x = TRANS_BY_TYPE[type]?.x || 'fade'; const P = 1 - e;
  const fx = { alpha: 1, dx: 0, dy: 0, sx: 1, sy: 1, clip: null, mask: null, filter: '', dip: null, pixel: 0, hblur: 0 };
  const shows = out ? P : e; // how much of the clip a plain mix keeps
  if (DIPS[type]) {
    const color = DIPS[type];
    if (!pair) fx.dip = { color, a: out ? e : 1 - e };
    else if (out) { if (e < 0.5) fx.dip = { color, a: 2 * e }; else fx.alpha = 0; } // A goes to the colour in the first half…
    else if (e >= 0.5) fx.dip = { color, a: 2 * (1 - e) }; else fx.alpha = 0; // …and B comes out of it in the second
    return fx;
  }
  if (x === 'fade') { fx.alpha = shows; return fx; }
  if (x === 'fadegrays') { fx.alpha = shows; fx.filter = grayTo(P * sstep(0.8, 1, P) + (1 - P) * (1 - sstep(0.2, 1, P))); return fx; }
  if (x === 'pixelize') { fx.alpha = shows; const dist = Math.ceil(Math.min(P, 1 - P) * 50) / 50; fx.pixel = (2 * dist * Math.min(w, h)) / 20; return fx; }
  if (x === 'hblur') { fx.alpha = shows; fx.hblur = 1 + Math.floor(w / 2) * (P <= 0.5 ? 2 * P : 2 * (1 - P)); return fx; }
  const rect = (a, b, c, d) => { const q = new Path2D(); q.rect(a, b, c, d); return q; };
  const not = (inner) => { const q = new Path2D(); q.rect(0, 0, w, h); q.addPath(inner); return q; }; // even-odd: the frame minus inner
  const push = PUSH[x];
  if (push) { const k = out ? e : -P; fx.dx = push[0] * w * k; fx.dy = push[1] * h * k; return fx; } // both sides move
  const cov = COVER[x];
  if (cov && !out) { fx.dx = -cov[0] * w * P; fx.dy = -cov[1] * h * P; return fx; } // the incoming side slides over
  if (x === 'squeezeh' || x === 'squeezev') {
    // Incoming: shows outside a band that shrinks to nothing. Outgoing: squashed into that band.
    if (out) { if (x === 'squeezeh') fx.sy = Math.max(0.0005, P); else fx.sx = Math.max(0.0005, P); }
    else fx.clip = x === 'squeezeh' ? not(rect(0, h / 2 - (P * h) / 2, w, P * h)) : not(rect(w / 2 - (P * w) / 2, 0, P * w, h));
    return fx;
  }
  if (XW[x]) { const f = XW[x]; fx.mask = out ? (a, b, mw, mh) => 1 - f(a, b, mw, mh, P) : (a, b, mw, mh) => f(a, b, mw, mh, P); fx.maskKind = MASK_KIND[x]; fx.maskP = P; fx.maskOut = !!out; return fx; }
  // Hard-edged wipes: the incoming region at this moment (the outgoing side keeps the rest).
  let r = null;
  switch (x) {
    case 'wipeleft': case 'coverleft': r = rect(w * P, 0, w * e, h); break;
    case 'wiperight': case 'coverright': r = rect(0, 0, w * e, h); break;
    case 'wipeup': case 'coverup': r = rect(0, h * P, w, h * e); break;
    case 'wipedown': case 'coverdown': r = rect(0, 0, w, h * e); break;
    case 'wipetl': r = not(rect(0, 0, w * P, h * P)); break;
    case 'wipetr': r = not(rect(w * e, 0, w * P, h * P)); break;
    case 'wipebl': r = not(rect(0, h * e, w * P, h * P)); break;
    case 'wipebr': r = not(rect(w * e, h * e, w * P, h * P)); break;
    default: break;
  }
  if (r) fx.clip = out ? not(r) : r;
  return fx;
}

/**
 * Cuts with a transition: clip A ends where clip B starts on the same video track and B has an In transition (or A an
 * Out one). B's transition then plays over A, which carries on under it for that long (its own Out is not used).
 * Returns { inOf: Map(B id → {type, duration}), tailOf: Map(A id → {type, duration, ext}) }; ext = how long A carries on.
 * The export does the same (server/video/studio.js cutPairs).
 */
export function cutPairs(seq) {
  const inOf = new Map(); const tailOf = new Map(); if (!seq) return { inOf, tailOf };
  const half = 0.5 / (seq.fps || 30);
  for (const tr of seq.videoTracks || []) {
    if (tr.muted) continue;
    const cs = tr.clips.filter((c) => c.enabled !== false && (c.type === 0 || c.type === 2)).sort((a, b) => a.start - b.start);
    for (let k = 1; k < cs.length; k++) {
      const A = cs[k - 1], B = cs[k];
      if (Math.abs(A.start + A.duration - B.start) > half) continue;
      const t = B.transIn?.type ? B.transIn : A.transOut?.type ? A.transOut : null; if (!t) continue;
      const d = Math.min(transDur(t), B.duration); if (d < 0.04) continue;
      inOf.set(B.id, { type: t.type, duration: d });
      tailOf.set(A.id, { type: t.type, duration: d, ext: DIPS[t.type] ? d / 2 : d });
    }
  }
  return { inOf, tailOf };
}

/** A title's transition frame: its box plus room for outlines, shadows and the Slide up / Drop in moves. Same in the export. */
export function titleFrame(boxW, boxH, size, scale) {
  const w = boxW + 2 * Math.max(0.25 * size, 12 * scale), h = boxH + 2 * Math.max(0.25 * size, 76 * scale);
  return { w: Math.ceil(w / 2) * 2, h: Math.ceil(h / 2) * 2 };
}

// ---- drawing the masked / pixelated / blurred ones through an offscreen canvas
const pool = new Map();
function canvasFor(key, w, h) {
  let c = pool.get(key); if (!c) { c = document.createElement('canvas'); pool.set(key, c); }
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  const g = c.getContext('2d'); g.setTransform(1, 0, 0, 1, 0, 0); g.globalAlpha = 1; g.globalCompositeOperation = 'source-over'; g.filter = 'none'; g.imageSmoothingEnabled = true; g.clearRect(0, 0, w, h);
  return c;
}
/** True when these effects need the offscreen path (a mask, pixelation or the horizontal blur). */
export const needsOffscreen = (fxs) => fxs.some((f) => f.mask || f.pixel > 1 || f.hblur > 1);

/**
 * Paint something through the transition effects that can't be done with a clip path: `paint(ctx)` draws it centred on
 * (0, 0) of a w×h frame. Returns the canvas to draw at the frame's top-left corner.
 */
export function fxCanvas(fxs, w, h, paint) {
  w = Math.max(1, Math.round(w)); h = Math.max(1, Math.round(h));
  const pixel = Math.max(0, ...fxs.map((f) => f.pixel || 0)); const hb = Math.max(0, ...fxs.map((f) => f.hblur || 0));
  const off = canvasFor('fx-off', w, h); const g = off.getContext('2d');
  if (pixel > 1) {
    // Blocks: drawn small, then blown back up without smoothing.
    const sw = Math.max(1, Math.round(w / pixel)), sh = Math.max(1, Math.round(h / pixel));
    const sm = canvasFor('fx-px', sw, sh); const sg = sm.getContext('2d'); sg.translate(sw / 2, sh / 2); sg.scale(sw / w, sh / h); paint(sg);
    g.imageSmoothingEnabled = false; g.drawImage(sm, 0, 0, w, h); g.imageSmoothingEnabled = true;
  } else { g.translate(w / 2, h / 2); paint(g); g.setTransform(1, 0, 0, 1, 0, 0); }
  if (hb > 1) {
    // xfade's horizontal blur: each pixel is the average of the next `hb` pixels to its right (16 steps of it here).
    // Past the right edge the window only has the picture's last pixels: carried on as its last column.
    const cp = canvasFor('fx-hb', w + Math.ceil(hb), h); const cg = cp.getContext('2d'); cg.drawImage(off, 0, 0); cg.drawImage(off, w - 1, 0, 1, h, w, 0, Math.ceil(hb), h);
    g.clearRect(0, 0, w, h); g.globalCompositeOperation = 'lighter'; const n = Math.min(16, Math.ceil(hb)); g.globalAlpha = 1 / n;
    for (let i = 0; i < n; i++) g.drawImage(cp, -((i + 0.5) * hb) / n, 0);
    g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
  }
  for (const f of fxs) {
    if (!f.mask) continue;
    const s = Math.min(1, 480 / Math.max(w, h)); const mw = Math.max(2, Math.round(w * s)), mh = Math.max(2, Math.round(h * s));
    const mc = canvasFor('fx-mask', mw, mh); const mg = mc.getContext('2d');
    let img = rustMask(f, mw, mh);
    if (!img) { img = mg.createImageData(mw, mh); const d = img.data; for (let y = 0, i = 3; y < mh; y++) for (let x = 0; x < mw; x++, i += 4) d[i] = Math.round(255 * Math.max(0, Math.min(1, f.mask(x, y, mw, mh)))); }
    mg.putImageData(img, 0, 0);
    g.globalCompositeOperation = 'destination-in'; g.drawImage(mc, 0, 0, w, h); g.globalCompositeOperation = 'source-over';
  }
  return off;
}
