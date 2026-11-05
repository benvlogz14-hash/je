// The political ad: flat colour sections that wipe diagonally, a condensed caps headline that builds word by word with the
// voice (key words boxed), the footage in a tilted white card over an offset colour block, word captions inside the card
// with the spoken word boxed, a name plate, place pills, a seal-style badge, a district map, a stat counter and an end card.
// Motion follows hold → travel → hold: everything arrives on a spring, settles, and nothing drifts while it's being read.
// Only spring() and interpolate() drive motion (frame-exact renders; no CSS animations).
import React, { useEffect, useMemo, useState } from 'react';
import { AbsoluteFill, Audio, Img, OffthreadVideo, Sequence, continueRender, delayRender, interpolate, spring, useCurrentFrame, useVideoConfig, Easing } from 'remotion';

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const DEFAULT_PAL = { navy: '#1f2b6e', yellow: '#f6c431', red: '#ef5a3a', white: '#ffffff', ink: '#111522' };

/** Which colours go with each section colour: the block behind the card, key-word boxes, headline text. */
function scheme(bg, pal) {
  const P = { ...DEFAULT_PAL, ...pal };
  if (bg === 'yellow') return { bg: P.yellow, block: P.red, key: P.navy, keyText: P.white, text: P.navy, plate: P.navy, plateText: P.white, plateEdge: P.red, capKey: P.red };
  if (bg === 'red') return { bg: P.red, block: P.navy, key: P.navy, keyText: P.white, text: P.white, plate: P.navy, plateText: P.white, plateEdge: P.yellow, capKey: P.navy };
  if (bg === 'white') return { bg: P.white, block: P.navy, key: P.red, keyText: P.white, text: P.navy, plate: P.navy, plateText: P.white, plateEdge: P.yellow, capKey: P.red };
  return { bg: P.navy, block: P.yellow, key: P.red, keyText: P.white, text: P.white, plate: P.navy, plateText: P.white, plateEdge: P.yellow, capKey: P.red };
}

/** Where things sit, for a tall (9:16) or wide (16:9) frame. */
export function layout(w, h) {
  if (h > w) {
    const card = { x: Math.round(w * 0.045), y: Math.round(h * 0.285), w: Math.round(w * 0.91), h: Math.round(h * 0.44) };
    return { v: true, head: { x: 60, y: Math.round(h * 0.07), w: w - 120, h: Math.round(h * 0.2), size: 112, lines: 3 }, card, cap: 84, plate: { x: card.x + 24, y: card.y + card.h + 54, size: 62 }, pill: { x: card.x + card.w - 30, y: card.y + card.h + 62 }, badge: 150 };
  }
  const card = { x: Math.round((w - 1120) / 2), y: Math.round(h * 0.25), w: 1120, h: Math.round(h * 0.59) };
  return { v: false, head: { x: 120, y: 22, w: w - 240, h: Math.round(h * 0.215), size: 92, lines: 2 }, card, cap: 66, plate: { x: card.x - 70, y: card.y + card.h - 30, size: 52 }, pill: { x: card.x + card.w + 40, y: card.y + card.h - 10 }, badge: 130 };
}

function useFonts(fonts) {
  const [handle] = useState(() => delayRender('Loading fonts'));
  useEffect(() => {
    const list = (fonts || []).map((f) => new FontFace(f.family, `url("${f.url}")`, { weight: f.weight || 'normal' }).load().then((ff) => document.fonts.add(ff)).catch(() => null));
    Promise.all(list).then(() => continueRender(handle));
  }, []);
}

const sp = (frame, fps, at, cfg = {}) => spring({ frame: frame - at, fps, config: { damping: 16, stiffness: 170, mass: 0.8, ...cfg } });

// ------------------------------------------------------------------ background with diagonal wipes

function Background({ segs, endCard, pal, fps }) {
  const frame = useCurrentFrame(); const { width: W, height: H } = useVideoConfig();
  const t = frame / fps;
  const all = [...segs, ...(endCard ? [{ at: endCard.at, dur: endCard.dur, bg: endCard.bg || 'navy', wipe: true }] : [])];
  let i = all.findIndex((s) => t >= s.at && t < s.at + s.dur); if (i < 0) i = t < (all[0]?.at || 0) ? 0 : all.length - 1;
  const cur = all[i]; const prev = all[i - 1];
  const now = scheme(cur.bg, pal).bg;
  const local = frame - Math.round(cur.at * fps);
  const wiping = prev && prev.bg !== cur.bg && local < 14;
  if (!wiping) return <AbsoluteFill style={{ background: now }} />;
  const p = interpolate(local, [0, 11], [0, 1], { extrapolateRight: 'clamp', easing: Easing.bezier(0.7, 0, 0.2, 1) });
  const slant = H * 0.45; const span = W + slant + 120;
  const edge = p * span - slant; // x of the wipe edge at the top
  const band = scheme(cur.bg, pal).block;
  return (
    <AbsoluteFill style={{ background: scheme(prev.bg, pal).bg }}>
      <AbsoluteFill style={{ background: band, clipPath: `polygon(0 0, ${edge + 110}px 0, ${edge + 110 + slant}px ${H}px, 0 ${H}px)` }} />
      <AbsoluteFill style={{ background: now, clipPath: `polygon(0 0, ${edge}px 0, ${edge + slant}px ${H}px, 0 ${H}px)` }} />
    </AbsoluteFill>
  );
}

// ------------------------------------------------------------------ headline

function Headline({ seg, L, pal, fps, fontHead }) {
  const frame = useCurrentFrame();
  const head = seg.head; if (!head?.words?.length) return null;
  const S = scheme(seg.bg, pal);
  const chars = head.words.reduce((n, x) => n + x.w.length + 1, 0);
  // Biggest size whose wrapped lines fit the headline area (Anton caps average ~0.47 em wide).
  let size = L.head.size;
  while (size > 50 && Math.ceil((chars * 0.47 * size) / (L.head.w * 0.9)) * size * 1.06 > L.head.h) size -= 2;
  size = Math.round(size * (head.scale || 1));
  return (
    <div style={{ position: 'absolute', left: L.head.x, top: L.head.y, width: L.head.w, height: L.head.h, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', alignItems: 'center', columnGap: size * 0.22, rowGap: size * 0.06, fontFamily: fontHead, fontSize: size, lineHeight: 1.02, color: S.text, textTransform: 'uppercase', letterSpacing: '0.005em', textAlign: 'center' }}>
        {head.words.map((x, k) => {
          const at = Math.round((x.t != null ? x.t : seg.at + 0.06 + k * 0.07) * fps);
          const s = sp(frame, fps, at, { damping: 14, stiffness: 210 });
          const shown = frame >= at;
          const box = x.key ? { background: S.key, color: S.keyText, padding: `0 ${size * 0.1}px`, transform: `rotate(-1.5deg) scale(${interpolate(s, [0, 1], [0.6, 1])})` } : { transform: `translateY(${interpolate(s, [0, 1], [size * 0.35, 0])}px)` };
          return <span key={k} style={{ display: 'inline-block', opacity: shown ? clamp(s * 1.6, 0, 1) : 0, ...box }}>{x.w}</span>;
        })}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ the card

function Outlined({ children, stroke, width, color }) {
  return (
    <span style={{ position: 'relative', display: 'inline-block' }}>
      <span style={{ position: 'absolute', inset: 0, WebkitTextStroke: `${width}px ${stroke}`, color: stroke }}>{children}</span>
      <span style={{ position: 'relative', color }}>{children}</span>
    </span>
  );
}

function CardContent({ seg, card, fps, w, h, base, pal, fontHead, fontBody }) {
  const frame = useCurrentFrame(); const t = frame / fps; // frame is relative to the segment
  const c = seg.card || {};
  if (c.kind === 'video' || c.kind === 'photo') {
    const push = c.pushLen ? 1 + 0.06 * clamp((seg.at + t - c.pushAt) / c.pushLen, 0, 1) : 1 + 0.05 * clamp(t / seg.dur, 0, 1);
    const style = { width: '100%', height: '100%', objectFit: 'cover', objectPosition: `${Math.round((c.fx ?? 0.5) * 100)}% ${Math.round((c.fy ?? 0.35) * 100)}%`, transform: `scale(${push})`, transformOrigin: `${Math.round((c.fx ?? 0.5) * 100)}% 40%` };
    return c.kind === 'photo' ? <Img src={c.src} style={style} /> : <OffthreadVideo src={c.src} muted startFrom={Math.round((c.from || 0) * fps)} style={style} />;
  }
  if (c.kind === 'map') return <MapCard c={c} w={w} h={h} fps={fps} pal={pal} fontHead={fontHead} fontBody={fontBody} />;
  if (c.kind === 'stat') return <StatCard c={c} w={w} h={h} fps={fps} pal={pal} fontHead={fontHead} fontBody={fontBody} seg={seg} />;
  return <AbsoluteFill style={{ background: scheme('navy', pal).bg }} />;
}

function Card({ seg, prevTilt, L, pal, fps, base, fontHead, fontBody, children }) {
  const frame = useCurrentFrame(); // relative to the segment
  const S = scheme(seg.bg, pal);
  const enter = seg.enter ? sp(frame, fps, 0, { damping: 15, stiffness: 120 }) : 1;
  const tiltS = sp(frame, fps, 0, { damping: 18, stiffness: 160 });
  const tilt = interpolate(tiltS, [0, 1], [prevTilt ?? seg.tilt ?? 0, seg.tilt ?? 0]);
  const punch = seg.enter ? 1 : 1 + 0.03 * (1 - sp(frame, fps, 0, { damping: 13, stiffness: 220 }));
  const { x, y, w, h } = L.card; const border = L.v ? 12 : 10;
  const ty = interpolate(enter, [0, 1], [L.v ? 900 : 700, 0]); const rot = tilt + interpolate(enter, [0, 1], [10, 0]);
  return (
    <div style={{ position: 'absolute', left: x, top: y, width: w, height: h, transform: `translateY(${ty}px) rotate(${rot}deg) scale(${punch})` }}>
      <div style={{ position: 'absolute', left: 26, top: 30, width: w, height: h, background: S.block, transform: 'rotate(1.4deg)' }} />
      <div style={{ position: 'absolute', inset: 0, background: '#fff', boxShadow: '0 22px 50px rgba(0,0,0,0.28)' }}>
        <div style={{ position: 'absolute', inset: border, overflow: 'hidden', background: '#0c1020' }}>
          <CardContent seg={seg} fps={fps} w={w - border * 2} h={h - border * 2} base={base} pal={pal} fontHead={fontHead} fontBody={fontBody} />
          {children}
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ captions in the card (spoken word boxed)

function chunkWords(words) {
  const out = []; let cur = [];
  const flush = () => { if (cur.length) out.push(cur); cur = []; };
  words.forEach((x, i) => {
    const prev = words[i - 1];
    if (cur.length && (cur.length >= 3 || x.s - prev.e > 0.4 || x.b !== prev.b || cur.map((c) => c.w).join(' ').length + x.w.length > 15)) flush();
    cur.push(x);
    if (/[.!?,;:]["”']?$/.test(x.w)) flush();
  });
  flush();
  return out;
}

function Captions({ words, L, pal, fps, fontHead, seg, offset }) {
  const frame = useCurrentFrame() + offset; const t = frame / fps; // absolute time
  const chunks = useMemo(() => chunkWords(words || []), [words]);
  const k = chunks.findIndex((c, i) => t >= c[0].s - 0.04 && t < Math.min(chunks[i + 1] ? chunks[i + 1][0].s - 0.04 : Infinity, c[c.length - 1].e + 0.45));
  if (k < 0) return null;
  const S = scheme(seg.bg, pal);
  const c = chunks[k]; const at = Math.round((c[0].s - 0.04) * fps);
  const s = sp(frame, fps, at, { damping: 14, stiffness: 240 });
  const size = L.cap;
  return (
    <div style={{ position: 'absolute', left: 0, right: 0, bottom: L.card.h * 0.07, display: 'flex', justifyContent: 'center', gap: size * 0.22, fontFamily: fontHead, fontSize: size, lineHeight: 1.1, textTransform: 'uppercase', transform: `scale(${interpolate(s, [0, 1], [0.86, 1])})` }}>
      {c.map((x, i) => {
        const on = t >= x.s - 0.03 && (i === c.length - 1 || t < c[i + 1].s - 0.03);
        const pop = on ? sp(frame, fps, Math.round((x.s - 0.03) * fps), { damping: 12, stiffness: 260 }) : 1;
        return on
          ? <span key={i} style={{ display: 'inline-block', background: S.capKey, color: '#fff', padding: `0 ${size * 0.1}px`, transform: `rotate(-2deg) scale(${interpolate(pop, [0, 1], [1.18, 1])})` }}>{x.w}</span>
          : <Outlined key={i} stroke="#0b0f1c" width={size * 0.14} color="#fff">{x.w}</Outlined>;
      })}
    </div>
  );
}

// ------------------------------------------------------------------ name plate, pill, badge

function Plate({ seg, L, pal, fps, fontHead, fontBody, name, office }) {
  const frame = useCurrentFrame();
  const S = scheme(seg.bg, pal);
  const s = sp(frame, fps, Math.round(0.25 * fps), { damping: 17, stiffness: 150 });
  const size = L.plate.size;
  return (
    <div style={{ position: 'absolute', left: L.plate.x, top: L.plate.y, transform: `translateX(${interpolate(s, [0, 1], [-60, 0])}px)`, opacity: clamp(s * 1.5, 0, 1), clipPath: `inset(0 ${(1 - s) * 100}% 0 0)` }}>
      <div style={{ background: S.plate, border: `5px solid ${S.plateEdge}`, padding: `${size * 0.1}px ${size * 0.3}px ${size * 0.14}px`, display: 'inline-block' }}>
        <div style={{ fontFamily: fontHead, fontSize: size, lineHeight: 1, color: S.plateText, textTransform: 'uppercase' }}>{name}</div>
        {office ? <div style={{ fontFamily: fontBody, fontSize: size * 0.32, marginTop: size * 0.1, color: S.plateEdge, letterSpacing: '0.02em' }}>{office}</div> : null}
      </div>
    </div>
  );
}

function Pill({ text, L, pal, fps, fontBody, seg, right }) {
  const frame = useCurrentFrame();
  const s = sp(frame, fps, Math.round(0.35 * fps), { damping: 13, stiffness: 200 });
  const S = scheme(seg.bg, pal);
  return (
    <div style={{ position: 'absolute', left: right ? undefined : L.card.x + 40, right: right ? L.card.x + 40 : undefined, top: L.card.y + L.card.h + (L.v ? 60 : 14), transform: `rotate(-3deg) scale(${interpolate(s, [0, 1], [0.4, 1])})`, opacity: clamp(s * 2, 0, 1) }}>
      <div style={{ background: '#fff', color: S.bg === DEFAULT_PAL.navy || seg.bg === 'navy' ? DEFAULT_PAL.navy : scheme('navy', pal).bg, fontFamily: fontBody, fontSize: L.v ? 30 : 24, letterSpacing: '0.04em', textTransform: 'uppercase', padding: L.v ? '12px 26px' : '9px 20px', borderRadius: 10, boxShadow: '0 8px 0 rgba(0,0,0,0.18)' }}>{text}</div>
    </div>
  );
}

function Badge({ L, pal, fps }) {
  const frame = useCurrentFrame();
  const s = sp(frame, fps, Math.round(0.4 * fps), { damping: 12, stiffness: 170 });
  const P = { ...DEFAULT_PAL, ...pal }; const d = L.badge;
  return (
    <div style={{ position: 'absolute', left: L.card.x + L.card.w - d * 0.72, top: L.card.y + L.card.h - d * 0.72, width: d, height: d, transform: `rotate(${interpolate(s, [0, 1], [-120, 0])}deg) scale(${s})` }}>
      <svg viewBox="0 0 100 100" width={d} height={d}>
        <circle cx="50" cy="50" r="48" fill="#fff" />
        <circle cx="50" cy="50" r="41" fill="none" stroke={P.navy} strokeWidth="3" />
        <circle cx="50" cy="50" r="36" fill="none" stroke={P.yellow} strokeWidth="2" strokeDasharray="2 3" />
        {/* a capitol dome, drawn from simple shapes */}
        <g fill={P.navy}>
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

// ------------------------------------------------------------------ map and stat cards

function MapCard({ c, w, h, fps, pal, fontHead, fontBody }) {
  const frame = useCurrentFrame(); const P = { ...DEFAULT_PAL, ...pal };
  const draw = interpolate(frame, [0, 0.9 * fps], [1, 0], { extrapolateRight: 'clamp', easing: Easing.out(Easing.cubic) });
  const fill = interpolate(frame, [0.5 * fps, 1.0 * fps], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const zoomTo = c.district?.box || (c.pin ? [c.pin[0] - c.state.box[2] * 0.18, c.pin[1] - c.state.box[3] * 0.18, c.state.box[2] * 0.36, c.state.box[3] * 0.36] : null);
  const z = zoomTo ? interpolate(frame, [1.1 * fps, 2.0 * fps], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.bezier(0.65, 0, 0.35, 1) }) : 0;
  const pad = (b, k) => [b[0] - b[2] * k, b[1] - b[3] * k, b[2] * (1 + 2 * k), b[3] * (1 + 2 * k)];
  const A = pad(c.state.box, 0.08); const B = zoomTo ? pad(zoomTo, 0.35) : A;
  const vb = A.map((a, i) => a + (B[i] - a) * z);
  const scale = Math.min(w / vb[2], h / vb[3]); const ox = (w - vb[2] * scale) / 2; const oy = (h - vb[3] * scale) / 2;
  const toPx = (pt) => [ox + (pt[0] - vb[0]) * scale, oy + (pt[1] - vb[1]) * scale];
  const pinPt = c.pin || (c.district ? [c.district.box[0] + c.district.box[2] / 2, c.district.box[1] + c.district.box[3] / 2] : null);
  const pin = pinPt ? toPx(pinPt) : null;
  const ls = sp(frame, fps, Math.round((zoomTo ? 1.9 : 1.0) * fps), { damping: 14, stiffness: 180 });
  const dpop = sp(frame, fps, Math.round(1.6 * fps), { damping: 15, stiffness: 160 });
  const big = Math.round(Math.min(w, h) * 0.13);
  return (
    <AbsoluteFill style={{ background: P.navy }}>
      <svg width={w} height={h} viewBox={vb.join(' ')} preserveAspectRatio="xMidYMid meet" style={{ position: 'absolute', inset: 0 }}>
        <path d={c.state.d} fill={P.navy} fillOpacity={1} stroke="#fff" strokeWidth={4} vectorEffect="non-scaling-stroke" pathLength={1} strokeDasharray="1 1" strokeDashoffset={draw} strokeLinejoin="round" />
        <path d={c.state.d} fill="#2c3d8f" fillOpacity={fill} stroke="none" />
        {c.district ? <path d={c.district.d} fill={P.red} fillOpacity={dpop} stroke="#fff" strokeWidth={3} vectorEffect="non-scaling-stroke" strokeLinejoin="round" /> : null}
      </svg>
      {pin ? (
        <svg width={64} height={84} viewBox="0 0 64 84" style={{ position: 'absolute', left: pin[0] - 32, top: pin[1] - 80, transform: `scale(${ls})`, transformOrigin: '50% 100%' }}>
          <path d="M32 82 C32 82 6 50 6 30 A26 26 0 0 1 58 30 C58 50 32 82 32 82 Z" fill={P.red} stroke="#fff" strokeWidth="4" />
          <circle cx="32" cy="30" r="10" fill="#fff" />
        </svg>
      ) : null}
      {c.label ? (
        <div style={{ position: 'absolute', left: pin ? clamp(pin[0] + 40, 20, w - big * 4.4) : 30, top: pin ? clamp(pin[1] - big * 1.4, 20, h - big * 2) : 30, transform: `rotate(-3deg) scale(${ls})`, transformOrigin: '0 50%' }}>
          <div style={{ background: P.yellow, color: P.navy, fontFamily: fontHead, fontSize: big * 0.62, padding: `${big * 0.06}px ${big * 0.22}px`, textTransform: 'uppercase', lineHeight: 1.05 }}>{c.label}</div>
          {c.sub ? <div style={{ background: '#fff', color: P.red, fontFamily: fontBody, fontSize: big * 0.2, padding: `${big * 0.05}px ${big * 0.22}px`, textTransform: 'uppercase', letterSpacing: '0.04em', display: 'inline-block' }}>{c.sub}</div> : null}
        </div>
      ) : null}
    </AbsoluteFill>
  );
}

function StatCard({ c, w, h, fps, pal, fontHead, fontBody }) {
  const frame = useCurrentFrame(); const P = { ...DEFAULT_PAL, ...pal };
  const run = interpolate(frame, [0.15 * fps, 1.3 * fps], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.out(Easing.cubic) });
  const v = Number(c.value) || 0; const dec = String(c.value).includes('.') ? String(c.value).split('.')[1].length : 0;
  const shown = (v * run).toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
  const ls = sp(frame, fps, Math.round(0.9 * fps));
  const big = Math.round(Math.min(w * 0.3, h * 0.42));
  return (
    <AbsoluteFill style={{ background: P.navy, alignItems: 'center', justifyContent: 'center', flexDirection: 'column' }}>
      <div style={{ fontFamily: fontHead, fontSize: big, color: P.yellow, lineHeight: 1 }}>{c.prefix || ''}{shown}{c.suffix || ''}</div>
      {c.label ? <div style={{ fontFamily: fontHead, fontSize: big * 0.24, color: '#fff', textTransform: 'uppercase', marginTop: big * 0.08, opacity: ls, transform: `translateY(${(1 - ls) * 30}px)`, textAlign: 'center', maxWidth: w * 0.86 }}>{c.label}</div> : null}
      {c.source ? <div style={{ position: 'absolute', bottom: 18, fontFamily: fontBody, fontSize: Math.max(16, big * 0.075), color: 'rgba(255,255,255,0.75)' }}>Source: {c.source}</div> : null}
    </AbsoluteFill>
  );
}

// ------------------------------------------------------------------ end card

function EndCard({ e, pal, fps, fontHead, fontBody, L }) {
  const frame = useCurrentFrame(); const { width: W, height: H } = useVideoConfig(); const P = { ...DEFAULT_PAL, ...pal };
  const a = sp(frame, fps, 2, { damping: 18, stiffness: 120 });
  const lines = [e.cta, e.name].filter(Boolean);
  const big = L.v ? 168 : 150;
  const at = (k) => sp(frame, fps, 6 + k * 5, { damping: 14, stiffness: 190 });
  return (
    <AbsoluteFill>
      <AbsoluteFill style={{ background: P.yellow, clipPath: `polygon(${W * 0.62 + (1 - a) * W}px 0, ${W}px 0, ${W}px ${H}px, ${W * 0.22 + (1 - a) * W}px ${H}px)` }} />
      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: big * 0.08 }}>
        {e.cta ? <div style={{ fontFamily: fontHead, fontSize: big * 0.42, color: P.white, background: P.red, padding: `0 ${big * 0.12}px`, transform: `rotate(-2deg) scale(${at(0)})`, textTransform: 'uppercase' }}>{e.cta}</div> : null}
        <div style={{ fontFamily: fontHead, fontSize: Math.min(big, (W * 0.9) / Math.max(4, (e.name || '').length * 0.5)), color: P.white, textTransform: 'uppercase', lineHeight: 0.98, textAlign: 'center', transform: `translateY(${(1 - at(1)) * 80}px)`, opacity: clamp(at(1) * 1.5, 0, 1) }}>
          <Outlined stroke={P.navy} width={10} color={P.white}>{e.name}</Outlined>
        </div>
        {e.sub ? <div style={{ fontFamily: fontBody, fontSize: big * 0.2, color: P.navy, background: P.white, padding: `${big * 0.04}px ${big * 0.16}px`, textTransform: 'uppercase', letterSpacing: '0.04em', transform: `scale(${at(2)})` }}>{e.sub}</div> : null}
        {e.site ? <div style={{ fontFamily: fontBody, fontSize: big * 0.17, color: P.white, marginTop: big * 0.06, opacity: at(3) }}>{e.site}</div> : null}
      </AbsoluteFill>
      {e.tag ? <div style={{ position: 'absolute', bottom: L.v ? 70 : 26, width: '100%', textAlign: 'center', fontFamily: fontBody, fontSize: L.v ? 22 : 18, color: 'rgba(255,255,255,0.8)', opacity: at(4) }}>{e.tag}</div> : null}
    </AbsoluteFill>
  );
}

// ------------------------------------------------------------------ the ad

export const PoliticalAd = ({ spec }) => {
  const { fps, width: W, height: H } = useVideoConfig();
  useFonts(spec?.fonts);
  if (!spec) return <AbsoluteFill style={{ background: DEFAULT_PAL.navy }} />;
  const L = layout(W, H); const pal = spec.pal || {};
  const fontHead = spec.fontHead || 'Anton'; const fontBody = spec.fontBody || 'Montserrat';
  const segs = spec.segs || [];
  const F = (s) => Math.round(s * fps);
  return (
    <AbsoluteFill style={{ overflow: 'hidden' }}>
      <Background segs={segs} endCard={spec.end} pal={pal} fps={fps} />
      {segs.map((seg, i) => (
        <Sequence key={`s${i}`} from={F(seg.at)} durationInFrames={Math.max(1, F(seg.at + seg.dur) - F(seg.at))} layout="none">
          <Card seg={seg} prevTilt={i > 0 && !seg.enter ? segs[i - 1].tilt : null} L={L} pal={pal} fps={fps} base={spec.base} fontHead={fontHead} fontBody={fontBody}>
            {seg.noCaptions ? null : <Captions words={spec.words} L={L} pal={pal} fps={fps} fontHead={fontHead} seg={seg} offset={F(seg.at)} />}
          </Card>
          {seg.pill ? <Pill text={seg.pill} L={L} pal={pal} fps={fps} fontBody={fontBody} seg={seg} right={!L.v || !!seg.plate} /> : null}
          {seg.badge ? <Badge L={L} pal={pal} fps={fps} /> : null}
        </Sequence>
      ))}
      {segs.map((seg, i) => seg.plate ? (
        <Sequence key={`p${i}`} from={F(seg.at)} durationInFrames={Math.max(1, F(seg.at + seg.dur) - F(seg.at))} layout="none">
          <Plate seg={seg} L={L} pal={pal} fps={fps} fontHead={fontHead} fontBody={fontBody} name={spec.name} office={spec.office} />
        </Sequence>
      ) : null)}
      <Headlines segs={segs} L={L} pal={pal} fps={fps} fontHead={fontHead} />
      {spec.end ? (
        <Sequence from={F(spec.end.at)} durationInFrames={Math.max(1, F(spec.end.dur))} layout="none">
          <EndCard e={spec.end} pal={pal} fps={fps} fontHead={fontHead} fontBody={fontBody} L={L} />
        </Sequence>
      ) : null}
      {(spec.voice || []).map((v, i) => (
        <Sequence key={`v${i}`} from={F(v.at)} durationInFrames={Math.max(1, F(v.dur))} layout="none">
          <Audio src={v.src} />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};

/** The headline of the section on screen (word times are absolute, so a section that keeps the same line never replays it). */
function Headlines({ segs, L, pal, fps, fontHead }) {
  const t = useCurrentFrame() / fps;
  const seg = segs.find((x) => t >= x.at && t < x.at + x.dur);
  return seg ? <Headline seg={seg} L={L} pal={pal} fps={fps} fontHead={fontHead} /> : null;
}
