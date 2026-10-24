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
  if (fs.existsSync(cache)) return JSON.parse(fs.readFileSync(cache, 'utf8'));
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
    const outBase = path.join(asset.workDir, `${asset.id}.whisper`);
    // Word timing: DTW alignment gives much tighter word times (whisper.cpp 1.6+); older builds run without it.
    const base = ['-m', localModel, '-f', wav, '-oj', '-ml', '1', '-sow', '-of', outBase];
    const opts = { timeoutMs: 6 * 3600000, priority: ff.priorityValue(), onStderrLine: (l) => { const m = /progress\s*=\s*(\d+)%/.exec(l); if (m && onProgress) onProgress(Number(m[1]) / 100); } };
    const dtw = /base\.en/i.test(localModel) ? 'base.en' : /small\.en/i.test(localModel) ? 'small.en' : /tiny\.en/i.test(localModel) ? 'tiny.en' : null;
    try { await run(localBin, dtw ? [...base, '--dtw', dtw] : base, opts); } catch (e) { if (!dtw) throw e; await run(localBin, base, opts); }
    const j = JSON.parse(fs.readFileSync(outBase + '.json', 'utf8'));
    const words = (j.transcription || []).map((t) => ({ w: t.text.trim(), s: t.offsets.from / 1000, e: t.offsets.to / 1000 })).filter((w) => w.w);
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
  fs.writeFileSync(cache, JSON.stringify(result));
  return result;
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
    if ([...out, ...exclude].some((o) => overlap(o, clip) > 0.2)) continue;
    out.push(clip);
  }
  return out.sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, count);
}

/** Taste rules so edits don't look AI-made (adapted from reel-room by Eli Colussi, MIT). */
const TASTE_RULES = `Don't make it look AI-edited; viewers scroll past the generic auto-edit look:
- No clickbait hooks ("You won't believe..."). Use the speaker's actual promise in their own words, 3-7 words.
- Zooms only on the words that carry the point: roughly one every 4-8 seconds for energetic clips, none on serious lines. Never a zoom on every sentence.
- Never more than two things on screen besides the speaker and captions, and nothing covers the face.
- Graphics never repeat the captions word for word. No decorative emoji.
- Every effect is motivated by a specific word or beat; when unsure, leave it out.`;

const DISCOVERY_SYSTEM = `You are the clip editor for a short-form video agency. You find the strongest standalone moments in long footage for TikTok, Reels and YouTube Shorts.
A great clip: opens on a hook in the first 2 seconds, makes one complete point, ends on a payoff or punchline, needs no outside context, and stays between the requested min and max length.
For political clients: keep claims accurate to what was said, never splice meaning, and avoid moments that misrepresent anyone.
Return JSON: {"clips":[{"start":sec,"end":sec,"title":"<=60 chars, curiosity-driven","hook":"<=8 word on-screen headline","caption":"1-2 sentence social caption","hashtags":["tag",...],"score":0-100,"reason":"why it works","punchIns":[{"at":seconds_from_clip_start,"dur":1.2}],"trials":[{"name":"<=3 words","test":"the one thing this version tests","hook":"a genuinely different opening headline","start":sec}]}]}
"trials": 2-3 alternative openings for the same clip, for Instagram trial reels: each opens differently (result first, question first, a bolder sentence later in the clip via a later start, or a contrarian line), never the same hook text, and every hook is paid off by the clip.
${TASTE_RULES}`;

async function discoverClips(asset, transcript, { count = 6, jobId, exclude = [], analysis = null, vision = null, onProgress = () => {} } = {}) {
  // Clip length: the client's own setting (the sliders by the upload box), else the global default.
  const prod = ctx.store.get('clients', asset.clientId)?.production || {};
  const minSec = Number(prod.minClipSec) || ctx.setting('production.minClipSec', 20); const maxSec = Math.max(minSec + 5, Number(prod.maxClipSec) || ctx.setting('production.maxClipSec', 59));
  const duration = asset.info?.duration || 0;
  const words = transcript?.words || [];
  // Story windows on whole sentences, scored on what the footage shows and sounds like
  // (voiceover, drone and strong shots, cuts, energy, a hook in the first line). Then an AI picks
  // the best and writes the titles and hooks; without one, the scores decide.
  if (transcript?.words?.length) {
    const montage = require('./montage');
    onProgress(0.25, 'Listening for voiceover');
    const sig = await montage.signals({ asset, transcript, vision, analysis });
    onProgress(0.4, 'Scoring every moment');
    const cands = montage.candidates(sig, { minSec, maxSec, duration, exclude, limit: 24, storyCuts: prod.storyCuts === true || ctx.setting('production.storyCuts', false) === true });
    if (cands.length) {
      const name = cleanName(asset.name);
      const fallback = (c, i) => ({ start: c.start, end: c.end, keep: c.keep, score: Math.round(c.score), title: `${name} · Part ${i + 1}`.slice(0, 80), hook: hookFrom(c.text) || name.split(/\s+[-|:·]\s+/)[0].split(/\s+/).slice(0, 7).join(' '), caption: '', hashtags: [], reason: `Picked for: ${c.why.join(', ') || 'steady speech'}`, punchIns: zoomsFor(c, analysis) });
      if (ai.anyConnected()) {
        let tick = null;
        try {
          // Llama on a laptop can be slow: if the AI hasn't chosen within 10 minutes (it's hung), the footage scores decide.
          const waitSec = Number(ctx.setting('production.aiPickSeconds', 600)); const t0 = Date.now();
          tick = setInterval(() => { const left = Math.max(0, waitSec - Math.round((Date.now() - t0) / 1000)); onProgress(0.45 + 0.4 * (1 - left / waitSec), `AI choosing the best ${count} (uses the scores in ${Math.ceil(left / 60)} min if it hasn't answered)`); }, 5000);
          const r = await Promise.race([new Promise((_, no) => setTimeout(() => no(new Error('AI took too long')), waitSec * 1000).unref?.()), ai.ask({ role: 'analysis', json: true, clientId: asset.clientId, jobId, maxTokens: 3500, system: DISCOVERY_SYSTEM,
            prompt: `Footage: "${asset.name}" (${Math.round(duration)}s). Below are the ${Math.min(cands.length, 18)} strongest candidate moments, already measured (VO = voiceover narration, which performs best; DRONE = aerial shots). Choose the ${count} that would do best as YouTube Shorts/TikToks: a scroll-stopping first line, one clear story with a payoff, curiosity, strong visuals. Skip ones that start mid-thought or are just filler.\n\n${cands.slice(0, 18).map((c, i) => `#${i + 1} [${c.start.toFixed(1)}-${c.end.toFixed(1)}s] score ${Math.round(c.score)}${c.why.length ? ` (${c.why.join(', ')})` : ''}: "${c.text.slice(0, 420)}"`).join('\n')}\n\nReturn JSON: {"clips":[{"pick":1,"title":"<=60 chars, curiosity-driven","hook":"<=8 word on-screen headline in the speaker's own promise","caption":"1-2 sentence social caption","hashtags":["tag"],"reason":"why it will work","punchIns":[{"at":seconds_from_clip_start,"dur":1.2}],"trials":[{"name":"<=3 words","test":"what this version tests","hook":"a different opening headline","start":sec}]}]}` })]);
          clearInterval(tick);
          const chosen = []; const seen = new Set();
          for (const x of r.json?.clips || []) {
            const c = cands[Number(x.pick) - 1]; if (!c || seen.has(c)) continue; seen.add(c);
            chosen.push({ ...fallback(c, chosen.length), ...x, start: c.start, end: c.end, keep: c.keep, score: Math.round(c.score), reason: `${x.reason || ''}${c.why.length ? ` (${c.why.join(', ')})` : ''}`.trim(), punchIns: Array.isArray(x.punchIns) && x.punchIns.length ? x.punchIns : zoomsFor(c, analysis), agent: `${r.provider}:${r.model}` });
            if (chosen.length >= count) break;
          }
          for (const c of cands) { if (chosen.length >= count) break; if (!seen.has(c)) { seen.add(c); chosen.push(fallback(c, chosen.length)); } }
          if (chosen.length) return { method: 'ai', clips: normalizeClips(chosen, { words, duration, minSec, maxSec, exclude, count }) };
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
    c.hook = name.split(/\s+[-|:·]\s+/)[0].split(/\s+/).slice(0, 7).join(' ');
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

module.exports = { TASTE_RULES, transcribe, discoverClips, planRevision, transcriptExcerpt, normalizeClips };
