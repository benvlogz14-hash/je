'use strict';
/**
 * Code-drawn motion graphics: every scene is laid out in HTML/CSS, screenshotted
 * by a headless Chromium browser (Edge on Windows) as a "sprite" holding the
 * background and each element, then FFmpeg cuts the sprite apart and animates
 * the pieces (pop, slide, float, slow zoom) and joins scenes with transitions.
 * One storyboard renders both 1080×1920 and 1920×1080.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const ctx = require('../core/ctx');
const ff = require('./ffmpeg');
const { run } = require('../core/util');
const campaign = require('./campaign');

const FONTS = path.join(__dirname, '..', '..', 'renderer', 'assets', 'fonts');
const FPS = 30;

// ------------------------------------------------------------------ browser

let browserPath;
function findBrowser() {
  if (browserPath !== undefined) return browserPath;
  const custom = ctx.setting('tools.browserPath', '');
  const pf = process.env.ProgramFiles || 'C:\\Program Files'; const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const la = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const list = [custom,
    ...(process.platform === 'win32' ? [
      path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'), path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'), path.join(la, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ] : process.platform === 'darwin' ? [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ] : ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/usr/bin/microsoft-edge', '/opt/pw-browsers/chromium'])];
  browserPath = list.find((p) => p && fs.existsSync(p)) || null;
  return browserPath;
}

function browserArgs(work) {
  // Own profile folder so it never attaches to the browser you have open.
  return ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    `--user-data-dir=${path.join(work, 'profile')}`, '--force-device-scale-factor=1', '--virtual-time-budget=4000', '--run-all-compositor-stages-before-draw',
    ...(process.platform === 'linux' ? ['--no-sandbox'] : [])];
}
const fileUrl = (p) => 'file:///' + path.resolve(p).replace(/\\/g, '/').replace(/^\/+/, '');

async function screenshot(htmlFile, out, w, h, work) {
  const b = findBrowser();
  if (!b) throw Object.assign(new Error('No Edge or Chrome found to draw the graphics. Install Microsoft Edge or Google Chrome, or set its path in Settings → System.'), { permanent: true });
  try { fs.unlinkSync(out); } catch { /* none */ }
  await run(b, [...browserArgs(work), '--default-background-color=00000000', `--window-size=${w},${h}`, `--screenshot=${out}`, fileUrl(htmlFile)], { timeoutMs: 90000 });
  if (!fs.existsSync(out)) throw new Error('The browser did not produce the graphic.');
}

async function printPdf(htmlFile, out, work) {
  const b = findBrowser();
  if (!b) throw Object.assign(new Error('No Edge or Chrome found to make the PDF.'), { permanent: true });
  try { fs.unlinkSync(out); } catch { /* none */ }
  await run(b, [...browserArgs(work), '--no-pdf-header-footer', '--print-to-pdf-no-header', `--print-to-pdf=${out}`, fileUrl(htmlFile)], { timeoutMs: 90000 });
  if (!fs.existsSync(out)) throw new Error('The browser did not produce the PDF.');
}

// ------------------------------------------------------------------ look

const THEMES = {
  blue: { a: '#2f6bff', b: '#ff5c8a', c: '#ffd23f', ink: '#10204a', bg1: '#e9f0ff', bg2: '#fff0f6', soft: '#cfe0ff' },
  red: { a: '#e8304a', b: '#2f6bff', c: '#ffd23f', ink: '#3a0d16', bg1: '#fff0f2', bg2: '#eef4ff', soft: '#ffd3da' },
  purple: { a: '#7a4dff', b: '#ff7a45', c: '#2fd3a7', ink: '#22124a', bg1: '#f3eeff', bg2: '#fff4ec', soft: '#e0d4ff' },
  green: { a: '#14a06f', b: '#ff6b6b', c: '#ffd23f', ink: '#0b3326', bg1: '#e9fbf3', bg2: '#fff4ef', soft: '#c8f1df' },
};
function mix(hex, to, t) {
  const h = (x) => parseInt(x, 16); const c = hex.replace('#', ''); const d = to.replace('#', '');
  const v = [0, 2, 4].map((i) => Math.round(h(c.substr(i, 2)) * (1 - t) + h(d.substr(i, 2)) * t));
  return '#' + v.map((x) => x.toString(16).padStart(2, '0')).join('');
}
/** A full palette from one brand colour (e.g. a client's highlight colour). */
function themeFromColor(hex) {
  const a = /^#[0-9a-f]{6}$/i.test(hex) ? hex : '#7a4dff';
  return { a, b: '#ff5c8a', c: '#ffd23f', ink: mix(a, '#000000', 0.72), bg1: mix(a, '#ffffff', 0.9), bg2: '#fff3f7', soft: mix(a, '#ffffff', 0.72) };
}
function themeFor(party, override) {
  if (override && THEMES[override]) return THEMES[override];
  if (override && /^#[0-9a-f]{6}$/i.test(override)) return themeFromColor(override);
  const p = String(party || '').toLowerCase();
  if (/democrat/.test(p)) return THEMES.blue;
  if (/republican/.test(p)) return THEMES.red;
  if (/green/.test(p)) return THEMES.green;
  return THEMES.purple;
}

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function css(T) {
  return `@font-face{font-family:Pop;font-weight:800;src:url('${fileUrl(path.join(FONTS, 'Montserrat_800ExtraBold.ttf'))}')}
@font-face{font-family:Pop;font-weight:600;src:url('${fileUrl(path.join(FONTS, 'Montserrat_600SemiBold.ttf'))}')}
@font-face{font-family:Tall;src:url('${fileUrl(path.join(FONTS, 'Anton_400Regular.ttf'))}')}
*{box-sizing:border-box;margin:0;padding:0}
html,body{background:transparent;overflow:hidden}
body{font-family:Pop,'Segoe UI',Arial,sans-serif;font-weight:800;color:${T.ink}}
.slot{position:absolute;left:0;overflow:hidden;display:flex;align-items:center;justify-content:center}
.fit{width:100%;height:100%;display:flex;align-items:center;justify-content:center;text-align:center;line-height:1.05;overflow:hidden}
.fit>span{display:block;max-width:100%;overflow-wrap:normal;word-break:keep-all;hyphens:none}
.card{position:absolute;inset:18px;border-radius:44px;background:#fff;box-shadow:0 14px 0 ${T.soft},0 24px 50px rgba(20,30,80,.18);display:flex;align-items:center;justify-content:center;padding:26px 40px}
.pill{position:absolute;inset:14px;border-radius:999px;display:flex;align-items:center;justify-content:center;padding:0 48px;box-shadow:0 10px 0 rgba(0,0,0,.12)}
.hl{color:${T.ink};letter-spacing:-.02em}
.hl b{color:${T.a}}
.grad{background:linear-gradient(120deg,${T.a},${T.b});-webkit-background-clip:text;background-clip:text;color:transparent}`;
}

const FIT = `<script>
function fit(){for(const el of document.querySelectorAll('.fit')){const s=el.firstElementChild;if(!s)continue;let f=parseFloat(getComputedStyle(el).fontSize);let n=0;
while((s.offsetHeight>el.clientHeight+1||s.scrollWidth>el.clientWidth+1)&&f>14&&n++<200){f-=2;el.style.fontSize=f+'px';}}}
(document.fonts&&document.fonts.ready?document.fonts.ready:Promise.resolve()).then(fit);fit();
</script>`;

/** Highlight *words* between asterisks in the accent colour. */
const mark = (s) => esc(s).replace(/\*([^*]+)\*/g, '<b>$1</b>');

function rng(seed) { let s = seed * 9301 + 49297; return () => ((s = (s * 9301 + 49297) % 233280) / 233280); }

function background(T, W, H, i) {
  const r = rng(i + 7);
  const blobs = Array.from({ length: 5 }, (_, k) => {
    const c = [T.a, T.b, T.c, T.soft, T.b][k]; const s = (0.35 + r() * 0.4) * Math.max(W, H);
    return `<div style="position:absolute;left:${(r() * W - s / 2) | 0}px;top:${(r() * H - s / 2) | 0}px;width:${s | 0}px;height:${s | 0}px;border-radius:50%;background:${c};opacity:${0.16 + r() * 0.14};filter:blur(${(s / 7) | 0}px)"></div>`;
  }).join('');
  const grid = `<div style="position:absolute;inset:0;background-image:radial-gradient(${T.ink}14 2.5px,transparent 3px);background-size:46px 46px"></div>`;
  return `<div style="position:absolute;inset:0;background:linear-gradient(${150 + i * 25}deg,${T.bg1},${T.bg2})"></div>${blobs}${grid}`;
}

function decoLayer(T, W, H, i) {
  const r = rng(i + 101); const u = Math.min(W, H) / 1080;
  const shapes = Array.from({ length: 12 }, () => {
    const kind = r(); const s = (26 + r() * 60) * u; const c = [T.a, T.b, T.c][(r() * 3) | 0];
    const x = r() * W; const y = r() * H; const rot = r() * 360;
    if (kind < 0.35) return `<div style="position:absolute;left:${x | 0}px;top:${y | 0}px;width:${s | 0}px;height:${s | 0}px;border-radius:50%;background:${c};opacity:.85"></div>`;
    if (kind < 0.6) return `<div style="position:absolute;left:${x | 0}px;top:${y | 0}px;width:${s | 0}px;height:${s | 0}px;border-radius:50%;border:${(s / 5) | 0}px solid ${c};opacity:.8"></div>`;
    if (kind < 0.8) return `<div style="position:absolute;left:${x | 0}px;top:${y | 0}px;width:${(s * 1.6) | 0}px;height:${(s / 3.2) | 0}px;border-radius:99px;background:${c};transform:rotate(${rot | 0}deg);opacity:.8"></div>`;
    return `<div style="position:absolute;left:${x | 0}px;top:${y | 0}px;font:800 ${(s * 1.3) | 0}px Pop;color:${c};transform:rotate(${rot | 0}deg)">✦</div>`;
  }).join('');
  return shapes;
}

// ------------------------------------------------------------------ scene layouts

/**
 * Each element: { x, y, w, h, html, anim: 'pop'|'slide'|'fade'|'drift', at }.
 * Coordinates are in output pixels for the given orientation.
 */
function layout(scene, T, V, ctxInfo) {
  const W = V ? 1080 : 1920; const H = V ? 1920 : 1080;
  const box = (vx, hx) => (V ? vx : hx);
  const els = [];
  const add = (b, html, anim, at) => els.push({ x: b[0], y: b[1], w: b[2], h: b[3], html, anim, at });
  const big = (txt, size, cls = 'hl') => `<div class="fit ${cls}" style="font-size:${size}px"><span>${mark(txt)}</span></div>`;
  const pill = (txt, size, bg, color = '#fff') => `<div class="pill" style="background:${bg}"><div class="fit" style="font-size:${size}px;color:${color}"><span>${mark(txt)}</span></div></div>`;
  const card = (inner) => `<div class="card">${inner}</div>`;
  const s = scene;

  switch (s.type) {
    case 'portrait': {
      const photo = ctxInfo.photo ? `<div style="position:absolute;inset:30px;border-radius:50%;background:url('${fileUrl(ctxInfo.photo)}') center 22%/cover;border:22px solid #fff;box-shadow:0 0 0 14px ${T.a},0 30px 60px rgba(0,0,0,.2)"></div>`
        : `<div style="position:absolute;inset:30px;border-radius:50%;background:linear-gradient(135deg,${T.a},${T.b});border:22px solid #fff;box-shadow:0 0 0 14px ${T.c};display:flex;align-items:center;justify-content:center;font:800 ${V ? 230 : 260}px Pop;color:#fff">${esc(initials(ctxInfo.name))}</div>`;
      add(box([200, 330, 680, 680], [190, 170, 740, 740]), photo, 'pop', 0.05);
      add(box([70, 1060, 940, 190], [990, 300, 820, 220]), pill(s.headline || ctxInfo.name, V ? 86 : 90, T.a), 'slide', 0.35);
      if (s.sub) add(box([130, 1270, 820, 140], [990, 545, 820, 150]), pill(s.sub, V ? 50 : 52, '#fff', T.ink), 'slide', 0.6);
      if (s.badge) add(box([700, 260, 300, 160], [720, 120, 300, 160]), pill(s.badge, 48, T.b), 'pop', 0.9);
      break;
    }
    case 'stat':
      if (s.kicker) add(box([190, 430, 700, 120], [610, 130, 700, 120]), pill(s.kicker, 46, T.c, T.ink), 'pop', 0.05);
      add(box([40, 580, 1000, 420], [140, 270, 1640, 400]), `<div class="fit grad" style="font-size:${V ? 250 : 260}px;font-family:Tall,Pop;font-weight:400;letter-spacing:.01em"><span>${esc(s.value || '')}</span></div>`, 'pop', 0.25);
      add(box([70, 1020, 940, 300], [240, 690, 1440, 220]), card(big(s.label || '', V ? 62 : 64)), 'slide', 0.55);
      break;
    case 'issues': {
      add(box([50, 300, 980, 330], [140, 80, 1640, 230]), big(s.headline || '', V ? 108 : 104), 'slide', 0.05);
      const items = (s.items || []).slice(0, 4);
      items.forEach((it, k) => {
        const b = V ? [80, 680 + k * 250, 920, 220] : [k % 2 ? 980 : 140, 360 + Math.floor(k / 2) * 290, 800, 250];
        const dot = `<span style="flex:none;width:${V ? 70 : 64}px;height:${V ? 70 : 64}px;border-radius:50%;background:${[T.a, T.b, T.c, T.a][k]};display:inline-flex;align-items:center;justify-content:center;color:#fff;font-size:${V ? 40 : 36}px;margin-right:26px">${k + 1}</span>`;
        add(b, `<div class="card" style="justify-content:flex-start">${dot}<div class="fit hl" style="font-size:${V ? 56 : 52}px;justify-content:flex-start;text-align:left"><span>${mark(it)}</span></div></div>`, 'pop', 0.4 + k * 0.28);
      });
      break;
    }
    case 'quote':
      add(box([50, 420, 980, 900], [180, 120, 1560, 660]), `<div class="card" style="flex-direction:column;padding:60px 70px"><div style="font:800 ${V ? 200 : 180}px/0.6 Pop;color:${T.b};align-self:flex-start;height:${V ? 110 : 90}px">“</div><div class="fit hl" style="font-size:${V ? 76 : 70}px;height:auto;flex:1;width:100%;min-height:0"><span>${esc(s.quote || '')}</span></div></div>`, 'pop', 0.05);
      if (s.source) add(box([130, 1370, 820, 130], [520, 820, 880, 120]), pill(`— ${s.source}`, 44, T.a), 'slide', 0.6);
      break;
    case 'cta':
      add(box([50, 520, 980, 480], [140, 190, 1640, 400]), big(s.headline || '', V ? 130 : 128), 'pop', 0.05);
      if (s.button) add(box([140, 1060, 800, 190], [510, 620, 900, 180]), pill(s.button, V ? 64 : 66, `linear-gradient(120deg,${T.a},${T.b})`), 'pop', 0.5);
      if (s.sub) add(box([90, 1300, 900, 160], [260, 840, 1400, 130]), big(s.sub, V ? 50 : 48), 'fade', 0.85);
      break;
    case 'counter': {
      // Count-up: each in-between value is its own frame, swapped in quick steps (ease-out).
      if (s.kicker) add(box([190, 430, 700, 120], [610, 130, 700, 120]), pill(s.kicker, 46, T.c, T.ink), 'pop', 0.05);
      const target = Number(s.to) || 0; const K = 16; const dur = 1.4; const from = 0.25;
      for (let k = 0; k < K; k++) {
        const p = (k + 1) / K; const v = target * (1 - Math.pow(1 - p, 3));
        const b = box([40, 580, 1000, 420], [140, 270, 1640, 400]);
        els.push({ x: b[0], y: b[1], w: b[2], h: b[3], html: `<div class="fit grad" style="font-size:${V ? 250 : 260}px;font-family:Tall,Pop;font-weight:400"><span>${esc((s.prefix || '') + compact(v, target) + (s.suffix || ''))}</span></div>`, anim: 'step', at: from + (dur * k) / K, until: k === K - 1 ? 999 : from + (dur * (k + 1)) / K });
      }
      add(box([70, 1020, 940, 300], [240, 690, 1440, 220]), card(big(s.label || '', V ? 62 : 64)), 'slide', 0.55);
      break;
    }
    case 'chart': {
      add(box([50, 260, 980, 260], [140, 70, 1640, 200]), big(s.headline || '', V ? 96 : 92), 'slide', 0.05);
      const bars = (s.bars || []).slice(-8); const max = Math.max(1, ...bars.map((x) => Number(x.value) || 0));
      const area = V ? [70, 600, 940, 980] : [160, 300, 1600, 640]; const n = Math.max(1, bars.length);
      const gap = Math.round(area[2] * 0.04); const bw = Math.floor((area[2] - gap * (n - 1)) / n);
      const colors = [T.a, T.b, T.c];
      bars.forEach((x, k) => {
        const hgt = Math.max(24, Math.round((area[3] - 150) * ((Number(x.value) || 0) / max)));
        const bx = area[0] + k * (bw + gap); const by = area[1] + area[3] - 70 - hgt;
        els.push({ x: bx, y: by, w: bw, h: hgt, html: `<div style="position:absolute;inset:0;border-radius:${Math.min(28, bw / 3) | 0}px ${Math.min(28, bw / 3) | 0}px 10px 10px;background:linear-gradient(180deg,${colors[k % 3]},${mix(colors[k % 3], '#ffffff', 0.35)});box-shadow:0 10px 0 ${T.soft}"></div>`, anim: 'grow', at: 0.35 + k * 0.12 });
        els.push({ x: bx - 10, y: by - 70, w: bw + 20, h: 62, html: `<div class="fit hl" style="font-size:${V ? 40 : 38}px"><span>${esc(x.display || compact(Number(x.value) || 0))}</span></div>`, anim: 'fade', at: 0.8 + k * 0.12 });
        els.push({ x: bx - 10, y: area[1] + area[3] - 62, w: bw + 20, h: 58, html: `<div class="fit" style="font-size:${V ? 34 : 32}px;color:${T.ink};opacity:.8;font-weight:600"><span>${esc(x.label || '')}</span></div>`, anim: 'fade', at: 0.3 });
      });
      break;
    }
    case 'gallery': {
      add(box([50, 230, 980, 260], [140, 60, 1640, 190]), big(s.headline || '', V ? 100 : 92), 'slide', 0.05);
      const imgs = (s.images || []).filter((f) => f && fs.existsSync(f)).slice(0, 6);
      const cols = V ? 2 : 3; const rows = Math.ceil(imgs.length / cols) || 1;
      const area = V ? [70, 540, 940, 1240] : [160, 280, 1600, 740];
      const cw = Math.floor((area[2] - 30 * (cols - 1)) / cols); const ch = Math.floor((area[3] - 30 * (rows - 1)) / rows);
      imgs.forEach((f, k) => {
        const cx = area[0] + (k % cols) * (cw + 30); const cy = area[1] + Math.floor(k / cols) * (ch + 30);
        els.push({ x: cx, y: cy, w: cw, h: ch, html: `<div style="position:absolute;inset:12px;border-radius:30px;background:#fff url('${fileUrl(f)}') center/cover;border:10px solid #fff;box-shadow:0 10px 0 ${T.soft},0 20px 40px rgba(0,0,0,.18);transform:rotate(${(k % 2 ? 1 : -1) * (1 + (k % 3))}deg)"></div>`, anim: 'pop', at: 0.3 + k * 0.18 });
      });
      break;
    }
    case 'end':
      add(box([90, 640, 900, 420], [260, 250, 1400, 360]), big(s.headline || ctxInfo.name, V ? 120 : 120, 'hl grad'), 'pop', 0.05);
      if (s.sub) add(box([140, 1110, 800, 150], [460, 660, 1000, 150]), pill(s.sub, 52, T.ink), 'slide', 0.45);
      break;
    case 'hook':
    default:
      if (s.badge) add(box([660, 330, 360, 170], [1440, 110, 360, 170]), pill(s.badge, 54, T.b), 'pop', 0.85);
      add(box([40, 520, 1000, 620], [120, 210, 1680, 460]), big(s.headline || '', V ? 140 : 140), 'pop', 0.05);
      if (s.sub) add(box([90, 1170, 900, 240], [260, 700, 1400, 180]), card(big(s.sub, V ? 56 : 56)), 'slide', 0.5);
  }
  return { W, H, els };
}

/** 48213 → 48.2K (decimals follow the final value so the count lands exactly). */
function compact(v, target = v) {
  const big = Math.abs(target);
  if (big >= 1e9) return (v / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
  if (big >= 1e6) return (v / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (big >= 1e4) return (v / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
  return Math.round(v).toLocaleString('en-US');
}

function initials(n) { return String(n || '?').split(/\s+/).filter(Boolean).map((w) => w[0]).slice(0, 2).join('').toUpperCase(); }

const DEFAULT_SEC = { hook: 4.5, portrait: 4.5, stat: 4.5, counter: 4.5, chart: 6, gallery: 5.5, issues: 6, quote: 6, cta: 5, end: 3.5 };
const TRANSITIONS = ['circleopen', 'slideleft', 'smoothup', 'zoomin', 'radial', 'slideup', 'circlecrop', 'smoothleft'];
const XF = 0.4;

// ------------------------------------------------------------------ rendering

/**
 * Render one orientation. scenes: storyboard scenes. info: { name, photo, party, theme, tag }.
 * Returns { file, duration }.
 */
async function renderVideo({ scenes, info, vertical, out, work, music, narration, onProgress = () => {} }) {
  const T = themeFor(info.party, info.theme);
  const camp = info.style === 'campaign' ? campaign.setup({ esc, fileUrl, compact }) : null;
  const P = camp ? campaign.paletteFor({ tone: info.tone, party: info.party, brand: info.brand }) : null;
  if (camp) {
    info = { citeText: () => '', ...info };
    const disclaimer = info.disclaimer || 'Concept ad by Euclidean Media. Not paid for or authorized by any candidate or committee.';
    if (!scenes.some((x) => x.type === 'disclaimer')) scenes = [...scenes, { type: 'disclaimer', text: disclaimer, sec: 2.5 }];
  }
  const baseCss = camp ? css(T) + camp.css(P) : css(T);
  fs.mkdirSync(work, { recursive: true });
  const clips = [];
  for (let i = 0; i < scenes.length; i++) {
    const s = scenes[i];
    const dur = Math.max(2.5, Math.min(20, Number(s.sec) || DEFAULT_SEC[s.type] || 4.5));
    const { W, H, els } = camp ? camp.layout(s, P, vertical, info) : layout(s, T, vertical, info);
    els.unshift(camp ? { x: 0, y: 0, w: W, h: H, html: camp.deco(P, W, H), anim: 'sweep', at: 0 } : { x: 0, y: 0, w: W, h: H, html: decoLayer(T, W, H, i), anim: 'drift', at: 0 });
    // Sprite: background on top, then each element stacked below it.
    let off = H; const placed = els.map((e) => { const p = { ...e, off }; off += e.h; return p; });
    const PAD = 240; // the window's viewport is a little shorter than the window itself
    const page = `<!doctype html><html><head><meta charset="utf-8"><style>${baseCss}</style></head><body style="width:${W}px;height:${off + PAD}px">
<div class="slot" style="top:0;width:${W}px;height:${H}px;display:block">${camp ? camp.background(P, W, H, s, info) : background(T, W, H, i)}</div>
${placed.map((e) => `<div class="slot" style="top:${e.off}px;width:${e.w}px;height:${e.h}px;${e.anim === 'drift' || e.anim === 'sweep' ? 'display:block' : ''}">${e.html}</div>`).join('\n')}
${FIT}</body></html>`;
    const htmlFile = path.join(work, `s${i}.html`); fs.writeFileSync(htmlFile, page);
    const sprite = path.join(work, `s${i}.png`);
    await screenshot(htmlFile, sprite, W, off + PAD, work);
    onProgress((i + 0.5) / (scenes.length + 1), `Drawing scene ${i + 1} of ${scenes.length}`);

    // FFmpeg: cut the sprite apart and animate each piece.
    const n = placed.length; const f = [];
    f.push(`[0:v]split=${n + 1}${Array.from({ length: n + 1 }, (_, k) => `[p${k}]`).join('')}`);
    f.push(`[p0]crop=${W}:${H}:0:0,scale=w='trunc(${W}*(1+0.06*t/${dur})/2)*2':h=-2:eval=frame,crop=${W}:${H},setsar=1[bg]`);
    let last = 'bg';
    placed.forEach((e, k) => {
      const at = e.at; const L = `e${k}`;
      let chain = `[p${k + 1}]crop=${e.w}:${e.h}:0:${e.off},format=rgba`;
      let x = `${e.x}`; let y = `${e.y}`;
      const P = `clip((t-${at})/0.5,0,1)`; // 0..1 entrance progress
      const back = `(1+2.70158*pow(${P}-1,3)+1.70158*pow(${P}-1,2))`; // easeOutBack
      const bob = `${(4 + (k % 3) * 2)}*sin(2*PI*0.55*(t-${at})+${k})*gte(t,${at + 0.5})`;
      if (e.anim === 'pop') {
        chain += `,fade=t=in:st=${at}:d=0.18:alpha=1,scale=w='max(2,trunc(${e.w}*max(0.05,${back})/2)*2)':h='max(2,trunc(${e.h}*max(0.05,${back})/2)*2)':eval=frame`;
        x = `${e.x}+(${e.w}-overlay_w)/2`; y = `${e.y}+(${e.h}-overlay_h)/2+${bob}`;
      } else if (e.anim === 'slide') {
        chain += `,fade=t=in:st=${at}:d=0.3:alpha=1`;
        y = `${e.y}+140*pow(1-${P},3)+${bob}`;
      } else if (e.anim === 'grow') {
        // Bars: grow up from their base with a little overshoot.
        chain += `,scale=w=${e.w}:h='max(2,trunc(${e.h}*max(0.01,${back})/2)*2)':eval=frame`;
        y = `${e.y}+${e.h}-overlay_h`;
      } else if (e.anim === 'slideX') {
        chain += `,fade=t=in:st=${at}:d=0.25:alpha=1`;
        x = `${e.x}-180*pow(1-${P},3)`;
      } else if (e.anim === 'sweep') {
        x = `-${W}+${2 * W}*t/${dur}`;
      } else if (e.anim === 'step') {
        // Shown only inside its time window (count-up frames).
      } else if (e.anim === 'drift') {
        chain += `,fade=t=in:st=0:d=0.5:alpha=1`;
        x = `10*sin(2*PI*t/${dur})`; y = `-30*t/${dur}`;
      } else {
        chain += `,fade=t=in:st=${at}:d=0.45:alpha=1`;
      }
      f.push(`${chain}[${L}s]`);
      const enable = e.anim === 'step' ? `:enable='between(t,${at},${e.until})'` : e.anim === 'grow' ? `:enable='gte(t,${at})'` : '';
      f.push(`[${last}][${L}s]overlay=x='${x}':y='${y}':eval=frame:shortest=1${enable}[${L}]`);
      last = L;
    });
    f.push(`[${last}]fps=${FPS},format=yuv420p[v]`);
    const clip = path.join(work, `c${i}.mp4`);
    await ff.ffmpegWithProgress(['-loop', '1', '-framerate', String(FPS), '-t', String(dur), '-i', sprite, '-filter_complex', f.join(';'), '-map', '[v]', '-t', String(dur),
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16', '-pix_fmt', 'yuv420p', clip], { totalSec: dur });
    clips.push({ file: clip, dur });
    onProgress((i + 1) / (scenes.length + 1), `Animated scene ${i + 1} of ${scenes.length}`);
  }

  // Tag + transitions + audio in one pass.
  const W = vertical ? 1080 : 1920; const H = vertical ? 1920 : 1080;
  const tagFile = path.join(work, 'tag.png');
  const tagHtml = path.join(work, 'tag.html');
  fs.writeFileSync(tagHtml, `<!doctype html><html><head><meta charset="utf-8"><style>${css(T)}</style></head><body style="width:460px;height:300px"><div style="position:relative;width:460px;height:84px"><div class="pill" style="inset:8px;background:${camp ? 'rgba(0,0,0,.45)' : 'rgba(255,255,255,.9)'};box-shadow:none;padding:0 26px"><div class="fit" style="font-size:24px;font-weight:600;color:${camp ? '#fff' : T.ink}"><span>${esc(info.tag || 'Concept by Euclidean Media')}</span></div></div></div>${FIT}</body></html>`);
  await screenshot(tagHtml, tagFile, 460, 300, work);

  const inputs = []; const f = [];
  clips.forEach((c) => inputs.push('-i', c.file));
  let cur = '[0:v]'; let offset = clips[0].dur;
  for (let i = 1; i < clips.length; i++) {
    const t = camp ? ['fade', 'wipeleft', 'fadeblack', 'slideleft', 'smoothleft', 'fade'][(i - 1) % 6] : TRANSITIONS[(i - 1) % TRANSITIONS.length];
    f.push(`${cur}[${i}:v]xfade=transition=${t}:duration=${XF}:offset=${(offset - XF).toFixed(3)}[x${i}]`);
    cur = `[x${i}]`; offset += clips[i].dur - XF;
  }
  const total = offset;
  const ti = clips.length; inputs.push('-i', tagFile);
  f.push(`[${ti}:v]crop=460:84:0:0[tg];${cur}[tg]overlay=x=${W - 460 - 24}:y=${H - 84 - (vertical ? 60 : 24)}[vt]`);
  // Audio: narration and/or music bed, else silence so every player accepts the file.
  const ai = ti + 1; const audio = [];
  if (narration && fs.existsSync(narration)) { inputs.push('-i', narration); audio.push(`[${ai}:a]aresample=48000,apad[na]`); }
  if (music && fs.existsSync(music)) { inputs.push('-stream_loop', '-1', '-i', music); const mi = ai + (audio.length ? 1 : 0); audio.push(`[${mi}:a]aresample=48000,volume=${audio.length ? 0.18 : 0.6},afade=t=out:st=${Math.max(0, total - 1.5)}:d=1.5[ma]`); }
  if (!audio.length) { inputs.push('-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo'); f.push(`[${ai}:a]anull[a]`); }
  else if (audio.length === 1) { f.push(audio[0].replace(/\[(na|ma)\]$/, '[a]')); }
  else { f.push(audio[0], audio[1], '[na][ma]amix=inputs=2:duration=longest:normalize=0[a]'); }
  await ff.ffmpegWithProgress([...inputs, '-filter_complex', f.join(';'), '-map', '[vt]', '-map', '[a]', '-t', total.toFixed(3),
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '21', '-maxrate', '8M', '-bufsize', '16M', '-pix_fmt', 'yuv420p', '-r', String(FPS),
    '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', out], { totalSec: total, onProgress: (p) => onProgress(0.9 + p * 0.1, 'Joining scenes') });
  return { file: out, duration: total };
}

module.exports = { compact, themeFromColor, findBrowser, screenshot, printPdf, renderVideo, themeFor, THEMES, esc, css, fileUrl, FIT, initials };
