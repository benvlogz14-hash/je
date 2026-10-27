'use strict';
/**
 * Story text edits: no talking, intense music, and short lines of text that carry the story forward
 * ("Exploring in the woods is fun until...", "They even left all their cars behind...", "What was this place??"),
 * each held for a few shots, in TikTok's own plain text look (white, sentence case, soft shadow, upper third).
 * Modelled on a 6M-view exploring video. The shots, cuts and music come from brolledit (raw look, cut on the beat).
 */
const fs = require('fs');
const path = require('path');
const fontnames = require('./fontnames');

const W = 1080, H = 1920;

// When no AI is available: the arc from the reference video (hook, discovery, scale, detail, mystery, question),
// with enough of each so the edits of one video don't all say the same thing.
const HOOKS = ['Exploring places like this is fun until...', "We weren't supposed to be here...", 'Nobody comes out here anymore...', 'This place was left to rot...', 'We found a way inside...', 'Something told us to turn back...'];
const MIDDLES = ["You find something you're not supposed to...", 'Nobody has been here in years...', 'They left everything behind...', 'It was all stuck in time...',
  'It looked like everyone left in a hurry...', 'The deeper we went, the stranger it got...', 'Everything was right where they left it...', 'Then it got really quiet...',
  'Nature is taking it all back...', 'Something happened here...'];
const ENDINGS = ['What was this place??', 'Why did everyone leave??', 'Would you go inside??', 'What happened here??'];
const TEMPLATE = [HOOKS[0], ...MIDDLES.slice(0, 6), ENDINGS[0]];
function template(count, part = 0) {
  const mids = Array.from({ length: Math.max(0, count - 2) }, (_, i) => MIDDLES[(part * 3 + i) % MIDDLES.length]);
  return [HOOKS[part % HOOKS.length], ...mids, ENDINGS[part % ENDINGS.length]];
}

/**
 * The story lines for one edit: count lines, each under ~9 words, most ending in "..." and the last one a question.
 * Written from what's actually in the shots (vision descriptions) and said (transcript) in this part of the video.
 */
async function lines({ shots = [], words = [], window = null, count = 7, title = '', clientId, jobId, avoid = [], part = 0 }) {
  count = Math.max(3, Math.min(12, count));
  const inWin = (t) => !window || (t >= window[0] && t <= window[1]);
  const seen = shots.filter((x) => inWin(x.s) && x.what).map((x) => `- ${x.what}`).slice(0, 40).join('\n');
  const said = words.filter((w) => inWin(w.s)).map((w) => w.w).join(' ').slice(0, 2500);
  try {
    const ai = require('../integrations/ai');
    const r = await ai.ask({
      role: 'writing', json: true, maxTokens: 700, clientId, jobId,
      system: 'You write the on-screen text for viral TikTok exploring videos with no voiceover: short lines that pull the viewer through the story. Rules: each line is under 9 words, plain and spoken like a person ("They even left all their cars behind..."), most end with "...", the first is a hook that promises something ("Exploring in the woods is fun until..."), the lines escalate (discovery, scale, eerie details, a sense that something happened), and the last one is a question to the viewer ending in "??". Only say things the footage or what is said supports; never invent names, dates or facts. No hashtags, no emojis, no em dashes.',
      prompt: `${title ? `Video: ${title}\n` : ''}What the shots show, in order:\n${seen || '(no shot descriptions)'}\n\nWhat is said in this part (for facts only; the edit has no voice):\n${said || '(nothing said)'}\n${avoid.length ? `\nOther edits of this video already used these lines, write different ones:\n${avoid.slice(0, 30).map((l) => `- ${l}`).join('\n')}\n` : ''}\nWrite exactly ${count} lines. Return {"lines":["..."]}`,
    });
    const out = (r.json?.lines || []).map((l) => clean(l)).filter(Boolean).slice(0, count);
    if (out.length >= 3) return { lines: out, by: `${r.provider}:${r.model}` };
  } catch { /* no AI: template */ }
  return { lines: template(count, part), by: 'template' };
}

function clean(l) {
  return String(l || '').replace(/[—–]/g, ', ').replace(/#\S+/g, '').replace(/[{}\\]/g, '').replace(/\s+/g, ' ').trim().slice(0, 90);
}

/** Break a line into at most two rows of similar length (TikTok's text box wraps like this). */
function wrap(line, max = 24) {
  if (line.length <= max) return [line];
  const ws = line.split(' '); let best = null;
  for (let i = 1; i < ws.length; i++) { const a = ws.slice(0, i).join(' '), b = ws.slice(i).join(' '); const d = Math.abs(a.length - b.length); if (!best || d < best.d) best = { d, rows: [a, b] }; }
  return best ? best.rows : [line];
}

/**
 * When each line shows: the edit is split into equal parts, and each line starts on the cut nearest its part's start,
 * so the text changes together with the picture. The last line stays to the end.
 */
function timing(grid, n) {
  const total = grid.total; const cuts = [0, ...(grid.cuts || [])];
  const starts = [];
  for (let i = 0; i < n; i++) {
    const want = (i * total) / n; let best = cuts[0];
    for (const c of cuts) if (Math.abs(c - want) < Math.abs(best - want)) best = c;
    if (starts.length && best <= starts[starts.length - 1] + 1.2) best = Math.min(total - 1, starts[starts.length - 1] + Math.max(1.5, total / n));
    starts.push(best);
  }
  return starts.map((s, i) => ({ start: s, end: i < n - 1 ? starts[i + 1] : total }));
}

/** Write the ASS file with the story lines in TikTok's plain text look. Returns its path. */
function writeAss({ lines: ls, grid, file, look = {} }) {
  const family = look.font || 'TikTok Sans'; const em = look.size || 64;
  const f = fontnames.face(family, false); const fit = fontnames.emFit(family, false);
  const fs_ = Math.round(em * fit.k); const y = Math.round(H * (look.y ?? 0.27)); const lh = Math.round(em * 1.18);
  const t2 = (t) => { const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = Math.floor(t % 60), cs = Math.floor((t * 100) % 100); return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`; };
  const out = ['[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${W}`, `PlayResY: ${H}`, 'WrapStyle: 2', 'ScaledBorderAndShadow: yes', '', '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: S,${f.name},${fs_},&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,${f.bold ? -1 : 0},0,0,0,100,100,0,0,1,0,2,5,40,40,0,1`,
    '', '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text'];
  const when = timing(grid, ls.length);
  ls.forEach((line, i) => {
    const rows = wrap(line);
    rows.forEach((row, k) => {
      const yy = Math.round(y + (k - (rows.length - 1) / 2) * lh + fit.dy * em);
      // Soft shadow like TikTok's: a slightly blurred dark copy under the text, then the text.
      out.push(`Dialogue: 0,${t2(when[i].start)},${t2(when[i].end)},S,,0,0,0,,{\\an5\\pos(${W / 2 + 2},${yy + 3})\\1c&H000000&\\1a&H90&\\shad0\\blur4}${row}`);
      out.push(`Dialogue: 1,${t2(when[i].start)},${t2(when[i].end)},S,,0,0,0,,{\\an5\\pos(${W / 2},${yy})\\shad0}${row}`);
    });
  });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, out.join('\n') + '\n');
  return { file, when };
}

module.exports = { lines, writeAss, timing, wrap, TEMPLATE };
