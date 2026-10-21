'use strict';
/**
 * "Campaign ad" look for the motion renderer: the style of current political
 * TV/online ads. Condensed all-caps type, navy/red/white, full-bleed photos
 * with a colour wash, newspaper headlines with the source on screen, contrast
 * splits, and a "VOTE" end card. Every factual scene can carry a citation that
 * is printed at the bottom of the frame, as real ads do.
 */
const fs = require('fs');

const PALETTES = {
  positive: { a: '#0a2a6b', b: '#d7263d', c: '#f2c14e', ink: '#0a1633', paper: '#fbf8f1', wash: 'rgba(10,30,90,.55)', bg1: '#081c4a', bg2: '#13336f' },
  republican: { a: '#7a0f1c', b: '#0a2a6b', c: '#f2c14e', ink: '#2a0a10', paper: '#fbf8f1', wash: 'rgba(110,10,25,.5)', bg1: '#4a0912', bg2: '#8a1424' },
  independent: { a: '#2a2350', b: '#e0663a', c: '#f2c14e', ink: '#141026', paper: '#fbf8f1', wash: 'rgba(40,30,90,.5)', bg1: '#1b1638', bg2: '#3a2f6e' },
  contrast: { a: '#111418', b: '#d7263d', c: '#f2c14e', ink: '#0d0f12', paper: '#f4f1ea', wash: 'rgba(20,20,24,.6)', bg1: '#121418', bg2: '#2a2d33' },
};

function hexMix(hex, to, t) {
  const n = (x) => parseInt(x, 16); const a = hex.replace('#', ''); const b = to.replace('#', '');
  return '#' + [0, 2, 4].map((i) => Math.round(n(a.substr(i, 2)) * (1 - t) + n(b.substr(i, 2)) * t).toString(16).padStart(2, '0')).join('');
}
/** Palette for an ad: contrast look, the candidate's brand colour (from their website), or their party's colours. */
function paletteFor({ tone, party, brand }) {
  if (tone === 'contrast') return PALETTES.contrast;
  if (brand && /^#[0-9a-f]{6}$/i.test(brand)) {
    const base = PALETTES.positive;
    return { ...base, a: brand, bg1: hexMix(brand, '#000000', 0.55), bg2: hexMix(brand, '#000000', 0.25), ink: hexMix(brand, '#000000', 0.8), wash: `${brand}88` };
  }
  const p = String(party || '').toLowerCase();
  if (/republican/.test(p)) return PALETTES.republican;
  if (/democrat/.test(p)) return PALETTES.positive;
  return p ? PALETTES.independent : PALETTES.positive;
}

function setup(h) {
  const { esc, fileUrl, compact } = h;
  const cap = (s) => esc(String(s || '').toUpperCase());
  const mark = (s) => esc(s).replace(/\*([^*]+)\*/g, '<b>$1</b>');

  function css(P) {
    return `.cx-title{font-family:Tall,Pop;font-weight:400;text-transform:uppercase;color:#fff;line-height:.95;letter-spacing:.01em;text-shadow:0 6px 24px rgba(0,0,0,.35)}
.cx-title b{color:${P.c};font-weight:400}
.cx-bar{position:absolute;inset:0;background:${P.b};display:flex;align-items:center;justify-content:center;padding:0 40px}
.cx-sub{font-family:Pop;font-weight:800;color:#fff;text-transform:uppercase;letter-spacing:.04em}
.cx-cite{font-family:Pop;font-weight:600;color:rgba(255,255,255,.85);font-size:22px;text-align:left;justify-content:flex-start;padding:0 6px}
.cx-paper{position:absolute;inset:16px;background:${P.paper};box-shadow:0 30px 60px rgba(0,0,0,.45);padding:44px 52px;display:flex;flex-direction:column;gap:18px;transform:rotate(-1.6deg)}
.cx-outlet{font-family:Georgia,'Times New Roman',serif;font-weight:700;font-size:34px;color:#222;border-bottom:3px solid #222;padding-bottom:10px;display:flex;justify-content:space-between}
.cx-head{font-family:Georgia,'Times New Roman',serif;font-weight:700;color:#111;line-height:1.12}
.cx-head mark{background:linear-gradient(transparent 55%,${P.c} 55%);color:#111}
.cx-col{position:absolute;inset:0;display:flex;flex-direction:column;justify-content:center;padding:34px 44px;gap:30px}
.cx-col h3{font-family:Tall,Pop;font-weight:400;font-size:84px;text-transform:uppercase;color:#fff;line-height:1}
.cx-item{font-family:Pop;font-weight:800;font-size:46px;color:#fff;display:flex;gap:16px;align-items:flex-start;line-height:1.15}
.cx-item i{font-style:normal;flex:none;width:52px;height:52px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:32px}`;
  }

  /** Instagram-style default avatar (grey circle, white head and shoulders) with a "your photo here" label. Only used when no photo was found. */
  function silhouette(P, W, H) {
    const V = H > W; const d = V ? W * 0.62 : H * 0.62; const cx = V ? W / 2 : W * 0.74; const cy = V ? H * 0.27 : H * 0.44;
    return `<div style="position:absolute;left:${(cx - d / 2) | 0}px;top:${(cy - d / 2) | 0}px;width:${d | 0}px;height:${d | 0}px;border-radius:50%;background:#dbdbdb;overflow:hidden;box-shadow:0 0 0 ${(d * 0.035) | 0}px rgba(255,255,255,.9),0 30px 60px rgba(0,0,0,.35)">
<svg viewBox="0 0 100 100" style="width:100%;height:100%;display:block"><circle cx="50" cy="38" r="17" fill="#fff"/><path d="M14 100c0-22 16-36 36-36s36 14 36 36z" fill="#fff"/></svg></div>
<div style="position:absolute;left:${(cx - d * 0.7) | 0}px;top:${(cy + d / 2 + d * 0.08) | 0}px;width:${(d * 1.4) | 0}px;text-align:center;font:800 ${V ? 40 : 34}px Pop;color:#fff;letter-spacing:.06em;text-transform:uppercase;text-shadow:0 2px 12px rgba(0,0,0,.4)">Your photo here</div>
<div style="position:absolute;left:${(cx - d * 0.7) | 0}px;top:${(cy + d / 2 + d * 0.08 + (V ? 52 : 44)) | 0}px;width:${(d * 1.4) | 0}px;text-align:center;font:600 ${V ? 26 : 22}px Pop;color:rgba(255,255,255,.8)">with image rights</div>`;
  }

  /** A real background photo (town, capitol, issue) under a brand-colour wash, so text stays readable. */
  function photoBg(P, file, i) {
    return `<div style="position:absolute;inset:0;background:url('${fileUrl(file)}') center/cover;filter:saturate(.9) contrast(1.05)"></div>
<div style="position:absolute;inset:0;background:linear-gradient(${150 + i * 20}deg,${P.bg1}cc,${P.bg2}73 55%,${P.bg1}bf)"></div>
<div style="position:absolute;inset:0;background:repeating-linear-gradient(-35deg,rgba(255,255,255,.035) 0 40px,transparent 40px 80px)"></div>`;
  }

  /** Cut-out candidate standing over the campaign colours, with a soft glow behind them. */
  function cutoutBg(P, W, H, file) {
    const V = H > W; const ch = V ? H * 0.66 : H * 0.98; const left = V ? '50%' : '74%';
    return `<div style="position:absolute;inset:0;background:linear-gradient(160deg,${P.bg1},${P.bg2})"></div>
<div style="position:absolute;inset:0;background:repeating-linear-gradient(-35deg,rgba(255,255,255,.04) 0 40px,transparent 40px 80px)"></div>
<div style="position:absolute;left:${left};top:${V ? '46%' : '52%'};width:${(ch * 0.95) | 0}px;height:${(ch * 0.95) | 0}px;transform:translate(-50%,-50%);border-radius:50%;background:radial-gradient(circle,${P.c}55 0%,${P.b}33 45%,transparent 70%)"></div>
<img src="${fileUrl(file)}" style="position:absolute;left:${left};bottom:0;height:${ch | 0}px;transform:translateX(-50%);filter:drop-shadow(0 20px 40px rgba(0,0,0,.45))">
<div style="position:absolute;inset:0;background:linear-gradient(180deg,transparent ${V ? 52 : 62}%,rgba(0,0,0,.7) 100%)"></div>`;
  }

  function background(P, W, H, scene, info) {
    const who = scene.who === 'opponent' ? 'opp' : 'cand';
    if (who === 'cand' && (scene.type === 'photo' || scene.type === 'vote')) {
      if (info.cutout && fs.existsSync(info.cutout)) return cutoutBg(P, W, H, info.cutout);
      if (info.silhouette) return `${(info.backgrounds || []).length && fs.existsSync(info.backgrounds[0]) ? photoBg(P, info.backgrounds[0], 0) : `<div style="position:absolute;inset:0;background:linear-gradient(160deg,${P.bg1},${P.bg2})"></div><div style="position:absolute;inset:0;background:repeating-linear-gradient(-35deg,rgba(255,255,255,.04) 0 40px,transparent 40px 80px)"></div>`}${silhouette(P, W, H)}<div style="position:absolute;inset:0;background:linear-gradient(180deg,transparent 55%,rgba(0,0,0,.6) 100%)"></div>`;
    }
    const photo = scene.type === 'photo' || scene.type === 'vote' ? (who === 'opp' ? info.oppPhoto : info.photo) : null;
    const grain = `<div style="position:absolute;inset:0;opacity:.18;background-image:repeating-linear-gradient(0deg,rgba(255,255,255,.08) 0 1px,transparent 1px 3px)"></div>`;
    const vignette = `<div style="position:absolute;inset:0;background:radial-gradient(ellipse at 50% 40%,transparent 40%,rgba(0,0,0,.55) 100%)"></div>`;
    if (photo && fs.existsSync(photo)) {
      const attack = who === 'opp';
      return `<div style="position:absolute;inset:0;background:url('${fileUrl(photo)}') center 25%/cover;filter:${attack ? 'grayscale(1) contrast(1.25) brightness(.8)' : 'saturate(1.05)'}"></div>
<div style="position:absolute;inset:0;background:${attack ? 'rgba(160,15,30,.35)' : P.wash};mix-blend-mode:${attack ? 'multiply' : 'normal'}"></div>
<div style="position:absolute;inset:0;background:linear-gradient(180deg,transparent 35%,rgba(0,0,0,.75) 100%)"></div>${grain}${vignette}`;
    }
    const bgs = info.backgrounds || [];
    if (bgs.length && !['quote', 'disclaimer'].includes(scene.type)) {
      const i = (info.sceneIndex || 0) % bgs.length;
      if (fs.existsSync(bgs[i])) return `${photoBg(P, bgs[i], info.sceneIndex || 0)}<div style="position:absolute;inset:0;opacity:.18;background-image:repeating-linear-gradient(0deg,rgba(255,255,255,.08) 0 1px,transparent 1px 3px)"></div><div style="position:absolute;inset:0;background:radial-gradient(ellipse at 50% 40%,transparent 40%,rgba(0,0,0,.55) 100%)"></div>`;
    }
    const stars = Array.from({ length: 18 }, (_, k) => `<div style="position:absolute;left:${(k * 137) % W}px;top:${(k * 251) % H}px;font-size:${18 + (k % 4) * 8}px;color:rgba(255,255,255,.07)">★</div>`).join('');
    const stripes = `<div style="position:absolute;inset:0;background:repeating-linear-gradient(-35deg,rgba(255,255,255,.035) 0 40px,transparent 40px 80px)"></div>`;
    return `<div style="position:absolute;inset:0;background:linear-gradient(160deg,${P.bg1},${P.bg2})"></div>${stripes}${stars}${grain}${vignette}`;
  }

  /** Light sweep across the frame: the subtle motion layer for this style. */
  function deco(P, W, H) {
    return `<div style="position:absolute;inset:0;background:linear-gradient(100deg,transparent 38%,rgba(255,255,255,.09) 50%,transparent 62%)"></div>`;
  }

  function layout(s, P, V, info) {
    const W = V ? 1080 : 1920; const H = V ? 1920 : 1080;
    const els = []; const box = (v, hz) => (V ? v : hz);
    const add = (b, html, anim, at) => els.push({ x: b[0], y: b[1], w: b[2], h: b[3], html, anim, at });
    const title = (t, size) => `<div class="fit cx-title" style="font-size:${size}px"><span>${mark(String(t || '').toUpperCase())}</span></div>`;
    const bar = (t, size, bg) => `<div class="cx-bar" style="${bg ? `background:${bg}` : ''}"><div class="fit cx-sub" style="font-size:${size}px"><span>${cap(t)}</span></div></div>`;
    const cite = s.cite ? info.citeText(s.cite) : '';
    switch (s.type) {
      case 'headline': {
        const t = esc(s.title || '').replace(/\*([^*]+)\*/g, '<mark>$1</mark>');
        add(box([60, 470, 960, 900], [300, 140, 1320, 720]), `<div class="cx-paper"><div class="cx-outlet"><span>${esc(s.outlet || 'News')}</span><span style="font-weight:400;font-size:26px">${esc(s.date || '')}</span></div><div class="fit cx-head" style="font-size:${V ? 120 : 118}px;justify-content:flex-start;text-align:left"><span>${t}</span></div></div>`, 'pop', 0.1);
        if (s.sub) add(box([60, 1420, 960, 140], [300, 900, 1320, 120]), bar(s.sub, 50), 'slideX', 0.7);
        break;
      }
      case 'contrast': {
        const col = (side, i) => {
          const good = i === 0;
          const items = (side.items || []).slice(0, 3).map((x) => `<div class="cx-item"><i style="background:${good ? '#1f9d55' : P.b}">${good ? '✓' : '✕'}</i><span>${esc(x)}</span></div>`).join('');
          return `<div class="cx-col" style="background:${good ? P.a : '#1b1d22'};border-top:12px solid ${good ? P.c : P.b}"><h3>${cap(side.label)}</h3>${items}</div>`;
        };
        if (s.headline) add(box([40, 150, 1000, 230], [100, 60, 1720, 170]), title(s.headline, V ? 120 : 110), 'slide', 0.05);
        add(box([40, 420, 1000, 620], [100, 270, 850, 680]), col(s.left || {}, 0), 'slideX', 0.3);
        add(box([40, 1080, 1000, 620], [970, 270, 850, 680]), col(s.right || {}, 1), 'slideX', 0.6);
        break;
      }
      case 'stat':
        add(box([40, 560, 1000, 440], [120, 230, 1680, 420]), title(s.value, V ? 300 : 300), 'pop', 0.15);
        add(box([90, 1040, 900, 170], [360, 690, 1200, 140]), bar(s.label, V ? 52 : 54), 'slideX', 0.55);
        break;
      case 'issues':
        add(box([40, 300, 1000, 300], [120, 90, 1680, 220]), title(s.headline, V ? 130 : 120), 'slide', 0.05);
        (s.items || []).slice(0, 4).forEach((it, k) => add(V ? [60, 680 + k * 220, 960, 180] : [260, 360 + k * 150, 1400, 128],
          `<div class="cx-bar" style="background:${k % 2 ? P.b : P.a};justify-content:flex-start;gap:26px"><span style="font:400 ${V ? 80 : 70}px Tall;color:${P.c}">${k + 1}</span><div class="fit cx-sub" style="font-size:${V ? 48 : 46}px;justify-content:flex-start;text-align:left"><span>${cap(it)}</span></div></div>`, 'slideX', 0.35 + k * 0.25));
        break;
      case 'quote':
        add(box([60, 500, 960, 760], [200, 170, 1520, 560]), `<div class="fit cx-title" style="font-size:${V ? 96 : 90}px;font-family:Pop;font-weight:800;text-transform:none"><span>“${esc(s.quote || '')}”</span></div>`, 'fade', 0.1);
        if (s.source) add(box([120, 1300, 840, 120], [460, 780, 1000, 110]), bar(`— ${s.source}`, 40), 'slideX', 0.6);
        break;
      case 'vote': {
        const side = info.cutout || info.silhouette;
        add(box([40, side ? 1080 : 640, 1000, side ? 380 : 520], side ? [90, 230, 1060, 420] : [120, 220, 1680, 440]), title(s.headline || `Vote ${info.name}`, V ? 190 : 200), 'pop', 0.1);
        if (s.date) add(box([90, side ? 1480 : 1200, 900, 140], side ? [90, 690, 900, 120] : [460, 700, 1000, 130]), bar(s.date, 54, P.b), 'slideX', 0.5);
        if (s.button) add(box([140, side ? 1640 : 1380, 800, 110], side ? [90, 840, 900, 100] : [560, 850, 800, 100]), `<div class="fit cx-sub" style="font-size:46px;color:#fff"><span>${esc(s.button)}</span></div>`, 'fade', 0.8);
        break;
      }
      case 'counter': {
        const target = Number(s.to) || 0; const K = 12; const dur = 1.4; const from = 0.2;
        for (let k = 0; k < K; k++) {
          const v = target * (1 - Math.pow(1 - (k + 1) / K, 3)); const b = box([40, 560, 1000, 440], [120, 230, 1680, 420]);
          els.push({ x: b[0], y: b[1], w: b[2], h: b[3], html: title(`${s.prefix || ''}${compact(v, target)}${s.suffix || ''}`, V ? 300 : 300), anim: 'step', at: from + (dur * k) / K, until: k === K - 1 ? 999 : from + (dur * (k + 1)) / K });
        }
        add(box([90, 1040, 900, 170], [360, 690, 1200, 140]), bar(s.label, V ? 52 : 54), 'slideX', 0.6);
        break;
      }
      case 'chart': {
        if (s.headline) add(box([40, 220, 1000, 260], [100, 60, 1720, 190]), title(s.headline, V ? 120 : 110), 'slide', 0.05);
        const bars = (s.bars || []).slice(-8); const max = Math.max(1, ...bars.map((x) => Number(x.value) || 0)); const n = Math.max(1, bars.length);
        const area = V ? [70, 560, 940, 1020] : [160, 290, 1600, 660]; const gap = Math.round(area[2] * 0.05); const bw = Math.floor((area[2] - gap * (n - 1)) / n);
        bars.forEach((x, k) => {
          const hgt = Math.max(20, Math.round((area[3] - 150) * ((Number(x.value) || 0) / max))); const bx = area[0] + k * (bw + gap); const by = area[1] + area[3] - 70 - hgt;
          const last = k === bars.length - 1;
          els.push({ x: bx, y: by, w: bw, h: hgt, html: `<div style="position:absolute;inset:0;background:${last ? P.c : '#ffffff'};opacity:${last ? 1 : 0.85}"></div>`, anim: 'grow', at: 0.35 + k * 0.12 });
          els.push({ x: bx - 10, y: by - 72, w: bw + 20, h: 64, html: `<div class="fit cx-sub" style="font-size:${V ? 42 : 40}px"><span>${esc(x.display || compact(Number(x.value) || 0))}</span></div>`, anim: 'fade', at: 0.8 + k * 0.12 });
          els.push({ x: bx - 10, y: area[1] + area[3] - 62, w: bw + 20, h: 58, html: `<div class="fit cx-sub" style="font-size:${V ? 32 : 30}px;opacity:.8"><span>${esc(x.label || '')}</span></div>`, anim: 'fade', at: 0.3 });
        });
        break;
      }
      case 'checklist': {
        if (s.headline) add(box([40, 260, 1000, 280], [100, 80, 1720, 200]), title(s.headline, V ? 120 : 110), 'slide', 0.05);
        (s.items || []).slice(0, 5).forEach((it, k) => add(V ? [70, 640 + k * 210, 940, 170] : [260, 330 + k * 140, 1400, 118],
          `<div style="position:absolute;inset:8px;display:flex;align-items:center;gap:28px;background:rgba(255,255,255,.1);border-radius:22px;padding:0 30px;border:2px solid rgba(255,255,255,.18)"><span style="flex:none;width:${V ? 86 : 72}px;height:${V ? 86 : 72}px;border-radius:50%;background:${P.c};color:${P.ink};display:flex;align-items:center;justify-content:center;font:800 ${V ? 54 : 46}px Pop">✓</span><div class="fit cx-sub" style="font-size:${V ? 52 : 46}px;justify-content:flex-start;text-align:left"><span>${cap(it)}</span></div></div>`, 'pop', 0.4 + k * 0.45));
        break;
      }
      case 'notification': {
        // A phone with a news alert sliding in (real, cited headline only).
        const pw = V ? 640 : 520; const ph = V ? 1180 : 880; const px = V ? 220 : 1260; const py = V ? 380 : 70;
        add([px, py, pw, ph], `<div style="position:absolute;inset:0;border-radius:${pw * 0.14 | 0}px;background:#0d0f14;border:14px solid #1d2028;box-shadow:0 40px 80px rgba(0,0,0,.5);overflow:hidden"><div style="position:absolute;inset:0;background:linear-gradient(170deg,${P.bg2},${P.bg1})"></div><div style="position:absolute;top:${ph * 0.12 | 0}px;width:100%;text-align:center;font:600 ${pw * 0.2 | 0}px Pop;color:#fff;opacity:.95">${esc(s.time || '9:41')}</div></div>`, 'slide', 0.05);
        add([px + 26, py + ph * 0.36 | 0, pw - 52, V ? 300 : 250], `<div style="position:absolute;inset:6px;border-radius:30px;background:rgba(250,250,252,.96);padding:22px 26px;display:flex;flex-direction:column;gap:8px;box-shadow:0 14px 30px rgba(0,0,0,.3)"><div style="display:flex;justify-content:space-between;font:700 ${V ? 26 : 22}px Pop;color:#666"><span>${esc(s.outlet || 'News')}</span><span>now</span></div><div class="fit" style="font:800 ${V ? 40 : 34}px Pop;color:#111;justify-content:flex-start;text-align:left;align-items:flex-start"><span>${esc(s.title || '')}</span></div></div>`, 'pop', 0.6);
        if (s.sub) add(box([60, 1620, 960, 140], [100, 440, 1060, 200]), V ? bar(s.sub, 48) : title(s.sub, 110), 'slideX', 1.1);
        break;
      }
      case 'disclaimer':
        add(box([80, 820, 920, 280], [300, 420, 1320, 240]), `<div class="fit cx-sub" style="font-size:34px;font-weight:600;text-transform:none;letter-spacing:0;color:rgba(255,255,255,.9)"><span>${esc(s.text || '')}</span></div>`, 'fade', 0.1);
        break;
      case 'photo':
      default: {
        const side = s.who !== 'opponent' && (info.cutout || info.silhouette);
        add(box([40, 1060, 1000, 460], side ? [90, 300, 1060, 400] : [100, 560, 1720, 300]), title(s.headline, V ? 150 : side ? 140 : 150), 'slide', 0.15);
        if (s.sub) add(box([60, 1540, 960, 130], side ? [90, 740, 900, 110] : [100, 870, 1100, 110]), bar(s.sub, V ? 46 : 46, s.who === 'opponent' ? P.b : P.a), 'slideX', 0.6);
      }
    }
    if (cite) add(box([40, 1780, 1000, 60], [60, 1010, 1300, 50]), `<div class="fit cx-cite"><span>${esc(cite)}</span></div>`, 'fade', 0.4);
    return { W, H, els };
  }

  return { css, background, deco, layout };
}

module.exports = { setup, PALETTES, paletteFor };
