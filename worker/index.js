'use strict';
/**
 * Euclidean render worker. Run on the editing desktop (or any spare PC) so
 * renders don't compete with the always-on coordinator:
 *   npm run worker -- --engine http://DESKTOP-1:4870 --token <worker token> [--name "Desktop 2"]
 * It leases render jobs, downloads the source once (cached), renders with the
 * same pipeline as the engine, uploads the result and goes back for more.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const paths = require('../server/core/paths');
const ctx = require('../server/core/ctx');

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const ENGINE = (arg('--engine') || process.env.EUCLIDEAN_ENGINE || '').replace(/\/$/, '');
const TOKEN = arg('--token') || process.env.EUCLIDEAN_TOKEN;
const NAME = arg('--name', os.hostname());
const DATA = arg('--data', path.join(os.homedir(), '.euclidean-worker'));
if (!ENGINE || !TOKEN) { console.error('Usage: npm run worker -- --engine http://HOST:4870 --token WORKER_TOKEN [--name NAME]'); process.exit(1); }

paths.setRoot(DATA);
const ff = require('../server/video/ffmpeg');
const render = require('../server/video/render');

const H = { authorization: `Bearer ${TOKEN}` };
const api = async (method, p, body) => {
  const r = await fetch(ENGINE + p, { method, headers: { ...H, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(60000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function download(url, dest, size, onProgress) {
  if (fs.existsSync(dest) && fs.statSync(dest).size === size) return dest;
  const r = await fetch(ENGINE + url, { headers: H });
  if (!r.ok) throw new Error(`Source download failed: HTTP ${r.status}`);
  const tmp = dest + '.part'; const out = fs.createWriteStream(tmp); let got = 0;
  for await (const chunk of r.body) { out.write(chunk); got += chunk.length; if (size) onProgress(got / size); }
  await new Promise((ok) => out.end(ok));
  fs.renameSync(tmp, dest);
  return dest;
}

async function runJob(workerId, job) {
  const s = job.spec;
  let progress = 0; let note = 'Starting';
  const beat = setInterval(() => api('POST', `/api/workers/jobs/${job.id}/heartbeat`, { worker: NAME, progress, note }).catch(() => {}), 15000);
  try {
    const cacheDir = paths.tmp('sources');
    const src = path.join(cacheDir, `${s.assetId}${path.extname(s.sourceName) || '.mp4'}`);
    note = 'Downloading source';
    await download(s.sourceUrl, src, s.sourceSize, (p) => { progress = p * 0.25; });
    const outDir = paths.tmp('renders', job.id);
    const outPath = path.join(outDir, 'render.mp4');
    note = 'Rendering';
    const r = await render.renderShort({ ...s, source: src, outPath, onProgress: (p) => { progress = 0.25 + p * 0.65; } });
    note = 'Uploading';
    const fd = new FormData();
    fd.append('worker', NAME); fd.append('encoder', r.encoder); fd.append('captioned', String(!!s.words?.length));
    fd.append('file', new Blob([fs.readFileSync(outPath)], { type: 'video/mp4' }), 'render.mp4');
    if (fs.existsSync(r.srtPath)) fd.append('file', new Blob([fs.readFileSync(r.srtPath)], { type: 'text/plain' }), 'captions.srt');
    const up = await fetch(`${ENGINE}/api/workers/jobs/${job.id}/result`, { method: 'POST', headers: H, body: fd });
    if (!up.ok) throw new Error(`Upload failed: ${(await up.json().catch(() => ({}))).error || up.status}`);
    fs.rmSync(outDir, { recursive: true, force: true });
    console.log(`[worker] finished ${s.title} via ${r.encoder}`);
  } catch (e) {
    console.error(`[worker] job ${job.id} failed: ${e.message}`);
    await api('POST', `/api/workers/jobs/${job.id}/fail`, { error: `${NAME}: ${e.message}` }).catch(() => {});
  } finally { clearInterval(beat); }
}

(async () => {
  Object.assign(ctx.capabilities, await ff.detect());
  if (!ctx.capabilities.ffmpeg) { console.error('[worker] FFmpeg not found on this machine. Install it (winget install Gyan.FFmpeg) and try again.'); process.exit(1); }
  render.ensureFonts();
  const specs = { cpu: os.cpus()[0]?.model, cores: os.cpus().length, ramGb: Math.round(os.totalmem() / 1e9), encoders: ctx.capabilities.encoders };
  let workerId = null;
  for (;;) {
    try {
      if (!workerId) { workerId = (await api('POST', '/api/workers/register', { name: NAME, capabilities: ['render.short'], specs })).workerId; console.log(`[worker] ${NAME} connected to ${ENGINE} · encoders: ${specs.encoders.join(', ')}`); }
      const free = Math.round(os.freemem() / 1048576);
      const r = await api('POST', '/api/workers/lease', { workerId, resources: { ramFreeMb: free } });
      if (r.job) { console.log(`[worker] leased ${r.job.spec.title}`); await runJob(workerId, r.job); continue; }
    } catch (e) { console.error(`[worker] ${e.message}; retrying`); if (/Unknown worker/.test(e.message)) workerId = null; await sleep(10000); }
    await sleep(5000);
  }
})();
