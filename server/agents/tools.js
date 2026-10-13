'use strict';
/**
 * Local tool discovery, installation and launching for terminal agents and Herdr.
 * Goal: the person never edits PATH or config files. Tools are found wherever
 * they already are, or installed into Euclidean's own data folder
 * (<data>/tools), and their location is remembered in settings.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const paths = require('../core/paths');

const WIN = process.platform === 'win32';

function toolsDir(...sub) { const p = path.join(paths.root, 'tools', ...sub); fs.mkdirSync(p, { recursive: true }); return p; }
function npmPrefix() { return toolsDir('npm'); }

function isFile(p) { try { return fs.statSync(p).isFile(); } catch { return false; } }

/** Common places installers put things, so we find tools even when PATH was never refreshed. */
function commonDirs() {
  const home = os.homedir();
  const dirs = [
    path.join(npmPrefix(), 'node_modules', '.bin'), npmPrefix(), toolsDir('bin'), toolsDir('herdr'),
    process.resourcesPath ? path.join(process.resourcesPath, 'bin') : null,
    process.resourcesPath ? path.join(process.resourcesPath, 'bin', 'herdr') : null,
    path.join(home, '.herdr', 'bin'), path.join(home, '.herdr'), path.join(home, '.local', 'bin'), path.join(home, '.cursor', 'bin'),
    path.join(home, '.opencode', 'bin'), path.join(home, '.claude', 'local'), path.join(home, '.npm-global', 'bin'), path.join(home, 'bin'),
  ];
  if (WIN) {
    const ad = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    const la = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    dirs.push(path.join(ad, 'npm'), path.join(la, 'Programs', 'herdr'), path.join(la, 'herdr'), path.join(la, 'cursor-agent'), path.join(la, 'Programs', 'cursor-agent'),
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs'), path.join(la, 'Microsoft', 'WinGet', 'Links'));
  } else {
    dirs.push('/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/snap/bin');
  }
  return dirs.filter(Boolean);
}

/**
 * Find an executable by any of its names. Checks a remembered path first, then
 * Euclidean's tools folder, common install folders and finally PATH.
 */
function findExecutable(names, { preferred, extraDirs = [] } = {}) {
  if (preferred && isFile(preferred)) return preferred;
  const exts = WIN ? ['.exe', '.cmd', '.bat', ''] : [''];
  const pathDirs = (process.env.PATH || process.env.Path || '').split(path.delimiter).filter(Boolean);
  for (const dir of [...extraDirs, ...commonDirs(), ...pathDirs]) {
    for (const n of names) for (const e of exts) { const p = path.join(dir, n + e); if (isFile(p)) return p; }
  }
  return null;
}

function findNode() {
  return findExecutable(['node']);
}

/** npm's JavaScript entry next to a Node install, so we never depend on npm.cmd or PATH. */
function findNpmCli(nodePath) {
  if (!nodePath) return null;
  const d = path.dirname(nodePath);
  for (const p of [path.join(d, 'node_modules', 'npm', 'bin', 'npm-cli.js'), path.join(d, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'), path.join(d, '..', 'node_modules', 'npm', 'bin', 'npm-cli.js')]) if (isFile(p)) return path.resolve(p);
  return null;
}

/** How to run a JavaScript file: with a real Node if present, otherwise with Electron acting as Node. */
function nodeRunner() {
  const n = findNode();
  if (n) return { cmd: n, env: {} };
  return { cmd: process.execPath, env: process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {} };
}

/**
 * Turn an executable path + args into something spawn() can run without a shell.
 * Windows .cmd shims (npm installs) are resolved to the JavaScript file they wrap,
 * which avoids every cmd.exe quoting problem with long prompts.
 */
function launchSpec(bin, args) {
  const ext = path.extname(bin).toLowerCase();
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') { const r = nodeRunner(); return { cmd: r.cmd, args: [bin, ...args], env: r.env }; }
  if (ext === '.cmd' || ext === '.bat') {
    let js = null;
    try {
      const shim = fs.readFileSync(bin, 'utf8');
      const m = /"%(?:~?dp0%?|dp0%)\\?([^"]+?\.(?:c|m)?js)"/i.exec(shim) || /(node_modules\\[^"\s]+?\.(?:c|m)?js)/i.exec(shim);
      if (m) { const rel = m[1].replace(/^\\/, ''); const cand = path.resolve(path.dirname(bin), rel); if (isFile(cand)) js = cand; }
    } catch { /* fall through to cmd.exe */ }
    if (js) { const r = nodeRunner(); return { cmd: r.cmd, args: [js, ...args], env: r.env }; }
    const quote = (a) => (/[\s"&|<>^%]/.test(a) ? `"${String(a).replace(/"/g, '""').replace(/%/g, '%%')}"` : a);
    return { cmd: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', `"${[bin, ...args].map(quote).join(' ')}"`], env: {}, verbatim: true };
  }
  return { cmd: bin, args, env: {} };
}

/** Run a tool, capture output, optionally write to stdin. Errors are rewritten into plain English. */
function exec(bin, args = [], { input, timeoutMs = 120000, cwd, env, signal } = {}) {
  const spec = launchSpec(bin, args);
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(spec.cmd, spec.args, { cwd: cwd || os.homedir(), windowsHide: true, windowsVerbatimArguments: !!spec.verbatim, env: { ...process.env, ...spec.env, ...(env || {}) } });
    } catch (e) { return reject(friendly(e, bin)); }
    let out = '', err = '', timedOut = false;
    const timer = setTimeout(() => { timedOut = true; try { child.kill('SIGKILL'); } catch { /* gone */ } }, timeoutMs);
    const abort = () => { try { child.kill('SIGKILL'); } catch { /* gone */ } };
    if (signal) signal.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (d) => { out += d; if (out.length > 4e6) out = out.slice(-2e6); });
    child.stderr.on('data', (d) => { err += d; if (err.length > 1e6) err = err.slice(-5e5); });
    child.on('error', (e) => { clearTimeout(timer); reject(friendly(e, bin)); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', abort);
      if (timedOut) return reject(Object.assign(new Error(`${path.basename(bin)} did not finish within ${Math.round(timeoutMs / 1000)} seconds.`), { timeout: true, out, err }));
      if (code === 0) return resolve({ out, err, code });
      const tail = (err || out).split(/\r?\n/).filter(Boolean).slice(-3).join(' ').slice(0, 400);
      reject(Object.assign(new Error(`${path.basename(bin)} stopped with an error${tail ? `: ${tail}` : ` (code ${code})`}`), { out, err, code }));
    });
    if (input != null) { child.stdin.on('error', () => {}); child.stdin.end(String(input)); } else child.stdin.end();
  });
}

function friendly(e, bin) {
  const name = path.basename(String(bin || 'the program'));
  if (e.code === 'ENOENT') return Object.assign(new Error(`${name} isn't installed on this computer (or was moved). Click Install or "Configure automatically".`), { code: 'ENOENT' });
  if (e.code === 'EACCES' || e.code === 'EPERM') return Object.assign(new Error(`Windows blocked ${name} from running. Right-click it, choose Properties and tick "Unblock", or reinstall it from here.`), { code: e.code });
  if (e.code === 'EINVAL') return Object.assign(new Error(`${name} couldn't be started directly. Click "Configure automatically" to fix it.`), { code: e.code });
  return e;
}

/**
 * Install an npm package into Euclidean's own tools folder (no admin rights, no PATH changes).
 * Returns the path of the installed command.
 */
async function npmInstall(pkg, binNames) {
  const node = findNode();
  const npmCli = findNpmCli(node);
  if (!node || !npmCli) {
    const err = new Error('This agent is installed with Node.js, which isn\'t on this computer yet. Click "Install Node.js", then try again.');
    err.needsNode = true; throw err;
  }
  await exec(node, [npmCli, 'install', '--prefix', npmPrefix(), '--no-audit', '--no-fund', '--loglevel', 'error', pkg], { timeoutMs: 15 * 60000, cwd: npmPrefix() })
    .catch((e) => { throw new Error(/ENOTFOUND|ETIMEDOUT|ECONNRESET|network/i.test(e.message) ? 'The download failed. Check the internet connection and try again.' : /EACCES|EPERM/.test(e.message) ? 'Windows blocked the install folder. Close other copies of Euclidean and try again.' : `The install didn't finish. ${e.message}`); });
  const bin = findExecutable(binNames, { extraDirs: [path.join(npmPrefix(), 'node_modules', '.bin')] });
  if (!bin) throw new Error(`${pkg} was downloaded, but its command wasn't found afterwards. Try "Configure automatically".`);
  return bin;
}

/** One-click Node.js install (needed by npm-based agents). */
async function installNode() {
  if (findNode()) return { ok: true, already: true };
  if (WIN) {
    const winget = findExecutable(['winget']);
    if (!winget) throw new Error('Windows couldn\'t install Node.js automatically (App Installer is missing). Install "Node.js LTS" from nodejs.org, then click "Configure automatically".');
    await exec(winget, ['install', '-e', '--id', 'OpenJS.NodeJS.LTS', '--accept-package-agreements', '--accept-source-agreements', '--silent'], { timeoutMs: 20 * 60000 });
  } else if (process.platform === 'darwin') {
    const brew = findExecutable(['brew']);
    if (!brew) throw new Error('Install "Node.js LTS" from nodejs.org, then click "Configure automatically".');
    await exec(brew, ['install', 'node'], { timeoutMs: 20 * 60000 });
  } else throw new Error('Install Node.js with your package manager (for example: sudo apt install nodejs npm), then click "Configure automatically".');
  if (!findNode()) throw new Error('Node.js was installed. Restart Euclidean once so it can be found.');
  return { ok: true };
}

/** Run an official install script (used for Cursor's CLI, which isn't on npm). */
async function runInstallScript({ windows, unix }) {
  if (WIN) {
    const ps = findExecutable(['powershell', 'pwsh']) || 'powershell.exe';
    return exec(ps, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', windows], { timeoutMs: 15 * 60000 });
  }
  return exec('/bin/sh', ['-c', unix], { timeoutMs: 15 * 60000 });
}

/** Download to a file (Node's fetch; follows redirects). */
async function download(url, dest) {
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(10 * 60000) }).catch((e) => { throw new Error(`Couldn't reach ${new URL(url).host}. Check the internet connection. (${e.message})`); });
  if (!res.ok) throw new Error(`The download failed (${res.status} from ${new URL(url).host}).`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, buf);
  return buf;
}

/** Unzip with what the OS already has (PowerShell on Windows, unzip/tar elsewhere). */
async function unzip(zip, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  if (WIN) {
    const ps = findExecutable(['powershell', 'pwsh']) || 'powershell.exe';
    await exec(ps, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `Expand-Archive -LiteralPath '${zip.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`], { timeoutMs: 5 * 60000 });
  } else if (/\.(tar\.gz|tgz)$/i.test(zip)) await exec('tar', ['-xzf', zip, '-C', destDir]);
  else { const u = findExecutable(['unzip']); if (u) await exec(u, ['-o', zip, '-d', destDir]); else await exec('tar', ['-xf', zip, '-C', destDir]); }
}

module.exports = { WIN, toolsDir, npmPrefix, findExecutable, findNode, launchSpec, exec, npmInstall, installNode, runInstallScript, download, unzip };
