'use strict';
/**
 * The winner formula: what Euclidean's 12 best-performing exploring shorts (10k+ views each, Stringer and friends)
 * have in common, measured from the files themselves (frames, scene cuts, loudness, caption positions), not guessed.
 * Every rule here is used somewhere in the clip machine (picking, cutting, titles, music, cut-aways) and each finished
 * clip is checked against it (`check`), so we can see how close a clip is to a banger and what's still off.
 *
 * Measured (Nov 2026, 12 shorts, 720x1280 30 fps):
 *  - Length: 20-46 s, middle 26.5 s; 10 of 12 between 25 and 36 s.
 *  - Title: on screen the WHOLE video in all 12 (top 8-17% of the frame, 2-3 lines). 2-7 words. 9 of 12 end in "...".
 *    Formulas: "they left ... (behind / to rot / to freeze)..." (5), "abandoned <thing>..." (2), a question with
 *    who/why/what/how (4: "WHY DID they leave it all behind...", "who left this boat here...", "WHAT did we find in a
 *    CIA agent's home:"), a place reveal ("tunnels under minneapolis...", "Island lost to time..."), a stake ("we outran
 *    the cops..."). Often the first one or two words in CAPITALS for emphasis.
 *  - Captions: 2-3 words at a time, centred about 77% of the way down a full-frame video, white heavy sans
 *    (Montserrat ExtraBold-like) with a shadow, key words in yellow (#FFD60A-ish); change ~1.6 times a second.
 *  - Pace: median shot 2.0 s, 90% of shots under 3.8 s, the longest rarely over 7 s; the first cut lands at ~2 s;
 *    the middle third has the most cuts. Lots of picture-only cut-aways while the voice keeps going.
 *  - Sound: the voice starts on the first frame and there is never a silent gap (no stretch under -35 dB longer than
 *    0.3 s in any of them); a bed of music/ambience always sits 10-15 dB under the voice. -14 to -18 LUFS.
 *  - Opening: action or a stake from frame 1: a drone/establishing shot under narration ("today we're going to
 *    Illinois to explore the abandoned...", "On August 3rd, 2012..."), or the creator mid-sentence to camera
 *    ("I can't believe...", "so this is the...", "Time flies...").
 *  - Ending: stops before the payoff, on an open loop: "here???", "there's more to this", "that never returned...",
 *    "those stairs...", "I found this", "a story later", "yoooo" as something is opened.
 *  - Layout: 10 full frame, 2 "framed" (the video in a band in the middle, blurred grainy bars above and below with the
 *    title in the top bar and captions in the bottom one).
 */
const ctx = require('../core/ctx');

const on = () => ctx.setting('production.winnerFormula', true) !== false;

const PROFILE = {
  length: { min: 20, max: 36, sweet: [25, 32] },
  shot: { median: 2.0, p90: 3.8, max: 7, firstCut: 2.1 },
  captionsY: 0.77,
  pauseMax: 0.3,
  musicUnderVoiceDb: [10, 15],
};

/** The 12 winning titles, for the AI writing new ones (the words are theirs; the formulas are what to copy). */
const TITLES = [
  'ABANDONED FACTORY...', 'they left it all behind...', 'WHAT did we find in a CIA agent\'s home:', 'WHY DID they leave it all behind...',
  'They left the whole town to rot...', 'tunnels under minneapolis...', 'we outran the cops...', 'ABANDONED GHOST TOWN', 'THEY LEFT MILLIONS TO FREEZE',
  'THEY LEFT millions behind in this mansion...', 'Island lost to time...', 'who left this boat here...',
];
// Written for ANY footage: the 12 titles are examples of the structure, not words or topics to reuse.
const rulesFor = (titles) => `On-screen titles copy the STRUCTURE of this channel's best shorts (each 10k+ views), never their words or topics: ${titles.map((t) => `"${t}"`).join(', ')}. What they share, for any subject: 2-6 words; names the single most intriguing thing in THIS video (a place, a person, an object, an event, a result); reads as an unanswered mystery or a stake, not a description; one of these shapes: (1) "<someone> <did/left/lost> <something surprising>..." ("they left it all behind..."), (2) a who/why/what/how question the video teases but doesn't answer ("who left this boat here..."), (3) "<the thing> + a twist word" ("tunnels under minneapolis...", "Island lost to time..."), (4) the stake in first person ("we outran the cops..."), (5) the subject in capitals ("ABANDONED GHOST TOWN"). Never a quote of what is said. End with "..." (or ":" / "?"). The first one or two words may be in CAPITALS for emphasis. Adapt to this video's own subject, whatever it is (a person, a sport, a business, a trip, food, a politician, a place).`;
const TITLE_RULES = rulesFor(TITLES);

// Openings that hooked in the winners (the first line said in the clip).
// Openings that hooked in the winners, as SHAPES that fit any subject (the first line said in the clip): straight into the
// what/where/when ("today we're...", "On August 3rd, 2012..."), a reaction ("I can't believe..."), a find or a stake.
const OPENER = /^\W*(today (we|i)('re| are| am|'m)?|so (this|here) (is|was)|this is (the|my|our|a|what|how|why|where)|i (can'?t|cannot|couldn'?t) believe|(we|i) (just )?(found|discovered|got|made|bought|tried|went|drove|flew|spent)|nobody|no one|(they|he|she) (left|built|lost|made|spent|said|told)|on (january|february|march|april|may|june|july|august|september|october|november|december) \d|in \d{4}|the (owner|reason|craziest|first|last|only)|it'?s (just |actually |so )?(crazy|insane|wild|unreal)|time flies|look at|welcome to|what (did|is|was|happens|would)|why (did|would|is|do)|how (did|could|is|do)|(we|i)('re| are|'m| am) (going|about|inside|in|at|finally)|there (were|was|is|are)|(\d[\d,]*|one|two|three|ten|a hundred|a million) )/i;
// Endings that left people hanging in the winners.
const CLIFF = /(\?\?|\?\s*["']?$|\.\.\.\s*["']?$|…\s*$|\bmore to (this|it)\b|\bnever (returned|came back|seen)\b|\bi found (this|something)\b|\b(a )?story (for )?later\b|\bthose (stairs|doors?)\b|\bnot sure what\b|\bwhat('s| is) (in|inside|behind|down) (there|here)\b|\byo{3,}\b|\blet'?s (see|find out|check)\b|\bwhat (we|i) found\b)/i;

/** Ensure the on-screen title reads like the winners: ends in "..." unless it ends in ? ! : already. */
function titleFinish(h) {
  const t = String(h || '').trim(); if (!t) return t;
  if (/(\.\.\.|…|[?!:])$/.test(t)) return t;
  return `${t.replace(/[.,;]+$/, '')}...`;
}

/**
 * How close a finished clip is to the winners (0-100) and what's off, from what the render already knows
 * (no extra decoding): length, how long shots run (jump cuts + cut-aways), the title, the ending, music.
 */
function check({ clip, version, words = [], style = {} }) {
  const out = []; let s = 100;
  const dur = version?.duration || 0;
  const P = profile();
  if (dur && (dur < P.length.min - 2 || dur > P.length.max + 6)) { s -= 15; out.push(`${Math.round(dur)} s long; the winners run ${P.length.min}-${P.length.max} s`); }
  // Shots: boundaries are every jump cut (a new piece of the source) and every cut-away start/end.
  if (dur) {
    let t = 0; const bounds = new Set([0, Math.round(dur * 10) / 10]);
    for (const [a, b] of version.segs || []) { t += b - a; bounds.add(Math.round(t * 10) / 10); }
    const outAt = (src) => { let o = 0; for (const [a, b] of version.segs || []) { if (src >= a && src <= b) return o + (src - a); o += b - a; } return null; };
    for (const c of version.covers || []) { const at = outAt(c.at); if (at != null) { bounds.add(Math.round(at * 10) / 10); bounds.add(Math.round((at + c.dur) * 10) / 10); } }
    const b = [...bounds].filter((x) => x >= 0 && x <= dur).sort((x, y) => x - y);
    const shots = b.slice(1).map((x, i) => x - b[i]).filter((x) => x > 0.2);
    const longest = shots.length ? Math.max(...shots) : dur; const first = shots[0] ?? dur;
    if (longest > PROFILE.shot.max + 1) { s -= Math.min(20, Math.round((longest - PROFILE.shot.max) * 3)); out.push(`one shot runs ${longest.toFixed(1)} s with no cut; the winners' longest is about ${PROFILE.shot.max} s`); }
    if (first > 3.5) { s -= 8; out.push(`the first cut comes at ${first.toFixed(1)} s; the winners cut by ~2 s`); }
  }
  const hookSec = Number(style.hookSeconds ?? 3.2);
  if (style.hook === false || !clip.hook) { s -= 12; out.push('no title on screen; every winner has one'); }
  else if (dur && hookSec < dur - 0.5) { s -= 8; out.push(`the title leaves after ${hookSec} s; the winners keep it up the whole video`); }
  const lastLine = (() => { const ws = words.slice(-14).map((w) => w.w).join(' '); return ws.split(/(?<=[.!?])\s/).pop() || ws; })();
  if (words.length && !CLIFF.test(lastLine) && !require('./montage').OPEN_LOOP.test(lastLine)) { s -= 12; out.push(`ends on "${lastLine.slice(-60)}"; the winners stop on an open question or "..."`); }
  const firstLine = words.slice(0, 12).map((w) => w.w).join(' ');
  if (words.length && words[0].s > 0.6) { s -= 6; out.push(`the voice starts ${words[0].s.toFixed(1)} s in; the winners talk from the first frame`); }
  if (words.length && !OPENER.test(firstLine) && !require('./montage').HOOK.test(firstLine.split(/(?<=[.!?])\s/)[0])) { s -= 4; out.push(`opens with "${firstLine.slice(0, 50)}..."; the winners open on a stake or the place`); }
  if (!version?.music?.cues?.length) { s -= 6; out.push('no music bed; every winner has one under the voice'); }
  return { score: Math.max(0, Math.min(100, s)), misses: out };
}

// ------------------------------------------------------------------ the library: more winners, a formula that keeps learning
/** The 12 measured on Nov 3 2026 (seconds): length, shots, first cut, longest shot, loudness. */
const BUILTIN = [
  [27.2, 11, 1.9, 7.3, -15.8, 'ABANDONED FACTORY...'], [28.2, 13, 1.4, 4.7, -17.7, 'they left it all behind...'], [26.9, 13, 4.8, 4.8, -14.0, "WHAT did we find in a CIA agent's home:"],
  [20.2, 9, 1.9, 5.9, -14.2, 'WHY DID they leave it all behind...'], [26.1, 7, 3.1, 7.8, -13.8, 'They left the whole town to rot...'], [28.5, 7, 3.8, 6.0, -16.1, 'tunnels under minneapolis...'],
  [26.2, 12, 3.1, 4.8, -15.1, 'we outran the cops...'], [25.2, 18, 0.9, 3.1, -13.8, 'ABANDONED GHOST TOWN'], [35.4, 20, 2.3, 3.5, -17.5, 'THEY LEFT MILLIONS TO FREEZE'],
  [25.9, 6, 1.3, 9.4, -14.9, 'THEY LEFT millions behind in this mansion...'], [46.1, null, null, null, null, 'Island lost to time...'], [36.4, null, null, null, null, 'who left this boat here...'],
].map(([dur, shots, firstCut, longest, lufs, title]) => ({ builtin: true, title, dur, shots, firstCut, longest, lufs }));
const added = () => ctx.store.settings._winners || [];
const fs = require('fs'); const path = require('path');

/** Measure one short (a file): length, every cut, the first cut, the longest shot, loudness, the quietest sound. */
async function measure(file) {
  const ff = require('./ffmpeg'); const { run } = require('../core/util');
  const info = await ff.probe(file); const dur = info.duration || 0;
  const sc = await run(ff.bin('ffmpeg'), ['-hide_banner', '-nostats', '-i', file, '-vf', "select='gt(scene,0.28)',showinfo", '-an', '-f', 'null', '-'], { timeoutMs: 600000, priority: ff.priorityValue() });
  const cuts = [...String(sc.err || sc.out || '').matchAll(/pts_time:([\d.]+)/g)].map((m) => Number(m[1])).filter((t) => t > 0.2 && t < dur - 0.2);
  const b = [0, ...cuts, dur]; const L = b.slice(1).map((x, i) => x - b[i]).filter((x) => x > 0.15);
  let lufs = null, quiet = null;
  if (info.hasAudio !== false) {
    const lo = await run(ff.bin('ffmpeg'), ['-hide_banner', '-nostats', '-i', file, '-af', 'ebur128', '-f', 'null', '-'], { timeoutMs: 600000 });
    const m = /I:\s*(-?[\d.]+) LUFS\s*\n\s*Threshold/.exec(String(lo.err || '')) || [...String(lo.err || '').matchAll(/I:\s*(-?[\d.]+) LUFS/g)].pop(); lufs = m ? Number(m[1]) : null;
    try { const lv = await require('./align').fineLevels(file, path.dirname(file)); const v = [...lv.db].sort((x, y) => x - y); quiet = v[Math.floor(v.length * 0.05)]; } catch { /* no level map */ }
  }
  const med = (xs) => { const s = [...xs].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
  return { dur: Math.round(dur * 10) / 10, shots: L.length, medianShot: Math.round((med(L) || dur) * 10) / 10, firstCut: Math.round((L[0] || dur) * 10) / 10, longest: Math.round(Math.max(...L, 0) * 10) / 10, lufs, quietDb: quiet == null ? null : Math.round(quiet) };
}

/** The formula from every winner (the 12 measured + any added in the app): ranges and medians. */
function profile() {
  const all = [...BUILTIN, ...added().filter((w) => w.dur)];
  const vals = (k) => all.map((w) => w[k]).filter((v) => v != null && Number.isFinite(v)).sort((a, b) => a - b);
  const q = (k, p) => { const v = vals(k); return v.length ? v[Math.min(v.length - 1, Math.floor(v.length * p))] : null; };
  const dur = vals('dur'); const shotLen = all.filter((w) => w.shots).map((w) => w.medianShot || w.dur / w.shots).sort((a, b) => a - b);
  return {
    count: all.length, added: added().length,
    length: { min: Math.max(15, Math.floor(q('dur', 0.1))), max: Math.ceil(q('dur', 0.9)), median: dur[Math.floor(dur.length / 2)] },
    shot: { median: Math.round((shotLen[Math.floor(shotLen.length / 2)] || 2) * 10) / 10, firstCut: q('firstCut', 0.5), max: q('longest', 0.5) },
    lufs: q('lufs', 0.5), titles: all.map((w) => w.title).filter(Boolean),
  };
}
function titleRules() { return rulesFor(profile().titles.slice(-24)); }

/** Add a short to the library (job winners.measure fills in the numbers). */
function add({ file, title, views = null, by = 'user' }) {
  const list = added(); const w = { id: Math.random().toString(36).slice(2, 10), file, title: String(title || path.basename(file).replace(/\.[^.]+$/, '').replace(/^[0-9a-f]{8}-/, '').replace(/_+/g, ' ')).slice(0, 120), views: views == null || views === '' ? null : Number(views), by, at: new Date().toISOString(), status: 'measuring' };
  ctx.store.settings._winners = [...list, w]; ctx.store.touch(); return w;
}
function update(id, patch) { ctx.store.settings._winners = added().map((w) => (w.id === id ? { ...w, ...patch } : w)); ctx.store.touch(); }
function remove(id) { const w = added().find((x) => x.id === id); if (w?.file) { try { fs.unlinkSync(w.file); } catch { /* gone */ } } ctx.store.settings._winners = added().filter((x) => x.id !== id); ctx.store.touch(); }
function list() { return { builtin: BUILTIN, added: added(), profile: profile() }; }

module.exports = { on, PROFILE, TITLES, TITLE_RULES, OPENER, CLIFF, titleFinish, check, measure, profile, titleRules, add, update, remove, list, BUILTIN };
