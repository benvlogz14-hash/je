'use strict';
/**
 * Puts transcript words back on the voice when speech-to-text drifted (whisper sometimes places a stretch of words a
 * second or more early or late; captions then run ahead of or behind the speaker in part of a video).
 *
 * Uses the sound's loudness map (montage.levels: RMS every 0.25 s, cached next to the file). For each ~20 s stretch of
 * words it tries shifts from -3 s to +3 s and keeps the one that puts the most words on loud (spoken) moments, only
 * when it's clearly better than no shift (words in quiet gaps are the tell-tale). Shifts are smoothed between
 * stretches and never reorder words. Footage with music under the whole voice (no quiet gaps) is left as it is, since
 * loudness can't tell there. Runs once per transcript (`voiceAligned`), new and old ones alike.
 */
const montage = require('./montage');

const STEP = 0.25, MAX = 3, WIN = 20;

function align(t, lv) {
  if (!t?.words?.length || !lv?.db?.length) return { t, changed: false };
  const db = lv.db; const st = lv.step || 0.25;
  const sorted = [...db].sort((a, b) => a - b);
  const floor = sorted[Math.floor(sorted.length * 0.1)], high = sorted[Math.floor(sorted.length * 0.9)];
  if (high - floor < 15) return { t, changed: false, why: 'no quiet gaps to measure against' };
  const thr = floor + Math.max(10, (high - floor) * 0.35);
  const off0 = t.audioOffset || 0;
  const voiced = (x) => { const i = Math.floor((x - off0) / st); return i >= 0 && i < db.length && db[i] > thr; };
  // How many of a word's sample points are on loud moments.
  const fit = (ws, d) => { let n = 0, k = 0; for (const w of ws) { const len = Math.max(0.12, w.e - w.s); for (const f of [0.2, 0.5, 0.8]) { k++; if (voiced(w.s + len * f + d)) n++; } } return k ? n / k : 0; };
  const words = t.words; const end = words[words.length - 1].e;
  const wins = [];
  for (let a = words[0].s; a < end; a += WIN) {
    const ws = words.filter((w) => w.s >= a && w.s < a + WIN); if (ws.length < 8) { wins.push({ c: a + WIN / 2, d: null }); continue; }
    const s0 = fit(ws, 0); let best = 0, bs = s0;
    for (let d = -MAX; d <= MAX + 1e-9; d += STEP) { const sc = fit(ws, d); if (sc > bs + 1e-9 || (Math.abs(sc - bs) < 1e-9 && Math.abs(d) < Math.abs(best))) { bs = sc; best = d; } }
    wins.push({ c: a + WIN / 2, d: bs - s0 >= 0.18 && bs >= 0.7 ? Math.round(best * 100) / 100 : 0, s0, bs });
  }
  // Smooth (median of neighbours) so one noisy stretch can't move on its own, then fill empty stretches.
  const raw = wins.map((w) => w.d);
  const sm = raw.map((d, i) => { if (d == null) return null; const nb = [raw[i - 1], d, raw[i + 1]].filter((x) => x != null).sort((a, b) => a - b); return nb[Math.floor(nb.length / 2)]; });
  for (let i = 0; i < sm.length; i++) if (sm[i] == null) sm[i] = sm[i - 1] ?? sm.find((x) => x != null) ?? 0;
  if (sm.every((d) => Math.abs(d) < 0.2)) return { t, changed: false };
  // Shift each word by the offset at its time (linear between stretch centres), keeping the order.
  const offAt = (x) => {
    if (x <= wins[0].c) return sm[0]; if (x >= wins[wins.length - 1].c) return sm[sm.length - 1];
    const i = Math.min(wins.length - 2, Math.floor((x - wins[0].c) / WIN)); const f = (x - wins[i].c) / WIN; return sm[i] + (sm[i + 1] - sm[i]) * Math.max(0, Math.min(1, f));
  };
  // Near where the drift starts or stops, the shift is refined per phrase (words between pauses) around that value.
  const per = new Map();
  const near = (x) => { const i = Math.max(0, Math.min(sm.length - 1, Math.floor((x - wins[0].c + WIN / 2) / WIN))); return [sm[i - 1], sm[i], sm[i + 1]].some((d) => d != null && Math.abs(d) >= 0.2); };
  for (let i = 0; i < words.length;) {
    let j = i; while (j + 1 < words.length && words[j + 1].s - words[j].e < 0.5) j++;
    const ph = words.slice(i, j + 1);
    if (near(ph[0].s)) {
      const b = offAt(ph[0].s); let best = b, bs = fit(ph, b);
      const cands = new Set([0, ...sm.map((d) => d ?? 0)]); for (let d = b - 1; d <= b + 1 + 1e-9; d += 0.125) cands.add(Math.round(d * 1000) / 1000);
      for (const d of cands) { if (Math.abs(d) > MAX) continue; const sc = fit(ph, d); if (sc > bs + 0.15) { bs = sc; best = d; } }
      for (let k = i; k <= j; k++) per.set(k, best);
    }
    i = j + 1;
  }
  let prevE = -Infinity;
  const out = words.map((w, k) => { const d = per.has(k) ? per.get(k) : offAt(w.s); let s = Math.max(0, w.s + d), e = Math.max(s + 0.04, w.e + d); if (s < prevE) { s = prevE; e = Math.max(e, s + 0.04); } prevE = e; return { ...w, s: Math.round(s * 1000) / 1000, e: Math.round(e * 1000) / 1000 }; });
  const segs = (t.segments || []).map((g) => ({ ...g, s: Math.max(0, g.s + offAt(g.s)), e: Math.max(0, g.e + offAt(g.s)) }));
  return { t: { ...t, words: out, segments: segs }, changed: true, shifts: sm };
}

// ---------------------------------------------------------------- fine pass: each phrase on its own voice
/** Loudness every 20 ms (cached next to the file as <name>.levels20.json). */
async function fineLevels(file, dir) {
  const path = require('path'); const fs = require('fs');
  const cache = path.join(dir || path.dirname(file), `${path.basename(file).replace(/\.[^.]+$/, '')}.levels20.json`);
  try { return JSON.parse(fs.readFileSync(cache, 'utf8')); } catch { /* measure */ }
  const ff = require('./ffmpeg'); const { run } = require('../core/util');
  const r = await run(ff.bin('ffmpeg'), ['-hide_banner', '-nostats', '-i', file, '-vn', '-ac', '1', '-af', 'aresample=16000,asetnsamples=n=320:p=0,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level', '-f', 'null', '-'], { timeoutMs: 3600000, priority: ff.priorityValue() });
  const out = String(r.err || '') + String(r.out || '');
  const lv = { step: 0.02, db: [...out.matchAll(/RMS_level=(-?[\d.]+|-inf)/g)].map((m) => (m[1] === '-inf' ? -90 : Math.max(-90, Math.round(Number(m[1]) * 10) / 10))) };
  try { fs.writeFileSync(cache, JSON.stringify(lv)); } catch { /* read-only */ }
  return lv;
}

/**
 * Each phrase (words between pauses) is matched to the burst of voice it really is, in order: the phrases and the
 * voice bursts heard in the sound (runs of loud 20 ms frames between quiet moments) are lined up as two sequences
 * (dynamic programming, like aligning two strings), where a match costs the difference in length plus a little for
 * how far it moves, and a phrase or a burst can go unmatched (music, a cough, a word whisper missed). A matched
 * phrase is moved onto its burst, keeping its words' spacing, and its last word ends where the voice stops; unmatched
 * phrases move by their neighbours' shift. Never more than 3 s, never out of order.
 */
function snapPhrases(t, lv) {
  if (!t?.words?.length || !lv?.db?.length) return { t, moved: 0 };
  const st = lv.step; const db = lv.db; const sorted = [...db].sort((a, b) => a - b);
  const floor = sorted[Math.floor(sorted.length * 0.1)], high = sorted[Math.floor(sorted.length * 0.9)];
  if (high - floor < 15) return { t, moved: 0 };
  const thr = floor + Math.max(8, (high - floor) * 0.3);
  const off0 = t.audioOffset || 0;
  // voice bursts: loud runs, joined across gaps under 0.25 s, at least 0.1 s long
  const segs = []; let cur = null;
  for (let i = 0; i <= db.length; i++) {
    const on = i < db.length && db[i] > thr; const x = i * st + off0;
    if (on) { if (cur && x - cur.e < 0.25) cur.e = x + st; else { if (cur) segs.push(cur); cur = { s: x, e: x + st }; } }
  }
  if (cur) segs.push(cur);
  const S = segs.filter((g) => g.e - g.s >= 0.1);
  const words = t.words.map((w) => ({ ...w }));
  const P = []; for (let i = 0; i < words.length;) { let j = i; while (j + 1 < words.length && words[j + 1].s - words[j].e < 0.25) j++; P.push({ i, j, s: words[i].s, e: words[j].e }); i = j + 1; }
  const N = P.length, M = S.length; if (!N || !M) return { t, moved: 0 };
  const W = M + 1; const INF = 1e9; const dp = new Float64Array((N + 1) * W).fill(INF); const from = new Int32Array((N + 1) * W).fill(-1); const how = new Int8Array((N + 1) * W);
  const SKIP_P = 0.9, SKIP_S = 0.25, BAND = 3;
  dp[0] = 0;
  for (let i = 0; i <= N; i++) for (let j = 0; j <= M; j++) {
    const c = dp[i * W + j]; if (c >= INF) continue;
    if (i < N && c + SKIP_P < dp[(i + 1) * W + j]) { dp[(i + 1) * W + j] = c + SKIP_P; from[(i + 1) * W + j] = i * W + j; how[(i + 1) * W + j] = 1; }
    if (j < M && c + SKIP_S < dp[i * W + j + 1]) { dp[i * W + j + 1] = c + SKIP_S; from[i * W + j + 1] = i * W + j; how[i * W + j + 1] = 2; }
    if (i < N && j < M && Math.abs(S[j].s - P[i].s) <= BAND) {
      const pd = P[i].e - P[i].s;
      for (let k = j; k < Math.min(M, j + 4); k++) { // a phrase may span a few bursts (short pauses inside it)
        const sd = S[k].e - S[j].s; if (sd > pd * 2 + 1) break;
        const cost = Math.abs(pd - sd) * 0.8 + Math.abs(S[j].s - P[i].s) * 0.15 + (k - j) * 0.1;
        if (c + cost < dp[(i + 1) * W + k + 1]) { dp[(i + 1) * W + k + 1] = c + cost; from[(i + 1) * W + k + 1] = i * W + j; how[(i + 1) * W + k + 1] = 3; }
      }
    }
  }
  // walk back the cheapest path
  const match = new Array(N).fill(null); let pos = N * W + M;
  while (pos > 0 && from[pos] >= 0) { const prev = from[pos]; if (how[pos] === 3) { const i = Math.floor(prev / W), j = prev % W, k = (pos % W) - 1; match[i] = { j, k }; } pos = prev; }
  const shift = P.map((p, i) => (match[i] ? S[match[i].j].s - p.s : null));
  // unmatched phrases take the shift of the nearest matched neighbours (in between: the average)
  for (let i = 0; i < N; i++) if (shift[i] == null) { let a = i - 1; while (a >= 0 && (shift[a] == null || !match[a])) a--; let b = i + 1; while (b < N && !match[b]) b++; const va = a >= 0 ? shift[a] : null, vb = b < N ? shift[b] : null; shift[i] = va != null && vb != null ? (va + vb) / 2 : va ?? vb ?? 0; }
  let moved = 0; let prevE = -Infinity;
  P.forEach((p, i) => {
    const d = shift[i]; if (Math.abs(d) >= 0.04) moved++;
    for (let k = p.i; k <= p.j; k++) { let s0 = words[k].s + d, e0 = words[k].e + d; if (s0 < prevE) { e0 += prevE - s0; s0 = prevE; } words[k].s = Math.round(Math.max(0, s0) * 1000) / 1000; words[k].e = Math.round(Math.max(s0 + 0.04, e0) * 1000) / 1000; prevE = words[k].e; }
    if (match[i]) { const end = S[match[i].k].e; const last = words[p.j]; const nextS = P[i + 1] ? P[i + 1].s + (shift[i + 1] ?? 0) : Infinity; if (end > last.s + 0.08 && end <= nextS + 0.01) { last.e = Math.round(end * 1000) / 1000; prevE = last.e; } }
  });
  return { t: { ...t, words }, moved };
}

/** Align a transcript object for a media file: the coarse pass (drift), then the fine pass (each phrase). Once. */
/**
 * Off unless asked for (a video's Caption timing set to "Lined up to the loudness", or `ai.transcription.align`): with
 * precise (DTW) word times it isn't needed, and on footage with wind/footsteps it moved captions off the voice.
 */
async function alignFile(t, file, workDir, { force = false } = {}) {
  if (!force && require('../core/ctx').setting('ai.transcription.align', false) !== true) return t;
  if (!t?.words?.length || t.voiceAligned?.v === 2) return t;
  // Studio's shared transcripts folder holds files from anywhere: give each its own loudness map (same names clash).
  let dir = workDir;
  if (/studio[\\/]transcripts[\\/]?$/.test(String(workDir || ''))) { dir = require('path').join(workDir, `lv-${require('crypto').createHash('sha1').update(file).digest('hex').slice(0, 12)}`); require('fs').mkdirSync(dir, { recursive: true }); }
  let out = t; let shifts = t.voiceAligned?.shifts || null;
  if (!t.voiceAligned) { try { const lv = await montage.levels(file, dir); const r = align(t, lv); out = r.t; if (r.changed) shifts = r.shifts; } catch { /* no level map */ } }
  let moved = 0;
  try { const r = snapPhrases(out, await fineLevels(file, dir)); out = r.t; moved = r.moved; } catch { /* keep the coarse result */ }
  // Whisper's own word times are kept (wordsRaw) so a video whose captions came out wrong can switch back to them.
  const wordsRaw = t.wordsRaw || (!t.voiceAligned ? t.words : undefined);
  return { ...out, ...(wordsRaw ? { wordsRaw } : {}), voiceAligned: { v: 2, at: new Date().toISOString(), shifts, phrasesMoved: moved } };
}

module.exports = { align, alignFile, snapPhrases, fineLevels };
