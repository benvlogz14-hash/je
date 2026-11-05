'use strict';
/**
 * Looks for the pro political ads: everything about how an ad looks and moves, separate from what it says.
 *
 *   preset ("bold", "cinematic", ...)  ─┐
 *   a typed prompt ("dark and gritty") ─┼─▶ look (validated) ─▶ remotion/PoliticalAd.jsx draws it
 *   a video's style recipe (reverse.js) ┘
 *
 * A look is plain data with a fixed set of options (layout, colours, fonts, headline and caption styles, transitions,
 * grade, texture, motion). The AI may only pick from those options and real hex colours and bundled fonts, so any prompt
 * gives a look that renders; `normalize` fixes anything else and makes sure text stays readable on its colour.
 */
const ai = require('../integrations/ai');

/** Bundled fonts the ads may use (family → file in server/video/fonts). */
const FONTS = {
  Anton: 'Anton_400Regular.ttf', 'Bebas Neue': 'BebasNeue-Regular.ttf', 'Barlow Condensed': 'BarlowCondensed-Black.ttf', Staatliches: 'Staatliches-Regular.ttf',
  Montserrat: 'Montserrat_800ExtraBold.ttf', Inter: 'Inter-ExtraBold.ttf', Poppins: 'Poppins-Black.ttf', 'Archivo Black': 'ArchivoBlack-Regular.ttf', Kanit: 'Kanit-Black.ttf',
  'TikTok Sans': 'TikTokSans-ExtraBold.ttf', 'Titillium Web': 'TitilliumWeb-Black.ttf', 'Russo One': 'RussoOne-Regular.ttf', 'Passion One': 'PassionOne-Black.ttf',
  'Playfair Display SC': 'PlayfairDisplaySC-Black.ttf', 'DM Serif Display': 'DMSerifDisplay-Regular.ttf', 'Abril Fatface': 'AbrilFatface-Regular.ttf', 'Alfa Slab One': 'AlfaSlabOne-Regular.ttf', 'Gravitas One': 'GravitasOne.ttf',
  'Permanent Marker': 'PermanentMarker-Regular.ttf', 'Caveat Brush': 'CaveatBrush-Regular.ttf', Kalam: 'Kalam-Bold.ttf', 'Special Elite': 'SpecialElite-Regular.ttf',
  'Lilita One': 'LilitaOne-Regular.ttf', 'Titan One': 'TitanOne-Regular.ttf', 'Luckiest Guy': 'LuckiestGuy-Regular.ttf', Bungee: 'Bungee-Regular.ttf', 'Black Ops One': 'BlackOpsOne-Regular.ttf',
  'Dela Gothic One': 'DelaGothicOne-Regular.ttf', 'Rubik Mono One': 'RubikMonoOne-Regular.ttf', VT323: 'VT323-Regular.ttf',
};

const OPTIONS = {
  layout: ['card', 'frame', 'full', 'letterbox'], // tilted card over colour | straight framed card | full-screen footage | cinematic bars
  headPos: ['top', 'bottom'], headCase: ['upper', 'none'], headAlign: ['center', 'left'],
  keyStyle: ['box', 'underline', 'color', 'highlight', 'circle', 'sticker'], reveal: ['word', 'line', 'type', 'fade', 'blur'],
  flair: ['bold', 'cinematic', 'clean', 'news', 'grassroots', 'tiktok', 'patriotic', 'dark', 'bright', 'none'],
  capStyle: ['box', 'color', 'plain', 'underline', 'none'], capPos: ['card', 'low', 'center'], capCase: ['upper', 'none'],
  transition: ['wipe', 'cut', 'fade', 'flash', 'slide', 'zoom'],
  grade: ['none', 'warm', 'cool', 'bw', 'film', 'punchy', 'dark'], texture: ['none', 'grain', 'paper', 'halftone', 'scanlines', 'stripes'],
  plate: ['box', 'bar', 'minimal', 'none'], pill: ['tag', 'tape', 'none'], end: ['split', 'solid', 'stripes'], motion: ['snappy', 'smooth', 'calm'],
};

/** The reference ad (Larinda Hooks): the default. Other presets only list what differs. */
const BOLD = {
  name: 'Bold blocks', layout: 'card', colors: { a: '#1f2b6e', b: '#f6c431', c: '#ef5a3a' }, light: '#ffffff', dark: '#111522',
  fonts: { head: 'Anton', body: 'Montserrat', cap: 'Anton' },
  head: { pos: 'top', case: 'upper', align: 'center', keyStyle: 'box', reveal: 'word', scale: 1 },
  cap: { style: 'box', pos: 'card', case: 'upper', scale: 1 },
  card: { tilt: true, border: 12, radius: 0, block: true, shadow: true, borderColor: '#ffffff' },
  transition: 'wipe', grade: 'none', texture: 'none', plate: 'box', pill: 'tag', badge: true, end: 'split', motion: 'snappy', punch: false, ticker: false, flair: 'bold',
};

const PRESETS = {
  bold: { ...BOLD, about: 'The reference ad: navy, yellow and red blocks, tilted footage card, boxed key words' },
  cinematic: {
    flair: 'cinematic', name: 'Cinematic', about: 'Film look: black bars, serif headlines, slow fades, warm film grade, grain', layout: 'letterbox', colors: { a: '#0b0b0d', b: '#14110e', c: '#0b0b0d' }, light: '#f4efe6', dark: '#0b0b0d',
    fonts: { head: 'DM Serif Display', body: 'Montserrat', cap: 'Inter' }, head: { pos: 'top', case: 'none', align: 'center', keyStyle: 'color', reveal: 'blur', scale: 0.85 },
    cap: { style: 'plain', pos: 'low', case: 'none', scale: 0.7 }, card: { tilt: false, border: 0, radius: 0, block: false, shadow: false }, accent: '#d9a441',
    transition: 'fade', grade: 'film', texture: 'grain', plate: 'minimal', pill: 'none', badge: false, end: 'solid', motion: 'calm',
  },
  clean: {
    flair: 'clean', name: 'Clean and modern', about: 'White background, rounded footage, one blue accent, calm motion', layout: 'frame', colors: { a: '#ffffff', b: '#eef3ff', c: '#ffffff' }, light: '#ffffff', dark: '#0e1a3a',
    fonts: { head: 'Inter', body: 'Inter', cap: 'Inter' }, head: { pos: 'top', case: 'none', align: 'left', keyStyle: 'underline', reveal: 'word', scale: 0.82 },
    cap: { style: 'color', pos: 'card', case: 'none', scale: 0.8 }, card: { tilt: false, border: 0, radius: 36, block: false, shadow: true }, accent: '#2f5bff',
    transition: 'slide', grade: 'none', texture: 'none', plate: 'bar', pill: 'tag', badge: false, end: 'solid', motion: 'smooth',
  },
  news: {
    flair: 'news', name: 'Breaking news', about: 'Red, black and white bars, a scrolling ticker, hard cuts, flashes', layout: 'frame', colors: { a: '#0d0d10', b: '#c8102e', c: '#0d0d10' }, light: '#ffffff', dark: '#0d0d10',
    fonts: { head: 'Barlow Condensed', body: 'Inter', cap: 'Barlow Condensed' }, head: { pos: 'bottom', case: 'upper', align: 'left', keyStyle: 'box', reveal: 'line', scale: 0.9 },
    cap: { style: 'box', pos: 'card', case: 'upper', scale: 0.85 }, card: { tilt: false, border: 6, radius: 0, block: false, shadow: false, borderColor: '#ffffff' }, accent: '#c8102e',
    transition: 'flash', grade: 'punchy', texture: 'none', plate: 'bar', pill: 'tag', badge: false, end: 'solid', motion: 'snappy', ticker: true,
  },
  grassroots: {
    flair: 'grassroots', name: 'Grassroots', about: 'Kraft paper, marker headlines, taped photo, hand-made feel', layout: 'card', colors: { a: '#efe6d2', b: '#e8dcc0', c: '#f3ead8' }, light: '#fffaf0', dark: '#1d2a44',
    fonts: { head: 'Permanent Marker', body: 'Kalam', cap: 'Permanent Marker' }, head: { pos: 'top', case: 'none', align: 'center', keyStyle: 'circle', reveal: 'word', scale: 0.9 },
    cap: { style: 'color', pos: 'card', case: 'none', scale: 0.85 }, card: { tilt: true, border: 18, radius: 2, block: false, shadow: true, borderColor: '#ffffff' }, accent: '#d6452b',
    transition: 'slide', grade: 'warm', texture: 'paper', plate: 'minimal', pill: 'tape', badge: false, end: 'solid', motion: 'smooth',
  },
  tiktok: {
    flair: 'tiktok', name: 'Full-screen TikTok', about: 'Footage fills the screen, giant captions in the middle, zoom punches on key words', layout: 'full', colors: { a: '#111111', b: '#ffde21', c: '#ff3b5c' }, light: '#ffffff', dark: '#000000',
    fonts: { head: 'TikTok Sans', body: 'TikTok Sans', cap: 'TikTok Sans' }, head: { pos: 'top', case: 'none', align: 'center', keyStyle: 'color', reveal: 'line', scale: 0.72 },
    cap: { style: 'color', pos: 'center', case: 'none', scale: 1.15 }, card: { tilt: false, border: 0, radius: 0, block: false, shadow: false }, accent: '#ffde21',
    transition: 'zoom', grade: 'punchy', texture: 'none', plate: 'minimal', pill: 'none', badge: false, end: 'solid', motion: 'snappy', punch: true,
  },
  patriotic: {
    flair: 'patriotic', name: 'Red, white and blue', about: 'Classic campaign: navy and red, serif caps, flag stripes on the end card', layout: 'frame', colors: { a: '#14234b', b: '#ffffff', c: '#b3192e' }, light: '#ffffff', dark: '#14234b',
    fonts: { head: 'Playfair Display SC', body: 'Montserrat', cap: 'Montserrat' }, head: { pos: 'top', case: 'none', align: 'center', keyStyle: 'color', reveal: 'line', scale: 0.85 },
    cap: { style: 'color', pos: 'card', case: 'upper', scale: 0.75 }, card: { tilt: false, border: 10, radius: 0, block: false, shadow: true, borderColor: '#ffffff' }, accent: '#b3192e',
    transition: 'fade', grade: 'none', texture: 'none', plate: 'bar', pill: 'tag', badge: true, end: 'stripes', motion: 'smooth',
  },
  dark: {
    flair: 'dark', name: 'Dark and urgent', about: 'Black and red, black-and-white footage, grain, hard cuts (contrast-ad energy)', layout: 'full', colors: { a: '#0a0a0a', b: '#a10f0f', c: '#0a0a0a' }, light: '#ffffff', dark: '#0a0a0a',
    fonts: { head: 'Bebas Neue', body: 'Inter', cap: 'Bebas Neue' }, head: { pos: 'top', case: 'upper', align: 'center', keyStyle: 'box', reveal: 'word', scale: 1 },
    cap: { style: 'box', pos: 'center', case: 'upper', scale: 1 }, card: { tilt: false, border: 0, radius: 0, block: false, shadow: false }, accent: '#e01e1e',
    transition: 'flash', grade: 'bw', texture: 'grain', plate: 'bar', pill: 'none', badge: false, end: 'solid', motion: 'snappy', punch: true,
  },
  bright: {
    flair: 'bright', name: 'Bright and poppy', about: 'Pastel colours, rounded bubbly type, bouncy motion', layout: 'card', colors: { a: '#ffd6e8', b: '#c9f2ff', c: '#fff1b8' }, light: '#ffffff', dark: '#2b1f5c',
    fonts: { head: 'Lilita One', body: 'Poppins', cap: 'Lilita One' }, head: { pos: 'top', case: 'none', align: 'center', keyStyle: 'sticker', reveal: 'word', scale: 0.95 },
    cap: { style: 'box', pos: 'card', case: 'none', scale: 0.9 }, card: { tilt: true, border: 14, radius: 28, block: true, shadow: true, borderColor: '#ffffff' }, accent: '#7b5cff',
    transition: 'slide', grade: 'punchy', texture: 'halftone', plate: 'box', pill: 'tag', badge: false, end: 'split', motion: 'snappy',
  },
};

// ------------------------------------------------------------------ colours

const HEX = /^#([0-9a-f]{6})$/i;
const hex = (x, d) => { const s = String(x || '').trim(); if (HEX.test(s)) return s.toLowerCase(); if (/^#[0-9a-f]{3}$/i.test(s)) return `#${s.slice(1).split('').map((c) => c + c).join('')}`.toLowerCase(); return d; };
function lum(h) { const n = parseInt(h.slice(1), 16); const c = [n >> 16, (n >> 8) & 255, n & 255].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; }
const contrast = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
/** The more readable of two text colours on a background. */
// Big display text: the first choice wins when it reaches 3:1 (WCAG large text), else the most readable.
const readable = (bg, ...opts) => (contrast(bg, opts[0]) >= 3 ? opts[0] : opts.reduce((best, o) => (contrast(bg, o) > contrast(bg, best) ? o : best), opts[0]));

/** Colours for each section (a / b / c): background, text, key-word box, the block behind the card, captions' spoken word, plate. */
function sections(L) {
  const { a, b, c } = L.colors; const light = L.light; const dark = L.dark;
  const acc = L.accent || c;
  const mk = (bg, block, key) => {
    const text = readable(bg, light, dark);
    const k = contrast(key, bg) >= 1.6 ? key : contrast(acc, bg) >= 1.6 ? acc : readable(bg, dark, light);
    const blk = contrast(block, bg) >= 1.25 ? block : contrast(acc, bg) >= 1.25 ? acc : readable(bg, dark, light);
    return { bg, text, block: blk, key: k, keyText: readable(k, light, dark), capKey: acc, plate: dark, plateText: readable(dark, light, '#ffffff'), plateEdge: contrast(b, dark) > 2.5 ? b : acc, accent: contrast(acc, bg) >= 1.6 ? acc : k };
  };
  return { a: mk(a, b, c), b: mk(b, c, a), c: mk(c, a, a) };
}

// ------------------------------------------------------------------ validation

const pick = (v, list, d) => (list.includes(v) ? v : d);
const num = (v, a, b, d) => (Number.isFinite(Number(v)) ? Math.max(a, Math.min(b, Number(v))) : d);
const font = (f, d) => { const k = Object.keys(FONTS).find((x) => x.toLowerCase() === String(f || '').toLowerCase().trim()); return k || d; };

/** Any look-like object → a complete, safe look (missing or unknown values come from the base preset). */
function normalize(x = {}, base = BOLD) {
  const B = { ...BOLD, ...base, head: { ...BOLD.head, ...(base.head || {}) }, cap: { ...BOLD.cap, ...(base.cap || {}) }, card: { ...BOLD.card, ...(base.card || {}) }, fonts: { ...BOLD.fonts, ...(base.fonts || {}) }, colors: { ...BOLD.colors, ...(base.colors || {}) } };
  const h = x.head || {}; const cp = x.cap || {}; const cd = x.card || {}; const f = x.fonts || {}; const col = x.colors || {};
  const L = {
    name: String(x.name || B.name).slice(0, 40), about: String(x.about || B.about || '').slice(0, 160),
    layout: pick(x.layout, OPTIONS.layout, B.layout),
    colors: { a: hex(col.a, B.colors.a), b: hex(col.b, B.colors.b), c: hex(col.c, B.colors.c) },
    light: hex(x.light, B.light), dark: hex(x.dark, B.dark), accent: hex(x.accent, B.accent || null),
    fonts: { head: font(f.head, B.fonts.head), body: font(f.body, B.fonts.body), cap: font(f.cap, B.fonts.cap) },
    head: { pos: pick(h.pos, OPTIONS.headPos, B.head.pos), case: pick(h.case, OPTIONS.headCase, B.head.case), align: pick(h.align, OPTIONS.headAlign, B.head.align), keyStyle: pick(h.keyStyle, OPTIONS.keyStyle, B.head.keyStyle), reveal: pick(h.reveal, OPTIONS.reveal, B.head.reveal), scale: num(h.scale, 0.6, 1.3, B.head.scale) },
    cap: { style: pick(cp.style, OPTIONS.capStyle, B.cap.style), pos: pick(cp.pos, OPTIONS.capPos, B.cap.pos), case: pick(cp.case, OPTIONS.capCase, B.cap.case), scale: num(cp.scale, 0.5, 1.4, B.cap.scale) },
    card: { tilt: cd.tilt != null ? !!cd.tilt : B.card.tilt, border: num(cd.border, 0, 30, B.card.border), radius: num(cd.radius, 0, 60, B.card.radius), block: cd.block != null ? !!cd.block : B.card.block, shadow: cd.shadow != null ? !!cd.shadow : B.card.shadow, borderColor: hex(cd.borderColor, B.card.borderColor || '#ffffff') },
    transition: pick(x.transition, OPTIONS.transition, B.transition), grade: pick(x.grade, OPTIONS.grade, B.grade), texture: pick(x.texture, OPTIONS.texture, B.texture),
    plate: pick(x.plate, OPTIONS.plate, B.plate), pill: pick(x.pill, OPTIONS.pill, B.pill), badge: x.badge != null ? !!x.badge : !!B.badge, end: pick(x.end, OPTIONS.end, B.end),
    motion: pick(x.motion, OPTIONS.motion, B.motion), flair: pick(x.flair, OPTIONS.flair, B.flair || 'none'), punch: x.punch != null ? !!x.punch : !!B.punch, ticker: x.ticker != null ? !!x.ticker : !!B.ticker,
  };
  // Full-screen and letterbox footage can't tilt or sit on a block; the cap position must exist in that layout.
  if (L.layout === 'full' || L.layout === 'letterbox') { L.card = { ...L.card, tilt: false, block: false, border: 0, radius: 0 }; L.badge = false; }
  if (L.layout === 'full' && L.cap.pos === 'card') L.cap.pos = 'center';
  if (!L.accent) L.accent = L.colors.c;
  L.sections = sections(L);
  return L;
}

const preset = (id) => normalize(PRESETS[id] || PRESETS.bold, PRESETS[id] || PRESETS.bold);
const list = () => Object.entries(PRESETS).map(([id, p]) => { const L = preset(id); return { id, name: L.name, about: L.about, colors: [L.colors.a, L.colors.b, L.colors.c, L.accent], font: L.fonts.head, layout: L.layout }; });

// ------------------------------------------------------------------ from a prompt

const SCHEMA = `{
 "name": "2-4 word name for this look",
 "base": one of ${JSON.stringify(Object.keys(PRESETS))} (closest preset to start from),
 "layout": ${OPTIONS.layout.join(' | ')}   (card = tilted footage card over flat colour, frame = straight framed footage, full = footage fills the screen, letterbox = cinematic black bars),
 "colors": {"a": "#hex section colour 1", "b": "#hex section colour 2", "c": "#hex section colour 3"}, "accent": "#hex", "light": "#hex light text", "dark": "#hex dark text",
 "fonts": {"head": headline font, "body": small text font, "cap": captions font}  (only from: ${Object.keys(FONTS).join(', ')}),
 "head": {"pos": top|bottom, "case": upper|none, "align": center|left, "keyStyle": ${OPTIONS.keyStyle.join('|')}, "reveal": ${OPTIONS.reveal.join('|')}, "scale": 0.6-1.3},
 "cap": {"style": ${OPTIONS.capStyle.join('|')}, "pos": card|low|center, "case": upper|none, "scale": 0.5-1.4},
 "card": {"tilt": true|false, "border": 0-30, "radius": 0-60, "block": true|false (offset colour block behind), "shadow": true|false, "borderColor": "#hex"},
 "transition": ${OPTIONS.transition.join('|')}, "grade": ${OPTIONS.grade.join('|')}, "texture": ${OPTIONS.texture.join('|')},
 "plate": ${OPTIONS.plate.join('|')} (name plate), "pill": tag|tape|none (place labels), "badge": true|false, "end": split|solid|stripes, "motion": snappy|smooth|calm,
 "flair": bold|cinematic|clean|news|grassroots|tiktok|patriotic|dark|bright|none (the signature motion graphics: bold = colour blocks and wipes, cinematic = opening bars/gold rules/vignette, clean = gliding soft shapes, news = sweeping red bars and a corner bug, grassroots = tape/marker scribbles/doodles, tiktok = full-screen word flashes and a progress bar, patriotic = flag-stripe wipes and stars, dark = glitches and stamped words, bright = floating shapes and confetti),
 "punch": true|false (zoom punch-ins on key words), "ticker": true|false (scrolling name bar along the bottom),
 "notes": "anything in the request about content or pacing (which lines, length, what to open or end on), for the editor; empty if none"
}`;

/** Turn words ("dark and gritty, black and gold, like a movie trailer") into a look (+ notes for the ad's editor). */
async function fromPrompt(prompt, { current = null } = {}) {
  const text = String(prompt || '').trim().slice(0, 1500);
  if (!text) return { look: preset('bold'), notes: '', by: 'preset' };
  if (ai.anyConnected()) {
    try {
      const r = await ai.ask({
        role: 'writing', json: true, maxTokens: 1200,
        system: `You are the art director for professional political campaign ads (motion graphics over the candidate's own footage). Turn the request into a look using ONLY the options in this schema, real hex colours and the listed fonts. Make strong, tasteful choices that clearly match the request: readable text (high contrast), fewer bigger elements, no neon glows. If they name a preset-like style (cinematic, news, grassroots, tiktok, patriotic, dark, bright, the original bold blocks), start from that base. Return JSON only:\n${SCHEMA}`,
        prompt: `Request: ${text}${current ? `\n\nThe current look (change only what the request asks for):\n${JSON.stringify(strip(current))}` : ''}`,
      });
      const j = r.json || {};
      const base = PRESETS[j.base] || (current ? current : PRESETS[guess(text)] || PRESETS.bold);
      return { look: normalize(j, base), notes: String(j.notes || '').slice(0, 600), by: `${r.provider}:${r.model}` };
    } catch { /* the built-in reading below */ }
  }
  return { look: fromWords(text, current), notes: '', by: 'built-in' };
}

/** Without an AI: the nearest preset by its words, plus any colours and fonts named. */
const WORDS = {
  cinematic: /cinema|film|movie|trailer|documentary|letterbox|serif|elegant|prestige/i, news: /news|breaking|report|headline news|ticker|cable/i,
  grassroots: /grassroots|hand.?made|handwritten|marker|paper|scrapbook|community|homemade|diy/i, tiktok: /tiktok|reels?|full.?screen|vertical video|influencer|gen ?z|captions? big/i,
  patriotic: /patriot|flag|america|red,? white|classic campaign|traditional|serious/i, dark: /dark|gritty|attack|contrast|urgent|ominous|black and red|scary|warning/i,
  bright: /bright|pastel|fun|bubbly|playful|pop(py)?|colou?rful|cute|young/i, clean: /clean|minimal|modern|simple|apple|white|corporate|sleek/i, bold: /bold|block|original|reference|larinda|same as/i,
};
function guess(text) { for (const [id, re] of Object.entries(WORDS)) if (re.test(text)) return id; return null; }
const COLOR_WORDS = { navy: '#1f2b6e', blue: '#2563eb', 'light blue': '#7cc4ff', red: '#d7263d', green: '#1f9d55', 'dark green': '#0f5132', gold: '#d4a017', yellow: '#f6c431', orange: '#f26b1d', purple: '#6d28d9', pink: '#ff5fa2', teal: '#14b8a6', black: '#0b0b0b', white: '#ffffff', grey: '#6b7280', gray: '#6b7280', maroon: '#7a1c2c', cream: '#f3ead8', brown: '#7a4a2a' };
function fromWords(text, current) {
  const base = PRESETS[guess(text)] || current || PRESETS.bold;
  const hits = Object.keys(COLOR_WORDS).filter((w) => new RegExp(`\\b${w}\\b`, 'i').test(text));
  const named = Object.entries(COLOR_WORDS).filter(([w]) => hits.includes(w) && !hits.some((o) => o !== w && o.includes(w))).sort((a, b) => text.toLowerCase().indexOf(a[0]) - text.toLowerCase().indexOf(b[0])).map(([, c]) => c);
  const hexes = (text.match(/#[0-9a-f]{6}\b/gi) || []);
  const cols = [...hexes, ...named];
  const x = {};
  if (cols.length) x.colors = { a: cols[0], b: cols[1] || base.colors.b, c: cols[2] || cols[0] }, x.accent = cols[1] || cols[0];
  const f = Object.keys(FONTS).find((k) => new RegExp(`\\b${k}\\b`, 'i').test(text)); if (f) x.fonts = { head: f };
  if (/no (tilt|angle)|straight/i.test(text)) x.card = { tilt: false };
  if (/black.?and.?white|b&w|monochrome/i.test(text)) x.grade = 'bw';
  if (/grain|vintage|retro/i.test(text)) x.texture = 'grain';
  return normalize(x, base);
}

/** A look without its computed parts (what the AI and the UI see). */
function strip(L) { const { sections: _s, ...rest } = L || {}; return rest; }

/** Font files the renderer must load for a look. */
function fontFiles(L) { return [...new Set([L.fonts.head, L.fonts.body, L.fonts.cap])].map((family) => ({ family, url: `/f/${FONTS[family]}` })); }

module.exports = { PRESETS, FONTS, OPTIONS, preset, list, normalize, fromPrompt, fromWords, fontFiles, strip, contrast, guess };
