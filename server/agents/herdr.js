'use strict';
/**
 * Herdr terminal runtime. Herdr only manages terminal sessions for CLI agents
 * (Claude Code, Codex, Cursor, opencode, Grok CLI); it never decides anything.
 * The broker hands it a prompt for one agent and gets the agent's reply back.
 *
 * Written against the Herdr 0.9 command line:
 *   herdr --version · herdr status server --json · herdr server
 *   herdr session list --json · herdr workspace create|list · herdr pane list|split
 *   herdr agent list|start|prompt --wait|read
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const ctx = require('../core/ctx');
const audit = require('../core/audit');
const events = require('../core/events');
const tools = require('./tools');
const { now, sleep, safeJson } = require('../core/util');

const MANIFESTS = ['https://herdr.dev/latest.json', 'https://herdr.dev/preview.json'];
const WORKSPACE_LABEL = 'Euclidean agents';

let last = null;            // last status snapshot
const panes = new Map();    // agentId -> paneId
let workspaceId = null;

function cfg() { return ctx.setting('agentNet.herdr', {}) || {}; }
function save(patch) { ctx.store.setSettings({ agentNet: { herdr: patch } }); }

function binary() {
  const p = tools.findExecutable(['herdr'], { preferred: cfg().path });
  return p;
}

function target() {
  const osName = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux';
  const arch = process.arch === 'arm64' && osName !== 'windows' ? 'aarch64' : 'x86_64';
  return `${osName}-${arch}`;
}

async function run(args, opts = {}) {
  const bin = binary();
  if (!bin) throw new Error('Herdr isn\'t installed yet. Click "Install Herdr".');
  return tools.exec(bin, args, { timeoutMs: 30000, ...opts });
}

async function version() {
  const r = await run(['--version'], { timeoutMs: 15000 });
  return (r.out || r.err).trim().split(/\r?\n/)[0];
}

async function serverRunning() {
  try { await run(['status', 'server', '--json'], { timeoutMs: 10000 }); return true; } catch { return false; }
}

/** Start the headless Herdr server in the background if it isn't running. */
async function ensureServer() {
  if (await serverRunning()) return true;
  const spec = tools.launchSpec(binary(), ['server']);
  const child = spawn(spec.cmd, spec.args, { detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, ...spec.env } });
  child.unref();
  for (let i = 0; i < 20; i++) { await sleep(500); if (await serverRunning()) { audit.log('system', 'herdr.server_started', {}); return true; } }
  throw new Error('Herdr is installed, but its background server didn\'t start. Click "Test Herdr" for details, or restart the computer.');
}

/** Pull an id out of Herdr's output whether it printed JSON or text. */
function pickId(out, keys) {
  const j = safeJson(out);
  const walk = (o) => {
    if (!o || typeof o !== 'object') return null;
    for (const k of keys) if (o[k] != null && typeof o[k] !== 'object') return String(o[k]);
    for (const v of Object.values(o)) { const r = walk(v); if (r) return r; }
    return null;
  };
  const fromJson = walk(j);
  if (fromJson) return fromJson;
  for (const k of keys) { const m = new RegExp(`${k}["':=\\s]+([\\w:.-]+)`, 'i').exec(out); if (m) return m[1]; }
  const toks = String(out).trim().split(/\s+/); return toks[toks.length - 1] || null;
}

async function ensureWorkspace() {
  if (workspaceId) return workspaceId;
  const list = await run(['workspace', 'list']).catch(() => ({ out: '' }));
  const j = safeJson(list.out);
  const arr = Array.isArray(j) ? j : j?.workspaces || [];
  const found = arr.find((w) => (w.label || w.name) === WORKSPACE_LABEL);
  if (found) workspaceId = String(found.workspace_id || found.id);
  else {
    const r = await run(['workspace', 'create', '--label', WORKSPACE_LABEL, '--cwd', tools.toolsDir('herdr-work'), '--no-focus']);
    workspaceId = pickId(r.out, ['workspace_id', 'id']);
  }
  return workspaceId;
}

async function paneFor(agentId) {
  if (panes.has(agentId)) return panes.get(agentId);
  const ws = await ensureWorkspace();
  const r = await run(['pane', 'list', '--workspace', ws]);
  const j = safeJson(r.out); const arr = Array.isArray(j) ? j : j?.panes || [];
  const used = new Set(panes.values());
  const idOf = (p) => String(p.pane_id || p.id || '');
  let pane = arr.map((p) => (!p.agent && !used.has(idOf(p)) ? idOf(p) : '')).find(Boolean);
  if (!pane) {
    const base = arr[0] ? String(arr[0].pane_id || arr[0].id) : pickId(r.out, ['pane_id', 'id']);
    const s = await run(['pane', 'split', base, '--direction', 'right', '--cwd', tools.toolsDir('herdr-work'), '--no-focus']);
    pane = pickId(s.out, ['pane_id', 'id']);
  }
  panes.set(agentId, pane);
  return pane;
}

/**
 * Send one prompt to a terminal agent running inside Herdr and return its reply.
 * The full conversation goes into a file the agent reads, so long multi-line
 * prompts never have to be typed into a terminal. The agent writes its answer
 * to a reply file; if it doesn't, the new terminal output is used instead.
 */
async function ask({ agentId, kind, args = [], prompt, timeoutMs = 300000 }) {
  await ensureServer();
  const name = `eu-${agentId}`;
  const agents = await run(['agent', 'list']).catch(() => ({ out: '' }));
  if (!agents.out.includes(name)) {
    const pane = await paneFor(agentId);
    await run(['agent', 'start', name, '--kind', kind, '--pane', pane, '--timeout', '60000', '--', ...args], { timeoutMs: 90000 });
  }
  const dir = tools.toolsDir('herdr-work', 'inbox');
  const stamp = crypto.randomBytes(4).toString('hex');
  const inFile = path.join(dir, `${agentId}-${stamp}.md`);
  const outFile = path.join(dir, `${agentId}-${stamp}.reply.md`);
  fs.writeFileSync(inFile, prompt);
  const before = (await run(['agent', 'read', name, '--source', 'recent-unwrapped', '--lines', '400']).catch(() => ({ out: '' }))).out;
  const line = `Read the file ${inFile} and do what it asks. Write your full reply (only the reply) to ${outFile}, then stop.`;
  await run(['agent', 'prompt', name, line, '--wait', '--until', 'idle', '--timeout', String(timeoutMs)], { timeoutMs: timeoutMs + 15000 });
  let text = '';
  if (fs.existsSync(outFile)) text = fs.readFileSync(outFile, 'utf8');
  else {
    const after = (await run(['agent', 'read', name, '--source', 'recent-unwrapped', '--lines', '400'])).out;
    text = after.startsWith(before) ? after.slice(before.length) : after.split(/\r?\n/).slice(-80).join('\n');
  }
  for (const f of [inFile, outFile]) { try { fs.unlinkSync(f); } catch { /* already gone */ } }
  return text.trim();
}

/** Everything the settings card needs. */
async function status() {
  const bin = binary();
  const s = { installed: !!bin, path: bin, version: null, serverRunning: false, sessions: [], agents: '', target: target(), checkedAt: now(), error: null };
  if (bin) {
    try { s.version = await version(); } catch (e) { s.error = e.message; }
    s.serverRunning = await serverRunning();
    if (s.serverRunning) {
      const ses = await run(['session', 'list', '--json']).catch(() => null);
      const j = ses && safeJson(ses.out); s.sessions = Array.isArray(j) ? j : j?.sessions || [];
      s.agents = (await run(['agent', 'list']).catch(() => ({ out: '' }))).out.trim().slice(0, 4000);
    }
  }
  last = s;
  events.publish('herdr', s, { coalesceKey: 'herdr' });
  return s;
}

async function configure() {
  const bin = tools.findExecutable(['herdr']);
  if (!bin) return { ok: false, error: 'Herdr wasn\'t found on this computer. Click "Install Herdr", or "Install from file" if you downloaded the zip.' };
  save({ path: bin });
  audit.log('system', 'herdr.configured', { path: bin });
  return { ok: true, path: bin, ...(await status()) };
}

async function test() {
  try {
    const v = await version();
    await ensureServer();
    await status();
    return { ok: true, version: v, message: `Herdr ${v} is working and its server is running.` };
  } catch (e) { return { ok: false, error: e.message }; }
}

function installedBinaryIn(dir) {
  return tools.findExecutable(['herdr'], { extraDirs: [dir, path.join(dir, 'bin')] });
}

/** Install from Herdr's official release manifest (verifies the SHA-256 when the manifest lists one). */
async function install(actor = 'system') {
  const tgt = target();
  let asset = null; let sha = null; let ver = '';
  for (const url of MANIFESTS) {
    let m;
    try { const r = await fetch(url, { signal: AbortSignal.timeout(20000) }); if (!r.ok) continue; m = await r.json(); } catch { continue; }
    const a = m.assets?.[tgt];
    if (!a) continue;
    asset = typeof a === 'string' ? a : a.url; sha = (typeof a === 'object' && a.sha256) || m.sha256?.[tgt] || null; ver = m.version || m.base_version || '';
    break;
  }
  if (!asset) throw new Error(`Couldn't download Herdr automatically (no ${tgt} build was offered, or herdr.dev couldn't be reached). If you have the Herdr zip, use "Install from file".`);
  const dir = tools.toolsDir('herdr');
  const file = path.join(tools.toolsDir('downloads'), path.basename(new URL(asset).pathname) || 'herdr.bin');
  const buf = await tools.download(asset, file);
  if (sha && crypto.createHash('sha256').update(buf).digest('hex').toLowerCase() !== String(sha).toLowerCase()) throw new Error('The Herdr download was damaged (checksum mismatch). Please try again.');
  await placeArchive(file, dir);
  audit.log(actor, 'herdr.installed', { version: ver, source: 'herdr.dev' });
  return configure();
}

/** Install from a zip (or herdr.exe) the person already downloaded. */
async function installFromFile(file, actor = 'system') {
  if (!file || !fs.existsSync(file)) throw new Error('That file couldn\'t be found.');
  await placeArchive(file, tools.toolsDir('herdr'));
  audit.log(actor, 'herdr.installed', { source: path.basename(file) });
  return configure();
}

async function placeArchive(file, dir) {
  if (/\.(zip|tar\.gz|tgz)$/i.test(file)) await tools.unzip(file, dir);
  else { const dest = path.join(dir, process.platform === 'win32' ? 'herdr.exe' : 'herdr'); fs.copyFileSync(file, dest); try { fs.chmodSync(dest, 0o755); } catch { /* windows */ } }
  const bin = installedBinaryIn(dir);
  if (!bin) throw new Error('The file didn\'t contain the Herdr program. Make sure it\'s the Herdr download for this computer.');
  try { fs.chmodSync(bin, 0o755); } catch { /* windows */ }
  save({ path: bin });
}

module.exports = { status, configure, test, install, installFromFile, ask, ensureServer, binary, get last() { return last; } };
