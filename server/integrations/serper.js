'use strict';
/**
 * Google results through Serper (serper.dev): the "full inquiry" search. DuckDuckGo (websearch.js) stays the free
 * default for quick facts and summaries; Serper is used when a job needs Google's own results, above all the Videos tab,
 * which lists a politician's public footage (floor sessions, hearings, council meetings, interviews, campaign videos).
 *
 * About $1 per 1,000 searches, so every call is streamlined:
 *  - results are cached on disk (<data>/serper/cache.json): the same search is never paid for twice within its time
 *    (videos and web 14 days, news 6 hours);
 *  - a monthly and a daily cap (`serper.monthlyCap`, default 2,000 ≈ $2; `serper.dailyCap`, default 300); over a cap, or
 *    with no key, callers fall back to DuckDuckGo instead of failing;
 *  - each paid search is counted (`settings._serper`) and recorded in AI usage (provider 'serper', `serper.costPer1000`).
 * Key: Settings → Connections → Google search (Serper) (`global.serper.apiKey`).
 */
const fs = require('fs');
const path = require('path');
const ctx = require('../core/ctx');
const paths = require('../core/paths');
const secrets = require('../core/secrets');
const safe = require('./safefetch');

const KEY = 'global.serper.apiKey';
const TYPES = { search: 14, videos: 14, news: 0.25, images: 14, places: 30, scholar: 30 }; // days cached
const base = () => process.env.EUCLIDEAN_SERPER_URL || 'https://google.serper.dev';

const ready = () => secrets.has(KEY) || !!process.env.EUCLIDEAN_SERPER_KEY;
const keyOf = () => process.env.EUCLIDEAN_SERPER_KEY || secrets.get(KEY);

// ------------------------------------------------------------------ cache (on disk, survives restarts)
let cache = null; let dirty = false;
const cacheFile = () => { const d = path.join(paths.root, 'serper'); fs.mkdirSync(d, { recursive: true }); return path.join(d, 'cache.json'); };
function loadCache() { if (cache) return cache; try { cache = JSON.parse(fs.readFileSync(cacheFile(), 'utf8')); } catch { cache = {}; } return cache; }
function saveCache() {
  if (!dirty) return; dirty = false;
  const c = loadCache(); const keys = Object.keys(c);
  if (keys.length > 3000) keys.sort((a, b) => c[a].at - c[b].at).slice(0, keys.length - 3000).forEach((k) => delete c[k]);
  try { fs.writeFileSync(cacheFile(), JSON.stringify(c)); } catch { /* next time */ }
}
setInterval(saveCache, 30000).unref?.();

// ------------------------------------------------------------------ budget
const month = () => new Date().toISOString().slice(0, 7);
const day = () => new Date().toISOString().slice(0, 10);
function counts() { const s = ctx.store?.settings?._serper || {}; return { month: s.month === month() ? s.monthCount || 0 : 0, day: s.day === day() ? s.dayCount || 0 : 0 }; }
function caps() { return { month: Number(ctx.setting?.('serper.monthlyCap', 2000)) || 2000, day: Number(ctx.setting?.('serper.dailyCap', 300)) || 300 }; }
function count() {
  const c = counts();
  ctx.store.setSettings({ _serper: { month: month(), monthCount: c.month + 1, day: day(), dayCount: c.day + 1 } });
  try { require('./ai').recordUsage({ provider: 'serper', model: 'google', role: 'search', inTok: 0, outTok: 0, costUsd: Number(ctx.setting('serper.costPer1000', 1)) / 1000, kind: 'search' }); } catch { /* usage is best-effort */ }
}
/** Why Serper can't be used right now, or null. */
function blocked() {
  if (!ready()) return 'No Serper key yet (Settings → Connections → Google search).';
  const c = counts(); const cap = caps();
  if (c.month >= cap.month) return `This month's Google search limit (${cap.month}) is used up. Raise it in Settings → Connections → Google search.`;
  if (c.day >= cap.day) return `Today's Google search limit (${cap.day}) is used up.`;
  return null;
}

/**
 * One Google search. type: search | videos | news | images | places | scholar. opts: num (10-100), gl, hl, tbs
 * (e.g. 'qdr:w' for the past week), page. Returns Serper's JSON plus `cached: true` when it came from the cache.
 */
async function query(type, q, { num = 10, gl = 'us', hl = 'en', tbs = null, page = 1 } = {}) {
  if (!TYPES[type]) throw new Error(`Unknown Google search type ${type}.`);
  q = String(q || '').replace(/\s+/g, ' ').trim().slice(0, 400); if (!q) throw new Error('Nothing to search for.');
  const body = { q, num: Math.max(10, Math.min(100, num)), gl, hl, ...(tbs ? { tbs } : {}), ...(page > 1 ? { page } : {}) };
  const ck = `${type}|${JSON.stringify(body).toLowerCase()}`;
  const c = loadCache()[ck];
  if (c && Date.now() - c.at < TYPES[type] * 86400000) return { ...c.data, cached: true };
  const why = blocked(); if (why) throw Object.assign(new Error(why), { serperBlocked: true });
  const r = await safe.get(`${base()}/${type}`, { method: 'POST', body: JSON.stringify(body), headers: { 'x-api-key': keyOf(), 'content-type': 'application/json', accept: 'application/json' }, timeout: 20000 });
  if (r.status === 401 || r.status === 403) throw Object.assign(new Error('Serper turned the key down. Check it in Settings → Connections → Google search.'), { serperBlocked: true });
  if (r.status === 429) throw Object.assign(new Error('Serper says too many searches right now, or the credits ran out (serper.dev → Billing).'), { serperBlocked: true });
  if (r.status >= 400) throw new Error(`Google search failed (${r.status}).`);
  let data; try { data = JSON.parse(r.text); } catch { throw new Error('Google search sent back something unreadable.'); }
  count();
  loadCache()[ck] = { at: Date.now(), data }; dirty = true; saveCache();
  return data;
}

/** Web results in the same shape as DuckDuckGo's: [{ title, url, snippet, date }], plus the answer box / knowledge panel. */
async function web(q, { num = 10, recent = null } = {}) {
  const tbs = { day: 'qdr:d', week: 'qdr:w', month: 'qdr:m', year: 'qdr:y' }[recent] || null;
  const d = await query('search', q, { num, tbs });
  const results = (d.organic || []).map((x) => ({ title: x.title, url: x.link, snippet: x.snippet || '', date: x.date || '' }));
  const box = d.answerBox ? { text: d.answerBox.answer || d.answerBox.snippet || '', url: d.answerBox.link || '', title: d.answerBox.title || '' } : null;
  const kg = d.knowledgeGraph ? { title: d.knowledgeGraph.title, type: d.knowledgeGraph.type, text: d.knowledgeGraph.description || '', url: d.knowledgeGraph.descriptionLink || d.knowledgeGraph.website || '', facts: d.knowledgeGraph.attributes || {} } : null;
  return { results, box, kg, cached: !!d.cached };
}

/** Google's Videos tab: [{ title, url, snippet, source, channel, duration (s), date, image }]. */
async function videos(q, { num = 20, recent = null } = {}) {
  const tbs = { day: 'qdr:d', week: 'qdr:w', month: 'qdr:m', year: 'qdr:y' }[recent] || null;
  const d = await query('videos', q, { num, tbs });
  const secs = (s) => { const p = String(s || '').split(':').map(Number); return p.some(isNaN) ? 0 : p.reduce((t, v) => t * 60 + v, 0); };
  return { cached: !!d.cached, videos: (d.videos || []).map((v) => ({ title: v.title || '', url: v.link || '', snippet: v.snippet || '', source: v.source || '', channel: v.channel || '', duration: secs(v.duration), date: v.date || '', image: v.imageUrl || '' })).filter((v) => /^https?:/.test(v.url)) };
}

async function news(q, { num = 10 } = {}) { const d = await query('news', q, { num }); return (d.news || []).map((x) => ({ title: x.title, url: x.link, snippet: x.snippet || '', source: x.source || '', date: x.date || '' })); }

function status() { const c = counts(); const cap = caps(); return { connected: ready(), month: c.month, day: c.day, monthlyCap: cap.month, dailyCap: cap.day, cached: Object.keys(loadCache()).length, costThisMonth: Math.round(c.month * Number(ctx.setting?.('serper.costPer1000', 1)) / 10) / 100, blocked: blocked() }; }

/** Check a key with one real (cheap) search. */
async function test() { if (!ready()) return { ok: false, error: 'Paste your Serper key first.' }; try { const d = await query('search', 'Euclidean Media', { num: 10 }); return { ok: true, results: (d.organic || []).length }; } catch (e) { return { ok: false, error: e.message }; } }

module.exports = { KEY, ready, blocked, query, web, videos, news, status, test };
