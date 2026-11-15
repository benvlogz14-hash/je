'use strict';
/**
 * Free stats for the shorts we posted: no API keys, no tokens (Nov 15, Ryan: "make the subagents refresh data in
 * analytics as long as Euclidean is open ... for no tokens, using DuckDuckGo instead of the Google API").
 * Done by Data Bot on this PC, while the app is open, every `analytics.publicEveryMin` (120):
 *  1. each published post's public link: the one saved when Euclidean uploaded it, else one found before, else
 *     found now: the client's YouTube channel's Shorts list (yt-dlp, matched by title), then a DuckDuckGo search for
 *     the title (YouTube / TikTok / Instagram links whose title matches);
 *  2. the public numbers off that page with yt-dlp (views, likes, comments; no login), else YouTube's page itself.
 * Numbers from YouTube's own API (a connected channel) or Ayrshare are kept when they're newer: these only fill in.
 * Nothing is written by an AI: matching and reading are plain code.
 */
const ctx = require('../core/ctx');
const audit = require('../core/audit');
const events = require('../core/events');
const { run } = require('../core/util');

const NAME = 'Data Bot';
const words = (s) => String(s || '').toLowerCase().replace(/&amp;/g, '&').replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w));
const STOP = new Set(['the', 'and', 'for', 'with', 'you', 'this', 'that', 'part', 'shorts', 'short', 'youtube', 'tiktok', 'video', 'from', 'was', 'are']);
/** How much two titles share (0-1), measured on the shorter one. */
function like(a, b) {
  const A = new Set(words(a)); const B = new Set(words(b)); if (!A.size || !B.size) return 0;
  let n = 0; for (const w of A) if (B.has(w)) n++;
  return n / Math.min(A.size, B.size);
}
function platformOf(url) {
  const u = String(url || '');
  if (/youtube\.com|youtu\.be/i.test(u)) return 'youtube';
  if (/tiktok\.com/i.test(u)) return 'tiktok';
  if (/instagram\.com/i.test(u)) return 'instagram';
  if (/facebook\.com|fb\.watch/i.test(u)) return 'facebook';
  return null;
}
/** A link that points at one video (not a channel or a search page). */
const isVideo = (u) => /youtube\.com\/(shorts\/|watch\?v=)|youtu\.be\/|tiktok\.com\/@[\w.-]+\/video\/\d+|instagram\.com\/(reel|p)\/|facebook\.com\/.+\/videos\/|fb\.watch\//i.test(String(u || ''));

/** Every title this post might go by on the platforms. */
function titlesOf(post) {
  const clip = post.clipId ? ctx.store.get('clips', post.clipId) : null;
  return [post.yt?.title, post.title, clip?.title, clip?.hook, String(post.caption || '').split('\n')[0]].map((t) => String(t || '').replace(/\s*·\s*Part \d+$/i, '').trim()).filter((t) => t.length > 5);
}

/** The links we already know for a post: { platform: url }. */
function knownLinks(post) {
  const out = { ...(post.publicUrls || {}) };
  for (const [plat, r] of Object.entries(post.results || {})) {
    if (r?.url && !out[plat]) out[plat] = r.url;
    else if (plat === 'youtube' && r?.id && !out.youtube) out.youtube = `https://www.youtube.com/shorts/${r.id}`;
  }
  return out;
}

const ytdlp = () => (ctx.capabilities.ytdlp ? require('../video/ffmpeg').ytdlpBin() : null);

/** The client's channel Shorts (title + link), read once per run. */
async function channelShorts(client, memo) {
  const url = client?.production?.channelUrl; if (!url || !ytdlp()) return [];
  if (memo.has(client.id)) return memo.get(client.id);
  let list = [];
  try {
    const r = await run(ytdlp(), ['--flat-playlist', '--dump-single-json', '--playlist-end', '200', `${String(url).replace(/\/+$/, '').replace(/\/(videos|shorts|featured|streams)$/, '')}/shorts`], { timeoutMs: 120000 });
    const j = JSON.parse(r.out || '{}');
    list = (j.entries || []).filter((e) => e && e.id).map((e) => ({ title: e.title || '', url: `https://www.youtube.com/shorts/${e.id}`, views: Number.isFinite(e.view_count) ? e.view_count : null }));
  } catch { /* channel not readable: the search still runs */ }
  memo.set(client.id, list);
  return list;
}

/** Find a post's public links: the channel's Shorts first, then DuckDuckGo. */
async function findLinks(post, client, memo) {
  const titles = titlesOf(post); if (!titles.length) return {};
  const found = {};
  const best = (items) => {
    let top = null;
    for (const it of items) { const s = Math.max(...titles.map((t) => like(t, it.title))); if (s >= 0.6 && (!top || s > top.s)) top = { ...it, s }; }
    return top;
  };
  const shorts = await channelShorts(client, memo);
  const onChannel = best(shorts.filter((x) => !memo.taken.has(x.url)));
  if (onChannel) found.youtube = onChannel.url;
  const ws = require('../integrations/websearch');
  for (const q of [`"${titles[0]}" ${client?.name || ''}`.trim(), `${titles[0]} shorts`]) {
    if (Object.keys(found).length >= 2) break;
    let results = [];
    try { results = await ws.search(q, 10); } catch { break; }
    const hit = best(results.filter((x) => isVideo(x.url) && !memo.taken.has(x.url) && !found[platformOf(x.url)]).map((x) => ({ title: `${x.title} ${x.snippet || ''}`, url: x.url })));
    if (hit) found[platformOf(hit.url)] = hit.url;
  }
  for (const u of Object.values(found)) memo.taken.add(u);
  return found;
}

/** The public numbers on one video's page: { views, likes, comments } (null when a number isn't shown). */
async function readNumbers(url) {
  const n = (x) => (Number.isFinite(Number(x)) && x !== null && x !== '' ? Number(x) : null);
  if (ytdlp()) {
    try {
      const r = await run(ytdlp(), ['-J', '--skip-download', '--no-playlist', '--no-warnings', url], { timeoutMs: 90000 });
      const j = JSON.parse(r.out || '{}');
      if (j && (j.view_count != null || j.like_count != null)) return { views: n(j.view_count), likes: n(j.like_count), comments: n(j.comment_count), shares: n(j.repost_count) };
    } catch { /* try the page */ }
  }
  if (platformOf(url) === 'youtube') {
    const html = (await require('../integrations/safefetch').get(url, { headers: { 'accept-language': 'en-US,en;q=0.9', cookie: 'CONSENT=YES+1' } }).catch(() => null))?.text || '';
    const views = (/"viewCount":"(\d+)"/.exec(html) || [])[1];
    const likes = (/"likeCount":"(\d+)"/.exec(html) || /"label":"([\d,]+) likes"/.exec(html) || [])[1];
    if (views) return { views: n(views), likes: likes ? n(String(likes).replace(/,/g, '')) : null, comments: null, shares: null };
  }
  throw new Error(ytdlp() ? 'The page didn\'t show its numbers.' : 'yt-dlp isn\'t installed (Production → Install it), and this platform\'s page doesn\'t show its numbers without it.');
}

function settings() { return ctx.setting('analytics', {}) || {}; }

/**
 * Refresh the numbers. `force` = every post now (Refresh now / Sync now); otherwise posts read in the last
 * `everyMin` are skipped. Returns a summary that is also kept for the Analytics page.
 */
async function refresh({ force = false, progress = () => {}, isCancelled = () => false } = {}) {
  const everyMin = Number(settings().publicEveryMin || 120);
  const since = new Date(Date.now() - Number(settings().publicDays || 90) * 864e5).toISOString();
  const posts = ctx.store.all('posts', (p) => p.status === 'published' && (p.publishedAt || '') >= since);
  const memo = new Map(); memo.taken = new Set(posts.flatMap((p) => Object.values(knownLinks(p))));
  const sum = { at: new Date().toISOString(), posts: posts.length, read: 0, found: 0, notFound: [], errors: [], by: NAME };
  let i = 0;
  for (const p of posts) {
    if (isCancelled()) break;
    progress(i++ / Math.max(1, posts.length), `${NAME}: ${p.title || 'a short'}`);
    const fresh = p.publicAt && Date.now() - Date.parse(p.publicAt) < everyMin * 60000;
    if (fresh && !force) continue;
    const client = ctx.store.get('clients', p.clientId);
    let links = knownLinks(p);
    if (!Object.keys(links).length || (force && !p.publicLookedAt)) {
      const got = await findLinks(p, client, memo);
      if (Object.keys(got).length) { links = { ...got, ...links }; sum.found += Object.keys(got).length; }
      ctx.store.update('posts', p.id, (x) => ({ publicUrls: { ...(x.publicUrls || {}), ...got }, publicLookedAt: new Date().toISOString() }));
    }
    if (!Object.keys(links).length) { sum.notFound.push({ id: p.id, title: p.title || '(untitled)' }); continue; }
    const stats = {};
    for (const [plat, url] of Object.entries(links)) {
      try {
        const nums = await readNumbers(url);
        stats[plat] = { ...Object.fromEntries(Object.entries(nums).filter(([, v]) => v != null)), source: 'public', url, at: new Date().toISOString() };
      } catch (e) { sum.errors.push(`${p.title || 'a short'} (${plat}): ${e.message}`); }
      await new Promise((r) => setTimeout(r, 800)); // gentle on the sites
    }
    if (Object.keys(stats).length) {
      ctx.store.update('posts', p.id, (x) => {
        const merged = { ...(x.stats || {}) };
        // An API's numbers (connected channel / Ayrshare) win while they're newer than ours.
        for (const [plat, s] of Object.entries(stats)) { const old = merged[plat]; if (!old || old.source === 'public' || !x.statsAt || Date.parse(x.statsAt) < Date.now() - 12 * 3600e3) merged[plat] = { ...old, ...s }; }
        return { stats: merged, statsAt: new Date().toISOString(), publicAt: new Date().toISOString() };
      });
      sum.read++;
    }
  }
  sum.errors = sum.errors.slice(0, 20);
  ctx.store.setSettings({ _publicStats: sum });
  if (sum.read || sum.found) audit.log(`bot:${NAME}`, 'analytics.public', { read: sum.read, found: sum.found, notFound: sum.notFound.length });
  events.publish('analytics', {});
  progress(1, `${sum.read} shorts refreshed${sum.notFound.length ? `, ${sum.notFound.length} not found yet` : ''}`);
  return sum;
}

/** A founder pastes a short's public link by hand (when the bot couldn't find it). */
function setLink(postId, url) {
  const p = ctx.store.get('posts', postId); if (!p) throw new Error('That post no longer exists.');
  const u = String(url || '').trim();
  const plat = platformOf(u);
  if (!plat || !isVideo(u)) throw new Error('Paste the link to the short itself (YouTube, TikTok, Instagram or Facebook).');
  ctx.store.update('posts', p.id, (x) => ({ publicUrls: { ...(x.publicUrls || {}), [plat]: u }, publicAt: null }));
  return { platform: plat, url: u };
}

function status() {
  const s = settings();
  return { on: s.publicStats !== false, everyMin: Number(s.publicEveryMin || 120), last: ctx.setting('_publicStats', null), ytdlp: !!ctx.capabilities.ytdlp, by: NAME };
}

module.exports = { refresh, setLink, status, like, platformOf, isVideo, knownLinks, titlesOf, readNumbers };
