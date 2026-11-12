'use strict';
/**
 * Serper (serper.dev): Google results through a paid key, about $1 per 1,000 searches (Nov 10, Ryan). DuckDuckGo stays the
 * free search for quick facts (websearch.search); Serper is for full inquiries and, mainly, Google's Videos tab, which
 * finds a candidate's public footage best: assembly and council sessions, hearings, campaign and news videos.
 *
 * Never wasteful: every query's answer is kept 14 days (the same search is never paid for twice), at most
 * `search.serper.perDay` searches a day (default 100), and callers ask once per candidate. Spend shows in Settings.
 */
const ctx = require('../core/ctx');
const secrets = require('../core/secrets');

const KEY = 'global.serper.apiKey';
const DAY = 86400000;
const S = (k, d) => ctx.setting(`search.serper.${k}`, d);

function connected() { return !!secrets.get(KEY); }

function usage() {
  const today = new Date().toISOString().slice(0, 10);
  const u = ctx.store.settings._serperUsage || {};
  return { today: u.day === today ? u.n || 0 : 0, total: u.total || 0, perDay: Number(S('perDay', 100)) || 100 };
}
function count() {
  const today = new Date().toISOString().slice(0, 10);
  const u = ctx.store.settings._serperUsage || {};
  ctx.store.settings._serperUsage = { day: today, n: (u.day === today ? u.n || 0 : 0) + 1, total: (u.total || 0) + 1 };
  ctx.store.touch();
}

/** One Serper call (kind: 'videos' | 'search' | 'news'), cached by its exact question for 14 days. */
async function ask(kind, q, { num = 20, gl = 'us' } = {}) {
  const key = secrets.get(KEY);
  if (!key) throw Object.assign(new Error('Serper isn\'t connected. Add the key in Settings → Connections → Web search.'), { notConnected: true });
  const ck = `${kind}|${gl}|${num}|${String(q).trim().toLowerCase()}`;
  const cache = ctx.store.settings._serperCache || {};
  if (cache[ck] && Date.now() - cache[ck].at < 14 * DAY) return cache[ck].data;
  const u = usage();
  if (u.today >= u.perDay) throw new Error(`Today's ${u.perDay} Serper searches are used up (Settings → Connections → Web search sets the limit). Free search is used until tomorrow.`);
  const res = await fetch(`https://google.serper.dev/${kind}`, { method: 'POST', headers: { 'X-API-KEY': key, 'content-type': 'application/json' }, body: JSON.stringify({ q, num, gl }), signal: AbortSignal.timeout(20000) });
  if (res.status === 401 || res.status === 403) throw new Error('Serper turned the key down. Check it in Settings → Connections → Web search.');
  if (!res.ok) throw new Error(`Serper answered ${res.status}`);
  const data = await res.json();
  count();
  const next = { ...cache, [ck]: { at: Date.now(), data } };
  const keys = Object.keys(next); if (keys.length > 500) for (const k of keys.sort((a, b) => next[a].at - next[b].at).slice(0, keys.length - 500)) delete next[k];
  ctx.store.settings._serperCache = next; ctx.store.touch();
  return data;
}

/** "12:34" / "1:02:03" → seconds. */
function seconds(d) { const p = String(d || '').split(':').map(Number); if (!p.length || p.some(isNaN)) return 0; return p.reduce((a, b) => a * 60 + b, 0); }

/** Google's Videos tab: [{ url, title, snippet, source, channel, duration (s), date }]. */
async function videos(q, opts = {}) {
  const d = await ask('videos', q, { num: 20, ...opts });
  return (d.videos || []).map((v) => ({ url: v.link, title: v.title || '', snippet: v.snippet || '', source: v.source || '', channel: v.channel || '', duration: seconds(v.duration), date: v.date || '' })).filter((v) => /^https?:\/\//.test(v.url));
}

/** Full web results: [{ title, url, snippet }]. */
async function search(q, opts = {}) {
  const d = await ask('search', q, { num: 10, ...opts });
  return (d.organic || []).map((r) => ({ title: r.title || '', url: r.link, snippet: r.snippet || '' })).filter((r) => /^https?:\/\//.test(r.url));
}

module.exports = { KEY, connected, usage, ask, videos, search, seconds };
