'use strict';
/**
 * Connects the Claude apps on this PC to Euclidean (the MCP connector in mcp/euclidean-mcp.js), at every engine start,
 * so it comes with the normal download and updates: no separate setup file.
 *
 *  - Claude desktop app: adds (or fixes) mcpServers.euclidean in its claude_desktop_config.json (Windows, including a
 *    Microsoft Store install, Mac and Linux). Only when Claude is installed (its folder exists); a config file that
 *    can't be read is left alone, never overwritten.
 *  - Claude Code: `claude mcp add-json --scope user euclidean ...` once per app location, when the `claude` command exists.
 *
 * The connector runs with Node when it's installed (Start Euclidean.bat installs it), else with this app's own runtime
 * (Electron in Node mode). Off with the setting claude.connect = false.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const ctx = require('../core/ctx');

const SCRIPT = path.join(__dirname, '..', '..', 'mcp', 'euclidean-mcp.js');

/** A node binary on PATH, else null. */
function findNode() {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd'] : [''];
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    for (const e of exts) { const f = path.join(dir, `node${e}`); try { if (fs.statSync(f).isFile()) return f; } catch { /* next */ } }
  }
  return null;
}

/** How Claude should start the connector. */
function entry() {
  const node = process.versions.electron ? findNode() : process.execPath;
  if (node) return { command: node, args: [SCRIPT] };
  return { command: process.execPath, args: [SCRIPT], env: { ELECTRON_RUN_AS_NODE: '1' } }; // Electron acting as Node
}

/** Where the Claude desktop app keeps its settings, for the installs that exist on this PC. */
function desktopConfigs() {
  const home = os.homedir(); const out = [];
  if (process.platform === 'win32') {
    const appdata = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    // Claude is installed (in AnthropicClaude) but has never run, so its settings folder doesn't exist yet: make it.
    const installed = ['AnthropicClaude', path.join('Programs', 'Claude'), 'Claude'].some((d) => { try { return fs.statSync(path.join(local, d)).isDirectory(); } catch { return false; } });
    if (installed) { try { fs.mkdirSync(path.join(appdata, 'Claude'), { recursive: true }); } catch { /* read-only */ } }
    out.push(path.join(appdata, 'Claude'));
    const pk = path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'Packages');
    try { for (const d of fs.readdirSync(pk)) if (/^Claude_/i.test(d)) out.push(path.join(pk, d, 'LocalCache', 'Roaming', 'Claude')); } catch { /* none */ }
  } else if (process.platform === 'darwin') {
    if (fs.existsSync('/Applications/Claude.app')) { try { fs.mkdirSync(path.join(home, 'Library', 'Application Support', 'Claude'), { recursive: true }); } catch { /* fine */ } }
    out.push(path.join(home, 'Library', 'Application Support', 'Claude'));
  }
  else out.push(path.join(home, '.config', 'Claude'));
  return out.filter((d) => { try { return fs.statSync(d).isDirectory(); } catch { return false; } }).map((d) => path.join(d, 'claude_desktop_config.json'));
}

function same(a, b) { return JSON.stringify(a || null) === JSON.stringify(b || null); }

/** Add or fix the "euclidean" entry in each Claude desktop config. Returns the files changed. */
function connectDesktop(want) {
  const changed = [];
  for (const f of desktopConfigs()) {
    let cfg = {};
    if (fs.existsSync(f)) {
      try { const raw = fs.readFileSync(f, 'utf8').replace(/^﻿/, '').trim(); cfg = raw ? JSON.parse(raw) : {}; } catch { continue; } // never overwrite a file we can't read
    }
    if (typeof cfg !== 'object' || Array.isArray(cfg) || !cfg) continue;
    cfg.mcpServers = cfg.mcpServers && typeof cfg.mcpServers === 'object' ? cfg.mcpServers : {};
    if (same(cfg.mcpServers.euclidean, want)) continue;
    cfg.mcpServers.euclidean = want;
    try { const tmp = `${f}.tmp`; fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2)); fs.renameSync(tmp, f); changed.push(f); } catch { /* read-only */ }
  }
  return changed;
}

/** Claude Code (the CLI), once per connector location. */
function connectCode(want) {
  const key = JSON.stringify(want);
  if (ctx.store?.settings?._claudeCodeMcp === key) return;
  const claude = process.platform === 'win32' ? 'claude.cmd' : 'claude';
  const opts = { timeout: 20000, windowsHide: true, shell: process.platform === 'win32' };
  execFile(claude, ['--version'], opts, (err) => {
    if (err) return; // not installed
    // Paths like C:\Program Files\nodejs\node.exe have spaces: quoted for the Windows shell.
    const q = (x) => (process.platform === 'win32' && /\s/.test(x) ? `"${x}"` : x);
    const add = ['mcp', 'add', '--scope', 'user', ...Object.entries(want.env || {}).flatMap(([k, v]) => ['-e', `${k}=${v}`]), 'euclidean', '--', q(want.command), ...want.args.map(q)];
    execFile(claude, ['mcp', 'remove', '--scope', 'user', 'euclidean'], opts, () => {
      execFile(claude, add, opts, (e2) => {
        if (!e2 && ctx.store) { ctx.store.settings._claudeCodeMcp = key; ctx.store.touch(); }
      });
    });
  });
}

function ensure() {
  if (ctx.setting('claude.connect', true) === false || !fs.existsSync(SCRIPT)) return { skipped: true };
  const want = entry();
  const changed = connectDesktop(want);
  try { watch(); } catch { /* optional */ }
  try { connectCode(want); } catch { /* optional */ }
  if (changed.length) require('../core/audit').log('system', 'claude.connected', { files: changed, command: want.command });
  return { changed, entry: want };
}

/**
 * The Claude app keeps its own preferences in the same file and rewrites it from what it has in memory, which drops our
 * entry when it was added while Claude was running (seen on Ryan's PC: the file had no mcpServers after Claude saved).
 * So each Claude settings folder is watched and the entry is put back a moment after any rewrite; Claude reads the file
 * when it starts, so it then loads the connector, and keeps it from then on. Our own write doesn't loop: an entry that's
 * already right isn't written again.
 */
const watchers = new Map();
function watch() {
  for (const f of desktopConfigs()) {
    const dir = path.dirname(f); if (watchers.has(dir)) continue;
    let t = null;
    try {
      const w = fs.watch(dir, { persistent: false }, (ev, name) => {
        if (name && String(name).toLowerCase() !== 'claude_desktop_config.json') return;
        clearTimeout(t); t = setTimeout(() => { try { const ch = connectDesktop(entry()); if (ch.length) require('../core/audit').log('system', 'claude.reconnected', { files: ch }); } catch { /* next time */ } }, 1500);
      });
      w.on('error', () => { try { w.close(); } catch { /* gone */ } watchers.delete(dir); });
      watchers.set(dir, w);
    } catch { /* folder can't be watched: the 5-minute check covers it */ }
  }
}

/** What's connected, for Settings → Connections → Claude app: each Claude settings file and whether it has us. */
function status() {
  const home = os.homedir();
  const looked = process.platform === 'win32'
    ? [path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Claude')]
    : process.platform === 'darwin' ? [path.join(home, 'Library', 'Application Support', 'Claude')] : [path.join(home, '.config', 'Claude')];
  const want = entry();
  const files = desktopConfigs().map((f) => {
    let cfg = null; let error = null;
    try { cfg = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '') || '{}') : {}; } catch (e) { error = `Can't read it: ${e.message}`; }
    const have = cfg?.mcpServers?.euclidean;
    return { file: f, exists: fs.existsSync(f), connected: !!have && same(have, want), entry: have || null, error };
  });
  return { on: ctx.setting('claude.connect', true) !== false, script: SCRIPT, scriptFound: fs.existsSync(SCRIPT), command: want.command, files, looked, claudeFound: files.length > 0 };
}

module.exports = { ensure, entry, desktopConfigs, status, watch, SCRIPT };
