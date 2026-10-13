'use strict';
/**
 * Creator tracking for Analytics: search for any creator (prospects, competitors,
 * inspiration) and follow their public numbers over time.
 *
 * Sources, best first:
 *  - yt-dlp when installed (YouTube, TikTok): channel follower count and recent uploads with views.
 *  - YouTube's public pages (no API key): search results and a channel's Videos tab.
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

/** Pull a creator's current numbers. Returns { followers, videos[], name?, avatar?, handle? }. */
async function fetchStats(creator) {
  const y = ytdlp();
  if (creator.platform === 'youtube') {
    const base = String(creator.url || '').replace(/\/(videos|shorts|featured|streams)\/?$/, '').replace(/\/$/, '');
    if (y) {
      try {
        const r = await run(y, ['-J', '--flat-playlist', '--playlist-end', '30', `${base}/videos`], { timeoutMs: 90000 });
        const j = safeJson(r.out, {});
        return {
          name: j.channel || j.uploader || j.title?.replace(/ - Videos$/, ''), handle: j.uploader_id || null, followers: j.channel_follower_count ?? null,
          avatar: (j.thumbnails || []).find((t) => /avatar/i.test(t.id || ''))?.url || null,
          videos: (j.entries || []).map((e) => ({ id: e.id, title: e.title, views: e.view_count ?? null, ageDays: e.timestamp ? (Date.now() / 1000 - e.timestamp) / 86400 : null, published: '', url: e.url || `https://www.youtube.com/watch?v=${e.id}` })),
        };
      } catch { /* fall back to the page */ }
    }
    const html = await fetchPage(`${base}/videos?hl=en`);
    const d = initialData(html);
    if (!d) throw new Error('YouTube didn\'t return the channel page. Check the link, or install yt-dlp (winget install yt-dlp.yt-dlp) for more reliable stats.');
    return parseYouTubeChannel(d, base);
  }
  if (creator.platform === 'tiktok') {
    if (!y) throw new Error('TikTok stats need yt-dlp (winget install yt-dlp.yt-dlp). You can type the follower count in by hand meanwhile.');
    const r = await run(y, ['-J', '--flat-playlist', '--playlist-end', '30', creator.url], { timeoutMs: 90000 })
      .catch(() => { throw new Error('TikTok blocked the automatic stats request. Try again later, or type the numbers in by hand.'); });
    const j = safeJson(r.out, {});
    return { name: j.uploader || j.title || null, followers: j.channel_follower_count ?? null, videos: (j.entries || []).map((e) => ({ id: e.id, title: e.title || e.description || '', views: e.view_count ?? null, ageDays: e.timestamp ? (Date.now() / 1000 - e.timestamp) / 86400 : null, url: e.url })) };
  }
  throw new Error(`Automatic stats aren't available for ${creator.platform} (it requires logging in). Type the numbers in by hand from their profile.`);
}

/** Summary numbers shown in Analytics. */
function metrics(videos) {
  const v = (videos || []).map((x) => x.views).filter((n) => typeof n === 'number');
  if (!v.length) return { avgViews: null, medianViews: null, uploads30d: null, totalRecentViews: null };
  const sorted = v.slice().sort((a, b) => a - b);
  const recent = (videos || []).filter((x) => x.ageDays != null && x.ageDays <= 30);
  return {
    avgViews: Math.round(v.reduce((t, n) => t + n, 0) / v.length), medianViews: sorted[Math.floor(sorted.length / 2)],
    uploads30d: (videos || []).some((x) => x.ageDays != null) ? recent.length : null, totalRecentViews: v.reduce((t, n) => t + n, 0), sample: v.length,
  };
}

module.exports = { classify, searchYouTube, searchWithAI, fetchStats, metrics, parseCount, parseAgo, parseYouTubeSearch, parseYouTubeChannel };
