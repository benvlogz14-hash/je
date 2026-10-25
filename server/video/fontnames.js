'use strict';
/**
 * Exact names of the bundled caption fonts, read from the font files.
 *
 * FFmpeg (libass) picks a font by family name and weight. When Windows already has a font with the
 * same family name (Adobe apps install Montserrat in several weights, for example), asking for
 * "Montserrat" bold gets Windows' Montserrat Bold instead of our ExtraBold, so exports looked thinner
 * than the preview. Asking for the file's own full name ("Montserrat ExtraBold") always gets our file.
 */
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, 'fonts');
let table = null;

/** { full, family, weight } from one TrueType/OpenType file, or null. */
function readFont(file) {
  const b = fs.readFileSync(file);
  if (b.length < 12) return null;
  const tables = {};
  for (let i = 0, n = b.readUInt16BE(4); i < n; i++) { const o = 12 + i * 16; tables[b.toString('latin1', o, o + 4)] = b.readUInt32BE(o + 8); }
  const names = {};
  if (tables.name != null) {
    const t = tables.name; const count = b.readUInt16BE(t + 2); const strings = t + b.readUInt16BE(t + 4);
    for (let i = 0; i < count; i++) {
      const r = t + 6 + i * 12; const plat = b.readUInt16BE(r); const lang = b.readUInt16BE(r + 4); const id = b.readUInt16BE(r + 6);
      const len = b.readUInt16BE(r + 8); const off = strings + b.readUInt16BE(r + 10);
      if (![1, 4, 16].includes(id)) continue;
      let s;
      if (plat === 3 || plat === 0) { const u = Buffer.from(b.subarray(off, off + len)); u.swap16(); s = u.toString('utf16le'); } else if (plat === 1) s = b.toString('latin1', off, off + len); else continue;
      const rank = plat === 3 && lang === 0x409 ? 3 : plat === 3 ? 2 : 1;
      if (!names[id] || names[id].rank < rank) names[id] = { s, rank };
    }
  }
  const weight = tables['OS/2'] != null ? b.readUInt16BE(tables['OS/2'] + 4) : 400;
  const family = (names[16] || names[1])?.s; const full = names[4]?.s;
  return family && full ? { family, full, weight } : null;
}

/**
 * Text measuring for one font file: advance widths from cmap + hmtx (no kerning), scaled the way libass
 * sizes fonts (the size is the Windows ascent + descent, like VSFilter). Used to fit rounded boxes behind titles.
 */
function readMetrics(file) {
  const b = fs.readFileSync(file); const T = {};
  for (let i = 0, n = b.readUInt16BE(4); i < n; i++) { const o = 12 + i * 16; T[b.toString('latin1', o, o + 4)] = b.readUInt32BE(o + 8); }
  const upem = b.readUInt16BE(T.head + 18); const nH = b.readUInt16BE(T.hhea + 34);
  const os2 = T['OS/2']; const winSum = os2 != null ? b.readUInt16BE(os2 + 74) + b.readUInt16BE(os2 + 76) : 0;
  const asc = os2 != null ? b.readUInt16BE(os2 + 74) : b.readInt16BE(T.hhea + 4);
  const capH = os2 != null && b.readUInt16BE(os2) >= 2 ? b.readInt16BE(os2 + 88) : Math.round(upem * 0.7);
  const adv = (g) => b.readUInt16BE(T.hmtx + Math.min(g, nH - 1) * 4);
  // cmap: Windows Unicode, full repertoire (format 12) or BMP (format 4).
  const map = new Map(); const cm = T.cmap; let sub = null;
  for (let i = 0, n = b.readUInt16BE(cm + 2); i < n; i++) { const r = cm + 4 + i * 8; const pid = b.readUInt16BE(r); const eid = b.readUInt16BE(r + 2); const off = cm + b.readUInt32BE(r + 4); const fmt = b.readUInt16BE(off); if (pid === 3 && eid === 10 && fmt === 12) { sub = off; break; } if (pid === 3 && eid === 1 && fmt === 4) sub = off; }
  const glyph = (code) => {
    if (map.has(code)) return map.get(code); let g = 0;
    if (sub != null && b.readUInt16BE(sub) === 12) { for (let i = 0, n = b.readUInt32BE(sub + 12); i < n; i++) { const r = sub + 16 + i * 12; const a = b.readUInt32BE(r), z = b.readUInt32BE(r + 4); if (code >= a && code <= z) { g = b.readUInt32BE(r + 8) + code - a; break; } } }
    else if (sub != null) {
      const segX2 = b.readUInt16BE(sub + 6); const ends = sub + 14, starts = ends + segX2 + 2, deltas = starts + segX2, ranges = deltas + segX2;
      for (let i = 0; i < segX2 / 2; i++) {
        if (code > b.readUInt16BE(ends + i * 2)) continue; const st = b.readUInt16BE(starts + i * 2); if (code < st) break;
        const ro = b.readUInt16BE(ranges + i * 2); const d = b.readInt16BE(deltas + i * 2);
        if (!ro) g = (code + d) & 0xffff; else { const gi = b.readUInt16BE(ranges + i * 2 + ro + (code - st) * 2); g = gi ? (gi + d) & 0xffff : 0; }
        break;
      }
    }
    map.set(code, g); return g;
  };
  const hA = b.readInt16BE(T.hhea + 4), hD = -b.readInt16BE(T.hhea + 6);
  const winAsc = os2 != null ? b.readUInt16BE(os2 + 74) : hA, winDesc = os2 != null ? b.readUInt16BE(os2 + 76) : hD;
  return { upem, winSum: winSum || upem, asc, capH, hA, hD, winAsc, winDesc, width: (text) => { let w = 0; for (const ch of String(text)) w += adv(glyph(ch.codePointAt(0))); return w; } };
}

/** family -> [{ full, weight }] for every bundled font. */
function fonts() {
  if (table) return table;
  table = {};
  let files = []; try { files = fs.readdirSync(DIR).filter((f) => /\.(ttf|otf)$/i.test(f)); } catch { /* none */ }
  for (const f of files) {
    try { const x = readFont(path.join(DIR, f)); if (x) (table[x.family] = table[x.family] || []).push({ full: x.full, weight: x.weight, file: path.join(DIR, f) }); } catch { /* unreadable */ }
  }
  return table;
}

/**
 * The name and Bold value to write into the subtitles for a font.
 * Bundled fonts: the file's own full name (heavy = the weight nearest 800, the preview's), drawn at its own weight.
 * Other fonts (Windows ones like Arial): the family name, bold when heavy.
 */
function face(family, heavy) {
  const list = fonts()[family];
  if (!list?.length) return { name: family, bold: heavy ? -1 : 0 };
  const want = heavy ? 800 : 400;
  const best = list.slice().sort((a, b) => Math.abs(a.weight - want) - Math.abs(b.weight - want))[0];
  return { name: best.full, bold: 0, file: best.file };
}

const metricsCache = new Map();
/**
 * Measure lines of text in a font at an ASS font size: { widths[], lineH, capH, asc } in pixels.
 * Fonts that aren't bundled (Windows fonts) get an estimate.
 */
function measure(family, heavy, fsPx, lines) {
  const f = face(family, heavy);
  if (!f.file) return { widths: lines.map((l) => l.length * fsPx * 0.52), lineH: fsPx, capH: fsPx * 0.62, asc: fsPx * 0.8 };
  if (!metricsCache.has(f.file)) { try { metricsCache.set(f.file, readMetrics(f.file)); } catch { metricsCache.set(f.file, null); } }
  const m = metricsCache.get(f.file); if (!m) return { widths: lines.map((l) => l.length * fsPx * 0.52), lineH: fsPx, capH: fsPx * 0.62, asc: fsPx * 0.8 };
  const k = fsPx / m.winSum;
  return { widths: lines.map((l) => m.width(l) * k), lineH: fsPx, capH: m.capH * k, asc: m.asc * k };
}

/**
 * How to make a subtitle (libass) draw text the same size and height as the browser does.
 * The browser's font size is the em; libass's is the Windows ascent + descent (like VSFilter), which is
 * 1.3-1.8x the em, so subtitles at the same number came out much smaller than the preview.
 * k: multiply a browser size by this to get the subtitle size.
 * dy: move the subtitle down by dy x the size so its baseline sits where a canvas 'middle' baseline puts it.
 */
function emFit(family, heavy) {
  const f = face(family, heavy);
  if (!f.file) return { k: 1.12, dy: 0 }; // Windows fonts (Arial, Georgia...) are close to this
  if (!metricsCache.has(f.file)) { try { metricsCache.set(f.file, readMetrics(f.file)); } catch { metricsCache.set(f.file, null); } }
  const m = metricsCache.get(f.file); if (!m) return { k: 1.12, dy: 0 };
  const canvas = m.hA / (m.hA + m.hD || 1) - 0.5; const ass = (m.winAsc - m.winDesc) / 2 / m.upem;
  return { k: m.winSum / m.upem, dy: canvas - ass };
}

/** family -> { k (heavy), kr (regular) } for every bundled font, for previews that draw with CSS. */
function scales() {
  const out = {};
  for (const fam of Object.keys(fonts())) { const a = emFit(fam, true), r = emFit(fam, false); out[fam] = { k: Math.round(a.k * 1000) / 1000, kr: Math.round(r.k * 1000) / 1000 }; }
  return out;
}

module.exports = { face, fonts, readFont, readMetrics, measure, emFit, scales };
