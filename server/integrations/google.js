'use strict';
/**
 * The founders' own Google account (Nov 15: the Calendar page syncs with their Google / Gmail calendar). Uses the same
 * Google OAuth client as YouTube direct upload (Settings → Connections → Google: an OAuth client of type Desktop app),
 * the installed-app sign-in: a one-off page on this PC (127.0.0.1) receives Google's answer, with PKCE, so no secret
 * travels through the browser. The login is kept in the encrypted secrets store under its own key.
 */
const http = require('http');
const crypto = require('crypto');
const secrets = require('../core/secrets');

const G_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const G_TOKEN = 'https://oauth2.googleapis.com/token';

const configured = () => secrets.has('global.google.clientId') && secrets.has('global.google.clientSecret');
const form = (o) => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(o), signal: AbortSignal.timeout(20000) });

/**
 * Start a sign-in. Resolves with the Google page to open; `onDone(error|null)` runs when it finishes (or is given up
 * after 10 minutes). The login is saved under `key`.
 */
function beginAuth({ key, scopes, label = 'Google', onDone = () => {} }) {
  if (!configured()) throw Object.assign(new Error('Add your Google OAuth client first: Settings → Connections → Google (the same one YouTube uses).'), { status: 400 });
  return new Promise((resolve, reject) => {
    const state = crypto.randomBytes(12).toString('hex');
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    let done = false; const finish = (err) => { if (done) return; done = true; try { srv.close(); } catch { /* closed */ } onDone(err); };
    const srv = http.createServer(async (req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      if (u.pathname !== '/callback') { res.writeHead(404); return res.end(); }
      const ok = u.searchParams.get('state') === state && u.searchParams.get('code');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<body style="font:15px system-ui;padding:40px;color:#333">${ok ? `${label} connected. You can close this tab and go back to Euclidean.` : 'Google didn\'t connect. Go back to Euclidean and try again.'}</body>`);
      if (!ok) return finish(new Error(u.searchParams.get('error') === 'access_denied' ? 'You said no on Google\'s page.' : 'Google didn\'t connect.'));
      try {
        const r = await fetch(G_TOKEN, form({ code: u.searchParams.get('code'), client_id: secrets.get('global.google.clientId'), client_secret: secrets.get('global.google.clientSecret'), redirect_uri: `http://127.0.0.1:${srv.address().port}/callback`, grant_type: 'authorization_code', code_verifier: verifier }));
        const j = await r.json();
        if (!r.ok) throw new Error(j.error_description || j.error || `HTTP ${r.status}`);
        secrets.set(key, { ...j, obtainedAt: Date.now() });
        finish(null);
      } catch (e) { finish(e); }
    });
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      setTimeout(() => finish(new Error('Google sign-in timed out. Try again.')), 10 * 60 * 1000).unref?.();
      resolve(`${G_AUTH}?${new URLSearchParams({ client_id: secrets.get('global.google.clientId'), redirect_uri: `http://127.0.0.1:${port}/callback`, response_type: 'code', scope: scopes.join(' '), access_type: 'offline', prompt: 'consent', state, code_challenge: challenge, code_challenge_method: 'S256' })}`);
    });
  });
}

/** A current access token for the login saved under `key` (refreshed when it's about to run out). */
async function accessToken(key) {
  const t = secrets.get(key);
  if (!t) throw Object.assign(new Error('Google isn\'t connected.'), { notConnected: true });
  if (t.access_token && Date.now() < t.obtainedAt + ((t.expires_in || 3600) - 120) * 1000) return t.access_token;
  if (!t.refresh_token) throw Object.assign(new Error('The Google login ran out. Connect Google again.'), { notConnected: true });
  const r = await fetch(G_TOKEN, form({ client_id: secrets.get('global.google.clientId'), client_secret: secrets.get('global.google.clientSecret'), refresh_token: t.refresh_token, grant_type: 'refresh_token' }));
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error === 'invalid_grant' ? 'Google signed Euclidean out (the password changed or access was removed). Connect Google again.' : `Google: ${j.error_description || j.error || r.status}`), { notConnected: j.error === 'invalid_grant' });
  secrets.set(key, { ...t, ...j, obtainedAt: Date.now() });
  return j.access_token;
}

/** A Google API call with that login; JSON in and out. A 204 (deleted) gives {}. */
async function api(key, url, { method = 'GET', body } = {}) {
  const r = await fetch(url, { method, headers: { authorization: `Bearer ${await accessToken(key)}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) });
  if (r.status === 204) return {};
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = j.error?.message || `HTTP ${r.status}`;
    const hint = /has not been used|is disabled|accessNotConfigured/i.test(msg) ? ' Turn on the Google Calendar API for your OAuth client\'s project in Google Cloud Console (APIs & Services → Library → Google Calendar API → Enable), then try again.' : '';
    throw Object.assign(new Error(`Google: ${msg}.${hint}`), { status: r.status, gone: r.status === 404 || r.status === 410 });
  }
  return j;
}

function forget(key) { secrets.set(key, ''); }
const connected = (key) => !!secrets.get(key);

module.exports = { configured, beginAuth, accessToken, api, forget, connected };
