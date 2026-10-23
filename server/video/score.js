'use strict';
/**
 * Music for a clip, moment by moment: decides WHEN music plays and WHAT mood it is
 * (creepy, suspense, intense, triumphant, uplifting, sad, chill, funny), then picks a
 * royalty-free track for each part.
 *
 * Reads what is said (the transcript, on the clip's own cut timeline) and what is on screen
 * (the shot list from "Look through it", plus brightness). An AI writes the cue sheet when one
 * is connected; otherwise a word-and-picture scorer does, so it always works offline.
 */
const ctx = require('../core/ctx');
const ai = require('../integrations/ai');
const music = require('./music');
const { safeJson } = require('../core/util');

const MOODS = music.CLIP_MOODS;
// Words that signal each mood (stems; matched at the start of a word).
const LEX = {
  creepy: ['abandon', 'creep', 'ghost', 'haunt', 'eerie', 'scary', 'scare', 'horror', 'blood', 'dead', 'death', 'corpse', 'body', 'bones', 'skull', 'doll', 'basement', 'cursed', 'demon', 'rott', 'decay', 'shadow', 'spooky', 'nightmare', 'grave', 'cemetery', 'morgue', 'asylum', 'mold', 'freaky', 'terrif', 'disturb', 'weird', 'strange'],
  suspense: ['suddenly', 'secret', 'hidden', 'hide', 'locked', 'door', 'heard', 'noise', 'listen', 'quiet', 'careful', 'footstep', 'someone', 'behind', 'caught', 'security', 'alarm', 'police', 'trespass', 'sneak', 'mystery', 'mysterious', 'unknown', 'wait', 'shh', 'tunnel', 'dark', 'flashlight', 'inside', 'discover'],
  intense: ['run', 'chase', 'crash', 'fight', 'attack', 'explo', 'fire', 'emergency', 'hurry', 'danger', 'insane', 'crazy', 'fast', 'speed', 'escape', 'collapse', 'falling', 'jump', 'go go', 'scream'],
  triumphant: ['finally', 'made it', 'we did', 'won', 'win', 'victory', 'success', 'champion', 'record', 'proud', 'incredible', 'unbelievable', 'massive', 'legend', 'goal', 'top', 'best', 'achiev', 'beat', 'conquer', 'summit'],
  sad: ['sad', 'lost', 'miss', 'gone', 'died', 'passed away', 'tragic', 'sorry', 'cry', 'tears', 'heartbreak', 'lonely', 'forgotten', 'memory', 'memories', 'once', 'used to'],
  funny: ['lol', 'haha', 'funny', 'joke', 'hilarious', 'silly', 'dumb', 'ridiculous', 'bro', 'what the', 'no way', 'oops'],
  chill: ['relax', 'calm', 'peace', 'beautiful', 'view', 'sunset', 'chill', 'vibe', 'cozy', 'nature', 'lake', 'beach', 'quiet'],
  positive: ['love', 'amazing', 'awesome', 'happy', 'great', 'excited', 'fun', 'welcome', 'today', 'let\'s'],
};
const has = (text, stem) => new RegExp(`(^|[^a-z])${stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i').test(text);
function scoreText(text) { const s = {}; for (const m of MOODS) s[m] = (LEX[m] || []).reduce((n, w) => n + (has(text, w) ? 1 : 0), 0); return s; }
const best = (s) => Object.entries(s).sort((a, b) => b[1] - a[1])[0];

/** Merge neighbours with the same mood and absorb parts shorter than minLen. */
function tidy(cues, duration, minLen = 4) {
  let out = cues.filter((c) => c.end > c.start).sort((a, b) => a.start - b.start).map((c) => ({ ...c, start: Math.max(0, c.start), end: Math.min(duration, c.end) }));
  for (let pass = 0; pass < 3; pass++) {
    const merged = [];
    for (const c of out) { const p = merged[merged.length - 1]; if (p && p.mood === c.mood && c.start - p.end < 1.5) p.end = c.end; else merged.push({ ...c }); }
    out = merged.filter((c, i, a) => c.end - c.start >= minLen || a.length === 1 || (c.mood === 'none' && c.end - c.start >= 2));
  }
  return out;
}

/** Offline cue sheet from words, shot descriptions and brightness. Covers the whole clip. */
function heuristic({ words, shots, duration, title }) {
  const textAt = (a, b) => [...words.filter((w) => w.s < b && w.e > a).map((w) => w.w), ...shots.filter((s) => s.s < b && s.e > a).map((s) => `${s.what || ''} ${s.text || ''}`)].join(' ');
  const whole = scoreText(`${title || ''} ${title || ''} ${textAt(0, duration)}`);
  const dark = shots.length ? shots.filter((s) => s.bright != null && s.bright < 55).reduce((n, s) => n + (Math.min(duration, s.e) - Math.max(0, s.s)), 0) / duration : 0;
  if (dark > 0.4) { whole.creepy += 2; whole.suspense += 2; }
  let [base, baseScore] = best(whole); if (!baseScore) base = 'positive';
  const W = 6; const cues = [];
  for (let t = 0; t < duration; t += W) {
    const e = Math.min(duration, t + W); const s = scoreText(textAt(t, e));
    const darkHere = shots.some((x) => x.s < e && x.e > t && x.bright != null && x.bright < 45); if (darkHere) s.suspense += 1;
    const [m, n] = best(s);
    cues.push({ start: t, end: e, mood: n >= 2 && m !== base ? m : base });
  }
  return { cues: tidy(cues, duration), how: 'words and picture' };
}

/** AI cue sheet. Returns null if no AI or the answer is unusable. */
async function withAi({ words, shots, duration, title, hook, clientId, jobId }) {
  if (!ai.anyConnected()) return null;
  const lines = []; let cur = null;
  for (const w of words) { if (!cur || w.s - cur.s > 3.5) { if (cur) lines.push(cur); cur = { s: w.s, t: w.w }; } else cur.t += ` ${w.w}`; }
  if (cur) lines.push(cur);
  const r = await ai.ask({ role: 'operations', json: true, maxTokens: 900, clientId, jobId,
    system: 'You are a music supervisor for short-form videos (YouTube Shorts, TikTok). You decide where background music plays and its mood. Match the emotion of each moment: creepy for eerie/scary/abandoned/horror moments, suspense for tension and build-up before a reveal, intense for action or danger, triumphant for wins, reveals and payoffs, sad for loss, funny for jokes, chill for calm scenery, positive for upbeat talk. Change mood only when the moment really changes (usually 1 to 3 parts). Use "none" for silence only when a dramatic pause or a punchline needs it.',
    prompt: `Clip: "${title || ''}"${hook ? ` (opening text: "${hook}")` : ''}, ${duration.toFixed(1)} seconds.\n\nWHAT IS SAID (seconds):\n${lines.map((l) => `[${l.s.toFixed(1)}] ${l.t}`).join('\n').slice(0, 5000) || '(no speech)'}\n\n${shots.length ? `WHAT IS ON SCREEN:\n${shots.map((s) => `[${s.s.toFixed(1)}-${s.e.toFixed(1)}] ${s.kind || ''}${s.what ? `: ${s.what}` : ''}${s.bright != null && s.bright < 50 ? ' (dark)' : ''}`).join('\n').slice(0, 3000)}\n\n` : ''}Moods: ${MOODS.join(', ')}, none.\nReturn JSON: {"cues":[{"start":0,"end":12.5,"mood":"suspense","why":"short reason"}]} covering 0 to ${duration.toFixed(1)}.` });
  const j = r.json || safeJson(r.text) || {};
  const cues = (j.cues || []).map((c) => ({ start: Number(c.start), end: Number(c.end), mood: [...MOODS, 'none'].includes(c.mood) ? c.mood : null, why: String(c.why || '').slice(0, 120) })).filter((c) => c.mood && Number.isFinite(c.start) && Number.isFinite(c.end) && c.end > c.start);
  if (!cues.length) return null;
  return { cues: tidy(cues, duration), how: `${r.provider}` };
}

/**
 * The cue sheet for one rendered clip, with a track picked for each part.
 *  words / shots on the clip's cut timeline; forced = a mood chosen by a person ('auto' / 'off' / a mood).
 */
async function plan({ words = [], shots = [], duration, title, hook, forced = 'auto', track = null, clientId, jobId }) {
  if (forced === 'off') return null;
  // A track a person picked from the catalog plays under the whole clip.
  if (track && track !== 'auto') {
    const file = await music.resolve(track);
    if (file) return { how: 'chosen by you', cues: [{ start: 0, end: duration, mood: track.split('/')[1], file, track: track.split('/').slice(2).join('/'), source: 'Chosen by you', offset: 0 }] };
  }
  let sheet;
  if (forced && forced !== 'auto' && MOODS.includes(forced)) sheet = { cues: [{ start: 0, end: duration, mood: forced }], how: 'chosen by you' };
  else {
    try { sheet = await withAi({ words, shots, duration, title, hook, clientId, jobId }); } catch { sheet = null; }
    if (!sheet) sheet = heuristic({ words, shots, duration, title });
  }
  const used = [];
  for (const c of sheet.cues) {
    if (c.mood === 'none') continue;
    const t = await music.pick(c.mood, { cc0Only: ctx.setting('music.cc0Only', true) !== false, avoid: used });
    if (t) { c.file = t.file; c.source = t.source; c.credit = t.credit; c.track = require('path').basename(t.file); used.push(t.file); c.offset = Math.round(Math.random() * 20); }
  }
  return sheet;
}

module.exports = { plan, heuristic, tidy, scoreText, MOODS };
