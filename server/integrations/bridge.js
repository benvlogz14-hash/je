'use strict';
/**
 * Your own Grok, Claude and ChatGPT accounts (subscriptions, no API keys), through
 * the desktop app's bridge windows (app/bridge.js). Used by the AI chat page and the
 * search bar, and, only if a founder switches it on, by Euclidean's own AI work.
 */
const ctx = require('../core/ctx');
const audit = require('../core/audit');
const events = require('../core/events');
const { now } = require('../core/util');

const SITES = ['grok', 'claude', 'chatgpt'];
const LABEL = { grok: 'Grok', claude: 'Claude', chatgpt: 'ChatGPT' };
const B = () => ctx.bridge || null;
const S = (k, d) => ctx.setting(`ai.bridge.${k}`, d);

function available() { return !!B(); }
// Logged in? Remembered across restarts so background work knows which accounts it can use.
const loggedIn = () => ctx.store.settings._bridgeLoggedIn || {};
function setLoggedIn(site, v) { ctx.store.settings._bridgeLoggedIn = { ...loggedIn(), [site]: !!v }; ctx.store.touch(); }

async function status() {
  if (!B()) return { available: false, sites: SITES.map((s) => ({ site: s, label: LABEL[s], ready: false })) };
  const sites = [];
  for (const s of SITES) { try { const st = await B().status(s); if (st.open) setLoggedIn(s, st.ready); sites.push({ ...st, ready: st.open ? st.ready : !!loggedIn()[s] }); } catch { sites.push({ site: s, label: LABEL[s], ready: false }); } }
  return { available: true, sites, use: S('use', 'off'), site: S('site', 'grok'), perHour: S('perHour', 20) };
}

function history(site) { return (ctx.store.settings._bridgeChats || {})[site] || []; }
function remember(site, role, text) {
  const all = ctx.store.settings._bridgeChats || {};
  all[site] = [...(all[site] || []), { role, text: String(text).slice(0, 20000), at: now() }].slice(-200);
  ctx.store.settings._bridgeChats = all; ctx.store.touch();
  events.publish('bridge', { site });
}

let queue = Promise.resolve(); // one message at a time per app, like a person typing
const sent = [];

/** Send a message to one of your assistants and get the reply. */
function ask(site, text, { newChat = false, record = true, actor = 'user', quiet = false } = {}) {
  if (!B()) return Promise.reject(new Error('Talking to your Grok, Claude or ChatGPT accounts works in the Euclidean desktop app.'));
  if (!SITES.includes(site)) return Promise.reject(new Error('Pick Grok, Claude or ChatGPT.'));
  const run = async () => {
    if (record) remember(site, 'you', text);
    try {
      const r = await B().ask(site, text, { newChat, quiet });
      setLoggedIn(site, true); sent.push(Date.now());
      if (record) remember(site, 'them', r.text);
      audit.log(actor, 'bridge.ask', { site, chars: text.length });
      return r;
    } catch (e) { if (e.needsLogin) setLoggedIn(site, false); if (record) remember(site, 'error', e.message); throw e; }
  };
  const p = queue.then(run, run); queue = p.catch(() => {});
  return p;
}

/** For ai.ask: can Euclidean's own AI work go through your accounts right now? */
function usable() {
  if (!B() || S('use', 'off') === 'off') return false;
  const site = S('site', 'grok'); if (!loggedIn()[site]) return false; // only accounts you've logged in to
  const hour = Date.now() - 3600000; while (sent.length && sent[0] < hour) sent.shift();
  return sent.length < Number(S('perHour', 20));
}

async function complete({ system, prompt, json }) {
  const site = S('site', 'grok');
  const text = `${system ? `${system}\n\n` : ''}${prompt}${json ? '\n\nReply with one valid JSON object only, no other text.' : ''}`.slice(0, 30000);
  const r = await ask(site, text, { newChat: true, record: false, actor: 'euclidean', quiet: true });
  return { text: r.text, model: `${LABEL[site]} (your account)` };
}

module.exports = { SITES, LABEL, available, status, ask, history, usable, complete };
