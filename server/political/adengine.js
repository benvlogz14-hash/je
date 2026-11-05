'use strict';
/**
 * Pro ads: motion-graphics political ads made from the candidate's own footage, drawn with Remotion
 * (React components → frames → MP4; the components are in /remotion).
 *
 *   footage + transcript + picked lines ─┐
 *   research (office, district, place) ──┼─▶ plan (AI, or the built-in planner) ─▶ spec ─▶ Remotion ─▶ music mix ─▶ MP4
 *   notes ("make the map longer") ───────┘
 *
 * The plan is a list of sections on the voice's timeline: each line the candidate says gets a colour section, a headline
 * taken word for word from what they say (key words boxed, built up as they say it), the footage in a tilted card, word
 * captions with the spoken word boxed, and on some lines B-roll or a district map in the card while the voice carries on.
 * The headline never puts words in their mouth: it must be words they actually say in that line.
 *
 * Ideas from open-source video skills (all MIT: remotion-motion-graphics-skill, claude-video-effects, claude-video-vision)
 * and from the reference ad; every line here is written for Euclidean. OpenMontage (AGPL) was read for ideas only.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const ctx = require('../core/ctx');
const paths = require('../core/paths');
const ai = require('../integrations/ai');
const ff = require('../video/ffmpeg');
const looks = require('./looks');

const FPS = 30;
const ROOT = path.join(__dirname, '..', '..');
const SRC = path.join(ROOT, 'remotion');
const FONTS = path.join(__dirname, '..', 'video', 'fonts');
const STOP = new Set('a an and are as at be but by for from had has have he her his i if in into is it its me my of on or our so that the their them they this to us was we were what when where which who will with you your just not do does did can all very really'.split(' '));
const norm = (w) => String(w).toLowerCase().replace(/[^a-z0-9']/g, '');

function available() {
  try { require.resolve('@remotion/renderer'); require.resolve('@remotion/bundler'); require.resolve('remotion'); return true; } catch { return false; }
}

// ------------------------------------------------------------------ local file server (footage and fonts for the renderer)

function serve(roots) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      try {
        const u = new URL(req.url, 'http://x'); const [, key, ...rest] = u.pathname.split('/');
        const base = roots[key]; if (!base) { res.writeHead(404); res.end(); return; }
        const file = path.join(base, ...rest.map(decodeURIComponent));
        if (!paths.inside(base, file) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
        const size = fs.statSync(file).size;
        const type = /\.mp4$/i.test(file) ? 'video/mp4' : /\.m4a$/i.test(file) ? 'audio/mp4' : /\.wav$/i.test(file) ? 'audio/wav' : /\.ttf$/i.test(file) ? 'font/ttf' : /\.png$/i.test(file) ? 'image/png' : /\.jpe?g$/i.test(file) ? 'image/jpeg' : 'application/octet-stream';
        const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
        const head = { 'content-type': type, 'accept-ranges': 'bytes', 'access-control-allow-origin': '*' };
        if (m) {
          const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2])); const end = m[1] && m[2] ? Math.min(size - 1, Number(m[2])) : size - 1;
          res.writeHead(206, { ...head, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': end - start + 1 });
          fs.createReadStream(file, { start, end }).pipe(res);
        } else { res.writeHead(200, { ...head, 'content-length': size }); fs.createReadStream(file).pipe(res); }
      } catch { try { res.writeHead(500); res.end(); } catch { /* closed */ } }
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

// ------------------------------------------------------------------ bundle (once per version of /remotion) and browser

function srcHash() {
  const h = crypto.createHash('sha1'); h.update(require('remotion/package.json').version);
  for (const f of fs.readdirSync(SRC).sort()) if (/\.(jsx?|tsx?)$/.test(f)) h.update(f).update(fs.readFileSync(path.join(SRC, f)));
  return h.digest('hex').slice(0, 12);
}

let bundling = null;
async function bundled(onStep = () => {}) {
  const dir = path.join(paths.root, 'remotion', `bundle-${srcHash()}`);
  if (fs.existsSync(path.join(dir, 'index.html'))) return dir;
  if (bundling) return bundling;
  bundling = (async () => {
    onStep('Preparing the ad designer (first time only)');
    const { bundle } = require('@remotion/bundler');
    const tmp = `${dir}.tmp`; fs.rmSync(tmp, { recursive: true, force: true });
    await bundle({ entryPoint: path.join(SRC, 'index.jsx'), outDir: tmp, enableCaching: false });
    fs.rmSync(dir, { recursive: true, force: true }); fs.renameSync(tmp, dir);
    // Older bundles are no longer used.
    for (const f of fs.readdirSync(path.dirname(dir))) if (f.startsWith('bundle-') && path.join(path.dirname(dir), f) !== dir) fs.rmSync(path.join(path.dirname(dir), f), { recursive: true, force: true });
    return dir;
  })().finally(() => { bundling = null; });
  return bundling;
}

/** Remotion's own headless Chrome, kept in the app's node_modules/.remotion (Remotion finds it from the working folder,
 *  so we stand in the app folder while it checks or downloads, then hand it the exact path). */
let browserPath = null;
async function browser(onStep = () => {}) {
  if (browserPath && fs.existsSync(browserPath)) return browserPath;
  const { ensureBrowser } = require('@remotion/renderer');
  const here = process.cwd(); let said = false;
  try {
    process.chdir(ROOT);
    await ensureBrowser({ logLevel: 'error', onBrowserDownload: () => { if (!said) { said = true; onStep('Downloading the video renderer (one time, about 100 MB)'); } return { version: null, onProgress: () => {} }; } });
    const info = require('@remotion/renderer/dist/browser/BrowserFetcher').getRevisionInfo();
    browserPath = info.local && fs.existsSync(info.executablePath) ? info.executablePath : null;
  } finally { process.chdir(here); }
  return browserPath;
}

// ------------------------------------------------------------------ maps (state outline, district from the Census Bureau)

const STATES = { AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming', DC: 'District of Columbia' };

/** State name from a two-letter code or any text that names one. */
function stateName(...texts) {
  for (const t of texts) {
    const s = String(t || '').trim(); if (!s) continue;
    if (STATES[s.toUpperCase()]) return STATES[s.toUpperCase()];
    const byName = Object.values(STATES).sort((a, b) => b.length - a.length).find((n) => new RegExp(`\\b${n}\\b`, 'i').test(s));
    if (byName) return byName;
    const code = (s.match(/\b([A-Z]{2})\b/g) || []).find((c) => STATES[c] && c !== 'US');
    if (code) return STATES[code];
  }
  return null;
}

/** Which district an office is: { chamber: 'lower' | 'upper' | 'congress', number }. */
function districtOf(office) {
  const o = String(office || '');
  const num = (o.match(/\b(?:district|AD|SD|HD|CD|LD)\s*[-#:]?\s*(\d{1,3})\b/i) || o.match(/\b(?!AD|SD|HD|LD)(?:[A-Z]{2})-(\d{1,2})\b/) || o.match(/\b(\d{1,3})(?:st|nd|rd|th)\s+(?:assembly\s+|senate\s+|house\s+|congressional\s+|legislative\s+)?district\b/i) || [])[1];
  if (!num) return null;
  const chamber = /congress|u\.?\s?s\.?\s+(house|representative)|\bCD\b/i.test(o) || /\b(?!AD|SD|HD|LD)[A-Z]{2}-\d{1,2}\b/.test(o) ? 'congress' : /senat|\bSD\b/i.test(o) && !/u\.?\s?s\.?\s+senat/i.test(o) ? 'upper' : /assembl|house|delegate|representative|\bAD\b|\bHD\b|\bLD\b/i.test(o) ? 'lower' : null;
  return chamber ? { chamber, number: String(Number(num)) } : null;
}

function project(lat0, lon0) {
  const k = Math.cos((lat0 * Math.PI) / 180);
  return ([lon, lat]) => [(lon - lon0) * k * 100, -(lat - lat0) * 100];
}
function pathOf(geom, P) {
  const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.type === 'MultiPolygon' ? geom.coordinates : [];
  let d = ''; let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const poly of polys) for (const ring of poly) {
    ring.forEach((pt, i) => { const [x, y] = P(pt); x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); d += `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`; });
    d += 'Z';
  }
  return { d, box: [x0, y0, x1 - x0, y1 - y0] };
}

async function districtGeo(stateFips, dist) {
  const cacheDir = path.join(paths.root, 'political', 'maps'); fs.mkdirSync(cacheDir, { recursive: true });
  const cache = path.join(cacheDir, `${stateFips}-${dist.chamber}-${dist.number}.json`);
  try { return JSON.parse(fs.readFileSync(cache, 'utf8')); } catch { /* not yet */ }
  const svc = 'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Legislative/MapServer';
  const meta = await (await fetch(`${svc}?f=json`, { signal: AbortSignal.timeout(15000) })).json();
  const want = dist.chamber === 'congress' ? /congressional districts/i : dist.chamber === 'upper' ? /legislative districts.*upper/i : /legislative districts.*lower/i;
  const layers = (meta.layers || []).filter((l) => want.test(l.name) && !/label/i.test(l.name)).sort((a, b) => String(b.name).localeCompare(String(a.name)));
  const n = dist.number; const where = `STATE='${stateFips}' AND BASENAME IN ('${n}','${n.padStart(2, '0')}','${n.padStart(3, '0')}')`;
  for (const l of layers) {
    try {
      const url = `${svc}/${l.id}/query?where=${encodeURIComponent(where)}&outFields=BASENAME,NAME&returnGeometry=true&outSR=4326&geometryPrecision=4&f=geojson`;
      const j = await (await fetch(url, { signal: AbortSignal.timeout(20000) })).json();
      const f = (j.features || [])[0];
      if (f?.geometry) { const out = { geometry: f.geometry, name: f.properties?.NAME || '' }; fs.writeFileSync(cache, JSON.stringify(out)); return out; }
    } catch { /* next layer */ }
  }
  return null;
}

/** The map card: the state outline and, when the Census Bureau has it, their district. */
async function mapFor({ state, office }) {
  const name = stateName(state, office); if (!name) return null;
  const topo = require('us-atlas/states-10m.json'); const { feature } = require('topojson-client');
  const f = feature(topo, topo.objects.states).features.find((x) => x.properties.name === name); if (!f) return null;
  // Centre the projection on the state (Alaska's islands across the date line are folded back).
  const fix = (g) => JSON.parse(JSON.stringify(g), (k, v) => (Array.isArray(v) && typeof v[0] === 'number' && v[0] > 0 && name === 'Alaska' ? [v[0] - 360, v[1]] : v));
  const geom = fix(f.geometry);
  const all = []; JSON.stringify(geom, (k, v) => { if (Array.isArray(v) && typeof v[0] === 'number') all.push(v); return v; });
  const lat0 = all.reduce((a, p) => a + p[1], 0) / all.length; const lon0 = all.reduce((a, p) => a + p[0], 0) / all.length;
  const P = project(lat0, lon0);
  const out = { state: pathOf(geom, P), stateName: name };
  const dist = districtOf(office);
  if (dist) {
    out.number = dist.number; out.chamber = dist.chamber;
    try { const g = await districtGeo(f.id, dist); if (g) out.district = pathOf(g.geometry, P); } catch { /* offline: the state outline only */ }
  }
  return out;
}

// ------------------------------------------------------------------ the plan

/** A headline taken word for word from a line: the whole sentence when it's short, else the strongest clause (4-8 words)
 *  that starts and ends on a clause break, so it reads as a whole thought ("Civil rights are being attacked,"). */
function autoHeadline(words, whole = 9) {
  const ws = words.map((x) => x.w);
  if (ws.length <= whole) return { from: 0, to: ws.length };
  const brk = (i) => i < 0 || /[.!?,;:]["”']?$/.test(ws[i]);
  let best = null;
  for (let len = 3; len <= 10; len++) for (let i = 0; i + len <= ws.length; i++) {
    const part = ws.slice(i, i + len); const content = part.filter((w) => !STOP.has(norm(w)) && norm(w).length > 2);
    let score = content.length * 2 + content.reduce((a, w) => a + Math.min(norm(w).length, 9) / 9, 0) - Math.max(0, len - 8) * 1.5;
    const endsClause = brk(i + len - 1) || i + len === ws.length; const startsClause = brk(i - 1);
    score += (endsClause ? 6 : 0) + (startsClause ? 6 : 0);
    if (STOP.has(norm(part[len - 1])) || /^(do|be|to|the|a|of)$/i.test(norm(part[len - 1]))) score -= 6;
    score -= Math.abs(len - 6) * 0.3;
    if (!best || score > best.score) best = { from: i, to: i + len, score };
  }
  return best;
}
function keyWordOf(words) {
  let best = null;
  for (let i = 0; i < words.length; i++) {
    const n = norm(words[i]); if (STOP.has(n) || (n.length < 4 && !/\d/.test(n))) continue;
    const score = n.length + (/\d/.test(n) ? 6 : 0) + (i === words.length - 1 ? 2 : 0);
    if (!best || score > best.score) best = { i, score };
  }
  return best ? best.i : -1;
}
/** Where a run of words appears in a line (case and punctuation ignored); -1 when it isn't said there. */
function findRun(lineWords, run) {
  const a = lineWords.map((x) => norm(x.w)); const b = run.map(norm).filter(Boolean);
  if (!b.length) return -1;
  for (let i = 0; i + b.length <= a.length; i++) if (b.every((w, k) => a[i + k] === w)) return i;
  return -1;
}

const BG_CYCLE = ['navy', 'yellow', 'navy', 'red', 'navy', 'yellow'];

/** The built-in planner (no AI needed); the AI's choices are laid over it when one is connected. */
function basePlan(bites, { broll, map, place = '', look = null }) {
  const whole = look && (look.layout === 'full' || look.head?.pos === 'bottom') ? 7 : 11; // tighter headline areas get shorter lines
  let brollUsed = 0;
  // The map goes on the line about the district or community (else the second line).
  const placeWords = String(place).toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 3);
  const local = (b) => /\b(district|community|neighbo|town|city|county|borough|state|street|home|here)/i.test(b.text) || placeWords.some((w) => b.text.toLowerCase().includes(w)) || (map?.number && new RegExp(`\\b${map.number}`).test(b.text));
  const mapAt = !map ? -1 : (bites.findIndex((b, k) => k >= 1 && b.e - b.s >= 3.4 && local(b)) + 1 || bites.findIndex((b, k) => k >= 1 && b.e - b.s >= 3.4) + 1) - 1;
  return bites.map((b, k) => {
    const dur = b.e - b.s; const h = autoHeadline(b.words, whole);
    const head = b.words.slice(h.from, h.to).map((x) => x.w);
    const key = keyWordOf(head);
    const p = { bite: k, headline: head.join(' '), keys: key >= 0 ? [head[key]] : [], bg: BG_CYCLE[k % BG_CYCLE.length] };
    if (k === mapAt) p.map = { at: Math.min(1.2, dur * 0.3), dur: Math.min(3.0, dur * 0.6) };
    else if (k >= 1 && dur >= 4.2 && brollUsed < broll.length) { p.cover = { broll: brollUsed++, at: dur * 0.42, dur: Math.min(2.8, dur * 0.36) }; }
    return p;
  });
}

async function aiPlan(bites, { name, office, place, broll, map, notes, prev, look }) {
  if (!ai.anyConnected()) return null;
  const lines = bites.map((b, k) => `#${k} (${(b.e - b.s).toFixed(1)}s): ${b.text}`).join('\n');
  const shots = broll.map((x, i) => `B${i}: ${x.what || 'footage with nobody talking'} (${(x.e - x.s).toFixed(1)}s)`).join('\n') || 'none';
  const r = await ai.ask({
    role: 'writing', json: true, maxTokens: 2500,
    system: `You are the motion designer for a professional political ad cut from a candidate's own speeches (flat navy / yellow / red colour sections, a bold condensed caps headline above a tilted footage card, word captions in the card). For each line the candidate says, choose:
- headline: 3 to 10 words copied EXACTLY, in order, from that line (it builds up on screen as they say it). Never reword, never add words. Pick the most powerful stretch.
- keys: 1 or 2 words of that headline to put in a coloured box (the word that hits hardest; a number if there is one).
- bg: "navy", "yellow" or "red" (change colour when the topic or energy changes; start on navy; don't use the same colour 3 times in a row).
- cover (optional): show a B-roll shot in the card for part of the line while the voice carries on: {"broll": <B number>, "at": seconds into the line (at least 1.2), "dur": 1.5 to 3 seconds}. Only use shots that fit what is being said. Never cover the first line.
- map (optional, at most once, only when a district map exists, on a line about the district, their community or the people they serve): {"at": seconds, "dur": 2 to 3.2}.
Design rules: fewer, bigger things on screen; motion shows meaning; every claim on screen must be the candidate's own words. Return JSON {"lines":[{"bite":0,"headline":"...","keys":["..."],"bg":"navy","cover":null,"map":null}, ...]}.`,
    prompt: `Candidate: ${name}${office ? `, ${office}` : ''}${place ? ` (${place})` : ''}
The look of this ad: ${look ? `${look.name}${look.about ? ` (${look.about})` : ''}${look.layout === 'full' || look.head?.pos === 'bottom' ? '; keep headlines to 3-6 words' : ''}` : 'Bold blocks'}
District map available: ${map ? `yes (${map.number ? `district ${map.number}, ` : ''}${map.stateName})` : 'no'}

Lines in order:
${lines}

B-roll shots:
${shots}
${prev ? `\nThe previous version's plan (keep what works, change what the note asks):\n${JSON.stringify(prev)}` : ''}${notes ? `\nThe founders' notes for this version: ${notes}` : ''}`,
  });
  return { lines: r.json?.lines || [], agent: `${r.provider}:${r.model}` };
}

/** Lay the AI's choices over the built-in plan, keeping only what passes the checks. */
function mergePlan(base, j, bites, { broll, map }) {
  if (!j?.lines?.length) return base;
  let mapUsed = false;
  return base.map((p, k) => {
    const a = j.lines.find((x) => Number(x.bite) === k); if (!a) return p;
    const out = { ...p }; const dur = bites[k].e - bites[k].s;
    const words = String(a.headline || '').replace(/[—–]/g, ' ').split(/\s+/).filter(Boolean);
    if (words.length >= 2 && words.length <= 12 && findRun(bites[k].words, words) >= 0) {
      out.headline = words.join(' ');
      const keys = [].concat(a.keys || []).map(String).filter((x) => words.some((w) => norm(w) === norm(x)));
      out.keys = keys.length ? keys.slice(0, 2) : (keyWordOf(words) >= 0 ? [words[keyWordOf(words)]] : []);
    }
    if (['navy', 'yellow', 'red'].includes(a.bg)) out.bg = a.bg;
    delete out.cover; delete out.map;
    if (a.map && map && !mapUsed && dur >= 3) { const at = Math.max(0.8, Math.min(dur - 2, Number(a.map.at) || 1)); out.map = { at, dur: Math.max(1.8, Math.min(3.2, dur - at, Number(a.map.dur) || 2.6)) }; mapUsed = true; }
    else if (a.cover && k > 0 && broll[Number(a.cover.broll)] && dur >= 3) { const at = Math.max(1.2, Math.min(dur - 1.5, Number(a.cover.at) || dur * 0.4)); out.cover = { broll: Number(a.cover.broll), at, dur: Math.max(1.2, Math.min(3, dur - at, Number(a.cover.dur) || 2.4)) }; }
    return out;
  }).map((p, k, arr) => (k === 0 ? { ...p, bg: p.bg || 'navy', cover: undefined } : p));
}

// ------------------------------------------------------------------ media for the renderer

const even = (n) => Math.round(n / 2) * 2;
async function cutBite(c, start, dur, out) {
  const scale = c.width >= c.height ? `scale=${even(Math.min(1280, c.width))}:-2` : `scale=-2:${even(Math.min(1280, c.height))}`;
  await ff.ffmpegWithProgress(['-ss', start.toFixed(3), '-t', dur.toFixed(3), '-i', c.file, '-vf', `${scale},fps=${FPS},eq=contrast=1.04:saturation=1.08`,
    '-af', `aresample=48000,aformat=channel_layouts=stereo,highpass=f=80,afade=t=in:d=0.04,afade=t=out:st=${Math.max(0, dur - 0.12).toFixed(2)}:d=0.12,loudnorm=I=-15:TP=-1.5:LRA=9,aresample=48000`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '17', '-pix_fmt', 'yuv420p', '-g', '15', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', out], { totalSec: dur });
}
async function cutBroll(c, start, dur, out) {
  const scale = c.width >= c.height ? `scale=${even(Math.min(1280, c.width))}:-2` : `scale=-2:${even(Math.min(1280, c.height))}`;
  await ff.ffmpegWithProgress(['-ss', start.toFixed(3), '-t', dur.toFixed(3), '-i', c.file, '-an', '-vf', `${scale},fps=${FPS},eq=contrast=1.04:saturation=1.08`, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-g', '15', '-movflags', '+faststart', out], { totalSec: dur });
}
async function faceX(c, start, end) {
  try {
    const ft = require('../video/facetrack');
    if (!(await ft.available())) return null;
    const tr = await ft.track(c.file, { width: c.width, height: c.height }, start, end, { fps: 2 });
    const xs = tr.path.map((x) => x.x).sort((a, b) => a - b);
    return xs.length ? Math.max(0.15, Math.min(0.85, xs[xs.length >> 1] / c.width)) : null;
  } catch { return null; }
}

// ------------------------------------------------------------------ build the spec from the plan

function buildSpec({ plan, bites, cuts, brollFiles, map, vertical, name, office, place, cta, site, tag, look }) {
  look = look || looks.preset('bold');
  const W = vertical ? 1080 : 1920; const H = vertical ? 1920 : 1080;
  const segs = []; const words = []; const voice = [];
  const tilts = [-1.6, 1.3, -1.1, 1.5, -1.4, 1.0];
  let t = 0;
  plan.forEach((p, k) => {
    const cut = cuts[k]; const b = bites[k];
    voice.push({ src: cut.url, at: t, dur: cut.dur });
    const lineWords = b.words.map((w) => ({ w: w.w, s: t + (w.s - cut.start), e: t + (w.e - cut.start), b: k })).filter((w) => w.e > t && w.s < t + cut.dur);
    words.push(...lineWords);
    // Headline: the words at the times they're said.
    const hw = String(p.headline || '').split(/\s+/).filter(Boolean);
    const at = findRun(b.words, hw);
    const keyset = new Set((p.keys || []).map(norm));
    const head = { words: hw.map((w, i) => ({ w, key: keyset.has(norm(w)), t: at >= 0 ? Math.max(t, t + (b.words[at + i].s - cut.start) - 0.05) : t + 0.08 + i * 0.07 })) };
    const speaker = (from, to) => ({ kind: 'video', src: cut.url, from: from - t, fx: cut.fx ?? 0.5, fy: 0.3, pushAt: t, pushLen: cut.dur });
    const base = { bg: p.bg || 'navy', head, tilt: tilts[k % tilts.length], label: b.label || null };
    const parts = [];
    const ins = p.map ? { kind: 'map', ...p.map } : p.cover && brollFiles[p.cover.broll] ? { kind: 'broll', ...p.cover } : null;
    if (ins && ins.at < cut.dur - 0.6) {
      const a = t + ins.at; let e = Math.min(t + cut.dur, a + ins.dur); if (t + cut.dur - e < 0.7) e = t + cut.dur;
      parts.push({ ...base, at: t, dur: a - t, card: speaker(t) });
      if (ins.kind === 'map') {
        const label = map.number ? `District ${map.number}` : map.stateName;
        const hw2 = (map.number ? ['District', map.number] : map.stateName.split(' '));
        parts.push({ ...base, at: a, dur: e - a, bg: base.bg === 'red' ? 'navy' : 'red', tilt: -base.tilt, card: { kind: 'map', state: map.state, district: map.district || null, label, sub: place || '' }, head: { words: hw2.map((w, i) => ({ w, key: /\d/.test(w) || (!map.number && i === hw2.length - 1), t: a + 0.05 + i * 0.12 })) } });
      } else {
        const bf = brollFiles[ins.broll];
        parts.push({ ...base, at: a, dur: e - a, card: { kind: 'video', src: bf.url, from: 0, fx: 0.5, fy: 0.45 }, pill: place || null });
      }
      if (e < t + cut.dur - 0.01) parts.push({ ...base, at: e, dur: t + cut.dur - e, card: speaker(e) });
    } else parts.push({ ...base, at: t, dur: cut.dur, card: speaker(t) });
    if (k === 0) { parts[0].enter = true; parts.forEach((x) => { if (x.card.kind === 'video' && x.card.src === cut.url) x.plate = true; }); }
    if (k >= 2 && k % 2 === 0) parts.forEach((x) => { if (x.card.kind === 'video' && x.card.src === cut.url) x.badge = true; });
    segs.push(...parts.filter((x) => x.dur > 0.02));
    t += cut.dur;
  });
  const endDur = 3.0;
  const end = { at: t, dur: endDur, bg: 'navy', cta, name, sub: office || '', site: site || '', tag: tag || '' };
  return {
    w: W, h: H, fps: FPS, total: t + endDur, segs, words, voice, end, name, office: [office, place].filter(Boolean).join(', ').slice(0, 70),
    bug: map ? (map.number ? `${map.stateName} · District ${map.number}` : map.stateName) : String(office || '').slice(0, 30),
    look, fonts: looks.fontFiles(look), ticker: [name, office, place, site].filter(Boolean).join('  •  '),
  };
}

/** Point the spec's file links at this run's local file server. */
function withBase(spec, base) {
  return JSON.parse(JSON.stringify(spec), (k, v) => (typeof v === 'string' && /^\/[mf]\//.test(v) && ['src', 'url'].includes(k) ? base + v : v));
}

// ------------------------------------------------------------------ make an ad

/**
 * Make one ad. bites = the picked lines ({clip, s, e, text, words}); footage = prospect.pkg.footage (clips, broll).
 * Returns { file, duration, spec, plan, agent }.
 */
async function make({ bites, footage, vertical, out, work, music, name, office, place, state, cta = 'Vote', site = '', tag = '', notes = '', prev = null, look = null, onProgress = () => {} }) {
  if (!available()) throw new Error('The pro ad designer is still installing. Restart Euclidean once to finish the update.');
  fs.mkdirSync(work, { recursive: true });
  const clips = footage.clips;
  onProgress(0.02, 'Planning the ad');
  const map = await mapFor({ state, office }).catch(() => null);
  // B-roll pieces: shots with nobody talking (best first), at most one per line.
  const broll = (footage.broll || []).filter((x) => clips[x.clip] && fs.existsSync(clips[x.clip].file) && x.e - x.s >= 1.6).slice(0, 8);
  const lookN = look ? looks.normalize(look, look) : looks.preset('bold');
  let plan = basePlan(bites, { broll, map, place, look: lookN }); let agent = 'built-in';
  try { const j = await aiPlan(bites, { name, office, place, broll, map, notes, prev, look: lookN }); if (j) { plan = mergePlan(plan, j, bites, { broll, map }); agent = j.agent; } } catch { /* the built-in plan */ }

  // Cut each line (with a hair of lead-in and tail) and each B-roll shot used.
  const cuts = [];
  for (let k = 0; k < bites.length; k++) {
    onProgress(0.05 + 0.2 * (k / bites.length), `Cutting line ${k + 1} of ${bites.length}`);
    const b = bites[k]; const c = clips[b.clip];
    const start = Math.max(0, b.s - 0.12); const dur = Math.min(c.duration - start, b.e - b.s + 0.38);
    const file = path.join(work, `line${k}.mp4`); await cutBite(c, start, dur, file);
    cuts.push({ start, dur, url: `/m/line${k}.mp4`, fx: c.width / c.height > 1.1 ? await faceX(c, start, start + dur) : 0.5 });
  }
  const brollFiles = {};
  for (const p of plan) if (p.cover && !brollFiles[p.cover.broll]) {
    const x = broll[p.cover.broll]; const c = clips[x.clip];
    const len = Math.min(x.e - x.s, p.cover.dur + 0.4); const s = x.s + Math.max(0, (x.e - x.s - len) / 2);
    const file = path.join(work, `broll${p.cover.broll}.mp4`); await cutBroll(c, s, len, file);
    brollFiles[p.cover.broll] = { url: `/m/broll${p.cover.broll}.mp4` };
  }
  const spec = buildSpec({ plan, bites, cuts, brollFiles, map, vertical, name, office, place, cta, site, tag, look: lookN });

  // Render with Remotion.
  const srv = await serve({ m: work, f: FONTS });
  const silent = path.join(work, 'ad_voice.mp4');
  try {
    const browserExecutable = await browser((x) => onProgress(0.27, x));
    const serveUrl = await bundled((x) => onProgress(0.28, x));
    const { selectComposition, renderMedia } = require('@remotion/renderer');
    const inputProps = { spec: withBase(spec, srv.base) };
    const composition = await selectComposition({ serveUrl, id: 'PoliticalAd', inputProps, logLevel: 'error', browserExecutable });
    const cores = require('os').cpus().length;
    await renderMedia({
      composition, serveUrl, browserExecutable, codec: 'h264', outputLocation: silent, inputProps, crf: 18, pixelFormat: 'yuv420p', audioCodec: 'aac', audioBitrate: '192k',
      concurrency: Math.max(1, Math.min(8, Math.floor(cores / 2))), logLevel: 'error', timeoutInMilliseconds: 120000,
      onProgress: ({ progress }) => onProgress(0.3 + 0.6 * progress, `Drawing the ad ${Math.round(progress * 100)}%`),
    });
  } finally { srv.server.close(); }

  // Music under the voice (ducked), faded out at the end.
  onProgress(0.92, 'Adding the music');
  await mixMusic(silent, music, out, spec.total);
  return { file: out, duration: spec.total, spec, plan, agent };
}

/** A still of a look (for the style picker): a sample headline, captions, a stat card and a name plate. Cached by look. */
let previewChain = Promise.resolve();
function previewStill(look, opts = {}) { const run = previewChain.then(() => previewOne(look, opts)); previewChain = run.catch(() => {}); return run; } // one at a time
async function previewOne(look, { vertical = true } = {}) {
  look = looks.normalize(look, look);
  const key = crypto.createHash('sha1').update(JSON.stringify(looks.strip(look)) + srcHash() + (vertical ? 'v' : 'h')).digest('hex').slice(0, 16);
  const dir = path.join(paths.root, 'remotion', 'previews'); fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `${key}.png`);
  if (fs.existsSync(out)) return out;
  const words = 'We are fighting for every family in this district'.split(' ');
  const seg = { at: 0, dur: 4, bg: 'navy', tilt: -1.4, enter: true, plate: true, badge: true, head: { words: ['Fighting', 'for', 'our', 'families'].map((w, i) => ({ w, key: w === 'families', t: 0.1 + i * 0.12 })) }, card: { kind: 'stat', value: '100', suffix: '%', label: 'for our families' } };
  const spec = { bug: 'Texas · District 12', w: vertical ? 1080 : 1920, h: vertical ? 1920 : 1080, fps: FPS, total: 4, segs: [seg], words: words.map((w, i) => ({ w, s: 1.6 + i * 0.12, e: 1.7 + i * 0.12, b: 0 })), voice: [], end: null, name: 'Jane Rivera', office: 'State Senate, District 12', look, fonts: looks.fontFiles(look), ticker: 'Jane Rivera  •  State Senate, District 12  •  janerivera.com' };
  const srv = await serve({ f: FONTS });
  try {
    const browserExecutable = await browser(); const serveUrl = await bundled();
    const { selectComposition, renderStill } = require('@remotion/renderer');
    const inputProps = { spec: withBase(spec, srv.base) };
    const composition = await selectComposition({ serveUrl, id: 'PoliticalAd', inputProps, logLevel: 'error', browserExecutable });
    await renderStill({ composition, serveUrl, browserExecutable, output: out, frame: Math.round(1.75 * FPS), inputProps, logLevel: 'error', scale: vertical ? 0.3 : 0.25 });
  } finally { srv.server.close(); }
  return out;
}

async function mixMusic(input, music, out, total) {
  const f = [];
  const inputs = ['-i', input];
  if (music && fs.existsSync(music)) {
    inputs.push('-stream_loop', '-1', '-i', music);
    f.push('[0:a]aresample=48000,aformat=channel_layouts=stereo,asplit=2[sv][sk]', `[1:a]aresample=48000,aformat=channel_layouts=stereo,volume=0.42,afade=t=out:st=${Math.max(0, total - 1.6).toFixed(2)}:d=1.6[mu]`,
      '[mu][sk]sidechaincompress=threshold=0.02:ratio=10:attack=10:release=450:makeup=1[md]', '[sv][md]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.95[a]');
  } else f.push('[0:a]anull[a]');
  await ff.ffmpegWithProgress([...inputs, '-filter_complex', f.join(';'), '-map', '0:v', '-map', '[a]', '-t', total.toFixed(3), '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', out], { totalSec: total });
}

module.exports = { available, make, previewStill, mapFor, districtOf, stateName, autoHeadline, basePlan, mergePlan, buildSpec, findRun, bundled };
