// API client for the local engine, with live server-sent events.
// A demo backend with the same interface can be swapped in (interactive example build).

let token = null;
const listeners = new Map(); // type -> Set(fn)
let backend = null;

const PHONE = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) || (navigator.standalone === true);
function readToken() {
  if (window.euclidean?.token) return window.euclidean.token;
  const u = new URL(location.href);
  const t = u.searchParams.get('token');
  if (t) {
    try { sessionStorage.setItem('eu.token', t); if (PHONE) localStorage.setItem('eu.token', t); } catch { /* ignore */ }
    // On a phone the sign-in link stays in the address so "Add to Home Screen" keeps it; elsewhere it's hidden.
    if (!PHONE) { u.searchParams.delete('token'); history.replaceState(null, '', u.pathname + u.search + u.hash); }
    return t;
  }
  try { return sessionStorage.getItem('eu.token') || (PHONE ? localStorage.getItem('eu.token') : null); } catch { return null; }
}

export class ApiError extends Error { constructor(msg, status) { super(msg); this.status = status; } }

const real = {
  async request(method, path, body) {
    const res = await fetch(path, { method, headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!res.ok) throw new ApiError(data?.error || `Request failed (${res.status})`, res.status);
    return data;
  },
  upload(path, files, fields = {}, onProgress) {
    return new Promise((resolve, reject) => {
      const fd = new FormData();
      for (const [k, v] of Object.entries(fields)) fd.append(k, v);
      for (const f of files) fd.append('file', f, f.name);
      const x = new XMLHttpRequest();
      x.open('POST', path); x.setRequestHeader('authorization', `Bearer ${token}`);
      x.upload.onprogress = (e) => { if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total); };
      x.onload = () => { let d; try { d = JSON.parse(x.responseText); } catch { d = x.responseText; } x.status < 300 ? resolve(d) : reject(new ApiError(d?.error || `Upload failed (${x.status})`, x.status)); };
      x.onerror = () => reject(new ApiError('Upload failed: connection lost', 0));
      x.send(fd);
    });
  },
  url(path) { return path + (path.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token); },
  connect() {
    let es; let retry = 1000;
    const open = () => {
      es = new EventSource(`/events?token=${encodeURIComponent(token)}`);
      es.onopen = () => { retry = 1000; emit('connection', { online: true }); };
      es.onmessage = (e) => { try { for (const it of JSON.parse(e.data)) emit(it.type, it.payload); } catch { /* malformed frame */ } };
      es.onerror = () => { emit('connection', { online: false }); es.close(); setTimeout(open, retry); retry = Math.min(15000, retry * 1.6); };
    };
    open();
  },
};

function emit(type, payload) {
  for (const fn of listeners.get(type) || []) { try { fn(payload); } catch (e) { console.error(e); } }
  for (const fn of listeners.get('*') || []) { try { fn(type, payload); } catch (e) { console.error(e); } }
}

export const api = {
  init(demoBackend) {
    backend = demoBackend || real;
    if (!demoBackend) token = readToken();
    if (backend.setEmitter) backend.setEmitter(emit);
    backend.connect();
    return !!(demoBackend || token);
  },
  get: (p) => backend.request('GET', p),
  post: (p, b = {}) => backend.request('POST', p, b),
  patch: (p, b = {}) => backend.request('PATCH', p, b),
  put: (p, b = {}) => backend.request('PUT', p, b),
  del: (p) => backend.request('DELETE', p),
  upload: (p, files, fields, onProgress) => backend.upload(p, files, fields, onProgress),
  url: (p) => backend.url(p),
  on(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); return () => listeners.get(type).delete(fn); },
  emit,
  get demo() { return backend !== real; },
};
