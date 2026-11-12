'use strict';
/**
 * YouTube posts from inside Euclidean (Nov 12, Ryan: "upload directly to Stringer's channel or any YouTuber's channel we
 * select: approve a clip, pick the time, the title, the description and the thumbnail in the program ... we don't want
 * anything sending out to Stringer yet").
 *
 *  - The HOLD (`publishing.hold`, ON by default): while it's on, nothing is uploaded anywhere. Scheduled posts reach
 *    their time and wait as "held"; switching the hold off puts every held post with a future time back on the
 *    schedule, and a held post whose time has passed waits for Publish now. The test environment still only packs
 *    files locally (publishing.publish) on top of this.
 *  - Each post's YouTube details (`post.yt`): the channel (any client whose YouTube is connected), title, description,
 *    tags, privacy after it goes live, thumbnail (a frame of the video or an uploaded image), set with
 *    `save(clipId, ...)`; the upload uses them (publishing.ytUpload) and sets the thumbnail after.
 *  - From Studio, `fromStudio(project, file)`: the edited video becomes the clip's newest version (or a new clip for a
 *    project not made from one), approved and put on the schedule, so it never has to be uploaded to YouTube by hand.
 */
const fs = require('fs');
const path = require('path');
const ctx = require('../core/ctx');
const paths = require('../core/paths');
const audit = require('../core/audit');
const events = require('../core/events');
const queue = require('../jobs/queue');
const { now } = require('../core/util');

const onHold = () => ctx.setting('publishing.hold', true) !== false;
const clean = (s, n) => String(s ?? '').replace(/[<>]/g, '').trim().slice(0, n);

/** Clients whose YouTube channel is connected (the channels a post can go to). */
function channels() {
  const secrets = require('../core/secrets');
  return ctx.store.all('clients', (c) => c.status !== 'archived' && secrets.has(`client.${c.id}.youtube.token`)).map((c) => ({ clientId: c.id, client: c.name, channel: c.accounts?.youtube?.name || 'YouTube channel' }));
}

function versionOf(clip, post) { return (clip.versions || [])[((post && post.version) || clip.currentVersion) - 1] || null; }

/** A still from the clip's video at `at` seconds (the thumbnail picker). Cached per version and tenth of a second. */
async function frame(clipId, at = 1) {
  const clip = ctx.store.get('clips', clipId); const v = clip && versionOf(clip);
  if (!v || !fs.existsSync(v.path)) throw Object.assign(new Error('This clip has no rendered video yet.'), { status: 404 });
  const t = Math.max(0, Math.min(Number(at) || 0, (v.duration || 60) - 0.05));
  const dir = paths.tmp('yt-frames'); const out = path.join(dir, `${clip.id}-v${v.n}-${Math.round(t * 10)}.jpg`);
  if (!fs.existsSync(out)) await require('../video/ffmpeg').thumbnail(v.path, out, t, 720);
  return out;
}

/** The thumbnail file for a post: YouTube wants JPG/PNG under 2 MB, at least 640 wide. */
async function makeThumb(clip, post, at) {
  const v = versionOf(clip, post); const dir = paths.clientDir(clip.clientId, 'thumbnails');
  const out = path.join(dir, `${post.id}-${Date.now().toString(36)}.jpg`);
  await require('../video/ffmpeg').thumbnail(v.path, out, Math.max(0, Number(at) || 0), 1280);
  return out;
}

/**
 * Set a clip's YouTube post: { at, channelClientId, title, description, tags, privacy, thumbAt | thumbFile | thumb: null }.
 * Makes the post when the clip has none yet (an approved clip with no free slot), and moves its publish time.
 */
async function save(clipId, b = {}, actor = 'user') {
  const clip = ctx.store.get('clips', clipId); if (!clip) throw Object.assign(new Error('Clip not found'), { status: 404 });
  if (!['approved', 'scheduled', 'published'].includes(clip.status)) throw Object.assign(new Error('Approve the clip first, then schedule it.'), { status: 400 });
  const chans = channels(); const chan = chans.find((c) => c.clientId === (b.channelClientId || clip.clientId)) || chans.find((c) => c.clientId === clip.clientId) || null;
  let at = b.at ? new Date(b.at) : null; if (at && isNaN(at)) at = null;
  if (at && at < new Date(Date.now() + 60000)) throw Object.assign(new Error('Pick a time at least a minute from now.'), { status: 400 });
  let post = clip.postId ? ctx.store.get('posts', clip.postId) : null;
  if (post && post.status === 'published') throw Object.assign(new Error('This one is already published.'), { status: 400 });
  if (!post) {
    if (!at) throw Object.assign(new Error('Pick when it should go up.'), { status: 400 });
    post = ctx.store.insert('posts', { clientId: clip.clientId, clipId, title: clip.title, caption: clip.caption, hashtags: clip.hashtags || [], platforms: ['youtube'], scheduledAt: at.toISOString(), status: 'scheduled', videoPath: versionOf(clip)?.path || null, results: {}, version: clip.currentVersion });
    ctx.store.update('clips', clipId, { status: 'scheduled', postId: post.id });
  }
  const yt = { ...(post.yt || {}) };
  if (chan) yt.channelClientId = chan.clientId;
  if (b.title !== undefined) yt.title = clean(b.title, 100);
  if (b.description !== undefined) yt.description = clean(b.description, 5000);
  if (b.tags !== undefined) yt.tags = [].concat(b.tags || []).flatMap((t) => String(t).split(',')).map((t) => t.replace(/^#/, '').trim()).filter(Boolean).slice(0, 30);
  if (['public', 'unlisted', 'private'].includes(b.privacy)) yt.privacy = b.privacy;
  if (b.thumb === null) yt.thumb = null;
  if (b.thumbAt !== undefined && b.thumbAt !== null) { yt.thumb = await makeThumb(clip, post, b.thumbAt); yt.thumbAt = Number(b.thumbAt); }
  if (b.thumbFile) yt.thumb = b.thumbFile;
  const patch = { yt, platforms: [...new Set([...(post.platforms || []), 'youtube'])], version: clip.currentVersion, videoPath: versionOf(clip)?.path || post.videoPath };
  if (at) patch.scheduledAt = at.toISOString();
  if (post.status === 'held' && at && at > new Date()) patch.status = onHold() ? 'held' : 'scheduled';
  post = ctx.store.update('posts', post.id, patch);
  schedule(post);
  audit.log(actor, 'post.youtube_set', { postId: post.id, clipId, channel: chan?.client || null, at: post.scheduledAt, hold: onHold() });
  events.publish('posts', { id: post.id });
  return { post, hold: onHold(), channel: chan };
}

/** (Re)queue the publish job at its time (15 minutes early, as the scheduler does). */
function schedule(post) {
  if (post.status !== 'scheduled') return;
  const runAt = new Date(new Date(post.scheduledAt).getTime() - 15 * 60000).toISOString();
  const job = ctx.store.find('jobs', (j) => j.dedupeKey === `publish:${post.id}` && j.status === 'queued');
  if (job) ctx.store.update('jobs', job.id, { runAt });
  else queue.enqueue('publish.post', { postId: post.id }, { clientId: post.clientId, runAt, title: `Publish: ${post.yt?.title || post.title}`, dedupeKey: `publish:${post.id}`, priority: 9 });
}

/** Called by the publish job: true = held (nothing uploaded). */
function holdIfOn(post) {
  if (!onHold()) return false;
  ctx.store.update('posts', post.id, { status: 'held', note: 'On hold (Publishing page): nothing was uploaded. It goes out once the hold is switched off.', heldAt: now() });
  audit.log('system', 'post.held', { postId: post.id, clientId: post.clientId });
  events.publish('posts', { id: post.id });
  return true;
}

/** Hold on/off. Off: every held post with a future time goes back on the schedule; past ones wait for Publish now. */
function setHold(on, actor = 'user') {
  ctx.store.setSettings({ publishing: { hold: !!on } });
  let back = 0; let waiting = 0;
  if (!on) {
    for (const p of ctx.store.all('posts', (x) => x.status === 'held')) {
      if (new Date(p.scheduledAt) > new Date(Date.now() + 60000)) { const q = ctx.store.update('posts', p.id, { status: 'scheduled', note: null }); schedule(q); back++; }
      else waiting++;
    }
  }
  audit.log(actor, on ? 'publishing.hold_on' : 'publishing.hold_off', { back, waiting });
  events.publish('posts', {});
  return { hold: !!on, back, waiting };
}

/** A held post whose time passed (or any scheduled one): publish it now (only with the hold off). */
function publishNow(postId, actor = 'user') {
  if (onHold()) throw Object.assign(new Error('Publishing is on hold. Switch the hold off on the Publishing page first.'), { status: 400 });
  const p = ctx.store.get('posts', postId); if (!p) throw Object.assign(new Error('Post not found'), { status: 404 });
  if (!['held', 'scheduled'].includes(p.status)) throw Object.assign(new Error(`This post is ${p.status}.`), { status: 400 });
  const q = ctx.store.update('posts', p.id, { status: 'scheduled', note: null, scheduledAt: new Date(Date.now() + 60000).toISOString() });
  const job = ctx.store.find('jobs', (j) => j.dedupeKey === `publish:${p.id}` && j.status === 'queued');
  if (job) ctx.store.update('jobs', job.id, { runAt: new Date().toISOString() });
  else queue.enqueue('publish.post', { postId: p.id }, { clientId: p.clientId, title: `Publish: ${p.yt?.title || p.title}`, dedupeKey: `publish:${p.id}` });
  audit.log(actor, 'post.publish_now', { postId: p.id });
  events.publish('posts', { id: p.id });
  return q;
}

/**
 * Studio → Send to Approved: the exported video becomes the clip's newest version (approved, on the schedule), or, for a
 * project not made from a clip, a new approved clip for the project's client. Returns the clip.
 */
async function fromStudio(project, file, actor = 'user') {
  const ff = require('../video/ffmpeg'); const pipeline = require('./pipeline');
  const info = await ff.probe(file).catch(() => ({}));
  let clip = project.clipId ? ctx.store.get('clips', project.clipId) : null;
  const clientId = clip?.clientId || project.clientId;
  if (!clientId) throw Object.assign(new Error('This project has no client. Open it from a clip, or pick the client.'), { status: 400 });
  const name = String(project.name || 'Studio edit').replace(/^#\d+\s+/, '').trim() || 'Studio edit';
  if (!clip) clip = ctx.store.insert('clips', { ref: pipeline.nextRef(), clientId, assetId: null, title: name, hook: name, caption: '', hashtags: [], status: 'approved', kind: 'studio', projectId: project.id, versions: [], currentVersion: 0, createdBy: actor });
  const n = (clip.versions || []).length + 1;
  const thumb = path.join(path.dirname(file), `${path.basename(file, path.extname(file))}.thumb.jpg`);
  try { await ff.thumbnail(file, thumb, Math.min(1, (info.duration || 2) / 3)); } catch { /* no thumb */ }
  const version = { n, path: file, thumb: fs.existsSync(thumb) ? thumb : null, duration: info.duration || 0, renderedAt: now(), fromStudio: project.id, qc: { passed: true, issues: [] }, captioned: true };
  const wasScheduled = clip.postId && ['scheduled', 'held'].includes(ctx.store.get('posts', clip.postId)?.status);
  ctx.store.update('clips', clip.id, (c) => ({ versions: [...(c.versions || []), version], currentVersion: n, status: wasScheduled ? 'scheduled' : 'approved', approvedBy: actor, approvedAt: now() }));
  for (const a of ctx.store.all('approvals', (x) => (x.refId === clip.id || x.id === clip.approvalId) && x.status === 'pending')) ctx.store.update('approvals', a.id, { status: 'approved', decidedBy: actor, decidedAt: now(), note: 'Edited in Studio' });
  if (wasScheduled) ctx.store.update('posts', clip.postId, { version: n, videoPath: file });
  else pipeline.scheduleClip(clip.id);
  audit.log(actor, 'clip.approved', { clipId: clip.id, clientId, stage: 'studio', note: 'Edited in Studio and sent to Approved' });
  events.publish('clips', { id: clip.id });
  return ctx.store.get('clips', clip.id);
}

module.exports = { onHold, channels, frame, save, schedule, holdIfOn, setHold, publishNow, fromStudio };
