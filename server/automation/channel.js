'use strict';
/**
 * Footage straight from the client's YouTube channel (Nov 14, Ryan: "autopilot pulls new and old videos from his
 * channel, auto downloads, loads them into the clip machine with the clip counts already set, 5 Documentary 5 Explorer").
 * `client.production.channelUrl` (any channel link yt-dlp reads: @handle, /channel/..., /c/...). Autopilot then:
 *  - new uploads: the channel is listed every few hours (`channelCheckHours`, default 6); a video uploaded after the
 *    channel was set (or newer than anything pulled) is downloaded straight away;
 *  - older videos: when the client runs out of footage, the next older long video is downloaded (newest first, going
 *    back), at most `channelBackfillPerDay` a day (default 2);
 * downloads go through the usual `ingest.url` (yt-dlp, up to 1080p) with Make clips pressed, so the client's own
 * style mix and clip lengths decide what gets made (autopilot clients never wait for Make clips). Shorts and videos
 * under `channelMinMinutes` (default 4) are skipped: there's nothing to clip in them. A video is never pulled twice.
 */
const ctx = require('../core/ctx');
const queue = require('../jobs/queue');
const audit = require('../core/audit');
const { run } = require('../core/util');

const P = (client, k, d) => (client.production || {})[k] ?? d;
const idOf = (url) => (/[?&]v=([\w-]{6,})/.exec(url) || /youtu\.be\/([\w-]{6,})/.exec(url) || /\/shorts\/([\w-]{6,})/.exec(url) || [])[1] || null;
const videosUrl = (u) => { const s = String(u || '').trim().replace(/\/+$/, ''); return /\/(videos|streams|shorts|featured)$/.test(s) ? s.replace(/\/(featured|shorts)$/, '/videos') : `${s}/videos`; };

/** Already pulled (or uploaded from the same link) for this client. */
function pulled(client) {
  const set = new Set(P(client, '_channelPulled', []));
  for (const a of ctx.store.all('assets', (x) => x.clientId === client.id)) { const id = idOf(a.source || ''); if (id) set.add(id); }
  return set;
}

/** Words of a title, for spotting a video that was uploaded by hand (a file, no link) under its own name. */
const words = (t) => String(t || '').toLowerCase().replace(/\.[a-z0-9]{2,4}$/, '').replace(/[_-]+/g, ' ').replace(/[^a-z0-9$ ]+/g, ' ').split(/\s+/).filter((w) => w.length > 2);
function clippedByName(client) {
  const names = ctx.store.all('assets', (x) => x.clientId === client.id).map((a) => new Set(words(a.name)));
  return (title) => { const w = words(title); if (w.length < 3) return false; return names.some((n) => n.size && w.filter((x) => n.has(x)).length / w.length >= 0.7); };
}

/** The channel's videos, newest first: [{ id, title, url, duration, uploaded }]. Cached on the client between checks. */
const reading = new Map(); // client id -> the read in progress (never two yt-dlp listings of one channel at once)
async function list(client, { force = false } = {}) {
  const url = P(client, 'channelUrl', ''); if (!url) return [];
  const cache = P(client, '_channel', null);
  if (!force && cache && cache.url === url && Date.now() - Date.parse(cache.at) < Number(P(client, 'channelCheckHours', 6)) * 3600000) return cache.videos;
  if (reading.has(client.id)) return reading.get(client.id);
  const p = read(client, url).finally(() => reading.delete(client.id)); reading.set(client.id, p); return p;
}
async function read(client, url) {
  if (!ctx.capabilities.ytdlp) throw new Error('yt-dlp is not installed, so the channel can’t be read. Production → Install it.');
  const r = await run(require('../video/ffmpeg').ytdlpBin(), ['--flat-playlist', '--dump-single-json', '--playlist-end', String(P(client, 'channelLookBack', 300)), videosUrl(url)], { timeoutMs: 180000 });
  const j = JSON.parse(r.out || '{}');
  const videos = (j.entries || []).filter((e) => e && e.id).map((e) => ({ id: e.id, title: e.title || e.id, url: e.url && /^https?:/.test(e.url) ? e.url : `https://www.youtube.com/watch?v=${e.id}`, duration: Number(e.duration) || 0, uploaded: e.upload_date || e.timestamp || null, views: Number(e.view_count) || 0 }));
  ctx.store.update('clients', client.id, (c) => ({ production: { ...(c.production || {}), _channel: { at: new Date().toISOString(), url, name: j.channel || j.uploader || j.title || null, videos } } }));
  return videos;
}

function longEnough(client, v) { return !v.duration || v.duration >= Number(P(client, 'channelMinMinutes', 4)) * 60; }

/** Download one video into the client's footage with Make clips pressed. */
function pull(client, v, why) {
  const job = queue.enqueue('ingest.url', { url: v.url, clientId: client.id, autoProcess: true }, { clientId: client.id, dedupeKey: `channel:${client.id}:${v.id}`, title: `From the channel: ${v.title}`.slice(0, 120), actor: 'autopilot' });
  ctx.store.update('clients', client.id, (c) => ({ production: { ...(c.production || {}), _channelPulled: [...new Set([...(c.production?._channelPulled || []), v.id])].slice(-2000) } }));
  audit.log('autopilot', 'channel.pulled', { clientId: client.id, video: v.title, why });
  return job;
}

/** Newest first: the first long video not pulled yet that came out after the channel was set (a new upload). */
function newUpload(client, videos) {
  const have = pulled(client); const since = P(client, '_channelSince', null);
  // The channel's newest video at the time it was set marks "new"; anything listed above it is a new upload.
  const mark = since ? videos.findIndex((v) => v.id === since) : -1;
  const fresh = mark >= 0 ? videos.slice(0, mark) : [];
  return fresh.find((v) => !have.has(v.id) && longEnough(client, v)) || null;
}

/** The next older video to pull when out of footage (newest of the ones not pulled yet). */
function nextOld(client, videos) { const have = pulled(client); return videos.find((v) => !have.has(v.id) && longEnough(client, v)) || null; }

function backfillToday(client) {
  const day = new Date().toISOString().slice(0, 10); const b = P(client, '_channelBackfill', {});
  return b.day === day ? b.n || 0 : 0;
}

/** From the scheduler (autopilot clients with a channel): pull a new upload when there is one. */
async function tick(client) {
  if (!P(client, 'channelUrl', '') || P(client, 'channelOn', true) === false) return null;
  const videos = await list(client);
  if (!P(client, '_channelSince', null) && videos[0]) { ctx.store.update('clients', client.id, (c) => ({ production: { ...(c.production || {}), _channelSince: videos[0].id } })); return null; }
  const v = newUpload(client, videos); if (v) return pull(client, v, 'new upload');
  return null;
}

/** Whether the out-of-footage step should try the channel today (set, on, under today's limit, not emptied today). */
function canBackfill(client) {
  return !!P(client, 'channelUrl', '') && P(client, 'channelOn', true) !== false && backfillToday(client) < Number(P(client, 'channelBackfillPerDay', 2)) && P(client, '_channelEmpty', null) !== new Date().toISOString().slice(0, 10);
}

/** From the scheduler when the client has no footage left: the next older video (a few a day). */
async function backfill(client) {
  if (!P(client, 'channelUrl', '') || P(client, 'channelOn', true) === false) return null;
  if (backfillToday(client) >= Number(P(client, 'channelBackfillPerDay', 2))) return null;
  const day = new Date().toISOString().slice(0, 10);
  const v = nextOld(client, await list(client));
  if (!v) { ctx.store.update('clients', client.id, (c) => ({ production: { ...(c.production || {}), _channelEmpty: day } })); return null; }
  ctx.store.update('clients', client.id, (c) => ({ production: { ...(c.production || {}), _channelBackfill: { day, n: backfillToday(c) + 1 } } }));
  return pull(client, v, 'out of footage');
}

/** For the Production panel. */
async function status(client, { refresh = false } = {}) {
  const url = P(client, 'channelUrl', '');
  if (!url) return { url: '', on: false };
  let videos = []; let error = null;
  try { videos = await list(client, { force: refresh }); } catch (e) { error = e.message; }
  const have = pulled(client); const long = videos.filter((v) => longEnough(client, v));
  return { url, on: P(client, 'channelOn', true) !== false, name: P(client, '_channel', {})?.name || null, checkedAt: P(client, '_channel', {})?.at || null, videos: videos.length, long: long.length, pulled: long.filter((v) => have.has(v.id)).length,
    next: nextOld(client, videos)?.title || null, morning: { ...morningCfg(client), last: P(client, '_morningPick', null), top: rank(client, videos).slice(0, 3).map((v) => ({ title: v.title, why: v.why })) }, perDay: Number(P(client, 'channelBackfillPerDay', 2)), error,
    recent: long.slice(0, 8).map((v) => ({ id: v.id, title: v.title, minutes: Math.round(v.duration / 60), pulled: have.has(v.id) })) };
}

/**
 * Morning pick (Nov 17, Ryan: "each morning go to the Stringer channel, find a flagrant one we haven't clipped,
 * load it into the clipper and click Make clips, so it's all ready for me"): `production.morningPick` = { on, at 'HH:MM' }.
 * Once a day after that time: the channel is read again (yt-dlp, no API keys, no AI), every long video not clipped
 * before (no link pulled, no footage with that video's id, none uploaded under its title) is ranked by how much it
 * stands out (views against the channel's middle video, a hook-like title, a little for being newer), and the top one is
 * downloaded with Make clips pressed, so the clips in the client's style mix are waiting in Approvals for small edits.
 */
const HOOKY = /\b(abandoned|hidden|secret|found|inside|left behind|forgotten|creepy|haunted|mansion|castle|billion|million|\$\d|never|why|what|lost|frozen|untouched|empty|exploring|sealed|underground|caught|police|scary|insane|crazy)\b/i;
function rank(client, videos) {
  const have = pulled(client); const byName = clippedByName(client);
  const pool = videos.filter((v) => longEnough(client, v) && !have.has(v.id) && !byName(v.title));
  const seen = videos.map((v) => v.views).filter(Boolean).sort((a, b) => a - b); const mid = seen[Math.floor(seen.length / 2)] || 0;
  return pool.map((v, i) => {
    const pop = mid && v.views ? Math.log2(Math.max(0.25, v.views / mid)) : 0; // 2x the channel's middle video = +1
    const hook = HOOKY.test(v.title) ? 0.8 : 0; const fresh = Math.max(0, 1 - i / Math.max(20, videos.length)) * 0.6;
    const why = [v.views && mid ? (v.views >= mid * 0.9 ? `${(v.views / mid).toFixed(1)}x the channel's usual views` : 'fewer views than usual') : null, hook ? 'a hook-style title' : null].filter(Boolean).join(', ') || 'the newest one not clipped yet';
    return { ...v, score: pop * 2 + hook + fresh, why };
  }).sort((a, b) => b.score - a.score);
}
function morningCfg(client) { return { on: false, at: '07:00', ...(P(client, 'morningPick', {}) || {}) }; }
function localNow() {
  const tz = ctx.setting('agency.timezone', 'America/New_York');
  const x = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date()).map((p) => [p.type, p.value]));
  return { day: `${x.year}-${x.month}-${x.day}`, time: `${x.hour}:${x.minute}` };
}
const picking = new Set();
/** From the scheduler every minute, for every active client with a channel (autopilot or not). */
async function morning(client, { force = false } = {}) {
  const cfg = morningCfg(client); if (!force && (!cfg.on || !P(client, 'channelUrl', ''))) return null;
  const { day, time } = localNow(); const last = P(client, '_morningPick', {}) || {};
  if (!force && (last.day === day || time < String(cfg.at))) return null;
  if (!force && Date.now() - Date.parse(P(client, '_morningTry', 0) || 0) < 30 * 60000) return null; // a failed read waits half an hour
  if (picking.has(client.id)) return null; picking.add(client.id);
  ctx.store.update('clients', client.id, (c) => ({ production: { ...(c.production || {}), _morningTry: new Date().toISOString() } }));
  const mark = (rec) => ctx.store.update('clients', client.id, (c) => ({ production: { ...(c.production || {}), _morningPick: { day, at: new Date().toISOString(), ...rec } } }));
  try {
    const videos = await list(client, { force: true });
    const best = rank(client, videos)[0];
    const events = require('../core/events');
    if (!best) { mark({ none: true, note: 'Every long video on the channel has been clipped already.' }); events.publish('notify', { kind: 'footage', title: `Morning pick for ${client.name}`, body: 'Every long video on their channel has been clipped already.', route: '/production' }); return null; }
    const job = pull(client, best, `morning pick: ${best.why}`);
    mark({ id: best.id, title: best.title, url: best.url, views: best.views, why: best.why, job: job?.id || null });
    events.publish('notify', { kind: 'footage', title: `Morning pick for ${client.name}`, body: `"${best.title}" (${best.why}). Downloading and making clips; they'll be in Approvals.`, route: '/production' });
    try { const m = ctx.store.insert('halMessages', { who: 'hal', by: 'morning', text: `Morning pick for ${client.name}: "${best.title}"\n${best.url}\nWhy: ${best.why}. It's downloading now with Make clips pressed, so the clips land in Approvals in ${client.name}'s style mix.` }); events.publish('hal', { id: m.id }); } catch { /* HAL's chat is optional */ }
    return best;
  } finally { picking.delete(client.id); }
}

module.exports = { morning, rank, morningCfg, canBackfill, list, pull, tick, backfill, status, nextOld, newUpload, idOf, videosUrl };
