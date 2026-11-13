// The political ad, drawn from a spec (what is said and when) and a look (how it looks and moves; server/political/looks.js).
// Layouts: "card" (tilted footage card over flat colour sections, the reference ad), "frame" (straight framed footage),
// "full" (footage fills the screen) and "letterbox" (cinematic bars). Headlines build with the voice, key words styled
// (box / underline / colour / highlight); captions show the spoken word; name plate, place labels, badge, district map,
// stat counter, ticker and end card all follow the look. Motion: hold → travel → hold, spring() and interpolate() only.
import React, { useEffect, useMemo, useState } from 'react';
import { AbsoluteFill, Audio, Img, OffthreadVideo, Sequence, continueRender, delayRender, interpolate, spring, useCurrentFrame, useVideoConfig, Easing } from 'remotion';
import { FlairUnder, FlairOver, CardFlair, EndFlair } from './Flair.jsx';

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const SEC = { navy: 'a', yellow: 'b', red: 'c', a: 'a', b: 'b', c: 'c' };

// The reference look, used when a spec carries none.
const FALLBACK = {
  layout: 'card', light: '#ffffff', dark: '#111522', accent: '#ef5a3a', fonts: { head: 'Anton', body: 'Montserrat', cap: 'Anton' },
  head: { pos: 'top', case: 'upper', align: 'center', keyStyle: 'box', reveal: 'word', scale: 1 }, cap: { style: 'box', pos: 'card', case: 'upper', scale: 1 },
  card: { tilt: true, border: 12, radius: 0, block: true, shadow: true, borderColor: '#ffffff' }, transition: 'wipe', grade: 'none', texture: 'none', plate: 'box', pill: 'tag', badge: true, end: 'split', motion: 'snappy', punch: false, ticker: false,
  sections: {
    a: { bg: '#1f2b6e', text: '#ffffff', block: '#f6c431', key: '#ef5a3a', keyText: '#ffffff', capKey: '#ef5a3a', plate: '#111522', plateText: '#ffffff', plateEdge: '#f6c431', accent: '#ef5a3a' },
    b: { bg: '#f6c431', text: '#111522', block: '#ef5a3a', key: '#1f2b6e', keyText: '#ffffff', capKey: '#ef5a3a', plate: '#111522', plateText: '#ffffff', plateEdge: '#f6c431', accent: '#ef5a3a' },
    c: { bg: '#ef5a3a', text: '#ffffff', block: '#1f2b6e', key: '#1f2b6e', keyText: '#ffffff', capKey: '#ef5a3a', plate: '#111522', plateText: '#ffffff', plateEdge: '#f6c431', accent: '#1f2b6e' },
  },
};
const schemeOf = (look, bg) => look.sections[SEC[bg] || 'a'] || look.sections.a;
const MOTION = {
  snappy: { enter: { damping: 11, stiffness: 130 }, word: { damping: 10, stiffness: 220 }, pop: { damping: 8, stiffness: 260 }, rot: 1 }, // springy: overshoots and settles (Ryan: more bounce)
  smooth: { enter: { damping: 20, stiffness: 110 }, word: { damping: 20, stiffness: 150 }, pop: { damping: 18, stiffness: 200 }, rot: 0.5 },
  calm: { enter: { damping: 28, stiffness: 80 }, word: { damping: 28, stiffness: 100 }, pop: { damping: 26, stiffness: 140 }, rot: 0 },
};
const GRADE = { none: 'none', warm: 'sepia(0.18) saturate(1.15) contrast(1.05)', cool: 'saturate(0.9) hue-rotate(-10deg) contrast(1.06)', bw: 'grayscale(1) contrast(1.18) brightness(0.95)', film: 'contrast(1.12) saturate(0.82) sepia(0.14) brightness(0.96)', punchy: 'contrast(1.14) saturate(1.3)', dark: 'brightness(0.78) contrast(1.22) saturate(0.7)' };
const ON_FOOTAGE = { color: '#ffffff', stroke: '#0b0f1c' };

/** Where things sit, for the frame size and the look's layout. */
export function layout(w, h, look) {
  const v = h > w; const kind = look.layout;
  let card;
  if (kind === 'full') card = { x: 0, y: 0, w, h };
  else if (kind === 'letterbox') card = v ? { x: 0, y: Math.round(h * 0.3), w, h: Math.round(h * 0.4) } : { x: 0, y: Math.round(h * 0.11), w, h: Math.round(h * 0.62) };
  else if (kind === 'frame') card = v ? { x: 54, y: Math.round(h * 0.28), w: w - 108, h: Math.round(h * 0.45) } : { x: Math.round((w - 1240) / 2), y: Math.round(h * 0.235), w: 1240, h: Math.round(h * 0.62) };
  else card = v ? { x: Math.round(w * 0.045), y: Math.round(h * 0.285), w: Math.round(w * 0.91), h: Math.round(h * 0.44) } : { x: Math.round((w - 1120) / 2), y: Math.round(h * 0.25), w: 1120, h: Math.round(h * 0.59) };
  // Captions only: no headline above the footage, so the footage takes the room.
  if (look.density === 'minimal' && (kind === 'card' || kind === 'frame')) card = v ? { x: Math.round(w * 0.05), y: Math.round(h * 0.15), w: Math.round(w * 0.9), h: Math.round(h * 0.6) } : { x: Math.round((w - 1420) / 2), y: Math.round(h * 0.085), w: 1420, h: Math.round(h * 0.74) };
  const pad = v ? 60 : 120;
  const above = { y: v ? Math.round(h * 0.07) : 22, h: card.y - (v ? Math.round(h * 0.07) : 22) - (v ? 28 : 18) };
  const belowY = card.y + card.h + (v ? 36 : 18);
  let head;
  if (kind === 'full') head = look.head.pos === 'bottom' ? { y: Math.round(h * (v ? 0.56 : 0.6)), h: Math.round(h * (v ? 0.17 : 0.2)) } : { y: Math.round(h * (v ? 0.09 : 0.06)), h: Math.round(h * (v ? 0.2 : 0.24)) };
  else if (look.head.pos === 'bottom') head = { y: belowY, h: Math.min(h - belowY - Math.round(h * (v ? 0.12 : 0.05)), Math.round(h * (v ? 0.2 : 0.2))) };
  else if (kind === 'letterbox' && !v) head = { y: belowY, h: h - belowY - 14 }; // wide cinematic: the headline sits in the bottom bar
  else head = above;
  if (look.ticker) { const tickerTop = v ? h - 300 : h - 58; head.h = Math.min(head.h, tickerTop - 14 - head.y); }
  const capBase = v ? 84 : 66;
  const capY = { card: null, low: kind === 'full' ? Math.round(h * (v ? 0.8 : 0.86)) : Math.min(h - (v ? 300 : 70), belowY + (look.head.pos === 'bottom' ? head.h + 10 : 30)), center: kind === 'full' ? Math.round(h * (v ? 0.64 : 0.74)) : Math.round(card.y + card.h * 0.62) }[look.cap.pos];
  const belowFree = look.head.pos === 'top' && look.cap.pos === 'card' && kind !== 'full';
  const plate = kind === 'full' ? (look.head.pos === 'bottom' ? { x: v ? 60 : 90, y: v ? 220 : 110, inside: true } : { x: v ? 64 : 90, y: Math.round(h * (v ? 0.72 : 0.62)), inside: false }) : belowFree ? { x: card.x + (kind === 'card' ? 24 : 0), y: belowY + (v ? 18 : 0), inside: false } : { x: card.x + 28, y: card.y + 28, inside: true };
  if (!v && belowFree && kind === 'card') { if (look.plate === 'box') { plate.x = card.x - 70; plate.y = card.y + card.h - 30; } else { plate.x = card.x; plate.y = belowY + 6; } }
  if (v && kind === 'letterbox') { plate.x = 70; plate.y = card.y + card.h + (look.cap.pos === 'low' ? 190 : 50); plate.inside = false; }
  return { v, card, head: { x: pad, y: head.y, w: w - pad * 2, h: Math.max(80, head.h), size: Math.round((v ? 112 : 92) * look.head.scale) }, cap: Math.round(capBase * look.cap.scale), capY, plate: { ...plate, size: v ? 62 : 52 }, belowFree, badge: v ? 150 : 130 };
}

/** Load the look's fonts before anything is drawn: text is sized by measuring it in its real font, so a frame drawn
 *  with a stand-in font would come out the wrong size (it did on the first frame of each render worker). */
function useFonts(fonts) {
  const [handle] = useState(() => delayRender('Loading fonts'));
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const list = (fonts || []).map((f) => new FontFace(f.family, `url("${f.url}")`, { weight: f.weight || 'normal' }).load().then((ff) => document.fonts.add(ff)).catch(() => null));
    Promise.all(list).then(() => document.fonts.ready).then(() => { setReady(true); continueRender(handle); });
  }, []);
  return ready;
}

const sp = (frame, fps, at, cfg = {}) => spring({ frame: frame - at, fps, config: { damping: 16, stiffness: 170, mass: 0.8, ...cfg } });
const segAt = (segs, t) => segs.find((s) => t >= s.at && t < s.at + s.dur);
/** Full-screen, fast looks: a short white flash and a punch-in that settles on every cut (the street / creator edit). */
const cutFlash = (look) => look.layout === 'full' && look.motion === 'snappy';
const onFootageOf = (look, inCard) => inCard || look.layout === 'full';
/** Where the speaker's face should sit in a full-screen vertical frame (fraction of the height), so the headline has
 *  the top and the captions sit under the chin. */
const faceTarget = (look) => (look.density === 'minimal' ? 0.36 : 0.42);
/** The transition into section i ('mix' varies it from one line to the next). */
const MIX = ['wipe', 'zoom', 'flash', 'slide', 'cut', 'zoom', 'wipe', 'flash'];
const transAt = (look, i) => (look.transition === 'mix' ? MIX[Math.max(0, i) % MIX.length] : look.transition);
const lum = (h) => { const n = parseInt(String(h).slice(1), 16); return [n >> 16, (n >> 8) & 255, n & 255].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }).reduce((a, v, i) => a + v * [0.2126, 0.7152, 0.0722][i], 0); };
const contrast = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };

// Text is fitted by measuring it in the real font (fonts are loaded before the first frame is drawn).
let ctx2d = null;
function textW(str, font, size) { if (!ctx2d) ctx2d = document.createElement('canvas').getContext('2d'); ctx2d.font = `${size}px "${font}"`; return ctx2d.measureText(str).width; }
/** The biggest size (≤ size0) at which these words, wrapped, fit maxW × maxH. extra(w) = added width per word in em (boxes). */
function fitWords(words, font, size0, maxW, maxH, { upper = false, gap = 0.22, lh = 1.08, extra = () => 0, min = 36, maxLines = 9 } = {}) {
  for (let size = size0; size > min; size -= 2) {
    let lines = 1; let x = 0; let ok = true;
    for (const w of words) {
      const ww = textW(upper ? w.toUpperCase() : w, font, size) + extra(w) * size;
      if (ww > maxW) { ok = false; break; }
      if (x > 0 && x + gap * size + ww > maxW) { lines++; x = ww; } else x += (x > 0 ? gap * size : 0) + ww;
    }
    if (ok && lines <= maxLines && lines * size * lh <= maxH) return size;
  }
  return min;
}

// ------------------------------------------------------------------ background, textures, transitions

function Background({ segs, endCard, look, fps }) {
  const frame = useCurrentFrame(); const { width: W, height: H } = useVideoConfig();
  const t = frame / fps;
  const all = [...segs, ...(endCard ? [{ at: endCard.at, dur: endCard.dur, bg: 'a' }] : [])];
  let i = all.findIndex((s) => t >= s.at && t < s.at + s.dur); if (i < 0) i = t < (all[0]?.at || 0) ? 0 : all.length - 1;
  const cur = all[i]; const prev = all[i - 1];
  const now = schemeOf(look, cur.bg).bg;
  const local = frame - Math.round(cur.at * fps);
  const changing = prev && schemeOf(look, prev.bg).bg !== now && local < 14;
  const tex = ['paper', 'halftone', 'stripes'].includes(look.texture) ? <Texture kind={look.texture} look={look} bg={now} /> : null;
  const tr = transAt(look, i);
  if (!changing || tr === 'cut' || tr === 'flash' || tr === 'zoom') return <AbsoluteFill style={{ background: now }}>{tex}</AbsoluteFill>;
  const before = schemeOf(look, prev.bg).bg;
  if (tr !== 'wipe') {
    const p = interpolate(local, [0, 10], [0, 1], { extrapolateRight: 'clamp' });
    return <AbsoluteFill style={{ background: before }}><AbsoluteFill style={{ background: now, opacity: p }} />{tex}</AbsoluteFill>;
  }
  const p = interpolate(local, [0, 11], [0, 1], { extrapolateRight: 'clamp', easing: Easing.bezier(0.7, 0, 0.2, 1) });
  const slant = H * 0.45; const span = W + slant + 240; const edge = p * span - slant - 240 * (1 - p);
  return (
    <AbsoluteFill style={{ background: before }}>
      <AbsoluteFill style={{ background: schemeOf(look, cur.bg).key, clipPath: `polygon(0 0, ${edge + 230}px 0, ${edge + 230 + slant}px ${H}px, 0 ${H}px)` }} />
      <AbsoluteFill style={{ background: schemeOf(look, cur.bg).block, clipPath: `polygon(0 0, ${edge + 110}px 0, ${edge + 110 + slant}px ${H}px, 0 ${H}px)` }} />
      <AbsoluteFill style={{ background: now, clipPath: `polygon(0 0, ${edge}px 0, ${edge + slant}px ${H}px, 0 ${H}px)` }} />
      {tex}
    </AbsoluteFill>
  );
}

/** Paper fibre, halftone dots, diagonal stripes (on the background) or film grain and scanlines (over everything). */
function Texture({ kind, look, bg }) {
  const frame = useCurrentFrame(); const { width: W, height: H } = useVideoConfig();
  if (kind === 'grain') return (
    <AbsoluteFill style={{ mixBlendMode: 'overlay', opacity: 0.32, pointerEvents: 'none' }}>
      <svg width={W} height={H}><filter id="gr"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed={frame % 9} stitchTiles="stitch" /><feColorMatrix type="saturate" values="0" /></filter><rect width={W} height={H} filter="url(#gr)" /></svg>
    </AbsoluteFill>
  );
  if (kind === 'scanlines') return (
    <AbsoluteFill style={{ opacity: 0.18, pointerEvents: 'none' }}>
      <svg width={W} height={H}><pattern id="sl" width="6" height="6" patternUnits="userSpaceOnUse"><rect width="6" height="2" fill="#000" /></pattern><rect width={W} height={H} fill="url(#sl)" /></svg>
    </AbsoluteFill>
  );
  if (kind === 'paper') return (
    <AbsoluteFill style={{ mixBlendMode: 'multiply', opacity: 0.22 }}>
      <svg width={W} height={H}><filter id="pp"><feTurbulence type="fractalNoise" baseFrequency="0.035 0.6" numOctaves="3" seed="4" /><feColorMatrix type="saturate" values="0" /></filter><rect width={W} height={H} filter="url(#pp)" /></svg>
    </AbsoluteFill>
  );
  if (kind === 'halftone') return (
    <AbsoluteFill style={{ opacity: 0.16 }}>
      <svg width={W} height={H}><pattern id="ht" width="26" height="26" patternUnits="userSpaceOnUse" patternTransform="rotate(20)"><circle cx="13" cy="13" r="5" fill={look.dark} /></pattern><rect width={W} height={H} fill="url(#ht)" /></svg>
    </AbsoluteFill>
  );
  if (kind === 'stripes') return (
    <AbsoluteFill style={{ opacity: 0.08 }}>
      <svg width={W} height={H}><pattern id="st" width="60" height="60" patternUnits="userSpaceOnUse" patternTransform="rotate(-35)"><rect width="22" height="60" fill={look.light} /></pattern><rect width={W} height={H} fill="url(#st)" /></svg>
    </AbsoluteFill>
  );
  return null;
}

/** Flashes, dips and sweeping bands where one section hands over to the next (cuts need nothing). */
function TransitionFX({ segs, look, fps, endAt }) {
  const frame = useCurrentFrame(); const { width: W, height: H } = useVideoConfig();
  const starts = [...segs.slice(1).map((s) => s.at), ...(endAt ? [endAt] : [])];
  const hits = starts.map((s, k) => [Math.round(s * fps), k + 1]).filter(([f]) => frame >= f && frame < f + 14);
  if (!hits.length) return null;
  const [at, idx] = hits[hits.length - 1];
  const local = frame - at; const tr = transAt(look, idx);
  if (cutFlash(look) && ['flash', 'zoom', 'cut', 'slide'].includes(tr)) return null;
  if (tr === 'flash') return <AbsoluteFill style={{ background: '#ffffff', opacity: interpolate(local, [0, 7], [0.85, 0], { extrapolateRight: 'clamp' }) }} />;
  if (tr === 'fade') return <AbsoluteFill style={{ background: look.dark, opacity: interpolate(local, [0, 9], [0.7, 0], { extrapolateRight: 'clamp' }) }} />;
  if (tr === 'wipe' && (look.layout === 'full' || look.layout === 'letterbox')) {
    const p = interpolate(local, [0, 12], [0, 1], { extrapolateRight: 'clamp', easing: Easing.bezier(0.6, 0, 0.3, 1) });
    const slant = H * 0.45; const x = -slant - 260 + p * (W + slant + 520);
    return <AbsoluteFill style={{ background: look.accent, clipPath: `polygon(${x}px 0, ${x + 220}px 0, ${x + 220 + slant}px ${H}px, ${x + slant}px ${H}px)` }} />;
  }
  return null;
}

// ------------------------------------------------------------------ headline

function Headline({ seg, L, look, fps }) {
  const frame = useCurrentFrame();
  const head = seg.head; if (!head?.words?.length) return null;
  const S = schemeOf(look, seg.bg); const M = MOTION[look.motion] || MOTION.snappy;
  const over = look.layout === 'full';
  const color = over ? ON_FOOTAGE.color : S.text;
  const caseUp = look.head.case === 'upper';
  const size = fitWords(head.words.map((x) => x.w), look.fonts.head, Math.round(L.head.size * (seg.hook ? 1.1 : 1)), L.head.w * 0.97, L.head.h, { upper: caseUp, gap: 0.24, lh: 1.12, extra: (w) => (head.words.find((x) => x.w === w)?.key ? 0.3 : 0) });
  const first = Math.round((head.words.find((x) => x.t != null)?.t ?? seg.at) * fps);
  const lineS = sp(frame, fps, first, M.word);
  const fade = interpolate(frame, [first, first + 12], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const depth = Math.max(3, Math.round(size * 0.07));
  const shadow = look.flair === 'poster' ? Array.from({ length: depth }, (_, i) => `${i + 1}px ${i + 1}px 0 ${look.dark}`).join(', ') : over ? '0 4px 22px rgba(0,0,0,0.55), 0 2px 4px rgba(0,0,0,0.5)' : 'none';
  // Cut-out zine: every word on its own scrap of paper, alternating stock and angle.
  const scrap = (k) => look.flair !== 'zine' ? null : ({ background: [look.light, look.dark, '#efe7cf', look.light][k % 4], color: [look.dark, look.light, look.dark, look.dark][k % 4], padding: `0 ${size * 0.12}px`, transform: `rotate(${[-2.5, 1.8, -1, 2.6][k % 4]}deg)`, boxShadow: '2px 3px 0 rgba(0,0,0,0.25)', textShadow: 'none' });
  return (
    <div style={{ position: 'absolute', left: L.head.x, top: L.head.y, width: L.head.w, height: L.head.h, display: 'flex', alignItems: look.head.pos === 'bottom' && look.layout !== 'full' ? 'flex-start' : 'flex-end', justifyContent: look.head.align === 'left' ? 'flex-start' : 'center' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: look.head.align === 'left' ? 'flex-start' : 'center', alignItems: 'baseline', columnGap: size * 0.22, rowGap: size * 0.08, fontFamily: look.fonts.head, fontSize: size, lineHeight: 1.04, color, textTransform: caseUp ? 'uppercase' : 'none', textAlign: look.head.align, textShadow: shadow,
        opacity: look.head.reveal === 'fade' ? fade : 1, transform: look.head.reveal === 'line' ? `translateY(${interpolate(lineS, [0, 1], [size * 0.5, 0])}px)` : 'none' }}>
        {head.words.map((x, k) => {
          const at = Math.round((x.t != null ? x.t : seg.at + 0.06 + k * 0.07) * fps);
          const s = sp(frame, fps, at, M.word);
          const shown = look.head.reveal === 'word' || look.head.reveal === 'type' ? frame >= at : frame >= first;
          const blurIn = look.head.reveal === 'blur';
          const bp = blurIn ? interpolate(frame - at, [0, 14], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.out(Easing.cubic) }) : 1;
          const opacity = look.head.reveal === 'word' ? (shown ? clamp(s * 1.6, 0, 1) : 0) : look.head.reveal === 'line' ? (shown ? clamp(lineS * 1.6, 0, 1) : 0) : blurIn ? (frame >= at ? bp : 0) : 1;
          const move = look.head.reveal === 'word' ? `translateY(${interpolate(s, [0, 1], [size * 0.35, 0])}px) scale(${interpolate(s, [0, 1], [1 + 0.2 * M.rot, 1])})` : blurIn ? `scale(${1.06 - 0.06 * bp})` : 'none';
          const blurF = blurIn ? `blur(${(1 - bp) * 14}px)` : 'none';
          let text = x.w;
          const ol = (node) => (look.head.outline && !over ? <Outlined stroke={look.dark} width={Math.max(4, size * 0.09)} color={color}>{node}</Outlined> : node);
          if (look.head.reveal === 'type') { const n = Math.floor(clamp((frame - at) / Math.max(1, fps * 0.035), 0, x.w.length)); text = <>{x.w.slice(0, n)}<span style={{ opacity: 0 }}>{x.w.slice(n)}</span></>; }
          if (!x.key) { const sc = scrap(k); return <span key={k} style={{ display: 'inline-block', opacity, transform: move, filter: blurF, ...(sc || {}), ...(sc ? { transform: `${move === 'none' ? '' : move} ${sc.transform}` } : {}) }}>{sc ? text : ol(text)}</span>; }
          const ks = look.head.keyStyle; const kpop = look.head.reveal === 'word' ? s : lineS;
          if (ks === 'circle') { const cp = interpolate(frame - at, [3, 17], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }); return <span key={k} style={{ display: 'inline-block', position: 'relative', opacity, transform: move }}><span style={{ position: 'relative', color: over ? ON_FOOTAGE.color : S.text }}>{text}</span><svg viewBox="0 0 100 100" preserveAspectRatio="none" style={{ position: 'absolute', left: '-14%', top: '-22%', width: '128%', height: '140%', overflow: 'visible' }}><path d="M8 58 C 4 22, 70 6, 94 30 C 108 52, 70 96, 30 90 C 6 86, 2 60, 14 40 C 24 26, 46 18, 62 16" fill="none" stroke={S.accent} strokeWidth={Math.max(4, size * 0.06)} strokeLinecap="round" vectorEffect="non-scaling-stroke" pathLength={1} strokeDasharray="1 1" strokeDashoffset={1 - cp} /></svg></span>; }
          if (ks === 'sticker') return <span key={k} style={{ display: 'inline-block', opacity, transform: `rotate(${-4 * M.rot}deg) scale(${interpolate(kpop, [0, 1], [0.5, 1])})`, filter: `drop-shadow(0 ${size * 0.06}px 0 ${look.dark})` }}><Outlined stroke={S.accent} width={size * 0.16} color={look.light}>{text}</Outlined></span>;
          if (ks === 'box') return <span key={k} style={{ display: 'inline-block', opacity, background: S.key, color: S.keyText, padding: `0 ${size * 0.1}px`, textShadow: 'none', transform: `rotate(${-1.5 * M.rot}deg) scale(${interpolate(kpop, [0, 1], [0.6, 1])})` }}>{text}</span>;
          if (ks === 'highlight') { const hl = contrast(look.accent, S.bg) >= 1.25 ? look.accent : S.key; const ht = contrast(hl, look.dark) >= contrast(hl, look.light) ? look.dark : look.light; return <span key={k} style={{ display: 'inline-block', position: 'relative', opacity, transform: move, color: over ? ON_FOOTAGE.color : S.text }}><span style={{ position: 'absolute', left: -size * 0.08, right: -size * 0.08, top: '18%', bottom: '4%', background: hl, opacity: 0.9, transform: `skewX(-8deg) scaleX(${kpop})`, transformOrigin: '0 50%' }} /><span style={{ position: 'relative', color: ht }}>{text}</span></span>; }
          if (ks === 'underline') return <span key={k} style={{ display: 'inline-block', position: 'relative', opacity, transform: move }}>{text}<span style={{ position: 'absolute', left: 0, right: 0, bottom: -size * 0.04, height: Math.max(6, size * 0.09), background: S.accent, transform: `scaleX(${kpop})`, transformOrigin: '0 50%' }} /></span>;
          const kc = over ? look.accent : contrast(S.accent, S.bg) >= 2.5 ? S.accent : mix(S.accent, contrast(S.bg, '#000000') > contrast(S.bg, '#ffffff') ? '#000000' : '#ffffff', 0.45);
          return <span key={k} style={{ display: 'inline-block', opacity, transform: move, color: kc }}>{text}</span>;
        })}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ the footage card

function Outlined({ children, stroke, width, color }) {
  return (
    <span style={{ position: 'relative', display: 'inline-block' }}>
      <span style={{ position: 'absolute', inset: 0, WebkitTextStroke: `${width}px ${stroke}`, color: stroke }}>{children}</span>
      <span style={{ position: 'relative', color }}>{children}</span>
    </span>
  );
}

function CardContent({ seg, fps, w, h, look, keyTimes }) {
  const frame = useCurrentFrame(); const t = frame / fps; // relative to the segment
  const c = seg.card || {};
  if (c.kind === 'video' || c.kind === 'photo') {
    const abs = seg.at + t;
    let push = c.pushLen ? 1 + 0.06 * clamp((abs - c.pushAt) / c.pushLen, 0, 1) : 1 + 0.05 * clamp(t / seg.dur, 0, 1);
    if ((look.punch || seg.rally) && c.kind === 'video' && !c.broll) for (const k of (keyTimes || []).filter((x) => look.punch || (x >= seg.at && x < seg.at + seg.dur))) push += 0.09 * interpolate(abs - k, [-0.02, 0.08, 0.85, 1.0], [0, 1, 1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
    const shake = look.flair === 'street' && c.kind === 'video' ? `translate(${(Math.sin(abs * 1.7) * 6 + Math.sin(abs * 4.3) * 3).toFixed(1)}px, ${(Math.cos(abs * 1.3) * 5 + Math.sin(abs * 3.1) * 2).toFixed(1)}px) rotate(${(Math.sin(abs * 0.9) * 0.4).toFixed(2)}deg) ` : '';
    if (shake) push += 0.03; // room for the handheld drift
    // A pause closed up inside a line is a jump cut: every other piece is punched in a little, like an editor would.
    if (c.jumps?.length && c.jumps.filter((j) => abs >= j).length % 2 === 1) push *= 1.08;
    // Full-screen vertical: lift the shot so the face sits above the captions (text never covers a face).
    // Also: one take cut like several cameras (c.angles): each framing is a zoom centred on the face.
    let lift = 0; let oy = 40;
    if (look.layout === 'full' && c.kind === 'video' && !c.broll) {
      const z = c.angles && c.face ? (c.angles.filter((a) => abs >= a.t - 0.001).pop() || c.angles[0]).z : 1; // never zoom without knowing where the face is
      const fy = c.face ? clamp(c.face.y, 0.15, 0.7) : 0.36;
      const need = h > w && c.face ? clamp(fy - faceTarget(look), 0, 0.2) : 0;
      let S = push * z; if ((S - 1) * (1 - fy) < need) S = 1 + need / (1 - fy);
      push = S; oy = fy * 100;
      lift = clamp(need + (z > 1.3 && h > w ? 0.02 : 0), 0, (1 - fy) * (S - 1)); // never past the picture's edge
    }
    // Centre the face: a wide picture in a narrower window shows only a slice of its width; the slice is placed so the
    // face sits in the middle of it (not at the same fraction it had in the full picture), kept inside the picture.
    const vis = c.ar && c.kind === 'video' ? clamp((w / h) / c.ar, 0.05, 1) : 1;
    const px = vis < 0.999 ? clamp(((c.fx ?? 0.5) - vis / 2) / (1 - vis), 0, 1) : 0.5;
    const ox = vis < 0.999 ? clamp(((c.fx ?? 0.5) - px * (1 - vis)) / vis, 0.1, 0.9) : (c.fx ?? 0.5);
    if (c.fit && c.kind === 'video') {
      // No face was found in this wide shot: show all of it over a blurred copy instead of cropping blind.
      const from = Math.round((c.from || 0) * fps);
      return (
        <AbsoluteFill style={{ background: '#000' }}>
          <OffthreadVideo src={c.src} muted startFrom={from} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', filter: 'blur(26px) brightness(0.55)', transform: 'scale(1.2)' }} />
          <OffthreadVideo src={c.src} muted startFrom={from} style={{ position: 'absolute', left: 0, top: '22%', width: '100%', height: '56%', objectFit: 'contain', filter: GRADE[look.grade] || 'none', transform: `scale(${1 + 0.04 * clamp(t / seg.dur, 0, 1)})` }} />
        </AbsoluteFill>
      );
    }
    const style = { width: '100%', height: '100%', objectFit: 'cover', objectPosition: `${(px * 100).toFixed(1)}% ${Math.round((c.fy ?? 0.35) * 100)}%`, transform: `translateY(${(-lift * h).toFixed(1)}px) ${shake}scale(${push})`, transformOrigin: `${(ox * 100).toFixed(1)}% ${oy.toFixed(1)}%`, filter: GRADE[look.grade] || 'none' };
    return c.kind === 'photo' ? <Img src={c.src} style={style} /> : <OffthreadVideo src={c.src} muted startFrom={Math.round((c.from || 0) * fps)} style={style} />;
  }
  if (c.kind === 'map') return <MapCard c={c} w={w} h={h} fps={fps} look={look} />;
  if (c.kind === 'stat') return <StatCard c={c} w={w} h={h} fps={fps} look={look} />;
  if (c.kind === 'checklist') return <ChecklistCard c={c} w={w} h={h} fps={fps} look={look} seg={seg} />;
  if (c.kind === 'compare') return <CompareCard c={c} w={w} h={h} fps={fps} look={look} />;
  if (c.kind === 'timeline') return <TimelineCard c={c} w={w} h={h} fps={fps} look={look} />;
  if (c.kind === 'clip') return <ClipCard c={c} w={w} h={h} fps={fps} look={look} />;
  return <AbsoluteFill style={{ background: look.dark }} />;
}

function Card({ seg, prevTilt, L, look, fps, keyTimes, children }) {
  const frame = useCurrentFrame(); // relative to the segment
  const { width: W } = useVideoConfig();
  const S = schemeOf(look, seg.bg); const M = MOTION[look.motion] || MOTION.snappy;
  const tiltOn = look.card.tilt;
  const flat = look.layout === 'full' || look.layout === 'letterbox';
  const enter = seg.enter ? sp(frame + 5, fps, 0, M.enter) : 1; // already on its way in on the first frame (the cover)
  const tiltS = sp(frame, fps, 0, { damping: 18, stiffness: 160 });
  const tilt = tiltOn ? interpolate(tiltS, [0, 1], [prevTilt ?? seg.tilt ?? 0, seg.tilt ?? 0]) : 0;
  const trans = transAt(look, seg.idx ?? 0);
  let punch = 1; let tx = 0;
  if (!seg.enter) {
    if (cutFlash(look)) punch = 1 + 0.13 * (1 - sp(frame, fps, 0, { damping: 200, stiffness: 300 }));
    else if (trans === 'zoom') punch = 1 + 0.12 * (1 - sp(frame, fps, 0, { damping: 18, stiffness: 200 }));
    else if (trans === 'slide' && seg.cut) tx = interpolate(sp(frame, fps, 0, M.enter), [0, 1], [W * 0.5, 0]);
    else if (look.layout === 'card' && look.motion === 'snappy') punch = 1 + 0.03 * (1 - sp(frame, fps, 0, { damping: 13, stiffness: 220 }));
  }
  const { x, y, w, h } = L.card; const border = Math.round(look.card.border * (L.v ? 1 : 0.85));
  const ty = flat ? 0 : interpolate(enter, [0, 1], [L.v ? 620 : 480, 0]);
  const rot = tilt + (tiltOn ? interpolate(enter, [0, 1], [10, 0]) : 0);
  const sc = punch * (flat && seg.enter ? interpolate(enter, [0, 1], [1.08, 1]) : 1);
  const op = 1; // the first frame is the cover: the footage is fully there from frame 0
  const r = look.card.radius;
  const openBars = look.flair === 'cinematic' && seg.enter ? `inset(${(1 - clamp(enter, 0, 1)) * 50}% 0)` : 'none';
  return (
    <div style={{ position: 'absolute', left: x, top: y, width: w, height: h, opacity: look.flair === 'cinematic' && seg.enter ? 1 : op, clipPath: openBars, transform: `translate(${tx}px, ${ty}px) rotate(${rot}deg) scale(${sc})` }}>
      {look.card.block && !flat ? <div style={{ position: 'absolute', left: 26, top: 30, width: w, height: h, background: S.block, borderRadius: r, transform: `rotate(${tiltOn ? 1.4 : 0}deg)` }} /> : null}
      <div style={{ position: 'absolute', inset: 0, background: look.card.borderColor, borderRadius: r, boxShadow: look.card.shadow && !flat ? '0 22px 50px rgba(0,0,0,0.28)' : 'none', overflow: 'hidden' }}>
        <div style={{ position: 'absolute', inset: border, overflow: 'hidden', background: '#0c1020', borderRadius: Math.max(0, r - border) }}>
          <CardContent seg={seg} fps={fps} w={w - border * 2} h={h - border * 2} look={look} keyTimes={keyTimes} />
          {!['grassroots', 'zine', 'y2k'].includes(look.flair) && (look.density || 'full') === 'full' ? <CardFlair look={look} w={w - border * 2} h={h - border * 2} frame={frame} fps={fps} seg={seg} /> : null}
          {look.layout === 'full' ? <AbsoluteFill style={{ background: 'rgba(8,12,30,0.16)' }} /> : null}
          {cutFlash(look) && !seg.enter ? <AbsoluteFill style={{ background: '#ffffff', opacity: interpolate(frame, [0, 5], [0.5, 0], { extrapolateRight: 'clamp' }) }} /> : null}
          {children}
        </div>
      </div>
      {['grassroots', 'zine', 'y2k'].includes(look.flair) && (look.density || 'full') !== 'minimal' ? <CardFlair look={look} w={w} h={h} frame={frame} fps={fps} seg={seg} /> : null}
    </div>
  );
}

// ------------------------------------------------------------------ captions (the spoken word marked)

function chunkWords(words, max, chars = 16) {
  const out = []; let cur = [];
  const flush = () => { if (cur.length) out.push(cur); cur = []; };
  words.forEach((x, i) => {
    const prev = words[i - 1];
    if (cur.length && (cur.length >= max || x.s - prev.e > 0.4 || x.b !== prev.b || cur.map((c) => c.w).join(' ').length + x.w.length > chars)) flush();
    cur.push(x);
    if ((chars > 16 ? /[.!?]["”']?$/ : /[.!?,;:]["”']?$/).test(x.w) || (chars > 16 && cur.length >= 4 && /[,;:]$/.test(x.w))) flush();
  });
  flush();
  return out;
}

function Captions({ words, L, look, fps, seg, offset, inCard }) {
  const frame = useCurrentFrame() + offset; const t = frame / fps; // absolute time
  const { width: W } = useVideoConfig();
  const phrase = look.cap.chunk === 'phrase'; const max = phrase ? 8 : look.cap.scale > 1.05 ? 2 : 3;
  const chunks = useMemo(() => chunkWords(words || [], max, phrase ? 38 : 16), [words, max, phrase]);
  const k = chunks.findIndex((c, i) => t >= c[0].s - 0.04 && t < Math.min(chunks[i + 1] ? chunks[i + 1][0].s - 0.04 : Infinity, c[c.length - 1].e + 0.45));
  if (k < 0 || look.cap.style === 'none') return null;
  const S = schemeOf(look, seg.bg); const M = MOTION[look.motion] || MOTION.snappy;
  const c = chunks[k]; const at = Math.round((c[0].s - 0.04) * fps);
  const s = sp(frame, fps, at, { damping: 14, stiffness: 240 });
  const maxW = (inCard ? L.card.w : W - 80) * 0.9;
  const capW = phrase && !inCard ? Math.min(maxW, W * (W > 1300 ? 0.5 : 0.7)) : maxW;
  const size = fitWords(c.map((x) => x.w), look.fonts.cap, L.cap, capW, L.cap * (phrase ? 3.8 : 2.5), { upper: look.cap.case === 'upper', gap: 0.24, lh: 1.12, extra: () => (phrase ? 0 : 0.22), maxLines: phrase ? 3 : 2 });
  const onFootage = inCard || look.layout === 'full';
  const base = onFootage ? ON_FOOTAGE.color : S.text;
  const pos = inCard ? { position: 'absolute', left: 0, right: 0, bottom: L.card.h * 0.07 } : { position: 'absolute', left: (W - capW) / 2 - 10, width: capW + 20, top: L.capY - size * 0.6 };
  const soft = look.cap.shadow && onFootageOf(look, inCard);
  return (
    <div style={{ ...pos, display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: size * 0.22, fontFamily: look.fonts.cap, fontSize: size, lineHeight: 1.12, textTransform: look.cap.case === 'upper' ? 'uppercase' : 'none', textShadow: soft ? '0 3px 14px rgba(0,0,0,0.75), 0 1px 3px rgba(0,0,0,0.8)' : 'none', opacity: phrase && k > 0 ? clamp(s * 2.2, 0, 1) : 1, transform: `scale(${interpolate(s, [0, 1], [phrase ? 0.97 : 0.86, 1])})` }}>
      {c.map((x, i) => {
        const on = look.cap.style !== 'plain' && t >= x.s - 0.03 && (i === c.length - 1 || t < c[i + 1].s - 0.03);
        const pop = on ? sp(frame, fps, Math.round((x.s - 0.03) * fps), M.pop) : 1;
        const plain = (color) => (onFootage && !soft ? <Outlined key={i} stroke={ON_FOOTAGE.stroke} width={size * 0.14} color={color}>{x.w}</Outlined> : <span key={i} style={{ color }}>{x.w}</span>);
        if (!on) return plain(base);
        if (look.cap.style === 'box') return <span key={i} style={{ display: 'inline-block', background: S.capKey, color: '#fff', padding: `0 ${size * 0.1}px`, transform: `rotate(${-2 * M.rot}deg) scale(${interpolate(pop, [0, 1], [1.18, 1])})` }}>{x.w}</span>;
        if (look.cap.style === 'underline') return <span key={i} style={{ display: 'inline-block', position: 'relative' }}>{plain(base)}<span style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: Math.max(5, size * 0.09), background: look.accent, transform: `scaleX(${pop})`, transformOrigin: '0 50%' }} /></span>;
        return <span key={i} style={{ display: 'inline-block', transform: `scale(${interpolate(pop, [0, 1], [1.12, 1])})` }}>{plain(onFootage ? look.accent : S.accent)}</span>;
      })}
    </div>
  );
}

// ------------------------------------------------------------------ name plate, place labels, badge, ticker

function Plate({ seg, L, look, fps, name, office }) {
  const frame = useCurrentFrame(); const M = MOTION[look.motion] || MOTION.snappy;
  const S = schemeOf(look, seg.bg);
  const s = sp(frame, fps, Math.round(0.25 * fps), M.enter);
  const size = L.plate.size; const onFootage = L.plate.inside || look.layout === 'full';
  const gone = look.layout === 'full' && seg.tag ? interpolate(frame, [Math.round(3.0 * fps), Math.round(3.3 * fps)], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }) : 1;
  const wrap = { position: 'absolute', left: L.plate.x, top: L.plate.y, opacity: clamp(s * 1.5, 0, 1) * gone, transform: `translateX(${interpolate(s, [0, 1], [-60, 0])}px)` };
  if (look.plate === 'bar') return (
    <div style={{ ...wrap, display: 'flex', alignItems: 'stretch', clipPath: `inset(0 ${(1 - s) * 100}% 0 0)` }}>
      <div style={{ width: size * 0.2, background: look.accent }} />
      <div style={{ background: look.dark, padding: `${size * 0.12}px ${size * 0.34}px` }}>
        <div style={{ fontFamily: look.fonts.head, fontSize: size * 0.82, lineHeight: 1.05, color: look.light, textTransform: look.head.case === 'upper' ? 'uppercase' : 'none' }}>{name}</div>
        {office ? <div style={{ fontFamily: look.fonts.body, fontSize: size * 0.32, marginTop: size * 0.06, color: look.light, opacity: 0.85 }}>{office}</div> : null}
      </div>
    </div>
  );
  if (look.plate === 'minimal') {
    const col = onFootage ? ON_FOOTAGE.color : S.text;
    return (
      <div style={{ ...wrap, textShadow: onFootage ? '0 2px 12px rgba(0,0,0,0.6)' : 'none' }}>
        <div style={{ fontFamily: look.fonts.head, fontSize: size * 0.8, color: col, lineHeight: 1.05, textTransform: look.head.case === 'upper' ? 'uppercase' : 'none' }}>{name}</div>
        <div style={{ width: size * 2.4 * s, height: Math.max(4, size * 0.07), background: look.accent, margin: `${size * 0.12}px 0` }} />
        {office ? <div style={{ fontFamily: look.fonts.body, fontSize: size * 0.32, color: col, opacity: 0.9 }}>{office}</div> : null}
      </div>
    );
  }
  return (
    <div style={{ ...wrap, clipPath: `inset(0 ${(1 - s) * 100}% 0 0)` }}>
      <div style={{ background: S.plate, border: `5px solid ${S.plateEdge}`, padding: `${size * 0.1}px ${size * 0.3}px ${size * 0.14}px`, display: 'inline-block' }}>
        <div style={{ fontFamily: look.fonts.head, fontSize: size, lineHeight: 1, color: S.plateText, textTransform: look.head.case === 'upper' ? 'uppercase' : 'none' }}>{name}</div>
        {office ? <div style={{ fontFamily: look.fonts.body, fontSize: size * 0.32, marginTop: size * 0.1, color: S.plateEdge, letterSpacing: '0.02em' }}>{office}</div> : null}
      </div>
    </div>
  );
}

function Pill({ text, L, look, fps, seg, right }) {
  const frame = useCurrentFrame();
  const s = sp(frame, fps, Math.round(0.35 * fps), { damping: 13, stiffness: 200 });
  const S = schemeOf(look, seg.bg);
  const below = L.belowFree && look.layout !== 'full';
  const pos = below ? { top: L.card.y + L.card.h + (L.v ? 60 : 14) } : { top: L.card.y + (look.layout === 'full' ? (L.v ? 300 : 40) : 30) };
  const side = right ? { right: (look.layout === 'full' ? 0 : L.card.x) + 40 } : { left: L.card.x + 40 };
  if (look.pill === 'title') return (
    <div style={{ position: 'absolute', left: 60, right: 60, top: Math.round(L.card.y + L.card.h * (L.v ? 0.3 : 0.2)), textAlign: 'center', fontFamily: look.fonts.head, fontSize: L.v ? 62 : 54, lineHeight: 1.1, color: look.accent, textShadow: '0 3px 14px rgba(0,0,0,0.7), 0 1px 3px rgba(0,0,0,0.8)', opacity: clamp(s * 2, 0, 1) }}>{text}</div>
  );
  if (look.flair === 'street') return (
    <div style={{ position: 'absolute', ...pos, ...side, transform: `scale(${interpolate(s, [0, 1], [0.4, 1])})`, opacity: clamp(s * 2, 0, 1), display: 'flex', alignItems: 'center', gap: 14, background: look.dark, borderRadius: 999, padding: L.v ? '8px 26px 8px 8px' : '6px 20px 6px 6px' }}>
      <div style={{ width: L.v ? 56 : 44, height: L.v ? 56 : 44, borderRadius: '50%', background: look.sections.a.bg, color: '#fff', fontFamily: look.fonts.head, fontSize: L.v ? 32 : 26, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{String(text).trim()[0]?.toUpperCase()}</div>
      <div style={{ fontFamily: look.fonts.body, fontSize: L.v ? 30 : 24, color: look.light, letterSpacing: '0.02em' }}>{text}</div>
    </div>
  );
  if (look.pill === 'tape') return (
    <div style={{ position: 'absolute', ...pos, ...side, transform: `rotate(-4deg) scale(${interpolate(s, [0, 1], [0.6, 1])})`, opacity: clamp(s * 2, 0, 1) }}>
      <div style={{ background: 'rgba(250,243,220,0.92)', color: look.dark, fontFamily: look.fonts.cap, fontSize: L.v ? 34 : 26, padding: L.v ? '10px 30px' : '8px 22px', boxShadow: '0 4px 10px rgba(0,0,0,0.15)' }}>{text}</div>
    </div>
  );
  return (
    <div style={{ position: 'absolute', ...pos, ...side, transform: `rotate(${look.card.tilt ? -3 : 0}deg) scale(${interpolate(s, [0, 1], [0.4, 1])})`, opacity: clamp(s * 2, 0, 1) }}>
      <div style={{ background: look.light, color: contrast(schemeOf(look, 'a').bg, look.light) >= 3 ? schemeOf(look, 'a').bg : look.dark, fontFamily: look.fonts.body, fontSize: L.v ? 30 : 24, letterSpacing: '0.04em', textTransform: 'uppercase', padding: L.v ? '12px 26px' : '9px 20px', borderRadius: Math.min(10, look.card.radius + 6), boxShadow: '0 8px 0 rgba(0,0,0,0.18)' }}>{text}</div>
    </div>
  );
}

function Badge({ L, look, fps }) {
  const frame = useCurrentFrame();
  const s = sp(frame, fps, Math.round(0.4 * fps), { damping: 12, stiffness: 170 });
  const d = L.badge; const A = lum(look.sections.a.bg) > 0.35 ? { bg: look.dark } : look.sections.a; const B = look.sections.b;
  return (
    <div style={{ position: 'absolute', left: L.card.x + L.card.w - d * 0.72, top: L.card.y + L.card.h - d * 0.72, width: d, height: d, transform: `rotate(${interpolate(s, [0, 1], [-120, 0])}deg) scale(${s})` }}>
      <svg viewBox="0 0 100 100" width={d} height={d}>
        <circle cx="50" cy="50" r="48" fill="#fff" />
        <circle cx="50" cy="50" r="41" fill="none" stroke={A.bg === '#ffffff' ? look.dark : A.bg} strokeWidth="3" />
        <circle cx="50" cy="50" r="36" fill="none" stroke={B.bg === '#ffffff' ? look.accent : B.bg} strokeWidth="2" strokeDasharray="2 3" />
        <g fill={A.bg === '#ffffff' ? look.dark : A.bg}>
          <rect x="47.5" y="22" width="5" height="7" />
          <path d="M34 46 Q34 30 50 29 Q66 30 66 46 Z" />
          <rect x="31" y="46" width="38" height="4" />
          {[34, 40, 46, 52, 58, 64].map((x) => <rect key={x} x={x - 1.4} y="51" width="2.8" height="13" />)}
          <rect x="28" y="64" width="44" height="4" />
          <rect x="25" y="69" width="50" height="5" />
        </g>
      </svg>
    </div>
  );
}

// ------------------------------------------------------------------ story graphics (Nov 9: more graphics, more bounce)

/** Simple icon glyphs drawn in code (100x100). */
function Glyph({ k, c }) {
  const g = {
    health: <path d="M50 82 L18 50 Q8 38 18 26 Q30 14 44 24 L50 30 L56 24 Q70 14 82 26 Q92 38 82 50 Z" fill={c} />,
    school: <g fill={c}><path d="M50 30 Q38 18 26 28 Q12 42 22 64 Q32 86 50 78 Q68 86 78 64 Q88 42 74 28 Q62 18 50 30 Z" /><path d="M50 30 Q52 18 62 12" stroke={c} strokeWidth="5" fill="none" /></g>,
    house: <g fill={c}><path d="M14 50 L50 18 L86 50 L78 50 L78 84 L22 84 L22 50 Z" /><rect x="42" y="60" width="16" height="24" fill="#fff" /></g>,
    money: <g><circle cx="50" cy="50" r="34" fill={c} /><text x="50" y="66" textAnchor="middle" fontSize="46" fontFamily="Arial Black, Arial" fill="#fff">$</text></g>,
    work: <g fill={c}><rect x="14" y="34" width="72" height="48" rx="6" /><path d="M36 34 V24 H64 V34" stroke={c} strokeWidth="7" fill="none" /><rect x="14" y="52" width="72" height="5" fill="#fff" /></g>,
    shield: <path d="M50 12 L84 24 Q84 66 50 88 Q16 66 16 24 Z" fill={c} />,
    leaf: <g><path d="M20 80 Q20 24 82 18 Q84 74 28 80 Z" fill={c} /><path d="M24 76 L64 36" stroke="#fff" strokeWidth="4" /></g>,
    bus: <g fill={c}><rect x="20" y="16" width="60" height="58" rx="10" /><rect x="28" y="26" width="44" height="22" fill="#fff" /><circle cx="32" cy="80" r="7" /><circle cx="68" cy="80" r="7" /></g>,
    scales: <g stroke={c} strokeWidth="6" fill="none"><path d="M50 16 V82 M28 82 H72 M18 30 H82" /><path d="M18 30 L8 56 H28 Z M82 30 L72 56 H92 Z" fill={c} /></g>,
    people: <g fill={c}><circle cx="34" cy="34" r="12" /><circle cx="66" cy="34" r="12" /><path d="M12 80 Q14 52 34 52 Q54 52 56 80 Z" /><path d="M44 80 Q46 52 66 52 Q86 52 88 80 Z" /></g>,
    science: <g stroke={c} strokeWidth="7" fill="none" strokeLinecap="round"><path d="M34 14 Q66 32 34 50 Q2 68 34 86" /><path d="M66 14 Q34 32 66 50 Q98 68 66 86" /><path d="M38 26 H62 M38 74 H62 M44 50 H56" /></g>,
    child: <g fill={c}><circle cx="50" cy="28" r="15" /><path d="M22 86 Q24 48 50 48 Q76 48 78 86 Z" /><circle cx="26" cy="58" r="7" /><circle cx="74" cy="58" r="7" /></g>,
    senior: <g fill={c}><circle cx="42" cy="22" r="12" /><path d="M26 88 L34 44 Q42 36 52 44 L58 88 Z" /><path d="M66 46 Q78 46 78 58 V88" stroke={c} strokeWidth="6" fill="none" strokeLinecap="round" /></g>,
    drop: <path d="M50 10 Q78 46 78 62 A28 28 0 0 1 22 62 Q22 46 50 10 Z" fill={c} />,
    wheat: <g stroke={c} strokeWidth="6" fill={c} strokeLinecap="round"><path d="M50 90 V34" fill="none" />{[36, 50, 64].map((y) => <g key={y}><ellipse cx="38" cy={y} rx="9" ry="5" transform={`rotate(-35 38 ${y})`} /><ellipse cx="62" cy={y} rx="9" ry="5" transform={`rotate(35 62 ${y})`} /></g>)}<ellipse cx="50" cy="20" rx="6" ry="10" /></g>,
    wifi: <g stroke={c} strokeWidth="9" fill="none" strokeLinecap="round"><path d="M14 44 Q50 10 86 44" /><path d="M28 58 Q50 38 72 58" /><circle cx="50" cy="76" r="6" fill={c} /></g>,
    bolt: <path d="M58 8 L22 56 H46 L40 92 L78 42 H54 Z" fill={c} />,
    ballot: <g fill={c}><rect x="14" y="48" width="72" height="40" rx="5" /><rect x="30" y="42" width="40" height="6" fill="#fff" /><path d="M36 14 H64 V44 H36 Z" /><path d="M42 28 L48 34 L58 22" stroke="#fff" strokeWidth="5" fill="none" strokeLinecap="round" /></g>,
    star: <path d="M50 10 L61 38 L91 39 L67 58 L76 88 L50 70 L24 88 L33 58 L9 39 L39 38 Z" fill={c} />,
    capitol: <g fill={c}><rect x="47.5" y="14" width="5" height="9" /><path d="M30 46 Q30 24 50 23 Q70 24 70 46 Z" /><rect x="26" y="46" width="48" height="5" />{[30, 38, 46, 54, 62, 70].map((x) => <rect key={x} x={x - 2} y="53" width="4" height="18" />)}<rect x="22" y="72" width="56" height="5" /><rect x="18" y="78" width="64" height="6" /></g>,
  }[k];
  return <svg viewBox="0 0 100 100" width="100%" height="100%">{g || null}</svg>;
}

/** Icon stickers on the card's corners for what the line is about: pop in with a bounce, then bob. */
function Icons({ icons, L, look, fps, seg }) {
  const frame = useCurrentFrame();
  const d = Math.round(L.badge * (L.v ? 1.05 : 0.9));
  const spots = [{ x: L.card.x + L.card.w - d * 0.7, y: L.card.y - d * 0.45 }, { x: L.card.x - d * 0.25, y: L.card.y - d * 0.4 }];
  const ring = [look.sections.c?.bg || look.accent, look.sections.b?.bg || look.accent];
  return <>{icons.slice(0, 2).map((k, i) => {
    const s = sp(frame, fps, Math.round((0.35 + i * 0.25) * fps), { damping: 7, stiffness: 190, mass: 0.7 });
    const bob = Math.sin((frame / fps) * 2.4 + i * 1.7) * d * 0.05;
    const col = ring[i % 2] === '#ffffff' ? look.dark : ring[i % 2];
    return (
      <div key={k} style={{ position: 'absolute', left: spots[i].x, top: spots[i].y + bob, width: d, height: d, transform: `scale(${s}) rotate(${interpolate(s, [0, 1], [-40, i ? 8 : -8])}deg)`, borderRadius: '50%', background: '#fff', boxShadow: `0 ${d * 0.06}px 0 ${look.dark}`, border: `${Math.max(4, d * 0.06)}px solid ${col}`, padding: d * 0.18, boxSizing: 'border-box' }}>
        <Glyph k={k} c={col} />
      </div>
    );
  })}</>;
}

/** The line's graphic, under the footage card (or above the captions on full-screen looks): a credential card, a stat
 *  badge, a quote's attribution, or a callout of their own words. Springs in with an overshoot. */
function Tag({ tag, L, look, fps, seg }) {
  const frame = useCurrentFrame();
  const full0 = look.layout === 'full'; const wait = full0 && seg.plate ? 3.35 : 0.45;
  if (full0 && seg.plate && seg.dur < 4.6) return null; // no room beside the name on a short opening line
  const s = sp(frame, fps, Math.round(wait * fps), { damping: 8, stiffness: 180, mass: 0.8 });
  const S = schemeOf(look, seg.bg); const v = L.v; const u = (v ? 1.4 : 0.9) * (look.density === 'minimal' ? 0.82 : 1);
  const full = look.layout === 'full';
  const plateBelow = seg.plate && !L.plate.inside && look.plate !== 'none';
  const top = full ? Math.round(L.card.h * (v ? 0.735 : 0.6)) : L.card.y + L.card.h + (v ? 26 : 10) + (plateBelow ? Math.round(L.plate.size * (v ? 2.2 : 1.9)) : 0);
  const left = full ? (v ? 64 : 90) : L.card.x + (v ? 30 : 40);
  const wrap = { position: 'absolute', left, top, transformOrigin: '0% 50%', transform: `rotate(${interpolate(s, [0, 1], [-10, look.card.tilt ? -2 : 0])}deg) scale(${s})` };
  const dark = look.dark; const light = look.light; const key = S.key; const keyText = S.keyText;
  if (tag.kind === 'credential') return (
    <div style={{ ...wrap, display: 'flex', alignItems: 'center', gap: 18 * u, background: light, borderRadius: 14, padding: `${12 * u}px ${26 * u}px ${12 * u}px ${12 * u}px`, boxShadow: `0 ${8 * u}px 0 ${dark}` }}>
      <div style={{ width: 70 * u, height: 70 * u, borderRadius: '50%', background: key, padding: 12 * u, boxSizing: 'border-box' }}><Glyph k="school" c={keyText} /></div>
      <div>
        <div style={{ fontFamily: look.fonts.head, fontSize: 46 * u, lineHeight: 1, color: dark, textTransform: 'uppercase' }}>{tag.title}</div>
        {tag.sub ? <div style={{ fontFamily: look.fonts.body, fontSize: 24 * u, color: look.sections.c?.bg || look.accent, textTransform: 'uppercase', marginTop: 4 }}>{tag.sub}</div> : null}
      </div>
    </div>
  );
  if (tag.kind === 'bill') return (
    <div style={{ ...wrap, display: 'flex', alignItems: 'center', gap: 16 * u, background: light, borderRadius: 12, padding: `${10 * u}px ${24 * u}px ${10 * u}px ${10 * u}px`, boxShadow: `0 ${8 * u}px 0 ${dark}`, borderLeft: `${10 * u}px solid ${key}` }}>
      <div style={{ width: 58 * u, height: 58 * u, padding: 6 * u, boxSizing: 'border-box' }}><Glyph k="capitol" c={dark} /></div>
      <div>
        <div style={{ fontFamily: look.fonts.head, fontSize: 38 * u, lineHeight: 1.05, color: dark, textTransform: 'uppercase', maxWidth: L.card.w * 0.7 }}>{tag.title}</div>
        {tag.status ? <div style={{ display: 'inline-block', fontFamily: look.fonts.body, fontWeight: 800, fontSize: 20 * u, color: keyText, background: key, textTransform: 'uppercase', letterSpacing: '0.05em', padding: `${2 * u}px ${10 * u}px`, marginTop: 5 * u, borderRadius: 4 }}>{tag.status}</div> : null}
      </div>
    </div>
  );
  if (tag.kind === 'stat') return (
    <div style={{ ...wrap, background: dark, border: `${5 * u}px solid ${light}`, borderRadius: 12, padding: `${8 * u}px ${28 * u}px ${10 * u}px`, textAlign: 'center', boxShadow: `0 ${8 * u}px 0 rgba(0,0,0,0.25)` }}>
      {tag.label ? <div style={{ fontFamily: look.fonts.body, fontSize: 24 * u, color: look.accent, textTransform: 'uppercase', letterSpacing: '0.06em' }}>{tag.label}</div> : null}
      <div style={{ fontFamily: look.fonts.head, fontSize: 96 * u, lineHeight: 1, color: light }}>{tag.value}</div>
    </div>
  );
  if (tag.kind === 'quote') return (
    <div style={{ ...wrap, background: light, color: dark, fontFamily: look.fonts.body, fontWeight: 800, fontSize: 28 * u, textTransform: 'uppercase', letterSpacing: '0.03em', padding: `${10 * u}px ${24 * u}px`, borderRadius: 8, boxShadow: `0 ${6 * u}px 0 ${dark}` }}>— {tag.by}</div>
  );
  return (
    <div style={{ ...wrap, background: key, color: keyText, fontFamily: look.fonts.head, fontSize: 40 * u, textTransform: 'uppercase', padding: `${4 * u}px ${20 * u}px`, borderRadius: 6, boxShadow: `0 ${6 * u}px 0 ${dark}` }}>{tag.text}</div>
  );
}

/** A thin bar growing along the bottom through the ad (like the reference ads). */
function Progress({ look, fps, total, until }) {
  const frame = useCurrentFrame(); const { width: W, height: H } = useVideoConfig();
  if (frame / fps >= until) return null;
  return <div style={{ position: 'absolute', left: 0, bottom: 0, height: Math.round(H * 0.006), width: W * clamp(frame / fps / until, 0, 1), background: look.accent }} />;
}

function Ticker({ text, look, fps, until }) {
  const frame = useCurrentFrame(); const { width: W, height: H } = useVideoConfig();
  if (frame / fps >= until) return null;
  const v = H > W; const hgt = v ? 78 : 58; const top = v ? H - 300 : H - hgt;
  const unit = `${text}  •  `; const speed = v ? 110 : 140; // px per second
  const x = -((frame / fps) * speed) % (unit.length * (v ? 17 : 14));
  const s = sp(frame, fps, Math.round(0.6 * fps), { damping: 20, stiffness: 140 });
  return (
    <div style={{ position: 'absolute', left: 0, top, width: W, height: hgt, display: 'flex', transform: `translateY(${(1 - s) * hgt * 1.5}px)` }}>
      <div style={{ background: look.accent, color: look.light, fontFamily: look.fonts.head, fontSize: hgt * 0.6, display: 'flex', alignItems: 'center', padding: `0 ${hgt * 0.35}px`, textTransform: 'uppercase', zIndex: 2 }}>{v ? 'VOTE' : 'ELECTION'}</div>
      <div style={{ flex: 1, background: look.light, overflow: 'hidden', position: 'relative', display: 'flex', alignItems: 'center' }}>
        <div style={{ position: 'absolute', left: x, whiteSpace: 'nowrap', fontFamily: look.fonts.body, fontSize: hgt * 0.42, color: look.dark, textTransform: 'uppercase', letterSpacing: '0.03em' }}>{unit.repeat(12)}</div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ map and stat cards

function mix(a, b, k) { const p = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)); const x = p(a), y = p(b); return `#${x.map((v, i) => Math.round(v + (y[i] - v) * k).toString(16).padStart(2, '0')).join('')}`; }

function MapCard({ c, w, h, fps, look }) {
  const frame = useCurrentFrame(); const A = look.sections.a;
  const bg = lum(A.bg) > 0.35 ? look.dark : A.bg;
  const draw = interpolate(frame, [0, 0.9 * fps], [1, 0], { extrapolateRight: 'clamp', easing: Easing.out(Easing.cubic) });
  const fill = interpolate(frame, [0.5 * fps, 1.0 * fps], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const zoomTo = c.district?.box || (c.pin ? [c.pin[0] - c.state.box[2] * 0.18, c.pin[1] - c.state.box[3] * 0.18, c.state.box[2] * 0.36, c.state.box[3] * 0.36] : null);
  const z = zoomTo ? interpolate(frame, [1.1 * fps, 2.0 * fps], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.bezier(0.65, 0, 0.35, 1) }) : 0;
  const pad = (b, k) => [b[0] - b[2] * k, b[1] - b[3] * k, b[2] * (1 + 2 * k), b[3] * (1 + 2 * k)];
  const P0 = pad(c.state.box, 0.08); const P1 = zoomTo ? pad(zoomTo, 0.35) : P0;
  const vb = P0.map((a, i) => a + (P1[i] - a) * z);
  const scale = Math.min(w / vb[2], h / vb[3]); const ox = (w - vb[2] * scale) / 2; const oy = (h - vb[3] * scale) / 2;
  const toPx = (pt) => [ox + (pt[0] - vb[0]) * scale, oy + (pt[1] - vb[1]) * scale];
  const pinPt = c.pin || (c.district ? [c.district.box[0] + c.district.box[2] / 2, c.district.box[1] + c.district.box[3] / 2] : null);
  const pin = pinPt ? toPx(pinPt) : null;
  const ls = sp(frame, fps, Math.round((zoomTo ? 1.9 : 1.0) * fps), { damping: 14, stiffness: 180 });
  const dpop = sp(frame, fps, Math.round(1.6 * fps), { damping: 15, stiffness: 160 });
  const big = Math.round(Math.min(w, h) * 0.13);
  const lab = contrast(look.sections.b.bg, bg) >= 2 ? look.sections.b.bg : look.accent;
  const labText = contrast(lab, look.dark) >= contrast(lab, look.light) ? look.dark : look.light;
  return (
    <AbsoluteFill style={{ background: bg }}>
      <svg width={w} height={h} viewBox={vb.join(' ')} preserveAspectRatio="xMidYMid meet" style={{ position: 'absolute', inset: 0 }}>
        <path d={c.state.d} fill={bg} stroke={look.light} strokeWidth={4} vectorEffect="non-scaling-stroke" pathLength={1} strokeDasharray="1 1" strokeDashoffset={draw} strokeLinejoin="round" />
        <path d={c.state.d} fill={mix(bg, look.light, 0.12)} fillOpacity={fill} stroke="none" />
        {c.district ? <path d={c.district.d} fill={look.accent} fillOpacity={dpop} stroke={look.light} strokeWidth={3} vectorEffect="non-scaling-stroke" strokeLinejoin="round" /> : null}
      </svg>
      {pin ? (
        <svg width={64} height={84} viewBox="0 0 64 84" style={{ position: 'absolute', left: pin[0] - 32, top: pin[1] - 80, transform: `scale(${ls})`, transformOrigin: '50% 100%' }}>
          <path d="M32 82 C32 82 6 50 6 30 A26 26 0 0 1 58 30 C58 50 32 82 32 82 Z" fill={look.accent} stroke="#fff" strokeWidth="4" />
          <circle cx="32" cy="30" r="10" fill="#fff" />
        </svg>
      ) : null}
      {c.label ? (
        <div style={{ position: 'absolute', left: pin ? clamp(pin[0] + 40, 20, w - big * 4.4) : 30, top: pin ? clamp(pin[1] - big * 1.4, 20, h - big * 2) : 30, transform: `rotate(${look.card.tilt ? -3 : 0}deg) scale(${ls})`, transformOrigin: '0 50%' }}>
          <div style={{ background: lab, color: labText, fontFamily: look.fonts.head, fontSize: big * 0.62, padding: `${big * 0.06}px ${big * 0.22}px`, textTransform: 'uppercase', lineHeight: 1.05 }}>{c.label}</div>
          {c.sub ? <div style={{ background: '#fff', color: look.accent, fontFamily: look.fonts.body, fontSize: big * 0.2, padding: `${big * 0.05}px ${big * 0.22}px`, textTransform: 'uppercase', letterSpacing: '0.04em', display: 'inline-block' }}>{c.sub}</div> : null}
        </div>
      ) : null}
    </AbsoluteFill>
  );
}

function StatCard({ c, w, h, fps, look }) {
  const frame = useCurrentFrame(); const A0 = look.sections.a;
  const A = lum(A0.bg) > 0.35 ? { ...A0, bg: look.dark, text: look.light, accent: look.accent } : A0;
  const run = interpolate(frame, [0.15 * fps, 1.3 * fps], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.out(Easing.cubic) });
  const v = Number(c.value) || 0; const dec = String(c.value).includes('.') ? String(c.value).split('.')[1].length : 0;
  const shown = (v * run).toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
  const ls = sp(frame, fps, Math.round(0.9 * fps));
  const big = Math.round(Math.min(w * 0.3, h * 0.42));
  return (
    <AbsoluteFill style={{ background: A.bg, alignItems: 'center', justifyContent: 'center', flexDirection: 'column' }}>
      <div style={{ fontFamily: look.fonts.head, fontSize: big, color: A.accent, lineHeight: 1 }}>{c.prefix || ''}{shown}{c.suffix || ''}</div>
      {c.label ? <div style={{ fontFamily: look.fonts.head, fontSize: big * 0.24, color: A.text, textTransform: 'uppercase', marginTop: big * 0.08, opacity: ls, transform: `translateY(${(1 - ls) * 30}px)`, textAlign: 'center', maxWidth: w * 0.86 }}>{c.label}</div> : null}
      {c.source ? <div style={{ position: 'absolute', bottom: 18, fontFamily: look.fonts.body, fontSize: Math.max(16, big * 0.075), color: A.text, opacity: 0.75 }}>Source: {c.source}</div> : null}
    </AbsoluteFill>
  );
}

// ------------------------------------------------------------------ graphic cards (cut in while the voice carries on)

/** The dark panel the graphic cards sit on (the look's first colour, or its dark when that colour is light). */
function panel(look) { const A0 = look.sections.a; return lum(A0.bg) > 0.35 ? { bg: look.dark, text: look.light, accent: look.accent } : { bg: A0.bg, text: A0.text, accent: A0.accent }; }

/** A list of three that ticks as each one is said. Items carry the time they're spoken. */
function ChecklistCard({ c, w, h, fps, look, seg }) {
  const frame = useCurrentFrame(); const A = panel(look);
  const base = Math.round(Math.min(w * 0.12, (h * 0.72) / c.items.length / 1.5));
  const size = Math.min(...c.items.map((it) => fitWords(it.text.split(' '), look.fonts.head, base, w * 0.66, base * 1.3, { upper: true, maxLines: 1, min: 28 })));
  return (
    <AbsoluteFill style={{ background: A.bg, justifyContent: 'center', padding: `0 ${w * 0.09}px`, gap: size * 0.5 }}>
      {c.items.map((it, i) => {
        const at = Math.max(4 + i * 4, Math.round((it.t - seg.at) * fps));
        const s = sp(frame, fps, i * 4, { damping: 13, stiffness: 180 }); const tick = sp(frame, fps, at, { damping: 9, stiffness: 240 });
        return (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: size * 0.4, opacity: clamp(s * 1.6, 0, 1), transform: `translateX(${(1 - s) * -60}px)` }}>
            <div style={{ width: size * 1.05, height: size * 1.05, flex: 'none', borderRadius: size * 0.18, border: `${Math.max(4, size * 0.08)}px solid ${A.text}`, background: tick > 0.05 ? A.accent : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <svg viewBox="0 0 100 100" width="76%" height="76%" style={{ transform: `scale(${tick})` }}><path d="M18 54 L42 76 L84 26" fill="none" stroke="#fff" strokeWidth="14" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </div>
            <div style={{ fontFamily: look.fonts.head, fontSize: size, lineHeight: 1.05, color: A.text, textTransform: 'uppercase' }}>{it.text}</div>
          </div>
        );
      })}
    </AbsoluteFill>
  );
}

/** Before and after: two bars sized by the two numbers they said, the second landing as they say it. */
function CompareCard({ c, w, h, fps, look }) {
  const frame = useCurrentFrame(); const A = panel(look);
  const n = (x) => Number(String(x).replace(/[^\d.]/g, '')) || 0; const a = n(c.a), b = n(c.b); const top = Math.max(a, b) || 1;
  const g1 = sp(frame, fps, 3, { damping: 16, stiffness: 120 }); const g2 = sp(frame, fps, Math.round(0.7 * fps), { damping: 11, stiffness: 150 });
  const unit = c.unit === '%' ? '%' : c.unit ? ` ${c.unit}` : ''; const big = Math.round(Math.min(w * 0.13, h * 0.16));
  const bar = (v, g, col, label) => (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-end', height: '100%', gap: big * 0.14 }}>
      <div style={{ fontFamily: look.fonts.head, fontSize: big, lineHeight: 1, color: A.text, opacity: clamp(g * 1.5, 0, 1) }}>{String(label)}{unit}</div>
      <div style={{ width: '70%', height: `${Math.max(6, (v / top) * 62 * g)}%`, background: col, borderRadius: `${big * 0.12}px ${big * 0.12}px 0 0` }} />
    </div>
  );
  return (
    <AbsoluteFill style={{ background: A.bg, padding: `${h * 0.1}px ${w * 0.1}px 0`, flexDirection: 'row', alignItems: 'flex-end', gap: w * 0.06 }}>
      {bar(a, g1, mix(A.bg, A.text, 0.45), c.a)}{bar(b, g2, A.accent, c.b)}
    </AbsoluteFill>
  );
}

/** Two years on a line, the line drawing from the first to the second. */
function TimelineCard({ c, w, h, fps, look }) {
  const frame = useCurrentFrame(); const A = panel(look);
  const p = interpolate(frame, [0.25 * fps, 1.3 * fps], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.bezier(0.6, 0, 0.3, 1) });
  const s1 = sp(frame, fps, 2, { damping: 11, stiffness: 180 }); const s2 = sp(frame, fps, Math.round(1.25 * fps), { damping: 9, stiffness: 200 });
  const big = Math.round(Math.min(w * 0.14, h * 0.2)); const x0 = w * 0.24; const x1 = w * 0.76; const y = h * 0.6; const dot = big * 0.3;
  return (
    <AbsoluteFill style={{ background: A.bg }}>
      <div style={{ position: 'absolute', left: x0, top: y - 4, width: x1 - x0, height: 8, background: mix(A.bg, A.text, 0.25) }} />
      <div style={{ position: 'absolute', left: x0, top: y - 4, width: (x1 - x0) * p, height: 8, background: A.accent }} />
      {[[x0, c.from, s1, A.text], [x1, c.to, s2, A.accent]].map(([x, label, s, col], i) => (
        <React.Fragment key={i}>
          <div style={{ position: 'absolute', left: x - dot / 2, top: y - dot / 2, width: dot, height: dot, borderRadius: '50%', background: col, transform: `scale(${s})` }} />
          <div style={{ position: 'absolute', left: x - big * 1.5, width: big * 3, top: y - big * 1.5, textAlign: 'center', fontFamily: look.fonts.head, fontSize: big, lineHeight: 1, color: col, transform: `translateY(${(1 - s) * 30}px)`, opacity: clamp(s * 1.5, 0, 1) }}>{label}</div>
        </React.Fragment>
      ))}
    </AbsoluteFill>
  );
}

/** A press clipping: a real headline from the research, as a paper cut-out with the outlet's name and date. */
function ClipCard({ c, w, h, fps, look }) {
  const frame = useCurrentFrame(); const A = panel(look);
  const s = sp(frame, fps, 2, { damping: 12, stiffness: 150 }); const pw = w * 0.84; const pad = pw * 0.07;
  const size = fitWords(String(c.title).split(/\s+/), 'Georgia', Math.round(Math.min(w * 0.075, h * 0.1)), pw - pad * 2, h * 0.46, { maxLines: 6, min: 22, lh: 1.2, gap: 0.26 });
  const hl = interpolate(frame, [0.5 * fps, 1.2 * fps], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  // A torn lower edge, the same every frame.
  const teeth = Array.from({ length: 28 }, (_, i) => `${(i / 27) * 100}% ${100 - (Math.abs(Math.sin(i * 12.9898) * 43758.5453) % 1) * 3.2}%`).join(', ');
  return (
    <AbsoluteFill style={{ background: A.bg, alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ width: pw, background: '#f6f1e4', color: '#16161a', padding: `${pad * 0.8}px ${pad}px ${pad * 1.3}px`, boxShadow: '0 18px 0 rgba(0,0,0,0.28)', transform: `rotate(${interpolate(s, [0, 1], [-7, -1.6])}deg) scale(${interpolate(s, [0, 1], [0.7, 1])})`, opacity: clamp(s * 1.6, 0, 1), clipPath: `polygon(0 0, 100% 0, ${teeth.split(', ').reverse().join(', ')})` }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', borderBottom: '3px solid #16161a', paddingBottom: size * 0.2, marginBottom: size * 0.35 }}>
          <div style={{ fontFamily: look.fonts.head, fontSize: size * 0.62, textTransform: 'uppercase', letterSpacing: '0.02em' }}>{c.outlet}</div>
          {c.date ? <div style={{ fontFamily: look.fonts.body, fontSize: size * 0.3, opacity: 0.7 }}>{c.date}</div> : null}
        </div>
        <div style={{ fontFamily: 'Georgia, "Times New Roman", serif', fontWeight: 700, fontSize: size, lineHeight: 1.2, backgroundImage: `linear-gradient(${look.accent}66, ${look.accent}66)`, backgroundRepeat: 'no-repeat', backgroundSize: `${hl * 100}% 38%`, backgroundPosition: '0 88%', display: 'inline' }}>{c.title}</div>
      </div>
    </AbsoluteFill>
  );
}

// ------------------------------------------------------------------ end card

function EndCard({ e, look, fps, L }) {
  const frame = useCurrentFrame(); const { width: W, height: H } = useVideoConfig();
  const A = look.sections.a; const B = look.sections.b; const M = MOTION[look.motion] || MOTION.snappy;
  const a = sp(frame, fps, 2, { damping: 18, stiffness: 120 });
  const big = L.v ? 168 : 150;
  const at = (k) => sp(frame, fps, 6 + k * 5, M.word);
  const up = look.head.case === 'upper';
  const nameSize = fitWords(String(e.name || '').split(/\s+/), look.fonts.head, big, W * 0.88, big * 2.3, { upper: up, maxLines: 2, gap: 0.25 });
  let deco = null;
  if (look.end === 'split') deco = <AbsoluteFill style={{ background: B.bg, clipPath: `polygon(${W * 0.62 + (1 - a) * W}px 0, ${W}px 0, ${W}px ${H}px, ${W * 0.22 + (1 - a) * W}px ${H}px)` }} />;
  if (look.end === 'stripes') deco = (
    <AbsoluteFill>{Array.from({ length: 7 }).map((_, i) => { const s = sp(frame, fps, 2 + i * 2, { damping: 20, stiffness: 140 }); return <div key={i} style={{ position: 'absolute', left: 0, top: i * (H * 0.035), width: W * s, height: H * 0.035, background: i % 2 ? look.light : look.accent }} />; })}</AbsoluteFill>
  );
  const brand = look.end === 'brand';
  const nameColor = brand ? (contrast(look.accent, A.bg) >= 2 ? look.accent : A.text) : A.text;
  const pd = Math.round(Math.min(W, H) * (L.v ? 0.44 : 0.34)); const ps = sp(frame, fps, 1, { damping: 8, stiffness: 150 });
  return (
    <AbsoluteFill>
      {deco}
      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: big * 0.08, paddingTop: look.end === 'stripes' ? H * 0.12 : 0 }}>
        {e.portrait && !brand ? (
          <div style={{ width: pd, height: pd, borderRadius: '50%', border: `${Math.round(pd * 0.07)}px solid ${B.bg === A.bg ? look.accent : B.bg}`, overflow: 'hidden', transform: `scale(${ps})`, boxShadow: `0 ${pd * 0.04}px 0 ${look.dark}`, marginBottom: big * 0.1, background: look.dark }}>
            <OffthreadVideo src={e.portrait.src} muted startFrom={Math.round((e.portrait.from || 0) * fps)} style={{ width: '100%', height: '100%', objectFit: 'cover', objectPosition: `${Math.round((e.portrait.fx ?? 0.5) * 100)}% 30%`, filter: GRADE[look.grade] || 'none' }} />
          </div>
        ) : null}
        {e.cta && !brand ? <div style={{ fontFamily: look.fonts.head, fontSize: big * 0.42, color: A.keyText, background: A.key, padding: `0 ${big * 0.12}px`, borderRadius: look.card.radius ? 12 : 0, transform: `rotate(${-2 * M.rot}deg) scale(${at(0)})`, textTransform: up ? 'uppercase' : 'none' }}>{e.cta}</div> : null}
        <div style={{ fontFamily: look.fonts.head, fontSize: nameSize, color: nameColor, textTransform: up ? 'uppercase' : 'none', lineHeight: 0.98, textAlign: 'center', maxWidth: W * 0.9, transform: `translateY(${(1 - at(1)) * 80}px)`, opacity: clamp(at(1) * 1.5, 0, 1) }}>
          {look.end === 'split' ? <Outlined stroke={look.dark} width={10} color={nameColor}>{e.name}</Outlined> : e.name}
        </div>
        {e.for ? <div style={{ fontFamily: look.fonts.head, fontSize: big * 0.36, lineHeight: 1, color: contrast(look.accent, A.bg) >= 2 ? look.accent : A.text, textTransform: up ? 'uppercase' : 'none', transform: `scale(${at(2)})` }}>{e.for}</div> : null}
        {e.sub ? <div style={{ fontFamily: look.fonts.body, fontSize: big * 0.2, color: look.dark, background: look.light === A.bg ? B.bg : look.light, padding: `${big * 0.04}px ${big * 0.16}px`, textTransform: 'uppercase', letterSpacing: '0.04em', transform: `scale(${at(2)})` }}>{e.sub}</div> : null}
        {e.line ? <div style={{ fontFamily: look.fonts.head, fontSize: fitWords(String(e.line).split(/\s+/), look.fonts.head, Math.round(big * 0.34), W * 0.8, big * 0.9, { upper: up, maxLines: 2, min: 24 }), lineHeight: 1.12, color: brand ? A.text : look.light, background: brand ? 'transparent' : look.dark, padding: brand ? 0 : `${big * 0.06}px ${big * 0.16}px`, textTransform: up ? 'uppercase' : 'none', textAlign: 'center', maxWidth: W * 0.82, marginTop: big * 0.08, opacity: clamp(at(4) * 1.4, 0, 1), transform: `translateY(${(1 - at(4)) * 40}px)` }}>“{String(e.line).replace(/[.!]+$/, '')}{/!$/.test(String(e.line)) ? '!' : '.'}”</div> : null}
        {e.date ? <div style={{ fontFamily: look.fonts.body, fontWeight: 800, fontSize: big * 0.2, color: A.text, textTransform: 'uppercase', letterSpacing: '0.05em', marginTop: big * 0.06, opacity: at(4) }}>{e.date}</div> : null}
        {e.site ? <div style={{ fontFamily: look.fonts.body, fontSize: big * 0.17, color: A.text, marginTop: big * 0.06, opacity: at(3) }}>{e.site}</div> : null}
      </AbsoluteFill>
      {e.tag ? <div style={{ position: 'absolute', bottom: L.v ? 70 : 26, width: '100%', textAlign: 'center', fontFamily: look.fonts.body, fontSize: L.v ? 22 : 18, color: A.text, opacity: 0.8 * at(4) }}>{e.tag}</div> : null}
    </AbsoluteFill>
  );
}

// ------------------------------------------------------------------ the ad

export const PoliticalAd = ({ spec }) => {
  const { fps, width: W, height: H } = useVideoConfig();
  const fontsReady = useFonts(spec?.fonts);
  const frame = useCurrentFrame();
  if (!spec || !fontsReady) return <AbsoluteFill style={{ background: FALLBACK.sections.a.bg }} />;
  const look = spec.look || { ...FALLBACK, fonts: { head: spec.fontHead || 'Anton', body: spec.fontBody || 'Montserrat', cap: spec.fontHead || 'Anton' } };
  const L = layout(W, H, look);
  const segs = spec.segs || [];
  const F = (s) => Math.round(s * fps);
  const keyTimes = (spec.segs || []).flatMap((s) => (s.head?.words || []).filter((w) => w.key && w.t != null).map((w) => w.t));
  const capsInCard = (look.cap.pos === 'card' && look.layout !== 'full') || (look.layout === 'letterbox' && W > H);
  const t = frame / fps; const now = segAt(segs, t);
  const dens = look.density || 'full';
  return (
    <AbsoluteFill style={{ overflow: 'hidden' }}>
      <Background segs={segs} endCard={spec.end} look={look} fps={fps} />
      {dens !== 'minimal' ? <FlairUnder segs={segs} look={look} L={L} fps={fps} endAt={spec.end?.at} /> : null}
      {segs.map((seg, i) => (
        <Sequence key={`s${i}`} from={F(seg.at)} durationInFrames={Math.max(1, F(seg.at + seg.dur) - F(seg.at))} layout="none">
          <Card seg={{ ...seg, idx: i, cut: i > 0 && segs[i - 1].card?.src !== seg.card?.src }} prevTilt={i > 0 && !seg.enter ? segs[i - 1].tilt : null} L={L} look={look} fps={fps} keyTimes={keyTimes}>
            {seg.noCaptions || !capsInCard ? null : <Captions words={spec.words} L={L} look={look} fps={fps} seg={seg} offset={F(seg.at)} inCard />}
          </Card>
          {seg.pill && look.pill !== 'none' ? <Pill text={seg.pill} L={L} look={look} fps={fps} seg={seg} right={!L.v || !!seg.plate} /> : null}
          {seg.badge && look.badge ? <Badge L={L} look={look} fps={fps} /> : null}
          {seg.icons?.length && seg.card?.kind === 'video' && look.layout !== 'full' && dens === 'full' && (i === 0 || segs[i - 1].icons?.join() !== seg.icons.join() || segs[i - 1].card?.kind !== 'video') ? <Icons icons={seg.icons} L={L} look={look} fps={fps} seg={seg} /> : null}
          {seg.tag ? <Tag tag={seg.tag} L={L} look={look} fps={fps} seg={seg} /> : null}
        </Sequence>
      ))}
      {!capsInCard && now && !now.noCaptions ? <Captions words={spec.words} L={L} look={look} fps={fps} seg={now} offset={0} /> : null}
      {segs.map((seg, i) => seg.plate && look.plate !== 'none' ? (
        <Sequence key={`p${i}`} from={F(seg.at)} durationInFrames={Math.max(1, F(seg.at + seg.dur) - F(seg.at))} layout="none">
          <Plate seg={seg} L={L} look={look} fps={fps} name={spec.name} office={spec.office} />
        </Sequence>
      ) : null)}
      {now ? <Headline seg={now} L={L} look={look} fps={fps} /> : null}
      {!look.ticker ? <Progress look={look} fps={fps} total={spec.total} until={spec.end ? spec.end.at : spec.total} /> : null}
      {look.ticker && spec.ticker ? <Ticker text={spec.ticker} look={look} fps={fps} until={spec.end ? spec.end.at : spec.total} /> : null}
      {dens === 'full' ? <FlairOver segs={segs} look={look} L={L} fps={fps} spec={spec} /> : null}
      {spec.end ? (
        <Sequence from={F(spec.end.at)} durationInFrames={Math.max(1, F(spec.end.dur))} layout="none">
          <EndCard e={spec.end} look={look} fps={fps} L={L} />
          <EndFlair look={look} fps={fps} L={L} name={spec.end.name} />
        </Sequence>
      ) : null}
      <TransitionFX segs={segs} look={look} fps={fps} endAt={spec.end?.at} />
      {['grain', 'scanlines'].includes(look.texture) ? <Texture kind={look.texture} look={look} /> : null}
      {(spec.voice || []).map((v, i) => (
        <Sequence key={`v${i}`} from={F(v.at)} durationInFrames={Math.max(1, F(v.dur))} layout="none">
          <Audio src={v.src} />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};
