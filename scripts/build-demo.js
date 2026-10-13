'use strict';
/**
 * Builds the single-file interactive example: snapshots a running engine
 * (normally the sample workspace from seed-sample.js), embeds small copies of
 * the rendered shorts, bundles the real renderer with the in-browser demo
 * backend, and writes one self-contained HTML file.
 *   node scripts/build-demo.js <engineUrlWithToken> <out.html>
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const [urlArg, outArg] = process.argv.slice(2);
const u = new URL(urlArg); const token = u.searchParams.get('token'); const base = u.origin;
const ROOT = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eu-demo-'));
const get = async (p) => { const r = await fetch(base + p, { headers: { authorization: `Bearer ${token}` } }); if (!r.ok) throw new Error(`${p}: ${r.status}`); return r.json(); };
const dataUri = (file, mime) => `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`;

// Large media downloads use curl, which streams to disk reliably.
async function fetchFile(p, dest) { execFileSync('curl', ['-sSf', '-o', dest, base + p + (p.includes('?') ? '&' : '?') + 'token=' + token]); return dest; }

(async () => {
  const D = {};
  D.bootstrap = await get('/api/bootstrap');
  D.bootstrap.dataDir = 'C:\\Users\\you\\AppData\\Roaming\\Euclidean\\data';
  D.conversations = await get('/api/conversations');
  D.messages = {};
  for (const c of D.conversations) D.messages[c.id] = await get(`/api/conversations/${c.id}/messages`);
  D.clients = await get('/api/clients');
  D.clientDetail = {}; D.slots = {};
  for (const c of D.clients) { const d = await get(`/api/clients/${c.id}`); d.portalUrl = 'http://your-pc:4870/portal/(private link)'; D.clientDetail[c.id] = d; D.slots[c.id] = d.upcomingSlots || []; }
  D.clips = (await get('/api/clips')).filter((c) => c.status !== 'rejected');
  D.approvals = (await get('/api/approvals')).map(({ ref, ...a }) => a);
  D.assets = await get('/api/assets');
  D.jobs = await get('/api/jobs?limit=40');
  D.queueStats = await get('/api/queue/stats');
  D.posts = await get('/api/posts');
  D.prospects = await get('/api/prospects');
  D.finance = await get('/api/finance');
  D.invoices = await get('/api/invoices');
  D.analytics = await get('/api/analytics');
  D.agents = await get('/api/agents');
  D.health = await get('/api/health');
  const r = await get('/api/resources'); D.resources = r.current; D.history = r.history;
  D.logs = (await get('/api/logs?limit=80')).map((e) => ({ ...e, detail: { ...e.detail, file: undefined } }));
  D.users = await get('/api/users');
  D.backups = await get('/api/backups');
  D.projectSummaries = await get('/api/projects');
  D.projects = {};
  for (const p of D.projectSummaries) D.projects[p.id] = await get(`/api/projects/${p.id}`);

  // Embed small versions of the rendered shorts and the source footage.
  const MEDIA = {};
  const ff = (args) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
  let k = 0;
  for (const c of D.clips.filter((x) => x.current).slice(0, 8)) {
    const key = `m${k++}`; c.mediaKey = key;
    const full = await fetchFile(`/api/clips/${c.id}/video`, path.join(tmp, `${key}.mp4`));
    const small = path.join(tmp, `${key}-s.mp4`);
    ff(['-i', full, '-t', '22', '-vf', 'scale=270:480', '-c:v', 'libx264', '-preset', 'slow', '-b:v', '210k', '-maxrate', '260k', '-bufsize', '400k', '-c:a', 'aac', '-b:a', '40k', '-ac', '1', '-movflags', '+faststart', small]);
    MEDIA[`video:${key}`] = dataUri(small, 'video/mp4');
    const th = await fetchFile(`/api/clips/${c.id}/thumb`, path.join(tmp, `${key}.jpg`));
    const ths = path.join(tmp, `${key}-s.jpg`); ff(['-i', th, '-vf', 'scale=240:-2', '-q:v', '6', ths]);
    MEDIA[`thumb:${key}`] = dataUri(ths, 'image/jpeg');
  }
  const asset = D.assets[0];
  if (asset) {
    const at = await fetchFile(`/api/assets/${asset.id}/thumb`, path.join(tmp, 'asset.jpg'));
    MEDIA['asset-thumb'] = dataUri(at, 'image/jpeg');
    const src = await fetchFile(`/api/assets/${asset.id}/media`, path.join(tmp, 'source.mp4'));
    const srcS = path.join(tmp, 'source-s.mp4');
    ff(['-i', src, '-t', '40', '-vf', 'scale=480:270', '-c:v', 'libx264', '-preset', 'slow', '-b:v', '160k', '-c:a', 'aac', '-b:a', '40k', '-ac', '1', '-movflags', '+faststart', srcS]);
    MEDIA.source = dataUri(srcS, 'video/mp4');
  }

  // Bundle the real renderer with the demo backend.
  const esbuild = require('esbuild');
  const entry = path.join(tmp, 'entry.js');
  fs.writeFileSync(entry, `import { boot } from ${JSON.stringify(path.join(ROOT, 'renderer/js/main.js'))};\nimport { demoBackend } from ${JSON.stringify(path.join(ROOT, 'renderer/js/demo/demo-backend.js'))};\nboot(demoBackend);\n`);
  const out = await esbuild.build({ entryPoints: [entry], bundle: true, minify: true, format: 'iife', write: false, target: ['chrome110', 'safari16', 'firefox115'] });
  const js = out.outputFiles[0].text;

  let css = fs.readFileSync(path.join(ROOT, 'renderer/css/app.css'), 'utf8');
  const font = dataUri(path.join(ROOT, 'renderer/assets/fonts/Montserrat_800ExtraBold.ttf'), 'font/ttf');
  css = `@font-face { font-family: "Montserrat"; src: url(${font}) format("truetype"); font-weight: 400 900; font-display: swap; }\n` + css;
  const safe = (o) => JSON.stringify(o).replace(/</g, '\\u003c');
  const html = `<title>Euclidean</title>
<style>${css}</style>
<div id="app"></div>
<script>window.EUCLIDEAN_DEMO = true; window.EUCLIDEAN_DEMO_DATA = ${safe(D)}; window.EUCLIDEAN_DEMO_MEDIA = ${safe(MEDIA)};</script>
<script>${js.replace(/<\/script/gi, '<\\/script')}</script>
`;
  fs.writeFileSync(outArg, html);
  console.log(`wrote ${outArg} (${(html.length / 1048576).toFixed(2)} MB, ${Object.keys(MEDIA).length} media)`);
})().catch((e) => { console.error(e); process.exit(1); });
