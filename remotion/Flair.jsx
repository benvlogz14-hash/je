// Signature motion graphics per look ("flair"), so every style has as many moving layers as the reference ad:
//   cinematic  bars that open, gold rules that draw, vignette, blur-in words, tracking name
//   clean      big soft shapes that glide between sections, dot grid, monogram ring
//   news       red bars that sweep on each new line, corner bug with a pulsing dot, "on the record" tag
//   grassroots tape on the photo, marker scribbles, a hand-drawn arrow and stars, a ticked box
//   tiktok     full-screen word flashes on key words, progress bar
//   patriotic  flag-stripe wipes, popping stars, a double inner border
//   dark       glitch bars on cuts, stamped key words, a red scan line, heavy vignette
//   bright     floating shapes that bob, confetti on the end card
// Under = drawn behind the footage; Over = on top of everything; Card = travels with the footage card.
import React from 'react';
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig, Easing } from 'remotion';

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const sp = (frame, fps, at, cfg = {}) => spring({ frame: frame - at, fps, config: { damping: 16, stiffness: 170, mass: 0.8, ...cfg } });
const rnd = (i) => { const x = Math.sin(i * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };
const mixHex = (a, b, k) => { const p = (h) => [1, 3, 5].map((i) => parseInt(String(h).slice(i, i + 2), 16)); const x = p(a), y = p(b); return `#${x.map((v, i) => Math.round(v + (y[i] - v) * k).toString(16).padStart(2, '0')).join('')}`; };
const segAt = (segs, t) => segs.find((s) => t >= s.at && t < s.at + s.dur);

/** Moments where a new line (bite) starts, and the key words with their times. */
export function beats(segs) {
  const lineStarts = segs.filter((s, i) => i > 0 && (s.card?.src !== segs[i - 1].card?.src || s.bg !== segs[i - 1].bg)).map((s) => s.at);
  const seen = new Set(); const keys = [];
  for (const s of segs) for (const w of s.head?.words || []) if (w.key && w.t != null && !seen.has(w.t)) { seen.add(w.t); keys.push({ w: w.w.replace(/[.,!?;:]+$/, ''), t: w.t }); }
  keys.sort((a, b) => a.t - b.t);
  const spaced = []; for (const k of keys) if (!spaced.length || k.t - spaced[spaced.length - 1].t >= 2) spaced.push(k);
  return { lineStarts, keys: spaced };
}

function Star({ size, color, style }) {
  return <svg width={size} height={size} viewBox="0 0 100 100" style={style}><path d="M50 4 L61 38 L97 38 L68 59 L79 94 L50 72 L21 94 L32 59 L3 38 L39 38 Z" fill={color} /></svg>;
}
/** A hand-drawn line that draws itself: the path is written in a 0-100 box and scaled to w × h pixels (so the stroke stays even). */
function Draw({ d, color, width, progress, w, h, style }) {
  const sd = d.replace(/(-?\d+(?:\.\d+)?)[ ,]+(-?\d+(?:\.\d+)?)/g, (m, x, y) => `${(Number(x) * w / 100).toFixed(1)} ${(Number(y) * h / 100).toFixed(1)}`);
  return <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={{ position: 'absolute', overflow: 'visible', ...style }}><path d={sd} fill="none" stroke={color} strokeWidth={width} strokeLinecap="round" strokeLinejoin="round" pathLength={1} strokeDasharray="1 1" strokeDashoffset={1 - clamp(progress, 0, 1)} /></svg>;
}
let ctx2d = null;
const textW = (str, font, size) => { if (!ctx2d) ctx2d = document.createElement('canvas').getContext('2d'); ctx2d.font = `${size}px "${font}"`; return ctx2d.measureText(str).width; };

// ------------------------------------------------------------------ behind the footage

export function FlairUnder({ segs, look, L, fps, endAt }) {
  const frame = useCurrentFrame(); const { width: W, height: H } = useVideoConfig(); const t = frame / fps;
  if (endAt != null && t >= endAt) return null;
  const f = look.flair;
  if (f === 'clean') {
    const i = Math.max(0, segs.findIndex((s) => t >= s.at && t < s.at + s.dur));
    const sec = segs.slice(0, i + 1).filter((s, k) => k === 0 || s.bg !== segs[k - 1].bg || s.card?.src !== segs[k - 1].card?.src).length;
    const at = Math.round((segs.slice(0, i + 1).filter((s, k) => k === 0 || s.bg !== segs[k - 1].bg || s.card?.src !== segs[k - 1].card?.src).pop()?.at || 0) * fps);
    const s = sp(frame, fps, at, { damping: 22, stiffness: 90 });
    const P = [[0.82, 0.12], [0.12, 0.2], [0.88, 0.78], [0.18, 0.86]];
    const a = P[(sec - 1 + 4) % 4], b = P[sec % 4], c = P[(sec + 1) % 4], d = P[(sec + 2) % 4];
    const lerp = (p, q) => [p[0] + (q[0] - p[0]) * s, p[1] + (q[1] - p[1]) * s];
    const c1 = lerp(a, b), c2 = lerp(c, d);
    const tint = mixHex(look.accent, look.sections.a.bg, 0.86); const tint2 = mixHex(look.colors?.b || look.sections.b.bg, look.sections.a.bg, 0.4);
    const R = Math.max(W, H) * 0.42;
    const pop = sp(frame, fps, 0, { damping: 18, stiffness: 80 });
    return (
      <AbsoluteFill>
        <div style={{ position: 'absolute', left: c1[0] * W - R / 2, top: c1[1] * H - R / 2, width: R, height: R, borderRadius: '50%', background: tint, transform: `scale(${pop})` }} />
        <div style={{ position: 'absolute', left: c2[0] * W - R * 0.35, top: c2[1] * H - R * 0.2, width: R * 0.7, height: R * 0.4, borderRadius: R * 0.1, background: tint2, transform: `rotate(${-12 + s * 8}deg) scale(${pop})` }} />
        <svg width={260} height={260} style={{ position: 'absolute', left: 40, top: H * 0.03, opacity: 0.35 * pop }}><pattern id="dg" width="26" height="26" patternUnits="userSpaceOnUse"><circle cx="4" cy="4" r="4" fill={look.accent} /></pattern><rect width="260" height="260" fill="url(#dg)" /></svg>
      </AbsoluteFill>
    );
  }
  if (f === 'bright') {
    const cols = [look.accent, look.sections.c.bg === look.sections.a.bg ? look.dark : mixHex(look.sections.c.bg, '#000000', 0.12), mixHex(look.sections.b.bg, '#000000', 0.15), look.dark];
    const spots = [[0.08, 0.08], [0.9, 0.12], [0.06, 0.8], [0.93, 0.86], [0.5, 0.96], [0.86, 0.48], [0.1, 0.46], [0.6, 0.04]];
    return (
      <AbsoluteFill>{spots.map(([x, y], i) => {
        const s = sp(frame, fps, 4 + i * 3, { damping: 9, stiffness: 160 });
        const bob = Math.sin(t * 1.6 + i) * 14; const rot = (t * (i % 2 ? 22 : -18)) + i * 40; const sz = 70 + rnd(i) * 70; const col = cols[i % cols.length];
        const st = { position: 'absolute', left: x * W - sz / 2, top: y * H - sz / 2 + bob, transform: `rotate(${rot}deg) scale(${s})` };
        const k = i % 5;
        if (k === 0) return <div key={i} style={{ ...st, width: sz, height: sz, borderRadius: '50%', background: col }} />;
        if (k === 1) return <div key={i} style={{ ...st, width: sz, height: sz, borderRadius: '50%', border: `${sz * 0.16}px solid ${col}` }} />;
        if (k === 2) return <Star key={i} size={sz} color={col} style={st} />;
        if (k === 3) return <div key={i} style={{ ...st, width: sz * 1.4, height: sz * 0.5, borderRadius: sz, background: col }} />;
        return <svg key={i} width={sz * 1.6} height={sz * 0.6} viewBox="0 0 160 60" style={st}><path d="M5 30 Q25 5 45 30 T85 30 T125 30 T155 30" fill="none" stroke={col} strokeWidth="12" strokeLinecap="round" /></svg>;
      })}</AbsoluteFill>
    );
  }
  if (f === 'patriotic') {
    return (
      <AbsoluteFill>{[0, 1, 2].map((i) => {
        const s = sp(frame, fps, 6 + i * 4, { damping: 10, stiffness: 150 });
        const x = L.v ? [56, W - 140, W / 2 - 40][i] : [40, W - 130, W - 150][i]; const y = L.v ? [L.card.y + L.card.h + 60, L.card.y + L.card.h + 90, H * 0.88][i] : [H - 130, H - 140, 26][i];
        return <Star key={i} size={i === 2 ? 70 : 84} color={i === 1 ? look.accent : look.light} style={{ position: 'absolute', left: x, top: y, transform: `rotate(${(t * 12 + i * 30) % 360}deg) scale(${s})`, opacity: 0.9 }} />;
      })}</AbsoluteFill>
    );
  }
  return null;
}

// ------------------------------------------------------------------ travels with the footage card

export function CardFlair({ look, w, h, frame, fps, seg }) {
  const f = look.flair;
  if (f === 'grassroots') {
    const s = sp(frame, fps, seg.enter ? 8 : 0, { damping: 14, stiffness: 160 });
    const tape = (x, y, r) => <div style={{ position: 'absolute', left: x, top: y, width: 170, height: 52, background: 'rgba(242,232,196,0.88)', transform: `rotate(${r}deg) scale(${s})`, boxShadow: '0 2px 6px rgba(0,0,0,0.12)' }} />;
    return <>{tape(-60, -18, -32)}{tape(w - 110, -18, 30)}</>;
  }
  if (f === 'patriotic') return <div style={{ position: 'absolute', inset: 14, border: `3px solid ${look.light}`, outline: `3px solid ${look.accent}`, outlineOffset: 6, opacity: 0.9, pointerEvents: 'none' }} />;
  if (f === 'cinematic' || f === 'dark') return <div style={{ position: 'absolute', inset: 0, boxShadow: `inset 0 0 ${Math.round(Math.min(w, h) * (f === 'dark' ? 0.32 : 0.22))}px rgba(0,0,0,${f === 'dark' ? 0.8 : 0.6})`, pointerEvents: 'none' }} />;
  return null;
}

// ------------------------------------------------------------------ on top of everything

export function FlairOver({ segs, look, L, fps, spec }) {
  const frame = useCurrentFrame(); const { width: W, height: H } = useVideoConfig(); const t = frame / fps;
  const f = look.flair; const endAt = spec.end ? spec.end.at : spec.total;
  if (t >= endAt) return null;
  const { lineStarts, keys } = beats(segs);
  const seg = segAt(segs, t);
  const firstHead = seg ? Math.round((seg.head?.words?.find((w) => w.t != null)?.t ?? seg.at) * fps) : 0;

  if (f === 'cinematic') {
    const s = sp(frame, fps, firstHead, { damping: 26, stiffness: 70 });
    const y = L.head.y + L.head.h + (L.v ? 10 : 6);
    return (
      <AbsoluteFill>
        <div style={{ position: 'absolute', left: W / 2 - (W * 0.32 * s), top: y, width: W * 0.64 * s, height: 3, background: look.accent }} />
        <div style={{ position: 'absolute', left: W / 2 - 6, top: y - 5, width: 12, height: 12, background: look.accent, transform: `rotate(45deg) scale(${s})` }} />
      </AbsoluteFill>
    );
  }
  if (f === 'news') {
    const ls = lineStarts.map((x) => Math.round(x * fps)).filter((x) => frame >= x && frame < x + 16).pop();
    const pulse = 0.55 + 0.45 * Math.abs(Math.sin(t * 3));
    const bs = sp(frame, fps, 3, { damping: 18, stiffness: 160 });
    const bug = spec.bug || '';
    const tagY = L.head.y - (L.v ? 58 : 40);
    const ts = seg ? sp(frame, fps, Math.round(seg.at * fps), { damping: 18, stiffness: 200 }) : 1;
    return (
      <AbsoluteFill>
        {ls != null ? (() => { const p = interpolate(frame - ls, [0, 12], [0, 1], { extrapolateRight: 'clamp', easing: Easing.bezier(0.6, 0, 0.3, 1) }); const x = -W * 1.2 + p * W * 2.6; return <><div style={{ position: 'absolute', left: x, top: H * 0.42, width: W * 1.1, height: H * 0.16, background: look.accent, transform: 'skewX(-18deg)' }} /><div style={{ position: 'absolute', left: x - 120, top: H * 0.42 + H * 0.16, width: W * 0.9, height: 14, background: look.light, transform: 'skewX(-18deg)' }} /></>; })() : null}
        {bug ? <div style={{ position: 'absolute', left: L.v ? 54 : 40, top: L.v ? 120 : 34, display: 'flex', alignItems: 'center', gap: 12, background: look.dark, padding: L.v ? '10px 18px' : '8px 14px', transform: `translateX(${(1 - bs) * -300}px)`, border: `2px solid ${look.accent}` }}>
          <div style={{ width: L.v ? 18 : 14, height: L.v ? 18 : 14, borderRadius: '50%', background: look.accent, opacity: pulse }} />
          <div style={{ fontFamily: look.fonts.head, fontSize: L.v ? 34 : 26, color: look.light, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{bug}</div>
        </div> : null}
        {look.head.pos === 'bottom' ? <div style={{ position: 'absolute', left: L.head.x, top: tagY, display: 'inline-block', background: look.accent, color: look.light, fontFamily: look.fonts.head, fontSize: L.v ? 34 : 26, padding: L.v ? '4px 16px' : '3px 12px', textTransform: 'uppercase', letterSpacing: '0.05em', transform: `scaleX(${ts})`, transformOrigin: '0 50%' }}>On the record</div> : null}
      </AbsoluteFill>
    );
  }
  if (f === 'grassroots') {
    const s = sp(frame, fps, firstHead + 6, { damping: 30, stiffness: 60 });
    const arrowP = interpolate(t, [0.5, 1.3], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
    const y = L.head.y + L.head.h + 4;
    return (
      <AbsoluteFill>
        <Draw d="M2 60 C 15 20, 30 90, 45 45 S 70 20, 98 50" color={look.accent} width={6} progress={s} w={W * 0.42} h={34} style={{ left: W * 0.29, top: y }} />
        {segs[0] && t < segs[0].at + segs[0].dur ? <Draw d="M5 10 C 30 0, 70 20, 80 70 M 62 58 L 80 72 L 92 52" color={look.dark} width={5} progress={arrowP} w={120} h={130} style={{ left: L.v ? W - 170 : L.card.x + L.card.w + 30, top: L.card.y - (L.v ? 120 : 40) }} /> : null}
        {[0, 1].map((i) => { const ss = sp(frame, fps, 14 + i * 6, { damping: 9, stiffness: 140 }); return <svg key={i} width="56" height="56" viewBox="0 0 100 100" style={{ position: 'absolute', left: i ? W - 110 : 50, top: i ? L.card.y + L.card.h + 40 : L.card.y - 70, transform: `scale(${ss}) rotate(${i ? 12 : -10}deg)` }}><path d="M50 8 L58 40 L92 42 L64 60 L74 92 L50 72 L26 92 L36 60 L8 42 L42 40 Z" fill="none" stroke={look.accent} strokeWidth="6" strokeLinejoin="round" /></svg>; })}
      </AbsoluteFill>
    );
  }
  if (f === 'tiktok') {
    const k = keys.find((x) => t >= x.t && t < x.t + 0.36);
    const s = k ? sp(frame, fps, Math.round(k.t * fps), { damping: 10, stiffness: 300 }) : 0;
    return (
      <AbsoluteFill>
        <div style={{ position: 'absolute', left: 0, top: 0, height: L.v ? 10 : 8, width: W * clamp(t / endAt, 0, 1), background: look.accent }} />
        {k ? <AbsoluteFill style={{ background: look.accent, alignItems: 'center', justifyContent: 'center' }}><div style={{ fontFamily: look.fonts.head, fontSize: Math.min(L.v ? 260 : 240, (W * 0.84 * (L.v ? 260 : 240)) / Math.max(1, textW(k.w.toUpperCase(), look.fonts.head, L.v ? 260 : 240))), color: look.dark, transform: `scale(${interpolate(s, [0, 1], [1.4, 1])}) rotate(-4deg)`, textTransform: 'uppercase' }}>{k.w}</div></AbsoluteFill> : null}
      </AbsoluteFill>
    );
  }
  if (f === 'patriotic') {
    const ls = lineStarts.map((x) => Math.round(x * fps)).filter((x) => frame >= x && frame < x + 18).pop();
    if (ls == null) return null;
    const n = 7; const sh = H / n;
    return <AbsoluteFill>{Array.from({ length: n }).map((_, i) => { const p = interpolate(frame - ls - i * 0.8, [0, 14], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.bezier(0.65, 0, 0.35, 1) }); return <div key={i} style={{ position: 'absolute', top: i * sh, height: sh + 1, left: -W + p * 2 * W, width: W, background: i % 2 ? look.light : look.accent }} />; })}</AbsoluteFill>;
  }
  if (f === 'dark') {
    const ls = lineStarts.map((x) => Math.round(x * fps)).filter((x) => frame >= x && frame < x + 5).pop();
    const k = keys.find((x) => t >= x.t && t < x.t + 0.95);
    const ks = k ? sp(frame, fps, Math.round(k.t * fps), { damping: 11, stiffness: 320 }) : 0;
    const kop = k ? interpolate(t - k.t, [0.75, 0.95], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }) : 0;
    const scan = ((t * 0.35) % 1) * H;
    const stampSize = k ? Math.min(L.v ? 170 : 150, (W * 0.66 * (L.v ? 170 : 150)) / Math.max(1, textW(k.w.toUpperCase(), look.fonts.head, L.v ? 170 : 150))) : 0;
    return (
      <AbsoluteFill>
        <div style={{ position: 'absolute', left: 0, top: scan, width: W, height: 3, background: look.accent, opacity: 0.35 }} />
        {ls != null ? Array.from({ length: 7 }).map((_, i) => { const r = rnd(ls + i * 7 + frame); return <div key={i} style={{ position: 'absolute', left: (rnd(i + frame) - 0.3) * W, top: r * H, width: W * (0.3 + rnd(i * 3 + frame) * 0.7), height: 8 + rnd(i * 5 + frame) * 40, background: i % 3 === 0 ? look.accent : i % 3 === 1 ? '#ffffff' : '#000000', mixBlendMode: 'difference', opacity: 0.85 }} />; }) : null}
        {k ? <div style={{ position: 'absolute', left: 0, right: 0, top: L.v ? H * 0.42 : H * 0.36, display: 'flex', justifyContent: 'center', opacity: kop }}><div style={{ fontFamily: look.fonts.head, fontSize: stampSize, color: look.accent, border: `${Math.round(stampSize * 0.07)}px solid ${look.accent}`, padding: `0 ${stampSize * 0.18}px`, textTransform: 'uppercase', letterSpacing: '0.04em', transform: `rotate(-8deg) scale(${interpolate(ks, [0, 1], [2.4, 1])})`, outline: `${Math.round(stampSize * 0.03)}px solid ${look.accent}`, outlineOffset: Math.round(stampSize * 0.06), background: 'rgba(0,0,0,0.35)' }}>{k.w}</div></div> : null}
      </AbsoluteFill>
    );
  }
  return null;
}

// ------------------------------------------------------------------ end card extras

export function EndFlair({ look, fps, L, name }) {
  const frame = useCurrentFrame(); const { width: W, height: H } = useVideoConfig(); const t = frame / fps;
  const f = look.flair;
  if (f === 'cinematic') {
    const s = sp(frame, fps, 10, { damping: 26, stiffness: 70 });
    return <AbsoluteFill>{[-1, 1].map((d) => <div key={d} style={{ position: 'absolute', left: W / 2 - W * 0.3 * s, top: H / 2 + d * (L.v ? 200 : 160), width: W * 0.6 * s, height: 3, background: look.accent }} />)}</AbsoluteFill>;
  }
  if (f === 'clean') {
    const s = sp(frame, fps, 4, { damping: 20, stiffness: 120 });
    const ini = String(name || '').split(/\s+/).filter(Boolean).map((x) => x[0]).slice(0, 2).join('').toUpperCase();
    const d = L.v ? 150 : 120;
    return <div style={{ position: 'absolute', left: W / 2 - d / 2, top: H / 2 - (L.v ? 470 : 380), width: d, height: d }}>
      <svg width={d} height={d} viewBox="0 0 100 100"><circle cx="50" cy="50" r="44" fill="none" stroke={look.accent} strokeWidth="6" pathLength={1} strokeDasharray="1 1" strokeDashoffset={1 - s} transform="rotate(-90 50 50)" /></svg>
      <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: look.fonts.head, fontSize: d * 0.36, color: look.accent, opacity: s }}>{ini}</div>
    </div>;
  }
  if (f === 'grassroots') {
    const p = interpolate(frame, [18, 34], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
    const d = L.v ? 110 : 90;
    return <div style={{ position: 'absolute', left: W / 2 - d / 2, top: H / 2 - (L.v ? 450 : 360), width: d, height: d }}>
      <Draw d="M8 10 L92 6 L94 92 L6 94 Z" color={look.dark} width={5} progress={interpolate(frame, [4, 16], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })} w={d} h={d} style={{ left: 0, top: 0 }} />
      <Draw d="M18 50 L42 76 L96 8" color={look.accent} width={9} progress={p} w={d} h={d} style={{ left: 0, top: 0 }} />
    </div>;
  }
  if (f === 'bright') {
    const cols = [look.accent, look.sections.b.bg, look.sections.c.bg, look.dark, look.sections.a.bg];
    return <AbsoluteFill>{Array.from({ length: 70 }).map((_, i) => {
      const x0 = rnd(i) * W; const sp0 = 300 + rnd(i + 9) * 500; const y = -40 + (t - rnd(i + 3) * 0.4) * sp0; const rot = t * (200 + rnd(i + 5) * 300);
      if (y < -40) return null;
      return <div key={i} style={{ position: 'absolute', left: x0 + Math.sin(t * 3 + i) * 30, top: y, width: 14 + rnd(i + 7) * 12, height: 8 + rnd(i + 8) * 8, background: cols[i % cols.length], transform: `rotate(${rot}deg)`, borderRadius: i % 3 === 0 ? '50%' : 2 }} />;
    })}</AbsoluteFill>;
  }
  if (f === 'patriotic') return <AbsoluteFill>{[0, 1, 2, 3, 4].map((i) => { const s = sp(frame, fps, 8 + i * 3, { damping: 9, stiffness: 160 }); const sz = L.v ? 54 : 44; return <Star key={i} size={sz} color={look.light} style={{ position: 'absolute', left: W / 2 + (i - 2) * sz * 1.3 - sz / 2, top: H / 2 - (L.v ? 330 : 270), transform: `scale(${s})` }} />; })}</AbsoluteFill>;
  if (f === 'dark') {
    const on = frame < 10 ? (rnd(frame) > 0.45 ? 1 : 0.15) : 1;
    return <AbsoluteFill style={{ background: '#000', opacity: 1 - on, pointerEvents: 'none' }} />;
  }
  return null;
}
