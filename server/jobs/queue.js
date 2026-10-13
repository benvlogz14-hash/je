'use strict';
/**
 * Persistent job queue. Jobs live in the database, so they survive restarts:
 * anything that was running when the engine stopped is re-queued on boot.
 * Supports priorities, delayed execution, retries with exponential backoff,
 * cancellation, idempotency keys, resource-aware scheduling of heavy jobs and
 * leasing to remote worker machines.
 */
const ctx = require('../core/ctx');
const events = require('../core/events');
const audit = require('../core/audit');
const { now } = require('../core/util');

const handlers = {};
const running = new Map(); // jobId -> { controller, heavy, startedAt }
let paused = false;
let timer = null;
let gate = () => ({ ok: true }); // resource gate for heavy jobs, provided by resources.js

const TERMINAL = new Set(['done', 'failed', 'canceled']);

/**
 * @param def.run       async (job, h) => result
 * @param def.heavy     uses significant CPU/GPU/RAM (renders, local transcription)
 * @param def.remote    can be executed by a remote worker machine
 * @param def.external  completed by an outside agent (Astra/Premiere) through the API
 * @param def.vital     keeps running in Lite mode
 * @param def.title     (payload) => display title
 */
const isHeavy = (h) => (typeof h.heavy === 'function' ? !!h.heavy() : !!h.heavy);
function register(type, def) { handlers[type] = { timeoutMs: 2 * 3600000, ...def }; }
function setGate(fn) { gate = fn; }

function publish(job) { events.publish('job', slim(job), { coalesceKey: `job:${job.id}` }); }
function slim(j) { const { log, ...rest } = j; return { ...rest, logTail: (log || []).slice(-3) }; }

function enqueue(type, payload = {}, opts = {}) {
  if (!handlers[type]) throw new Error(`Unknown job type ${type}`);
  if (opts.dedupeKey) {
    const existing = ctx.store.find('jobs', (j) => j.dedupeKey === opts.dedupeKey && !TERMINAL.has(j.status));
    if (existing) return existing;
  }
  const h = handlers[type];
  const job = ctx.store.insert('jobs', {
    type, payload, clientId: opts.clientId || payload.clientId || null, title: opts.title || (h.title ? h.title(payload) : type),
    status: h.external ? 'waiting_agent' : 'queued', priority: opts.priority ?? 5, runAt: opts.runAt || now(), attempts: 0, maxAttempts: opts.maxAttempts ?? h.maxAttempts ?? 3,
    progress: 0, note: '', log: [], result: null, error: null, parentId: opts.parentId || null, dedupeKey: opts.dedupeKey || null,
    heavy: isHeavy(h), assignee: opts.assignee || h.assignee || (h.external ? 'computer-use' : 'engine'), createdBy: opts.actor || 'system',
  });
  publish(job);
  setImmediate(tick);
  return job;
}

function helpers(job, controller) {
  let lastSave = 0;
  return {
    signal: controller.signal,
    progress(p, note) {
      const j = ctx.store.get('jobs', job.id); if (!j) return;
      j.progress = Math.max(0, Math.min(1, p)); if (note != null) j.note = note;
      // Persist at most every 2s; stream every change to the UI.
      if (Date.now() - lastSave > 2000) { lastSave = Date.now(); ctx.store.update('jobs', job.id, {}); }
      publish(j);
    },
    log(msg) {
      const j = ctx.store.get('jobs', job.id); if (!j) return;
      j.log.push({ at: now(), msg: String(msg).slice(0, 2000) }); if (j.log.length > 200) j.log.splice(0, j.log.length - 200);
      ctx.store.update('jobs', job.id, {}); publish(j);
    },
    enqueue: (type, payload, opts = {}) => enqueue(type, payload, { parentId: job.id, clientId: job.clientId, ...opts }),
  };
}

async function execute(job) {
  const h = handlers[job.type];
  const controller = new AbortController();
  running.set(job.id, { controller, heavy: isHeavy(h), startedAt: Date.now() });
  ctx.store.update('jobs', job.id, { status: 'running', attempts: job.attempts + 1, startedAt: now(), error: null, workerId: 'local' });
  publish(job);
  const timeout = setTimeout(() => controller.abort(), h.timeoutMs);
  try {
    const result = await h.run(ctx.store.get('jobs', job.id), helpers(job, controller));
    const cur = ctx.store.get('jobs', job.id);
    if (cur && cur.status === 'running') ctx.store.update('jobs', job.id, { status: 'done', progress: 1, result: result ?? null, finishedAt: now(), note: cur.note || 'Complete' });
  } catch (e) {
    const cur = ctx.store.get('jobs', job.id);
    if (!cur) return;
    if (controller.signal.aborted && cur.status === 'canceled') { /* user canceled */ }
    else if (e.canceled || cur.status === 'canceled') ctx.store.update('jobs', job.id, { status: 'canceled', finishedAt: now() });
    else if (e.deferUntil) ctx.store.update('jobs', job.id, { status: 'queued', runAt: e.deferUntil, attempts: Math.max(0, cur.attempts - 1), note: e.message });
    else {
      const permanent = e.permanent || e.notConnected;
      const willRetry = !permanent && cur.attempts < cur.maxAttempts;
      const delay = Math.min(30 * 60, 20 * 2 ** (cur.attempts - 1)) * 1000;
      cur.log.push({ at: now(), msg: `Error: ${e.message}` });
      ctx.store.update('jobs', job.id, willRetry
        ? { status: 'queued', runAt: new Date(Date.now() + delay).toISOString(), error: e.message, note: `Retrying in ${Math.round(delay / 1000)}s` }
        : { status: 'failed', error: e.message, finishedAt: now(), note: e.notConnected ? 'Integration not connected' : 'Failed', needsIntegration: !!e.notConnected });
      if (!willRetry) {
        audit.log('system', 'job.failed', { jobId: job.id, type: job.type, clientId: job.clientId, error: e.message }, 'error');
        events.publish('alert', { level: e.notConnected ? 'warn' : 'error', title: `${cur.title} failed`, text: e.message, jobId: job.id });
      }
    }
  } finally {
    clearTimeout(timeout);
    running.delete(job.id);
    const j = ctx.store.get('jobs', job.id); if (j) publish(j);
    setImmediate(tick);
  }
}

function limits() {
  return { heavy: ctx.setting('resources.maxConcurrentRenders', 1), light: ctx.setting('resources.maxConcurrentLight', 4) };
}

function tick() {
  if (paused) return;
  const lim = limits();
  const mode = ctx.setting('resources.mode', 'full');
  let heavyRunning = 0, lightRunning = 0;
  for (const r of running.values()) r.heavy ? heavyRunning++ : lightRunning++;
  const t = now();
  const ready = ctx.store.all('jobs', (j) => j.status === 'queued' && j.runAt <= t && handlers[j.type] && !handlers[j.type].external)
    .sort((a, b) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt));
  let heavyGate = null;
  for (const job of ready) {
    const h = handlers[job.type];
    if (mode === 'lite' && !h.vital) continue; // Lite mode: only vital work (messaging, publishing, safety)
    if (isHeavy(h)) {
      if (heavyRunning >= lim.heavy) continue;
      if (!ctx.setting('resources.runHeavyJobsLocally', true)) continue; // left for remote workers
      heavyGate = heavyGate || gate();
      if (!heavyGate.ok) { if (job.note !== heavyGate.reason) { ctx.store.update('jobs', job.id, { note: heavyGate.reason }); publish(job); } continue; }
      heavyRunning++;
    } else {
      if (lightRunning >= lim.light) continue;
      lightRunning++;
    }
    execute(job);
  }
}

function start() {
  // Recover jobs that were mid-flight when the engine stopped.
  for (const j of ctx.store.all('jobs', (x) => x.status === 'running')) {
    ctx.store.update('jobs', j.id, { status: 'queued', note: 'Recovered after restart', workerId: null, runAt: now() });
  }
  timer = setInterval(() => { tick(); expireLeases(); }, 1000);
}
function stop() { clearInterval(timer); for (const r of running.values()) r.controller.abort(); }

function cancel(id, actor = 'user') {
  const j = ctx.store.get('jobs', id); if (!j || TERMINAL.has(j.status)) return j;
  ctx.store.update('jobs', id, { status: 'canceled', finishedAt: now(), note: `Canceled by ${actor}` });
  const r = running.get(id); if (r) r.controller.abort();
  publish(j); return j;
}
function retry(id) {
  const j = ctx.store.get('jobs', id); if (!j) return null;
  ctx.store.update('jobs', id, { status: handlers[j.type]?.external ? 'waiting_agent' : 'queued', runAt: now(), attempts: 0, error: null, note: 'Retry requested', workerId: null });
  publish(j); setImmediate(tick); return j;
}
function setPaused(v) { paused = !!v; events.publish('queue', { paused }); if (!paused) setImmediate(tick); }

// ---------------------------------------------------------------- Remote workers
const LEASE_MS = 90 * 1000;
function lease(workerId, capabilities = []) {
  if (paused) return null;
  const t = now();
  const job = ctx.store.all('jobs', (j) => j.status === 'queued' && j.runAt <= t && handlers[j.type]?.remote && capabilities.includes(j.type))
    .sort((a, b) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt))[0];
  if (!job) return null;
  ctx.store.update('jobs', job.id, { status: 'running', workerId, attempts: job.attempts + 1, startedAt: t, leaseUntil: new Date(Date.now() + LEASE_MS).toISOString(), note: `Running on ${workerId}` });
  publish(job);
  return job;
}
function heartbeat(jobId, workerId, progress, note) {
  const j = ctx.store.get('jobs', jobId);
  if (!j || j.workerId !== workerId || j.status !== 'running') return false;
  j.progress = progress ?? j.progress; if (note) j.note = note; j.leaseUntil = new Date(Date.now() + LEASE_MS).toISOString();
  publish(j); return true;
}
function expireLeases() {
  const t = now();
  for (const j of ctx.store.all('jobs', (x) => x.status === 'running' && x.leaseUntil && x.workerId !== 'local' && x.leaseUntil < t)) {
    ctx.store.update('jobs', j.id, { status: 'queued', workerId: null, leaseUntil: null, note: 'Worker stopped responding; re-queued' });
    audit.log('system', 'worker.lease_expired', { jobId: j.id, workerId: j.workerId }, 'warn');
  }
}

function stats() {
  const all = ctx.store.all('jobs');
  const by = (s) => all.filter((j) => j.status === s).length;
  const day = new Date(Date.now() - 864e5).toISOString();
  return { paused, running: by('running'), queued: by('queued'), waitingAgent: by('waiting_agent'), failed24h: all.filter((j) => j.status === 'failed' && (j.finishedAt || '') > day).length, done24h: all.filter((j) => j.status === 'done' && (j.finishedAt || '') > day).length, localRunning: [...running.keys()] };
}

module.exports = { register, enqueue, start, stop, tick, cancel, retry, setPaused, setGate, lease, heartbeat, stats, handlers, get paused() { return paused; }, slim, publish };
