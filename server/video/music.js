'use strict';
/**
 * Royalty-free music for every kind of moment, for the political ads and the clips.
 *
 * Where a track comes from, in order:
 *  1. the founders' own music folder (setting music.dir, or political.musicDir), one subfolder per mood
 *     ("creepy", "suspense", "triumphant"...), used as-is,
 *  2. a free library downloaded once from Openverse: CC0 only for clips (no credit needed anywhere),
 *     CC0 or CC BY for the political ads (the credit goes on the end card),
 *  3. music Euclidean writes itself with FFmpeg for that mood (always available, owned by nobody else).
 *
 * Every downloaded track is loudness-matched once so beds sit at the same level under speech.
 */
const fs = require('fs');
const path = require('path');
const ctx = require('../core/ctx');
const paths = require('../core/paths');
const ff = require('./ffmpeg');
const { run } = require('../core/util');

// Note frequencies used by the built-in composer.
const N = { E1: 41.2, G1: 49, A1: 55, Bb1: 58.27, C2: 65.41, Db2: 69.3, D2: 73.42, E2: 82.41, F2: 87.31, G2: 98, A2: 110, Bb2: 116.54, B2: 123.47, C3: 130.81, D3: 146.83, E3: 164.81, F3: 174.61, Fs3: 185, G3: 196, Gs3: 207.65, A3: 220, B3: 246.94, C4: 261.63, Cs4: 277.18, D4: 293.66, E4: 329.63, F4: 349.23, Fs4: 369.99, G4: 392, A4: 440, B4: 493.88, C5: 523.25, D5: 587.33, E5: 659.25 };

/**
 * Moods. `search` feeds the free library; `gen` is the built-in composer's recipe.
 *  kind: pad (chords + bass + drums), drone (dark textures), pluck (bouncy staccato), piano (soft decaying chords)
 */
const MOODS = {
  positive: { label: 'Uplifting', search: ['uplifting inspirational', 'hopeful cinematic', 'upbeat motivational'], gen: { kind: 'pad', bpm: 112, chords: [[N.C4, N.E4, N.G4], [N.G3, N.B3, N.D4], [N.A3, N.C4, N.E4], [N.F3, N.A3, N.C4]], kick: 1 } },
  triumphant: { label: 'Triumphant', search: ['epic triumphant', 'victory orchestral', 'heroic cinematic'], gen: { kind: 'pad', bpm: 100, brass: true, chords: [[N.D3, N.Fs3, N.A3], [N.A2, N.Cs4 / 2, N.E3], [N.B2, N.D3, N.Fs3], [N.G2, N.B2, N.D3]], kick: 2, snare: true } },
  suspense: { label: 'Suspense', search: ['suspense tension', 'dark suspense', 'thriller tension'], gen: { kind: 'drone', bpm: 76, root: N.A1, rub: N.Bb1, pulse: [N.A2, N.A2, N.Bb2, N.A2], heartbeat: true } },
  creepy: { label: 'Creepy / scary', search: ['creepy horror', 'eerie haunted', 'horror ambient'], gen: { kind: 'drone', bpm: 60, root: N.G1, rub: N.Db2, whine: true, plinks: [N.E5, N.C5, N.B4, N.Fs4] } },
  intense: { label: 'Intense / action', search: ['intense action', 'epic battle', 'driving drums action'], gen: { kind: 'pad', bpm: 140, chords: [[N.A2, N.C3, N.E3], [N.F2, N.A2, N.C3], [N.G2, N.B2, N.D3], [N.E2, N.Gs3 / 2, N.B2]], kick: 1, snare: true, drive: true } },
  sad: { label: 'Sad / emotional', search: ['sad piano', 'emotional melancholy', 'sad cinematic'], gen: { kind: 'piano', bpm: 66, chords: [[N.A3, N.C4, N.E4], [N.F3, N.A3, N.C4], [N.C4, N.E4, N.G4], [N.G3, N.B3, N.D4]] } },
  chill: { label: 'Chill', search: ['lofi chill', 'calm ambient', 'relaxing background'], gen: { kind: 'pad', bpm: 84, chords: [[N.C4, N.E4, N.B4], [N.A3, N.C4, N.G4], [N.D4, N.F4, N.C5], [N.G3, N.B3, N.F4]], kick: 2, soft: true } },
  funny: { label: 'Funny / quirky', search: ['quirky funny', 'comedy playful', 'ukulele happy'], gen: { kind: 'pluck', bpm: 124, chords: [[N.C4, N.E4, N.G4], [N.F4, N.A4, N.C5], [N.G4, N.B4, N.D5], [N.C4, N.E4, N.G4]] } },
  contrast: { label: 'Serious', search: ['tense dramatic', 'serious cinematic', 'dark suspense'], gen: { kind: 'pad', bpm: 84, chords: [[N.A3, N.C4, N.E4], [N.F3, N.A3, N.C4], [N.E3, N.G3, N.B3], [N.D3, N.F3, N.A3]], kick: 1 } },
  speech: { label: 'Inspiring', search: ['inspiring piano', 'emotional piano', 'gentle hopeful'], gen: { kind: 'pad', bpm: 90, chords: [[N.C4, N.E4, N.G4], [N.A3, N.C4, N.E4], [N.F3, N.A3, N.C4], [N.G3, N.B3, N.D4]], kick: 1 } },
};
const AUDIO = /\.(mp3|m4a|wav|aac|ogg|flac)$/i;
const valid = (m) => (MOODS[m] ? m : 'positive');

function ownDirs() { return [ctx.setting('music.dir', ''), ctx.setting('political.musicDir', '')].filter(Boolean); }
function fromFolder(mood) {
  for (const root of ownDirs()) {
    const subs = [mood, MOODS[mood].label.toLowerCase(), ...(mood === 'speech' || mood === 'triumphant' ? ['positive'] : []), ...(mood === 'creepy' ? ['scary', 'horror', 'suspense'] : [])];
    for (const s of subs) { try { const dir = path.join(root, s); const list = fs.readdirSync(dir).filter((f) => AUDIO.test(f)); if (list.length) return { file: path.join(dir, list[(Math.random() * list.length) | 0]), credit: '', source: 'Your music folder' }; } catch { /* none */ } }
  }
  return null;
}

const libDir = (mood) => { const d = path.join(paths.root, 'music', mood); fs.mkdirSync(d, { recursive: true }); return d; };
function credits(mood) { try { return JSON.parse(fs.readFileSync(path.join(libDir(mood), 'credits.json'), 'utf8')); } catch { return {}; } }
/** Downloaded tracks for a mood: [{ file, credit, title, license }]. credit is '' for CC0. */
function library(mood) {
  const dir = libDir(mood); const c = credits(mood);
  return fs.readdirSync(dir).filter((f) => AUDIO.test(f) && !f.startsWith('generated')).map((f) => ({ file: path.join(dir, f), credit: typeof c[f] === 'string' ? c[f] : c[f]?.credit || '', title: c[f]?.title || f, license: c[f]?.license || (c[f] ? 'cc-by' : 'cc0') }));
}

/** Download a few free tracks for a mood from Openverse (no key). cc0Only skips anything that needs a credit. */
async function fill(mood, { want = 4, cc0Only = false } = {}) {
  mood = valid(mood); const dir = libDir(mood); const c = credits(mood);
  let got = library(mood).filter((t) => !cc0Only || !t.credit).length;
  for (const q of MOODS[mood].search) {
    if (got >= want) break;
    let res;
    try { res = await (await fetch(`https://api.openverse.org/v1/audio/?q=${encodeURIComponent(q)}&license=${cc0Only ? 'cc0' : 'cc0,by'}&category=music&length=medium,long&page_size=20`, { headers: { 'user-agent': 'EuclideanMedia/1.0' }, signal: AbortSignal.timeout(20000) })).json(); }
    catch { continue; }
    for (const a of res.results || []) {
      if (got >= want) break;
      const url = a.url || ''; if (!/\.(mp3|ogg|wav|flac)(\?|$)/i.test(url) || (a.duration && a.duration < 60000)) continue;
      const lic = String(a.license || '').toLowerCase(); if (!['cc0', 'by'].includes(lic) || (cc0Only && lic !== 'cc0')) continue;
      const name = `${String(a.id || Date.now()).slice(0, 12)}.m4a`; const file = path.join(dir, name);
      if (fs.existsSync(file)) continue;
      const tmp = path.join(dir, `dl-${Date.now()}${path.extname(new URL(url).pathname) || '.mp3'}`);
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(90000) }); if (!r.ok) continue;
        const buf = Buffer.from(await r.arrayBuffer()); if (buf.length < 200000) continue;
        fs.writeFileSync(tmp, buf);
        // Same loudness for every track, so music sits at a predictable level under speech.
        await run(ff.bin('ffmpeg'), ['-hide_banner', '-y', '-i', tmp, '-vn', '-t', '360', '-af', 'loudnorm=I=-18:TP=-2,aformat=sample_rates=48000:channel_layouts=stereo', '-c:a', 'aac', '-b:a', '160k', file], { timeoutMs: 180000 });
        c[name] = { title: a.title || 'Untitled', by: a.creator || 'unknown', license: lic === 'cc0' ? 'cc0' : 'cc-by', url: a.foreign_landing_url || url,
          credit: lic === 'cc0' ? '' : `Music: "${a.title || 'Untitled'}" by ${a.creator || 'unknown'} (CC BY ${a.license_version || ''})`.replace(/\s+\)/, ')') };
        got++;
      } catch { try { fs.unlinkSync(file); } catch { /* none */ } }
      finally { try { fs.unlinkSync(tmp); } catch { /* none */ } }
    }
  }
  fs.writeFileSync(path.join(dir, 'credits.json'), JSON.stringify(c, null, 1));
  return got;
}

// ---------------------------------------------------------------- the built-in composer
const f3 = (x) => Number(x).toFixed(3);
/** FFmpeg expression for one mood's music (stereo-ready mono), seconds long. */
function recipe(mood) {
  const g = MOODS[mood].gen; const beat = 60 / g.bpm; const bar = beat * 4;
  const idx = `floor(mod(t,${f3(bar * 4)})/${f3(bar)})`;
  const pick = (list) => list.reduceRight((acc, v, i) => (i === list.length - 1 ? `${v}` : `if(eq(${idx},${i}),${v},${acc})`), '');
  const tone = (fq, rich) => (rich ? `(sin(2*PI*${fq}*t)+0.5*sin(4*PI*${fq}*t)+0.3*sin(6*PI*${fq}*t)+0.18*sin(8*PI*${fq}*t))` : `sin(2*PI*${fq}*t)`);
  const kick = (every) => `0.9*sin(2*PI*(48+90*exp(-30*mod(t,${f3(beat * every)})))*mod(t,${f3(beat * every)}))*exp(-9*mod(t,${f3(beat * every)}))`;
  const snare = `0.28*(random(0)*2-1)*exp(-16*mod(t+${f3(beat)},${f3(beat * 2)}))`;
  if (g.kind === 'drone') {
    const swell = `(0.55+0.45*sin(2*PI*t/${f3(bar * 2)}))`;
    let e = `0.35*(sin(2*PI*${g.root}*t)+0.6*sin(2*PI*${g.root * 2}*t)+0.4*sin(2*PI*${g.rub}*t))*${swell}`;
    if (g.pulse) { const st = beat / 2; const pIdx = `floor(mod(t,${f3(st * 4)})/${f3(st)})`; const pf = g.pulse.reduceRight((acc, v, i) => (i === g.pulse.length - 1 ? `${v}` : `if(eq(${pIdx},${i}),${v},${acc})`), ''); e += `+0.32*(sin(2*PI*(${pf})*t)+0.3*sin(6*PI*(${pf})*t))*exp(-7*mod(t,${f3(st)}))`; }
    if (g.heartbeat) { const hb = beat * 1.2; e += `+0.8*sin(2*PI*52*mod(t,${f3(hb)}))*(exp(-14*mod(t,${f3(hb)}))+0.7*exp(-14*abs(mod(t,${f3(hb)})-0.22)))`; }
    if (g.whine) e += `+0.05*sin(2*PI*1180*t+3.3*sin(2*PI*5.5*t))*pow(sin(2*PI*t/11),2)+0.04*sin(2*PI*1253*t+12*sin(2*PI*0.7*t))*pow(sin(2*PI*t/7),2)`; // vibrato (phase-modulated, so the pitch stays put)
    if (g.plinks) { const p = 2.7; const pIdx = `mod(floor(t/${p}),${g.plinks.length})`; const pf = g.plinks.reduceRight((acc, v, i) => (i === g.plinks.length - 1 ? `${v}` : `if(eq(${pIdx},${i}),${v},${acc})`), ''); e += `+0.16*(sin(2*PI*(${pf})*t)+0.25*sin(4*PI*(${pf})*t))*exp(-3.2*mod(t,${p}))*gt(mod(floor(t/${p}),5),0)`; }
    return { expr: e, lowpass: g.whine ? 6000 : 3000 };
  }
  if (g.kind === 'piano') {
    const hit = `exp(-1.6*mod(t,${f3(bar / 2)}))`;
    const e = `0.22*(${[0, 1, 2].map((k) => tone(pick(g.chords.map((c) => c[k])), true)).join('+')})*${hit}+0.25*sin(2*PI*(${pick(g.chords.map((c) => c[0] / 2))})*t)*exp(-1.2*mod(t,${f3(bar)}))`;
    return { expr: e, lowpass: 3500 };
  }
  if (g.kind === 'pluck') {
    const st = beat / 2; const hit = `exp(-22*mod(t,${f3(st)}))`;
    const arp = `if(eq(mod(floor(t/${f3(st)}),3),0),${pick(g.chords.map((c) => c[0]))},if(eq(mod(floor(t/${f3(st)}),3),1),${pick(g.chords.map((c) => c[1]))},${pick(g.chords.map((c) => c[2]))}))`;
    const e = `0.5*${tone(`(${arp})`, true)}*${hit}+0.45*sin(2*PI*(${pick(g.chords.map((c) => c[0] / 2))})*t)*exp(-10*mod(t,${f3(beat)}))+0.6*${kick(2)}`;
    return { expr: e, lowpass: 7000 };
  }
  // pad: chords + bass + drums
  const env = `(0.6+0.4*sin(2*PI*t/${f3(bar)}))`;
  const pad = [0, 1, 2].map((k) => tone(pick(g.chords.map((c) => c[k])), !!g.brass)).join('+');
  let e = `${g.brass ? 0.1 : 0.12}*(${pad})*${env}`;
  e += g.drive ? `+0.5*sin(2*PI*(${pick(g.chords.map((c) => c[0] / 2))})*t)*exp(-12*mod(t,${f3(beat / 4)}))` : `+0.5*sin(2*PI*(${pick(g.chords.map((c) => c[0]))})/2*t)*exp(-3*mod(t,${f3(beat * 2)}))`;
  if (g.kick) e += `+${g.soft ? 0.5 : 1}*${kick(g.kick)}`;
  if (g.snare) e += `+${snare}`;
  return { expr: e, lowpass: g.soft ? 3000 : 5500 };
}

/** Music written by FFmpeg for a mood (cached). */
async function generate(mood, seconds = 120) {
  mood = valid(mood); const dir = libDir(mood);
  const out = path.join(dir, `generated-${mood}-v2.m4a`); if (fs.existsSync(out)) return out;
  const r = recipe(mood);
  await run(ff.bin('ffmpeg'), ['-hide_banner', '-y', '-f', 'lavfi', '-i', `aevalsrc=${r.expr.replace(/,/g, '\\,')}:s=44100:d=${seconds}`, '-af', `lowpass=f=${r.lowpass},aecho=0.6:0.5:60|120:0.25|0.15,afade=t=in:d=1.5,loudnorm=I=-18,aformat=sample_rates=48000:channel_layouts=stereo`, '-c:a', 'aac', '-b:a', '160k', out], { timeoutMs: 300000 });
  return out;
}

/**
 * A track for one mood. Returns { file, credit, source } or null.
 *  cc0Only: true for clips (nothing to credit, royalty-free in every regard).
 */
async function pick(mood = 'positive', { cc0Only = false, avoid = [] } = {}) {
  if (mood === 'none') return null;
  mood = valid(mood);
  const own = fromFolder(mood); if (own) return own;
  const ok = (t) => (!cc0Only || !t.credit) && !avoid.includes(t.file);
  let lib = library(mood).filter(ok);
  if (lib.length < 2 && ctx.setting('music.download', true) !== false) { try { await fill(mood, { cc0Only }); lib = library(mood).filter(ok); } catch { /* offline */ } }
  if (lib.length) { const t = lib[(Math.random() * lib.length) | 0]; return { file: t.file, credit: t.credit, source: t.credit ? 'Free library (CC BY)' : 'Free library (CC0)' }; }
  try { return { file: await generate(mood), credit: '', source: 'Made by Euclidean' }; } catch { return null; }
}

/**
 * Lay music cues under a finished video, ducked under speech.
 * cues: [{ start, end, file, vol? }] in the video's own seconds.
 */
async function scoreVideo({ video, cues, out, duration, volume = 0.3, voice = 1, onProgress }) {
  const list = cues.filter((c) => c.file && fs.existsSync(c.file) && c.end - c.start > 0.5);
  if (!list.length) {
    if (Math.abs(voice - 1) < 0.01) return null;
    // No music, just the voice turned up or down.
    await ff.ffmpegWithProgress(['-i', video, '-map', '0:v', '-map', '0:a', '-c:v', 'copy', '-af', `volume=${f3(voice)},alimiter=limit=0.95`, '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', out], { totalSec: duration, onProgress });
    return out;
  }
  const inputs = ['-i', video]; const f = []; const XF = 0.7;
  list.forEach((c, i) => {
    inputs.push('-stream_loop', '-1', '-i', c.file);
    const len = Math.min(duration - c.start, c.end - c.start + (i < list.length - 1 ? XF : 0));
    const off = c.offset || 0; const v = (c.vol ?? 1) * volume;
    f.push(`[${i + 1}:a]atrim=start=${f3(off)}:duration=${f3(len + off > 0 ? len : 0.1)},asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,volume=${f3(v)},afade=t=in:d=${c.start < 0.1 ? 0.3 : XF},afade=t=out:st=${f3(Math.max(0, len - (i < list.length - 1 ? XF : 1.2)))}:d=${i < list.length - 1 ? XF : 1.2},adelay=${Math.round(c.start * 1000)}|${Math.round(c.start * 1000)}[m${i}]`);
  });
  f.push(`${list.map((_, i) => `[m${i}]`).join('')}amix=inputs=${list.length}:duration=longest:normalize=0,apad,atrim=0:${f3(duration)}[mus]`);
  f.push(`[0:a]aresample=48000,aformat=channel_layouts=stereo,volume=${f3(voice)},asplit=2[vo][key]`, '[mus][key]sidechaincompress=threshold=0.03:ratio=8:attack=15:release=450:makeup=1[duck]', '[vo][duck]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.95[a]');
  await ff.ffmpegWithProgress([...inputs, '-filter_complex', f.join(';'), '-map', '0:v', '-map', '[a]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-t', f3(duration), '-movflags', '+faststart', out], { totalSec: duration, onProgress });
  return out;
}

/** What's in the library, for the Music screen. */
function overview() {
  return Object.entries(MOODS).filter(([k]) => k !== 'contrast' && k !== 'speech').map(([k, m]) => {
    const lib = library(k);
    return { mood: k, label: m.label, own: !!fromFolder(k), cc0: lib.filter((t) => !t.credit).length, ccby: lib.filter((t) => t.credit).length, generated: fs.existsSync(path.join(libDir(k), `generated-${k}-v2.m4a`)), tracks: lib.map((t) => ({ name: path.basename(t.file), title: t.title, license: t.license })) };
  });
}
const CLIP_MOODS = ['creepy', 'suspense', 'intense', 'triumphant', 'positive', 'sad', 'chill', 'funny'];

/** Every track you can pick, by mood: your folder, the free library, and Euclidean's own. id = "<where>/<mood>/<file>". */
function catalog() {
  return CLIP_MOODS.map((mood) => {
    const tracks = [];
    for (const root of ownDirs()) for (const sub of [mood, MOODS[mood].label.toLowerCase()]) {
      try { for (const f of fs.readdirSync(path.join(root, sub)).filter((x) => AUDIO.test(x))) tracks.push({ id: `own/${mood}/${f}`, title: f.replace(/\.[^.]+$/, ''), license: 'yours', source: 'Your music folder' }); } catch { /* none */ }
    }
    for (const t of library(mood)) tracks.push({ id: `lib/${mood}/${path.basename(t.file)}`, title: t.title, license: t.credit ? 'CC BY (credit needed)' : 'CC0 (free for anything)', source: 'Free library', needsCredit: !!t.credit });
    tracks.push({ id: `gen/${mood}/original`, title: `Euclidean original: ${MOODS[mood].label}`, license: 'Made by Euclidean', source: 'Made by Euclidean' });
    return { mood, label: MOODS[mood].label, tracks };
  });
}
/** The file for a catalog id (made on the spot for Euclidean's own), or null. Never leaves the music folders. */
async function resolve(id) {
  const [where, mood, ...rest] = String(id || '').split('/'); const name = rest.join('/');
  if (!MOODS[mood] || !name || name.includes('..') || /[\\/]/.test(name)) return null;
  if (where === 'gen') return generate(mood);
  if (where === 'lib') { const f = path.join(libDir(mood), name); return fs.existsSync(f) ? f : null; }
  if (where === 'own') for (const root of ownDirs()) for (const sub of [mood, MOODS[mood].label.toLowerCase()]) { const f = path.join(root, sub, name); if (fs.existsSync(f)) return f; }
  return null;
}
/** Download free tracks for every mood (CC0 first). */
async function fillAll(onProgress = () => {}) {
  let n = 0;
  for (let i = 0; i < CLIP_MOODS.length; i++) { onProgress(i / CLIP_MOODS.length, `Getting ${MOODS[CLIP_MOODS[i]].label.toLowerCase()} music`); try { n += await fill(CLIP_MOODS[i], { want: 5, cc0Only: true }); } catch { /* offline */ } }
  return n;
}

module.exports = { pick, generate, fill, fillAll, library, overview, catalog, resolve, scoreVideo, recipe, libDir, MOODS, CLIP_MOODS };
