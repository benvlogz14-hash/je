'use strict';
/**
 * Automation health monitor: failed jobs, expired credentials, disconnected
 * services, stalled jobs, offline workers, disk space and missing tools.
 * Every check reports ok / warn / error with a plain-language fix.
 */
const ctx = require('../core/ctx');
const events = require('../core/events');
const secrets = require('../core/secrets');
const ai = require('../integrations/ai');
const twilio = require('../integrations/twilio');
const email = require('../integrations/email');
const publishing = require('../integrations/publishing');
const resources = require('./resources');
const handoff = require('./handoff');
const queue = require('../jobs/queue');

let lastReport = null; let timer = null;
const alerted = new Map();

function check() {
  const items = [];
  // 'setup' = optional service not connected yet. It is shown in System → Health but never counted as a problem.
  const add = (key, label, level, text, fix) => items.push({ key, label, level, text, fix });
  const caps = ctx.capabilities;
  add('ffmpeg', 'FFmpeg', caps.ffmpeg && caps.ffprobe ? 'ok' : 'error', caps.ffmpeg ? `Version ${caps.ffmpegVersion} · encoders: ${(caps.encoders || []).join(', ')}` : 'Not found: rendering and intake are unavailable', 'Install FFmpeg (winget install Gyan.FFmpeg) or set its path in Settings → System');
  if (caps.ffmpeg && !caps.libass) add('libass', 'Caption burn-in', 'warn', 'This FFmpeg build has no libass; captions will be missing from renders', 'Use a full FFmpeg build (gyan.dev "full" or BtbN GPL)');
  add('ytdlp', 'Link downloads (yt-dlp)', caps.ytdlp ? 'ok' : 'setup', caps.ytdlp ? `yt-dlp ${caps.ytdlpVersion}` : 'Not installed: YouTube/Drive/Twitch links cannot be downloaded', 'winget install yt-dlp.yt-dlp');
  for (const [k, p] of Object.entries(ai.PROVIDERS)) {
    const st = ai.agentStatus().providers[k];
    if (k === 'ollama') { add('ai.ollama', 'Llama on this computer (Ollama)', st.connected ? 'ok' : 'setup', st.connected ? `Running · free · models: ${(st.health?.models || []).join(', ')}` : st.health?.error || 'Not running', 'Install Ollama from ollama.com, then run: ollama pull llama3.2'); continue; }
    if (!st.connected) add(`ai.${k}`, `${p.label} (${p.vendor})`, 'setup', 'Not connected', 'Add an API key in Settings → Connections');
    else if (st.health && !st.health.ok) add(`ai.${k}`, `${p.label} (${p.vendor})`, 'error', st.health.error, 'Check or replace the API key');
    else if (st.overBudget) add(`ai.${k}`, `${p.label} (${p.vendor})`, 'warn', `Monthly budget reached ($${st.spendUsd} of $${st.budgetUsd}); using fallbacks`, 'Raise the budget in Settings → AI');
    else add(`ai.${k}`, `${p.label} (${p.vendor})`, 'ok', `Connected · $${st.spendUsd} spent this month`);
  }
  const transcriptionOk = ai.connected('openai') || caps.whisper;
  add('transcription', 'Transcription', transcriptionOk ? 'ok' : 'setup', transcriptionOk ? (caps.whisper ? 'Local whisper.cpp' : 'OpenAI Whisper') : 'No engine: clips render without captions', 'Connect OpenAI or point Settings → AI at a whisper.cpp binary and model');
  add('sms', 'SMS (Twilio)', !twilio.configured() ? 'setup' : twilio.state.ok === false ? 'error' : 'ok', !twilio.configured() ? 'Not connected' : twilio.state.ok === false ? twilio.state.lastError : `Polling every ${ctx.setting('messaging.smsPollSeconds', 20)}s${twilio.state.lastPoll ? ` · last ${twilio.state.lastPoll.slice(11, 19)}` : ''}`, 'Settings → Connections → Twilio');
  add('email', 'Email', !email.configured() ? 'setup' : email.state.ok === false ? 'error' : 'ok', !email.configured() ? 'Not connected' : email.state.ok === false ? email.state.lastError : `IMAP polling${email.state.lastPoll ? ` · last ${email.state.lastPoll.slice(11, 19)}` : ''}`, 'Settings → Connections → Email (use an app password)');
  const pubProvider = ctx.setting('publishing.provider', 'manual');
  add('publishing', 'Publishing', pubProvider === 'ayrshare' && !publishing.ayrConfigured() ? 'error' : pubProvider === 'manual' ? 'setup' : 'ok', pubProvider === 'manual' ? 'Manual Pack: videos and captions are packaged for hand posting' : publishing.ayrConfigured() ? 'Ayrshare connected' : 'Ayrshare selected but no API key', 'Connect Ayrshare in Settings → Connections to crosspost automatically');
  for (const c of ctx.store.all('clients', (x) => x.status === 'active')) {
    if (secrets.has(`client.${c.id}.youtube.token`)) {
      const t = secrets.get(`client.${c.id}.youtube.token`);
      if (!t.refresh_token) add(`yt.${c.id}`, `${c.name} · YouTube`, 'warn', 'No refresh token; will expire within the hour', 'Reconnect the channel');
    }
    if (c.schedule?.autopilot) {
      const q = require('./pipeline').quotaStatus(c);
      if (q.open > 0 && !q.unusedFootage && !q.inProduction && !q.inReview) add(`quota.${c.id}`, `${c.name} · quota`, 'warn', `${q.open} open slots and no footage left`, 'Ask the client for footage or add a YouTube channel source');
    }
  }
  const stalled = ctx.store.all('jobs', (j) => j.status === 'running' && j.startedAt && Date.now() - new Date(j.startedAt).getTime() > 3 * 3600000);
  add('jobs.stalled', 'Stalled jobs', stalled.length ? 'error' : 'ok', stalled.length ? `${stalled.length} job(s) running over 3 hours` : 'None', 'Open the Queue and cancel or retry');
  const st = queue.stats();
  add('jobs.failed', 'Failed jobs (24h)', st.failed24h ? 'warn' : 'ok', `${st.failed24h} failed · ${st.done24h} completed`, 'Open the Queue to retry');
  add('queue', 'Automation', queue.paused ? 'error' : 'ok', queue.paused ? 'Emergency stop is active: nothing is being sent or published' : 'Running', 'Resume from the status bar or /resume');
  const workers = ctx.store.all('workers');
  for (const w of workers) { const online = Date.now() - new Date(w.lastSeen).getTime() < 120000; add(`worker.${w.id}`, `Worker · ${w.name}`, online ? 'ok' : 'warn', online ? `Online · ${w.capabilities.join(', ')}` : `Offline since ${w.lastSeen.slice(0, 16).replace('T', ' ')}`, 'Start "npm run worker" on that machine'); }
  const hs = handoff.status();
  if (hs.waiting) add('computer-use', 'Computer-use agent (Astra)', hs.online ? 'ok' : 'warn', `${hs.waiting} Premiere job(s) waiting${hs.online ? '' : '; no agent has checked in for 2 minutes'}`, 'Start Astra and point it at the agent API (Settings → Agents)');
  const r = resources.last;
  if (r?.disk) add('disk', 'Disk space', r.disk.freeGb < 10 ? 'error' : r.disk.freeGb < 40 ? 'warn' : 'ok', `${r.disk.freeGb} GB free of ${r.disk.totalGb} GB`, 'Archive old renders or move the data folder');
  if (ctx.setting('environment', 'test') !== 'production') add('environment', 'Environment', 'setup', 'TEST: outbound messages go to the sandbox recipient and nothing is posted publicly', 'Switch to Production in Settings → General when ready');
  const summary = { ok: items.filter((i) => i.level === 'ok').length, warn: items.filter((i) => i.level === 'warn').length, error: items.filter((i) => i.level === 'error').length, setup: items.filter((i) => i.level === 'setup').length };
  lastReport = { at: new Date().toISOString(), items, summary };
  for (const i of items.filter((x) => x.level === 'error')) {
    const prev = alerted.get(i.key);
    if (!prev || Date.now() - prev > 6 * 3600000) { alerted.set(i.key, Date.now()); events.publish('alert', { level: 'error', title: i.label, text: i.text }); }
  }
  events.publish('health', lastReport, { coalesceKey: 'health' });
  return lastReport;
}

function start() { setTimeout(check, 4000); timer = setInterval(check, 60000); }
module.exports = { start, check, get last() { return lastReport; } };
