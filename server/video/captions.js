'use strict';
/** Caption generation: word-timed ASS subtitles (with active-word highlight) and SRT for Premiere. */

// Fonts with a real bold/black weight; the others are drawn at their own weight (libass would fake-bold them).
const HEAVY = new Set(['Montserrat', 'Poppins', 'Kanit', 'Barlow Condensed', 'Titillium Web', 'Passion One', 'Playfair Display SC', 'Kalam', 'Silkscreen', 'Arial', 'Verdana', 'Georgia', 'Trebuchet MS', 'Comic Sans MS']);
// Bundled fonts are asked for by their own full name (see fontnames.js), so a same-named Windows font never replaces them.
const fontnames = require('./fontnames');
const face = (font, want = true) => fontnames.face(font, want && HEAVY.has(font));
const boldFlag = (font, want = true) => face(font, want).bold;
const fontName = (font, want = true) => face(font, want).name.replace(/,/g, ' ');

const DEFAULT_STYLE = {
  preset: 'clean-pop',
  font: 'Montserrat',
  fallbackFont: 'Arial',
  size: 84,
  bold: true,
  uppercase: true,
  wordsPerLine: 3,
  primary: '#FFFFFF',
  highlight: '#F2C14E',
  outline: '#111111',
  outlineWidth: 7,
  shadow: 0,
  position: 'lower',     // 'lower' | 'center' | 'upper'
  animation: 'pop',      // 'pop' | 'none'
  highlightMode: 'word', // 'word' | 'none'
  box: false,
  hook: true,            // show the hook headline for the first seconds
  hookSeconds: 3.2,
  hookBg: '#FFFFFF',
  hookColor: '#111111',
  // The opening text has its own look; empty font / size means "same as the captions".
  hookFont: '',
  hookSize: 0,
  hookPosition: 'upper', // 'upper' | 'center' | 'lower'
  hookBox: true,         // solid box behind it (hookBg); off = outlined text like the captions
  hookOutline: '#111111',
  hookOutlineWidth: 8,
  hookTilt: 0,           // degrees, a little tilt reads as playful
  hookAnim: 'fade',      // 'fade' | 'pop'
  hookText: '',          // what the banner says; empty = the clip's hook
  hookUpper: false,      // banner in CAPITALS (off = exactly as typed)
  rotate: 0,             // caption tilt in degrees
  punctuation: false,    // keep commas/periods in captions
};

const PRESETS = {
  'clean-pop': {},
  'boxed': { box: true, primary: '#111111', highlight: '#2E7D74', outline: '#FFFFFF', outlineWidth: 14, uppercase: false, size: 70 },
  'minimal': { uppercase: false, highlightMode: 'none', animation: 'none', size: 66, outlineWidth: 4, wordsPerLine: 5 },
  'news': { uppercase: true, highlight: '#E07A5F', wordsPerLine: 4, size: 72, position: 'lower' },
  'karaoke-teal': { highlight: '#6CC3B8', wordsPerLine: 2, size: 96 },
  // Bold cartoon looks, like big YouTube channels.
  'cartoon': { font: 'Luckiest Guy', size: 96, highlight: '#FFD23F', outline: '#000000', outlineWidth: 9, shadow: 5, wordsPerLine: 2, hookFont: 'Luckiest Guy', hookBox: false, hookColor: '#FFFFFF', hookOutline: '#000000', hookTilt: -4, hookAnim: 'pop' },
  'comic': { font: 'Bangers', size: 104, highlight: '#FF4D6D', outline: '#000000', outlineWidth: 8, shadow: 4, wordsPerLine: 3, hookFont: 'Bangers', hookBg: '#FFD23F', hookColor: '#000000', hookTilt: -3, hookAnim: 'pop' },
  'bubbly': { font: 'Titan One', size: 88, highlight: '#5CE1E6', outline: '#1B1B3A', outlineWidth: 10, shadow: 4, wordsPerLine: 2, uppercase: false, hookFont: 'Titan One', hookBg: '#FF8FB1', hookColor: '#FFFFFF', hookAnim: 'pop' },
};

function resolveStyle(s) { const base = { ...DEFAULT_STYLE, ...(PRESETS[s?.preset] || {}) }; return { ...base, ...(s || {}) }; }

function assColor(hex, alpha = 0) {
  const h = String(hex || '#FFFFFF').replace('#', '').padEnd(6, '0');
  const r = h.slice(0, 2), g = h.slice(2, 4), b = h.slice(4, 6);
  return `&H${alpha.toString(16).padStart(2, '0').toUpperCase()}${b}${g}${r}`.toUpperCase();
}
function assTime(t) {
  t = Math.max(0, t);
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = Math.floor(t % 60), cs = Math.floor((t * 100) % 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}
function clean(w, style) {
  let s = String(w).replace(/[{}\\]/g, '').trim();
  if (!style.punctuation) s = s.replace(/^[^\w'$%#@]+|[^\w'$%!?]+$/g, '');
  return style.uppercase ? s.toUpperCase() : s;
}

/** Group words (clip-relative times) into on-screen lines. */
function chunkWords(words, style) {
  const chunks = []; let cur = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i]; const prev = words[i - 1];
    const gap = prev ? w.s - prev.e : 0;
    if (cur.length && (cur.length >= style.wordsPerLine || gap > 0.65 || /[.!?]$/.test(prev?.w || ''))) { chunks.push(cur); cur = []; }
    cur.push(w);
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

/**
 * Build an ASS subtitle file for a vertical short.
 * @param words  [{w,s,e}] absolute source times
 * @param range  {start,end} absolute source range of the clip
 */
const DEFAULT_GRAPHICS = {
  lowerThird: { enabled: false, name: '', title: '', seconds: 4 },
  endCard: { enabled: false, text: 'Follow for more', seconds: 2.5 },
  progressBar: { enabled: false, color: '#6CC3B8' },
  logo: { position: 'top-right', size: 150, opacity: 0.9 },
};
function resolveGraphics(g) {
  const d = DEFAULT_GRAPHICS; g = g || {};
  return { lowerThird: { ...d.lowerThird, ...(g.lowerThird || {}) }, endCard: { ...d.endCard, ...(g.endCard || {}) }, progressBar: { ...d.progressBar, ...(g.progressBar || {}) }, logo: { ...d.logo, ...(g.logo || {}) } };
}

// Words that make good highlights: numbers and money, names, and longer strong words (never filler).
const STOP = new Set('the a an and or but so to of in on at for with from by is are was were be been being it its this that these those there here they them we our you your i me my he she his her him as if then than just like really very kind sort get got going gonna want wanna about into out up down over under again also only even still yeah okay um uh well right know think thing things some any all every what when where which who whom why how can could would should will shall may might must do does did done have has had not no yes one two'.split(' '));
function autoKeywords(words, every = 4) {
  const norm = (w) => String(w).toLowerCase().replace(/[^a-z0-9$%']/g, '');
  const freq = {}; for (const w of words) { const k = norm(w.w); if (k) freq[k] = (freq[k] || 0) + 1; }
  const score = (w) => { const k = norm(w.w); const raw = String(w.w); if (!k || STOP.has(k)) return 0; let v = 0; if (/\d|\$|%/.test(raw)) v += 5; if (/^[A-Z][a-z]/.test(raw)) v += 2; if (k.length >= 6) v += 2 + Math.min(3, k.length - 6) * 0.5; if (/(est|ion|ous|ful|ive)$/.test(k)) v += 1; return v - Math.max(0, (freq[k] || 1) - 2) * 0.5; };
  const picked = new Set();
  for (let i = 0; i < words.length; i += every) { const win = words.slice(i, i + every); const best = win.reduce((b, w) => (score(w) > (b ? score(b) : 0) ? w : b), null); if (best && score(best) >= 2) picked.add(norm(best.w)); }
  return [...picked];
}

function buildAss({ words = [], range, style: st, hook, graphics, width = 1080, height = 1920, keywords = null }) {
  const gr = resolveGraphics(graphics);
  const style = resolveStyle(st);
  const align = style.position === 'upper' ? 8 : style.position === 'center' ? 5 : 2;
  const marginV = style.position === 'center' ? 0 : style.position === 'upper' ? Math.round(height * 0.16) : Math.round(height * 0.2);
  const borderStyle = style.box ? 3 : 1;
  const font = style.font || style.fallbackFont;
  const hookFont = style.hookFont || font;
  const hookSize = Math.round(style.hookSize || style.size * 0.72);
  const hookAlign = style.hookPosition === 'lower' ? 2 : style.hookPosition === 'center' ? 5 : 8;
  const hookMarginV = style.hookPosition === 'center' ? 0 : style.hookPosition === 'lower' ? Math.round(height * 0.2) : Math.round(height * 0.11);
  const hookLook = style.hookBox
    ? `${assColor(style.hookColor)},${assColor(style.hookColor)},${assColor(style.hookBg)},${assColor(style.hookBg)},${boldFlag(hookFont)},0,0,0,100,100,0,${-(style.hookTilt || 0)},3,18,0`
    : `${assColor(style.hookColor)},${assColor(style.hookColor)},${assColor(style.hookOutline)},${assColor('#000000', 0x70)},${boldFlag(hookFont)},0,0,0,100,100,1,${-(style.hookTilt || 0)},1,${style.hookOutlineWidth},${style.shadow || 0}`;
  const lines = [
    '[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${width}`, `PlayResY: ${height}`, 'WrapStyle: 2', 'ScaledBorderAndShadow: yes', 'YCbCr Matrix: TV.709', '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Caption,${fontName(font, style.bold)},${style.size},${assColor(style.primary)},${assColor(style.highlight)},${assColor(style.outline)},${assColor('#000000', 0x80)},${boldFlag(font, style.bold)},0,0,0,100,100,1,${-(style.rotate || 0)},${borderStyle},${style.outlineWidth},${style.shadow},${align},80,80,${marginV},1`,
    `Style: Hook,${fontName(hookFont)},${hookSize},${hookLook},${hookAlign},90,90,${hookMarginV},1`,
    `Style: LowerName,${fontName(font)},${Math.round(height * 0.03)},${assColor('#FFFFFF')},${assColor('#FFFFFF')},${assColor('#15181B', 0x20)},${assColor('#15181B', 0x20)},${boldFlag(font)},0,0,0,100,100,0,0,3,16,0,7,0,0,0,1`,
    `Style: LowerTitle,${fontName(font)},${Math.round(height * 0.021)},${assColor('#15181B')},${assColor('#15181B')},${assColor(style.highlight)},${assColor(style.highlight)},${boldFlag(font)},0,0,0,100,100,0,0,3,12,0,7,0,0,0,1`,
    `Style: EndCard,${fontName(font)},${Math.round(style.size * 0.9)},${assColor(style.hookColor)},${assColor(style.hookColor)},${assColor(style.hookBg)},${assColor(style.hookBg)},${boldFlag(font)},0,0,0,100,100,0,0,3,26,0,5,90,90,0,1`,
    '', '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];
  const dur = range.end - range.start;
  const esc = (t) => String(t || '').replace(/[{}\\]/g, '').trim();
  // Client graphics template: lower third (name + title) and closing end card.
  if (gr.lowerThird.enabled && gr.lowerThird.name) {
    const s0 = Math.min(dur, (hook && style.hook ? style.hookSeconds : 0) + 0.3), s1 = Math.min(dur, s0 + gr.lowerThird.seconds);
    const x = Math.round(width * 0.07), y = Math.round(height * 0.6);
    lines.push(`Dialogue: 2,${assTime(s0)},${assTime(s1)},LowerName,,0,0,0,,{\\pos(${x},${y})\\fad(160,200)}${esc(gr.lowerThird.name)}`);
    if (gr.lowerThird.title) lines.push(`Dialogue: 2,${assTime(s0 + 0.12)},${assTime(s1)},LowerTitle,,0,0,0,,{\\pos(${x},${y + Math.round(height * 0.046)})\\fad(160,200)}${esc(gr.lowerThird.title)}`);
  }
  if (gr.endCard.enabled && gr.endCard.text && dur > gr.endCard.seconds + 2) {
    lines.push(`Dialogue: 3,${assTime(dur - gr.endCard.seconds)},${assTime(dur)},EndCard,,0,0,0,,{\\pos(${width / 2},${Math.round(height * 0.42)})\\fad(220,0)\\fscx90\\fscy90\\t(0,180,\\fscx100\\fscy100)}${esc(gr.endCard.text)}`);
  }
  hook = String(style.hookText || '').trim() || hook;
  if (hook && style.hook) {
    const ht = String(hook).replace(/[{}\\]/g, '').trim().replace(/\s*\n\s*/g, '\\N');
    const anim = style.hookAnim === 'pop' ? '\\fad(0,180)\\fscx20\\fscy20\\t(0,140,\\fscx115\\fscy115)\\t(140,240,\\fscx100\\fscy100)' : '\\fad(120,180)';
    lines.push(`Dialogue: 1,${assTime(0)},${assTime(Math.min(style.hookSeconds, dur))},Hook,,0,0,0,,{${anim}}${style.hookUpper ? ht.toUpperCase() : ht}`);
  }
  const local = words.filter((w) => w.e > range.start && w.s < range.end)
    .map((w) => ({ w: w.w, s: Math.max(0, w.s - range.start), e: Math.min(dur, w.e - range.start) }))
    .filter((w) => clean(w.w, style));
  const hl = assColor(style.highlight);
  // Keyword mode: chosen (or auto-picked) words stay in the highlight colour the whole time they're on screen.
  const keyNorm = (w) => String(w).toLowerCase().replace(/[^a-z0-9$%']/g, '');
  const keys = style.highlightMode === 'keywords' ? new Set((keywords && keywords.length ? keywords : autoKeywords(local)).map(keyNorm)) : null;
  for (const chunk of chunkWords(local, style)) {
    const cStart = chunk[0].s, cEnd = Math.max(chunk[chunk.length - 1].e, cStart + 0.25);
    const texts = chunk.map((w) => clean(w.w, style));
    if (style.highlightMode !== 'word') {
      const pop = style.animation === 'pop' ? '{\\fscx92\\fscy92\\t(0,90,\\fscx100\\fscy100)}' : '';
      const shown = keys ? texts.map((t, j) => (keys.has(keyNorm(chunk[j].w)) ? `{\\c${hl}}${t}{\\c${assColor(style.primary)}}` : t)) : texts;
      lines.push(`Dialogue: 0,${assTime(cStart)},${assTime(cEnd)},Caption,,0,0,0,,${pop}${shown.join(' ')}`);
      continue;
    }
    for (let i = 0; i < chunk.length; i++) {
      const s = i === 0 ? cStart : chunk[i].s;
      const e = i < chunk.length - 1 ? chunk[i + 1].s : cEnd;
      if (e - s < 0.01) continue;
      const text = texts.map((t, j) => {
        if (j !== i) return t;
        const pop = style.animation === 'pop' ? '\\fscx112\\fscy112\\t(0,80,\\fscx100\\fscy100)' : '';
        return `{\\c${hl}${pop}}${t}{\\r}`;
      }).join(' ');
      lines.push(`Dialogue: 0,${assTime(s)},${assTime(e)},Caption,,0,0,0,,${text}`);
    }
  }
  return lines.join('\n') + '\n';
}

function srtTime(t) {
  t = Math.max(0, t);
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = Math.floor(t % 60), ms = Math.round((t % 1) * 1000) % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

function buildSrt({ words = [], range, style: st }) {
  const style = resolveStyle(st);
  const dur = range.end - range.start;
  const local = words.filter((w) => w.e > range.start && w.s < range.end).map((w) => ({ w: w.w, s: Math.max(0, w.s - range.start), e: Math.min(dur, w.e - range.start) })).filter((w) => clean(w.w, style));
  return chunkWords(local, style).map((c, i) => `${i + 1}\n${srtTime(c[0].s)} --> ${srtTime(c[c.length - 1].e)}\n${c.map((w) => clean(w.w, style)).join(' ')}\n`).join('\n');
}

/** Caption chunks with clip-relative times; used for Velo text clips and the Studio caption track. */
function captionChunks({ words = [], range, style: st }) {
  const style = resolveStyle(st);
  const dur = range.end - range.start;
  const local = words.filter((w) => w.e > range.start && w.s < range.end).map((w) => ({ w: w.w, s: Math.max(0, w.s - range.start), e: Math.min(dur, w.e - range.start) })).filter((w) => clean(w.w, style));
  return chunkWords(local, style).map((c) => ({ start: c[0].s, end: Math.max(c[c.length - 1].e, c[0].s + 0.25), text: c.map((w) => clean(w.w, style)).join(' '),
    words: c.map((w) => ({ w: clean(w.w, style), s: Math.round((w.s - c[0].s) * 1000) / 1000, e: Math.round((w.e - c[0].s) * 1000) / 1000 })) }));
}

module.exports = { autoKeywords, HEAVY, DEFAULT_STYLE, DEFAULT_GRAPHICS, PRESETS, resolveStyle, resolveGraphics, buildAss, buildSrt, captionChunks, assColor };
