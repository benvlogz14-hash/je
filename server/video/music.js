'use strict';
/**
 * Royalty-free music for the ads, matched to the ad's mood:
 *  1. the founders' own music folder (political.musicDir, "positive"/"contrast" subfolders),
 *  2. a free library downloaded once from Openverse (CC0 and CC BY music, no key needed),
 *     credited on the ad's end card when the licence asks for it,
 *  3. a music bed Euclidean writes itself with FFmpeg (always available, owned by nobody else).
 */
const fs = require('fs');
const path = require('path');
const ctx = require('../core/ctx');
const paths = require('../core/paths');
const ff = require('./ffmpeg');
const { run } = require('../core/util');

const MOODS = {
  positive: { search: ['uplifting inspirational', 'hopeful cinematic', 'upbeat motivational'], chords: [[261.63, 329.63, 392], [196, 246.94, 293.66], [220, 261.63, 329.63], [174.61, 220, 261.63]], bpm: 112 },
  contrast: { search: ['tense dramatic', 'dark suspense', 'serious cinematic'], chords: [[220, 261.63, 329.63], [174.61, 220, 261.63], [164.81, 196, 246.94], [146.83, 174.61, 220]], bpm: 84 },
  speech: { search: ['inspiring piano', 'emotional piano', 'gentle hopeful'], chords: [[261.63, 329.63, 392], [220, 261.63, 329.63], [174.61, 220, 261.63], [196, 246.94, 293.66]], bpm: 90 },
};
const AUDIO = /\.(mp3|m4a|wav|aac|ogg)$/i;

function fromFolder(mood) {
  const root = ctx.setting('political.musicDir', ''); if (!root) return null;
  const sub = path.join(root, mood === 'speech' ? 'positive' : mood);
  for (const dir of [sub, root]) { try { const list = fs.readdirSync(dir).filter((f) => AUDIO.test(f)); if (list.length) return { file: path.join(dir, list[(Math.random() * list.length) | 0]), credit: '' }; } catch { /* none */ } }
  return null;
}

const libDir = (mood) => { const d = path.join(paths.root, 'music', mood); fs.mkdirSync(d, { recursive: true }); return d; };
function library(mood) {
  const dir = libDir(mood); let credits = {};
  try { credits = JSON.parse(fs.readFileSync(path.join(dir, 'credits.json'), 'utf8')); } catch { /* none yet */ }
  return fs.readdirSync(dir).filter((f) => AUDIO.test(f) && !f.startsWith('generated')).map((f) => ({ file: path.join(dir, f), credit: credits[f] || '' }));
}

/** Download a few tracks for a mood from Openverse (free, no key). */
async function fill(mood, want = 4) {
  const dir = libDir(mood); let credits = {};
  try { credits = JSON.parse(fs.readFileSync(path.join(dir, 'credits.json'), 'utf8')); } catch { /* none */ }
  let got = library(mood).length;
  for (const q of MOODS[mood].search) {
    if (got >= want) break;
    let res;
    try { res = await (await fetch(`https://api.openverse.org/v1/audio/?q=${encodeURIComponent(q)}&license=cc0,by&category=music&length=medium,long&page_size=20`, { headers: { 'user-agent': 'EuclideanMedia/1.0' }, signal: AbortSignal.timeout(20000) })).json(); }
    catch { continue; }
    for (const a of res.results || []) {
      if (got >= want) break;
      const url = a.url || ''; if (!/\.mp3(\?|$)/i.test(url) || (a.duration && a.duration < 60000)) continue;
      const name = `${String(a.id || Date.now()).slice(0, 12)}.mp3`; const file = path.join(dir, name);
      if (fs.existsSync(file)) continue;
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(60000) }); if (!r.ok) continue;
        const buf = Buffer.from(await r.arrayBuffer()); if (buf.length < 200000) continue;
        fs.writeFileSync(file, buf);
        const lic = String(a.license || '').toLowerCase();
        credits[name] = lic === 'cc0' ? '' : `Music: "${a.title || 'Untitled'}" by ${a.creator || 'unknown'} (CC ${lic.toUpperCase()} ${a.license_version || ''})`.replace(/\s+\)/, ')');
        got++;
      } catch { /* try the next one */ }
    }
  }
  fs.writeFileSync(path.join(dir, 'credits.json'), JSON.stringify(credits, null, 1));
  return got;
}

/** A music bed written by FFmpeg: soft chord pads, bass and a kick, in the mood's key and tempo. */
async function generate(mood, seconds = 90) {
  const m = MOODS[mood] || MOODS.positive; const dir = libDir(mood);
  const out = path.join(dir, `generated-${mood}.m4a`); if (fs.existsSync(out)) return out;
  const beat = 60 / m.bpm; const bar = beat * 4;
  const idx = `floor(mod(t,${(bar * 4).toFixed(3)})/${bar.toFixed(3)})`;
  const pick = (k) => m.chords.reduceRight((acc, c, i) => (i === m.chords.length - 1 ? `${c[k]}` : `if(eq(${idx},${i}),${c[k]},${acc})`), '');
  const pad = [0, 1, 2].map((k) => `sin(2*PI*(${pick(k)})*t)`).join('+');
  const env = `(0.6+0.4*sin(2*PI*t/${bar.toFixed(3)}))`;
  const bass = `0.5*sin(2*PI*(${pick(0)})/2*t)*exp(-3*mod(t,${(beat * 2).toFixed(3)}))`;
  const kick = `0.9*sin(2*PI*(50+90*exp(-30*mod(t,${beat.toFixed(3)})))*mod(t,${beat.toFixed(3)}))*exp(-9*mod(t,${beat.toFixed(3)}))`;
  const expr = `0.12*(${pad})*${env}+${bass}+${kick}`;
  await run(ff.bin('ffmpeg'), ['-hide_banner', '-y', '-f', 'lavfi', '-i', `aevalsrc=${expr.replace(/,/g, '\\,')}:s=44100:d=${seconds}`, '-af', `lowpass=f=5000,afade=t=in:d=1.5,loudnorm=I=-18,aformat=channel_layouts=stereo`, '-c:a', 'aac', '-b:a', '160k', out], { timeoutMs: 180000 });
  return out;
}

/** Music for one ad. mood: positive | contrast | speech. Returns { file, credit } or null. */
async function pick(mood = 'positive') {
  if (ctx.setting('political.musicOn', true) === false) return null;
  mood = MOODS[mood] ? mood : 'positive';
  const own = fromFolder(mood); if (own) return own;
  let lib = library(mood);
  if (lib.length < 3) { try { await fill(mood); lib = library(mood); } catch { /* offline */ } }
  if (lib.length) return lib[(Math.random() * lib.length) | 0];
  try { return { file: await generate(mood), credit: '' }; } catch { return null; }
}

module.exports = { pick, generate, fill, library, MOODS };
