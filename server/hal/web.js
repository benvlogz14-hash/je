'use strict';
/**
 * HAL's senses (Part 2 of the master prompt): real news, web search, reading a page, and the protest scan. Nothing
 * here asks the model to remember a fact; it fetches the facts, and HAL is only allowed to use what came back.
 * News comes from Google News and Al Jazeera RSS (as in HAL's own program), web search from Euclidean's free search,
 * map pins from OpenStreetMap's geocoder (one request a second, per its rules).
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

// ------------------------------------------------------------------ protest map (HAL's scan, grounded)
const PROTEST_QUERIES = [
  '(protest OR rally OR demonstration OR march OR vigil OR walkout OR "sit-in") ("New York City" OR Manhattan OR Brooklyn OR Queens OR Bronx)',
  '(protest OR rally OR demonstration OR march OR vigil OR walkout) ("Long Island" OR Nassau OR Suffolk)',
  '(protest OR rally OR demonstration OR march OR vigil OR walkout) (Connecticut OR Hartford OR "New Haven" OR Bridgeport OR Stamford)',
  '(protest OR rally OR demonstration OR march OR vigil OR walkout) ("New Jersey" OR Newark OR "Jersey City")',
  '(convention OR expo OR "book fair" OR festival OR fan OR comic) ("New York" OR "Long Island" OR Connecticut OR "New Jersey")',
  '(nationwide OR national) (protest OR rally OR "day of action" OR march OR strike OR walkout)',
];
async function protestItems(per = 8) {
  const seen = new Set(); const out = [];
  for (const q of PROTEST_QUERIES) for (const it of await rss(gnews(q, '7d'), 'protest', per)) { const k = it.t.toLowerCase(); if (!seen.has(k)) { seen.add(k); out.push(it); } }
  return out;
}

const geoCache = new Map(); let lastGeo = 0;
/** Place name → [lat, lng] in the US (OpenStreetMap Nominatim, 1 request a second). */
async function geocode(place) {
  const k = String(place || '').trim().toLowerCase(); if (!k) return null;
  if (geoCache.has(k)) return geoCache.get(k);
  const wait = 1100 - (Date.now() - lastGeo); if (wait > 0) await new Promise((ok) => setTimeout(ok, wait));
  lastGeo = Date.now();
  try {
    const u = `https://nominatim.openstreetmap.org/search?${new URLSearchParams({ q: place, format: 'json', limit: '1', countrycodes: 'us', viewbox: '-75.6,41.9,-71.7,40.3', bounded: '0' })}`;
    const arr = await (await fetch(u, { headers: { 'user-agent': 'EuclideanTargeting/1.0 (political ops mapping)' }, signal: AbortSignal.timeout(15000) })).json();
    const hit = arr?.[0] ? [Number(arr[0].lat), Number(arr[0].lon)] : null; geoCache.set(k, hit); return hit;
  } catch { geoCache.set(k, null); return null; }
}

const STATEWORDS = { 'new york city': 'NY', manhattan: 'NY', brooklyn: 'NY', queens: 'NY', bronx: 'NY', 'long island': 'NY', nassau: 'NY', suffolk: 'NY', 'new york': 'NY', connecticut: 'CT', hartford: 'CT', 'new haven': 'CT', bridgeport: 'CT', stamford: 'CT', 'new jersey': 'NJ', newark: 'NJ', 'jersey city': 'NJ' };
/** Without a brain: a place guess from the headline, time always TBD (never invented). */
function regexParse(items) {
  return items.map((it) => {
    const low = it.t.toLowerCase(); const hit = Object.keys(STATEWORDS).find((w) => low.includes(w));
    const scope = /nationwide|national/.test(low) ? 'national' : 'local';
    const place = hit ? hit.replace(/\b\w/g, (c) => c.toUpperCase()) : '';
    return { title: it.t.slice(0, 120), type: 'protest', scope, place: place || (scope === 'national' ? 'United States' : ''), city: place, state: hit ? STATEWORDS[hit] : '', date: '', time: 'TBD', url: it.url, status: 'rumored' };
  });
}

/** Scan, parse (HAL's brain if it's up, else the headline itself), geocode and merge into the map. */
async function protestScan(brainParse) {
  const items = await protestItems();
  if (!items.length) return { ok: false, added: 0, total: ctx.store.all('protests').length, msg: 'No feed items came back. Check the PC\'s internet and try again.' };
  let parsed = null; try { parsed = brainParse ? await brainParse(items) : null; } catch { parsed = null; }
  if (!Array.isArray(parsed) || !parsed.length) parsed = regexParse(items);
  const have = new Set(ctx.store.all('protests').map((p) => `${String(p.title).toLowerCase().slice(0, 50)}|${p.date || ''}`));
  let added = 0;
  for (const ev of parsed) {
    const title = String(ev.title || '').trim(); if (!title) continue;
    const sig = `${title.toLowerCase().slice(0, 50)}|${ev.date || ''}`; if (have.has(sig)) continue;
    const place = String(ev.place || ev.city || '').trim(); const scope = String(ev.scope || 'local').toLowerCase();
    let geo = place ? await geocode(place + (scope === 'national' ? ', USA' : '')) : null;
    if (!geo && scope === 'national') geo = [39.5, -98.35]; // US centre for a nationwide action
    if (!geo) continue; // no pin without a real place
    ctx.store.insert('protests', { title: title.slice(0, 140), type: String(ev.type || 'protest').toLowerCase(), scope, place, city: String(ev.city || ''), state: String(ev.state || '').toUpperCase(), date: String(ev.date || ''), time: String(ev.time || 'TBD') || 'TBD', lat: geo[0], lng: geo[1], url: String(ev.url || ''), status: String(ev.status || 'rumored').toLowerCase(), src: 'scan' });
    have.add(sig); added++;
  }
  const total = ctx.store.all('protests').length;
  return { ok: true, added, total, msg: added ? `Scan complete. ${added} new event${added === 1 ? '' : 's'} pinned (${total} on the map).` : `Scan complete. Nothing new; ${total} already on the map.` };
}

module.exports = { rss, topNews, newsAbout, newsFor, researchUrl, search, readPage, protestItems, protestScan, geocode, strip };
