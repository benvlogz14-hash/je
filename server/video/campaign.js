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
  contrast: { a: '#111418', b: '#d7263d', c: '#f2c14e', ink: '#0d0f12', paper: '#f4f1ea', wash: 'rgba(20,20,24,.6)', bg1: '#121418', bg2: '#2a2d33' },
};

function setup(h) {
  const { esc, fileUrl } = h;
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

  function background(P, W, H, scene, info) {
    const who = scene.who === 'opponent' ? 'opp' : 'cand';
    const photo = scene.type === 'photo' || scene.type === 'vote' ? (who === 'opp' ? info.oppPhoto : info.photo) : null;
    const grain = `<div style="position:absolute;inset:0;opacity:.18;background-image:repeating-linear-gradient(0deg,rgba(255,255,255,.08) 0 1px,transparent 1px 3px)"></div>`;
    const vignette = `<div style="position:absolute;inset:0;background:radial-gradient(ellipse at 50% 40%,transparent 40%,rgba(0,0,0,.55) 100%)"></div>`;
    if (photo && fs.existsSync(photo)) {
      const attack = who === 'opp';
      return `<div style="position:absolute;inset:0;background:url('${fileUrl(photo)}') center 25%/cover;filter:${attack ? 'grayscale(1) contrast(1.25) brightness(.8)' : 'saturate(1.05)'}"></div>
<div style="position:absolute;inset:0;background:${attack ? 'rgba(160,15,30,.35)' : P.wash};mix-blend-mode:${attack ? 'multiply' : 'normal'}"></div>
<div style="position:absolute;inset:0;background:linear-gradient(180deg,transparent 35%,rgba(0,0,0,.75) 100%)"></div>${grain}${vignette}`;
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
      case 'vote':
        add(box([40, 640, 1000, 520], [120, 220, 1680, 440]), title(s.headline || `Vote ${info.name}`, V ? 190 : 200), 'pop', 0.1);
        if (s.date) add(box([90, 1200, 900, 150], [460, 700, 1000, 130]), bar(s.date, 54, P.b), 'slideX', 0.5);
        if (s.button) add(box([140, 1380, 800, 120], [560, 850, 800, 100]), `<div class="fit cx-sub" style="font-size:46px;color:#fff"><span>${esc(s.button)}</span></div>`, 'fade', 0.8);
        break;
      case 'disclaimer':
        add(box([80, 820, 920, 280], [300, 420, 1320, 240]), `<div class="fit cx-sub" style="font-size:34px;font-weight:600;text-transform:none;letter-spacing:0;color:rgba(255,255,255,.9)"><span>${esc(s.text || '')}</span></div>`, 'fade', 0.1);
        break;
      case 'photo':
      default:
        add(box([40, 1060, 1000, 460], [100, 560, 1720, 300]), title(s.headline, V ? 150 : 150), 'slide', 0.15);
        if (s.sub) add(box([60, 1540, 960, 130], [100, 870, 1100, 110]), bar(s.sub, V ? 46 : 46, s.who === 'opponent' ? P.b : P.a), 'slideX', 0.6);
    }
    if (cite) add(box([40, 1780, 1000, 60], [60, 1010, 1300, 50]), `<div class="fit cx-cite"><span>${esc(cite)}</span></div>`, 'fade', 0.4);
    return { W, H, els };
  }

  return { css, background, deco, layout };
}

module.exports = { setup, PALETTES };
