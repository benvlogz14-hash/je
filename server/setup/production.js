'use strict';
/**
 * What's stopping Production right now, in plain English, with a fix for each.
 * Shown as a banner on the Production page so "nothing is happening" never goes unexplained.
 */
const ctx = require('../core/ctx');
const queue = require('../jobs/queue');
const ff = require('../video/ffmpeg');
const ai = require('../integrations/ai');
const tools = require('../agents/tools');

let lastDetect = 0;
/** Look for FFmpeg and friends again (they may have been installed since the app started). */
async function refreshTools(force = false) {
  if (!force && Date.now() - lastDetect < 60000) return ctx.capabilities;
  lastDetect = Date.now();
  try { Object.assign(ctx.capabilities, await ff.detect()); } catch { /* keep what we had */ }
  return ctx.capabilities;
}

async function health(clientId) {
  const caps = await refreshTools();
  const issues = [];
  if (queue.paused) issues.push({ key: 'paused', level: 'error', text: 'Automation is paused, so nothing runs.', fix: { action: 'resume', label: 'Resume' } });
  if (ctx.setting('resources.mode', 'full') === 'lite') issues.push({ key: 'lite', level: 'error', text: 'Lite mode is on, so video work is paused (only messages and posting run).', fix: { action: 'full', label: 'Switch to Full' } });
  if (!ctx.setting('resources.runHeavyJobsLocally', true)) issues.push({ key: 'remote', level: 'error', text: 'Video work is set to run on another computer only, so nothing renders here.', fix: { action: 'local', label: 'Run it on this PC' } });
  const waiting = ctx.store.all('jobs', (j) => j.status === 'queued' && j.note && /^Waiting/.test(j.note)).slice(-1)[0];
  if (waiting) issues.push({ key: 'waiting', level: 'warn', text: `Jobs are waiting: ${waiting.note}` });
  if (!caps.ffmpeg || !caps.ffprobe) issues.push({ key: 'ffmpeg', level: 'error', text: "FFmpeg isn't installed (or can't be found). It reads and makes every video, so imports stay stuck without it.", fix: { action: 'ffmpeg', label: 'Install FFmpeg' } });
  if (!caps.ytdlp) issues.push({ key: 'ytdlp', level: 'warn', text: "yt-dlp isn't installed, so video links can't be downloaded (uploads still work).", fix: { action: 'ffmpeg', label: 'Install it' } });
  const whisper = require('./whisper').status().ready;
  if (!whisper && !ai.connected('openai')) issues.push({ key: 'speech', level: 'warn', text: 'No speech-to-text yet, so clips get no captions and weaker picks.', fix: { action: 'whisper', label: 'Install free speech-to-text' } });
  await ai.pingOllama().catch(() => {});
  if (!ai.anyConnected()) issues.push({ key: 'ai', level: 'warn', text: 'No AI is on, so clips are picked from the audio only.', fix: { action: 'ollama', label: 'Turn on Ollama (free)' } });
  if (clientId) {
    const day = new Date(Date.now() - 864e5).toISOString();
    const failed = ctx.store.all('jobs', (j) => j.clientId === clientId && j.status === 'failed' && (j.finishedAt || '') > day).slice(-1)[0];
    if (failed) issues.push({ key: 'failed', level: 'warn', text: `Last problem: ${failed.title}: ${failed.error || 'failed'}`, fix: failed.payload?.assetId ? { action: 'retry-asset', assetId: failed.payload.assetId, label: 'Retry' } : { action: 'retry-job', jobId: failed.id, label: 'Retry' } });
  }
  return { ok: !issues.some((i) => i.level === 'error'), issues, paused: queue.paused };
}

/** One click: install FFmpeg and yt-dlp with Windows' own installer, then look for them again. */
async function installFfmpeg(h) {
  if (!tools.WIN) throw new Error(process.platform === 'darwin' ? 'Install FFmpeg with Homebrew, then restart Euclidean.' : 'Install FFmpeg with your package manager, then restart Euclidean.');
  const winget = tools.findExecutable(['winget']);
  if (!winget) throw new Error('Open the Microsoft Store, install "App Installer", then click Install FFmpeg again.');
  if (!ctx.capabilities.ffmpeg || !ctx.capabilities.ffprobe) { h.progress(0.1, 'Installing FFmpeg'); await tools.exec(winget, ['install', '-e', '--id', 'Gyan.FFmpeg', '--accept-package-agreements', '--accept-source-agreements', '--silent'], { timeoutMs: 20 * 60000 }).catch(() => {}); }
  if (!ctx.capabilities.ytdlp) { h.progress(0.6, 'Installing yt-dlp'); await tools.exec(winget, ['install', '-e', '--id', 'yt-dlp.yt-dlp', '--accept-package-agreements', '--accept-source-agreements', '--silent'], { timeoutMs: 10 * 60000 }).catch(() => {}); }
  h.progress(0.9, 'Checking');
  const caps = await refreshTools(true);
  if (!caps.ffmpeg || !caps.ffprobe) throw new Error('FFmpeg installed, but Euclidean can\'t see it yet. Close Euclidean fully (the Stop button, then close the window) and open it again.');
  // Restart footage that got stuck waiting for FFmpeg.
  for (const a of ctx.store.all('assets', (x) => x.status === 'importing')) {
    if (!ctx.store.find('jobs', (j) => j.payload?.assetId === a.id && ['queued', 'running'].includes(j.status))) queue.enqueue('ingest.file', { assetId: a.id, autoProcess: true }, { clientId: a.clientId, dedupeKey: `ingest:${a.id}:${Date.now()}`, priority: 6 });
  }
  return { ok: true };
}

module.exports = { health, refreshTools, installFfmpeg };
