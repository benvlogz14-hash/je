'use strict';
/**
 * Live internet for Euclidean's AI, free and with no API key or account.
 *
 *  - search(q): DuckDuckGo's public results page (html.duckduckgo.com, then lite.duckduckgo.com if that one says
 *    no), or your own SearXNG first when `ai.searxngUrl` is set. `recent` = day | week | month | year.
 *  - read(url): the page fetched safely (safefetch.js: never this computer or your home network) and turned into
 *    clean text: title, date, description, the article's paragraphs, and its links.
 *  - research(question): search, read the best few pages side by side, and keep the passages that answer the
 *    question. This is what makes the free local Llama useful for current facts: it gets the pages' own words
 *    with their links, not just one-line snippets.
 *  - forPrompt(text, { deep }): the results (and with deep, the passages) as context for a prompt. ai.ask uses
 *    deep for the free local AI and your own AI account, which can't browse by themselves.
 *
 * Results are cached for 10 minutes and DuckDuckGo is asked at most once a second, so busy bots don't get the
 * app's address blocked.
 */
const ctx = require('../core/ctx');
const safe = require('./safefetch');

// ------------------------------------------------------------------ text helpers
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '-', mdash: '-', hellip: '...', rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"', copy: '(c)', reg: '(R)', trade: '(TM)', middot: '·', bull: '•', laquo: '«', raquo: '»', eacute: 'é', egrave: 'è', aacute: 'á', oacute: 'ó', iacute: 'í', uacute: 'ú', ntilde: 'ñ', ccedil: 'ç', uuml: 'ü', ouml: 'ö', auml: 'ä' };
function entities(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') { const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); try { return Number.isFinite(n) && n > 0 ? String.fromCodePoint(n) : ''; } catch { return ''; } }
    return ENT[e.toLowerCase()] ?? m;
  });
}
const decode = (s) => entities(String(s || '').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
const meta = (html, name) => { const re = new RegExp(`<meta[^>]+(?:name|property|itemprop)=["']${name}["'][^>]*>`, 'i'); const tag = re.exec(html)?.[0]; return tag ? decode((/content=["']([^"']*)["']/i.exec(tag) || [])[1] || '') : ''; };
const STOP = new Set('a an and are as at be but by can could did do does for from had has have how i if in into is it its me my not of on or our so than that the their them then there these they this to up us was we were what when where which who why will with would you your about please tell find search look give show latest new news today current right now me know get'.split(' '));
const terms = (s) => [...new Set(String(s || '').toLowerCase().replace(/[^a-z0-9$%.\s-]/g, ' ').split(/\s+/).map((w) => w.replace(/^[.-]+|[.-]+$/g, '')).filter((w) => w.length > 1 && !STOP.has(w)))];

// ------------------------------------------------------------------ search
const cache = new Map(); // key -> { at, results }
const CACHE_MS = 10 * 60000;
let lastDdg = 0; let chain = Promise.resolve();
/** One DuckDuckGo request at a time, at least a second apart. */
function paced(fn) {
  const run = chain.then(async () => { const wait = lastDdg + 1100 - Date.now(); if (wait > 0) await new Promise((r) => setTimeout(r, wait)); lastDdg = Date.now(); return fn(); });
  chain = run.catch(() => {});
  return run;
}
const DF = { day: 'd', week: 'w', month: 'm', year: 'y' };
const ddgBase = () => process.env.EUCLIDEAN_DDG_URL || 'https://html.duckduckgo.com';
const liteBase = () => process.env.EUCLIDEAN_DDG_LITE_URL || 'https://lite.duckduckgo.com';
const blockedPage = (html) => /anomaly-modal|bots use DuckDuckGo too|challenge-form|Please complete the following challenge/i.test(html);
const cleanUrl = (href) => { let url = entities(href); const u = /[?&]uddg=([^&]+)/.exec(url); if (u) url = decodeURIComponent(u[1]); if (url.startsWith('//')) url = `https:${url}`; return url; };
const keep = (url) => /^https?:\/\//.test(url) && !/duckduckgo\.com\/(y\.js|l\/\?)/.test(url) && !/[?&]ad_provider=|bing\.com\/aclick/.test(url);

async function duckduckgo(q, n, recent) {
  const body = new URLSearchParams({ q, kl: 'us-en', ...(DF[recent] ? { df: DF[recent] } : {}) }).toString();
  const r = await paced(() => safe.get(`${ddgBase()}/html/`, { method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded', referer: 'https://html.duckduckgo.com/' }, timeout: 15000 }));
  if (r.status >= 400 || blockedPage(r.text)) throw Object.assign(new Error('DuckDuckGo asked for a check'), { blocked: true });
  const out = [];
  // Each result: a result__a link, then (usually) a result__snippet.
  const blocks = r.text.split(/(?=<div[^>]+class="[^"]*\bresult\b[^"]*")/i).slice(1);
  for (const b of blocks) {
    if (/result--ad\b/.test(b.slice(0, 200))) continue;
    const a = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(b) || /<a[^>]+href="([^"]+)"[^>]+class="[^"]*result__a[^"]*"[^>]*>([\s\S]*?)<\/a>/i.exec(b);
    if (!a) continue;
    const url = cleanUrl(a[1]); if (!keep(url)) continue;
    const sn = /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|td|div)>/i.exec(b);
    out.push({ title: decode(a[2]), url, snippet: decode(sn ? sn[1] : '') });
    if (out.length >= n) break;
  }
  return out;
}

async function duckduckgoLite(q, n, recent) {
  const body = new URLSearchParams({ q, kl: 'us-en', ...(DF[recent] ? { df: DF[recent] } : {}) }).toString();
  const r = await paced(() => safe.get(`${liteBase()}/lite/`, { method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded', referer: 'https://lite.duckduckgo.com/' }, timeout: 15000 }));
  if (r.status >= 400 || blockedPage(r.text)) throw Object.assign(new Error('DuckDuckGo asked for a check'), { blocked: true });
  const out = []; const links = [...r.text.matchAll(/<a[^>]+href="([^"]+)"[^>]*class=['"]result-link['"][^>]*>([\s\S]*?)<\/a>|<a[^>]+class=['"]result-link['"][^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)];
  const snips = [...r.text.matchAll(/<td[^>]+class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/gi)].map((m) => decode(m[1]));
  links.forEach((m, i) => { const url = cleanUrl(m[1] || m[3]); if (keep(url) && out.length < n) out.push({ title: decode(m[2] || m[4]), url, snippet: snips[i] || '' }); });
  return out;
}

async function searxng(base, q, n, recent) {
  const range = { day: 'day', week: 'week', month: 'month', year: 'year' }[recent];
  const r = await safe.get(`${base.replace(/\/$/, '')}/search?q=${encodeURIComponent(q)}&format=json${range ? `&time_range=${range}` : ''}`, { timeout: 15000 });
  const j = JSON.parse(r.text || '{}');
  return (j.results || []).slice(0, n).map((x) => ({ title: x.title, url: x.url, snippet: x.content || '' }));
}

/**
 * DuckDuckGo's Instant Answer API (api.duckduckgo.com, free, no key): a short summary (usually Wikipedia's), a direct
 * answer or a definition, with its source link. { heading, text, url, source, related: [{ text, url }] } or null.
 */
async function instant(q) {
  q = String(q || '').trim().slice(0, 200); if (!q) return null;
  const key = `ia|${q.toLowerCase()}`; const hit = cache.get(key); if (hit && Date.now() - hit.at < CACHE_MS) return hit.results;
  try {
    const base = process.env.EUCLIDEAN_DDG_API_URL || 'https://api.duckduckgo.com';
    const r = await paced(() => safe.get(`${base}/?q=${encodeURIComponent(q)}&format=json&no_html=1&skip_disambig=1&t=euclidean`, { timeout: 10000, headers: { accept: 'application/json' } }));
    const j = JSON.parse(r.text || '{}');
    const text = j.Answer || j.AbstractText || j.Definition || '';
    const related = (j.RelatedTopics || []).flatMap((t) => (t.Topics ? t.Topics : [t])).filter((t) => t.Text && t.FirstURL).slice(0, 5).map((t) => ({ text: t.Text, url: t.FirstURL }));
    const out = text || related.length ? { heading: j.Heading || q, text, url: j.AbstractURL || j.DefinitionURL || j.AnswerURL || '', source: j.AbstractSource || j.DefinitionSource || '', related } : null;
    cache.set(key, { at: Date.now(), results: out });
    return out;
  } catch { return null; }
}

/** Web search: [{ title, url, snippet }]. Throws only when every way failed and the internet looks down. */
async function search(q, n = 8, { recent = null } = {}) {
  q = String(q || '').replace(/\s+/g, ' ').trim().slice(0, 300); if (!q) return [];
  const key = `${q.toLowerCase()}|${n}|${recent || ''}`; const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.results;
  const errors = [];
  const tries = [];
  const sx = ctx.setting?.('ai.searxngUrl', '');
  if (sx) tries.push(() => searxng(sx, q, n, recent));
  tries.push(() => duckduckgo(q, n, recent), () => duckduckgoLite(q, n, recent));
  for (const t of tries) {
    try { const r = await t(); if (r.length) { cache.set(key, { at: Date.now(), results: r }); if (cache.size > 300) cache.delete(cache.keys().next().value); return r; } }
    catch (e) { errors.push(e.message); }
  }
  if (errors.length === tries.length) throw new Error(`Web search didn't answer (${errors[errors.length - 1]}). Check the internet connection.`);
  return [];
}

// ------------------------------------------------------------------ reading a page
const DROP = /<(script|style|noscript|svg|template|iframe|object|canvas|form|select|button|nav|footer|aside)\b[\s\S]*?<\/\1>/gi;
/** Readable text out of an HTML page: { title, description, date, text, links }. */
function extract(html, url = '') {
  html = String(html || '').slice(0, 3_000_000);
  const title = meta(html, 'og:title') || decode((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html) || [])[1] || '');
  const description = meta(html, 'description') || meta(html, 'og:description');
  const date = meta(html, 'article:published_time') || meta(html, 'datePublished') || meta(html, 'date') || ((/<time[^>]+datetime=["']([^"']+)["']/i.exec(html) || [])[1] || '');
  let body = html.replace(/<head\b[\s\S]*?<\/head>/i, ' ').replace(/<!--[\s\S]*?-->/g, ' ').replace(DROP, ' ').replace(/<header\b[\s\S]*?<\/header>/gi, (m) => (/<h1/i.test(m) ? m : ' '));
  // Prefer the article (or main) when it holds most of the text.
  const pick = (tag) => { const all = [...body.matchAll(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi'))].map((m) => m[1]); return all.sort((a, b) => b.length - a.length)[0] || ''; };
  const article = pick('article'); const main = pick('main');
  const plainLen = (s) => s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').length;
  if (article && plainLen(article) > 300) body = article; else if (main && plainLen(main) > 300) body = main;
  // Links before tags are stripped.
  const links = []; const seen = new Set();
  for (const m of body.matchAll(/<a\b[^>]*href=["']([^"'#][^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    let href; try { href = new URL(entities(m[1]), url || undefined).toString(); } catch { continue; }
    const text = decode(m[2]).slice(0, 100);
    if (!/^https?:/.test(href) || !text || text.length < 3 || seen.has(href)) continue;
    seen.add(href); links.push({ text, url: href }); if (links.length >= 60) break;
  }
  const text = entities(body
    .replace(/<(h[1-6])\b[^>]*>([\s\S]*?)<\/\1>/gi, (m, h, t) => `\n\n## ${t.replace(/<[^>]+>/g, ' ')}\n\n`)
    .replace(/<li\b[^>]*>/gi, '\n• ').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|section|tr|li|blockquote|pre|table|ul|ol|dd|dt|figcaption)>/gi, '\n\n').replace(/<t[dh]\b[^>]*>/gi, ' | ')
    .replace(/<[^>]+>/g, ' '))
    .replace(/[ \t\f\v ]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return { title: title.slice(0, 200), description: description.slice(0, 400), date: date.slice(0, 40), text, links };
}

const pageCache = new Map();
/** Read one page: { url, title, description, date, text, links }. */
async function read(url, { maxChars = 60000 } = {}) {
  const hit = pageCache.get(url); if (hit && Date.now() - hit.at < CACHE_MS) return hit.page;
  const r = await safe.get(url, { timeout: 20000, keepBuffer: true, maxBytes: 12 * 1024 * 1024 });
  if (r.status >= 400) throw new Error(`The page answered ${r.status}${r.status === 403 || r.status === 429 ? ' (it blocks automated readers)' : ''}.`);
  // PDFs and Word files (reports, finance filings, bills, a campaign's platform) are read in code too.
  if (r.binary && r.buffer && (/pdf|wordprocessingml/i.test(r.type) || r.buffer.subarray(0, 5).toString('latin1') === '%PDF-')) {
    const doc = require('../data').textOfFile(r.buffer, /pdf/i.test(r.type) || r.buffer.subarray(0, 5).toString('latin1') === '%PDF-' ? 'file.pdf' : 'file.docx');
    const title = (/^#?\s*(.{4,120})$/m.exec(doc.text.trim()) || [])[1] || url;
    const page = { url: r.url, title, description: doc.pages ? `PDF, ${doc.pages} pages` : 'Word file', date: '', text: doc.text.slice(0, maxChars), links: [...new Set(doc.text.match(/https?:\/\/[^\s)>\]]+/g) || [])].slice(0, 40).map((u) => ({ text: u, url: u })), truncated: doc.text.length > maxChars || r.truncated };
    pageCache.set(url, { at: Date.now(), page }); return page;
  }
  if (r.binary) throw new Error(`That link is a file (${r.type.split(';')[0] || 'not a web page'}), not a page I can read.`);
  let page;
  if (/json/i.test(r.type)) page = { title: url, description: '', date: '', text: r.text.slice(0, maxChars), links: [] };
  else if (/html|xml/i.test(r.type) || /<html|<body|<p[\s>]/i.test(r.text.slice(0, 5000))) page = extract(r.text, r.url);
  else page = { title: url, description: '', date: '', text: r.text, links: [] };
  page = { url: r.url, ...page, text: page.text.slice(0, maxChars), truncated: page.text.length > maxChars || r.truncated };
  pageCache.set(url, { at: Date.now(), page }); if (pageCache.size > 120) pageCache.delete(pageCache.keys().next().value);
  return page;
}

/** The parts of a text that are most about the question: [{ text, score }] in page order. */
function passages(text, question, { max = 4, size = 700 } = {}) {
  const q = terms(question); const paras = String(text || '').split(/\n{2,}/).map((p) => p.trim()).filter((p) => p.length > 30);
  const chunks = []; let cur = '';
  for (const p of paras) { if ((cur + '\n' + p).length > size && cur) { chunks.push(cur); cur = p; } else cur = cur ? `${cur}\n${p}` : p; }
  if (cur) chunks.push(cur);
  if (!q.length) return chunks.slice(0, max).map((t) => ({ text: t.slice(0, size * 1.5), score: 0 }));
  const scored = chunks.map((t, i) => {
    const low = t.toLowerCase(); let s = 0;
    for (const w of q) { const hits = low.split(w).length - 1; if (hits) s += 1 + Math.min(hits - 1, 3) * 0.3; }
    if (/\d/.test(t) && /\b(how many|how much|when|what year|number|price|cost|raised|votes?|percent)\b/i.test(question)) s += 0.5;
    return { i, text: t.slice(0, size * 1.5), score: s / q.length };
  });
  return scored.filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, max).sort((a, b) => a.i - b.i).map(({ text: t, score }) => ({ text: t, score: Math.round(score * 100) / 100 }));
}

/** Turn a request into a search query ("can you find the latest on X" -> "X"). */
function queryOf(text) {
  return String(text || '').replace(/\s+/g, ' ')
    .replace(/^(hey|hi|ok|okay|please|so)[,\s]+/i, '')
    .replace(/^(can|could|would) you (please )?/i, '')
    .replace(/^(please )?(search( the web)?( for)?|look up|google|find( out)?|research|tell me|show me|what('s| is| are) the latest( news)? (on|about)|give me)\s+/i, '')
    .replace(/^(about |on )?(the )?(latest|recent|newest|current)( news| info(rmation)?| updates?)? (on|about|for|with)\s+/i, '')
    .replace(/[?!.]+$/, '').trim().slice(0, 200);
}

/**
 * Search and read: the best `pages` results are read side by side and their passages about the question kept.
 * Returns { query, results, pages: [{ url, title, date, passages: [text] }], failed: [{ url, error }] }.
 */
async function research(question, { query, pages = 3, results: n = 8, recent = null, perPage = 3, full = false } = {}) {
  const q = query || queryOf(question);
  // A full inquiry uses Google (Serper) when it's set up and within budget; otherwise the free DuckDuckGo search.
  let google = null;
  if (full) { const s = require('./serper'); if (!s.blocked()) { try { google = await s.web(q, { num: Math.max(10, n), recent }); } catch { google = null; } } }
  const [results, quick] = await Promise.all([google ? google.results.slice(0, n) : search(q, n, { recent }), recent || google ? null : instant(q)]);
  const pick = results.filter((r) => !/\.(docx?|xlsx?|pptx?|zip|mp4|mp3)(\?|$)/i.test(r.url) && !/youtube\.com\/watch|tiktok\.com|instagram\.com|facebook\.com|x\.com\/|twitter\.com/i.test(r.url)).slice(0, pages);
  const failed = []; const read_ = [];
  await Promise.all(pick.map(async (r) => {
    try {
      const p = await read(r.url);
      const ps = passages(p.text, `${question} ${q}`, { max: perPage });
      read_.push({ url: p.url, title: p.title || r.title, date: p.date, passages: ps.length ? ps.map((x) => x.text) : [(p.description || p.text.slice(0, 600))] });
    } catch (e) { failed.push({ url: r.url, error: e.message }); }
  }));
  read_.sort((a, b) => pick.findIndex((r) => r.url === a.url || r.title === a.title) - pick.findIndex((r) => r.url === b.url || r.title === b.title));
  const box = google?.box?.text ? { heading: google.box.title || 'Google', text: google.box.text, url: google.box.url, source: 'Google', related: [] } : google?.kg?.text ? { heading: google.kg.title, text: google.kg.text, url: google.kg.url, source: 'Google', related: [] } : null;
  return { query: q, engine: google ? 'google' : 'duckduckgo', instant: box || quick, results, pages: read_, failed };
}

/** Research as prompt context. */
function formatResearch(r, { maxChars = 9000 } = {}) {
  if (!r.results.length && !r.instant) return '';
  let out = r.instant ? `DUCKDUCKGO INSTANT ANSWER (${r.instant.heading}${r.instant.source ? `, ${r.instant.source}` : ''}${r.instant.url ? `: ${r.instant.url}` : ''}): ${r.instant.text}${r.instant.related.length ? `\nRelated: ${r.instant.related.map((x) => `${x.text} (${x.url})`).join('; ')}` : ''}\n\n` : '';
  out += `WEB SEARCH (searched just now for "${r.query}"; only trust what these actually say, and give the link for anything you use):\n`;
  out += r.results.map((x, i) => `${i + 1}. ${x.title} — ${x.url}\n   ${x.snippet}`).join('\n');
  if (r.pages.length) {
    out += '\n\nPAGES READ (the pages\' own words):';
    for (const p of r.pages) {
      const block = `\n\n### ${p.title} (${p.url})${p.date ? ` · ${p.date.slice(0, 10)}` : ''}\n${p.passages.join('\n…\n')}`;
      if (out.length + block.length > maxChars) { out += `\n\n### ${p.title} (${p.url})\n${p.passages[0].slice(0, Math.max(200, maxChars - out.length - 200))}`; break; }
      out += block;
    }
  }
  return out;
}

/** Search results (deep: plus the pages read) formatted as context for a prompt; '' when nothing came back. */
async function forPrompt(text, { deep = false, pages = 3, recent = null } = {}) {
  const q = queryOf(String(text || '').replace(/^.*?\b(find|research|audit)\s+/i, ''));
  if (q.length < 4) return '';
  try {
    if (deep) return formatResearch(await research(text, { query: q, pages, recent }));
    const r = await search(q, 8, { recent });
    return r.length ? formatResearch({ query: q, results: r, pages: [] }) : '';
  } catch { return ''; }
}

module.exports = { instant, search, read, extract, passages, research, formatResearch, forPrompt, queryOf, terms };
