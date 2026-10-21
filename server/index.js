'use strict';
/**
 * Euclidean engine. Runs inside the desktop app, or headless on an always-on
 * machine:  node server/index.js [--data <dir>] [--port 4870] [--lan]
 */
const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');
const paths = require('./core/paths');
const ctx = require('./core/ctx');
const { Store, deepMerge } = require('./core/store');
const secrets = require('./core/secrets');
const audit = require('./core/audit');
const events = require('./core/events');
const defaults = require('./core/defaults');
const { parseBody, send, serveStatic } = require('./core/http');
const { HttpError, id: makeId } = require('./core/util');

const RENDERER = path.join(__dirname, '..', 'renderer');

function lanAddress() {
  for (const list of Object.values(os.networkInterfaces())) for (const i of list || []) if (i.family === 'IPv4' && !i.internal) return i.address;
  return null;
}

function seed() {
  const s = ctx.store;
  // Fill in any settings added in newer versions without touching user choices.
  const merged = deepMerge(JSON.parse(JSON.stringify(defaults)), s.settings);
  s.data.settings = merged; s.touch();
  if (!s.all('users').length) {
    s.insert('users', { id: 'ryan', name: 'Ryan Rosario', role: 'owner', token: 'eu_' + require('crypto').randomBytes(24).toString('base64url') });
    s.insert('users', { id: 'ben', name: 'Ben Gingold', role: 'owner', token: 'eu_' + require('crypto').randomBytes(24).toString('base64url') });
  }
  require('./automation/messaging').commandConversation();
}

/**
 * @param opts.dataDir, opts.port, opts.lan, opts.sealer (Electron safeStorage), opts.electron hooks
 */
async function start(opts = {}) {
  if (opts.dataDir) paths.setRoot(opts.dataDir); else paths.ensure();
  if (opts.sealer) secrets.setSealer(opts.sealer);
  secrets.load();
  audit.loadRecent();
  ctx.store = new Store(paths.db());
  seed();
  Object.assign(ctx, opts.hooks || {});
  ctx.electron = !!opts.electron;
  ctx.startedAt = new Date().toISOString();

  // Detect tools before the queue starts so handlers know what is available.
  const ff = require('./video/ffmpeg');
  Object.assign(ctx.capabilities, await ff.detect());
  ctx.capabilities.faceTracking = await require('./video/facetrack').available();
  require('./video/render').ensureFonts();

  const queue = require('./jobs/queue');
  require('./jobs/handlers');
  const resources = require('./automation/resources');
  queue.setGate(resources.heavyGate);
  if (ctx.store.settings._paused) queue.setPaused(true);
  if (ctx.setting('resources.mode') === 'background' && !opts.electron) ctx.store.setSettings({ resources: { mode: 'full' } });

  const api = require('./api');
  const portal = require('./portal');
  const messaging = require('./automation/messaging');
  const twilio = require('./integrations/twilio');

  const port = opts.port ?? ctx.setting('server.port', 4870);
  const lan = opts.lan ?? ctx.setting('server.lan', false);
  ctx.lanAddress = lan ? lanAddress() : null;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    req.query = Object.fromEntries(url.searchParams);
    const pathname = url.pathname;
    res.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      if (pathname === '/' || pathname === '/index.html') return serveStatic(req, res, RENDERER, 'index.html');
      if (pathname.startsWith('/ui/')) return serveStatic(req, res, RENDERER, pathname.slice(4));
      if (pathname === '/favicon.ico') return serveStatic(req, res, RENDERER, 'assets/icon.png');

      // Twilio webhook (only useful when the engine is publicly reachable; polling works without it).
      if (pathname === '/webhooks/twilio' && req.method === 'POST') {
        const body = await parseBody(req);
        const publicUrl = ctx.setting('server.publicUrl', '');
        if (!publicUrl || !twilio.validSignature(publicUrl.replace(/\/$/, '') + '/webhooks/twilio', body, req.headers['x-twilio-signature'])) return send(res, 403, 'Invalid signature');
        messaging.receive({ channel: 'sms', providerId: body.MessageSid, from: body.From, body: body.Body, at: new Date().toISOString() });
        return send(res, 200, '<Response></Response>', { 'Content-Type': 'text/xml' });
      }

      const routers = pathname.startsWith('/portal/') ? [portal.router] : [api.router];
      let m = null; for (const rt of routers) { m = rt.match(req.method, pathname); if (m) break; }

      if (pathname === '/events') {
        const user = authenticate(req, url);
        if (!user || !['owner', 'contractor'].includes(user.role)) return send(res, 401, { error: 'Unauthorized' });
        req.user = user; return events.attach(req, res);
      }
      if (!m) return send(res, 404, { error: 'Not found' });

      if (!pathname.startsWith('/portal/')) {
        const user = authenticate(req, url);
        if (!user) return send(res, 401, { error: 'Unauthorized: missing or invalid token' });
        const roles = m.route.opts.roles || ['owner', 'contractor'];
        if (user.role !== 'owner' && !roles.includes(user.role)) return send(res, 403, { error: `Your role (${user.role}) cannot do this` });
        req.user = user;
      }
      if (m.route.opts.stream) return await m.route.handler(req, res, m.params);
      const body = m.route.opts.raw ? null : await parseBody(req);
      const out = await m.route.handler(req, body, m.params);
      if (!res.headersSent) send(res, 200, out === undefined ? { ok: true } : out);
    } catch (e) {
      const status = e.status || 500;
      if (status >= 500) console.error('[api]', req.method, pathname, e);
      if (!res.headersSent) send(res, status, { error: e.message || 'Server error', ...(e.extra || {}) });
    }
  });

  function authenticate(req, url) {
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : (url.searchParams.get('token') || req.headers['x-euclidean-token']);
    if (!token) return null;
    return ctx.store.find('users', (u) => u.token === token) || null;
  }

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, lan ? '0.0.0.0' : '127.0.0.1', resolve);
  });
  ctx.server = server;
  ctx.port = server.address().port;

  queue.start();
  resources.start();
  require('./automation/health').start();
  require('./automation/scheduler').start();
  messaging.startPollers();
  require('./agents/broker').start();
  setTimeout(() => { require('./setup/ollama').autostart().catch(() => {}); }, 3000);
  audit.log('system', 'engine.started', { version: ctx.version, port: ctx.port, lan: !!lan, host: os.hostname() });
  console.log(`[euclidean] engine ${ctx.version} on http://${lan ? (ctx.lanAddress || '0.0.0.0') : '127.0.0.1'}:${ctx.port} · data ${paths.root}`);
  return { port: ctx.port, ownerToken: ctx.store.get('users', 'ryan')?.token, store: ctx.store };
}

async function stop() {
  try { require('./jobs/queue').stop(); } catch { /* not started */ }
  try { ctx.store.flush(); } catch { /* ignore */ }
  if (ctx.server) await new Promise((r) => ctx.server.close(r));
}

if (require.main === module) {
  const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
  start({ dataDir: arg('--data'), port: arg('--port') ? Number(arg('--port')) : undefined, lan: process.argv.includes('--lan') ? true : undefined })
    .then((r) => {
      const u = ctx.store.all('users', (x) => x.role === 'owner');
      console.log(`[euclidean] open http://127.0.0.1:${r.port}/?token=${u[0].token}`);
    })
    .catch((e) => { console.error('[euclidean] failed to start:', e.message); process.exit(1); });
  const shutdown = () => { stop().then(() => process.exit(0)); };
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
}

module.exports = { start, stop, ctx };
