'use strict';
/**
 * Ad reads in a video: a creator plugging their website or merch, a sponsor read, "link in the description",
 * "use code", "subscribe". Found from the transcript, sentence by sentence; clips are never made from them
 * (Stringer opens every video with a plug for his website, which used to waste a clip).
 */
const STRONG = [
  /\b(sponsor(ed)?|brought to you by|today'?s video is (brought|sponsored)|partnered with|paid partnership)\b/,
  /\blink(s)? (is |are )?(in|down in|below in) (the |my )?(description|bio|comments)\b/, /\b(in|down in) (the |my )?description\b/,
  /\b(my|our) (own )?(website|site|web site|store|shop|merch|merchandise|patreon|discord|course|app|brand|clothing( line)?|newsletter)\b/,
  /\b[a-z0-9-]+ ?(\.|dot) ?(com|net|org|co|io|shop|store)\b/,
  /\b(use|with) (my |the )?code\b/, /\bpromo code\b/, /\b\d+ ?(%|percent) off\b/, /\bdiscount\b/, /\bfree shipping\b/,
  /\b(like and subscribe|hit (that|the) (subscribe|bell|like)|smash (that|the) like|turn on (post )?notifications)\b/,
];
const WEAK = [/\b(check (it|them|that|this) out|head (on )?over to|go (over )?to|sign up|order|buy|grab (one|yours)|support (the|my) channel|subscribe)\b/];

function sentences(words) {
  const out = []; let cur = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i]; cur.push(w); const next = words[i + 1];
    if (/[.!?]["')\]]?$/.test(String(w.w)) || !next || next.s - w.e > 0.7) { out.push(cur); cur = []; }
  }
  return out.map((ws) => ({ s: ws[0].s, e: ws[ws.length - 1].e, text: ws.map((w) => w.w).join(' ').toLowerCase() }));
}

/** [{ start, end, text }] stretches of the video that are ad reads (merged, with the sentences between two ad lines). */
function adRanges(words = []) {
  const sents = sentences(words);
  const score = sents.map((x) => STRONG.reduce((n, re) => n + (re.test(x.text) ? 2 : 0), 0) + WEAK.reduce((n, re) => n + (re.test(x.text) ? 1 : 0), 0));
  const ad = score.map((v) => v >= 2);
  // A single plain sentence between two ad lines is part of the read ("It's the best one I've used.").
  for (let i = 1; i < ad.length - 1; i++) if (!ad[i] && ad[i - 1] && ad[i + 1] && sents[i + 1].s - sents[i - 1].e < 20) ad[i] = true;
  // A weak line right next to an ad line belongs to it ("Go check it out.").
  for (let i = 0; i < ad.length; i++) if (!ad[i] && score[i] >= 1 && (ad[i - 1] || ad[i + 1])) ad[i] = true;
  const out = [];
  sents.forEach((x, i) => {
    if (!ad[i]) return; const last = out[out.length - 1];
    if (last && x.s - last.end < 3) { last.end = x.e; last.text += ` ${x.text}`; } else out.push({ start: x.s, end: x.e, text: x.text });
  });
  return out.map((r) => ({ start: Math.max(0, Math.round((r.start - 0.4) * 100) / 100), end: Math.round((r.end + 0.4) * 100) / 100, text: r.text.slice(0, 200) }));
}

module.exports = { adRanges, sentences };
