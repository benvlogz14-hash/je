'use strict';
/**
 * Creator tracking for Analytics: search for any creator (prospects, competitors,
 * inspiration) and follow their public numbers over time.
 *
 * Sources, best first:
 *  - yt-dlp when installed (YouTube, TikTok): followers, channel details and the whole upload history
 *    (Videos, Shorts, Live) with dates, views, likes, comments, shares and length.
 *  - YouTube's public pages (no API key): search results and the latest Videos and Shorts.
 *  - AI search (Grok/Claude/GPT, optional) to find creators on TikTok/Instagram by description;
 *    those results are marked unverified until their stats sync.
 * Anything that can't be fetched automatically can still be added and its numbers typed in.
 */
const ctx = require('../core/ctx');
const { run, safeJson } = require('../core/util');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';

/** "1.2M subscribers" → 1200000, "12,345 views" → 12345 */
function parseCount(s) {
  if (s == null) return null;
  if (typeof s === 'number') return s;
  const m = /([\d][\d.,]*)\s*([KMB]?)/i.exec(String(s).replace(/ /g, ' '));
  if (!m) return /no views/i.test(s) ? 0 : null;
  const n = parseFloat(m[1].replace(/,/g, ''));
  return Math.round(n * ({ K: 1e3, M: 1e6, B: 1e9 }[m[2].toUpperCase()] || 1));
}
/** "3 weeks ago" → days (approximate) */
function parseAgo(s) {
  const m = /(\d+)\s*(second|minute|hour|day|week|month|year)/i.exec(String(s || ''));
  if (!m) return null;
  return Number(m[1]) * { second: 1 / 86400, minute: 1 / 1440, hour: 1 / 24, day: 1, week: 7, month: 30, year: 365 }[m[2].toLowerCase()];
}
const text = (t) => (t == null ? '' : typeof t === 'string' ? t : t.simpleText || (t.runs || []).map((r) => r.text).join('') || t.content || '');

/** Detect what the person typed: a URL, @handle, or plain words. */
function classify(q) {
  const s = String(q || '').trim();
  let m;
  if ((m = /youtube\.com\/(@[\w.-]+|channel\/[\w-]+|c\/[\w.-]+|user\/[\w.-]+)/i.exec(s))) return { platform: 'youtube', url: `https://www.youtube.com/${m[1]}` };
  if ((m = /tiktok\.com\/@([\w.-]+)/i.exec(s))) return { platform: 'tiktok', url: `https://www.tiktok.com/@${m[1]}`, handle: '@' + m[1] };
  if ((m = /instagram\.com\/([\w.]+)/i.exec(s))) return { platform: 'instagram', url: `https://www.instagram.com/${m[1]}/`, handle: '@' + m[1] };
  if ((m = /(?:x|twitter)\.com\/(\w+)/i.exec(s))) return { platform: 'x', url: `https://x.com/${m[1]}`, handle: '@' + m[1] };
  if ((m = /^@([\w.-]{2,})$/.exec(s))) return { platform: 'youtube', url: `https://www.youtube.com/@${m[1]}`, handle: '@' + m[1], maybeOther: true };
  return null;
}

function ytdlp() { return ctx.capabilities.ytdlp ? require('../video/ffmpeg').ytdlpBin() : null; }

async function fetchPage(url) {
  let r;
  try { r = await fetch(url, { headers: { 'user-agent': UA, 'accept-language': 'en-US,en;q=0.9', cookie: 'CONSENT=YES+1' }, signal: AbortSignal.timeout(20000) }); }
  catch (e) { throw new Error(`Couldn't reach ${new URL(url).host}. Check the internet connection.`); }
  if (!r.ok) throw new Error(`${new URL(url).host} answered ${r.status}.`);
  return r.text();
}
/** YouTube pages embed their data as `var ytInitialData = {...};` */
function initialData(html) {
  const m = /ytInitialData\s*=\s*(\{[\s\S]*?\});\s*<\/script>/.exec(html) || /ytInitialData"\]\s*=\s*(\{[\s\S]*?\});/.exec(html);
  return m ? safeJson(m[1]) : null;
}
function* walk(o, key) {
  if (!o || typeof o !== 'object') return;
  if (Array.isArray(o)) { for (const x of o) yield* walk(x, key); return; }
  for (const [k, v] of Object.entries(o)) { if (k === key) yield v; yield* walk(v, key); }
}

/** Parse a YouTube search-results page (channel filter) into creators. */
function parseYouTubeSearch(data) {
  const out = [];
  for (const c of walk(data, 'channelRenderer')) {
    // YouTube shows "@handle" in subscriberCountText and "1.2M subscribers" in videoCountText on newer layouts.
    const a = text(c.subscriberCountText), b = text(c.videoCountText);
    const subs = /subscriber/i.test(a) ? a : /subscriber/i.test(b) ? b : '';
    const handle = [a, b].find((x) => /^@/.test(x)) || (c.navigationEndpoint?.browseEndpoint?.canonicalBaseUrl || '').replace(/^\//, '');
    const thumbs = c.thumbnail?.thumbnails || [];
    out.push({
      platform: 'youtube', name: text(c.title), handle: handle && handle.startsWith('@') ? handle : '', channelId: c.channelId,
      url: handle && handle.startsWith('@') ? `https://www.youtube.com/${handle}` : `https://www.youtube.com/channel/${c.channelId}`,
      avatar: thumbs.length ? String(thumbs[thumbs.length - 1].url).replace(/^\/\//, 'https://') : null,
      followers: subs ? parseCount(subs) : null, about: text(c.descriptionSnippet).slice(0, 200), verified: true,
    });
  }
  return out;
}

/** Parse a channel's Videos tab: header numbers plus the most recent uploads. */
function parseYouTubeChannel(data, url) {
  const json = JSON.stringify(data || {});
  const subsM = /"([\d.,]+[KMB]?) subscribers"/i.exec(json);
  const meta = data?.metadata?.channelMetadataRenderer || {};
  const videos = [];
  for (const v of walk(data, 'videoRenderer')) {
    if (!v.videoId) continue;
    videos.push({ id: v.videoId, title: text(v.title), views: parseCount(text(v.viewCountText)), ageDays: parseAgo(text(v.publishedTimeText)), published: text(v.publishedTimeText), url: `https://www.youtube.com/watch?v=${v.videoId}` });
  }
  // newer grid layout
  for (const l of walk(data, 'lockupViewModel')) {
    const id = l.contentId; if (!id || videos.some((x) => x.id === id)) continue;
    const rows = JSON.stringify(l.metadata || {});
    const views = /"([\d.,]+[KMB]?) views"/i.exec(rows); const ago = /"(\d+ \w+ ago)"/.exec(rows);
    videos.push({ id, title: l.metadata?.lockupMetadataViewModel?.title?.content || '', views: views ? parseCount(views[1]) : null, ageDays: ago ? parseAgo(ago[1]) : null, published: ago ? ago[1] : '', url: `https://www.youtube.com/watch?v=${id}` });
  }
  const av = meta.avatar?.thumbnails || [];
  return {
    name: meta.title || null, about: (meta.description || '').slice(0, 300), channelId: meta.externalId || null,
    handle: (/"(@[\w.-]+)"/.exec(json) || [])[1] || null, url: meta.vanityChannelUrl || url,
    avatar: av.length ? av[av.length - 1].url : null, followers: subsM ? parseCount(subsM[1]) : null, videos: videos.slice(0, 30),
  };
}

async function searchYouTube(q) {
  const y = ytdlp();
  if (y) {
    try {
      const r = await run(y, ['-J', '--flat-playlist', '--playlist-end', '12', `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}&sp=EgIQAg%253D%253D`], { timeoutMs: 45000 });
      const j = safeJson(r.out, {});
      const list = (j.entries || []).filter((e) => e.ie_key === 'YoutubeTab' || /channel|@/.test(e.url || '')).map((e) => ({
        platform: 'youtube', name: e.title || e.channel, handle: e.uploader_id && e.uploader_id.startsWith('@') ? e.uploader_id : '', channelId: e.channel_id || e.id,
        url: e.url, avatar: (e.thumbnails || []).slice(-1)[0]?.url?.replace(/^\/\//, 'https://') || null, followers: e.channel_follower_count ?? null, about: (e.description || '').slice(0, 200), verified: true,
      }));
      if (list.length) return list;
    } catch { /* fall back to the page */ }
  }
  const html = await fetchPage(`https://www.youtube.com/results?search_query=${encodeURIComponent(q)}&sp=EgIQAg%253D%253D&hl=en`);
  return parseYouTubeSearch(initialData(html));
}

/** AI-assisted discovery across platforms (optional; costs a little per search). */
async function searchWithAI(q) {
  const ai = require('./ai');
  if (!ai.anyConnected()) throw new Error('AI search needs Grok, Claude or GPT connected in Settings → Connections.');
  const r = await ai.ask({
    role: 'research', json: true, search: true, maxTokens: 1500,
    system: 'You find real social media creators. Only list accounts you are confident exist. Never invent handles or numbers; use null when unsure.',
    prompt: `Find up to 8 creators matching: "${q}". Include YouTube, TikTok and Instagram accounts. Return JSON {"creators":[{"name","platform":"youtube|tiktok|instagram|x","handle":"@...","url","followers":number|null,"about":"one line"}]}`,
  });
  return (r.json?.creators || []).filter((c) => c && c.name && c.platform).map((c) => ({
    platform: String(c.platform).toLowerCase(), name: String(c.name).slice(0, 80), handle: c.handle ? String(c.handle).slice(0, 60) : '',
    url: c.url && /^https?:\/\//.test(c.url) ? c.url : null, followers: typeof c.followers === 'number' ? c.followers : null, about: String(c.about || '').slice(0, 200), verified: false, via: r.provider,
  }));
}

// ------------------------------------------------------------ collecting a creator's data
const DAY = 864e5;
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
/** yt-dlp gives upload_date "20260914" or a unix timestamp; pages give "3 weeks ago". */
function dateOf({ upload_date: ud, timestamp, release_timestamp: rt, ageDays }) {
  if (ud && /^\d{8}$/.test(ud)) return { date: `${ud.slice(0, 4)}-${ud.slice(4, 6)}-${ud.slice(6, 8)}`, approx: false };
  const ts = timestamp || rt;
  if (ts) return { date: isoDay(ts * 1000), approx: true };
  if (ageDays != null) return { date: isoDay(Date.now() - ageDays * DAY), approx: true };
  return { date: null, approx: true };
}
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** One upload in the shape Euclidean stores, whatever the source. */
function video(e, kind, platform) {
  const d = dateOf(e);
  const id = String(e.id || e.videoId || '');
  return {
    id, kind, title: String(e.title || e.description || '').replace(/\s+/g, ' ').trim().slice(0, 200),
    date: d.date, dateApprox: d.approx,
    views: num(e.view_count ?? e.views), likes: num(e.like_count ?? e.likes), comments: num(e.comment_count ?? e.comments), shares: num(e.repost_count ?? e.shares),
    durationSec: num(e.duration) != null ? Math.round(e.duration) : null,
    url: e.webpage_url || (e.url && /^https?:/.test(e.url) ? e.url : platform === 'youtube' ? (kind === 'short' ? `https://www.youtube.com/shorts/${id}` : `https://www.youtube.com/watch?v=${id}`) : e.url || null),
  };
}

/** yt-dlp prints one JSON object per line with -j. */
function jsonLines(out) { return String(out || '').split('\n').map((l) => safeJson(l.trim())).filter((x) => x && typeof x === 'object'); }

async function ytTab(y, base, tab, limit) {
  const r = await run(y, ['-J', '--flat-playlist', '--playlist-end', String(limit), '--extractor-args', 'youtubetab:approximate_date', `${base}/${tab}`], { timeoutMs: 180000 });
  return safeJson(r.out, {});
}

/** Likes, comments and exact dates need each video's own page; done for the newest uploads only. */
async function ytDetails(y, urls) {
  if (!urls.length) return [];
  const r = await run(y, ['-j', '--skip-download', '--no-warnings', '--ignore-errors', '--extractor-args', 'youtube:skip=dash,hls,translated_subs', ...urls], { timeoutMs: 60000 + urls.length * 15000 }).catch((e) => ({ out: e.out || '' }));
  return jsonLines(r.out);
}

/** Shorts tab on the public page (no yt-dlp): views only, no dates. */
function parseYouTubeShorts(data) {
  const out = [];
  for (const r of walk(data, 'reelItemRenderer')) if (r.videoId) out.push({ id: r.videoId, title: text(r.headline), views: parseCount(text(r.viewCountText)) });
  for (const l of walk(data, 'shortsLockupViewModel')) {
    const id = String(l.entityId || '').replace(/^shorts-shelf-item-/, '') || l.onTap?.innertubeCommand?.reelWatchEndpoint?.videoId;
    if (id && !out.some((x) => x.id === id)) out.push({ id, title: l.overlayMetadata?.primaryText?.content || '', views: parseCount(l.overlayMetadata?.secondaryText?.content) });
  }
  return out;
}

/**
 * Collect everything public about a creator.
 * @param opts.full  go back through the whole upload history (slower) instead of the latest ~200 per tab
 * Returns { name, handle, avatar, about, keywords, followers, totalVideos, totalViews, videos[] }.
 */
async function fetchStats(creator, { full = false } = {}) {
  const y = ytdlp();
  const limit = full ? 5000 : 200;
  if (creator.platform === 'youtube') {
    const base = String(creator.url || '').replace(/\/(videos|shorts|featured|streams|about)\/?$/, '').replace(/\/$/, '');
    if (y) {
      const out = { videos: [] }; let got = false; const errors = [];
      for (const [tab, kind] of [['videos', 'video'], ['shorts', 'short'], ['streams', 'live']]) {
        try {
          const j = await ytTab(y, base, tab, limit); got = true;
          if (!out.name) Object.assign(out, { name: j.channel || j.uploader || String(j.title || '').replace(/ - \w+$/, '') || null, handle: j.uploader_id || null, followers: num(j.channel_follower_count), about: String(j.description || '').slice(0, 1000), keywords: (j.tags || []).slice(0, 30), channelId: j.channel_id || null, avatar: (j.thumbnails || []).find((t) => /avatar/i.test(t.id || ''))?.url || null });
          for (const e of j.entries || []) if (e && e.id) out.videos.push(video(e, kind, 'youtube'));
        } catch (e) { if (!/does not have a|no videos|This channel has no/i.test(e.message)) errors.push(`${tab}: ${e.message.slice(0, 120)}`); }
      }
      if (got) {
        // Exact dates, likes and comments for the newest uploads that don't have them yet.
        const known = new Map((creator.videos || []).map((v) => [v.id, v]));
        const need = out.videos.filter((v) => { const k = known.get(v.id); return !(k && k.likes != null && !k.dateApprox); }).sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, full ? 60 : 15);
        for (const d of await ytDetails(y, need.map((v) => v.url))) {
          const v = out.videos.find((x) => x.id === d.id); if (!v) continue;
          Object.assign(v, Object.fromEntries(Object.entries(video(d, v.kind, 'youtube')).filter(([k, x]) => x != null && x !== '' && k !== 'kind' && k !== 'url' && k !== 'id')));
        }
        out.totalVideos = out.videos.length;
        return out;
      }
      if (errors.length) console.warn('[creators] yt-dlp failed, using the public page:', errors.join(' | '));
    }
    const d = initialData(await fetchPage(`${base}/videos?hl=en`));
    if (!d) throw new Error('YouTube didn\'t return the channel page. Check the link, or install yt-dlp (winget install yt-dlp.yt-dlp) for full history, likes and comments.');
    const c = parseYouTubeChannel(d, base);
    const json = JSON.stringify(d);
    c.totalVideos = parseCount((/"([\d.,]+[KMB]?) videos"/i.exec(json) || [])[1]);
    c.keywords = String(d?.metadata?.channelMetadataRenderer?.keywords || '').match(/"[^"]+"|\S+/g)?.map((k) => k.replace(/"/g, '')).slice(0, 30) || [];
    c.videos = c.videos.map((v) => video(v, 'video', 'youtube'));
    try { c.videos.push(...parseYouTubeShorts(initialData(await fetchPage(`${base}/shorts?hl=en`))).map((v) => video(v, 'short', 'youtube'))); } catch { /* shorts tab optional */ }
    c.partial = true;
    return c;
  }
  if (creator.platform === 'tiktok') {
    if (!y) throw new Error('TikTok stats need yt-dlp (winget install yt-dlp.yt-dlp). You can type the follower count in by hand meanwhile.');
    const r = await run(y, ['-j', '--skip-download', '--ignore-errors', '--no-warnings', '--playlist-end', String(full ? 1000 : 120), creator.url], { timeoutMs: full ? 1800000 : 300000 }).catch((e) => ({ out: e.out || '' }));
    const items = jsonLines(r.out);
    if (!items.length) throw new Error('TikTok blocked the automatic stats request. Try again later, or type the numbers in by hand.');
    const f = items[0];
    return { name: f.uploader || f.channel || null, handle: f.uploader_id ? `@${String(f.uploader_id).replace(/^@/, '')}` : null, followers: num(f.channel_follower_count), videos: items.map((e) => video(e, 'short', 'tiktok')), totalVideos: items.length };
  }
  throw new Error(`Automatic stats aren't available for ${creator.platform} (it requires logging in). Type the numbers in by hand from their profile.`);
}

/** Merge a fresh fetch into what's stored: newest numbers win, nothing already known is lost. */
function mergeVideos(oldList = [], fresh = [], at = new Date().toISOString()) {
  const map = new Map(oldList.map((v) => [v.id, v]));
  for (const v of fresh) {
    if (!v.id) continue;
    const o = map.get(v.id);
    if (!o) { map.set(v.id, { ...v, firstSeenAt: at, updatedAt: at }); continue; }
    const m = { ...o, updatedAt: at };
    for (const [k, x] of Object.entries(v)) {
      if (x == null || x === '') continue;
      if (k === 'date' && o.date && !o.dateApprox && v.dateApprox) continue; // keep an exact date over an estimate
      if (k === 'dateApprox' && o.date && !o.dateApprox) continue;
      m[k] = x;
    }
    map.set(v.id, m);
  }
  return [...map.values()].sort((a, b) => String(b.date || '').localeCompare(String(a.date || ''))).slice(0, 5000);
}

const median = (a) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); const i = s.length >> 1; return s.length % 2 ? s[i] : Math.round((s[i - 1] + s[i]) / 2); };
const sum = (a) => a.reduce((t, n) => t + n, 0);

/** Everything grouped by upload month ("2026-09"), plus followers at the end of each month. */
function monthly(videos = [], history = []) {
  const months = new Map();
  const get = (k) => { if (!months.has(k)) months.set(k, { month: k, uploads: 0, videos: 0, shorts: 0, lives: 0, views: [], likes: [], comments: [], shares: [], durations: [], top: null, approx: 0 }); return months.get(k); };
  for (const v of videos) {
    if (!v.date) continue;
    const m = get(v.date.slice(0, 7));
    m.uploads++; m[v.kind === 'short' ? 'shorts' : v.kind === 'live' ? 'lives' : 'videos']++;
    if (v.dateApprox) m.approx++;
    if (v.views != null) m.views.push(v.views);
    if (v.likes != null) m.likes.push(v.likes);
    if (v.comments != null) m.comments.push(v.comments);
    if (v.shares != null) m.shares.push(v.shares);
    if (v.durationSec != null) m.durations.push(v.durationSec);
    if (v.views != null && (!m.top || v.views > m.top.views)) m.top = { id: v.id, title: v.title, views: v.views, url: v.url, kind: v.kind };
  }
  for (const h of history) if (h.followers != null) get(String(h.at).slice(0, 7));
  const byMonth = {}; for (const h of history) if (h.followers != null) byMonth[String(h.at).slice(0, 7)] = h.followers; // last snapshot in each month
  const rows = [...months.values()].sort((a, b) => a.month.localeCompare(b.month));
  let prev = null;
  return rows.map((m) => {
    const followers = byMonth[m.month] ?? null;
    const views = sum(m.views); const eng = m.likes.length || m.comments.length ? sum(m.likes) + sum(m.comments) : null;
    const row = {
      month: m.month, uploads: m.uploads, videos: m.videos, shorts: m.shorts, lives: m.lives, datesApprox: m.approx,
      views: m.views.length ? views : null, avgViews: m.views.length ? Math.round(views / m.views.length) : null, medianViews: median(m.views),
      likes: m.likes.length ? sum(m.likes) : null, comments: m.comments.length ? sum(m.comments) : null, shares: m.shares.length ? sum(m.shares) : null,
      engagementPct: eng != null && views ? Math.round((eng / views) * 10000) / 100 : null,
      avgDurationSec: m.durations.length ? Math.round(sum(m.durations) / m.durations.length) : null,
      top: m.top, followers, followersDelta: followers != null && prev != null ? followers - prev : null,
    };
    if (followers != null) prev = followers;
    return row;
  }).reverse(); // newest month first
}

/** Summary numbers shown in the creators table. */
function metrics(videos = []) {
  const v = videos.map((x) => x.views).filter((n) => typeof n === 'number');
  const cutoff = isoDay(Date.now() - 30 * DAY);
  const recent = videos.filter((x) => x.date && x.date >= cutoff);
  const recent30 = videos.slice(0, 30).map((x) => x.views).filter((n) => typeof n === 'number');
  return {
    avgViews: recent30.length ? Math.round(sum(recent30) / recent30.length) : null, medianViews: median(recent30),
    uploads30d: videos.some((x) => x.date) ? recent.length : null, totalViews: v.length ? sum(v) : null, uploadsTracked: videos.length,
    shorts: videos.filter((x) => x.kind === 'short').length, longForm: videos.filter((x) => x.kind === 'video').length, lives: videos.filter((x) => x.kind === 'live').length,
    firstUpload: videos.map((x) => x.date).filter(Boolean).sort()[0] || null, lastUpload: videos.map((x) => x.date).filter(Boolean).sort().pop() || null,
  };
}

module.exports = { classify, searchYouTube, searchWithAI, fetchStats, mergeVideos, monthly, metrics, video, parseCount, parseAgo, parseYouTubeSearch, parseYouTubeChannel, parseYouTubeShorts };
