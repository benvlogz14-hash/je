'use strict';
/**
 * Sound design for the political ads: quiet interface sounds made in code (no samples, nothing to license).
 *
 *   swipe   a soft filtered-noise whoosh           → colour wipes and slides
 *   thud    a low sine drop                        → a new line cutting in, zoom punches
 *   pop     a short pitched blip                   → graphics popping in (tags, stickers, icons)
 *   tick    a tiny click                           → headline key words
 *   riser   noise swelling up for 0.6 s            → into the end card
 *   impact  a deep boom with a soft noise tail     → the end card landing, the opening hook
 *   shimmer a few high sines fading                → the name on the end card
 *
 * `plan(spec)` reads a finished spec and lists when each one plays; `mixArgs` gives FFmpeg the inputs and filters.
 * They sit far under the voice (see GAIN): felt, not noticed. Never on top of each other within 0.12 s.
 */
const fs = require('fs');
const path = require('path');
const paths = require('../core/paths');

const SR = 48000;
const V = 2; // bump when a sound changes, so cached files are made again

function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 * 2 - 1; }; }
const buf = (sec) => new Float32Array(Math.round(sec * SR));
/** One-pole low-pass with a cutoff that can change over the sound (k = 0..1 per sample). */
function lowpass(x, k) { const y = new Float32Array(x.length); let acc = 0; for (let i = 0; i < x.length; i++) { const kk = typeof k === 'function' ? k(i / x.length) : k; acc += kk * (x[i] - acc); y[i] = acc; } return y; }

const MAKE = {
  swipe() {
    const n = buf(0.34); const r = rng(3); for (let i = 0; i < n.length; i++) n[i] = r();
    const y = lowpass(n, (p) => 0.02 + 0.28 * p * p);
    for (let i = 0; i < y.length; i++) { const p = i / y.length; y[i] *= Math.sin(Math.PI * p) ** 2; }
    return y;
  },
  thud() {
    const y = buf(0.38); let ph = 0;
    for (let i = 0; i < y.length; i++) { const t = i / SR; ph += (2 * Math.PI * (46 + 92 * Math.exp(-t * 22))) / SR; y[i] = Math.tanh(2 * Math.sin(ph) * Math.exp(-t * 10)) * Math.min(1, t / 0.002); }
    return y;
  },
  pop() {
    const y = buf(0.11); let ph = 0;
    for (let i = 0; i < y.length; i++) { const t = i / SR; ph += (2 * Math.PI * (320 + 860 * Math.exp(-t * 26))) / SR; y[i] = Math.sin(ph) * Math.exp(-t * 42) * Math.min(1, t / 0.001); }
    return y;
  },
  tick() {
    const y = buf(0.045); const r = rng(9);
    for (let i = 0; i < y.length; i++) { const t = i / SR; y[i] = Math.sin(2 * Math.PI * 2100 * t) * Math.exp(-t * 130) + 0.3 * r() * Math.exp(-t * 220); }
    return y;
  },
  riser() {
    const n = buf(0.62); const r = rng(5); for (let i = 0; i < n.length; i++) n[i] = r();
    const y = lowpass(n, (p) => 0.015 + 0.2 * p ** 2.2);
    for (let i = 0; i < y.length; i++) { const p = i / y.length; y[i] *= p ** 2.4 * (p > 0.97 ? (1 - p) / 0.03 : 1); }
    return y;
  },
  impact() {
    const y = buf(1.1); const r = rng(11); let ph = 0; let acc = 0;
    for (let i = 0; i < y.length; i++) {
      const t = i / SR; ph += (2 * Math.PI * (36 + 64 * Math.exp(-t * 13))) / SR;
      acc += 0.22 * (r() - acc);
      y[i] = Math.tanh(1.8 * (Math.sin(ph) * Math.exp(-t / 0.42) + 0.5 * acc * Math.exp(-t / 0.11))) * Math.min(1, t / 0.0015) * (t > 0.95 ? (1.1 - t) / 0.15 : 1);
    }
    return y;
  },
  shimmer() {
    const y = buf(0.9);
    for (let i = 0; i < y.length; i++) { const t = i / SR; y[i] = [1318.5, 1976, 2637].reduce((a, f, k) => a + Math.sin(2 * Math.PI * f * t) * Math.exp(-t * (4 + k * 2)) / (k + 1.5), 0) * Math.min(1, t / 0.02); }
    return y;
  },
};

function writeWav(file, mono) {
  let peak = 0; for (const v of mono) peak = Math.max(peak, Math.abs(v));
  const g = peak ? 0.9 / peak : 1; const n = mono.length;
  const b = Buffer.alloc(44 + n * 4);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 4, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(2, 22);
  b.writeUInt32LE(SR, 24); b.writeUInt32LE(SR * 4, 28); b.writeUInt16LE(4, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) { const s = Math.max(-32767, Math.min(32767, Math.round(mono[i] * g * 32767))); b.writeInt16LE(s, 44 + i * 4); b.writeInt16LE(s, 46 + i * 4); }
  fs.writeFileSync(file, b);
}

/** The sound files (made once, kept in <data>/political/sfx). */
function files() {
  const dir = path.join(paths.root, 'political', 'sfx'); fs.mkdirSync(dir, { recursive: true });
  const out = {};
  for (const k of Object.keys(MAKE)) { const f = path.join(dir, `${k}-v${V}.wav`); if (!fs.existsSync(f)) writeWav(f, MAKE[k]()); out[k] = f; }
  return out;
}

// Level of each sound against a voice normalised to about -16 LUFS (linear gain on a 0.9-peak file).
const GAIN = { swipe: 0.16, thud: 0.2, pop: 0.1, tick: 0.05, riser: 0.2, impact: 0.3, shimmer: 0.06 };

/**
 * When each sound plays, read off the spec: a sound where a new line cuts in (by that cut's transition), a pop when a
 * graphic lands, a tick on boxed key words, a riser into the end card and an impact as it lands. Nothing pops on the end
 * card itself. level = 'full' | 'light' (transitions and the end only) | 'off'.
 */
function plan(spec, level = 'full') {
  if (level === 'off' || !spec?.segs?.length) return [];
  const ev = []; const segs = spec.segs; const look = spec.look || {};
  const MIX = ['wipe', 'zoom', 'flash', 'slide', 'cut', 'zoom', 'wipe', 'flash'];
  const trans = (i) => (look.transition === 'mix' ? MIX[i % MIX.length] : look.transition);
  ev.push({ k: 'impact', t: 0, g: 0.6 }); // the opening hook lands
  segs.forEach((s, i) => {
    if (i === 0) return;
    const p = segs[i - 1]; const newLine = s.line !== p.line; const newShot = s.card?.src !== p.card?.src || s.card?.kind !== p.card?.kind;
    if (newLine) { const tr = trans(i); ev.push({ k: tr === 'wipe' || tr === 'slide' ? 'swipe' : tr === 'fade' ? null : 'thud', t: s.at - (tr === 'wipe' || tr === 'slide' ? 0.1 : 0.02), g: tr === 'cut' ? 0.6 : 1 }); }
    else if (newShot && level === 'full') ev.push({ k: s.card?.kind === 'map' ? 'swipe' : 'tick', t: s.at - 0.02, g: s.card?.kind === 'map' ? 0.7 : 1.6 });
  });
  if (level === 'full') {
    for (const s of segs) {
      if (s.tag) ev.push({ k: 'pop', t: s.at + 0.45 });
      if (s.icons?.length && s.showIcons) ev.push({ k: 'pop', t: s.at + 0.35, g: 0.7 });
      if (s.card?.kind === 'map') ev.push({ k: 'pop', t: s.at + (s.card.district || s.card.pin ? 1.9 : 1.0), g: 0.8 });
    }
    const seen = new Set();
    for (const s of segs) for (const w of s.head?.words || []) if (w.key && w.t != null && !seen.has(w.t)) { seen.add(w.t); ev.push({ k: 'tick', t: w.t }); }
  }
  if (spec.end) { ev.push({ k: 'riser', t: spec.end.at - 0.6 }, { k: 'impact', t: spec.end.at }, { k: 'shimmer', t: spec.end.at + 0.35 }); }
  // Never two sounds on top of each other: the louder kind wins inside 0.12 s.
  const rank = { impact: 6, riser: 5, thud: 4, swipe: 3, pop: 2, shimmer: 1, tick: 0 };
  const out = [];
  for (const e of ev.filter((x) => x.k && x.t >= -0.05).sort((a, b) => a.t - b.t)) {
    const last = out[out.length - 1];
    if (last && e.t - last.t < 0.12 && !(last.k === 'riser' && e.k === 'impact')) { if (rank[e.k] > rank[last.k]) out[out.length - 1] = e; continue; }
    out.push(e);
  }
  return out.slice(0, 60).map((e) => ({ k: e.k, t: Math.max(0, e.t), g: +(GAIN[e.k] * (e.g || 1)).toFixed(3) }));
}

/** FFmpeg inputs and filters that lay the planned sounds on one track labelled [sfx] (inputs start at index `first`). */
function mixArgs(events, first) {
  if (!events.length) return null;
  const f = files(); const kinds = [...new Set(events.map((e) => e.k))];
  const inputs = kinds.flatMap((k) => ['-i', f[k]]);
  const filters = []; const outs = [];
  kinds.forEach((k, i) => {
    const mine = events.filter((e) => e.k === k);
    filters.push(`[${first + i}:a]aformat=sample_rates=48000:channel_layouts=stereo,asplit=${mine.length}${mine.map((_, j) => `[x${i}_${j}]`).join('')}`);
    mine.forEach((e, j) => { const d = Math.round(e.t * 1000); filters.push(`[x${i}_${j}]volume=${e.g},adelay=${d}|${d}[y${i}_${j}]`); outs.push(`[y${i}_${j}]`); });
  });
  filters.push(`${outs.join('')}amix=inputs=${outs.length}:duration=longest:normalize=0[sfx]`);
  return { inputs, filters, count: kinds.length };
}

module.exports = { files, plan, mixArgs, GAIN, MAKE };
