'use strict';
/**
 * Updates Euclidean every time it opens. Before the engine starts, it asks GitHub for the newest version of the
 * working branch; if it's newer than this copy (VERSION.sha), a small "Updating Euclidean" window shows while the new
 * files are downloaded and copied in, then Euclidean restarts into the new version. Your clients, keys and settings
 * live in a separate data folder and are never touched. No internet, GitHub slow, or anything going wrong: it opens
 * the copy you have, as before. Skipped for a developer copy (a git checkout) or when NO-AUTO-UPDATE.txt exists here.
 */
const { BrowserWindow, app } = require('electron');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execFile } = require('child_process');

const REPO = 'benvlogz14-hash/je';
const BRANCH = 'claude/agent-connections-setup-i1v6qt';
const ROOT = path.join(__dirname, '..');
const MARK = path.join(ROOT, 'VERSION.sha');
const SKIP = ['node_modules', '.git', 'tools'];

/** GET with redirects; text back, or saved to `file` with progress (0..1). */
function get(url, { file = null, timeout = 6000, accept = null, onProgress = () => {} } = {}, hops = 0) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Euclidean-updater', ...(accept ? { Accept: accept } : {}) }, timeout }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && hops < 6) { res.resume(); return resolve(get(new URL(res.headers.location, url).toString(), { file, timeout, accept, onProgress }, hops + 1)); }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      const total = Number(res.headers['content-length']) || 0; let got = 0;
      if (file) {
        const out = fs.createWriteStream(file);
        res.on('data', (d) => { got += d.length; if (total) onProgress(got / total); else onProgress(Math.min(0.95, got / 30e6)); });
        res.pipe(out); out.on('finish', () => out.close(() => resolve(file))); out.on('error', reject);
      } else { let s = ''; res.setEncoding('utf8'); res.on('data', (d) => { s += d; }); res.on('end', () => resolve(s)); }
    });
    req.on('timeout', () => req.destroy(new Error('timed out'))); req.on('error', reject);
  });
}

function splash() {
  const w = new BrowserWindow({ width: 400, height: 150, frame: false, resizable: false, center: true, show: true, alwaysOnTop: true, skipTaskbar: false, title: 'Updating Euclidean', backgroundColor: '#ffffff', icon: path.join(ROOT, 'build', process.platform === 'win32' ? 'icon.ico' : 'icon.png'), webPreferences: { contextIsolation: true } });
  const html = `<html><body style="margin:0;font:14px 'Segoe UI',system-ui,sans-serif;background:#fff;color:#1c2024;display:flex;flex-direction:column;justify-content:center;padding:0 26px;height:100vh;box-sizing:border-box;border:1px solid #e4e7eb">
    <b style="font-size:16px">Updating Euclidean</b><div id="s" style="margin:8px 0 12px;color:#5b636b">Getting the newest version...</div>
    <div style="height:6px;background:#eef1f4;border-radius:9px;overflow:hidden"><i id="b" style="display:block;height:100%;width:3%;background:#66bdb4;border-radius:9px;transition:width .2s"></i></div></body></html>`;
  w.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  const set = (text, frac) => { if (w.isDestroyed()) return; w.webContents.executeJavaScript(`document.getElementById('s').textContent=${JSON.stringify(text)};${frac != null ? `document.getElementById('b').style.width='${Math.round(Math.max(0.03, Math.min(1, frac)) * 100)}%'` : ''}`).catch(() => {}); };
  return { set, close: () => { if (!w.isDestroyed()) w.destroy(); } };
}

function unzip(zip, dest) {
  return new Promise((resolve, reject) => {
    const [cmd, args] = process.platform === 'win32'
      ? ['powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `Expand-Archive -LiteralPath '${zip.replace(/'/g, "''")}' -DestinationPath '${dest.replace(/'/g, "''")}' -Force`]]
      : ['unzip', ['-oq', zip, '-d', dest]];
    execFile(cmd, args, { timeout: 300000, windowsHide: true }, (err) => (err ? reject(err) : resolve()));
  });
}

/** Copy every file from the new version over this copy (new and changed files; nothing of yours is deleted). */
function copyOver(src, dest) {
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (SKIP.includes(e.name)) continue;
    const a = path.join(src, e.name), b = path.join(dest, e.name);
    if (e.isDirectory()) { fs.mkdirSync(b, { recursive: true }); copyOver(a, b); } else fs.copyFileSync(a, b);
  }
}

const deps = (dir) => { try { const p = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); return JSON.stringify([p.dependencies || {}, p.devDependencies || {}]); } catch { return ''; } };

/**
 * Returns true when it has started an update and Euclidean is about to restart (the caller should stop starting up),
 * false to carry on opening this copy.
 */
async function checkAndUpdate() {
  if (process.env.EUCLIDEAN_NO_UPDATE || fs.existsSync(path.join(ROOT, '.git')) || fs.existsSync(path.join(ROOT, 'NO-AUTO-UPDATE.txt'))) return false;
  let latest;
  try { latest = String(await get(`https://api.github.com/repos/${REPO}/commits/${encodeURIComponent(BRANCH)}`, { accept: 'application/vnd.github.sha', timeout: 5000 })).trim(); } catch { return false; }
  if (!/^[0-9a-f]{40}$/.test(latest)) return false;
  let have = ''; try { have = fs.readFileSync(MARK, 'utf8').trim(); } catch { /* first run of the updater */ }
  if (have === latest) return false;

  const ui = splash(); const work = fs.mkdtempSync(path.join(os.tmpdir(), 'euclidean-update-'));
  try {
    const zip = path.join(work, 'new.zip');
    await get(`https://codeload.github.com/${REPO}/zip/${latest}`, { file: zip, timeout: 30000, onProgress: (f) => ui.set(`Downloading... ${Math.round(f * 100)}%`, f * 0.75) });
    ui.set('Unpacking...', 0.8); const out = path.join(work, 'x'); await unzip(zip, out);
    const top = fs.readdirSync(out).map((n) => path.join(out, n)).find((p) => fs.statSync(p).isDirectory());
    if (!top || !fs.existsSync(path.join(top, 'app', 'main.js'))) throw new Error('The download was incomplete');
    const needInstall = deps(top) !== deps(ROOT);
    ui.set('Installing...', 0.9); copyOver(top, ROOT);
    fs.writeFileSync(MARK, latest + '\n');
    const d = new Date(); fs.writeFileSync(path.join(ROOT, 'BUILD.txt'), `${d.toLocaleDateString()} ${d.toTimeString().slice(0, 5)}\r\n`);
    try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* temp folder */ }
    if (needInstall && process.platform === 'win32') {
      // New parts to install (npm), which can't happen while Euclidean is open: close, install, reopen by itself.
      ui.set('Installing new parts. Euclidean reopens by itself in a minute...', 0.97);
      const cmd = `timeout /t 3 /nobreak >nul & cd /d "${ROOT}" & npm install --no-audit --no-fund & start "" "${process.execPath}" "${ROOT}"`;
      spawn('cmd', ['/c', cmd], { detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, PATH: `${process.env.PATH};${process.env.ProgramFiles}\\nodejs;${process.env.APPDATA}\\npm` } }).unref();
      setTimeout(() => app.exit(0), 1500);
      return true;
    }
    ui.set('Done. Restarting...', 1);
    setTimeout(() => { app.relaunch(); app.exit(0); }, 600);
    return true;
  } catch (e) {
    ui.close(); try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* temp folder */ }
    return false; // open the copy we have
  }
}

module.exports = { checkAndUpdate, _test: { unzip, copyOver, deps, get } };
