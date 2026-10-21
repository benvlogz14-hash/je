'use strict';
/**
 * Finding real images without paid keys.
 *
 *  - Candidate photos: tries every free source, verifies each download is a
 *    real photo with exactly one clear face, and ranks the results. Sources:
 *    Ballotpedia headshots, official portraits, Wikipedia/Wikimedia,
 *    the campaign website (share image and named <img> tags), and DuckDuckGo
 *    image search as the last resort.
 *  - Background images: stock-style photos of the place (town, state,
 *    capitol) from Openverse and Wikimedia Commons (openly licensed, credited),
 *    or a Pexels key if you add one.
 */
const fs = require('fs');
const path = require('path');
const ctx = require('../core/ctx');
const secrets = require('../core/secrets');
const ff = require('../video/ffmpeg');
const { run } = require('../core/util');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
const PEXELS = 'global.pexels.apiKey';

async function get(url, { json = false, timeoutMs = 15000, headers = {} } = {}) {
  const res = await fetch(url, { headers: { 'user-agent': UA, ...headers }, signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
  if (!res.ok) throw new Error(`${new URL(url).hostname} ${res.status}`);
  return json ? res.json() : res.text();
}

async function download(url, file) {
  const res = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`image ${res.status}`);
  if (!/^image\//.test(res.headers.get('content-type') || 'image/')) throw new Error('not an image');
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 6000) throw new Error('too small');
  fs.writeFileSync(file, buf);
  return file;
}

async function dims(file) {
  try {
    const r = await run(ff.bin('ffprobe'), ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file], { timeoutMs: 15000 });
    const [w, h] = r.out.trim().split(',').map(Number); return { w, h };
  } catch { return { w: 0, h: 0 }; }
}

const lastName = (n) => String(n).trim().split(/\s+/).slice(-1)[0].toLowerCase().replace(/[^a-z]/g, '');

// ------------------------------------------------------------------ candidate photo sources

async function ballotpedia(name) {
  const html = await get(`https://ballotpedia.org/${encodeURIComponent(name.trim().replace(/\s+/g, '_'))}`);
  const og = /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)/i.exec(html);
  if (og && !/ballotpedia[-_]?logo|Ballotpedia_Logo|default/i.test(og[1])) return [{ url: og[1], credit: 'Ballotpedia', score: 9 }];
  const img = /<img[^>]+class=["'][^"']*widget-img[^"']*["'][^>]+src=["']([^"']+)/i.exec(html);
  return img ? [{ url: new URL(img[1], 'https://ballotpedia.org').href, credit: 'Ballotpedia', score: 8 }] : [];
}

async function wikimedia(name) {
  const out = [];
  const s = await get(`https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(`${name} politician`)}&srlimit=2&format=json&formatversion=2`, { json: true });
  for (const t of (s.query?.search || []).map((x) => x.title)) {
    if (!t.toLowerCase().includes(lastName(name))) continue;
    const d = await get(`https://en.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(t)}&prop=pageimages&piprop=original&pilicense=any&format=json&formatversion=2`, { json: true });
    const src = d.query?.pages?.[0]?.original?.source; if (src) out.push({ url: src, credit: 'Wikimedia Commons', score: 8 });
  }
  const c = await get(`https://commons.wikimedia.org/w/api.php?action=query&format=json&formatversion=2&generator=search&gsrsearch=${encodeURIComponent(`"${name}"`)}&gsrnamespace=6&gsrlimit=6&prop=imageinfo&iiprop=url|mime&iiurlwidth=1400`, { json: true });
  for (const p of (c.query?.pages || []).sort((a, b) => (a.index || 0) - (b.index || 0))) {
    const ii = p.imageinfo?.[0]; if (/image\/(jpeg|png|webp)/.test(ii?.mime || '') && p.title.toLowerCase().includes(lastName(name))) out.push({ url: ii.thumburl || ii.url, credit: 'Wikimedia Commons', score: 6 });
  }
  return out;
}

/** Share image plus any <img> whose alt/file name contains their last name. */
async function campaignSite(name, site) {
  const html = await get(site);
  const out = []; const ln = lastName(name);
  const og = /<meta[^>]+(?:property|name)=["'](?:og:image|twitter:image)["'][^>]+content=["']([^"']+)/i.exec(html) || /<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["'](?:og:image|twitter:image)/i.exec(html);
  if (og) out.push({ url: new URL(og[1].replace(/&amp;/g, '&'), site).href, credit: `Campaign website (${new URL(site).hostname})`, score: 7 });
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0]; const src = /\s(?:data-src|src)=["']([^"']+)["']/i.exec(tag)?.[1]; const alt = /\salt=["']([^"']*)["']/i.exec(tag)?.[1] || '';
    if (!src || /logo|icon|sprite|\.svg/i.test(src)) continue;
    if (`${alt} ${src}`.toLowerCase().includes(ln)) out.push({ url: new URL(src.replace(/&amp;/g, '&'), site).href, credit: `Campaign website (${new URL(site).hostname})`, score: 7.5 });
    if (out.length > 6) break;
  }
  return out;
}

/** DuckDuckGo image search (no key). Last resort, since results may be anyone. */
async function ddgImages(query, n = 6) {
  const page = await get(`https://duckduckgo.com/?q=${encodeURIComponent(query)}&iax=images&ia=images`);
  const vqd = /vqd=["']?([\d-]+)/.exec(page)?.[1]; if (!vqd) return [];
  const j = await get(`https://duckduckgo.com/i.js?l=us-en&o=json&q=${encodeURIComponent(query)}&vqd=${vqd}&f=,,,,,&p=1`, { json: true, headers: { referer: 'https://duckduckgo.com/' } });
  return (j.results || []).slice(0, n).map((r) => ({ url: r.image, credit: `Found online (${(() => { try { return new URL(r.url).hostname; } catch { return 'web'; } })()})`, score: 4, title: r.title }));
}

/**
 * Try every source until a verified photo is found. Returns [{ file, credit, url, faces }] best first.
 * known: URLs already found by the research step (official portrait etc.).
 */
async function findCandidatePhotos({ name, office, sites = [], known = [], dir, want = 3, onStep = () => {} }) {
  fs.mkdirSync(dir, { recursive: true });
  const tried = new Set(); const good = []; const errors = [];
  const facetrack = require('../video/facetrack');
  const consider = async (list) => {
    for (const c of list.sort((a, b) => b.score - a.score)) {
      if (good.length >= want || !c.url || tried.has(c.url)) continue; tried.add(c.url);
      const file = path.join(dir, `found${tried.size}.jpg`);
      try {
        await download(c.url, file);
        const { w, h } = await dims(file);
        if (Math.min(w, h) < 240 || w / h > 2.2 || h / w > 2.6) { fs.unlinkSync(file); continue; }
        const faces = await facetrack.facesInImage(file);
        // Exactly one clear face (group photos and logos are skipped). If the face model can't load, accept and rank lower.
        if (faces && faces.length !== 1) { fs.unlinkSync(file); continue; }
        good.push({ file, credit: c.credit, url: c.url, faces: faces ? 1 : null, score: c.score + (faces ? 1 : 0) });
      } catch (e) { errors.push(e.message); try { fs.unlinkSync(file); } catch { /* none */ } }
    }
  };
  const step = async (label, fn) => { if (good.length >= want) return; onStep(label); try { await consider(await fn()); } catch (e) { errors.push(`${label}: ${e.message}`); } };
  await step('Photos you already had', async () => known.map((k) => ({ ...k, score: k.score ?? 9 })));
  await step('Ballotpedia', () => ballotpedia(name));
  await step('Wikipedia', () => wikimedia(name));
  for (const s of sites.slice(0, 2)) await step(`Campaign website ${s}`, () => campaignSite(name, s));
  await step('Web image search', () => ddgImages(`${name} ${office || 'candidate'} headshot`));
  if (!good.length) await step('Web image search (wider)', () => ddgImages(`"${name}" ${String(office || '').split(/[,·]/)[0]}`));
  return { photos: good.sort((a, b) => b.score - a.score), errors };
}

// ------------------------------------------------------------------ background images

async function openverse(q, n) {
  const j = await get(`https://api.openverse.org/v1/images/?q=${encodeURIComponent(q)}&page_size=${n}&license_type=commercial,modification&aspect_ratio=wide&size=large`, { json: true });
  return (j.results || []).map((r) => ({ url: r.url, credit: `${r.title || 'Photo'} by ${r.creator || 'unknown'} (${String(r.license || '').toUpperCase()} ${r.license_version || ''}, Openverse)`.trim() }));
}
async function commons(q, n) {
  const j = await get(`https://commons.wikimedia.org/w/api.php?action=query&format=json&formatversion=2&generator=search&gsrsearch=${encodeURIComponent(q)}&gsrnamespace=6&gsrlimit=${n}&prop=imageinfo&iiprop=url|mime|extmetadata&iiurlwidth=1920`, { json: true });
  return (j.query?.pages || []).filter((p) => /image\/jpeg/.test(p.imageinfo?.[0]?.mime || '')).map((p) => { const ii = p.imageinfo[0]; const m = ii.extmetadata || {}; const strip = (x) => String(x?.value || '').replace(/<[^>]+>/g, '').trim(); return { url: ii.thumburl || ii.url, credit: `${strip(m.Artist).slice(0, 60) || 'Wikimedia Commons'} (${strip(m.LicenseShortName) || 'see Commons'})` }; });
}
async function pexels(q, n) {
  const key = secrets.get(PEXELS); if (!key) return [];
  const j = await get(`https://api.pexels.com/v1/search?query=${encodeURIComponent(q)}&per_page=${n}&orientation=landscape`, { json: true, headers: { authorization: key } });
  return (j.photos || []).map((p) => ({ url: p.src?.large2x || p.src?.original, credit: `Photo by ${p.photographer} on Pexels` }));
}

/**
 * Stock-style background photos for the ads, e.g. the candidate's town, state capitol, or an issue.
 * queries: tried in order until `want` images are saved. Returns [{ file, credit }].
 */
async function findBackgrounds({ queries, dir, want = 4, onStep = () => {} }) {
  fs.mkdirSync(dir, { recursive: true });
  const out = []; const seen = new Set(); const errors = [];
  for (const q of queries.filter(Boolean)) {
    if (out.length >= want) break;
    onStep(`Background photos: ${q}`);
    let list = [];
    for (const src of [pexels, openverse, commons]) { try { list = list.concat(await src(q, 6)); } catch (e) { errors.push(e.message); } if (list.length >= 4) break; }
    for (const c of list) {
      if (out.length >= want || !c.url || seen.has(c.url)) continue; seen.add(c.url);
      const file = path.join(dir, `bg${out.length + 1}.jpg`);
      try { await download(c.url, file); const { w, h } = await dims(file); if (w < 900 || w < h) { fs.unlinkSync(file); continue; } out.push({ file, credit: c.credit, query: q }); } catch (e) { errors.push(e.message); }
    }
  }
  return { backgrounds: out, errors };
}

module.exports = { findCandidatePhotos, findBackgrounds, ddgImages, PEXELS };
