'use strict';
/**
 * Public-record lookup for a political figure. Everything here is public and
 * professional: office, party, district, committees, legislation, fundraising,
 * news, official/campaign sites and public contact addresses. No home
 * addresses, family or personal details are collected.
 *
 * Every fact carries the number of the source it came from, so the brief can
 * cite it. Each source is optional; whatever answers is used.
 */
const fs = require('fs');
const path = require('path');
const ctx = require('../core/ctx');
const secrets = require('../core/secrets');

const UA = 'EuclideanMedia/1.0 (outreach research; contact via official site)';
const KEYS = { dataGov: 'global.political.dataGovKey', openStates: 'global.political.openStatesKey' };

async function get(url, { json = true, timeoutMs = 15000, headers = {} } = {}) {
  const res = await fetch(url, { headers: { 'user-agent': UA, accept: json ? 'application/json' : '*/*', ...headers }, signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
  if (!res.ok) throw new Error(`${new URL(url).hostname} answered ${res.status}`);
  return json ? res.json() : res.text();
}

class Collector {
  constructor() { this.sources = []; this.facts = []; this.errors = []; this.text = []; }
  source(title, url) {
    const found = this.sources.find((s) => s.url === url);
    if (found) return found.n;
    const n = this.sources.length + 1; this.sources.push({ n, title, url }); return n;
  }
  fact(topic, text, src) { if (text) this.facts.push({ topic, text: String(text).trim(), src }); }
  raw(src, text) { if (text) this.text.push({ src, text: String(text).slice(0, 6000) }); }
}

// ------------------------------------------------------------------ Wikipedia / Wikidata

async function wikipedia(name, hint, c) {
  const q = encodeURIComponent(`${name} ${hint || 'politician'}`);
  const s = await get(`https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${q}&srlimit=3&format=json&origin=*`);
  const hit = (s.query?.search || []).find((x) => nameMatch(x.title, name)) || null;
  if (!hit) return null;
  const sum = await get(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(hit.title.replace(/ /g, '_'))}`);
  const url = sum.content_urls?.desktop?.page || `https://en.wikipedia.org/wiki/${encodeURIComponent(hit.title)}`;
  const n = c.source(`Wikipedia: ${sum.title}`, url);
  c.fact('overview', sum.extract, n); c.raw(n, sum.extract);
  if (sum.description) c.fact('role', sum.description, n);
  // A little more of the article for the writer (the intro sections).
  try {
    const ex = await get(`https://en.wikipedia.org/w/api.php?action=query&prop=extracts&explaintext=1&exsectionformat=plain&exchars=6000&titles=${encodeURIComponent(sum.title)}&format=json&origin=*`);
    const page = Object.values(ex.query?.pages || {})[0]; if (page?.extract) c.raw(n, page.extract);
  } catch { /* summary is enough */ }
  return { title: sum.title, qid: sum.wikibase_item || null, image: sum.originalimage?.source || sum.thumbnail?.source || null, description: sum.description || '' };
}

function nameMatch(title, name) {
  const t = title.toLowerCase(); const parts = String(name).toLowerCase().split(/\s+/).filter((p) => p.length > 1);
  return parts.length && parts.filter((p) => t.includes(p)).length >= Math.min(2, parts.length);
}

const WD = { position: 'P39', party: 'P102', website: 'P856', x: 'P2002', facebook: 'P2013', instagram: 'P2003', youtube: 'P2397', tiktok: 'P7085', bioguide: 'P1157', fec: 'P1839', image: 'P18', district: 'P768', start: 'P580', end: 'P582', email: 'P968' };

async function wikidata(qid, c) {
  const e = (await get(`https://www.wikidata.org/wiki/Special:EntityData/${qid}.json`)).entities?.[qid];
  if (!e) return {};
  const n = c.source(`Wikidata: ${e.labels?.en?.value || qid}`, `https://www.wikidata.org/wiki/${qid}`);
  const claims = e.claims || {};
  const val = (p) => (claims[p] || []).map((x) => x.mainsnak?.datavalue?.value).filter((v) => v != null);
  const ids = new Set();
  const current = (claims[WD.position] || []).filter((x) => !x.qualifiers?.[WD.end]).map((x) => ({ id: x.mainsnak?.datavalue?.value?.id, district: x.qualifiers?.[WD.district]?.[0]?.datavalue?.value?.id, start: x.qualifiers?.[WD.start]?.[0]?.datavalue?.value?.time }));
  current.forEach((p) => { if (p.id) ids.add(p.id); if (p.district) ids.add(p.district); });
  const parties = val(WD.party).map((v) => v.id); parties.forEach((x) => ids.add(x));
  let labels = {};
  if (ids.size) {
    const r = await get(`https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${[...ids].slice(0, 45).join('|')}&props=labels&languages=en&format=json&origin=*`);
    labels = Object.fromEntries(Object.entries(r.entities || {}).map(([k, v]) => [k, v.labels?.en?.value]));
  }
  const out = {
    positions: current.map((p) => [labels[p.id], p.district && labels[p.district]].filter(Boolean).join(', ')).filter(Boolean),
    party: labels[parties[parties.length - 1]] || null,
    website: val(WD.website)[0] || null,
    socials: { x: val(WD.x)[0], facebook: val(WD.facebook)[0], instagram: val(WD.instagram)[0], youtube: val(WD.youtube)[0], tiktok: val(WD.tiktok)[0] },
    bioguide: val(WD.bioguide)[0] || null, fec: val(WD.fec), image: val(WD.image)[0] || null, email: val(WD.email)[0] || null,
  };
  out.positions.forEach((p) => c.fact('office', `Holds: ${p}`, n));
  if (out.party) c.fact('party', `Party: ${out.party}`, n);
  if (out.website) c.fact('web', `Website: ${out.website}`, n);
  return out;
}

// ------------------------------------------------------------------ Congress / FEC / OpenStates

let legislators = null; let legislatorsAt = 0;
async function congressMember(bioguide, name, c) {
  if (!legislators || Date.now() - legislatorsAt > 864e5) {
    const cache = path.join(require('../core/paths').tmp('political'), 'legislators-current.json');
    try {
      legislators = await get('https://unitedstates.github.io/congress-legislators/legislators-current.json', { timeoutMs: 30000 });
      fs.writeFileSync(cache, JSON.stringify(legislators)); legislatorsAt = Date.now();
    } catch (e) { if (fs.existsSync(cache)) legislators = JSON.parse(fs.readFileSync(cache, 'utf8')); else throw e; }
  }
  const m = legislators.find((x) => (bioguide && x.id?.bioguide === bioguide) || (!bioguide && nameMatch(`${x.name.official_full || ''} ${x.name.first} ${x.name.last}`, name)));
  if (!m) return null;
  const t = m.terms[m.terms.length - 1];
  const n = c.source('U.S. Congress member data (congress-legislators)', 'https://github.com/unitedstates/congress-legislators');
  const office = t.type === 'sen' ? `U.S. Senator for ${t.state}` : `U.S. Representative for ${t.state}-${t.district === 0 ? 'At-large' : t.district}`;
  c.fact('office', `${office} (current term ${t.start} to ${t.end})`, n);
  c.fact('party', `Party: ${t.party}`, n);
  c.fact('tenure', `Has served ${m.terms.length} term${m.terms.length === 1 ? '' : 's'} in Congress since ${m.terms[0].start.slice(0, 4)}`, n);
  if (t.url) c.fact('web', `Official site: ${t.url}`, n);
  return { bioguide: m.id.bioguide, fec: m.id.fec || [], office, party: t.party, state: t.state, district: t.district, officialSite: t.url, officePhone: t.phone, contactForm: t.contact_form, photo: `https://theunitedstates.io/images/congress/450x550/${m.id.bioguide}.jpg` };
}

async function fecTotals(ids, c) {
  const key = secrets.get(KEYS.dataGov) || 'DEMO_KEY';
  for (const id of (ids || []).slice(-2).reverse()) {
    const r = await get(`https://api.open.fec.gov/v1/candidate/${id}/totals/?api_key=${key}&sort=-cycle&per_page=1`);
    const t = r.results?.[0]; if (!t) continue;
    const n = c.source(`FEC: candidate ${id}`, `https://www.fec.gov/data/candidate/${id}/`);
    const $ = (v) => (v == null ? null : `$${Math.round(v).toLocaleString('en-US')}`);
    c.fact('money', `${t.cycle} cycle: raised ${$(t.receipts)}, spent ${$(t.disbursements)}${t.last_cash_on_hand_end_period != null ? `, cash on hand ${$(t.last_cash_on_hand_end_period)}` : ''}`, n);
    return { cycle: t.cycle, raised: t.receipts, spent: t.disbursements, cash: t.last_cash_on_hand_end_period };
  }
  return null;
}

async function openStates(name, c) {
  const key = secrets.get(KEYS.openStates); if (!key) return null;
  const r = await get(`https://v3.openstates.org/people?name=${encodeURIComponent(name)}&include=links&include=offices&per_page=5`, { headers: { 'X-API-KEY': key } });
  const p = (r.results || []).find((x) => nameMatch(x.name, name)); if (!p) return null;
  const n = c.source(`Open States: ${p.name}`, p.openstates_url || `https://openstates.org/person/${p.id}`);
  const role = p.current_role ? `${p.current_role.title} for ${p.jurisdiction?.name || ''} district ${p.current_role.district}` : null;
  if (role) c.fact('office', role, n);
  if (p.party) c.fact('party', `Party: ${p.party}`, n);
  return { office: role, party: p.party, email: p.email || null, image: p.image || null, links: (p.links || []).map((l) => l.url) };
}

// ------------------------------------------------------------------ news & websites

async function news(name, office, c) {
  const xml = await get(`https://news.google.com/rss/search?q=${encodeURIComponent(`"${name}"`)}&hl=en-US&gl=US&ceid=US:en`, { json: false });
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 8).map((m) => {
    const g = (t) => (new RegExp(`<${t}>([\\s\\S]*?)</${t}>`).exec(m[1]) || [])[1] || '';
    return { title: decode(g('title')), url: decode(g('link')), date: g('pubDate') ? new Date(g('pubDate')).toISOString().slice(0, 10) : null, outlet: decode(g('source')) };
  }).filter((x) => x.title && x.url);
  for (const it of items) { const n = c.source(`${it.outlet || 'News'}: ${it.title}`, it.url); c.fact('news', `${it.date || ''} ${it.title}`.trim(), n); }
  return items;
}
const decode = (s) => String(s).replace(/<!\[CDATA\[|\]\]>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();

const SOCIAL_RX = /https?:\/\/(?:www\.)?(?:x|twitter|facebook|instagram|youtube|tiktok|threads)\.(?:com|net)\/[A-Za-z0-9_.@\/-]+/g;
async function website(url, c, label) {
  const found = { emails: [], socials: [], brand: null, image: null };
  const pages = [url, new URL('/contact', url).href, new URL('/contact-us', url).href];
  for (const p of pages) {
    let html; try { html = await get(p, { json: false, timeoutMs: 12000 }); } catch { continue; }
    const n = c.source(`${label}: ${new URL(p).hostname}${new URL(p).pathname === '/' ? '' : new URL(p).pathname}`, p);
    const text = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    if (p === url) {
      // Sites built with JavaScript come back nearly empty; read those through Jina Reader (anonymous, public pages only).
      let body = text;
      if (body.trim().length < 600 && ctx.setting('political.jinaReader', true)) {
        try { const md = await get(`https://r.jina.ai/${url}`, { json: false, timeoutMs: 25000, headers: { accept: 'text/plain' } }); if (md && md.length > body.length) { body = md; for (const m of md.matchAll(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g)) found.emails.push({ email: m[0].toLowerCase(), src: n, page: p }); } } catch { /* reader unavailable */ }
      }
      c.raw(n, body.slice(0, 5000));
      // Brand colour: the site's theme-color, else its most used saturated colour.
      const tc = /<meta[^>]+name=["']theme-color["'][^>]+content=["'](#[0-9a-f]{6})/i.exec(html) || /<meta[^>]+content=["'](#[0-9a-f]{6})["'][^>]+name=["']theme-color/i.exec(html);
      if (tc) found.brand = tc[1].toLowerCase();
      // The site's share image (usually the candidate) for the ads, credited to the campaign.
      const og = /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)/i.exec(html) || /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image/i.exec(html) || /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)/i.exec(html);
      if (og) { try { found.image = new URL(og[1].replace(/&amp;/g, '&'), p).href; } catch { /* bad url */ } }
      else {
        const counts = {};
        for (const m of html.matchAll(/#([0-9a-f]{6})\b/gi)) {
          const hx = m[1].toLowerCase(); const [r, g, b] = [0, 2, 4].map((i) => parseInt(hx.substr(i, 2), 16));
          const mx = Math.max(r, g, b); const mn = Math.min(r, g, b);
          if (mx - mn > 60 && mx > 60 && mx < 250) counts[hx] = (counts[hx] || 0) + 1;
        }
        const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]; if (top && top[1] >= 3) found.brand = `#${top[0]}`;
      }
    }
    for (const m of html.matchAll(/mailto:([^"'?>\s]+)/gi)) found.emails.push({ email: decodeURIComponent(m[1]).toLowerCase(), src: n, page: p });
    for (const m of text.matchAll(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g)) found.emails.push({ email: m[0].toLowerCase(), src: n, page: p });
    for (const m of html.matchAll(SOCIAL_RX)) found.socials.push(m[0].replace(/\/$/, ''));
  }
  found.emails = dedupe(found.emails, (e) => e.email).filter((e) => !/\.(png|jpg|gif|webp)$/.test(e.email) && !/example\.|sentry|wixpress|domain\.com/.test(e.email));
  found.socials = [...new Set(found.socials)].filter((s) => !/\/(share|sharer|intent|plugins|tr)\b/.test(s)).slice(0, 10);
  return found;
}
const dedupe = (arr, key) => { const seen = new Set(); return arr.filter((x) => { const k = key(x); if (seen.has(k)) return false; seen.add(k); return true; }); };

/** Rank contact emails: campaign/press first, official .gov last (we pitch campaigns, not government offices). */
function bestContact(emails) {
  const score = (e) => (/\.gov$|\.gov\./.test(e.email) ? -10 : 0) + (/press|media|comms|communications/.test(e.email) ? 5 : 0) + (/info|contact|hello|team|campaign/.test(e.email) ? 3 : 0) + (/noreply|no-reply|donotreply/.test(e.email) ? -20 : 0);
  return [...emails].sort((a, b) => score(b) - score(a));
}

async function download(url, file) {
  const res = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`photo ${res.status}`);
  if (!/^image\//.test(res.headers.get('content-type') || 'image/')) throw new Error('not an image');
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 6000) throw new Error('image too small');
  fs.writeFileSync(file, buf);
  return file;
}

// ------------------------------------------------------------------ main

/**
 * Look up a political figure. hint: office/state to disambiguate. campaignSite: optional URL you already know.
 * Returns { profile, sources, facts, text, errors }.
 */
async function lookup({ name, hint, campaignSite, dir, onStep = () => {} }) {
  const c = new Collector();
  const tryStep = async (label, fn) => { onStep(label); try { return await fn(); } catch (e) { c.errors.push(`${label}: ${e.message}`); return null; } };
  const wp = await tryStep('Wikipedia', () => wikipedia(name, hint, c));
  const wd = wp?.qid ? await tryStep('Wikidata', () => wikidata(wp.qid, c)) : null;
  const cong = await tryStep('Congress', () => congressMember(wd?.bioguide, name, c));
  const os = await tryStep('Open States', () => openStates(name, c));
  const money = await tryStep('FEC', () => fecTotals([...(cong?.fec || []), ...(wd?.fec || [])], c));
  const headlines = await tryStep('News', () => news(name, cong?.office, c));
  const sites = [...new Set([campaignSite, wd?.website, cong?.officialSite, ...(os?.links || [])].filter(Boolean))].slice(0, 3);
  const emails = []; const socials = []; let brand = null; let siteImage = null;
  for (const s of sites) { const r = await tryStep(`Website ${s}`, () => website(s, c, s === campaignSite ? 'Campaign site' : 'Website')); if (r) { emails.push(...r.emails); socials.push(...r.socials); brand = brand || r.brand; siteImage = siteImage || (r.image ? { url: r.image, site: s } : null); } }
  if (os?.email) emails.push({ email: os.email.toLowerCase(), src: c.sources.find((s) => /Open States/.test(s.title))?.n, page: 'Open States' });
  if (wd?.email) emails.push({ email: String(wd.email).replace(/^mailto:/, '').toLowerCase(), src: c.sources.find((s) => /Wikidata/.test(s.title))?.n, page: 'Wikidata' });
  const socialLinks = [...new Set([...socials,
    wd?.socials?.x && `https://x.com/${wd.socials.x}`, wd?.socials?.instagram && `https://instagram.com/${wd.socials.instagram}`,
    wd?.socials?.facebook && `https://facebook.com/${wd.socials.facebook}`, wd?.socials?.tiktok && `https://tiktok.com/@${wd.socials.tiktok}`,
    wd?.socials?.youtube && `https://youtube.com/channel/${wd.socials.youtube}`].filter(Boolean))];

  // Photo: official congressional portrait (public domain), else Open States, else Wikipedia/Wikimedia (credit kept).
  let photo = null; let photoCredit = null; const photos = [];
  if (dir) {
    // Collect every usable photo (up to 4); the first is the main one. Campaign-site images are credited to the campaign.
    const cands = [[cong?.photo, 'Official U.S. Congress portrait'], [os?.image, 'Open States'], [wp?.image, 'Wikimedia Commons'], ...(ctx.setting('political.campaignPhotos', true) && siteImage ? [[siteImage.url, `Campaign website (${new URL(siteImage.site).hostname})`]] : [])];
    for (const [u, credit] of cands) {
      if (!u || photos.length >= 4) continue;
      let ext = '.jpg'; try { ext = (path.extname(new URL(u).pathname).slice(0, 5) || '.jpg').toLowerCase(); } catch { continue; }
      if (!/\.(jpe?g|png|webp)$/.test(ext)) ext = '.jpg';
      const file = path.join(dir, `photo${photos.length ? photos.length + 1 : ''}${ext}`);
      if (await tryStep('Photo', () => download(u, file))) { photos.push({ file, credit, url: u }); if (!photo) { photo = file; photoCredit = credit; } }
    }
  }
  const ranked = bestContact(dedupe(emails, (e) => e.email));
  const profile = {
    name, office: cong?.office || os?.office || wd?.positions?.[0] || wp?.description || hint || '', party: cong?.party || os?.party || wd?.party || '',
    state: cong?.state || null, district: cong?.district ?? null, level: cong ? 'federal' : os ? 'state' : 'unknown',
    sites, socials: socialLinks, emails: ranked, contact: ranked[0]?.email || null,
    officePhone: cong?.officePhone || null, contactForm: cong?.contactForm || null,
    money, news: headlines || [], photo, photoCredit, photos, wikipedia: wp?.title || null, brand,
  };
  return { profile, sources: c.sources, facts: c.facts, text: c.text, errors: c.errors };
}

/** Lead discovery from public rosters (Open States by state/chamber) plus the research agent. */
async function rosterSearch({ state, chamber, limit = 30 }) {
  const key = secrets.get(KEYS.openStates); if (!key) return [];
  const juris = encodeURIComponent(String(state || '').toLowerCase());
  const r = await get(`https://v3.openstates.org/people?jurisdiction=${juris}${chamber ? `&org_classification=${chamber}` : ''}&per_page=${Math.min(50, limit)}`, { headers: { 'X-API-KEY': key } });
  return (r.results || []).map((p) => ({ name: p.name, office: p.current_role ? `${p.current_role.title}, district ${p.current_role.district}` : '', party: p.party, email: p.email || '', url: p.openstates_url }));
}

module.exports = { lookup, rosterSearch, bestContact, website, KEYS, nameMatch };
