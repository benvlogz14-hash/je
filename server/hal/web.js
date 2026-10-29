'use strict';
/**
 * HAL's senses: real news, web search, reading a page, and live search through the founders' own Grok (the JEV link).
 * Nothing here asks the model to remember a fact; it fetches the facts, and HAL is only allowed to use what came back.
 * News comes from Google News and Al Jazeera RSS, web search from Euclidean's free search.
 */
const ctx = require('../core/ctx');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Euclidean-HAL';
// Entities first (feeds often carry escaped HTML), then tags, then what's left.
const decode = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&#x27;|&apos;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
const strip = (s) => decode(decode(String(s || '').replace(/<!\[CDATA\[|\]\]>/g, '')).replace(/<[^>]+>/g, ' ')).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const firstSentence = (s, cap = 160) => { const t = strip(s); const o = t.split(/(?<=[.!?])\s/)[0] || t; return o.length > cap ? `${o.slice(0, cap)}...` : o; };
const tag = (xml, name) => { const m = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i').exec(xml); return m ? m[1] : ''; };

async function get(url, { timeout = 20000, accept } = {}) {
  const res = await fetch(url, { headers: { 'user-agent': UA, ...(accept ? { accept } : {}) }, signal: AbortSignal.timeout(timeout), redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res;
}

/** RSS items: [{ s: source, t: title, b: first sentence, url }]. */
async function rss(url, src, limit = 6) {
  try {
    const xml = await (await get(url)).text();
    return [...xml.matchAll(/<item[\s>][\s\S]*?<\/item>/gi)].slice(0, limit).map((m) => {
      const it = m[0]; const t = strip(tag(it, 'title')).replace(/\s*-\s*(AP News|Al Jazeera)\s*$/, '');
      return { s: src, t, b: firstSentence(tag(it, 'description')), url: strip(tag(it, 'link')) };
    }).filter((x) => x.t);
  } catch { return []; }
}
const gnews = (q, when = '30d') => `https://news.google.com/rss/search?q=${encodeURIComponent(`${when ? `when:${when} ` : ''}${q}`)}&hl=en-US&gl=US&ceid=US:en`;

/** Today's politics headlines, AP and Al Jazeera interleaved (fetch_news). */
async function topNews() {
  const [ap, ajz] = await Promise.all([rss(gnews('(politics OR election) site:apnews.com', '1d'), 'ap', 6), rss('https://www.aljazeera.com/xml/rss/all.xml', 'ajz', 6)]);
  const mix = []; for (let i = 0; i < Math.max(ap.length, ajz.length); i++) { if (ap[i]) mix.push(ap[i]); if (ajz[i]) mix.push(ajz[i]); }
  return mix;
}
/** Recent headlines about a person (news_per_name). */
const newsAbout = (name, limit = 4) => rss(gnews(`${name} (campaign OR election OR race)`), 'news', limit);
/** Any topic in the news. */
const newsFor = (q, limit = 6) => rss(gnews(q, ''), 'web', limit);
/** A link that always opens something useful about a person (research_url). */
const researchUrl = (name, office = '') => `https://news.google.com/search?q=${encodeURIComponent(`${name}${office ? ` ${String(office).split('·')[0].trim()}` : ''} campaign`)}&hl=en-US&gl=US&ceid=US:en`;

/** Web search (free, no key): [{ title, url, snippet }]. */
async function search(q, n = 6) {
  try { return (await require('../integrations/websearch').search(q, n)).map((r) => ({ title: r.title, url: r.url, snippet: r.snippet || '' })); } catch { return []; }
}

/** Read a web page as plain text (first ~6,000 characters), for "read this link". */
async function readPage(url) {
  if (!/^https?:\/\//i.test(url)) throw new Error('That is not a web link.');
  const res = await get(url, { timeout: 20000, accept: 'text/html,text/plain' });
  const type = res.headers.get('content-type') || '';
  if (!/text|html|json|xml/i.test(type)) throw new Error('That link is not a web page I can read (it is a file).');
  const html = (await res.text()).slice(0, 2_000_000);
  const title = strip(tag(html, 'title')).slice(0, 160);
  const body = strip(html.replace(/<(script|style|noscript|svg|nav|footer|header)[\s\S]*?<\/\1>/gi, ' ')).slice(0, 6000);
  return { title, text: body, url };
}

// ------------------------------------------------------------------ the JEV link: the founders' own AI accounts
/**
 * Live web through the founders' own Grok login (AI apps page): Grok browses the web itself, so HAL can ask it for
 * today's news and leads without an API key. Only used when Grok is logged in on the AI apps page, and at most
 * `hal.watch.grokPerHour` times an hour (personal-account terms limit automated use). Returns { text, items } where
 * items are the lines Grok gave that carry a real link; anything without a link is dropped.
 */
const grokSent = [];
function grokReady() {
  const bridge = require('../integrations/bridge');
  if (!bridge.available() || !(ctx.store.settings._bridgeLoggedIn || {}).grok) return false;
  const hour = Date.now() - 3600000; while (grokSent.length && grokSent[0] < hour) grokSent.shift();
  return grokSent.length < Number(ctx.setting('hal.watch.grokPerHour', 4));
}
async function viaGrok(question) {
  if (!grokReady()) return null;
  grokSent.push(Date.now());
  const r = await require('../integrations/bridge').ask('grok', `${question}\n\nSearch the live web now. Reply with at most 8 lines, one item per line: a short headline, then " | ", then the full source URL. Only things you actually found with a link. No commentary.`, { newChat: true, record: false, actor: 'hal', quiet: true });
  const items = String(r.text || '').split(/\r?\n/).map((l) => { const url = (l.match(/https?:\/\/[^\s)\]>]+/) || [])[0]; if (!url) return null; const t = strip(l.replace(url, '').replace(/^[\s\-*•\d.)]+/, '').replace(/[|\s(]+$/, '')); return t ? { s: 'grok', t: t.slice(0, 200), b: '', url } : null; }).filter(Boolean);
  return { text: r.text, items };
}
/** Grok through xAI with live search, when the founders added an xAI key. */
async function viaXai(question) {
  const ai = require('../integrations/ai');
  if (!ai.connected('xai')) return null;
  const r = await ai.ask({ role: 'hal', provider: 'xai', search: true, maxTokens: 700, prompt: `${question}\n\nReply with at most 8 lines: a short headline, " | ", the full source URL. Only items with a real link.` });
  const items = String(r.text || '').split(/\r?\n/).map((l) => { const url = (l.match(/https?:\/\/[^\s)\]>]+/) || [])[0]; const t = url && strip(l.replace(url, '').replace(/^[\s\-*•\d.)]+/, '').replace(/[|\s(]+$/, '')); return t ? { s: 'xai', t: t.slice(0, 200), b: '', url } : null; }).filter(Boolean);
  return { text: r.text, items };
}
/** The best live search available: Grok (your login), else xAI search, else nothing (the free feeds still work). */
async function live(question) {
  try { const g = await viaGrok(question); if (g?.items.length) return { ...g, via: 'Grok (your account)' }; } catch { /* not logged in or busy */ }
  try { const x = await viaXai(question); if (x?.items.length) return { ...x, via: 'Grok (xAI live search)' }; } catch { /* no key */ }
  return null;
}

module.exports = { rss, topNews, newsAbout, newsFor, researchUrl, search, readPage, live, viaGrok, grokReady, strip };
