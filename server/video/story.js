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
async function lines({ shots = [], words = [], window = null, count = 7, title = '', clientId, jobId, avoid = [], part = 0, look = 'story', beats = null }) {
  if (look === 'swag') return swagLines({ shots, words, window, title, clientId, jobId, avoid, part, beats: beats || [] });
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

function clean(l, max = 90) {
  return String(l || '').replace(/[—–]/g, ', ').replace(/#\S+/g, '').replace(/[{}\\]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * 2swag (Nov 13, from four ~64 s exploring shorts Ryan sent: "nobody can tell us what this building between the highway
 * ramps was used for", "the state bought this house for a reservoir that was never built", "the fridge light was still
 * on", "this abandoned house is worth $1,100"): no voice, music only, about 14 lines of lowercase text, one per ~4.5 s,
 * each saying what is on screen at that moment, told as "we": the place and its strangest fact, getting in, what we
 * found room by room (escalating), a fact twist, and a last question ending "??". beats: [{ start, end, what }] = the
 * picture shown when each line starts (from the edit's own shots), so every line matches its shot.
 */
const SWAG_SYSTEM = 'You write the on-screen text for viral TikTok exploring videos that have no voiceover, in one exact style. Every line is all lowercase, told by "we", plain and spoken, 6-16 words, and says what the viewer is seeing at that moment. The lines tell one story in order: (1) the place and its most surprising fact from the material (a price, a year, who owns it, why it is strange), e.g. "we found a tiny building stuck between highway ramps with no public record of what it was..."; (2) getting there and going in, e.g. "so we went inside expecting it to be empty..."; (3) what we found, escalating room by room, e.g. "even the typewriters were still sitting here", "that\'s when we found a hatch in the floor..."; (4) late in the video, a twist fact if the material has one, e.g. "it last sold in 1998 for $145,000"; (5) the last line is a question to the viewer ending in "??", e.g. "what did this place control and what\'s under that hatch??". Many lines end with "...". Only use facts that the material supports; never invent names, numbers, prices or dates (without facts, describe what is seen). No hashtags, no emojis, no em dashes, no quotes.';
const SWAG_MID = ['so we walked up to get a closer look...', 'the door was already open...', 'so we went inside expecting it to be empty...', 'but everything was still here...', 'it looked like someone just stepped out', 'nobody has touched any of this in years...', 'everything was left exactly how they left it', 'the deeper we went the stranger it got...', "that's when we found this...", 'and it was all still sitting right here...'];
const SWAG_START = ['we found a place that nobody could tell us anything about...', 'we found this place sitting completely untouched...', 'nobody has lived here in years but everything is still inside...'];
const SWAG_END = ['so what happened here and why did everyone leave??', 'who left all of this behind and why??', 'what was this place really used for??'];
async function swagLines({ shots, words, window, title, clientId, jobId, avoid, part, beats }) {
  const n = Math.max(4, Math.min(18, beats.length || 14));
  const inWin = (t) => !window || (t >= window[0] && t <= window[1]);
  const said = words.filter((w) => inWin(w.s)).map((w) => w.w).join(' ').slice(0, 3000);
  const pics = beats.length ? beats.map((b, i) => `${i + 1}. (${b.start.toFixed(1)}-${b.end.toFixed(1)} s) ${b.what || 'no description of this shot'}`).join('\n') : '';
  try {
    const ai = require('../integrations/ai');
    const r = await ai.ask({
      role: 'writing', json: true, maxTokens: 1200, clientId, jobId, system: SWAG_SYSTEM,
      prompt: `${title ? `Video: ${title}\n` : ''}What is on screen when each line starts, in order:\n${pics || '(no shot descriptions: write lines that fit an exploring walk-through)'}\n\nWhat is said in the raw footage (for facts only; the edit has no voice):\n${said || '(nothing said)'}\n${avoid.length ? `\nOther edits of this video already used these lines, write different ones:\n${avoid.slice(0, 30).map((l) => `- ${l}`).join('\n')}\n` : ''}\nWrite exactly ${n} lines, line 1 for picture 1, line 2 for picture 2, and so on. Return {"lines":["..."]}`,
    });
    const out = (r.json?.lines || []).map((l) => clean(l, 130).toLowerCase()).filter((l) => l.split(' ').length >= 3).slice(0, n);
    if (out.length >= Math.min(n, 4)) {
      if (!/\?\?$/.test(out[out.length - 1])) out[out.length - 1] = out[out.length - 1].replace(/[.!?,]*$/, '??');
      return { lines: out, by: `${r.provider}:${r.model}` };
    }
  } catch { /* no AI: built from the shot descriptions */ }
  // No AI: the same arc, using what each shot shows when it's described.
  const see = (b) => String(b?.what || '').toLowerCase().replace(/[.!?]+$/, '').replace(/^(a|an|the) /, (m) => m).trim();
  const out = [SWAG_START[part % SWAG_START.length]];
  for (let i = 1; i < n - 1; i++) { const w = see(beats[i]); out.push(w && i % 2 === 0 ? `then we found ${w}...` : SWAG_MID[(part * 3 + i - 1) % SWAG_MID.length]); }
  out.push(SWAG_END[part % SWAG_END.length]);
  return { lines: out, by: 'template' };
}

/** Break a line into at most two rows of similar length (TikTok's text box wraps like this). */
function wrap(line, max = 24, rows = 2) {
  if (line.length <= max) return [line];
  const ws = line.split(' '); let best = null;
  for (let i = 1; i < ws.length; i++) { const a = ws.slice(0, i).join(' '), b = ws.slice(i).join(' '); const d = Math.abs(a.length - b.length); if (!best || d < best.d) best = { d, rows: [a, b] }; }
  // Three rows for long lines (2swag): fill rows up to max characters, like TikTok's text box.
  if (rows >= 3 && best && Math.max(...best.rows.map((r) => r.length)) > max * 1.15) {
    const out = []; let cur = '';
    for (const w of ws) { if (cur && (cur + ' ' + w).length > max && out.length < rows - 1) { out.push(cur); cur = w; } else cur = cur ? `${cur} ${w}` : w; }
    if (cur) out.push(cur); return out;
  }
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
function writeAss({ lines: ls, grid, file, look = {}, when: given = null }) {
  const family = look.font || 'TikTok Sans'; const em = look.size || 64;
  const f = fontnames.face(family, false); const fit = fontnames.emFit(family, false);
  const fs_ = Math.round(em * fit.k); const y = Math.round(H * (look.y ?? 0.27)); const lh = Math.round(em * (look.lineHeight || 1.18));
  const t2 = (t) => { const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = Math.floor(t % 60), cs = Math.floor((t * 100) % 100); return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`; };
  const out = ['[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${W}`, `PlayResY: ${H}`, 'WrapStyle: 2', 'ScaledBorderAndShadow: yes', '', '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: S,${f.name},${fs_},&H00FFFFFF,&H00FFFFFF,${look.edge ? '&H70000000' : '&H00000000'},&H64000000,${f.bold ? -1 : 0},0,0,0,100,100,0,0,1,${look.edge || 0},2,5,40,40,0,1`, // edge: 2swag's thin dark rim
    '', '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text'];
  const when = given && given.length === ls.length ? given : timing(grid, ls.length);
  ls.forEach((line, i) => {
    const rows = wrap(look.lower ? line.toLowerCase() : line, look.max || 24, look.rows || 2);
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

/** 2swag's text: TikTok's plain text, lowercase, just below the middle, up to three rows (measured on the references). */
const SWAG_LOOK = { font: 'TikTok Sans', size: 70, y: 0.622, lineHeight: 1.18, max: 30, rows: 3, lower: true, edge: 2.2 };

module.exports = { lines, swagLines, writeAss, timing, wrap, TEMPLATE, SWAG_LOOK };
