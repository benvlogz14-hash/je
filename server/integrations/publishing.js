'use strict';
/**
 * Publishing connectors.
 *  - Manual Pack (always available): writes the video plus per-platform
 *    captions into exports/<client>/<date>/ so anyone can post by hand.
 *  - Ayrshare: one API that crossposts to TikTok, Instagram Reels, YouTube
 *    Shorts, Facebook Reels, X, LinkedIn and Threads. Each client links their
 *    own social accounts to an Ayrshare profile; we store that profile key.
 *  - YouTube Data API v3 direct upload with per-client OAuth tokens.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const secrets = require('../core/secrets');
const paths = require('../core/paths');
const ctx = require('../core/ctx');
const { slug } = require('../core/util');

const PLATFORMS = {
  tiktok: { label: 'TikTok', maxCaption: 2200 },
  instagram: { label: 'Instagram Reels', maxCaption: 2200 },
  youtube: { label: 'YouTube Shorts', maxCaption: 5000 },
  facebook: { label: 'Facebook Reels', maxCaption: 5000 },
  twitter: { label: 'X', maxCaption: 280 },
  threads: { label: 'Threads', maxCaption: 500 },
  linkedin: { label: 'LinkedIn', maxCaption: 3000 },
};

function captionFor(platform, { title, caption, hashtags }) {
  const tags = (hashtags || []).map((h) => (h.startsWith('#') ? h : `#${h}`));
  const max = PLATFORMS[platform]?.maxCaption || 2200;
  let body = [caption || title, tags.join(' ')].filter(Boolean).join('\n\n');
  if (platform === 'youtube' && !/#shorts/i.test(body)) body += ' #Shorts';
  if (body.length > max) body = body.slice(0, max - 1).trimEnd() + '…';
  return body;
}

// ------------------------------------------------------------ Manual Pack
function manualPack({ client, post, videoPath }) {
  const day = (post.scheduledAt || new Date().toISOString()).slice(0, 10);
  const dir = paths.exports(slug(client.name), day);
  const base = `${(post.scheduledAt || '').slice(11, 16).replace(':', '') || 'now'}-${slug(post.title).slice(0, 40)}`;
  const outVideo = path.join(dir, `${base}.mp4`);
  fs.copyFileSync(videoPath, outVideo);
  const lines = [`TITLE: ${post.title}`, `SCHEDULED: ${post.scheduledAt || 'immediately'}`, ''];
  for (const p of post.platforms) lines.push(`===== ${PLATFORMS[p]?.label || p} =====`, captionFor(p, post), '');
  fs.writeFileSync(path.join(dir, `${base}.captions.txt`), lines.join('\n'));
  return { ok: true, mode: 'manual', path: outVideo, results: Object.fromEntries(post.platforms.map((p) => [p, { status: 'packaged' }])) };
}

// ------------------------------------------------------------ Ayrshare
const AYR = 'https://api.ayrshare.com/api';
function ayrHeaders(profileKey) {
  const h = { authorization: `Bearer ${secrets.get('global.ayrshare.apiKey')}`, 'content-type': 'application/json' };
  if (profileKey) h['Profile-Key'] = profileKey;
  return h;
}
function ayrConfigured() { return secrets.has('global.ayrshare.apiKey'); }

async function ayrUploadMedia(videoPath, profileKey) {
  const name = path.basename(videoPath);
  const r = await fetch(`${AYR}/media/uploadUrl?fileName=${encodeURIComponent(name)}&contentType=mp4`, { headers: ayrHeaders(profileKey), signal: AbortSignal.timeout(30000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.uploadUrl) throw new Error(`Ayrshare upload URL: ${j.message || r.status}`);
  const size = fs.statSync(videoPath).size;
  const put = await fetch(j.uploadUrl, { method: 'PUT', headers: { 'content-type': 'video/mp4', 'content-length': String(size) }, body: fs.createReadStream(videoPath), duplex: 'half', signal: AbortSignal.timeout(900000) });
  if (!put.ok) throw new Error(`Ayrshare media upload failed: HTTP ${put.status}`);
  return j.accessUrl;
}

async function ayrPost({ client, post, videoPath }) {
  if (!ayrConfigured()) throw new Error('Ayrshare is not connected (Settings → Connections)');
  const profileKey = secrets.get(`client.${client.id}.ayrshare.profileKey`) || undefined;
  const mediaUrl = await ayrUploadMedia(videoPath, profileKey);
  const platforms = post.platforms.filter((p) => PLATFORMS[p]);
  // Short-caption networks get their own request so long captions are not cut for everyone else.
  const groups = [platforms.filter((p) => !['twitter', 'threads'].includes(p)), platforms.filter((p) => ['twitter', 'threads'].includes(p))].filter((g) => g.length);
  const results = {}; const ids = [];
  for (const group of groups) {
    const capPlatform = group.includes('twitter') ? 'twitter' : group.includes('threads') ? 'threads' : 'instagram';
    const body = {
      post: captionFor(capPlatform, post),
      platforms: group,
      mediaUrls: [mediaUrl],
      isVideo: true,
    };
    if (group.includes('youtube')) body.youTubeOptions = { title: post.title.slice(0, 100), visibility: 'public', shorts: true };
    if (post.scheduledAt && new Date(post.scheduledAt) > new Date(Date.now() + 120000)) body.scheduleDate = new Date(post.scheduledAt).toISOString();
    const r = await fetch(`${AYR}/post`, { method: 'POST', headers: ayrHeaders(profileKey), body: JSON.stringify(body), signal: AbortSignal.timeout(120000) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.status === 'error') throw new Error(`Ayrshare: ${j.message || (j.errors || []).map((e) => e.message).join('; ') || r.status}`);
    ids.push(j.id);
    for (const p of j.postIds || []) results[p.platform] = { status: p.status || 'success', id: p.id, url: p.postUrl };
    for (const p of group) if (!results[p]) results[p] = { status: body.scheduleDate ? 'scheduled' : 'submitted' };
  }
  return { ok: true, mode: 'ayrshare', providerId: ids.join(','), results };
}

async function ayrAnalytics(providerId, platforms, client) {
  const profileKey = secrets.get(`client.${client.id}.ayrshare.profileKey`) || undefined;
  const r = await fetch(`${AYR}/analytics/post`, { method: 'POST', headers: ayrHeaders(profileKey), body: JSON.stringify({ id: providerId, platforms }), signal: AbortSignal.timeout(60000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Ayrshare analytics: ${j.message || r.status}`);
  return j;
}

async function ayrTest() {
  if (!ayrConfigured()) return { ok: false, error: 'No API key saved' };
  try {
    const r = await fetch(`${AYR}/user`, { headers: ayrHeaders(), signal: AbortSignal.timeout(20000) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.message || `HTTP ${r.status}`);
    return { ok: true, linked: j.activeSocialAccounts || [] };
  } catch (e) { return { ok: false, error: e.message }; }
}

// ------------------------------------------------------------ YouTube direct
const G_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const G_TOKEN = 'https://oauth2.googleapis.com/token';
const YT_SCOPES = 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly';
const pendingOAuth = new Map();

function ytConfigured() { return secrets.has('global.google.clientId') && secrets.has('global.google.clientSecret'); }

/** Start a loopback OAuth flow (installed-app pattern). Returns the URL to open. */
function ytBeginAuth(clientId) {
  if (!ytConfigured()) throw new Error('Add a Google OAuth client ID and secret in Settings first');
  return new Promise((resolve, reject) => {
    const state = crypto.randomBytes(12).toString('hex');
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const srv = http.createServer(async (req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      if (u.pathname !== '/callback') { res.writeHead(404); return res.end(); }
      const ok = u.searchParams.get('state') === state && u.searchParams.get('code');
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<body style="font:15px system-ui;padding:40px;color:#333">${ok ? 'YouTube connected. You can close this tab and return to Euclidean.' : 'Authorization failed. Return to Euclidean and try again.'}</body>`);
      srv.close();
      if (!ok) return;
      try {
        const redirect = `http://127.0.0.1:${srv.address()?.port || port}/callback`;
        const r = await fetch(G_TOKEN, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ code: u.searchParams.get('code'), client_id: secrets.get('global.google.clientId'), client_secret: secrets.get('global.google.clientSecret'), redirect_uri: redirect, grant_type: 'authorization_code', code_verifier: verifier }) });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error_description || j.error);
        secrets.set(`client.${clientId}.youtube.token`, { ...j, obtainedAt: Date.now() });
        const ch = await ytApi(clientId, 'channels?part=snippet&mine=true');
        const title = ch.items?.[0]?.snippet?.title || 'YouTube channel';
        ctx.store.update('clients', clientId, (c) => ({ accounts: { ...(c.accounts || {}), youtube: { connected: true, name: title, at: new Date().toISOString() } } }));
        require('../core/events').publish('clients', { id: clientId });
      } catch (e) { console.error('[youtube] token exchange failed', e.message); }
    });
    let port = 0;
    srv.listen(0, '127.0.0.1', () => {
      port = srv.address().port;
      const redirect = `http://127.0.0.1:${port}/callback`;
      pendingOAuth.set(state, { clientId, srv });
      setTimeout(() => { try { srv.close(); } catch { /* already closed */ } }, 10 * 60 * 1000);
      resolve(`${G_AUTH}?${new URLSearchParams({ client_id: secrets.get('global.google.clientId'), redirect_uri: redirect, response_type: 'code', scope: YT_SCOPES, access_type: 'offline', prompt: 'consent', state, code_challenge: challenge, code_challenge_method: 'S256' })}`);
    });
    srv.on('error', reject);
  });
}

async function ytAccessToken(clientId) {
  const t = secrets.get(`client.${clientId}.youtube.token`);
  if (!t) throw new Error('YouTube is not connected for this client');
  if (t.access_token && Date.now() < t.obtainedAt + (t.expires_in - 120) * 1000) return t.access_token;
  if (!t.refresh_token) throw new Error('YouTube authorization expired: reconnect the channel');
  const r = await fetch(G_TOKEN, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: secrets.get('global.google.clientId'), client_secret: secrets.get('global.google.clientSecret'), refresh_token: t.refresh_token, grant_type: 'refresh_token' }) });
  const j = await r.json();
  if (!r.ok) throw new Error(`YouTube token refresh failed: ${j.error_description || j.error} (reconnect the channel)`);
  secrets.set(`client.${clientId}.youtube.token`, { ...t, ...j, obtainedAt: Date.now() });
  return j.access_token;
}

async function ytApi(clientId, pathQ) {
  const r = await fetch(`https://www.googleapis.com/youtube/v3/${pathQ}`, { headers: { authorization: `Bearer ${await ytAccessToken(clientId)}` } });
  const j = await r.json();
  if (!r.ok) throw new Error(`YouTube API: ${j.error?.message || r.status}`);
  return j;
}

async function ytUpload({ client, post, videoPath }) {
  const token = await ytAccessToken(client.id);
  const meta = {
    snippet: { title: post.title.slice(0, 100), description: captionFor('youtube', post), tags: (post.hashtags || []).map((h) => h.replace(/^#/, '')).slice(0, 15), categoryId: client.type === 'political' ? '25' : '22' },
    status: { privacyStatus: 'private', selfDeclaredMadeForKids: false },
  };
  const when = post.scheduledAt && new Date(post.scheduledAt) > new Date(Date.now() + 15 * 60000);
  if (when) meta.status.publishAt = new Date(post.scheduledAt).toISOString(); else meta.status.privacyStatus = 'public';
  const size = fs.statSync(videoPath).size;
  const init = await fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=UTF-8', 'x-upload-content-type': 'video/mp4', 'x-upload-content-length': String(size) }, body: JSON.stringify(meta),
  });
  if (!init.ok) { const j = await init.json().catch(() => ({})); throw new Error(`YouTube upload init: ${j.error?.message || init.status}`); }
  const loc = init.headers.get('location');
  const up = await fetch(loc, { method: 'PUT', headers: { 'content-type': 'video/mp4', 'content-length': String(size) }, body: fs.createReadStream(videoPath), duplex: 'half', signal: AbortSignal.timeout(1800000) });
  const j = await up.json().catch(() => ({}));
  if (!up.ok) throw new Error(`YouTube upload: ${j.error?.message || up.status}`);
  return { ok: true, mode: 'youtube', results: { youtube: { status: when ? 'scheduled' : 'published', id: j.id, url: `https://youtube.com/shorts/${j.id}` } } };
}

async function ytStats(clientId, videoIds) {
  if (!videoIds.length) return {};
  const j = await ytApi(clientId, `videos?part=statistics&id=${videoIds.slice(0, 50).join(',')}`);
  return Object.fromEntries((j.items || []).map((v) => [v.id, { views: +v.statistics.viewCount || 0, likes: +v.statistics.likeCount || 0, comments: +v.statistics.commentCount || 0 }]));
}

/** Pick the connector for a post. In the test environment everything goes to the Manual Pack. */
async function publish({ client, post, videoPath }) {
  const env = ctx.setting('environment', 'test');
  const results = { mode: [], results: {} };
  if (env !== 'production') {
    const r = manualPack({ client, post, videoPath });
    return { ...r, note: 'Test environment: packaged locally, nothing was posted publicly.' };
  }
  const provider = ctx.setting('publishing.provider', 'manual');
  const wantsYtDirect = ctx.setting('publishing.youtubeDirect', false) && post.platforms.includes('youtube') && secrets.has(`client.${client.id}.youtube.token`);
  if (wantsYtDirect) {
    const r = await ytUpload({ client, post, videoPath });
    results.mode.push('youtube'); Object.assign(results.results, r.results);
  }
  const rest = { ...post, platforms: post.platforms.filter((p) => !(wantsYtDirect && p === 'youtube')) };
  if (rest.platforms.length) {
    if (provider === 'ayrshare') { const r = await ayrPost({ client, post: rest, videoPath }); results.mode.push('ayrshare'); results.providerId = r.providerId; Object.assign(results.results, r.results); }
    else { const r = manualPack({ client, post: rest, videoPath }); results.mode.push('manual'); results.path = r.path; Object.assign(results.results, r.results); }
  }
  return { ok: true, mode: results.mode.join('+'), ...results };
}

module.exports = { PLATFORMS, captionFor, publish, manualPack, ayrConfigured, ayrTest, ayrAnalytics, ytConfigured, ytBeginAuth, ytStats, ytAccessToken };
