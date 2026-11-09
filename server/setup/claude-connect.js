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

// ------------------------------------------------------------------ the drag-in file (Claude extension, .mcpb)
/**
 * A Claude extension file (MCP Bundle: a zip with manifest.json and the connector), made from this app's own copy of
 * the connector, so it always matches the version installed. Dragged onto Claude → Settings → Extensions (or the
 * "Drag .MCPB or .DXT files here" box) it installs without any settings file; Claude runs it with its own built-in Node,
 * so nothing else is needed. Written to <data>/Euclidean.mcpb (and again when the connector changes).
 */
const zlib = require('zlib');
const CRC = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
function crc32(buf) { let c = -1; for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; }
/** A plain zip (deflate) of [{ name, data }]. */
function zip(files) {
  const parts = []; const central = []; let off = 0;
  for (const f of files) {
    const name = Buffer.from(f.name); const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data); const comp = zlib.deflateRawSync(data); const crc = crc32(data);
    const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt16LE(8, 8); h.writeUInt16LE(0, 10); h.writeUInt16LE(0x21, 12);
    h.writeUInt32LE(crc, 14); h.writeUInt32LE(comp.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(name.length, 26); h.writeUInt16LE(0, 28);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(8, 10); c.writeUInt16LE(0, 12); c.writeUInt16LE(0x21, 14);
    c.writeUInt32LE(crc, 16); c.writeUInt32LE(comp.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(name.length, 28); c.writeUInt32LE(0, 30); c.writeUInt32LE(0, 34); c.writeUInt32LE(0, 38); c.writeUInt32LE(off, 42);
    parts.push(h, name, comp); central.push(c, name); off += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(central); const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cd, end]);
}
function manifest() {
  const src = fs.readFileSync(SCRIPT, 'utf8');
  const tools = [...src.matchAll(/\{ name: '([a-z_]+)', description: (["'])(.*?)\2/g)].map((m) => ({ name: m[1], description: m[3].replace(/\\'/g, "'") }));
  const version = '1.2.0'; // raise when the extension itself changes (the tools come from the app's own copy anyway)
  return {
    manifest_version: '0.3', name: 'euclidean', display_name: 'Euclidean', version,
    description: "Check Euclidean's jobs, candidates and ad runs, and start Make the ads. It can't approve, send or post anything.",
    long_description: 'Connects Claude to the Euclidean app running on this PC. Keep Euclidean open while you use it.',
    author: { name: 'Euclidean Media' }, icon: 'icon.png',
    server: { type: 'node', entry_point: 'server/euclidean-mcp.js', mcp_config: { command: 'node', args: ['${__dirname}/server/euclidean-mcp.js'], env: {} } },
    tools, compatibility: { platforms: ['win32', 'darwin', 'linux'], runtimes: { node: '>=18.0.0' } }, license: 'UNLICENSED',
  };
}
function bundle() {
  if (!fs.existsSync(SCRIPT)) return null;
  const out = path.join(require('../core/paths').root || os.tmpdir(), 'Euclidean.mcpb');
  const files = [{ name: 'manifest.json', data: JSON.stringify(manifest(), null, 2) }, { name: 'server/euclidean-mcp.js', data: fs.readFileSync(SCRIPT) }];
  const icon = path.join(__dirname, '..', '..', 'build', 'icon.png'); if (fs.existsSync(icon)) files.push({ name: 'icon.png', data: fs.readFileSync(icon) });
  const buf = zip(files);
  try { if (fs.existsSync(out) && fs.readFileSync(out).equals(buf)) return out; } catch { /* rewrite */ }
  fs.writeFileSync(out, buf); return out;
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
  let ext = null; try { ext = bundle(); } catch { /* shown as missing */ }
  return { on: ctx.setting('claude.connect', true) !== false, extension: ext, script: SCRIPT, scriptFound: fs.existsSync(SCRIPT), command: want.command, files, looked, claudeFound: files.length > 0 };
}

module.exports = { ensure, entry, desktopConfigs, status, watch, bundle, manifest, zip, SCRIPT };
