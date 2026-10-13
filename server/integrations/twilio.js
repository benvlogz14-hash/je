'use strict';
/**
 * Twilio Programmable Messaging. Outbound via REST; inbound by polling the
 * Messages list (works behind NAT with no public URL) and, optionally, by the
 * signed webhook at /webhooks/twilio when the engine is exposed publicly.
 * Inbound processing is idempotent on MessageSid.
 */
const crypto = require('crypto');
const secrets = require('../core/secrets');
const ctx = require('../core/ctx');

const K = { sid: 'global.twilio.accountSid', token: 'global.twilio.authToken', from: 'global.twilio.fromNumber', service: 'global.twilio.messagingServiceSid' };
const state = { lastPoll: null, lastError: null, ok: null };

function configured() { return secrets.has(K.sid) && secrets.has(K.token) && (secrets.has(K.from) || secrets.has(K.service)); }
function auth() { return 'Basic ' + Buffer.from(`${secrets.get(K.sid)}:${secrets.get(K.token)}`).toString('base64'); }
function base() { return `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(secrets.get(K.sid))}`; }

function normalize(num) {
  if (!num) return '';
  const d = String(num).replace(/[^\d+]/g, '');
  if (d.startsWith('+')) return d;
  if (d.length === 10) return '+1' + d;
  if (d.length === 11 && d.startsWith('1')) return '+' + d;
  return d;
}

async function send({ to, body }) {
  if (!configured()) throw new Error('SMS is not connected (Settings → Connections → Twilio)');
  const form = new URLSearchParams({ To: normalize(to), Body: body });
  if (secrets.has(K.service)) form.set('MessagingServiceSid', secrets.get(K.service)); else form.set('From', normalize(secrets.get(K.from)));
  const res = await fetch(`${base()}/Messages.json`, { method: 'POST', headers: { authorization: auth(), 'content-type': 'application/x-www-form-urlencoded' }, body: form, signal: AbortSignal.timeout(30000) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) { state.ok = false; state.lastError = j.message || `HTTP ${res.status}`; throw new Error(`Twilio: ${j.message || res.status}${j.code ? ` (code ${j.code})` : ''}`); }
  state.ok = true; state.lastError = null;
  return { providerId: j.sid, status: j.status };
}

/** Fetch inbound messages received since `sinceIso`. */
async function pollInbound(sinceIso) {
  if (!configured()) return [];
  const to = secrets.has(K.from) ? normalize(secrets.get(K.from)) : null;
  const q = new URLSearchParams({ PageSize: '50' });
  if (to) q.set('To', to);
  if (sinceIso) q.set('DateSent>', sinceIso.slice(0, 10));
  const res = await fetch(`${base()}/Messages.json?${q}`, { headers: { authorization: auth() }, signal: AbortSignal.timeout(30000) });
  const j = await res.json().catch(() => ({}));
  state.lastPoll = new Date().toISOString();
  if (!res.ok) { state.ok = false; state.lastError = j.message || `HTTP ${res.status}`; throw new Error(`Twilio poll: ${state.lastError}`); }
  state.ok = true; state.lastError = null;
  return (j.messages || []).filter((m) => m.direction === 'inbound').map((m) => ({
    providerId: m.sid, from: normalize(m.from), to: normalize(m.to), body: m.body || '', at: new Date(m.date_sent || m.date_created).toISOString(), media: Number(m.num_media || 0),
  }));
}

/** Validate X-Twilio-Signature (HMAC-SHA1 of URL + sorted params). */
function validSignature(url, params, signature) {
  const token = secrets.get(K.token);
  if (!token || !signature) return false;
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join('');
  const expected = crypto.createHmac('sha1', token).update(Buffer.from(data, 'utf8')).digest('base64');
  try { return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature)); } catch { return false; }
}

async function test() {
  if (!configured()) return { ok: false, error: 'Account SID, auth token and a from number (or messaging service) are required' };
  try {
    const res = await fetch(`${base()}.json`, { headers: { authorization: auth() }, signal: AbortSignal.timeout(20000) });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j.message || `HTTP ${res.status}`);
    state.ok = true; state.lastError = null;
    return { ok: true, account: j.friendly_name, status: j.status };
  } catch (e) { state.ok = false; state.lastError = e.message; return { ok: false, error: e.message }; }
}

module.exports = { K, configured, send, pollInbound, validSignature, normalize, test, state, pollSeconds: () => ctx.setting('messaging.smsPollSeconds', 20) };
