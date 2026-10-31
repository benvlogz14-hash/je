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

/** Align a transcript object for a media file (once; marks `voiceAligned`). */
async function alignFile(t, file, workDir) {
  if (!t?.words?.length || t.voiceAligned) return t;
  // Studio's shared transcripts folder holds files from anywhere: give each its own loudness map (same names clash).
  let dir = workDir;
  if (/studio[\\/]transcripts[\\/]?$/.test(String(workDir || ''))) { dir = require('path').join(workDir, `lv-${require('crypto').createHash('sha1').update(file).digest('hex').slice(0, 12)}`); require('fs').mkdirSync(dir, { recursive: true }); }
  let lv = null; try { lv = await montage.levels(file, dir); } catch { return t; }
  const r = align(t, lv);
  return { ...r.t, voiceAligned: r.changed ? { at: new Date().toISOString(), shifts: r.shifts } : true };
}

module.exports = { align, alignFile };
