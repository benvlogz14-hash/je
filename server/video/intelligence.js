'use strict';
/** Transcription, AI clip discovery (with a labelled heuristic fallback) and feedback → edit plans. */
const fs = require('fs');
const path = require('path');
const ctx = require('../core/ctx');
const ai = require('../integrations/ai');
const ff = require('./ffmpeg');
const { run, safeJson, clamp } = require('../core/util');

// ------------------------------------------------------------ Transcription
async function transcribe(asset, { jobId, onProgress } = {}) {
  const dir = path.dirname(asset.path);
  const cache = path.join(asset.workDir || dir, `${asset.id}.transcript.json`);
  if (fs.existsSync(cache)) { const raw = JSON.parse(fs.readFileSync(cache, 'utf8')); const t = require('./transcript-fix').clean(raw); if (t !== raw) { try { fs.writeFileSync(cache, JSON.stringify(t)); } catch { /* read-only */ } } return t; }
  const duration = asset.info?.duration || 0;
  // No speech-to-text yet: install the free one (whisper.cpp) right here instead of stopping.
  if (!ai.connected('openai')) {
    const wh = require('../setup/whisper');
    if (!wh.status().ready) { try { await wh.install({ progress: () => {} }); } catch (e) { const err = new Error(`Couldn't install the free speech-to-text tool: ${e.message}. Press "Install" on the speech-to-text item in Settings, or check the internet connection.`); err.notConnected = true; throw err; } }
  }
  const localBin = ctx.setting('ai.transcription.localWhisperPath', '');
  const localModel = ctx.setting('ai.transcription.localWhisperModel', '');
  let result;
  if (localBin && localModel && fs.existsSync(localBin)) {
    const wav = path.join(asset.workDir, `${asset.id}.wav`);
    await ff.extractWav(asset.path, wav);
    const words = await whisperLocal(localBin, localModel, wav, path.join(asset.workDir, `${asset.id}.whisper`), { duration, onProgress });
    result = { engine: 'whisper.cpp (local)', text: words.map((w) => w.w).join(' '), words, segments: segmentsFromWords(words) };
    try { fs.unlinkSync(wav); } catch { /* ignore */ }
  } else if (ai.connected('openai')) {
    // 48 kbps mono MP3 ≈ 21 MB/hour; split into ≤45-minute pieces to stay under the 25 MB API limit.
    const CH = 45 * 60; const pieces = Math.max(1, Math.ceil(duration / CH));
    const words = []; const segments = []; let text = '';
    for (let i = 0; i < pieces; i++) {
      const mp3 = path.join(asset.workDir, `${asset.id}.part${i}.mp3`);
      await ff.extractAudio(asset.path, mp3, pieces > 1 ? { start: i * CH, duration: CH } : {});
      const r = await ai.transcribeOpenAI(mp3, { clientId: asset.clientId, jobId, durationSec: Math.min(CH, duration - i * CH), model: ctx.setting('ai.transcription.model', 'whisper-1') });
      const off = i * CH;
      words.push(...r.words.map((w) => ({ w: w.w, s: w.s + off, e: w.e + off })));
      segments.push(...r.segments.map((s) => ({ s: s.s + off, e: s.e + off, t: s.t })));
      text += (text ? ' ' : '') + r.text;
      try { fs.unlinkSync(mp3); } catch { /* ignore */ }
      if (onProgress) onProgress((i + 1) / pieces);
    }
    result = { engine: 'OpenAI Whisper', text, words, segments: segments.length ? segments : segmentsFromWords(words) };
  } else {
    const e = new Error('No speech-to-text yet. Euclidean tried to install the free one and could not; press Install on the speech-to-text item in Settings.');
    e.notConnected = true; throw e;
  }
  // Line the words up with the picture when the file's sound starts later than its video.
  try {
    const off = (await ff.probe(asset.path)).audioOffset || 0;
    if (off > 0.02) { result.words = result.words.map((w) => ({ ...w, s: w.s + off, e: w.e + off })); result.segments = (result.segments || []).map((x) => ({ ...x, s: x.s + off, e: x.e + off })); result.audioOffset = off; }
  } catch { /* keep as is */ }
  result = require('./transcript-fix').clean(result);
  fs.writeFileSync(cache, JSON.stringify(result));
  return result;
}

// ------------------------------------------------------------ local whisper.cpp, fast
/**
 * whisper.cpp on this PC, as fast as the machine allows without losing the timing fixes:
 *  - all but one CPU core (whisper.cpp's own default is 4 threads),
 *  - greedy decoding (one pass instead of 5 beams, ~2x faster; `ai.transcription.accuracy: 'best'` keeps beams),
 *  - long videos on 8+ core PCs are split at quiet moments and the pieces run side by side (whisper stops getting
 *    faster past ~8 threads, so two or three processes beat one), word times shifted back by each piece's start,
 *  - `-pp` so the progress bar moves (without it whisper prints no progress and the step sat at 0%),
 *  - DTW word timing kept; a build that can't do it is remembered so the file is never transcribed twice.
 */
async function whisperLocal(bin, model, wav, outBase, { duration = 0, onProgress } = {}) {
  const os = require('os');
  const cores = Math.max(1, (os.availableParallelism ? os.availableParallelism() : os.cpus().length) || 1);
  const set = Number(ctx.setting('ai.transcription.threads', 0)) || 0;
  const best = ctx.setting('ai.transcription.accuracy', 'fast') === 'best';
  const dur = duration || 0;
  const n = set ? 1 : dur > 240 && cores >= 8 ? Math.min(4, Math.floor(cores / 4), Math.ceil(dur / 120)) : 1;
  const threads = set || Math.max(1, Math.min(8, Math.floor((cores - (cores > 2 ? 1 : 0)) / n)));
  // Where to cut: the quiet moment nearest each even split point (never inside a word).
  let cuts = [0];
  if (n > 1) {
    let quiet = [];
    try { quiet = (await ff.speechWindows(wav)).silences.map(([a, b]) => (a + b) / 2); } catch { /* cut on time */ }
    for (let i = 1; i < n; i++) {
      const t = (dur * i) / n; const near = quiet.filter((q) => Math.abs(q - t) < 25).sort((a, b) => Math.abs(a - t) - Math.abs(b - t))[0];
      cuts.push(near ?? t);
    }
  }
  cuts = [...new Set(cuts.map((c) => Math.round(c * 100) / 100))].sort((a, b) => a - b);
  const pieces = cuts.map((s, i) => ({ s, e: cuts[i + 1] ?? null, i }));
  const prog = pieces.map(() => 0); const weight = pieces.map((p) => (dur ? ((p.e ?? dur) - p.s) / dur : 1 / pieces.length));
  const report = () => onProgress && onProgress(Math.min(0.99, prog.reduce((a, v, i) => a + v * weight[i], 0)));
  const dtw = ctx.setting('ai.transcription.noDtw', false) ? null : /base\.en/i.test(model) ? 'base.en' : /small\.en/i.test(model) ? 'small.en' : /tiny\.en/i.test(model) ? 'tiny.en' : /medium\.en/i.test(model) ? 'medium.en' : null;
  const one = async (p) => {
    let file = wav; const of = pieces.length > 1 ? `${outBase}.p${p.i}` : outBase;
    if (pieces.length > 1) { file = `${of}.wav`; await run(ff.bin('ffmpeg'), ['-hide_banner', '-y', '-ss', String(p.s), ...(p.e != null ? ['-to', String(p.e)] : []), '-i', wav, '-c:a', 'pcm_s16le', file], { timeoutMs: 600000 }); }
    const base = ['-m', model, '-f', file, '-oj', '-ml', '1', '-sow', '-pp', '-t', String(threads), ...(best ? [] : ['-bs', '1', '-bo', '1']), '-of', of];
    const opts = { timeoutMs: 6 * 3600000, onStderrLine: (l) => { const m = /progress\s*=\s*(\d+)%/.exec(l); if (m) { prog[p.i] = Number(m[1]) / 100; report(); } } };
    try { await run(bin, dtw ? [...base, '--dtw', dtw] : base, opts); } catch (e) {
      if (!dtw || e.canceled) throw e;
      ctx.store.setSettings({ ai: { transcription: { noDtw: true } } }); // this build can't do DTW: don't try again on the next video
      await run(bin, base, opts);
    }
    prog[p.i] = 1; report();
    const j = JSON.parse(fs.readFileSync(`${of}.json`, 'utf8'));
    if (pieces.length > 1) { for (const f of [file, `${of}.json`]) { try { fs.unlinkSync(f); } catch { /* ignore */ } } }
    return (j.transcription || []).map((t) => ({ w: t.text.trim(), s: t.offsets.from / 1000 + p.s, e: t.offsets.to / 1000 + p.s })).filter((w) => w.w);
  };
  const parts = await Promise.all(pieces.map(one));
  return parts.flat().sort((a, b) => a.s - b.s);
}

function segmentsFromWords(words) {
  const segs = []; let cur = null;
  for (const w of words) {
    if (!cur || w.s - cur.e > 0.8 || cur.t.length > 160 || /[.!?]$/.test(cur.t)) { if (cur) segs.push(cur); cur = { s: w.s, e: w.e, t: w.w }; }
    else { cur.e = w.e; cur.t += ' ' + w.w; }
  }
  if (cur) segs.push(cur);
  return segs;
}

// ------------------------------------------------------------ Clip discovery
function snap(words, t, edge) {
  if (!words.length) return t;
  let best = t, bestD = Infinity;
  for (const w of words) { const v = edge === 'start' ? w.s : w.e; const d = Math.abs(v - t); if (d < bestD) { bestD = d; best = v; } }
  return bestD < 2.5 ? best : t;
}
/** "Inside Pepsi_s Secret ABANDONED Lab _jfE02Xr2nCU_.mp4" -> "Inside Pepsi's Secret ABANDONED Lab". */
function cleanName(n) {
  return String(n || 'Clip').replace(/\.[^.]+$/, '').replace(/[\s_]*[[(_]?[A-Za-z0-9_-]{11}[\])_]?\s*$/, (m) => (/\d/.test(m) && /[A-Z]/.test(m) ? '' : m)).replace(/(\w)_s\b/g, "$1's").replace(/_/g, ' ').replace(/\s+/g, ' ').trim() || 'Clip';
}
/**
 * The on-screen title must be a short hook about the subject ("ABANDONED FACTORY...", "WHY DID they leave it all
 * behind..."), never a sentence quoted from what is said (that just repeats the captions and filled half the screen).
 * cleanHook keeps a good title, shortens a long one, and replaces a quote with a title made from the video's name.
 */
const HOOK_STOP = new Set(['inside', 'exploring', 'explore', 'explored', 'we', 'i', 'the', 'a', 'an', 'this', 'my', 'our', 'visiting', 'touring', 'into', 'entering']);
const HOOK_BREAK = new Set(['from', 'in', 'at', 'on', 'of', 'for', 'with', 'after', 'to', 'by', 'near', 'that', 'where', 'when', 'and', 'but']);
function topicHook(name) {
  const base = String(name || '').replace(/\.[a-z0-9]{2,4}$/i, '').replace(/\(\d+\)/g, '').split(/\s+[-|:·]\s+|_/)[0].replace(/[^\w' ?!]/g, ' ').trim();
  const ws = base.split(/\s+/).filter(Boolean); let i = 0; while (i < ws.length - 1 && HOOK_STOP.has(ws[i].toLowerCase())) i++;
  const out = []; for (const w of ws.slice(i)) { if (out.length >= 2 && HOOK_BREAK.has(w.toLowerCase())) break; out.push(w); if (out.length >= 4) break; }
  return out.length ? `${out.join(' ')}...` : '';
}
function cleanHook(hook, { spoken = '', name = '' } = {}) {
  let h = String(hook || '').replace(/["“”]/g, '').replace(/\s+/g, ' ').trim();
  const norm = (t) => String(t).toLowerCase().replace(/[^a-z0-9' ]/g, ' ').replace(/\s+/g, ' ').trim();
  const first = norm(h).split(' ').slice(0, 3).join(' ');
  const isQuote = first.split(' ').length >= 3 && norm(spoken).includes(first);
  if (!h || isQuote) return topicHook(name) || h.split(' ').slice(0, 4).join(' ');
  const ws = h.split(' ');
  if (ws.length > 7 || h.length > 40) {
    // Cut at a natural break: a comma, then a joining word ("because", "but", "when"...), then a preposition.
    const fits = (t) => { const n = t.split(' ').length; return n >= 2 && n <= 7 && t.length <= 40; };
    const byPunct = h.split(/[,:;—–-]\s/)[0].trim();
    const before = (set) => { for (let i = Math.min(ws.length - 1, 7); i >= 2; i--) if (set.has(ws[i].toLowerCase().replace(/[^a-z]/g, ''))) { const t = ws.slice(0, i).join(' '); if (fits(t)) return t; } return null; };
    h = (fits(byPunct) && byPunct) || before(new Set(['because', 'but', 'and', 'so', 'when', 'while', 'until', 'since', 'which', 'who', 'that', 'where'])) || before(HOOK_BREAK) || ws.slice(0, 5).join(' ');
    h = h.replace(/[,.;:]+$/, '');
    if (!/[?!]$/.test(h) && !/\.\.\.$/.test(h)) h += '...';
  }
  return h;
}

/** A short on-screen hook from the clip's first sentence. */
function hookFrom(text) { const first = String(text || '').split(/(?<=[.!?])\s/)[0].replace(/[.,!?]+$/, ''); const w = first.split(/\s+/); return w.length >= 3 ? w.slice(0, 7).join(' ') : ''; }
/** Zooms on energy peaks and scene changes, about one every 5 seconds. */
function zoomsFor(c, analysis) {
  const beats = [...(analysis?.peaks || []), ...(analysis?.scenes || [])].filter((t) => t > c.start + 1.5 && t < c.end - 1.5).sort((a, b) => a - b);
  const z = []; let last = -99;
  for (const t of beats) if (t - last >= 4.5) { z.push({ at: Math.round((t - c.start) * 10) / 10, dur: 1.2, zoom: 1.12 }); last = t; }
  for (let t = 2.5; t < c.end - c.start - 2 && z.length < Math.ceil((c.end - c.start) / 6); t += 6) if (!z.some((x) => Math.abs(x.at - t) < 3)) z.push({ at: t, dur: 1.2, zoom: 1.1 });
  return z.sort((a, b) => a.at - b.at).slice(0, 10);
}
function overlap(a, b) { const i = Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start)); return i / Math.min(a.end - a.start, b.end - b.start); }

function normalizeClips(raw, { words, duration, minSec, maxSec, exclude = [], count }) {
  const out = [];
  for (const c of raw) {
    let start = clamp(Number(c.start) || 0, 0, duration), end = clamp(Number(c.end) || 0, 0, duration);
    if (!(end > start)) continue;
    start = snap(words, start, 'start'); end = snap(words, end, 'end') + 0.15;
    if (end - start < minSec) end = Math.min(duration, start + minSec);
    if (end - start > maxSec && !c.keep) end = start + maxSec; // story cuts span longer; their kept sentences fit
    end = Math.min(end, duration);
    const clip = { ...c, start: Math.round(start * 100) / 100, end: Math.round(end * 100) / 100 };
    if (end - start < Math.min(minSec, 5)) continue;
    const share = require('./montage').sharedSec; const len = (x) => (x.keep?.length ? x.keep.reduce((n, [a, b]) => n + b - a, 0) : x.end - x.start);
    if ([...out, ...exclude].some((o) => share(o, clip) > 0.2 * Math.min(len(o), len(clip)))) continue;
    out.push(clip);
  }
  return out.sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, count);
}

/** Taste rules so edits don't look AI-made (adapted from reel-room by Eli Colussi, MIT). */
const TASTE_RULES = `Don't make it look AI-edited; viewers scroll past the generic auto-edit look:
- The hook is a short on-screen title about the subject, 2-5 words, like a video title: "Abandoned factory...", "Why did they leave it all behind...", "The town that sank...". Never a sentence quoted from what is said (the captions already show that), no clickbait like "You won't believe".
- Zooms only on the words that carry the point: roughly one every 4-8 seconds for energetic clips, none on serious lines. Never a zoom on every sentence.
- Never more than two things on screen besides the speaker and captions, and nothing covers the face.
- Graphics never repeat the captions word for word. No decorative emoji.
- Every effect is motivated by a specific word or beat; when unsure, leave it out.`;

const DISCOVERY_SYSTEM = `You are the clip editor for a short-form video agency. You find the strongest standalone moments in long footage for TikTok, Reels and YouTube Shorts.
A great clip: opens on a hook in the first 2 seconds, makes one complete point, ends on a payoff or punchline, needs no outside context, and stays between the requested min and max length.
For political clients: keep claims accurate to what was said, never splice meaning, and avoid moments that misrepresent anyone.
Return JSON: {"clips":[{"start":sec,"end":sec,"title":"<=60 chars, curiosity-driven","hook":"2-5 word on-screen title about the subject, never a quote of what is said","caption":"1-2 sentence social caption","hashtags":["tag",...],"score":0-100,"reason":"why it works","punchIns":[{"at":seconds_from_clip_start,"dur":1.2}],"trials":[{"name":"<=3 words","test":"the one thing this version tests","hook":"a genuinely different opening headline","start":sec}]}]}
"trials": 2-3 alternative openings for the same clip, for Instagram trial reels: each opens differently (result first, question first, a bolder sentence later in the clip via a later start, or a contrarian line), never the same hook text, and every hook is paid off by the clip.
${TASTE_RULES}`;

/** Tips like "focus on the drone shots, skip the intro": moments that mention the tip's words score higher, words after no/skip/avoid/not lower. */
function tipNudge(cands, tips) {
  const STOP = new Set(['the', 'and', 'that', 'this', 'with', 'from', 'more', 'less', 'only', 'clips', 'clip', 'focus', 'want', 'make', 'some', 'when', 'where', 'they', 'have', 'into', 'like', 'shots', 'parts', 'moments', 'part', 'moment', 'video', 'should']);
  const neg = new Set(); const pos = new Set();
  for (const sent of tips.toLowerCase().split(/[.,;!\n]+/)) {
    const ws = sent.match(/[a-z0-9']+/g) || []; let no = false;
    for (const w of ws) { if (['no', 'not', 'skip', 'avoid', 'without', 'dont', "don't", 'never', 'cut'].includes(w)) { no = true; continue; } if (w.length < 4 || STOP.has(w)) continue; (no ? neg : pos).add(w.replace(/s$/, '')); }
  }
  for (const c of cands) {
    const t = ` ${String(c.text || '').toLowerCase()} ${(c.why || []).join(' ')} `;
    const hit = (w) => t.includes(w);
    const p = [...pos].filter(hit).length, n = [...neg].filter(hit).length;
    if (p || n) { c.score = Math.round((c.score + 8 * Math.min(p, 3) - 12 * Math.min(n, 2)) * 10) / 10; if (p) c.why = [...(c.why || []), 'matches your tips']; }
  }
  cands.sort((a, b) => b.score - a.score);
}

/**
 * The AI re-cuts each chosen montage clip from the whole stretch it came from: it sees every sentence (numbered, with
 * lengths) and picks whole lines in order for a 20-30 s story that opens on a hook and ends on an open loop. Its pick
 * is used only if it's whole sentences, in order, the right length, opens on a line that stands alone and ends on an
 * open hook; otherwise the scored cut stays.
 */
async function recut(chosen, sig, { asset, jobId, minSec, maxSec, tips }) {
  const m = require('./montage'); const S = sig.sents;
  const tmax = Math.min(maxSec, Math.max(minSec + 10, Number(ctx.setting('production.montageMaxSec', 30)) || 30));
  const list = chosen.filter((c) => c.keep && c.span).slice(0, 8);
  if (!list.length) return;
  const block = list.map((c, n) => `CLIP ${n + 1} (${c.title || ''}):\n${S.slice(c.span[0], c.span[1] + 1).map((x, k) => `${k + 1}. (${m.spoken(x).toFixed(1)}s) ${x.t}`).join('\n')}`).join('\n\n');
  try {
    const waitSec = Math.min(300, Number(ctx.setting('production.aiPickSeconds', 600)));
    const r = await Promise.race([new Promise((_, no) => setTimeout(() => no(new Error('slow')), waitSec * 1000).unref?.()), ai.ask({ role: 'analysis', json: true, clientId: asset.clientId, jobId, maxTokens: 1500,
      system: `You edit YouTube Shorts the usual way: take a long stretch of someone talking and cut it down to a short story. Rules: whole sentences only (never cut inside one), keep them in their original order, no filler, no repeats, no outros or plugs. Open on a line that grabs attention and makes sense on its own. Build up through the strongest lines. End on an open hook: a line that leaves the viewer wanting the payoff ("and then we opened the door...", a question, a reveal about to happen), never the payoff itself. Total ${minSec} to ${tmax} seconds (the seconds are next to each line).${tips ? ` The editor's tips: ${tips}` : ''}`,
      prompt: `${block}\n\nFor every clip return the line numbers to keep. JSON: {"clips":[{"clip":1,"lines":[1,4,5,9]}]}` })]);
    for (const x of r.json?.clips || []) {
      const c = list[Number(x.clip) - 1]; if (!c) continue;
      const sec = S.slice(c.span[0], c.span[1] + 1);
      const idx = [...new Set((x.lines || []).map(Number).filter((k) => k >= 1 && k <= sec.length))].sort((a, b) => a - b);
      if (idx.length < 2) continue;
      const kept = idx.map((k) => sec[k - 1]); const total = kept.reduce((n, y) => n + m.spoken(y), 0);
      if (total < minSec * 0.9 || total > tmax + 3) continue;
      if (m.DANGLING.test(kept[0].t) || !m.OPEN_LOOP.test(kept[kept.length - 1].t) || kept.some((y) => m.OUTRO.test(y.t))) continue;
      c.keep = kept.map((y) => [Math.round(Math.max(0, y.s - 0.12) * 100) / 100, Math.round((y.e + 0.18) * 100) / 100]);
      c.start = c.keep[0][0]; c.end = c.keep[c.keep.length - 1][1];
      c.reason = `${c.reason || ''} (cut by the AI from ${Math.round(sec[sec.length - 1].e - sec[0].s)} s)`.trim();
    }
  } catch { /* the scored cut stays */ }
}

async function discoverClips(asset, transcript, { count = 6, jobId, exclude = [], analysis = null, vision = null, onProgress = () => {}, storyCuts = null, endHook = false, minSec: minO = null, maxSec: maxO = null } = {}) {
  // Clip length: a style's own (Documentary is 22-40 s, from the reference short), else the client's setting (the sliders
  // by the upload box), else the global default.
  const prod = ctx.store.get('clients', asset.clientId)?.production || {};
  const minSec = Number(minO) || Number(prod.minClipSec) || ctx.setting('production.minClipSec', 20); const maxSec = Math.max(minSec + 5, Number(maxO) || Number(prod.maxClipSec) || ctx.setting('production.maxClipSec', 59));
  const duration = asset.info?.duration || 0;
  const words = transcript?.words || [];
  // The editor's tips (box by the upload area): sent to the AI, and used to nudge the scores when no AI picks.
  const tips = String(prod.aiTips || '').trim().slice(0, 1000);
  // Story windows on whole sentences, scored on what the footage shows and sounds like
  // (voiceover, drone and strong shots, cuts, energy, a hook in the first line). Then an AI picks
  // the best and writes the titles and hooks; without one, the scores decide.
  if (transcript?.words?.length) {
    const montage = require('./montage');
    onProgress(0.25, 'Listening for voiceover');
    const sig = await montage.signals({ asset, transcript, vision, analysis });
    onProgress(0.4, 'Scoring every moment');
    const cands = montage.candidates(sig, { minSec, maxSec, duration, exclude, limit: 24, endHook, storyCuts: storyCuts ?? (prod.storyCuts ?? ctx.setting('production.storyCuts', true)) !== false });
    if (tips) tipNudge(cands, tips);
    // What this client's editor approved and rejected before leans the scores (and is shown to the AI below).
    try { require('./taste').nudge(cands, asset.clientId); } catch { /* nothing learned yet */ }
    if (cands.length) {
      const name = cleanName(asset.name);
      const fallback = (c, i) => ({ start: c.start, end: c.end, keep: c.keep, why: c.why, score: Math.round(c.score), title: `${name} · Part ${i + 1}`.slice(0, 80), hook: topicHook(asset.name) || cleanHook(hookFrom(c.text), { name: asset.name }), caption: '', hashtags: [], reason: `Picked for: ${c.why.join(', ') || 'steady speech'}`, punchIns: zoomsFor(c, analysis) });
      if (ai.anyConnected()) {
        let tick = null;
        try {
          // Llama on a laptop can be slow: if the AI hasn't chosen within 10 minutes (it's hung), the footage scores decide.
          const waitSec = Number(ctx.setting('production.aiPickSeconds', 600)); const t0 = Date.now();
          tick = setInterval(() => { const left = Math.max(0, waitSec - Math.round((Date.now() - t0) / 1000)); onProgress(0.45 + 0.4 * (1 - left / waitSec), `AI choosing the best ${count} (uses the scores in ${Math.ceil(left / 60)} min if it hasn't answered)`); }, 5000);
          const r = await Promise.race([new Promise((_, no) => setTimeout(() => no(new Error('AI took too long')), waitSec * 1000).unref?.()), ai.ask({ role: 'analysis', json: true, clientId: asset.clientId, jobId, maxTokens: 3500, system: DISCOVERY_SYSTEM,
            prompt: `Footage: "${asset.name}" (${Math.round(duration)}s). Below are the ${Math.min(cands.length, 18)} strongest candidate moments, already measured (VO = voiceover narration, which performs best; DRONE = aerial shots). Choose the ${count} that would do best as YouTube Shorts/TikToks: a scroll-stopping first line, one clear story with a payoff, curiosity, strong visuals. Skip ones that start mid-thought or are just filler.${require('./taste').promptBlock(asset.clientId)}${tips ? `\n\nThe editor's tips for this footage (follow them; they beat the scores): ${tips}` : ''}\n\n${cands.slice(0, 18).map((c, i) => `#${i + 1} [${c.start.toFixed(1)}-${c.end.toFixed(1)}s${c.keep ? `, montage: ${c.lines} whole sentences from this stretch` : ''}] score ${Math.round(c.score)}${c.why.length ? ` (${c.why.join(', ')})` : ''}: "${c.text.slice(0, 420)}"`).join('\n')}\n\nReturn JSON: {"clips":[{"pick":1,"title":"<=60 chars, curiosity-driven","hook":"2-5 word on-screen title about what this moment shows (different for every clip, never a quote of what is said)","caption":"1-2 sentence social caption","hashtags":["tag"],"reason":"why it will work","punchIns":[{"at":seconds_from_clip_start,"dur":1.2}],"trials":[{"name":"<=3 words","test":"what this version tests","hook":"a different opening headline","start":sec}]}]}` })]);
          clearInterval(tick);
          const chosen = []; const seen = new Set();
          for (const x of r.json?.clips || []) {
            const c = cands[Number(x.pick) - 1]; if (!c || seen.has(c)) continue; seen.add(c);
            chosen.push({ ...fallback(c, chosen.length), ...x, start: c.start, end: c.end, keep: c.keep, span: c.span, score: Math.round(c.score), reason: `${x.reason || ''}${c.why.length ? ` (${c.why.join(', ')})` : ''}`.trim(), punchIns: Array.isArray(x.punchIns) && x.punchIns.length ? x.punchIns : zoomsFor(c, analysis), agent: `${r.provider}:${r.model}` });
            if (chosen.length >= count) break;
          }
          for (const c of cands) { if (chosen.length >= count) break; if (!seen.has(c)) { seen.add(c); chosen.push(fallback(c, chosen.length)); } }
          if (chosen.some((c) => c.keep)) { onProgress(0.86, 'AI tightening the montage cuts'); await recut(chosen, sig, { asset, jobId, minSec, maxSec, tips }); }
          if (chosen.length) return { method: 'ai', clips: normalizeClips(chosen, { words, duration, minSec, maxSec, exclude, count }).map((c) => ({ ...c, hook: cleanHook(c.hook, { name: asset.name, spoken: words.filter((w) => w.s >= c.start - 0.5 && w.s < c.end).map((w) => w.w).join(' ') }) })) };
        } catch { /* the scores decide */ } finally { clearInterval(tick); }
      }
      return { method: 'scored', clips: normalizeClips(cands.slice(0, count).map(fallback), { words, duration, minSec, maxSec, exclude, count }) };
    }
  }
  // Heuristic fallback: densest speech windows. Clearly labelled in the UI.
  const { silences } = await ff.speechWindows(asset.path);
  const target = Math.round((minSec + maxSec) / 2);
  const cands = [];
  const starts = [...new Set([0, ...silences.map(([, e]) => e), ...(analysis?.scenes || [])])].sort((a, b) => a - b);
  for (const s of starts) {
    if (s + minSec > duration) continue;
    const e = Math.min(duration, s + target);
    const silent = silences.reduce((acc, [a, b]) => acc + Math.max(0, Math.min(b, e) - Math.max(a, s)), 0);
    const peaks = (analysis?.peaks || []).filter((t) => t >= s && t <= e).length;
    const cuts = (analysis?.scenes || []).filter((t) => t >= s && t <= e).length;
    // Pictures count too: drone and strong shots lift a window, dark or unusable ones sink it.
    const vs = (vision?.shots || []).filter((x) => x.s < e && x.e > s);
    const m = require('./montage'); const look = vs.length ? vs.reduce((n, x) => n + m.shotScore(x) * (Math.min(e, x.e) - Math.max(s, x.s)), 0) / (e - s) : 0;
    const drone = vs.some(m.isDrone);
    const score = Math.round(100 * (1 - silent / (e - s)) + peaks * 8 + Math.min(cuts, 4) * 6 + look * 60 + (drone ? 20 : 0));
    cands.push({ start: s, end: e, score, title: '', hook: '', caption: '', hashtags: [], reason: `Picked for ${drone ? 'drone shots, ' : ''}${look > 0.55 ? 'strong visuals, ' : ''}dense sound${peaks ? `, ${peaks} energy peak${peaks > 1 ? 's' : ''}` : ''}${cuts ? `, ${cuts} scene change${cuts > 1 ? 's' : ''}` : ''}` });
  }
  const picked = normalizeClips(cands, { words, duration, minSec, maxSec, exclude, count });
  // Still an edit, not a raw chunk: a clean title and hook from the video's name, and zooms on energy peaks and scene changes.
  const name = cleanName(asset.name);
  picked.forEach((c, i) => {
    c.title = `${name} · Part ${i + 1}`.slice(0, 80);
    c.hook = topicHook(asset.name) || name.split(/\s+/).slice(0, 4).join(' ');
    const beats = [...(analysis?.peaks || []), ...(analysis?.scenes || [])].filter((t) => t > c.start + 1.5 && t < c.end - 1.5).sort((a, b) => a - b);
    const zooms = []; let last = -99;
    for (const t of beats) { if (t - last >= 4.5) { zooms.push({ at: Math.round((t - c.start) * 10) / 10, dur: 1.2, zoom: 1.12 }); last = t; } }
    for (let t = 2.5; t < c.end - c.start - 2 && zooms.length < Math.ceil((c.end - c.start) / 6); t += 6) if (!zooms.some((z) => Math.abs(z.at - t) < 3)) zooms.push({ at: t, dur: 1.2, zoom: 1.1 });
    c.punchIns = zooms.sort((a, b) => a.at - b.at).slice(0, 10);
  });
  return { method: 'heuristic', clips: picked };
}

// ------------------------------------------------------------ Feedback → edit plan
const REVISION_SYSTEM = `${TASTE_RULES}
You turn client feedback on a short-form video into precise edit changes and durable preferences.
Return JSON:
{"changes":{"start":number?,"end":number?,"hook":string?,"title":string?,"caption":string?,"reframe":"crop"|"smart-blur"|"fit"?,"focusX":0-1?,"silenceCut":bool?,"punchIns":[{"at":n,"dur":n}]?,"style":{"preset"?: "clean-pop"|"boxed"|"minimal"|"news"|"karaoke-teal","uppercase"?:bool,"wordsPerLine"?:1-6,"size"?:40-140,"primary"?:"#RRGGBB","highlight"?:"#RRGGBB","position"?:"lower"|"center"|"upper","animation"?:"pop"|"none","highlightMode"?:"word"|"none","box"?:bool,"hook"?:bool}?},
 "remember":[{"text":"durable preference in plain words","style":{...same keys as changes.style}?}],
 "reply":"short friendly confirmation to send the client (no promises about timing)",
 "needsHuman":bool, "reason":"why a human is needed, if so"}
Only include fields that should change. Put a preference in "remember" only if the client expressed it as general taste ("I hate", "always", "never", "for future videos"), not for one-off fixes. Times in changes.start/end are absolute source seconds.`;

async function planRevision({ clip, client, feedback, transcriptExcerpt, jobId }) {
  const r = await ai.ask({
    role: 'analysis', json: true, clientId: client.id, jobId, maxTokens: 1500, system: REVISION_SYSTEM,
    prompt: `CURRENT CLIP: ${JSON.stringify({ start: clip.start, end: clip.end, hook: clip.hook, title: clip.title, caption: clip.caption, reframe: clip.reframe, focusX: clip.focusX, silenceCut: clip.silenceCut })}\nCURRENT CAPTION STYLE: ${JSON.stringify(client.style || {})}\nTRANSCRIPT AROUND CLIP: ${transcriptExcerpt || '(none)'}\n\nCLIENT FEEDBACK: """${feedback}"""`,
  });
  return { ...r.json, agent: `${r.provider}:${r.model}` };
}

function transcriptExcerpt(transcript, start, end, pad = 20) {
  if (!transcript) return '';
  return (transcript.segments || []).filter((s) => s.e > start - pad && s.s < end + pad).map((s) => `[${s.s.toFixed(1)}] ${s.t}`).join('\n').slice(0, 6000);
}

module.exports = { whisperLocal, cleanHook, topicHook, TASTE_RULES, transcribe, discoverClips, planRevision, transcriptExcerpt, normalizeClips };
