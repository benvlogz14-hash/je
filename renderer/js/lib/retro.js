// Retro looks in the Studio preview (VHS, camcorder, digicam, Super 8, old film, glitch, CRT, noir, night vision, 8-bit).
// The export does the same with FFmpeg (server/video/retro.js), with the same numbers: sizes are in the clip's own
// pixels, scaled by u = shorter side / 1080, so the preview and the export line up.

const AMOUNT = ['amount', 'Strength', 0, 100, 70];
const MIX = ['mix', 'Intensity %', 1, 100, 100]; // how much of the look is laid over the untouched picture
const STAMP = ['stamp', 'Date stamp', 0, 1, 1, 1];
export const RETRO_EFFECTS = [
  { id: 'vhs', name: 'VHS', cat: 'Retro', params: [MIX, AMOUNT, STAMP] },
  { id: 'camcorder', name: '90s Camcorder', cat: 'Retro', params: [MIX, AMOUNT, STAMP] },
  { id: 'digicam', name: 'Y2K Digicam', cat: 'Retro', params: [MIX, AMOUNT, STAMP] },
  { id: 'super8', name: 'Super 8', cat: 'Retro', params: [MIX, AMOUNT] },
  { id: 'oldfilm', name: 'Old Film', cat: 'Retro', params: [MIX, AMOUNT] },
  { id: 'glitch', name: 'Glitch', cat: 'Retro', params: [MIX, AMOUNT] },
  { id: 'crt', name: 'CRT TV', cat: 'Retro', params: [MIX, AMOUNT] },
  { id: 'noir', name: 'Noir', cat: 'Retro', params: [MIX, AMOUNT] },
  { id: 'nightvision', name: 'Night Vision', cat: 'Retro', params: [MIX, AMOUNT] },
  { id: 'pixel8', name: '8-bit', cat: 'Retro', params: [MIX, AMOUNT] },
];
export const RETRO_IDS = new Set(RETRO_EFFECTS.map((e) => e.id));

/** RGB split as an SVG filter the canvas can use (red one way, blue the other). Made once per offset. */
const made = new Set();
function rgbSplit(px) {
  const n = Math.max(0.5, Math.round(px * 2) / 2); const id = `eu-rgb-${String(n).replace('.', '_')}`;
  if (!made.has(id)) {
    let svg = document.getElementById('eu-retro-svg');
    if (!svg) { svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.id = 'eu-retro-svg'; svg.setAttribute('width', '0'); svg.setAttribute('height', '0'); svg.style.position = 'absolute'; document.body.appendChild(svg); }
    svg.insertAdjacentHTML('beforeend', `<filter id="${id}" color-interpolation-filters="sRGB" x="0" y="0" width="100%" height="100%">
      <feColorMatrix in="SourceGraphic" type="matrix" values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0" /><feOffset dx="${-n}" result="r" />
      <feColorMatrix in="SourceGraphic" type="matrix" values="0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0" result="g" />
      <feColorMatrix in="SourceGraphic" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0" /><feOffset dx="${n}" result="b" />
      <feBlend in="r" in2="g" mode="screen" result="rg" /><feBlend in="rg" in2="b" mode="screen" /></filter>`);
    made.add(id);
  }
  return `url(#${id})`;
}

/**
 * What one look does at this moment: CSS filters for the picture, plus things drawn on top (overlay) and pixelation.
 * u = the clip's shorter side on the canvas / 1080 (so 1 export pixel = u canvas pixels at 1080 wide).
 */
export function retroLook(id, p, local, u) {
  const k = Math.max(0, Math.min(100, p.amount ?? 70)) / 100; const st = (p.stamp ?? 1) >= 0.5;
  const L = { css: [], grain: 0, lines: 0, vig: 0, pixel: 0, draw: [], mix: Math.max(0.01, Math.min(1, (p.mix ?? 100) / 100)) };
  const split = (px) => L.css.push(rgbSplit(px * u));
  switch (id) {
    case 'vhs':
      L.css.push(`blur(${(0.3 + 0.8 * k) * u}px)`); split(Math.max(1, Math.round(2 + 7 * k)));
      L.css.push(`saturate(${1 + 0.3 * k})`, `contrast(${1 + 0.08 * k})`, `brightness(1.02)`);
      L.grain = 0.06 + 0.16 * k; L.lines = 0.1 + 0.25 * k; L.draw.push({ band: { speed: 1 / 3.5, len: 1.4, off: 0.2, hh: 0.035, a: 0.05 + 0.1 * k } });
      if (st) L.draw.push({ text: 'PLAY', at: 'tl' }, { text: 'OCT. 29 1996', at: 'bl', size: 0.8 });
      break;
    case 'camcorder':
      L.css.push(`sepia(${0.3 * k})`, `saturate(${1 - 0.2 * k})`, `contrast(${1 - 0.06 * k})`, `brightness(${1 + 0.03 * k})`, `blur(${(0.3 + 0.7 * k) * u}px)`);
      L.grain = 0.05 + 0.12 * k; L.vig = 0.25 + 0.35 * k;
      if (st) {
        const hh = Math.floor(local / 3600), mm = Math.floor(local / 60) % 60, ss = Math.floor(local) % 60; const two = (x) => String(x).padStart(2, '0');
        L.draw.push({ text: 'REC', at: 'tl', dx: 0.7 }, { rec: local % 1 < 0.6 }, { text: `${two(hh)}:${two(mm)}:${two(ss)}`, at: 'tr' }, { text: 'OCT 29 1997', at: 'br', size: 0.85 });
      }
      break;
    case 'digicam':
      L.css.push(`brightness(${1 + 0.04 * k})`, `contrast(${1 + 0.12 * k})`, `saturate(${1 + 0.35 * k})`, `hue-rotate(${-6 * k}deg)`);
      L.grain = 0.03 + 0.06 * k; if (st) L.draw.push({ text: "'99 10 29", at: 'br', color: '#FF9A2E' });
      break;
    case 'super8':
      L.css.push(`sepia(${0.35 * k})`, `contrast(${1 - 0.15 * k})`, `brightness(${1 + 0.05 * k + 0.03 * k * Math.sin(local * 31)})`, `saturate(${1 - 0.1 * k})`, `blur(${(0.3 + 0.5 * k) * u}px)`);
      L.grain = 0.1 + 0.18 * k; L.vig = 0.3 + 0.4 * k;
      break;
    case 'oldfilm':
      L.css.push(`sepia(${k})`, `contrast(${1 + 0.15 * k})`, `brightness(${1 + 0.05 * k * Math.sin(local * 43)})`);
      L.grain = 0.14 + 0.22 * k; L.vig = 0.4 + 0.4 * k; L.draw.push({ scratch: { x: Math.abs(Math.sin(local * 13.7)), w: 2, a: 0.15 + 0.25 * k } });
      break;
    case 'glitch': {
      split(Math.max(2, Math.round(6 + 18 * k))); L.css.push(`saturate(${1 + 0.25 * k})`, `contrast(${1 + 0.1 * k})`); L.grain = 0.05 + 0.12 * k;
      const a = 0.35 + 0.4 * k;
      if (local % 1.3 < 0.18) L.draw.push({ box: { x: Math.abs(Math.sin(local * 7.1)), y: Math.abs(Math.sin(local * 3.3)), w: 0.45, h: 0.022, color: `rgba(0,255,255,${a})` } });
      if ((local + 0.6) % 1.7 < 0.14) L.draw.push({ box: { x: Math.abs(Math.cos(local * 5.3)) - 0.2, y: Math.abs(Math.cos(local * 2.7)), w: 0.6, h: 0.015, color: `rgba(255,0,255,${a})` } });
      if ((local + 0.3) % 2.1 < 0.1) L.draw.push({ box: { x: 0, y: Math.abs(Math.sin(local * 1.9)), w: 1, h: 0.05, color: `rgba(255,255,255,${0.08 + 0.12 * k})` } });
      break;
    }
    case 'crt':
      split(Math.max(1, Math.round(2))); L.css.push(`contrast(${1 + 0.15 * k})`, `saturate(${1 + 0.15 * k})`, `brightness(${1 + 0.02 * k})`);
      L.lines = 0.25 + 0.4 * k; L.grain = 0.03 + 0.06 * k; L.vig = 0.45 + 0.35 * k;
      break;
    case 'noir':
      L.css.push('grayscale(1)', `contrast(${1 + 0.45 * k})`, `brightness(${1 - 0.03 * k})`); L.grain = 0.05 + 0.14 * k; L.vig = 0.35 + 0.4 * k;
      break;
    case 'nightvision':
      L.css.push('grayscale(1)', `contrast(${1 + 0.3 * k})`, `brightness(${1 + 0.06 * k})`, `sepia(${k})`, `hue-rotate(${70 * k}deg)`, `saturate(${1 + 3 * k})`);
      L.grain = 0.14 + 0.2 * k; L.lines = 0.15 + 0.2 * k; L.vig = 0.6 + 0.3 * k;
      break;
    case 'pixel8': L.pixel = Math.max(2, Math.round(2 + 14 * k)); break;
    default: break;
  }
  return L;
}

let noise = null;
/** A small tile of fresh random grain each frame (drawn over the picture like FFmpeg's noise filter). */
function grainTile() {
  if (!noise) { noise = document.createElement('canvas'); noise.width = 128; noise.height = 128; }
  const g = noise.getContext('2d'); const img = g.createImageData(128, 128); const d = img.data;
  for (let i = 0; i < d.length; i += 4) { const v = (Math.random() * 255) | 0; d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255; }
  g.putImageData(img, 0, 0); return noise;
}

/**
 * Draws a look's overlays over the picture (centred at 0,0, nw x nh canvas pixels). view = the part of the picture
 * that's on screen ({ x, y, w, h } from its top-left), so stamps and flashes sit where they're seen (same as export).
 */
export function retroOverlay(g, L, nw, nh, local, u, view = null) {
  const A0 = g.globalAlpha * (L.mix ?? 1); // the clip's own opacity x the look's intensity
  g.save(); g.filter = 'none'; g.globalAlpha = A0;
  g.beginPath(); g.rect(-nw / 2, -nh / 2, nw, nh); g.clip();
  const V = view || { x: 0, y: 0, w: nw, h: nh };
  const x0 = -nw / 2 + V.x, y0 = -nh / 2 + V.y; const fullX = -nw / 2;
  nw = V.w; nh = V.h;
  if (L.grain) { g.globalAlpha = A0 * L.grain; g.globalCompositeOperation = 'overlay'; g.fillStyle = g.createPattern(grainTile(), 'repeat'); g.fillRect(x0, y0, nw, nh); g.globalCompositeOperation = 'source-over'; }
  if (L.lines) { g.globalAlpha = A0 * L.lines; g.fillStyle = '#000'; const gap = Math.max(3, Math.round((nh / u) / 320)) * u; for (let y = y0; y < y0 + nh; y += gap) g.fillRect(x0, y, nw, Math.max(1, u)); }
  g.globalAlpha = A0;
  const fs = 64 * u; const m = 44 * u;
  for (const d of L.draw) {
    if (d.band) { const H = nh; const y = ((local * H * d.band.speed) % (H * d.band.len)) - H * d.band.off; g.fillStyle = `rgba(255,255,255,${d.band.a})`; g.fillRect(fullX, y0 + y, nw + 2 * Math.abs(fullX - x0) + 9999, H * d.band.hh); }
    if (d.scratch) { g.fillStyle = `rgba(255,255,255,${d.scratch.a})`; g.fillRect(x0 + nw * d.scratch.x, y0, d.scratch.w * u, nh); }
    if (d.box) { g.fillStyle = d.box.color; g.fillRect(d.box.w >= 1 ? fullX : x0 + nw * d.box.x, y0 + nh * d.box.y, d.box.w >= 1 ? 99999 : nw * d.box.w, nh * d.box.h); }
    if (d.rec) { g.fillStyle = 'rgba(255,0,0,0.9)'; g.fillRect(x0 + m, y0 + m + fs * 0.2, fs * 0.5, fs * 0.5); }
    if (d.text) {
      const size = fs * (d.size || 1); g.font = `${size}px VT323, monospace`; g.textBaseline = 'top'; g.lineJoin = 'round';
      const w = g.measureText(d.text).width; const right = d.at === 'tr' || d.at === 'br'; const bottom = d.at === 'bl' || d.at === 'br';
      const x = right ? x0 + nw - m - w : x0 + m + (d.dx || 0) * fs; const y = bottom ? y0 + nh - m - size : y0 + m;
      g.lineWidth = Math.max(1, size / 7); g.strokeStyle = 'rgba(0,0,0,0.6)'; g.strokeText(d.text, x, y); g.fillStyle = d.color || '#fff'; g.fillText(d.text, x, y);
    }
  }
  g.restore();
  if (L.vig) { g.save(); g.filter = 'none'; g.globalAlpha = A0; const rg = g.createRadialGradient(0, 0, Math.min(nw, nh) * 0.25, 0, 0, Math.max(nw, nh) * 0.6); rg.addColorStop(0, 'rgba(0,0,0,0)'); rg.addColorStop(1, `rgba(0,0,0,${L.vig * 0.85})`); g.fillStyle = rg; g.fillRect(-nw / 2, -nh / 2, nw, nh); g.restore(); }
}
