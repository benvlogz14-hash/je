'use strict';
const crypto = require('crypto');
const { spawn } = require('child_process');

const id = (prefix = '') => prefix + crypto.randomBytes(9).toString('base64url');
const now = () => new Date().toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function safeJson(text, fallback = null) {
  if (text == null) return fallback;
  try { return JSON.parse(text); } catch { /* fall through */ }
  // Models sometimes wrap JSON in prose or code fences; take the outermost object.
  const s = String(text);
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(s.slice(a, b + 1)); } catch { /* ignore */ } }
  const c = s.indexOf('['), d = s.lastIndexOf(']');
  if (c >= 0 && d > c) { try { return JSON.parse(s.slice(c, d + 1)); } catch { /* ignore */ } }
  return fallback;
}

/** Run a process, collect output, optional progress callback per stdout line. */
function run(cmd, args, { cwd, onLine, onStderrLine, timeoutMs, priority, signal } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawn(cmd, args, { cwd, windowsHide: true }); }
    catch (e) { return reject(e); }
    if (priority != null) { try { require('os').setPriority(child.pid, priority); } catch { /* not permitted */ } }
    let out = '', err = '', bufO = '', bufE = '';
    const timer = timeoutMs ? setTimeout(() => { child.kill('SIGKILL'); }, timeoutMs) : null;
    const abort = () => child.kill('SIGKILL');
    if (signal) signal.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (d) => {
      const s = d.toString(); out += s; if (out.length > 4e6) out = out.slice(-2e6);
      if (onLine) { bufO += s; let i; while ((i = bufO.indexOf('\n')) >= 0) { onLine(bufO.slice(0, i).trim()); bufO = bufO.slice(i + 1); } }
    });
    child.stderr.on('data', (d) => {
      const s = d.toString(); err += s; if (err.length > 4e6) err = err.slice(-2e6);
      if (onStderrLine) { bufE += s; let i; while ((i = bufE.search(/[\r\n]/)) >= 0) { onStderrLine(bufE.slice(0, i).trim()); bufE = bufE.slice(i + 1); } }
    });
    child.on('error', (e) => { if (timer) clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', abort);
      if (signal && signal.aborted) return reject(Object.assign(new Error('Canceled'), { canceled: true }));
      if (code === 0) resolve({ out, err, code });
      else reject(Object.assign(new Error(`${cmd} exited with code ${code}: ${err.split('\n').filter(Boolean).slice(-4).join(' | ')}`), { out, err, code }));
    });
  });
}

/** Check whether an executable exists by running it with a harmless flag. */
async function which(cmd, args = ['-version']) {
  try { await run(cmd, args, { timeoutMs: 8000 }); return true; } catch (e) { return e.code !== 'ENOENT' && !/ENOENT/.test(e.message); }
}

function fmtDuration(sec) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

function slug(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'item'; }

function monthKey(d = new Date()) { return d.toISOString().slice(0, 7); }

class HttpError extends Error { constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; } }

module.exports = { id, now, sleep, clamp, safeJson, run, which, fmtDuration, slug, monthKey, HttpError };
