'use strict';
/**
 * Computer resource manager. Samples CPU, RAM, GPU (NVIDIA via nvidia-smi)
 * and disk; detects Premiere Pro; gates heavy jobs so editing in Premiere
 * through Astra always has headroom; and implements the three power modes:
 *   full        everything runs
 *   background  window closed to tray, engine still does all work
 *   lite        vital functions only: messaging, publishing, approvals, safety.
 *               Renders, transcription, discovery and analytics are suspended,
 *               sampling slows down and caches are released.
 */
const os = require('os');
const fs = require('fs');
const ctx = require('../core/ctx');
const events = require('../core/events');
const paths = require('../core/paths');
const { run } = require('../core/util');

let last = null; let prevCpu = null; let timer = null;
const history = [];
let premiere = { open: false, checkedAt: 0 };
let gpuAvailable = null;

function cpuPercent() {
  const cpus = os.cpus();
  const t = cpus.reduce((a, c) => { for (const k in c.times) a.total += c.times[k]; a.idle += c.times.idle; return a; }, { total: 0, idle: 0 });
  if (!prevCpu) { prevCpu = t; return 0; }
  const dt = t.total - prevCpu.total, di = t.idle - prevCpu.idle; prevCpu = t;
  return dt > 0 ? Math.round((1 - di / dt) * 100) : 0;
}

async function gpu() {
  if (gpuAvailable === false) return null;
  try {
    const r = await run('nvidia-smi', ['--query-gpu=name,utilization.gpu,memory.used,memory.total', '--format=csv,noheader,nounits'], { timeoutMs: 5000 });
    const [name, util, used, total] = r.out.trim().split('\n')[0].split(',').map((s) => s.trim());
    gpuAvailable = true;
    return { name, util: +util, memUsedMb: +used, memTotalMb: +total };
  } catch { gpuAvailable = false; return null; }
}

async function detectPremiere() {
  if (Date.now() - premiere.checkedAt < 15000) return premiere.open;
  premiere.checkedAt = Date.now();
  try {
    if (process.platform === 'win32') {
      const r = await run('tasklist', ['/FI', 'IMAGENAME eq Adobe Premiere Pro.exe', '/NH'], { timeoutMs: 8000 });
      premiere.open = /Premiere/i.test(r.out);
    } else if (process.platform === 'darwin') {
      const r = await run('pgrep', ['-f', 'Adobe Premiere Pro'], { timeoutMs: 5000 }).catch(() => ({ out: '' }));
      premiere.open = !!r.out.trim();
    } else premiere.open = false;
  } catch { premiere.open = false; }
  return premiere.open;
}

async function sample() {
  const total = os.totalmem(), free = os.freemem();
  let disk = null;
  try { const s = fs.statfsSync(paths.root); disk = { freeGb: Math.round((s.bavail * s.bsize) / 1e9), totalGb: Math.round((s.blocks * s.bsize) / 1e9) }; } catch { /* unsupported */ }
  const mu = process.memoryUsage();
  last = {
    at: new Date().toISOString(), cpu: cpuPercent(), cores: os.cpus().length,
    ramTotalMb: Math.round(total / 1048576), ramFreeMb: Math.round(free / 1048576),
    engineMb: Math.round(mu.rss / 1048576), heapMb: Math.round(mu.heapUsed / 1048576),
    uiMb: ctx.uiMemoryMb ? ctx.uiMemoryMb() : null,
    gpu: await gpu(), disk, premiereOpen: await detectPremiere(), mode: ctx.setting('resources.mode', 'full'),
    host: os.hostname(), platform: process.platform,
  };
  history.push({ t: Date.now(), cpu: last.cpu, ram: last.ramTotalMb - last.ramFreeMb, gpu: last.gpu?.util ?? null });
  while (history.length > 240) history.shift();
  events.publish('resources', last, { coalesceKey: 'resources' });
  if (last.premiereOpen && ctx.setting('resources.autoLiteWhenPremiereOpen', false) && last.mode === 'full') setMode('lite', 'Premiere Pro opened');
  return last;
}

/** Decide whether a heavy job may start right now. */
function heavyGate() {
  if (!last) return { ok: true };
  // Keep some RAM free for other apps, but never so much that an ordinary PC can't run anything:
  // at most 12% of this PC's RAM (about 1 GB on an 8 GB PC), and never less than 500 MB.
  const reserve = Math.max(500, Math.min(ctx.setting('resources.reserveRamMb', 1000), Math.round((last.ramTotalMb || 8000) * 0.12)));
  if (last.ramFreeMb < reserve) return { ok: false, reason: `Waiting for memory: ${last.ramFreeMb} MB free, needs ${reserve} MB. Close some apps or browser tabs.` };
  const cpuMax = ctx.setting('resources.pauseHeavyWhenCpuAbove', 85);
  if (last.cpu > cpuMax) return { ok: false, reason: `Waiting: CPU at ${last.cpu}%` };
  if (last.premiereOpen && ctx.setting('resources.pauseHeavyWhenPremiereOpen', true)) return { ok: false, reason: 'Waiting: Premiere Pro is open' };
  if (last.disk && last.disk.freeGb < 5) return { ok: false, reason: `Waiting: only ${last.disk.freeGb} GB disk free` };
  return { ok: true };
}

function interval() { return ctx.setting('resources.mode', 'full') === 'lite' ? 30000 : 4000; }
function schedule() { clearTimeout(timer); timer = setTimeout(async () => { try { await sample(); } catch { /* sampling never crashes the engine */ } schedule(); }, interval()); }
function start() { sample().catch(() => {}); schedule(); }

const modeListeners = new Set();
function onMode(fn) { modeListeners.add(fn); }
function setMode(mode, reason = 'user') {
  if (!['full', 'lite', 'background'].includes(mode)) throw new Error('Unknown mode');
  ctx.store.setSettings({ resources: { mode } });
  if (mode === 'lite' && global.gc) global.gc();
  require('../core/audit').log('system', 'resources.mode', { mode, reason });
  events.publish('mode', { mode, reason });
  for (const fn of modeListeners) { try { fn(mode); } catch { /* ignore */ } }
  schedule();
  return mode;
}

module.exports = { start, sample, heavyGate, setMode, onMode, get last() { return last; }, history: () => history };
