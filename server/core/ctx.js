'use strict';
/** Shared engine context, populated once by server/index.js at boot. */
const ctx = {
  store: null,
  version: require('../../package.json').version,
  startedAt: null,
  capabilities: {},          // detected tools: ffmpeg, ffprobe, ytdlp, whisper, nvenc, libass
  setting(pathStr, fallback) {
    let v = ctx.store && ctx.store.settings;
    for (const k of pathStr.split('.')) { if (v == null) break; v = v[k]; }
    return v === undefined ? fallback : v;
  },
};
module.exports = ctx;
