'use strict';
/**
 * Each bot's own computer: a small Linux virtual machine on this PC (a Docker or Podman container), where a bot can
 * run commands, write and run code, keep files and open web pages in a real browser, without touching the PC itself.
 *
 *  - One container per bot (`euclidean-bot-<id>`), started when the bot first needs it and stopped after
 *    `bots.computer.idleMin` minutes idle (default 30). Its files are kept in <data>/bots/computers/<id>, which is
 *    the only folder of the PC it can see (/work inside).
 *  - Locked down: no extra Linux privileges (--cap-drop ALL, no-new-privileges), 2 GB of memory, 2 processor cores,
 *    at most 512 processes. It has the internet (that's the point) but not the PC's files.
 *  - The image (`euclidean/bot-computer:<IMAGE_V>`) is Debian with Chromium, Python, Node, curl and git, built once on
 *    this PC by "Set up the computer" (job `bots.computer.setup`).
 *  - Needs Docker Desktop (Windows/Mac) or Docker/Podman (Linux). `status()` says what's missing in plain words;
 *    on Windows "Install Docker Desktop" runs winget (job `bots.computer.install`).
 *
 * Inspired by OpenMausBot's Local VM (Apache 2.0, https://github.com/milind-soni/OpenMausBot); written fresh for
 * Euclidean, no code copied.
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const ctx = require('../core/ctx');
const paths = require('../core/paths');

const WIN = process.platform === 'win32';
const IMAGE_V = '1';
const IMAGE = `euclidean/bot-computer:${IMAGE_V}`;
const LABEL = 'media.euclidean.bot-computer';
const DOCKERFILE = `FROM debian:bookworm-slim
ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8
RUN apt-get update && apt-get install -y --no-install-recommends \\
    chromium fonts-dejavu-core fonts-liberation ca-certificates curl wget git jq unzip \\
    python3 python3-pip python3-venv python3-requests python3-bs4 nodejs npm procps \\
 && rm -rf /var/lib/apt/lists/*
RUN useradd -m -u 1000 bot && mkdir -p /work && chown bot:bot /work
USER bot
WORKDIR /work
LABEL ${LABEL}=${IMAGE_V}
CMD ["sleep", "infinity"]
`;

const rootDir = (...p) => { const d = path.join(paths.root, 'bots', ...p); fs.mkdirSync(d, { recursive: true }); return d; };
const workDir = (botId) => rootDir('computers', String(botId).replace(/[^A-Za-z0-9_-]/g, ''));
const nameOf = (botId) => `euclidean-bot-${String(botId).replace(/[^A-Za-z0-9_-]/g, '').toLowerCase()}`;

/** Run a program (never through a shell). Resolves { code, out, err }. */
function run(cmd, args, { timeout = 60000, input = null, onLine = null, max = 200000 } = {}) {
  return new Promise((resolve) => {
    let out = ''; let err = ''; let done = false;
    let p;
    try { p = spawn(cmd, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); } catch (e) { return resolve({ code: -1, out: '', err: e.message }); }
    const timer = setTimeout(() => { if (!done) { err += `\n(stopped after ${Math.round(timeout / 1000)} s)`; try { p.kill('SIGKILL'); } catch { /* gone */ } } }, timeout);
    const feed = (which) => (c) => { const s = c.toString(); if (which === 'out') { if (out.length < max) out += s; } else if (err.length < max) err += s; if (onLine) for (const l of s.split(/\r?\n/)) if (l.trim()) onLine(l); };
    p.stdout.on('data', feed('out')); p.stderr.on('data', feed('err'));
    p.on('error', (e) => { if (!done) { done = true; clearTimeout(timer); resolve({ code: -1, out, err: e.message }); } });
    p.on('close', (code) => { if (!done) { done = true; clearTimeout(timer); resolve({ code, out, err }); } });
    if (input != null) { p.stdin.write(input); } p.stdin.end();
  });
}

// ------------------------------------------------------------------ finding Docker / Podman
let found = null; let foundAt = 0;
function candidates() {
  const list = [ctx.setting?.('bots.computer.runtime', '') || null, 'docker', 'podman'];
  if (WIN) list.push(path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Docker', 'Docker', 'resources', 'bin', 'docker.exe'), path.join(process.env.ProgramFiles || 'C:\\Program Files', 'RedHat', 'Podman', 'podman.exe'));
  else list.push('/usr/local/bin/docker', '/opt/homebrew/bin/docker', '/Applications/Docker.app/Contents/Resources/bin/docker', '/opt/homebrew/bin/podman', '/usr/bin/podman');
  return [...new Set(list.filter(Boolean))];
}
/** { cli, kind: 'docker'|'podman', installed, running, version, error } (cached 20 s). */
async function runtime(force = false) {
  if (!force && found && Date.now() - foundAt < 20000) return found;
  let best = { cli: null, kind: null, installed: false, running: false, error: 'not-installed' };
  for (const c of candidates()) {
    const v = await run(c, ['version', '--format', '{{.Server.Version}}'], { timeout: 12000 });
    if (v.code === -1) continue; // not there
    const kind = /podman/i.test(c) || /podman/i.test(v.out + v.err) ? 'podman' : 'docker';
    if (v.code === 0 && v.out.trim()) { best = { cli: c, kind, installed: true, running: true, version: v.out.trim() }; break; }
    if (!best.installed) best = { cli: c, kind, installed: true, running: false, error: 'not-running', detail: (v.err || v.out).trim().split('\n').pop().slice(0, 200) };
  }
  found = best; foundAt = Date.now();
  return best;
}

async function imageReady(cli) { const r = await run(cli, ['image', 'inspect', IMAGE, '--format', '{{.Id}}'], { timeout: 15000 }); return r.code === 0; }
async function state(cli, botId) {
  const r = await run(cli, ['container', 'inspect', nameOf(botId), '--format', '{{.State.Status}}'], { timeout: 15000 });
  return r.code === 0 ? r.out.trim() : 'none';
}

const MESSAGES = {
  'not-installed': WIN ? 'Bots need Docker Desktop for their own computer. Press "Install Docker Desktop" (it needs a restart of the PC once), then open Docker Desktop.' : 'Bots need Docker Desktop (Mac) or Docker/Podman (Linux) for their own computer. Install it, open it once, then press Check again.',
  'not-running': 'Docker is installed but not running. Open Docker Desktop and wait until it says it is running, then press Check again.',
  'no-image': 'The bots\' computer isn\'t set up on this PC yet. Press "Set up the computer" (a one-time download of about 600 MB).',
};

/** Everything the page needs: runtime, image, and this bot's machine. */
async function status(botId = null, { force = false } = {}) {
  const rt = await runtime(force);
  const out = { runtime: rt.kind, installed: rt.installed, running: rt.running, version: rt.version || null, image: false, ready: false, canInstall: WIN && !rt.installed, setupJob: setupJob() };
  if (!rt.running) return { ...out, problem: rt.error, message: MESSAGES[rt.error], detail: rt.detail || null };
  out.image = await imageReady(rt.cli);
  if (!out.image) return { ...out, problem: 'no-image', message: MESSAGES['no-image'] };
  out.ready = true;
  if (botId) { out.machine = await state(rt.cli, botId); out.folder = workDir(botId); }
  return out;
}
function setupJob() {
  const j = ctx.store?.find?.('jobs', (x) => (x.type === 'bots.computer.setup' || x.type === 'bots.computer.install') && !['done', 'failed', 'cancelled', 'canceled', 'succeeded'].includes(x.status));
  const last = !j && ctx.store?.all?.('jobs', (x) => x.type === 'bots.computer.setup' || x.type === 'bots.computer.install').slice(-1)[0];
  if (last && last.status === 'failed') return { id: last.id, type: last.type, failed: true, error: last.error };
  return j ? { id: j.id, type: j.type, progress: j.progress, note: j.note || '' } : null;
}

/** Build the image (job bots.computer.setup). */
async function setup(h = { progress() {} }) {
  const rt = await runtime(true);
  if (!rt.running) throw Object.assign(new Error(MESSAGES[rt.error]), { notConnected: true });
  h.progress(0.02, 'Downloading Debian and the browser (one time, about 600 MB)');
  let steps = 0;
  const r = await run(rt.cli, ['build', '-t', IMAGE, '-'], {
    input: DOCKERFILE, timeout: 45 * 60000,
    onLine: (l) => { if (/^#\d+|^Step \d+|STEP \d+/i.test(l)) steps++; const m = /(\d+)\s*(?:of|\/)\s*(\d+)\s*(?:files|packages)?|Get:(\d+)/.exec(l); h.progress(Math.min(0.95, 0.05 + steps * 0.02 + (m && m[3] ? Number(m[3]) / 900 : 0)), l.replace(/\s+/g, ' ').slice(0, 120)); },
  });
  if (r.code !== 0) throw new Error(`Setting up the computer failed: ${(r.err || r.out).trim().split('\n').slice(-3).join(' ').slice(0, 300)}`);
  h.progress(1, 'The bots\' computer is ready');
  return { image: IMAGE };
}

/** Install Docker Desktop on Windows (job bots.computer.install). */
async function installDocker(h = { progress() {} }) {
  if (!WIN) throw new Error('Install Docker from docker.com on this computer, then press Check again.');
  h.progress(0.05, 'Installing Docker Desktop with winget (this takes a few minutes)');
  const r = await run('winget', ['install', '-e', '--id', 'Docker.DockerDesktop', '--accept-package-agreements', '--accept-source-agreements', '--silent'], { timeout: 40 * 60000, onLine: (l) => h.progress(0.5, l.slice(0, 120)) });
  if (r.code !== 0 && !/already installed/i.test(r.out + r.err)) throw new Error(`Docker Desktop didn't install: ${(r.err || r.out).trim().split('\n').pop().slice(0, 200)}. You can also download it from docker.com.`);
  found = null;
  h.progress(1, 'Docker Desktop is installed. Restart the PC if it asks, open Docker Desktop once, then set up the bots\' computer.');
  return { ok: true };
}

const lastUse = {};
/** Make sure this bot's machine is running; returns the CLI to talk to it. */
async function ensure(botId) {
  const st = await status(botId);
  if (!st.ready) throw Object.assign(new Error(st.message), { computer: st.problem });
  const rt = await runtime();
  const name = nameOf(botId);
  if (st.machine === 'none') {
    const args = ['run', '-d', '--name', name, '--label', `${LABEL}=${IMAGE_V}`, '--hostname', 'bot-computer',
      '--memory', `${Number(ctx.setting('bots.computer.memoryMb', 2048))}m`, '--cpus', String(ctx.setting('bots.computer.cpus', 2)), '--pids-limit', '512',
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--shm-size', '512m',
      '-v', `${workDir(botId)}:/work`, '-w', '/work', IMAGE, 'sleep', 'infinity'];
    if (rt.kind === 'podman') args.splice(1, 0, '--userns=keep-id');
    // On Linux the folder belongs to the PC's own user, so the machine runs as that user (Docker Desktop on
    // Windows/Mac shares folders writable for anyone).
    else if (process.platform === 'linux' && typeof process.getuid === 'function') args.splice(1, 0, '--user', `${process.getuid()}:${process.getgid()}`, '-e', 'HOME=/work');
    const r = await run(rt.cli, args, { timeout: 60000 });
    if (r.code !== 0) throw new Error(`The bot's computer didn't start: ${(r.err || r.out).trim().split('\n').pop().slice(0, 240)}`);
  } else if (st.machine !== 'running') {
    const r = await run(rt.cli, ['start', name], { timeout: 60000 });
    if (r.code !== 0) throw new Error(`The bot's computer didn't start: ${(r.err || r.out).trim().split('\n').pop().slice(0, 240)}`);
  }
  lastUse[botId] = Date.now();
  return { cli: rt.cli, name };
}

/** Run a shell command inside the bot's machine. Resolves { code, output }. */
async function exec(botId, command, { timeout = 120000 } = {}) {
  const { cli, name } = await ensure(botId);
  const r = await run(cli, ['exec', '-i', '-w', '/work', name, 'bash', '-lc', String(command)], { timeout: Math.min(Number(timeout) || 120000, 15 * 60000), max: 60000 });
  lastUse[botId] = Date.now();
  const output = [r.out.trimEnd(), r.err.trimEnd()].filter(Boolean).join('\n');
  return { code: r.code, output: output.length > 30000 ? `${output.slice(0, 15000)}\n…(cut)…\n${output.slice(-14000)}` : output };
}

/** A path inside /work (the only place files are read or written). */
function inWork(botId, p) {
  const base = workDir(botId);
  const rel = String(p || '').replace(/^\/?work\/?/, '').replace(/^\/+/, '');
  const full = path.resolve(base, rel);
  if (full !== base && !full.startsWith(base + path.sep)) throw new Error('Files stay inside the bot\'s own folder (/work).');
  return full;
}
function writeFile(botId, p, content) { const f = inWork(botId, p); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, String(content ?? '')); return { path: `/work/${path.relative(workDir(botId), f).replace(/\\/g, '/')}`, bytes: Buffer.byteLength(String(content ?? '')) }; }
function readFile(botId, p, max = 40000) { const f = inWork(botId, p); const st = fs.statSync(f); if (st.isDirectory()) return { dir: true, files: listFiles(botId, p) }; const b = fs.readFileSync(f); const text = b.subarray(0, max).toString('utf8'); return { path: `/work/${path.relative(workDir(botId), f).replace(/\\/g, '/')}`, bytes: st.size, text, cut: st.size > max }; }
function listFiles(botId, sub = '', limit = 300) {
  const base = workDir(botId); const start = inWork(botId, sub); const out = [];
  const walk = (d, depth) => { if (out.length >= limit || depth > 5) return; let ents = []; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) { if (out.length >= limit) return; if (e.name === '.shots' || e.name === 'node_modules' || e.name === '.cache') continue; const f = path.join(d, e.name); const rel = path.relative(base, f).replace(/\\/g, '/');
      if (e.isDirectory()) { out.push({ path: `${rel}/`, dir: true }); walk(f, depth + 1); } else { let size = 0; try { size = fs.statSync(f).size; } catch { /* gone */ } out.push({ path: rel, size }); } } };
  walk(start, 0); return out;
}

/** Open a page in the machine's Chromium: { url, title, text, links, shot (file on the PC) }. */
async function browse(botId, url) {
  const ok = await require('../integrations/safefetch').check(url); if (!ok.ok) throw new Error(ok.reason);
  const { cli, name } = await ensure(botId);
  fs.mkdirSync(path.join(workDir(botId), '.shots'), { recursive: true });
  const file = `.shots/${Date.now()}.png`;
  const flags = ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--hide-scrollbars', '--no-first-run', '--window-size=1280,1600', '--virtual-time-budget=9000', '--user-agent=Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36'];
  const [shot, dom] = await Promise.all([
    run(cli, ['exec', name, 'chromium', ...flags, `--screenshot=/work/${file}`, String(url)], { timeout: 60000 }),
    run(cli, ['exec', name, 'chromium', ...flags, '--dump-dom', String(url)], { timeout: 60000, max: 3_000_000 }),
  ]);
  lastUse[botId] = Date.now();
  if (dom.code !== 0 && !dom.out) throw new Error(`The page didn't open: ${(dom.err || '').trim().split('\n').pop().slice(0, 200)}`);
  const page = require('../integrations/websearch').extract(dom.out, url);
  const shotPath = path.join(workDir(botId), file);
  return { url, title: page.title, text: page.text, links: page.links, shot: shot.code === 0 && fs.existsSync(shotPath) ? shotPath : null };
}

async function stop(botId) { const rt = await runtime(); if (!rt.running) return { ok: true }; await run(rt.cli, ['stop', '-t', '3', nameOf(botId)], { timeout: 30000 }); return { ok: true }; }
/** Throw the machine away (its files in /work are kept unless wipe). */
async function reset(botId, { wipe = false } = {}) {
  const rt = await runtime(); if (rt.running) await run(rt.cli, ['rm', '-f', nameOf(botId)], { timeout: 30000 });
  if (wipe) { try { fs.rmSync(workDir(botId), { recursive: true, force: true }); } catch { /* in use */ } }
  return { ok: true };
}

// Idle machines are stopped so they don't hold memory.
setInterval(async () => {
  const idle = Number(ctx.setting?.('bots.computer.idleMin', 30)) * 60000;
  for (const [id, t] of Object.entries(lastUse)) if (Date.now() - t > idle) { delete lastUse[id]; stop(id).catch(() => {}); }
}, 5 * 60000).unref?.();

module.exports = { status, runtime, setup, installDocker, ensure, exec, writeFile, readFile, listFiles, browse, stop, reset, workDir, nameOf, IMAGE, DOCKERFILE };
