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

/** family -> [{ full, weight }] for every bundled font. */
function fonts() {
  if (table) return table;
  table = {};
  let files = []; try { files = fs.readdirSync(DIR).filter((f) => /\.(ttf|otf)$/i.test(f)); } catch { /* none */ }
  for (const f of files) {
    try { const x = readFont(path.join(DIR, f)); if (x) (table[x.family] = table[x.family] || []).push({ full: x.full, weight: x.weight }); } catch { /* unreadable */ }
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
  return { name: best.full, bold: 0 };
}

module.exports = { face, fonts, readFont };
