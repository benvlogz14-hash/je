'use strict';
/** Minimal dependency-free HTTP router with JSON bodies, uploads and ranged file serving. */
const fs = require('fs');
const path = require('path');
const { HttpError } = require('./util');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.ico': 'image/x-icon',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.m4v': 'video/mp4', '.webm': 'video/webm', '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf', '.otf': 'font/otf', '.srt': 'text/plain; charset=utf-8', '.ass': 'text/plain; charset=utf-8',
  '.xml': 'application/xml', '.webmanifest': 'application/manifest+json', '.velo': 'application/json', '.txt': 'text/plain; charset=utf-8',
};

class Router {
  constructor() { this.routes = []; }
  add(method, pattern, handler, opts = {}) {
    const keys = [];
    const rx = new RegExp('^' + pattern.replace(/\//g, '\\/').replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^\\/]+)'; }).replace(/\*$/, '(.*)') + '\\/?$');
    this.routes.push({ method, rx, keys, handler, opts, wildcard: pattern.endsWith('*') });
  }
  get(p, h, o) { this.add('GET', p, h, o); }
  post(p, h, o) { this.add('POST', p, h, o); }
  put(p, h, o) { this.add('PUT', p, h, o); }
  patch(p, h, o) { this.add('PATCH', p, h, o); }
  del(p, h, o) { this.add('DELETE', p, h, o); }
  match(method, pathname) {
    for (const r of this.routes) {
      if (r.method !== method) continue;
      const m = r.rx.exec(pathname);
      if (!m) continue;
      const params = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      if (r.wildcard) params.rest = decodeURIComponent(m[r.keys.length + 1] || '');
      return { route: r, params };
    }
    return null;
  }
}

function readBody(req, limit = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new HttpError(413, 'Request body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function parseBody(req) {
  const ct = req.headers['content-type'] || '';
  if (req.method === 'GET' || req.method === 'HEAD') return {};
  if (ct.startsWith('multipart/form-data')) return null; // handled by route with receiveUpload
  const buf = await readBody(req);
  if (!buf.length) return {};
  if (ct.includes('application/json')) {
    try { return JSON.parse(buf.toString('utf8')); } catch { throw new HttpError(400, 'Malformed JSON'); }
  }
  if (ct.includes('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(buf.toString('utf8')));
  req.rawBody = buf;
  return { raw: buf.toString('utf8') };
}

/** Stream multipart uploads straight to disk (no buffering of large footage in memory). */
function receiveUpload(req, destDir, { maxBytes = 20 * 1024 ** 3, onProgress } = {}) {
  const Busboy = require('busboy');
  return new Promise((resolve, reject) => {
    const bb = Busboy({ headers: req.headers, limits: { fileSize: maxBytes } });
    const files = []; const fields = {}; const pending = [];
    let received = 0; const total = Number(req.headers['content-length'] || 0);
    bb.on('field', (k, v) => { fields[k] = v; });
    bb.on('file', (name, stream, info) => {
      const safe = path.basename(info.filename || 'upload.bin').replace(/[^\w.\- ()]+/g, '_').slice(0, 140) || 'upload.bin';
      let target = path.join(destDir, safe); let n = 1;
      while (fs.existsSync(target)) { const ext = path.extname(safe); target = path.join(destDir, `${path.basename(safe, ext)} (${n++})${ext}`); }
      const out = fs.createWriteStream(target);
      stream.on('data', (d) => { received += d.length; if (onProgress && total) onProgress(received / total); });
      stream.on('limit', () => reject(new HttpError(413, 'File exceeds size limit')));
      stream.pipe(out);
      pending.push(new Promise((r, j) => { out.on('finish', r); out.on('error', j); }));
      files.push({ field: name, path: target, name: safe, mime: info.mimeType });
    });
    bb.on('error', reject);
    bb.on('close', () => Promise.all(pending).then(() => resolve({ files, fields }), reject));
    req.pipe(bb);
  });
}

function send(res, status, body, headers = {}) {
  if (res.headersSent) return;
  const isObj = body !== null && typeof body === 'object' && !Buffer.isBuffer(body);
  const data = isObj ? JSON.stringify(body) : body == null ? '' : body;
  res.writeHead(status, { 'Content-Type': isObj ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(data);
}

/** Serve a file with HTTP Range support so <video> elements can seek. */
function serveFile(req, res, file, { cache = false, download = null } = {}) {
  let st;
  try { st = fs.statSync(file); } catch { return send(res, 404, { error: 'File not found' }); }
  if (!st.isFile()) return send(res, 404, { error: 'Not a file' });
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': cache ? 'max-age=3600' : 'no-cache', 'Last-Modified': st.mtime.toUTCString() };
  if (download) headers['Content-Disposition'] = `attachment; filename="${download.replace(/"/g, '')}"`;
  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    let start = m && m[1] ? parseInt(m[1], 10) : 0;
    let end = m && m[2] ? parseInt(m[2], 10) : st.size - 1;
    if (m && !m[1] && m[2]) { start = st.size - parseInt(m[2], 10); end = st.size - 1; }
    if (start >= st.size || end >= st.size || start > end) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
    if (req.method === 'HEAD') return res.end();
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...headers, 'Content-Length': st.size });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}

function serveStatic(req, res, baseDir, rel) {
  const p = path.normalize(path.join(baseDir, rel || 'index.html'));
  if (!p.startsWith(path.normalize(baseDir))) return send(res, 403, { error: 'Forbidden' });
  let file = p;
  try { if (fs.statSync(file).isDirectory()) file = path.join(file, 'index.html'); } catch { return send(res, 404, { error: 'Not found' }); }
  return serveFile(req, res, file, { cache: false });
}

module.exports = { Router, parseBody, readBody, receiveUpload, send, serveFile, serveStatic, MIME };
