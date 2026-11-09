'use strict';
/**
 * The bots' browser: one hidden, walled-off Chromium window per bot inside the desktop app, so a bot can open pages
 * that need JavaScript, read them, look at them (a screenshot after every step) and, when you allow it, click and type.
 *
 * Walls (per bot, its own `persist:bot-<id>` session, nothing shared with the app or your other logins):
 *  - every request is checked: only http/https/data/blob; never this computer (localhost, the engine), your home
 *    or office network, link-local or cloud-metadata addresses (names are looked up, so a name pointing inside is
 *    refused too); `web.localNetwork` opens the home network;
 *  - no downloads, no camera/microphone/location/notifications, no pop-up windows (they open in the same window);
 *  - offscreen rendering (never shown), until you press "Open it yourself", which shows a normal window with the same
 *    session so you can log the bot into a site or take over.
 * Engine side: `ctx.botBrowser` (server/bots/tools.js). Written for Euclidean; the idea of a per-bot browser with an
 * egress gate comes from OpenMausBot (Apache 2.0).
 */
const { BrowserWindow, session } = require('electron');
const fs = require('fs');
const path = require('path');

const wins = {}; const shown = {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let guard = null; // set by the engine: (url) => Promise<{ ok, reason }>
const blockedLog = {};
// The check looks the name up, so it's remembered per host for a minute (pages load dozens of files from one host).
const verdicts = new Map();
async function guarded(u) {
  let host; try { const x = new URL(u); host = `${x.protocol}//${x.host}`; } catch { return { ok: false, reason: 'Not a web address.' }; }
  const v = verdicts.get(host); if (v && Date.now() - v.at < 60000) return v.r;
  const r = guard ? await guard(u) : { ok: false, reason: 'The bot browser is not ready yet.' };
  verdicts.set(host, { at: Date.now(), r }); if (verdicts.size > 500) verdicts.delete(verdicts.keys().next().value);
  return r;
}

function sessionFor(botId) {
  const part = `persist:bot-${String(botId).replace(/[^A-Za-z0-9_-]/g, '')}`;
  const s = session.fromPartition(part);
  if (!s.__euWalled) {
    s.__euWalled = true;
    s.setPermissionRequestHandler((wc, perm, cb) => cb(perm === 'clipboard-sanitized-write'));
    s.setPermissionCheckHandler(() => false);
    s.on('will-download', (e) => e.preventDefault());
    s.webRequest.onBeforeRequest(async (details, cb) => {
      const u = details.url;
      if (/^(data|blob|about|chrome-error|devtools):/i.test(u)) return cb({});
      if (!/^https?:/i.test(u)) return cb({ cancel: true });
      try { const r = await guarded(u); if (!r.ok) { (blockedLog[botId] = blockedLog[botId] || []).push(r.reason); if (blockedLog[botId].length > 20) blockedLog[botId].shift(); } cb(r.ok ? {} : { cancel: true }); }
      catch { cb({ cancel: true }); }
    });
  }
  return s;
}

function win(botId) {
  let w = wins[botId];
  if (w && !w.isDestroyed()) return w;
  w = new BrowserWindow({ width: 1280, height: 900, show: false, webPreferences: { session: sessionFor(botId), offscreen: true, contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false, javascript: true, webviewTag: false } });
  w.webContents.setFrameRate(4);
  w.webContents.setAudioMuted(true);
  w.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/i.test(url)) w.loadURL(url); return { action: 'deny' }; });
  w.webContents.on('will-attach-webview', (e) => e.preventDefault());
  wins[botId] = w;
  return w;
}

async function settle(w, ms = 25000) {
  const wc = w.webContents;
  if (wc.isLoading()) await new Promise((r) => { const done = () => r(); wc.once('did-stop-loading', done); setTimeout(done, ms); });
  await sleep(900);
}

const READ = `(() => {
  const pick = () => { const a = [...document.querySelectorAll('article, main, [role=main]')].sort((x, y) => y.innerText.length - x.innerText.length)[0]; return a && a.innerText.length > 400 ? a : document.body; };
  const root = pick();
  const text = (root ? root.innerText : '').replace(/\\n{3,}/g, '\\n\\n').slice(0, 60000);
  const seen = new Set(); const links = [];
  for (const a of document.querySelectorAll('a[href]')) { const t = (a.innerText || a.getAttribute('aria-label') || '').trim().replace(/\\s+/g, ' ').slice(0, 90); if (!t || t.length < 2 || seen.has(a.href) || !/^https?:/.test(a.href)) continue; seen.add(a.href); links.push({ text: t, url: a.href }); if (links.length >= 60) break; }
  const fields = [...document.querySelectorAll('input:not([type=hidden]), textarea, select, [contenteditable=true]')].filter((e) => e.offsetParent !== null).slice(0, 25).map((e) => ({ kind: e.tagName.toLowerCase(), type: e.type || '', name: e.name || e.id || '', label: (e.labels && e.labels[0] && e.labels[0].innerText) || e.getAttribute('aria-label') || e.placeholder || '' }));
  const buttons = [...document.querySelectorAll('button, [role=button], input[type=submit]')].filter((e) => e.offsetParent !== null).slice(0, 30).map((e) => (e.innerText || e.value || e.getAttribute('aria-label') || '').trim().slice(0, 60)).filter(Boolean);
  return { title: document.title, url: location.href, text, links, fields, buttons };
})()`;

async function snapshot(botId, w, shotDir) {
  const page = await w.webContents.executeJavaScript(READ).catch(() => ({ title: w.webContents.getTitle(), url: w.webContents.getURL(), text: '', links: [], fields: [], buttons: [] }));
  let shot = null;
  try {
    const img = await w.webContents.capturePage();
    if (img && !img.isEmpty()) { fs.mkdirSync(shotDir, { recursive: true }); shot = path.join(shotDir, `${String(botId).replace(/[^A-Za-z0-9_-]/g, '')}-${Date.now()}.png`); fs.writeFileSync(shot, img.resize({ width: 1000 }).toPNG()); }
  } catch { /* no picture this time */ }
  const blocked = (blockedLog[botId] || []).splice(0);
  return { ...page, shot, blocked: [...new Set(blocked)].slice(0, 5) };
}

/** Open a page. */
async function open(botId, url, { shotDir }) {
  const w = win(botId);
  try { await w.loadURL(url); } catch (e) { if (!/ERR_ABORTED/.test(e.message)) { const s = await snapshot(botId, w, shotDir); if (!s.text) throw new Error(/ERR_BLOCKED_BY_CLIENT|ERR_ABORTED/.test(e.message) ? (s.blocked[0] || 'That address is blocked for bots.') : `The page didn't open (${e.message.replace(/^.*?(ERR_[A-Z_]+).*$/s, '$1')}).`); return s; } }
  await settle(w);
  return snapshot(botId, w, shotDir);
}

/** The page as it is now. */
async function read(botId, { shotDir }) { const w = wins[botId]; if (!w || w.isDestroyed()) throw new Error('No page is open yet. Open one first.'); return snapshot(botId, w, shotDir); }

const FIND = (target) => `((t) => {
  const vis = (e) => e && e.offsetParent !== null && !e.disabled;
  try { const q = document.querySelector(t); if (vis(q)) return q; } catch { /* not a selector */ }
  const low = t.toLowerCase().trim();
  const cands = [...document.querySelectorAll('a, button, [role=button], [role=link], [role=tab], [role=menuitem], input[type=submit], input[type=button], label, summary, [onclick]')].filter(vis);
  const name = (e) => (e.innerText || e.value || e.getAttribute('aria-label') || e.title || '').trim().toLowerCase().replace(/\\s+/g, ' ');
  return cands.find((e) => name(e) === low) || cands.find((e) => name(e).startsWith(low)) || cands.find((e) => name(e).includes(low)) || null;
})(${JSON.stringify(String(target))})`;

/** Click something by its visible text (or a CSS selector). */
async function click(botId, target, { shotDir }) {
  const w = wins[botId]; if (!w || w.isDestroyed()) throw new Error('No page is open yet.');
  const ok = await w.webContents.executeJavaScript(`(() => { const e = ${FIND(target)}; if (!e) return false; e.scrollIntoView({ block: 'center' }); e.click(); return (e.innerText || e.value || e.getAttribute('aria-label') || 'it').trim().slice(0, 60) || true; })()`).catch(() => false);
  if (!ok) throw new Error(`Nothing called "${target}" to click on this page.`);
  await sleep(600); await settle(w, 15000);
  return { clicked: ok, ...(await snapshot(botId, w, shotDir)) };
}

/** Type into a field (found by its label, placeholder, name or a selector; the focused/first field otherwise). */
async function type(botId, { field = '', text = '', enter = false }, { shotDir }) {
  const w = wins[botId]; if (!w || w.isDestroyed()) throw new Error('No page is open yet.');
  const ok = await w.webContents.executeJavaScript(`((f, v) => {
    const vis = (e) => e && e.offsetParent !== null && !e.disabled && !e.readOnly;
    const all = [...document.querySelectorAll('input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=checkbox]):not([type=radio]), textarea, [contenteditable=true]')].filter(vis);
    let el = null; const low = f.toLowerCase().trim();
    if (low) { try { const q = document.querySelector(f); if (vis(q)) el = q; } catch { /* not a selector */ }
      if (!el) el = all.find((e) => [(e.labels && e.labels[0] && e.labels[0].innerText) || '', e.getAttribute('aria-label') || '', e.placeholder || '', e.name || '', e.id || ''].some((s) => s.toLowerCase().includes(low))); }
    if (!el) el = (vis(document.activeElement) && all.includes(document.activeElement)) ? document.activeElement : all[0];
    if (!el) return false;
    el.focus();
    if (el.isContentEditable) { document.execCommand('selectAll', false); document.execCommand('insertText', false, v); }
    else { const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }
    return el.name || el.id || el.placeholder || el.tagName.toLowerCase();
  })(${JSON.stringify(String(field))}, ${JSON.stringify(String(text))})`).catch(() => false);
  if (!ok) throw new Error(field ? `No field called "${field}" on this page.` : 'There is no field to type into on this page.');
  if (enter) { const wc = w.webContents; wc.sendInputEvent({ type: 'keyDown', keyCode: 'Return' }); wc.sendInputEvent({ type: 'char', keyCode: '\r' }); wc.sendInputEvent({ type: 'keyUp', keyCode: 'Return' }); await sleep(800); await settle(w, 15000); }
  return { typedInto: ok, ...(await snapshot(botId, w, shotDir)) };
}

async function scroll(botId, dir = 'down', { shotDir }) {
  const w = wins[botId]; if (!w || w.isDestroyed()) throw new Error('No page is open yet.');
  await w.webContents.executeJavaScript(`window.scrollBy(0, ${dir === 'up' ? -1 : 1} * window.innerHeight * 0.85)`).catch(() => {});
  await sleep(500);
  return snapshot(botId, w, shotDir);
}

/** Show a normal window with the bot's own session (log it into a site, or take over). */
function show(botId) {
  const url = wins[botId] && !wins[botId].isDestroyed() ? wins[botId].webContents.getURL() : 'https://duckduckgo.com/';
  let w = shown[botId];
  if (!w || w.isDestroyed()) {
    w = new BrowserWindow({ width: 1200, height: 860, title: 'Bot browser (Euclidean)', autoHideMenuBar: true, webPreferences: { session: sessionFor(botId), contextIsolation: true, sandbox: true } });
    w.webContents.setWindowOpenHandler(({ url: u }) => { if (/^https?:/i.test(u)) w.loadURL(u); return { action: 'deny' }; });
    shown[botId] = w;
  }
  w.loadURL(url || 'https://duckduckgo.com/'); w.show(); w.focus();
  return { ok: true, url };
}

function close(botId) { for (const m of [wins, shown]) { const w = m[botId]; if (w && !w.isDestroyed()) w.destroy(); delete m[botId]; } }
function closeAll() { for (const id of new Set([...Object.keys(wins), ...Object.keys(shown)])) close(id); }
async function clearData(botId) { close(botId); await sessionFor(botId).clearStorageData(); return { ok: true }; }
function setGuard(fn) { guard = fn; }

module.exports = { open, read, click, type, scroll, show, close, closeAll, clearData, setGuard };
