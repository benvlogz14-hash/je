'use strict';
/**
 * Video analysis beyond the transcript: scene cuts (visual changes) and audio
 * energy peaks (laughter, applause, raised voices). These signals go to the
 * clip-discovery agent alongside the transcript and drive the heuristic picker
 * when no AI is connected. Results are cached per footage file.
 */
const fs = require('fs');
const path = require('path');
const ff = require('./ffmpeg');
const { run } = require('../core/util');

async function analyze(asset, { onProgress, signal } = {}) {
  const cache = path.join(asset.workDir, `${asset.id}.analysis.json`);
  if (fs.existsSync(cache)) return JSON.parse(fs.readFileSync(cache, 'utf8'));
  const dur = asset.info?.duration || 0;
  const result = { scenes: [], energy: [], peaks: [], duration: dur };
  if (asset.info?.hasVideo) {
    // Scene changes on a small, low-fps proxy: cheap even for multi-hour streams.
    const r = await run(ff.bin('ffmpeg'), ['-hide_banner', '-nostats', '-i', asset.path, '-an', '-vf', "fps=6,scale=256:-2,select='gt(scene\\,0.32)',showinfo", '-f', 'null', '-'], {
      timeoutMs: 4 * 3600000, priority: ff.priorityValue(), signal,
      onStderrLine: (l) => { const m = /pts_time:([\d.]+)/.exec(l); if (m) { result.scenes.push(Math.round(Number(m[1]) * 100) / 100); if (onProgress && dur) onProgress(Math.min(0.6, (Number(m[1]) / dur) * 0.6)); } },
    });
    void r;
  }
  if (asset.info?.hasAudio) {
    // Short-term loudness once per second; peaks are moments well above the clip's median.
    const r = await run(ff.bin('ffmpeg'), ['-hide_banner', '-nostats', '-i', asset.path, '-vn', '-af', 'ebur128=framelog=info', '-f', 'null', '-'], { timeoutMs: 4 * 3600000, priority: ff.priorityValue(), signal });
    const pts = [...r.err.matchAll(/t:\s*([\d.]+)\s+TARGET:.*?M:\s*-?[\d.]+\s+S:\s*(-?[\d.]+)/g)].map((m) => ({ t: Number(m[1]), s: Number(m[2]) }));
    const perSec = []; for (const p of pts) { const k = Math.floor(p.t); if (!perSec[k] || p.s > perSec[k].s) perSec[k] = { t: k, s: p.s }; }
    result.energy = perSec.filter(Boolean).filter((p) => p.s > -70).map((p) => ({ t: p.t, lufs: Math.round(p.s * 10) / 10 }));
    const sorted = result.energy.map((e) => e.lufs).sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] ?? -30;
    let lastPeak = -10;
    for (const e of result.energy) if (e.lufs > median + 6 && e.t - lastPeak > 8) { result.peaks.push(e.t); lastPeak = e.t; }
    result.medianLufs = median;
  }
  if (onProgress) onProgress(1);
  fs.writeFileSync(cache, JSON.stringify(result));
  return result;
}

/** Compact text for the discovery prompt. */
function summarize(a) {
  if (!a) return '';
  const fmt = (t) => Math.round(t);
  return [
    a.scenes.length ? `SCENE CUTS (seconds): ${a.scenes.slice(0, 300).map(fmt).join(', ')}` : '',
    a.peaks.length ? `AUDIO ENERGY PEAKS (laughter/applause/raised voices, seconds): ${a.peaks.slice(0, 120).map(fmt).join(', ')}` : '',
  ].filter(Boolean).join('\n');
}

module.exports = { analyze, summarize };
