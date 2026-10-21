'use strict';
/**
 * Background removal for candidate photos, so ads can place a clean cut-out
 * over the campaign colours. Uses remove.bg when its key is saved (best
 * quality), else the free local `rembg` tool if installed, else nothing (the
 * ads fall back to the full photo).
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const secrets = require('../core/secrets');
const { run } = require('../core/util');

const KEY = 'global.removebg.apiKey';

function rembgPath() {
  const names = process.platform === 'win32' ? ['rembg.exe'] : ['rembg'];
  const dirs = (process.env.PATH || process.env.Path || '').split(path.delimiter).filter(Boolean);
  if (process.platform === 'win32') {
    const la = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'); const ap = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    for (const base of [path.join(la, 'Programs', 'Python'), path.join(ap, 'Python')]) { try { for (const v of fs.readdirSync(base)) dirs.push(path.join(base, v, 'Scripts')); } catch { /* none */ } }
  } else dirs.push(path.join(os.homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin');
  for (const d of dirs) for (const n of names) { const p = path.join(d, n); if (fs.existsSync(p)) return p; }
  return null;
}

function available() { return secrets.has(KEY) ? 'remove.bg' : rembgPath() ? 'rembg' : null; }

/** Returns the output path, or null when no remover is set up or it failed. */
async function removeBackground(input, output) {
  if (!input || !fs.existsSync(input)) return null;
  if (secrets.has(KEY)) {
    const form = new FormData();
    form.append('image_file', new Blob([fs.readFileSync(input)]), path.basename(input));
    form.append('size', 'auto'); form.append('type', 'person'); form.append('format', 'png');
    const res = await fetch('https://api.remove.bg/v1.0/removebg', { method: 'POST', headers: { 'X-Api-Key': secrets.get(KEY) }, body: form, signal: AbortSignal.timeout(60000) });
    if (!res.ok) throw new Error(`remove.bg ${res.status}: ${(await res.text()).slice(0, 160)}`);
    fs.writeFileSync(output, Buffer.from(await res.arrayBuffer()));
    return output;
  }
  const bin = rembgPath(); if (!bin) return null;
  await run(bin, ['i', '-m', 'u2net_human_seg', input, output], { timeoutMs: 180000 });
  return fs.existsSync(output) ? output : null;
}

module.exports = { KEY, available, removeBackground, rembgPath };
