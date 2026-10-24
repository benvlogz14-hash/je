'use strict';
/**
 * Tidy speech-to-text words before anything uses them (captions, pause cuts, clip picking).
 *
 * 1. Word times: Whisper lets the first word after a pause start in the silence before it, and the
 *    last word before a pause run on into the silence after it. Such a word is cut back to twice the
 *    typical word length, from the side that touches the silence. Captions then appear when the word
 *    is said, and the pause between the words is seen as a pause.
 * 2. Repetition loops: on noise, music or quiet, Whisper can repeat one phrase many times in a row.
 *    A phrase repeated back to back 4+ times (a single word 6+ times) keeps one copy.
 *
 * Runs on new transcripts and on saved ones as they are loaded, so old footage gets it too.
 */

const norm = (w) => String(w).toLowerCase().replace(/[^a-z0-9']/g, '');

function fixTimes(words) {
  if (words.length < 4) return words;
  const lens = words.map((w) => w.e - w.s).filter((d) => d > 0).sort((a, b) => a - b);
  const median = lens[Math.floor(lens.length / 2)] || 0.3;
  const cap = Math.max(0.35, Math.min(1.2, median * 2));
  return words.map((w, i) => {
    const prev = words[i - 1]; const next = words[i + 1]; let { s, e } = w;
    if (e - s <= cap) return w;
    const pauseBefore = !prev || s - prev.e > 0.25 || prev.e >= s; // starts after a gap (or soaked it up)
    const pauseAfter = !next || next.s - e > 0.25;
    if (pauseBefore && !pauseAfter) s = e - cap;
    else if (pauseAfter && !pauseBefore) e = s + cap;
    else if (pauseBefore && pauseAfter) { const mid = (s + e) / 2; s = mid - cap / 2; e = mid + cap / 2; }
    else return w; // inside continuous speech: leave it
    return { ...w, s: Math.round(s * 1000) / 1000, e: Math.round(e * 1000) / 1000 };
  });
}

function dropLoops(words) {
  const out = []; let i = 0;
  while (i < words.length) {
    let skipped = false;
    for (let n = 1; n <= 6 && !skipped; n++) {
      const phrase = words.slice(i, i + n).map((w) => norm(w.w)).join(' '); if (!phrase.trim()) break;
      let reps = 1; while (words.slice(i + reps * n, i + (reps + 1) * n).map((w) => norm(w.w)).join(' ') === phrase) reps++;
      if (reps >= (n === 1 ? 6 : 4)) { out.push(...words.slice(i, i + n)); i += reps * n; skipped = true; }
    }
    if (!skipped) { out.push(words[i]); i++; }
  }
  return out;
}

/** A cleaned copy of a transcript ({ words, segments, text }). */
function clean(t) {
  if (!t || !Array.isArray(t.words) || t.cleaned === 2) return t;
  const words = fixTimes(dropLoops(t.words.filter((w) => w && String(w.w).trim() && w.e >= w.s)));
  return { ...t, words, text: words.map((w) => w.w).join(' '), cleaned: 2 };
}

module.exports = { clean, fixTimes, dropLoops };
