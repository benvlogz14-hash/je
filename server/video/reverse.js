'use strict';
/**
 * Copy a video's style: download any video (or read an uploaded file), then
 * measure and look at everything about how it was made, and write a recipe
 * Euclidean can reuse.
 *
 *  - FFmpeg: every cut, seconds per shot, colours per shot, loudness, a contact sheet.
 *  - Shot by shot (vision.js): what's on screen, shot types, on-screen text.
 *  - Speech (when a transcription engine is set up): words per minute and the opening line.
 *  - An AI that can see reads the frames and writes the recipe: hook, structure,
 *    caption style, text overlays, transitions, effects, colour grade, B-roll and music feel.
 *
 * Recipes can be applied to a client's captions and editing memory, or to the
 * political ads' pacing.
 */
const fs = require('fs');
const path = require('path');
const ctx = require('../core/ctx');
const paths = require('../core/paths');
const ai = require('../integrations/ai');
const ff = require('./ffmpeg');
const vision = require('./vision');
const { run } = require('../core/util');
const { fetchSource } = require('./reference');

const hex = (r, g, b) => `#${[r, g, b].map((x) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0')).join('')}`;

/** Average colour of a still, read as raw pixels from FFmpeg. */
async function colorOf(file, at) {
  try {
    const r = await new Promise((ok, bad) => {
      const { spawn } = require('child_process');
      const p = spawn(ff.bin('ffmpeg'), ['-hide_banner', '-loglevel', 'error', '-ss', at.toFixed(2), '-i', file, '-frames:v', '1', '-vf', 'scale=8:8,format=rgb24', '-f', 'rawvideo', '-'], { windowsHide: true });
      const chunks = []; p.stdout.on('data', (c) => chunks.push(c)); p.on('error', bad); p.on('close', () => ok(Buffer.concat(chunks)));
    });
    if (r.length < 3) return null;
    // Most saturated pixel and the average: the accent and the overall grade.
    let sr = 0, sg = 0, sb = 0, best = null, bestSat = -1; const n = r.length / 3;
    for (let i = 0; i < r.length; i += 3) {
      const R = r[i], G = r[i + 1], B = r[i + 2]; sr += R; sg += G; sb += B;
      const sat = Math.max(R, G, B) - Math.min(R, G, B); if (sat > bestSat) { bestSat = sat; best = [R, G, B]; }
    }
    return { avg: hex(sr / n, sg / n, sb / n), accent: bestSat > 60 ? hex(...best) : null };
  } catch { return null; }
}

async function loudness(file) {
  try {
    const r = await run(ff.bin('ffmpeg'), ['-hide_banner', '-nostats', '-i', file, '-vn', '-af', 'ebur128', '-f', 'null', '-'], { timeoutMs: 300000 });
    const m = /I:\s*(-?[\d.]+) LUFS[\s\S]*?LRA:\s*([\d.]+) LU/.exec(r.err.split('Summary:').pop() || '');
    return m ? { lufs: Number(m[1]), range: Number(m[2]) } : null;
  } catch { return null; }
}

const CAPTION_KEYS = ['position', 'uppercase', 'wordsPerLine', 'primary', 'highlight', 'outline', 'box', 'animation', 'font'];

/** Study one video. Returns the recipe (also saved in the recipe list). */
async function study(src, { onProgress = () => {}, jobId } = {}) {
  const id = `rv_${Date.now().toString(36)}`;
  const dir = path.join(paths.root, 'reverse', id); fs.mkdirSync(dir, { recursive: true });
  onProgress(0.03, 'Getting the video');
  const file = await fetchSource(src, dir);
  const info = await ff.probe(file);
  if (!info.duration) throw new Error("Couldn't read that video.");
  const duration = Math.min(info.duration, 600);

  onProgress(0.1, 'Measuring the cuts and pacing');
  const ref = await require('./reference').analyze(file, dir).catch(() => null);
  onProgress(0.2, 'Looking through it shot by shot');
  const seen = await vision.look(file, { workDir: dir, maxShots: 40, jobId, purpose: 'reverse-engineering how this video was edited (captions, text overlays, transitions, effects, shot types)', onProgress: (f, t) => onProgress(0.2 + f * 0.45, t) });
  onProgress(0.66, 'Reading the colours and sound');
  const colors = [];
  for (const x of seen.shots.slice(0, 24)) { const c = await colorOf(file, (x.s + x.e) / 2); if (c) colors.push(c); }
  const accents = Object.entries(colors.reduce((m, c) => { if (c.accent) m[c.accent] = (m[c.accent] || 0) + 1; return m; }, {})).sort((a, b) => b[1] - a[1]).map(([h]) => h).slice(0, 5);
  const sound = info.hasAudio ? await loudness(file) : null;

  let speech = null;
  if (info.hasAudio) {
    try {
      onProgress(0.72, 'Listening to the words');
      const t = await require('./intelligence').transcribe({ id: 'speech', path: file, workDir: dir, info: { duration }, clientId: null });
      const words = (t.words || []).filter((w) => w.s < duration);
      speech = { wordsPerMinute: Math.round((words.length / Math.max(1, duration)) * 60), opening: (t.segments || []).slice(0, 2).map((s) => s.t).join(' ').slice(0, 300), talkingShare: Math.round((words.reduce((s, w) => s + (w.e - w.s), 0) / duration) * 100) };
    } catch { /* no transcription engine: skip speech */ }
  }

  const measured = {
    src: String(src).slice(0, 500), duration: Math.round(duration * 10) / 10, vertical: info.height > info.width, size: `${info.width}×${info.height}`,
    cuts: ref?.cuts ?? null, avgShot: ref?.avgShot ?? null, cutsPerMinute: ref?.cutsPerMinute ?? null,
    shotKinds: seen.shots.reduce((m, x) => { m[x.kind] = (m[x.kind] || 0) + 1; return m; }, {}),
    onScreenText: [...new Set(seen.shots.map((x) => x.text).filter(Boolean))].slice(0, 12),
    palette: accents, grade: colors.length ? colors.map((c) => c.avg) : [], loudness: sound, speech, motion: Math.round((seen.shots.reduce((s, x) => s + (x.motion || 0), 0) / Math.max(1, seen.shots.length)) * 10) / 10,
  };

  let recipe = null; let agent = 'measured';
  const frames = seen.shots.filter((x) => x.frame && fs.existsSync(x.frame));
  const pick = frames.length <= 10 ? frames : Array.from({ length: 10 }, (_, i) => frames[Math.floor((i * frames.length) / 10)]);
  if (ai.canSee() && pick.length) {
    onProgress(0.8, 'Working out how it was made');
    try {
      const r = await ai.ask({ role: 'analysis', json: true, maxTokens: 2500, jobId, images: pick.map((x) => x.frame),
        system: 'You are a senior short-form video editor. Reverse-engineer how a video was edited so another editor can recreate the style with different footage. Be concrete and practical. Only describe what the frames and measurements show; say "unclear" rather than guess.',
        prompt: `The images are stills in order from these shots: ${pick.map((x, k) => `image ${k + 1} at ${x.s.toFixed(1)}s (${x.kind}${x.what ? `: ${x.what}` : ''})`).join('; ')}.\nMEASUREMENTS: ${JSON.stringify(measured).slice(0, 4000)}\n${vision.summarize(seen, { max: 40 })}\n\nReturn JSON: {"summary":"one or two sentences: what kind of video and what makes it work","hook":"how the first 2 seconds grab attention","structure":[{"at":seconds,"beat":"hook|setup|point|proof|payoff|cta|other","what":"short"}],"captions":{"present":true/false,"position":"lower|center|upper","uppercase":true/false,"wordsPerLine":1-6,"primary":"#hex","highlight":"#hex or empty","outline":"#hex","box":true/false,"animation":"pop|none","font":"bold sans|condensed|serif|handwritten|other"},"textOverlays":"titles, labels, emojis, stickers and how they appear","transitions":["hard cuts","whip pans","zoom transitions", "..."],"effects":["punch-in zooms on key words","shake","speed ramps","..."],"colorGrade":"short description","broll":"how B-roll is used","music":"music feel and how it sits under the voice (from the loudness numbers)","pacing":"plain-English pacing","recreate":["5-8 concrete steps to recreate this style in our editor"]}` });
      recipe = r.json; agent = `${r.provider}:${r.model}`;
    } catch (e) { measured.aiError = e.message; }
  }
  if (!recipe) {
    recipe = {
      summary: `${measured.vertical ? 'Vertical' : 'Horizontal'} video, ${measured.duration}s, ${measured.cuts ?? '?'} cuts (${measured.avgShot ?? '?'}s a shot).`,
      pacing: measured.avgShot ? `About ${measured.avgShot} seconds per shot, ${measured.cutsPerMinute} cuts a minute.` : 'Unknown',
      captions: { present: measured.onScreenText.length > 0 }, transitions: [], effects: [], recreate: ['Connect an AI that can see (or download the free Llama vision) for the full breakdown.'],
    };
  }
  const out = { id, at: new Date().toISOString(), agent, sheet: ref?.sheet || null, ...measured, recipe };
  fs.writeFileSync(path.join(dir, 'recipe.json'), JSON.stringify(out, null, 2));
  const list = [out, ...(ctx.setting('reverse.recipes', []) || [])].slice(0, 30);
  ctx.store.setSettings({ reverse: { recipes: list } });
  onProgress(1, 'Recipe ready');
  return out;
}

/** Caption settings from a recipe, in the client caption-style format. */
function captionStyle(rc) {
  const c = rc?.recipe?.captions || {}; if (!c.present) return null;
  const o = {};
  for (const k of CAPTION_KEYS) if (c[k] !== undefined && c[k] !== '' && c[k] !== 'unclear') o[k] = c[k];
  if (o.font) o.font = /condensed/i.test(o.font) ? 'Anton' : 'Montserrat';
  if (!['lower', 'center', 'upper'].includes(o.position)) delete o.position;
  if (!['pop', 'none'].includes(o.animation)) delete o.animation;
  o.highlightMode = o.highlight ? 'word' : 'none';
  return o;
}

/** Plain-English editing notes from a recipe, for a client's editing memory. */
function notes(rc) {
  const r = rc.recipe || {};
  return [`Copy the style of ${rc.src}: ${r.summary || ''}`, r.hook && `Hook: ${r.hook}`, r.pacing && `Pacing: ${r.pacing}`, (r.effects || []).length && `Effects: ${r.effects.join(', ')}`, (r.transitions || []).length && `Transitions: ${r.transitions.join(', ')}`, r.textOverlays && `Text overlays: ${r.textOverlays}`, r.colorGrade && `Colour: ${r.colorGrade}`]
    .filter(Boolean).join('\n').slice(0, 1500);
}

function list() { return ctx.setting('reverse.recipes', []) || []; }
function get(id) { return list().find((x) => x.id === id) || null; }
function remove(id) { ctx.store.setSettings({ reverse: { recipes: list().filter((x) => x.id !== id) } }); }

module.exports = { study, captionStyle, notes, list, get, remove };
