'use strict';
/**
 * AI bridge: talk to Grok, Claude and ChatGPT through your own logged-in
 * accounts (your subscriptions, no API keys). Each service runs in its own
 * hidden Euclidean window with its own saved login. A message is typed into the
 * page like a person would, and the reply is read off the page once it stops
 * changing.
 *
 * Pages change their layout from time to time, so reading replies has two
 * ways: the service's reply bubbles when we recognise them, else the new text
 * that appeared on the page after our message.
 */
const { BrowserWindow } = require('electron');

const SITES = {
  grok: { label: 'Grok', url: 'https://grok.com/', reply: ['.message-bubble', '[class*="message-bubble"]', '[data-testid*="message"]'] },
  claude: { label: 'Claude', url: 'https://claude.ai/new', reply: ['[data-is-streaming]', '.font-claude-message', '[data-testid*="assistant"]'] },
  chatgpt: { label: 'ChatGPT', url: 'https://chatgpt.com/', reply: ['[data-message-author-role="assistant"]'] },
};
const wins = {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function win(site, { show = false } = {}) {
  const s = SITES[site]; if (!s) throw new Error('Unknown assistant');
  let w = wins[site];
  if (!w || w.isDestroyed()) {
    w = new BrowserWindow({ width: 1100, height: 820, show, title: `${s.label} (Euclidean)`, autoHideMenuBar: true, webPreferences: { partition: `persist:bridge-${site}`, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
    w.on('close', (e) => { if (!w.__quitting) { e.preventDefault(); w.hide(); } });
    w.loadURL(s.url);
    wins[site] = w;
  } else if (show) { w.show(); w.focus(); }
  return w;
}

async function loaded(w) {
  if (!w.webContents.isLoading()) return;
  await new Promise((r) => { w.webContents.once('did-stop-loading', r); setTimeout(r, 30000); });
}

const FIND_INPUT = `(() => {
  const els = [...document.querySelectorAll('textarea, [contenteditable="true"], div.ProseMirror')].filter((e) => e.offsetParent !== null && !e.closest('[aria-hidden="true"]'));
  return els.sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top)[0] || null;
})()`;

async function status(site) {
  const w = wins[site];
  if (!w || w.isDestroyed()) return { site, label: SITES[site].label, open: false, ready: false };
  await loaded(w);
  const ready = await w.webContents.executeJavaScript(`!!${FIND_INPUT}`).catch(() => false);
  return { site, label: SITES[site].label, open: true, ready, url: w.webContents.getURL() };
}

/** Open the window so you can log in (it stays logged in afterwards). */
async function open(site) { win(site, { show: true }); return status(site); }

/** Send one message and wait for the whole reply. */
async function ask(site, text, { newChat = false, timeoutMs = 240000, quiet = false } = {}) {
  const s = SITES[site];
  const w = win(site);
  if (newChat) { w.loadURL(s.url); }
  await loaded(w); await sleep(800);
  const page = w.webContents;
  const ok = await page.executeJavaScript(`!!${FIND_INPUT}`).catch(() => false);
  if (!ok) { if (!quiet) win(site, { show: true }); throw Object.assign(new Error(`Log in to ${s.label} in the window that just opened, then try again.`), { needsLogin: true }); }
  const before = await page.executeJavaScript(`({ n: Math.max(0, ...${JSON.stringify(s.reply)}.map((q) => document.querySelectorAll(q).length)), text: (document.querySelector('main') || document.body).innerText })`);
  // Type the message like a person: focus the box, insert the text, press Enter (or click send).
  await page.executeJavaScript(`(() => { const el = ${FIND_INPUT}; el.focus(); if (el.tagName === 'TEXTAREA') { const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(el, ${JSON.stringify(text)}); el.dispatchEvent(new Event('input', { bubbles: true })); } else { document.execCommand('selectAll', false); document.execCommand('insertText', false, ${JSON.stringify(text)}); } })()`);
  await sleep(500);
  const sent = await page.executeJavaScript(`(() => { const b = [...document.querySelectorAll('button')].filter((x) => !x.disabled && x.offsetParent !== null && /send|submit/i.test((x.getAttribute('aria-label') || '') + ' ' + (x.getAttribute('data-testid') || '') + ' ' + (x.type || ''))).pop(); if (b) { b.click(); return true; } return false; })()`);
  if (!sent) { page.sendInputEvent({ type: 'keyDown', keyCode: 'Return' }); page.sendInputEvent({ type: 'char', keyCode: '\r' }); page.sendInputEvent({ type: 'keyUp', keyCode: 'Return' }); }
  // Wait for the reply to finish: the text stops changing for a few seconds.
  const read = `(() => {
    const sels = ${JSON.stringify(s.reply)};
    for (const q of sels) { const all = document.querySelectorAll(q); if (all.length > ${before.n}) return { via: 'bubble', text: all[all.length - 1].innerText }; }
    const t = (document.querySelector('main') || document.body).innerText; const mine = ${JSON.stringify(text.slice(-120))};
    const i = t.lastIndexOf(mine); return { via: 'page', text: i >= 0 ? t.slice(i + mine.length) : t.slice(${before.text.length}) };
  })()`;
  const start = Date.now(); let last = ''; let still = 0;
  while (Date.now() - start < timeoutMs) {
    await sleep(1500);
    const r = await page.executeJavaScript(read).catch(() => ({ text: '' }));
    const cur = String(r.text || '').trim();
    const busy = await page.executeJavaScript(`!![...document.querySelectorAll('button')].find((x) => x.offsetParent !== null && /stop/i.test((x.getAttribute('aria-label') || '') + ' ' + (x.getAttribute('data-testid') || '')))`).catch(() => false);
    if (cur && cur === last && !busy) { if (++still >= 2) return { text: cur.replace(/\n(Copy|Retry|Edit|Share|Regenerate|Good response|Bad response)\s*$/gi, '').trim(), site }; }
    else still = 0;
    last = cur;
  }
  if (last) return { text: last, site, partial: true };
  throw new Error(`${s.label} didn't answer in time. Open its window to check.`);
}

function closeAll() { for (const w of Object.values(wins)) { if (w && !w.isDestroyed()) { w.__quitting = true; w.close(); } } }

module.exports = { SITES, open, ask, status, closeAll };
