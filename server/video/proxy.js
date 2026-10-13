'use strict';
/**
 * Studio preview proxies. The program monitor plays media in Chromium, which
 * can't decode HEVC/H.265 (most phone footage), ProRes, DNxHD, or AVI/MTS/MXF
 * containers, and stutters on 4K. For those files a small H.264 copy is made in
 * the background and used for preview only; exports always use the original.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const ctx = require('../core/ctx');
const paths = require('../core/paths');
const events = require('../core/events');
const { run } = require('../core/util');
const ff = require('./ffmpeg');

const PLAYABLE_CODECS = new Set(['h264', 'vp8', 'vp9', 'av1']);
const PLAYABLE_EXT = new Set(['.mp4', '.m4v', '.mov', '.webm']);

function needsProxy(file, info) {
  if (!info?.hasVideo) return false;
  if (!PLAYABLE_CODECS.has(String(info.vcodec || '').toLowerCase())) return true;
  if (!PLAYABLE_EXT.has(path.extname(file).toLowerCase())) return true;
  return Math.max(info.width || 0, info.height || 0) > 2560; // 4K and above: preview from a lighter copy
}

function proxyPath(file) {
  let st = { size: 0, mtimeMs: 0 }; try { st = fs.statSync(file); } catch { /* ignore */ }
  const h = crypto.createHash('md5').update(`${file}|${st.size}|${st.mtimeMs}`).digest('hex');
  return path.join(paths.tmp('proxies'), `${h}.mp4`);
}

const queue = [];
let busy = false;

/** Queue a proxy for a Studio media item; the project is updated and the UI told when it's ready. */
function make(projectId, media) {
  const out = proxyPath(media.path);
  if (fs.existsSync(out)) { media.proxy = out; media.proxyPending = false; return; }
  queue.push({ projectId, mediaId: media.id, src: media.path, out });
  pump();
}

async function pump() {
  if (busy || !queue.length) return;
  busy = true;
  const job = queue.shift();
  const tmp = job.out.replace(/\.mp4$/, '.part.mp4');
  let ok = false; let error = null;
  try {
    await run(ff.bin('ffmpeg'), ['-hide_banner', '-y', '-i', job.src, '-map', '0:v:0', '-map', '0:a:0?', '-vf', "scale='if(gt(iw,ih),-2,min(720,iw))':'if(gt(iw,ih),min(720,ih),-2)'", '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-pix_fmt', 'yuv420p', '-g', '30', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', tmp],
      { timeoutMs: 6 * 3600000, priority: os.constants.priority.PRIORITY_BELOW_NORMAL });
    fs.renameSync(tmp, job.out); ok = true;
  } catch (e) { error = 'Preview copy failed: ' + e.message.slice(0, 200); try { fs.unlinkSync(tmp); } catch { /* none */ } }
  const pr = ctx.store.get('projects', job.projectId);
  if (pr) {
    const data = pr.data; const m = (data.media || []).find((x) => x.id === job.mediaId);
    if (m) { m.proxyPending = false; if (ok) m.proxy = job.out; else m.proxyError = error; ctx.store.update('projects', pr.id, { data }); }
  }
  events.publish('studio.proxy', { projectId: job.projectId, mediaId: job.mediaId, proxy: ok ? job.out : null, error });
  busy = false;
  pump();
}

module.exports = { needsProxy, make, proxyPath };
