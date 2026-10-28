// Studio: Euclidean's built-in editor. Same project model as Velo (projects open in either),
// Premiere-style layout: project bin + effects, program monitor, effect controls, multi-track timeline.
import { html, useRoute, useState, useEffect, useRef, useMemo, useCallback, useStore, useApi, navigate, Button, Seg, Toggle, Empty, Loading, Modal, Field, act, toast, openMenu, confirmDialog, promptDialog, useEvent } from '../lib/ui.js';
import { api } from '../lib/api.js';
import { Icon } from '../lib/icons.js';
import { play as sfx } from '../lib/sound.js';
import { tc, ago, dur } from '../lib/format.js';
import { FONT_GROUPS, HEAVY } from '../lib/fonts.js';
import { LOOKS } from './clip.js';

// ------------------------------------------------------------ Velo effect registry (mirrors src/effects/Effects.cpp)
const EFFECTS = [
  { id: 'gaussian_blur', name: 'Gaussian Blur', cat: 'Blur', params: [['radius', 'Radius', 0, 200, 10]] },
  { id: 'color_correction', name: 'Color Correction', cat: 'Color', params: [['brightness', 'Brightness', -100, 100, 0], ['contrast', 'Contrast', -100, 100, 0], ['saturation', 'Saturation', 0, 200, 100], ['temperature', 'Temperature', -100, 100, 0]] },
  { id: 'color_grade', name: 'Color Grade', cat: 'Color', params: [['exposure', 'Exposure (EV)', -4, 4, 0, 0.05], ['contrast', 'Contrast', -100, 100, 0], ['highlights', 'Highlights', -100, 100, 0], ['shadows', 'Shadows', -100, 100, 0], ['temperature', 'Temperature', -100, 100, 0], ['tint', 'Tint', -100, 100, 0], ['hue', 'Hue', -180, 180, 0], ['saturation', 'Saturation', 0, 200, 100], ['vibrance', 'Vibrance', -100, 100, 0]] },
  { id: 'sharpen', name: 'Sharpen', cat: 'Color', params: [['amount', 'Amount', 0, 300, 50]] },
  { id: 'black_white', name: 'Black & White', cat: 'Color', params: [['mix', 'Mix', 0, 100, 100]] },
  { id: 'crop', name: 'Crop', cat: 'Transform', params: [['left', 'Left %', 0, 100, 0], ['right', 'Right %', 0, 100, 0], ['top', 'Top %', 0, 100, 0], ['bottom', 'Bottom %', 0, 100, 0]] },
  { id: 'vignette', name: 'Vignette', cat: 'Stylize', params: [['amount', 'Amount', 0, 100, 40]] },
  { id: 'flip', name: 'Flip', cat: 'Transform', params: [['horizontal', 'Horizontal', 0, 1, 1, 1], ['vertical', 'Vertical', 0, 1, 0, 1]] },
];
// Transitions. Types 1–3 are Velo's own; the rest render with FFmpeg's xfade filter on export
// (server/video/studio.js) and are drawn the same way in the program monitor below.
const TRANSITIONS = [
  { type: 1, name: 'Cross Dissolve', cat: 'Dissolve', x: 'fade' }, { type: 2, name: 'Fade', cat: 'Dissolve', x: 'fade' }, { type: 3, name: 'Dip to Black', cat: 'Dissolve', x: 'fadeblack' },
  { type: 4, name: 'Dip to White', cat: 'Dissolve', x: 'fadewhite' }, { type: 5, name: 'Dither Dissolve', cat: 'Dissolve', x: 'dissolve' }, { type: 6, name: 'Fade Through Gray', cat: 'Dissolve', x: 'fadegrays' },
  { type: 7, name: 'Blur Dissolve', cat: 'Dissolve', x: 'hblur' }, { type: 8, name: 'Pixelate', cat: 'Dissolve', x: 'pixelize' },
  { type: 10, name: 'Wipe Left', cat: 'Wipe', x: 'wipeleft' }, { type: 11, name: 'Wipe Right', cat: 'Wipe', x: 'wiperight' }, { type: 12, name: 'Wipe Up', cat: 'Wipe', x: 'wipeup' }, { type: 13, name: 'Wipe Down', cat: 'Wipe', x: 'wipedown' },
  { type: 14, name: 'Soft Wipe Left', cat: 'Wipe', x: 'smoothleft' }, { type: 15, name: 'Soft Wipe Right', cat: 'Wipe', x: 'smoothright' }, { type: 16, name: 'Soft Wipe Up', cat: 'Wipe', x: 'smoothup' }, { type: 17, name: 'Soft Wipe Down', cat: 'Wipe', x: 'smoothdown' },
  { type: 18, name: 'Corner Wipe ↘', cat: 'Wipe', x: 'wipetl' }, { type: 19, name: 'Corner Wipe ↙', cat: 'Wipe', x: 'wipetr' }, { type: 20, name: 'Corner Wipe ↗', cat: 'Wipe', x: 'wipebl' }, { type: 21, name: 'Corner Wipe ↖', cat: 'Wipe', x: 'wipebr' },
  { type: 22, name: 'Diagonal ↖', cat: 'Wipe', x: 'diagtl' }, { type: 23, name: 'Diagonal ↗', cat: 'Wipe', x: 'diagtr' }, { type: 24, name: 'Diagonal ↙', cat: 'Wipe', x: 'diagbl' }, { type: 25, name: 'Diagonal ↘', cat: 'Wipe', x: 'diagbr' },
  { type: 26, name: 'Clock Wipe', cat: 'Wipe', x: 'radial' }, { type: 27, name: 'Slats Left', cat: 'Wipe', x: 'hlslice' }, { type: 28, name: 'Slats Right', cat: 'Wipe', x: 'hrslice' }, { type: 29, name: 'Slats Up', cat: 'Wipe', x: 'vuslice' }, { type: 30, name: 'Slats Down', cat: 'Wipe', x: 'vdslice' },
  { type: 31, name: 'Iris Round', cat: 'Iris', x: 'circleopen' }, { type: 32, name: 'Iris Round Close', cat: 'Iris', x: 'circleclose' }, { type: 33, name: 'Split Open', cat: 'Iris', x: 'horzopen' }, { type: 34, name: 'Split Close', cat: 'Iris', x: 'horzclose' },
  { type: 35, name: 'Barn Doors Open', cat: 'Iris', x: 'vertopen' }, { type: 36, name: 'Barn Doors Close', cat: 'Iris', x: 'vertclose' },
  { type: 40, name: 'Push Left', cat: 'Slide', x: 'slideleft' }, { type: 41, name: 'Push Right', cat: 'Slide', x: 'slideright' }, { type: 42, name: 'Push Up', cat: 'Slide', x: 'slideup' }, { type: 43, name: 'Push Down', cat: 'Slide', x: 'slidedown' },
  { type: 44, name: 'Slide Left', cat: 'Slide', x: 'coverleft' }, { type: 45, name: 'Slide Right', cat: 'Slide', x: 'coverright' }, { type: 46, name: 'Slide Up', cat: 'Slide', x: 'coverup' }, { type: 47, name: 'Slide Down', cat: 'Slide', x: 'coverdown' },
  { type: 48, name: 'Squeeze Horizontal', cat: 'Slide', x: 'squeezeh' }, { type: 49, name: 'Squeeze Vertical', cat: 'Slide', x: 'squeezev' },
];
const TRANS_BY_TYPE = Object.fromEntries(TRANSITIONS.map((t) => [t.type, t]));

/**
 * What a transition does to a clip at progress p (0→1) in the clip's own frame (w×h, origin top-left).
 * Mirrors FFmpeg xfade: the clip is the incoming side on an In edge and the outgoing side on an Out edge.
 * Returns { alpha, dx, dy, clip: Path2D|null, evenodd, filter, dip: {color, a}, pixel }.
 */
function transitionFx(type, p, w, h, out) {
  const x = TRANS_BY_TYPE[type]?.x || 'fade';
  const fx = { alpha: 1, dx: 0, dy: 0, clip: null, evenodd: true, filter: '', dip: null, pixel: 0 };
  const rect = (a, b, c, d) => { const q = new Path2D(); q.rect(a, b, c, d); return q; };
  const not = (inner) => { const q = new Path2D(); q.rect(0, 0, w, h); q.addPath(inner); return q; };
  // incoming region at progress p, as sampled from xfade
  const R = Math.hypot(w / 2, h / 2);
  const region = () => {
    switch (x) {
      case 'wipeleft': case 'smoothleft': case 'hlslice': case 'coverleft': return rect(w * (1 - p), 0, w * p, h);
      case 'wiperight': case 'smoothright': case 'hrslice': case 'coverright': return rect(0, 0, w * p, h);
      case 'wipeup': case 'smoothup': case 'vuslice': case 'coverup': return rect(0, h * (1 - p), w, h * p);
      case 'wipedown': case 'smoothdown': case 'vdslice': case 'coverdown': return rect(0, 0, w, h * p);
      case 'wipetl': return not(rect(0, 0, w * (1 - p), h * (1 - p)));
      case 'wipetr': return not(rect(w * p, 0, w * (1 - p), h * (1 - p)));
      case 'wipebl': return not(rect(0, h * p, w * (1 - p), h * (1 - p)));
      case 'wipebr': return not(rect(w * p, h * p, w * (1 - p), h * (1 - p)));
      case 'diagtl': case 'diagtr': case 'diagbl': case 'diagbr': {
        // grows from the opposite corner along the diagonal
        const k = 2 * p; const q = new Path2D();
        const pts = { diagtl: [[w, h], [w - w * k, h], [w, h - h * k]], diagtr: [[0, h], [w * k, h], [0, h - h * k]], diagbl: [[w, 0], [w - w * k, 0], [w, h * k]], diagbr: [[0, 0], [w * k, 0], [0, h * k]] }[x];
        q.moveTo(...pts[0]); q.lineTo(...pts[1]); q.lineTo(...pts[2]); q.closePath(); return q;
      }
      case 'radial': { const q = new Path2D(); q.moveTo(w / 2, h / 2); q.arc(w / 2, h / 2, R + 2, -Math.PI / 2, -Math.PI / 2 + p * Math.PI * 2); q.closePath(); return q; }
      case 'circleopen': { const q = new Path2D(); q.arc(w / 2, h / 2, p * R, 0, Math.PI * 2); return q; }
      case 'circleclose': { const q = new Path2D(); q.arc(w / 2, h / 2, (1 - p) * R, 0, Math.PI * 2); return not(q); }
      case 'horzopen': return rect(0, h / 2 - (p * h) / 2, w, p * h);
      case 'horzclose': case 'squeezeh': return not(rect(0, h / 2 - ((1 - p) * h) / 2, w, (1 - p) * h));
      case 'vertopen': return rect(w / 2 - (p * w) / 2, 0, p * w, h);
      case 'vertclose': case 'squeezev': return not(rect(w / 2 - ((1 - p) * w) / 2, 0, (1 - p) * w, h));
      default: return null;
    }
  };
  if (['fade', 'dissolve'].includes(x)) { fx.alpha = out ? 1 - p : p; return fx; }
  if (x === 'fadegrays') { fx.alpha = out ? 1 - p : p; fx.filter = `grayscale(${out ? p : 1 - p})`; return fx; }
  if (x === 'hblur') { fx.alpha = out ? 1 - p : p; fx.filter = `blur(${Math.round((1 - Math.abs(2 * p - 1)) * 12)}px)`; return fx; }
  if (x === 'pixelize') { fx.alpha = out ? 1 - p : p; fx.pixel = Math.round((1 - Math.abs(2 * p - 1)) * 48); return fx; }
  if (x === 'fadeblack' || x === 'fadewhite') {
    const color = x === 'fadeblack' ? '#000' : '#fff';
    const show = out ? p < 0.5 : p >= 0.5; // the clip is visible on its own half; the colour peaks in the middle
    fx.alpha = show ? 1 : 0; fx.dip = { color, a: show ? (out ? 2 * p : 2 * (1 - p)) : (out ? 2 * (1 - p) : 2 * p) }; return fx;
  }
  const dir = { slideleft: [1, 0], slideright: [-1, 0], slideup: [0, 1], slidedown: [0, -1] }[x];
  if (dir) { // push: both clips move
    if (out) { fx.dx = -dir[0] * w * p; fx.dy = -dir[1] * h * p; } else { fx.dx = dir[0] * w * (1 - p); fx.dy = dir[1] * h * (1 - p); }
    return fx;
  }
  const cover = { coverleft: [1, 0], coverright: [-1, 0], coverup: [0, 1], coverdown: [0, -1] }[x];
  if (cover && !out) { fx.dx = cover[0] * w * (1 - p); fx.dy = cover[1] * h * (1 - p); return fx; }
  const r = region();
  // even-odd filling: the frame plus a region is that region's complement, which is what the outgoing side keeps
  if (r) { if (out) { const q = new Path2D(); q.rect(0, 0, w, h); q.addPath(r); fx.clip = q; } else fx.clip = r; fx.evenodd = true; }
  return fx;
}
const PRESETS = [{ label: 'Shorts / Reels / TikTok', w: 1080, h: 1920 }, { label: 'YouTube 1080p', w: 1920, h: 1080 }, { label: 'Instagram square', w: 1080, h: 1080 }, { label: 'YouTube 4K', w: 3840, h: 2160 }];

const base = (p, d = 0) => (p && typeof p === 'object' ? (p.base ?? d) : (p ?? d));
const anim = (v) => ({ base: v });
// ---- keyframes (Velo format: { base, keys: [[clipLocalSeconds, value], ...] }, smoothstep easing between keys)
const qt = (t) => Math.round(t * 1000) / 1000;
// A key within one frame of the playhead counts as "on" it, so clicking a frame off updates it instead of adding a near-duplicate.
const KEY_TOL = 0.034;
const sortedKeys = (p) => (p && typeof p === 'object' && Array.isArray(p.keys) ? p.keys.slice().sort((a, b) => a[0] - b[0]) : []);
const isAnimated = (p) => sortedKeys(p).length > 0;
/** Value of a (possibly keyframed) parameter at clip-local time t. */
function valAt(p, t, d = 0) {
  if (p == null) return d;
  if (typeof p !== 'object') return p;
  const k = sortedKeys(p);
  if (!k.length) return p.base ?? d;
  if (t <= k[0][0]) return k[0][1];
  for (let i = 1; i < k.length; i++) if (t < k[i][0]) { const [t0, v0] = k[i - 1], [t1, v1] = k[i]; const span = t1 - t0; if (span <= 1e-9) return v1; const f = (t - t0) / span; return v0 + (v1 - v0) * f * f * (3 - 2 * f); }
  return k[k.length - 1][1];
}
/** Set the value at t: moves/creates a keyframe when animated, otherwise changes the plain value. */
function withValueAt(p, t, v, d = 0) {
  const o = p && typeof p === 'object' ? clone(p) : { base: p ?? d };
  if (o.keys?.length) { const near = o.keys.filter((k) => Math.abs(k[0] - t) <= KEY_TOL).sort((a, b) => Math.abs(a[0] - t) - Math.abs(b[0] - t))[0]; const at = near ? near[0] : qt(t); o.keys = o.keys.filter((k) => Math.abs(k[0] - t) > KEY_TOL); o.keys.push([at, v]); o.keys.sort((a, b) => a[0] - b[0]); }
  else o.base = v;
  return o;
}
/** Stopwatch: start animating (first key at t) or stop (keep the value at t, drop all keys). */
function toggleAnimation(p, t, d = 0) {
  const o = p && typeof p === 'object' ? clone(p) : { base: p ?? d };
  if (o.keys?.length) { o.base = valAt(o, t, d); delete o.keys; } else o.keys = [[qt(t), o.base ?? d]];
  return o;
}
/** Add a keyframe at t (with the current value), or remove the one that's there. */
function toggleKeyAt(p, t, d = 0) {
  const o = p && typeof p === 'object' ? clone(p) : { base: p ?? d };
  const k = sortedKeys(o); const i = k.findIndex((x) => Math.abs(x[0] - t) <= KEY_TOL);
  if (i >= 0) { k.splice(i, 1); if (!k.length) { o.base = valAt(p, t, d); delete o.keys; } else o.keys = k; }
  else { o.keys = [...k, [qt(t), valAt(o, t, d)]].sort((a, b) => a[0] - b[0]); }
  return o;
}
const hasKeyAt = (p, t) => sortedKeys(p).some((k) => Math.abs(k[0] - t) <= KEY_TOL);
/** Every animatable parameter of a clip, as [object, key] pairs. */
function animParams(c) {
  const out = ['posX', 'posY', 'scaleX', 'scaleY', 'rotation', 'opacity', 'volume'].filter((k) => c[k] && typeof c[k] === 'object').map((k) => [c, k]);
  for (const e of c.effects || []) for (const k of Object.keys(e.params || {})) out.push([e.params, k]);
  return out;
}
/** Move every keyframe of a clip by dt seconds (used by split and trimming the start). */
function shiftKeys(c, dt) { for (const [o, k] of animParams(c)) if (o[k]?.keys?.length) o[k] = { ...o[k], keys: o[k].keys.map(([t, v]) => [qt(t + dt), v]) }; }
const keyTimesOf = (c) => [...new Set(animParams(c).flatMap(([o, k]) => sortedKeys(o[k]).map((x) => x[0])))].sort((a, b) => a - b);
const clone = (o) => JSON.parse(JSON.stringify(o));
/** The opening title made with the clip (stays recognised after you rename it). */
const isHook = (c) => c && c.type === 3 && (c.isHook || c.name === 'Hook');
/** Captions are marked as such (made from the transcript); titles you add yourself never count as captions. */
const isCaption = (c) => c && c.type === 3 && !isHook(c) && !!c.text && !!c.isCaption;
/** Older projects: the pieces on the "Captions" track (or with word timings) are the captions. */
function markCaptions(data) {
  for (const sq of data?.sequences || []) for (const tr of sq.videoTracks || []) for (const c of tr.clips || []) if (c.type === 3 && c.isCaption === undefined && !isHook(c) && (tr.name === 'Captions' || Array.isArray(c.text?.words))) c.isCaption = true;
  return data;
}
/**
 * Titles wider than the frame (projects made before titles were fitted, or long text) are split into 2 or 3 balanced
 * lines and shrunk just enough to fit, like renders do. Captions are left alone. Returns how many were changed.
 */
function fitTitles(data) {
  const g = document.createElement('canvas').getContext('2d'); let changed = 0;
  for (const sq of data?.sequences || []) {
    const W = sq.width || 1080;
    for (const tr of sq.videoTracks || []) for (const c of tr.clips || []) {
      const st = c.text; if (c.type !== 3 || c.isCaption || !st?.text) continue;
      const show = (t) => (st.uppercase ? t.toUpperCase() : t);
      const widthOf = (t, px) => { g.font = `${st.italic ? 'italic ' : ''}${st.bold === false ? 500 : 800} ${px}px ${JSON.stringify(st.family || 'Montserrat')}, Montserrat, sans-serif`; return Math.max(...t.split('\n').map((l) => g.measureText(show(l)).width)) + 2 * (st.box ? (st.boxPad ?? 18) : st.outlineWidth || 0); };
      const limit = (W * 0.93) / Math.max(0.1, base(c.scaleX, 1)); let px = st.pixelSize || 96; let text = String(st.text);
      if (widthOf(text, px) <= limit) continue;
      if (!text.includes('\n') && text.includes(' ')) {
        const ws = text.split(/\s+/); const len = (a, z) => ws.slice(a, z).join(' ').length; let best2 = null, best3 = null;
        for (let i = 1; i < ws.length; i++) { const m = Math.max(len(0, i), len(i, ws.length)); if (!best2 || m < best2.m) best2 = { m, t: `${ws.slice(0, i).join(' ')}\n${ws.slice(i).join(' ')}` }; for (let j = i + 1; j < ws.length; j++) { const m3 = Math.max(len(0, i), len(i, j), len(j, ws.length)); if (!best3 || m3 < best3.m) best3 = { m: m3, t: [ws.slice(0, i), ws.slice(i, j), ws.slice(j)].map((x) => x.join(' ')).join('\n') }; } }
        text = [best2?.t, best3?.t].filter(Boolean).find((t) => widthOf(t, px) <= limit) || best3?.t || best2?.t || text;
      }
      px = Math.max(20, Math.min(px, Math.floor((px * limit) / widthOf(text, px))));
      c.text = { ...st, text, pixelSize: px }; changed++;
    }
  }
  return changed;
}
/** What a clip is called on the timeline: its name, or for titles and captions their text unless you renamed them. */
const clipLabel = (c) => (c.type === 3 && !c.renamed ? c.text?.text || c.name || 'Title' : c.name || 'Clip');
const TRACK_H = { 0: 48, 1: 40 };
// Live scrubbing mutates the clip in place for instant preview; the original value is restored
// right before the committing edit() so undo snapshots stay correct.
const live = new Map();
const redraw = () => window.dispatchEvent(new Event('studio-redraw'));
// Copied clips (Ctrl+C / right-click → Copy), kept for the session so you can paste into another project too.
let clipboard = null;
/** URL the monitor plays: the smooth preview copy when one exists (phone HEVC, ProRes, 4K), else the file itself. */
const playUrl = (m, still) => api.url(`/api/media?path=${encodeURIComponent((!still && m.proxy) || m.path)}`);
function liveSet(obj, key, val, id) { if (!live.has(id)) live.set(id, { obj, key, orig: clone(obj[key]) }); obj[key] = val; redraw(); }
function revertLive() { for (const { obj, key, orig } of live.values()) obj[key] = orig; live.clear(); }
const HEAD_W = 132;

export function Studio() {
  const route = useRoute();
  const id = route.path.split('/')[2];
  const clipId = route.query.clip;
  useEffect(() => { if (clipId && !id) act(() => api.post(`/api/clips/${clipId}/studio`), { sound: 'open' }).then((p) => navigate(`/studio/${p.id}`)).catch(() => {}); }, [clipId]);
  return id ? html`<${Editor} key=${id} id=${id} />` : html`<${Projects} />`;
}

// ------------------------------------------------------------ project list
function Projects() {
  const { data, loading, reload } = useApi('/api/projects', []);
  const { data: clients } = useApi('/api/clients', []);
  const [creating, setCreating] = useState(false);
  return html`<div class="page">
    <div class="page-head"><div class="grow"><h1>Studio</h1><div class="sub">Edit by hand when automation needs a human touch. Projects use Velo's format, so they open in Velo too, and any clip can go to Premiere through Astra.</div></div>
      <${Button} kind="primary" icon="plus" onClick=${() => setCreating(true)}>New project</${Button}></div>
    ${loading ? html`<${Loading} />` : !(data || []).length ? html`<div class="panel"><${Empty} icon="studio" title="No projects yet" action=${html`<${Button} kind="soft" icon="plus" onClick=${() => setCreating(true)}>New project</${Button}>`}>Open any clip with "Open in Studio" to get a project pre-built with footage, captions and hook, or start from scratch.</${Empty}></div>` : html`
      <div class="grid c3">${data.map((p) => html`<div class="panel pad" style="cursor:pointer" onClick=${() => { sfx('open'); navigate(`/studio/${p.id}`); }} onContextMenu=${(e) => openMenu(e, [{ label: 'Rename project', icon: 'edit', onClick: async () => { const v = await promptDialog({ title: 'Rename project', label: 'Project name', value: p.name || '', confirm: 'Rename' }); if (v && v.trim()) act(() => api.put(`/api/projects/${p.id}`, { name: v.trim() }), { ok: 'Renamed' }).then(reload); } }, { label: 'Delete project', icon: 'trash', danger: true, onClick: async () => { if (await confirmDialog({ title: 'Delete project?', text: `"${p.name}" will be removed. Media files are not deleted.`, confirm: 'Delete' })) act(() => api.del(`/api/projects/${p.id}`), { ok: 'Deleted' }).then(reload); } }])}>
        <div class="row"><div class="avatar" style="background:var(--slate-soft);color:var(--slate-ink)"><${Icon} name="studio" size=${17} /></div><div class="grow" style="min-width:0"><b class="ellipsis" style="display:block">${p.name || 'Untitled edit'}</b><div class="faint" style="font-size:var(--fs-sm)">${p.media} media · edited ${ago(p.updatedAt)}</div></div></div>
        ${(p.exports || []).length ? html`<div class="faint" style="font-size:var(--fs-xs);margin-top:10px">${p.exports.length} export${p.exports.length > 1 ? 's' : ''}</div>` : null}</div>`)}</div>`}
    ${creating ? html`<${NewProject} clients=${clients || []} onClose=${() => setCreating(false)} />` : null}
  </div>`;
}

function NewProject({ clients, onClose }) {
  const [name, setName] = useState('Untitled edit');
  const [preset, setPreset] = useState(0);
  const [clientId, setClientId] = useState('');
  const create = () => act(() => api.post('/api/projects', { name, clientId: clientId || null, width: PRESETS[preset].w, height: PRESETS[preset].h, fps: 30 }), { sound: 'open' }).then((p) => navigate(`/studio/${p.id}`));
  return html`<${Modal} title="New project" icon="studio" onClose=${onClose} footer=${html`<${Button} kind="ghost" onClick=${onClose}>Cancel</${Button}><${Button} kind="primary" onClick=${create}>Create</${Button}>`}>
    <div class="col" style="gap:14px">
      <${Field} label="Name" id="np-name"><input id="np-name" class="input" value=${name} onInput=${(e) => setName(e.target.value)} autofocus /></${Field}>
      <${Field} label="Client" id="np-client"><select id="np-client" class="select" value=${clientId} onChange=${(e) => setClientId(e.target.value)}><option value="">No client</option>${clients.map((c) => html`<option value=${c.id}>${c.name}</option>`)}</select></${Field}>
      <div class="field"><span class="label">Sequence preset</span><div class="chips">${PRESETS.map((p, i) => html`<button class=${'chip' + (i === preset ? ' on' : '')} onClick=${() => setPreset(i)}>${p.label} <span class="faint">${p.w}×${p.h}</span></button>`)}</div></div>
    </div></${Modal}>`;
}

// ------------------------------------------------------------ editor
function Editor({ id }) {
  const [proj, setProj] = useState(null);
  const [data, setDataRaw] = useState(null);
  const [sel, setSel] = useState([]); // clip ids (strings)
  const [t, setTRaw] = useState(0);
  const fpsRef = useRef(30);
  /** The playhead always sits exactly on a frame, so keyframes, splits and edits line up with what's shown. */
  const setT = useCallback((v) => setTRaw((prev) => { const x = typeof v === 'function' ? v(prev) : v; const f = fpsRef.current || 30; return Math.max(0, Math.round(x * f) / f); }), []);
  const [playing, setPlaying] = useState(false);
  const [tool, setTool] = useState('select');
  const [snap, setSnap] = useState(true);
  const [zoom, setZoom] = useState(60); // px per second
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false); dirtyRef.current = dirty;
  const [leftTab, setLeftTab] = useState('media');
  const undo = useRef([]); const redo = useRef([]);
  const saveTimer = useRef(null);

  useEffect(() => { api.get(`/api/projects/${id}`).then((p) => {
    setProj(p); setDataRaw(markCaptions(p.data));
    // Once the title fonts are loaded (so measuring is exact), titles running off the frame are fitted and saved.
    const fams = [...new Set((p.data?.sequences || []).flatMap((sq) => (sq.videoTracks || []).flatMap((tr) => (tr.clips || []).filter((c) => c.type === 3 && c.text).map((c) => c.text.family || 'Montserrat'))))];
    Promise.all(fams.map((f) => document.fonts?.load(`800 40px ${JSON.stringify(f)}`).catch(() => null))).then(() => {
      let n = 0; setDataRaw((prev) => { const next = JSON.parse(JSON.stringify(prev)); n = fitTitles(next); return n ? next : prev; });
      setTimeout(() => { if (n) { setDirty(true); toast(`Fitted ${n} title${n > 1 ? 's' : ''} that ran off the screen`, { kind: 'info' }); } }, 0);
    });
  }).catch((e) => toast(e.message, { kind: 'error' })); }, [id]);
  const seq = data ? (data.sequences.find((s) => s.id === data.activeSequence) || data.sequences[0]) : null;
  if (seq) fpsRef.current = seq.fps || 30;
  const media = useMemo(() => Object.fromEntries((data?.media || []).map((m) => [m.id, m])), [data]);
  const duration = seq ? Math.max(1, ...[...seq.videoTracks, ...seq.audioTracks].flatMap((tr) => tr.clips.map((c) => c.start + c.duration))) : 1;

  /** Every edit goes through here: snapshot for undo, mark dirty, autosave. */
  const edit = useCallback((fn) => {
    setDataRaw((prev) => {
      undo.current.push(JSON.stringify(prev)); if (undo.current.length > 200) undo.current.shift(); redo.current = [];
      const next = clone(prev); fn(next, next.sequences.find((s) => s.id === next.activeSequence) || next.sequences[0]);
      return next;
    });
    setDirty(true);
  }, []);
  const doUndo = () => { if (!undo.current.length) return; sfx('tap'); setDataRaw((prev) => { redo.current.push(JSON.stringify(prev)); return JSON.parse(undo.current.pop()); }); setDirty(true); };
  const doRedo = () => { if (!redo.current.length) return; sfx('tap'); setDataRaw((prev) => { undo.current.push(JSON.stringify(prev)); return JSON.parse(redo.current.pop()); }); setDirty(true); };
  const save = async (quiet) => { if (!data) return; clearTimeout(saveTimer.current); try { await api.put(`/api/projects/${id}`, { data }); setDirty(false); if (!quiet) { sfx('success'); toast('Project saved', { kind: 'ok' }); } } catch (e) { sfx('error'); toast(e.message, { kind: 'error', title: 'Not saved' }); } };
  useEffect(() => { if (!dirty) return; clearTimeout(saveTimer.current); saveTimer.current = setTimeout(() => save(true), 1500); return () => clearTimeout(saveTimer.current); }, [data, dirty]);

  // ---- importing (bin button, drag from the desktop onto the bin, the timeline or anywhere in the editor)
  const [importing, setImporting] = useState(false);
  const [exporting, setExporting] = useState(false);
  useEvent('studio.exported', (x) => { if (x.projectId === id) toast(`Saved to ${x.path}${x.warnings?.length ? ` · ${x.warnings.join(' · ')}` : ''}`, { kind: 'ok', title: 'Export finished', ms: 9000 }); }, [id]);
  const acceptImported = (r) => {
    const added = Array.isArray(r) ? r : r?.media || [];
    if (r?.problems?.length) toast(r.problems.join(' · '), { kind: 'warn', title: 'Some files were skipped' });
    if (added.length) { setDataRaw((d) => ({ ...d, media: [...d.media, ...added] })); sfx('success'); }
    if (added.some((m) => m.proxyPending)) toast('Making a smooth preview copy of this footage (phone/HEVC, ProRes or 4K). It plays here when ready; exports always use the original.', { kind: 'info', ms: 7000 });
    return added;
  };
  const importPaths = async (list) => {
    setImporting(true);
    try { return acceptImported(await api.post(`/api/projects/${id}/media`, { paths: list })); }
    catch (e) { sfx('error'); toast(e.message, { kind: 'error', title: 'Import failed' }); return []; } finally { setImporting(false); }
  };
  const importFiles = async (files) => {
    files = [...files]; if (!files.length) return [];
    // Desktop app: use the files where they are (instant, even for huge videos). Browser: upload a copy.
    const local = window.euclidean?.pathForFile ? files.map((f) => window.euclidean.pathForFile(f)).filter(Boolean) : [];
    if (local.length === files.length) return importPaths(local);
    setImporting(true);
    try { return acceptImported(await api.upload(`/api/projects/${id}/media`, files, {}, null)); }
    catch (e) { sfx('error'); toast(e.message, { kind: 'error', title: 'Import failed' }); return []; } finally { setImporting(false); }
  };
  /** Files dropped from the desktop straight onto a timeline track. */
  const dropFilesOnTrack = async (files, lane, at, replace = false, dir = 'down') => {
    const added = await importFiles(files);
    let pos = at;
    for (const m of added) { addMedia(m, lane.type === 0 ? lane.i : 0, pos, lane.type === 1 ? lane.i : 0, replace, dir); pos += m.kind >= 2 ? 5 : Math.max(0.1, m.duration || 0); }
  };
  useEvent('studio.proxy', (p) => {
    if (p.projectId !== id) return;
    setDataRaw((d) => (d ? { ...d, media: d.media.map((m) => (m.id === p.mediaId ? { ...m, proxy: p.proxy || m.proxy, proxyPending: false, proxyError: p.error || null } : m)) } : d));
    if (p.error) toast(p.error, { kind: 'warn' });
  }, [id]);
  useEffect(() => {
    const over = (e) => { if (e.dataTransfer?.types?.includes('Files')) e.preventDefault(); };
    const drop = (e) => { if (document.body.dataset.screen && document.body.dataset.screen !== '/studio') return; if (e.defaultPrevented || !e.dataTransfer?.files?.length) return; e.preventDefault(); importFiles(e.dataTransfer.files); };
    window.addEventListener('dragover', over); window.addEventListener('drop', drop);
    return () => { window.removeEventListener('dragover', over); window.removeEventListener('drop', drop); };
  }, [id]);

  const nextId = (d) => { const n = Number(d.nextClipId || 1); d.nextClipId = String(n + 1); return String(n); };
  const findClip = (s, cid) => { for (const tr of [...s.videoTracks, ...s.audioTracks]) { const c = tr.clips.find((x) => x.id === cid); if (c) return { c, tr }; } return null; };
  const linked = (s, c) => (c.linkId && c.linkId !== '0' ? [...s.videoTracks, ...s.audioTracks].flatMap((tr) => tr.clips).filter((x) => x.linkId === c.linkId) : [c]);

  /** Cut clips at time `at` (all unlocked tracks, or only `pick` clips). Returns how many were cut. */
  /** Cutting a caption: each half keeps only the words said on its side of the cut (by the middle of the word), timed from its own start. */
  const splitWords = (left, right, off) => {
    const st = left.text; const ws = st?.words; if (!ws?.length) return;
    const toks = String(st.text || '').split(/\s+/).filter(Boolean); if (toks.length !== ws.length) return; // edited words: leave as is
    const n = ws.filter((w) => (w.s + w.e) / 2 < off).length;
    const mk = (a, b, shift) => ({ text: toks.slice(a, b).join(' '), words: ws.slice(a, b).map((w) => ({ ...w, s: Math.max(0, w.s - shift), e: Math.max(0, w.e - shift) })) });
    left.text = { ...st, ...mk(0, n, 0) }; right.text = { ...right.text, ...mk(n, ws.length, off) };
    for (const c of [left, right]) if (!c.renamed) c.name = c.text.text || '(pause)';
  };
  const splitAt = (d, s, at, pick) => {
    const targets = [];
    for (const tr of [...s.videoTracks, ...s.audioTracks]) { if (tr.locked) continue; for (const c of tr.clips) if (at > c.start + 0.03 && at < c.start + c.duration - 0.03 && (!pick || pick(c))) targets.push({ c, tr }); }
    const t = at; const linkMap = {};
    for (const { c, tr } of targets) {
      const right = clone(c); right.id = nextId(d);
      const off = t - c.start; right.start = t; right.duration = c.duration - off; right.in = (c.in || 0) + off * (c.speed || 1); right.transIn = { type: 0, duration: 1 }; shiftKeys(right, -off);
      c.duration = off; c.transOut = { type: 0, duration: 1 };
      if (c.type === 3) splitWords(c, right, off);
      if (c.linkId && c.linkId !== '0') { linkMap[c.linkId] = linkMap[c.linkId] || nextId(d); right.linkId = linkMap[c.linkId]; }
      tr.clips.push(right); tr.clips.sort((a, b) => a.start - b.start);
    }
    return targets.length;
  };
  const split = (all) => edit((d, s) => { if (splitAt(d, s, t, all ? null : (c) => sel.includes(c.id) || !sel.length)) sfx('press'); });
  /** Premiere's ripple trim: Q removes everything before the playhead on every track (the rest moves to 0:00), W everything after. */
  const trimToPlayhead = (side) => edit((d, s) => {
    splitAt(d, s, t, null);
    for (const tr of [...s.videoTracks, ...s.audioTracks]) {
      if (tr.locked) continue;
      if (side === 'before') { tr.clips = tr.clips.filter((c) => c.start >= t - 1e-3); for (const c of tr.clips) c.start = Math.max(0, c.start - t); }
      else tr.clips = tr.clips.filter((c) => c.start < t - 1e-3);
    }
    setSel([]); if (side === 'before') setT(0); sfx('press');
  });
  const remove = (ripple) => edit((d, s) => {
    const ids = new Set(sel.flatMap((cid) => { const f = findClip(s, cid); return f ? linked(s, f.c).map((x) => x.id) : []; }));
    const tracks = [...s.videoTracks, ...s.audioTracks];
    const all = tracks.flatMap((tr) => tr.clips.filter((c) => ids.has(c.id))); if (!all.length) return;
    const a = Math.min(...all.map((c) => c.start)), b = Math.max(...all.map((c) => c.start + c.duration));
    // A selected block with nothing else in its time span (e.g. everything before a Ctrl+B cut): ripple closes that whole
    // span on every track at once, so video, audio and captions stay in sync.
    const whole = !tracks.some((tr) => tr.clips.some((c) => !ids.has(c.id) && c.start < b - 1e-6 && c.start + c.duration > a + 1e-6));
    for (const tr of tracks) {
      const gone = tr.clips.filter((c) => ids.has(c.id));
      tr.clips = tr.clips.filter((c) => !ids.has(c.id));
      if (ripple && whole) { if (!tr.locked) for (const c of tr.clips) if (c.start >= b - 1e-6) c.start -= b - a; }
      else if (ripple) for (const g of gone) for (const c of tr.clips) if (c.start >= g.start + g.duration - 1e-6) c.start -= g.duration;
    }
    // Deleting the start of the edit leaves nothing to play at 0:00, so everything moves up to the start together.
    const rest = tracks.flatMap((tr) => tr.clips); const first = rest.length ? Math.min(...rest.map((c) => c.start)) : 0;
    if (first > 1e-3 && a <= 1e-3) { for (const tr of tracks) for (const c of tr.clips) c.start = Math.round((c.start - first) * 1e6) / 1e6; setT(0); }
    setSel([]);
  });

  // ---- clip operations (right-click menu and shortcuts), Premiere-style
  const groupOf = (s, ids) => [...new Set(ids.flatMap((cid) => { const f = findClip(s, cid); return f ? linked(s, f.c).map((x) => x.id) : []; }))];
  const trackRef = (s, cid) => { const v = s.videoTracks.findIndex((tr) => tr.clips.some((c) => c.id === cid)); if (v >= 0) return { kind: 'v', i: v }; return { kind: 'a', i: s.audioTracks.findIndex((tr) => tr.clips.some((c) => c.id === cid)) }; };
  const ensureTrack = (s, kind, i) => { const list = kind === 'v' ? s.videoTracks : s.audioTracks; while (list.length <= i) list.push({ type: kind === 'v' ? 0 : 1, name: `${kind === 'v' ? 'V' : 'A'}${list.length + 1}`, muted: false, locked: false, volume: { base: 1 }, clips: [] }); return list[i]; };
  const forGroup = (ids, fn) => edit((d, s) => { for (const cid of groupOf(s, ids)) { const f = findClip(s, cid); if (f) fn(f.c, f.tr, d, s); } });
  const copyClips = (ids = sel, quiet) => {
    if (!ids.length) return false;
    const g = groupOf(seq, ids); const items = g.map((cid) => ({ c: clone(findClip(seq, cid).c), ref: trackRef(seq, cid) }));
    const t0 = Math.min(...items.map((x) => x.c.start));
    clipboard = { items: items.map((x) => ({ ...x, off: x.c.start - t0 })), media: data.media.filter((m) => items.some((x) => x.c.mediaId === m.id)), span: Math.max(...items.map((x) => x.c.start + x.c.duration)) - t0 };
    if (!quiet) toast(`${items.length} clip${items.length > 1 ? 's' : ''} copied`, { kind: 'ok', ms: 1800 });
    return true;
  };
  const pasteAt = (at) => {
    if (!clipboard) return toast('Copy a clip first (Ctrl+C)', { kind: 'warn' });
    const ids = [];
    edit((d, s) => {
      for (const m of clipboard.media) if (!d.media.some((x) => x.id === m.id)) d.media.push(clone(m));
      const links = {};
      for (const it of clipboard.items) {
        const c = clone(it.c); c.id = nextId(d); c.start = at + it.off;
        if (c.linkId && c.linkId !== '0') { links[c.linkId] = links[c.linkId] || nextId(d); c.linkId = links[c.linkId]; }
        ensureTrack(s, it.ref.kind, Math.max(0, it.ref.i)); place(s, it.ref.kind, Math.max(0, it.ref.i), c); ids.push(c.id);
      }
    });
    setTimeout(() => setSel(ids), 0);
  };
  const duplicate = (ids = sel) => { if (!copyClips(ids, true)) return; const g = groupOf(seq, ids).map((cid) => findClip(seq, cid).c); pasteAt(Math.max(...g.map((c) => c.start + c.duration))); };
  const cut = (ids = sel) => { if (copyClips(ids, true)) { setSel(ids); setTimeout(() => remove(false), 0); } };
  const unlink = (ids = sel) => forGroup(ids, (c) => { c.linkId = '0'; });
  const link = (ids = sel) => edit((d, s) => { const L = nextId(d); for (const cid of ids) { const f = findClip(s, cid); if (f) f.c.linkId = L; } });
  const setEnabled = (ids, on) => forGroup(ids, (c) => { c.enabled = on; });
  const muteAudio = (ids, on) => forGroup(ids, (c) => { if (c.type === 1) c.volume = anim(on ? 0 : 1); });
  const speedDialog = async (ids = sel) => {
    const first = findClip(seq, ids[0])?.c; if (!first) return;
    const v = await promptDialog({ title: 'Speed / Duration', label: 'Speed in percent (100 = normal, 200 = twice as fast, 50 = slow motion)', value: String(Math.round((first.speed || 1) * 100)), confirm: 'Apply' });
    const pct = Number(v); if (!v || !(pct > 0) || pct > 2000) return v == null ? null : toast('Enter a number between 1 and 2000', { kind: 'warn' });
    forGroup(ids, (c) => { const old = c.speed || 1; c.duration = (c.duration * old) / (pct / 100); c.speed = pct / 100; });
  };
  const fitClip = (ids, mode) => forGroup(ids, (c, tr, d, s) => {
    const m = media[c.mediaId]; if (!m?.width || c.type === 1) return;
    const k = mode === 'fill' ? Math.max(s.width / m.width, s.height / m.height) : Math.min(s.width / m.width, s.height / m.height);
    c.scaleX = anim(k); c.scaleY = anim(k); c.posX = anim(0); c.posY = anim(0); c.rotation = anim(0);
  });
  const setTransitions = (ids, type) => forGroup(ids, (c) => { if (type) { c.transIn = { type, duration: Math.min(0.5, c.duration / 3) }; c.transOut = { type, duration: Math.min(0.5, c.duration / 3) }; } else { c.transIn = { type: 0, duration: 0.5 }; c.transOut = { type: 0, duration: 0.5 }; } });
  const renameClip = async (c) => { const v = await promptDialog({ title: 'Rename clip', label: 'Clip name (shown on the timeline)', value: clipLabel(c), confirm: 'Rename' }); if (v != null && v.trim()) forGroup([c.id], (x) => { if (x.id === c.id) { if (isHook(x)) x.isHook = true; x.name = v.trim().slice(0, 80); x.renamed = true; } }); };
  const renameProject = async () => { const v = await promptDialog({ title: 'Rename project', label: 'Project name', value: proj.name || '', confirm: 'Rename' }); if (v == null || !v.trim()) return; await act(() => api.put(`/api/projects/${id}`, { data, name: v.trim() }), { ok: 'Renamed' }); setProj((p) => ({ ...p, name: v.trim().slice(0, 120) })); setDirty(false); };
  /** Extract Audio: write the clip's sound to its own file, put it on a free audio track, unlink it from the picture. */
  const extractAudio = async (c) => {
    const m = media[c.mediaId]; if (!m?.hasAudio) return toast('This clip has no audio', { kind: 'warn' });
    const item = await act(() => api.post(`/api/projects/${id}/extract-audio`, { mediaId: m.id }), { ok: (x) => `Audio extracted to ${x.name}` });
    edit((d, s) => {
      d.media.push(item);
      const vid = findClip(s, c.id)?.c; if (!vid) return;
      for (const x of linked(s, vid)) if (x.type === 1) for (const tr of s.audioTracks) tr.clips = tr.clips.filter((y) => y.id !== x.id);
      vid.linkId = '0';
      const a = { ...clone(vid), id: nextId(d), type: 1, mediaId: item.id, name: item.name, linkId: '0', effects: [], volume: anim(1), transIn: { type: 0, duration: 0.5 }, transOut: { type: 0, duration: 0.5 } };
      let ti = s.audioTracks.findIndex((tr) => !tr.locked && !tr.clips.some((y) => y.start < a.start + a.duration - 1e-6 && y.start + y.duration > a.start + 1e-6));
      if (ti < 0) ti = s.audioTracks.length;
      ensureTrack(s, 'a', ti); place(s, 'a', ti, a);
    });
  };
  const reveal = (c) => { const m = media[c.mediaId]; if (m) act(() => api.post('/api/system/open', { path: m.path, reveal: true })); };

  const clipMenu = (e, c) => {
    const ids = sel.includes(c.id) ? sel : [c.id];
    if (!sel.includes(c.id)) setSel([c.id]);
    const grp = groupOf(seq, ids).map((cid) => findClip(seq, cid)?.c).filter(Boolean);
    const isLinked = grp.some((x) => x.linkId && x.linkId !== '0');
    const kinds = new Set(ids.map((cid) => findClip(seq, cid)?.c.type));
    const visual = grp.some((x) => x.type === 0 || x.type === 2);
    const m = media[c.mediaId];
    const allOn = grp.every((x) => x.enabled !== false);
    const audioMuted = grp.filter((x) => x.type === 1).every((x) => base(x.volume, 1) === 0);
    openMenu(e, [
      { label: 'Cut', icon: 'scissors', hint: 'Ctrl+X', onClick: () => cut(ids) },
      { label: 'Copy', icon: 'layers', hint: 'Ctrl+C', onClick: () => copyClips(ids) },
      { label: 'Paste at playhead', icon: 'paperclip', hint: 'Ctrl+V', disabled: !clipboard, onClick: () => pasteAt(t) },
      { label: 'Duplicate', icon: 'plus', hint: 'Ctrl+D', onClick: () => duplicate(ids) },
      'sep',
      { label: 'Split at playhead', icon: 'scissors', hint: 'S', disabled: !(t > c.start && t < c.start + c.duration), onClick: () => { setSel(ids); setTimeout(() => split(false), 0); } },
      { label: allOn ? 'Disable' : 'Enable', icon: allOn ? 'eyeOff' : 'eye', hint: 'Shift+E', onClick: () => setEnabled(ids, !allOn) },
      isLinked ? { label: 'Unlink audio and video', icon: 'link', onClick: () => unlink(ids) } : kinds.has(0) && kinds.has(1) ? { label: 'Link audio and video', icon: 'link', onClick: () => link(ids) } : null,
      grp.some((x) => x.type === 1) ? { label: audioMuted ? 'Unmute audio' : 'Mute audio', icon: audioMuted ? 'volume' : 'mute', onClick: () => muteAudio(ids, !audioMuted) } : null,
      c.type === 0 && m?.hasAudio ? { label: 'Extract audio to new file', icon: 'volume', onClick: () => extractAudio(c) } : null,
      'sep',
      c.type !== 3 ? { label: 'Speed / Duration…', icon: 'clock', hint: 'Ctrl+R', onClick: () => speedDialog(ids) } : null,
      visual ? { label: 'Scale to fill frame', icon: 'zoomIn', onClick: () => fitClip(ids, 'fill') } : null,
      visual ? { label: 'Fit inside frame', icon: 'zoomOut', onClick: () => fitClip(ids, 'fit') } : null,
      { label: 'Apply Cross Dissolve (in + out)', icon: 'layers', hint: 'Ctrl+Shift+D', onClick: () => setTransitions(ids, 1) },
      grp.some((x) => x.transIn?.type || x.transOut?.type) ? { label: 'Remove transitions', icon: 'x', onClick: () => setTransitions(ids, 0) } : null,
      grp.some((x) => x.effects?.length) ? { label: 'Remove effects', icon: 'wand', onClick: () => forGroup(ids, (x) => { x.effects = []; }) } : null,
      { label: 'Effects…', icon: 'wand', onClick: () => setLeftTab('effects') },
      'sep',
      c.type === 3 ? { label: 'Edit title…', icon: 'type', hint: 'Double-click', onClick: () => setTitleEdit({ clipId: c.id }) } : null,
      { label: 'Rename…', icon: 'edit', onClick: () => renameClip(c) },
      m && window.euclidean ? { label: 'Reveal in Explorer', icon: 'folder', onClick: () => reveal(c) } : null,
      'sep',
      { label: 'Delete', icon: 'trash', hint: 'Del', danger: true, onClick: () => { setSel(ids); setTimeout(() => remove(false), 0); } },
      { label: 'Ripple delete', icon: 'trash', hint: 'Alt+Del', danger: true, onClick: () => { setSel(ids); setTimeout(() => remove(true), 0); } },
    ]);
  };
  const addMedia = (m, trackIdx = 0, at = null, audioIdx = 0, replace = false, dir = 'down') => edit((d, s) => {
    const isAudio = m.kind === 1; const len = m.kind >= 2 ? 5 : Math.max(0.1, (m.srcOut > 0 ? m.srcOut : m.duration) - (m.srcIn || 0));
    const vt = s.videoTracks[trackIdx] || s.videoTracks[0]; const at_ = at ?? Math.max(0, ...(isAudio ? (s.audioTracks[audioIdx] || s.audioTracks[0]).clips : vt.clips).map((c) => c.start + c.duration), 0);
    const link = m.hasVideo && m.hasAudio && m.kind === 0 ? nextId(d) : '0';
    const W = s.width, H = s.height; const fit = m.width ? Math.max(W / m.width, H / m.height) : 1;
    const mk = (type) => ({ id: nextId(d), type, mediaId: m.id, name: m.name, start: at_, duration: len, in: m.srcIn || 0, speed: 1, preservePitch: false, linkId: link, enabled: true, posX: anim(0), posY: anim(0), scaleX: anim(type === 1 ? 1 : fit), scaleY: anim(type === 1 ? 1 : fit), rotation: anim(0), opacity: anim(1), volume: anim(1), uniformScale: true, effects: [], transIn: { type: 0, duration: 1 }, transOut: { type: 0, duration: 1 } });
    const vi = s.videoTracks.indexOf(vt);
    if (!isAudio) place(s, 'v', vi, mk(m.kind === 2 || m.kind === 3 ? 2 : 0), { replace, dir });
    if (m.hasAudio && m.kind !== 2) place(s, 'a', s.audioTracks[audioIdx] ? audioIdx : 0, mk(1), { replace, dir });
    sfx('press');
  });
  const [titleEdit, setTitleEdit] = useState(null); // null | {} (new) | { clipId } | { clipId, ids } (style for many)
  const [musicOpen, setMusicOpen] = useState(false);
  // Timeline area height: drag the bar above it (▲ ▼) to give the timeline or the preview more room; remembered.
  const defBottom = () => Math.round(Math.max(260, window.innerHeight * 0.38));
  const [bottomH, setBottomH] = useState(() => { try { return Number(localStorage.getItem('eu.edBottom')) || defBottom(); } catch { return defBottom(); } });
  const setBottom = (v) => { const h = v == null ? defBottom() : Math.max(150, Math.min(window.innerHeight - 220, Math.round(v))); setBottomH(h); try { if (v == null) localStorage.removeItem('eu.edBottom'); else localStorage.setItem('eu.edBottom', String(h)); } catch { /* ignore */ } };
  const startResize = (e) => {
    e.preventDefault(); const y0 = e.clientY, h0 = bottomH;
    const move = (ev) => { if (ev.buttons === 0) return up(); setBottom(h0 - (ev.clientY - y0)); };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  };
  /** Add a library track at the playhead on the Music track, quiet under the voice and no longer than the edit. */
  const addMusic = async (trackId, title) => {
    const { path: file } = await api.post('/api/music/file', { id: trackId });
    const [m] = await importPaths([file]); if (!m) return;
    edit((d, s) => {
      let ai = s.audioTracks.findIndex((tr) => tr.name === 'Music');
      if (ai < 0) { s.audioTracks.push({ type: 1, name: 'Music', muted: false, locked: false, volume: { base: 1 }, clips: [] }); ai = s.audioTracks.length - 1; }
      const end = Math.max(0, ...s.videoTracks.flatMap((tr) => tr.clips.map((c) => c.start + c.duration)));
      const at = t < end - 0.5 ? t : 0; const len = Math.max(1, Math.min(m.duration || 30, (end > at ? end - at : m.duration || 30)));
      place(s, 'a', ai, { id: nextId(d), type: 1, mediaId: m.id, name: title || m.name, start: at, duration: len, in: 0, speed: 1, preservePitch: false, linkId: '0', enabled: true, posX: anim(0), posY: anim(0), scaleX: anim(1), scaleY: anim(1), rotation: anim(0), opacity: anim(1), volume: anim(0.25), uniformScale: true, effects: [], transIn: { type: 2, duration: 0.5 }, transOut: { type: 2, duration: 1.5 } }, { replace: true });
    });
    toast(`Added "${title}" on the Music track at 25% volume. Select it to change the volume.`, { kind: 'success' });
  };
  /** A YouTube (or other) link: the engine downloads its audio, and it goes on the timeline at the playhead, full length, on the first free audio track. */
  const [linkBusy, setLinkBusy] = useState(false);
  const addLink = async (url) => {
    url = String(url || '').trim(); if (!url || linkBusy) return;
    setLinkBusy(true); toast('Getting the audio from that link. It goes on the timeline in a moment.', { kind: 'info', ms: 6000 });
    try {
      const r = await api.post('/api/studio/link', { url });
      const [m] = await importPaths([r.path]); if (!m) return;
      edit((d, s) => {
        const len = Math.max(0.5, m.duration || 30); const at = t;
        const free = (tr) => !tr.locked && !tr.clips.some((x) => x.start < at + len - 1e-3 && x.start + x.duration > at + 1e-3);
        let ai = s.audioTracks.findIndex(free);
        if (ai < 0) { s.audioTracks.push({ type: 1, name: `Audio ${s.audioTracks.length + 1}`, muted: false, locked: false, volume: { base: 1 }, clips: [] }); ai = s.audioTracks.length - 1; }
        place(s, 'a', ai, { id: nextId(d), type: 1, mediaId: m.id, name: r.title || m.name, start: at, duration: len, in: 0, speed: 1, preservePitch: false, linkId: '0', enabled: true, posX: anim(0), posY: anim(0), scaleX: anim(1), scaleY: anim(1), rotation: anim(0), opacity: anim(1), volume: anim(1), uniformScale: true, effects: [], transIn: { type: 0, duration: 1 }, transOut: { type: 0, duration: 1 } });
      });
      sfx('success'); toast(`Added "${r.title}" at the playhead. Drag it, trim it or lower its volume like any clip.`, { kind: 'success' });
    } catch (e) { sfx('error'); toast(e.message, { kind: 'error', title: "Couldn't add that link" }); }
    finally { setLinkBusy(false); }
  };
  const askLink = async () => { const u = await promptDialog({ title: 'Add audio from a YouTube link', label: 'Paste the link', placeholder: 'https://www.youtube.com/watch?v=...', confirm: 'Add to timeline' }); if (u) addLink(u); };
  // Pasting a link anywhere in Studio (not into a text box) adds it straight to the timeline.
  useEffect(() => {
    const onPaste = (e) => {
      if (document.body.dataset.screen && document.body.dataset.screen !== '/studio') return;
      const el = e.target; if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      const txt = (e.clipboardData?.getData('text') || '').trim();
      if (/^https?:\/\/(www\.|m\.|music\.)?(youtube\.com|youtu\.be)\//i.test(txt)) { e.preventDefault(); addLink(txt); }
    };
    window.addEventListener('paste', onPaste); return () => window.removeEventListener('paste', onPaste);
  });
  /** Replace the project with a version the engine produced (AI / agent edit), keeping Ctrl+Z working. */
  const adoptServerData = (next) => { setDataRaw((prev) => { undo.current.push(JSON.stringify(prev)); redo.current = []; return markCaptions(next); }); setDirty(false); };
  const aiEdit = async (instruction) => {
    clearTimeout(saveTimer.current);
    const r = await api.post(`/api/projects/${id}/ai-edit`, { instruction, data });
    if (r.changed) adoptServerData(r.data);
    return r;
  };
  const aiUndo = async () => { const r = await act(() => api.post(`/api/projects/${id}/ai-undo`), { ok: 'Undid the last AI edit' }); adoptServerData(r.data); };
  useEvent('studio.updated', (x) => {
    if (x.projectId !== id || x.via?.startsWith('ai:') || x.via === 'undo') return; // our own AI edits are already applied
    if (dirtyRef.current) { toast(`${x.via?.startsWith('agent:') ? 'An agent' : 'Someone'} changed this project. Save or undo your changes, then reopen it to see theirs.`, { kind: 'warn', ms: 8000 }); return; }
    api.get(`/api/projects/${id}`).then((p) => { adoptServerData(p.data); toast(x.done?.slice(0, 3).join(' · ') || 'Project updated', { kind: 'info', title: x.via?.startsWith('agent:') ? `Edited by ${x.via.slice(6)}` : 'Project updated' }); });
  }, [id]);
  const addText = () => setTitleEdit({});
  const saveTitle = ({ text, posY, duration, fade }) => {
    const tid = titleEdit?.clipId;
    if (titleEdit?.ids?.length > 1) {
      // One style for many: every selected title/caption gets the look (and the position, if you moved it); words and timing stay.
      const first = findClip(seq, tid)?.c; const movedY = first && Math.abs(valAt(first.posY, 0) - posY) > 1;
      edit((d, s) => { for (const cid of titleEdit.ids) { const f = findClip(s, cid); if (!f || f.c.type !== 3) continue; for (const k of STYLE_KEYS) if (text[k] !== undefined) f.c.text[k] = text[k]; if (movedY && !isAnimated(f.c.posY)) f.c.posY = anim(posY); } });
      setTitleEdit(null); sfx('success'); return;
    }
    edit((d, s) => {
      if (tid) { const f = findClip(s, tid); if (!f) return; const c = f.c; c.text = text; c.name = text.text.slice(0, 40); c.duration = duration; c.posY = isAnimated(c.posY) ? c.posY : anim(posY); c.transIn = { type: fade ? 2 : 0, duration: fade || 0.25 }; c.transOut = { type: fade ? 2 : 0, duration: fade || 0.25 }; return; }
      place(s, 'v', s.videoTracks.length - 1, { id: nextId(d), type: 3, mediaId: '', name: text.text.slice(0, 40), start: t, duration, in: 0, speed: 1, preservePitch: false, linkId: '0', enabled: true, posX: anim(0), posY: anim(posY), scaleX: anim(1), scaleY: anim(1), rotation: anim(0), opacity: anim(1), volume: anim(1), uniformScale: true, effects: [], transIn: { type: fade ? 2 : 0, duration: fade || 0.25 }, transOut: { type: fade ? 2 : 0, duration: fade || 0.25 }, text });
    });
    setTitleEdit(null); sfx('success');
  };

  // keyboard
  useEffect(() => {
    const k = (e) => {
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;
      if (document.querySelector('.modal')) return; // dialogs (title designer, export) get the keyboard
      const mod = e.ctrlKey || e.metaKey; const key = e.key.toLowerCase();
      if (mod && key === 'z' && !e.shiftKey) { e.preventDefault(); doUndo(); }
      else if (mod && (key === 'y' || (key === 'z' && e.shiftKey))) { e.preventDefault(); doRedo(); }
      else if (mod && key === 's') { e.preventDefault(); save(); }
      else if (mod && key === 'c') { if (copyClips()) e.preventDefault(); }
      else if (mod && key === 'x') { e.preventDefault(); cut(); }
      else if (mod && key === 'v') { e.preventDefault(); pasteAt(t); }
      else if (mod && key === 'd' && e.shiftKey) { e.preventDefault(); if (sel.length) setTransitions(sel, 1); }
      else if (mod && key === 'd') { e.preventDefault(); duplicate(); }
      else if (mod && key === 'r') { e.preventDefault(); if (sel.length) speedDialog(); }
      else if (e.shiftKey && key === 'e' && sel.length) { e.preventDefault(); const on = sel.every((cid) => findClip(seq, cid)?.c.enabled !== false); setEnabled(sel, !on); }
      else if (key === ' ') { e.preventDefault(); setPlaying((p) => !p); }
      else if (key === 'l') setPlaying(true);
      else if (key === 'k') setPlaying(false);
      else if (key === 'j') { setPlaying(false); setT((x) => Math.max(0, x - 1)); }
      else if (key === 's' && !mod) { e.preventDefault(); split(e.shiftKey); }
      else if (mod && key === 'b') { e.preventDefault(); split(true); }
      else if (mod && key === 'a') { e.preventDefault(); setSel([...seq.videoTracks, ...seq.audioTracks].filter((tr) => !tr.locked).flatMap((tr) => tr.clips.map((c) => c.id))); }
      else if (key === 'q' && !mod) { e.preventDefault(); trimToPlayhead('before'); }
      else if (key === 'w' && !mod) { e.preventDefault(); trimToPlayhead('after'); }
      else if (key === 'v') setTool('select');
      else if (key === 'c') setTool('razor');
      else if (key === 'f2' && sel.length) { e.preventDefault(); const f = findClip(seq, sel[0]); if (f) renameClip(f.c); }
      else if (key === 't' && !mod) addText();
      else if ((key === 'delete' || key === 'backspace') && sel.length) { e.preventDefault(); remove(e.altKey || e.shiftKey); }
      else if (key === 'arrowleft') { e.preventDefault(); setT((x) => Math.max(0, x - (e.shiftKey ? 1 : 1 / (seq?.fps || 30)))); }
      else if (key === 'arrowright') { e.preventDefault(); setT((x) => x + (e.shiftKey ? 1 : 1 / (seq?.fps || 30))); }
      else if (key === 'home') setT(0);
      else if (key === 'end') setT(duration);
      else if (key === '=' || key === '+') setZoom((z) => Math.min(600, z * 1.25));
      else if (key === '-') setZoom((z) => Math.max(4, z / 1.25));
    };
    const k0 = k; const kk = (e) => { if (document.body.dataset.screen && document.body.dataset.screen !== '/studio') return; k0(e); }; window.addEventListener('keydown', kk); return () => window.removeEventListener('keydown', kk);
  }, [sel, t, duration, seq, data]);

  if (!data || !seq) return html`<div class="page"><${Loading} /></div>`;
  const selected = sel.length === 1 ? findClip(seq, sel[0]) : null;

  const exportNow = async () => { await save(true); setExporting(true); };
  return html`<div style=${`position:absolute;inset:0;display:grid;grid-template-columns:minmax(0, 1fr);grid-template-rows:46px minmax(0, 1fr) ${bottomH}px;background:var(--ed-bg)`}>
    <div class="row" style="padding:0 12px;background:var(--surface);border-bottom:1px solid var(--line);gap:10px;min-width:0;overflow-x:auto">
      <${Button} kind="ghost" size="sm" icon="chevronLeft" title="All projects" onClick=${() => { if (dirty) save(true); navigate('/studio'); }} />
      <b class="ellipsis" style="max-width:260px;cursor:text" title="Click to rename the project" onClick=${renameProject}>${proj.name || 'Untitled edit'}</b><span class="faint tnum" style="font-size:var(--fs-sm)">${seq.width}×${seq.height} · ${seq.fps} fps</span>
      <span class="faint" style="font-size:var(--fs-xs)">${dirty ? 'Unsaved changes' : 'Saved'}</span>
      <div class="spacer" />
      <div class="btn-group"><button class=${tool === 'select' ? 'on' : ''} title="Selection (V)" onClick=${() => { sfx('tap'); setTool('select'); }}><${Icon} name="pointer" size=${14} /></button><button class=${tool === 'razor' ? 'on' : ''} title="Razor (C)" onClick=${() => { sfx('tap'); setTool('razor'); }}><${Icon} name="scissors" size=${14} /></button><button title="Add title (T)" onClick=${addText}><${Icon} name="type" size=${14} /></button></div>
      <button class=${'chip' + (snap ? ' on' : '')} title="Snapping (hold Alt to bypass)" onClick=${() => { sfx('toggle'); setSnap(!snap); }}><${Icon} name="magnet" size=${13} />Snap</button>
      <${Button} kind="ghost" size="sm" icon="scissors" title="Split at playhead (S, Shift+S for all tracks)" onClick=${() => split(false)} />
      <${Button} kind="ghost" size="sm" icon="undo" title="Undo (Ctrl+Z)" disabled=${!undo.current.length} onClick=${doUndo} />
      <${Button} kind="ghost" size="sm" icon="redo" title="Redo (Ctrl+Shift+Z)" disabled=${!redo.current.length} onClick=${doRedo} />
      <div style="width:1px;height:22px;background:var(--line)" />
      <${Button} kind="ghost" size="sm" icon="volume" onClick=${() => setMusicOpen(true)} title="Free music library: listen and add">Music</${Button}>
      <${Button} kind="ghost" size="sm" icon="link" disabled=${linkBusy} onClick=${askLink} title="Paste a YouTube link and its audio goes on the timeline at the playhead (or just press Ctrl+V on the timeline)">${linkBusy ? 'Getting audio...' : 'YouTube link'}</${Button}>
      <${Button} kind="ghost" size="sm" icon="external" onClick=${() => act(() => api.post(`/api/projects/${id}/open-velo`), { ok: 'Opening in Velo', sound: 'open' })}>Open in Velo</${Button}>
      <${Button} kind="ghost" size="sm" onClick=${() => save()}>Save</${Button}>
      <${Button} kind="primary" size="sm" icon="upload" onClick=${exportNow}>Export</${Button}>
    </div>
    <div style="display:grid;grid-template-columns:260px minmax(0, 1fr) 300px;min-height:0">
      <${LeftPanel} tab=${leftTab} setTab=${setLeftTab} data=${data} onAdd=${addMedia} selected=${selected} edit=${edit} importFiles=${importFiles} importPaths=${importPaths} importing=${importing} aiEdit=${aiEdit} aiUndo=${aiUndo} projectId=${id} />
      <${Monitor} seq=${seq} media=${media} t=${t} setT=${setT} playing=${playing} setPlaying=${setPlaying} duration=${duration} selected=${selected} sel=${sel} edit=${edit} setSel=${setSel} onEditTitle=${(cid) => setTitleEdit({ clipId: cid })} />
      <${EffectControls} selected=${selected} sel=${sel} findClip=${findClip} seq=${seq} edit=${edit} media=${media} t=${t} setT=${setT} onEditTitle=${(cid, ids) => setTitleEdit({ clipId: cid, ids })} />
    </div>
    <div style="display:flex;flex-direction:column;min-height:0;position:relative">
    <div class="ed-split" title="Drag up or down to resize the timeline (double-click to reset)" onPointerDown=${startResize} onDblClick=${() => setBottom(null)}><span>▲</span><span class="ed-grip" /><span>▼</span></div>
    <${CaptionsBar} seq=${seq} media=${media} sel=${sel} setSel=${setSel} edit=${edit} findClip=${findClip} nextId=${nextId} />
    <${Timeline} seq=${seq} media=${media} t=${t} setT=${setT} sel=${sel} setSel=${setSel} tool=${tool} snap=${snap} zoom=${zoom} setZoom=${setZoom} duration=${duration} edit=${edit} findClip=${findClip} linked=${linked} onAdd=${addMedia} nextId=${nextId} onDropFiles=${dropFilesOnTrack} onClipMenu=${clipMenu} onEditTitle=${(cid) => setTitleEdit({ clipId: cid })} /></div>
    ${exporting ? html`<${ExportDialog} id=${id} onClose=${() => setExporting(false)} />` : null}
    ${musicOpen ? html`<${MusicLibrary} onClose=${() => setMusicOpen(false)} onAdd=${addMusic} />` : null}
    ${titleEdit ? html`<${TitleDesigner} seq=${seq} clip=${titleEdit.clipId ? findClip(seq, titleEdit.clipId)?.c : null} count=${titleEdit.ids?.length || 1} onClose=${() => setTitleEdit(null)} onSave=${saveTitle} />` : null}
  </div>`;
}

/**
 * Put a clip on a track without destroying anything: clips it lands on are pushed down one
 * layer (V2 → V1, A1 → A2), cascading, and a new track is added when the bottom is reached.
 * Hold Shift while dropping to push them up a layer instead, or Ctrl to overwrite
 * (Velo/Premiere behaviour: what's underneath is trimmed).
 * kind: 'v' | 'a'. Returns the number of clips that were moved.
 */
function place(s, kind, ti, c, { replace = false, keep = new Set(), dir = 'down' } = {}) {
  const list = kind === 'v' ? s.videoTracks : s.audioTracks;
  ti = Math.max(0, Math.min(list.length - 1, ti));
  if (replace) { overwrite(list[ti], c); return 0; }
  const tr = list[ti];
  const hit = (x) => x.id !== c.id && !keep.has(x.id) && x.start < c.start + c.duration - 1e-6 && x.start + x.duration > c.start + 1e-6;
  const bumped = tr.clips.filter(hit);
  tr.clips = [...tr.clips.filter((x) => !bumped.includes(x) && x.id !== c.id), c].sort((a, b) => a.start - b.start);
  let pushed = 0;
  for (const x of bumped) { pushed += 1 + pushAside(s, kind, list.indexOf(tr), x, keep, dir); }
  return pushed;
}
/**
 * The next layer down (or up) as it appears on screen: video tracks are drawn V1 at the bottom,
 * audio tracks A1 at the top. A new track is added when there's no layer left in that direction.
 */
function pushAside(s, kind, fromTi, x, keep, dir) {
  const list = kind === 'v' ? s.videoTracks : s.audioTracks;
  const step = (kind === 'v') === (dir === 'down') ? -1 : 1;
  let ti = fromTi + step;
  while (ti >= 0 && ti < list.length && list[ti].locked) ti += step;
  if (ti < 0 || ti >= list.length) {
    const fresh = { type: kind === 'v' ? 0 : 1, name: '', muted: false, locked: false, volume: { base: 1 }, clips: [] };
    if (ti < 0) { list.unshift(fresh); ti = 0; } else { list.push(fresh); ti = list.length - 1; }
    list.forEach((t, i) => { if (!t.name || /^[VA]\d+$/.test(t.name)) t.name = `${kind === 'v' ? 'V' : 'A'}${i + 1}`; });
  }
  return place(s, kind, ti, x, { keep, dir });
}

/** Velo's overwrite-insert: whatever the new clip covers on its track is trimmed or removed. */
function overwrite(track, c) {
  const s = c.start, e = c.start + c.duration;
  const out = [];
  for (const x of track.clips) {
    if (x.id === c.id) continue;
    const xe = x.start + x.duration;
    if (xe <= s + 1e-6 || x.start >= e - 1e-6) { out.push(x); continue; }
    if (x.start < s - 1e-6) { const left = { ...x, duration: s - x.start }; out.push(left); if (xe > e + 1e-6) out.push({ ...clone(x), id: x.id + 'r' + Math.round(e * 1000), start: e, duration: xe - e, in: (x.in || 0) + (e - x.start) * (x.speed || 1) }); }
    else if (xe > e + 1e-6) out.push({ ...x, start: e, duration: xe - e, in: (x.in || 0) + (e - x.start) * (x.speed || 1) });
  }
  out.push(c); out.sort((a, b) => a.start - b.start);
  track.clips = out.filter((x) => x.duration > 0.01);
}

// ------------------------------------------------------------ AI edit: describe a change, the connected AI makes it
const AI_EXAMPLES = ['Add a hook title "WAIT FOR IT" for the first 2 seconds', 'Slowly zoom in on the first clip from 100% to 120%', 'Cut the first 2 seconds', 'Add cross dissolves between the clips', 'Make the whole edit black and white', 'Add a subscribe banner for the last 3 seconds'];
/** Change all selected captions at once: size, font, and "2 words per line" so none run off the screen. */
const argbOf = (hex) => '#ff' + String(hex || '#ffffff').replace('#', '').slice(-6).toLowerCase();
/** A caption look (the same quick looks as the clip panel) as Studio text settings, for captions and for the Hook title. */
function lookText(v, hook) {
  if (hook) {
    const font = v.hookFont || v.font;
    return { family: font, bold: HEAVY.has(font), pixelSize: v.hookSize || Math.round((v.size || 84) * 0.72), uppercase: !!v.hookUpper, color: argbOf(v.hookColor || '#ffffff'),
      box: !!v.hookBox, boxColor: argbOf(v.hookBg || '#ffffff'), boxPad: 18, boxRadius: v.hookBox ? v.hookRadius || 0 : 0, outlineColor: argbOf(v.hookOutline || '#000000'), outlineWidth: v.hookBox ? 0 : Math.round((v.hookOutlineWidth ?? 8) / 2), shadow: v.hookBox ? 0 : v.shadow || 0 };
  }
  return { family: v.font, bold: HEAVY.has(v.font), pixelSize: v.size || 84, uppercase: v.uppercase !== false, color: argbOf(v.primary), outlineColor: argbOf(v.outline), outlineWidth: Math.round((v.outlineWidth ?? 7) / 2), shadow: v.shadow || 0, box: false, hlColor: argbOf(v.highlight) };
}

function CaptionsBar({ seq, media, sel, setSel, edit, findClip, nextId }) {
  // Open / closed (remembered), so the caption tools never crowd the timeline; the keyword word list has its own toggle.
  const [open, setOpenRaw] = useState(() => { try { return localStorage.getItem('eu.capOpen') !== '0'; } catch { return true; } });
  const setOpen = (v) => { setOpenRaw(v); try { localStorage.setItem('eu.capOpen', v ? '1' : '0'); } catch { /* ignore */ } };
  const [showWords, setShowWords] = useState(false);
  const [look, setLook] = useState('signature'); const [titleLook, setTitleLook] = useState(''); const [busy, setBusy] = useState('');
  if (!seq) return null;
  const all = [...seq.videoTracks].flatMap((tr) => tr.clips.filter(isCaption));
  const lookV = (LOOKS.find((l) => l.id === look) || LOOKS[0]).v;
  // Captions follow what you hear: the clips on the audio tracks (or the video clips when there are none).
  const sources = () => {
    const pick = (tracks, type) => tracks.filter((tr) => !tr.muted).flatMap((tr) => tr.clips).filter((c) => c.type === type && c.enabled !== false && media[c.mediaId]?.path);
    const a = pick(seq.audioTracks, 1); return (a.length ? a : pick(seq.videoTracks.filter((tr) => tr.name !== 'B-roll'), 0)).map((c) => ({ path: media[c.mediaId].path, in: c.in || 0, duration: c.duration, start: c.start, speed: c.speed || 1 }));
  };
  const insert = (caps) => edit((d, s) => {
    for (const tr of s.videoTracks) tr.clips = tr.clips.filter((c) => !isCaption(c));
    let tr = s.videoTracks.find((x) => x.name === 'Captions');
    if (!tr) { tr = { type: 0, name: 'Captions', muted: false, locked: false, volume: { base: 1 }, clips: [] }; const hi = s.videoTracks.findIndex((x) => x.name === 'Hook'); s.videoTracks.splice(hi >= 0 ? hi : s.videoTracks.length, 0, tr); }
    const a = (v) => ({ base: v }); const posY = Math.round(s.height * 0.28);
    for (const k of caps) tr.clips.push({ id: nextId(d), type: 3, mediaId: '', name: k.text, start: k.start, duration: k.duration, in: 0, speed: 1, preservePitch: false, linkId: '0', enabled: true, posX: a(0), posY: a(posY), scaleX: a(1), scaleY: a(1), rotation: a(0), opacity: a(1), volume: a(1), uniformScale: true, effects: [], transIn: { type: 0, duration: 1 }, transOut: { type: 0, duration: 1 },
      text: { text: k.text, ...lookText(lookV, false), hlMode: 'word', words: k.words, keywords: [] }, isCaption: true });
    tr.clips.sort((x, y) => x.start - y.start);
  });
  const addCaptions = async () => {
    const src = sources(); if (!src.length) return toast('Put a video or audio clip on the timeline first.', { kind: 'warn' });
    if (all.length && !(await confirmDialog({ title: 'Make the captions again?', text: 'The captions on the timeline are replaced with new ones from the transcript. Undo (Ctrl+Z) brings the old ones back.', confirm: 'Make captions' }))) return;
    const req = { clips: src, wordsPerLine: lookV.wordsPerLine || 3, uppercase: lookV.uppercase !== false };
    try {
      setBusy('Getting the words…');
      let r = await api.post('/api/studio/captions', req);
      if (r.missing.length) {
        // No transcript yet: transcribe those videos (free Whisper on this PC), then come back for the captions.
        await api.post('/api/studio/transcribe', { paths: r.missing });
        setBusy('Transcribing the audio (a few minutes for long videos)…');
        const t0 = Date.now();
        while (r.missing.length && Date.now() - t0 < 45 * 60000) { await new Promise((ok) => setTimeout(ok, 6000)); r = await api.post('/api/studio/captions', req); }
        if (r.missing.length) throw new Error('Transcribing is taking a long time. Check Production → jobs, then press Add captions again.');
      }
      if (!r.captions.length) throw new Error('No speech was found in these clips.');
      insert(r.captions); sfx('success'); toast(`${r.captions.length} captions added with the spoken word highlighted. Change the look or highlight below.`, { kind: 'success' });
    } catch (e) { sfx('error'); toast(e.message, { kind: 'error' }); } finally { setBusy(''); }
  };
  // Captions and the opening title have their own looks (e.g. a TikTok title over Signature captions).
  const applyLook = (id, which) => {
    const v = (LOOKS.find((l) => l.id === id) || LOOKS[0]).v; if (which === 'title') setTitleLook(id); else setLook(id);
    edit((d, s) => { for (const tr of s.videoTracks) for (const c of tr.clips) {
      if (which !== 'title' && isCaption(c)) c.text = { ...c.text, ...lookText(v, false) };
      else if (which === 'title' && isHook(c) && c.text) { c.text = { ...c.text, ...lookText(v, true) }; c.rotation = { base: v.hookTilt || 0 }; }
    } });
    sfx('tap');
  };
  const hasHook = seq.videoTracks.some((tr) => tr.clips.some(isHook));
  const top = html`<div class="row wrap" style="gap:8px;padding:6px 12px;border-top:1px solid var(--line);background:var(--surface-2);font-size:var(--fs-sm)">
    <button type="button" class="chip" style="font-weight:700" title=${open ? 'Hide the caption tools (more room for the timeline)' : 'Show the caption tools'} aria-expanded=${open} onClick=${() => setOpen(!open)}>${open ? '▾' : '▸'} Captions</button>
    <${Button} size="sm" kind=${all.length ? 'ghost' : 'primary'} icon="type" disabled=${!!busy} onClick=${addCaptions}>${all.length ? 'Make captions again' : 'Add captions'}</${Button}>
    <span class="faint">Captions look</span>
    <select class="select sm" style="width:auto" value=${look} onChange=${(e) => applyLook(e.target.value, 'captions')} aria-label="Caption look" title="Applies to every caption">${LOOKS.map((l) => html`<option value=${l.id}>${l.label}</option>`)}</select>
    ${hasHook ? html`<span class="faint">Title look</span>
    <select class="select sm" style="width:auto" value=${titleLook} onChange=${(e) => applyLook(e.target.value, 'title')} aria-label="Title look" title="Applies to the opening title (the text at the top)"><option value="" disabled>Pick…</option>${LOOKS.map((l) => html`<option value=${l.id}>${l.label}</option>`)}</select>` : null}
    ${busy ? html`<span class="badge sky">${busy}</span>` : !all.length ? html`<span class="faint">Makes captions from what's said, with the spoken word highlighted in gold.</span>` : null}
  </div>`;
  if (!all.length || !open) return top;
  const chosen = sel.map((id) => findClip(seq, id)?.c).filter(isCaption);
  const ids = chosen.length ? chosen.map((c) => c.id) : [];
  const forAll = (fn) => edit((d, s) => { for (const cid of ids) { const f = findClip(s, cid); if (f && isCaption(f.c)) fn(f.c); } });
  const size = chosen[0]?.text?.pixelSize || 96;
  const scale = (k) => forAll((c) => { c.text.pixelSize = Math.max(20, Math.min(320, Math.round((c.text.pixelSize || 96) * k))); });
  const twoWords = () => edit((d, s) => {
    const made = [];
    for (const cid of ids.length ? ids : all.map((c) => c.id)) {
      const f = findClip(s, cid); if (!f || !isCaption(f.c)) continue;
      const c = f.c; const words = String(c.text.text || '').trim().split(/\s+/).filter(Boolean);
      if (words.length <= 2) { made.push(c.id); continue; }
      const parts = []; for (let i = 0; i < words.length; i += 2) parts.push(words.slice(i, i + 2).join(' '));
      // With word timings each piece starts when its first word is said (keeps the spoken-word highlight in step); else split by length.
      const tw = Array.isArray(c.text.words) && c.text.words.length === words.length ? c.text.words : null;
      const total = parts.reduce((n, x) => n + x.length + 1, 0); let at = c.start; const start0 = c.start; const end = c.start + c.duration;
      parts.forEach((txt, i) => {
        const next = i === parts.length - 1 ? end : tw ? start0 + tw[(i + 1) * 2].s : at + c.duration * ((txt.length + 1) / total);
        const piece = i === 0 ? c : clone(c); if (i > 0) { piece.id = nextId(d); f.tr.clips.push(piece); }
        const off = at - start0;
        piece.start = at; piece.duration = Math.max(0.05, next - at); piece.name = txt;
        piece.text = { ...piece.text, text: txt, words: tw ? tw.slice(i * 2, i * 2 + 2).map((w) => ({ ...w, s: Math.max(0, w.s - off), e: Math.max(0, w.e - off) })) : undefined };
        made.push(piece.id); at = next;
      });
    }
    setTimeout(() => setSel(made), 0);
  });
  // Highlight: applies to the selected captions, or to all of them when none are selected.
  const targets = ids.length ? chosen : all;
  const forTargets = (fn) => edit((d, s) => { for (const c0 of targets) { const f = findClip(s, c0.id); if (f && isCaption(f.c)) fn(f.c); } });
  const hlMode = targets[0]?.text?.hlMode || 'none';
  const hlColor = '#' + String(targets[0]?.text?.hlColor || '#fff2c14e').replace('#', '').slice(-6);
  const keywords = all[0]?.text?.keywords || [];
  const kwSet = new Set(keywords.map(normWord));
  // Keywords are shared by every caption, so a word lights up wherever it appears.
  const setKeywords = (list) => edit((d, s) => { for (const c0 of all) { const f = findClip(s, c0.id); if (f) f.c.text.keywords = list; } });
  const toggleWord = (w) => { const k = normWord(w); if (!k) return; setKeywords(kwSet.has(k) ? keywords.filter((x) => normWord(x) !== k) : [...keywords, k]); };
  const autoPick = async () => {
    try { const r = await api.post('/api/captions/keywords', { text: all.map((c) => c.text?.text || '').join(' ') }); setKeywords(r.keywords || []); toast(`${(r.keywords || []).length} keyword${(r.keywords || []).length === 1 ? '' : 's'} picked. Click any word below to change them.`, { kind: 'success' }); } catch (e) { toast(e.message, { kind: 'error' }); }
  };
  const wordsShown = [...new Set((ids.length ? chosen : all).flatMap((c) => String(c.text?.text || '').split(/\s+/)).filter((w) => normWord(w)))].slice(0, 60);
  return html`<div class="col" style="gap:0;border-top:1px solid var(--line);background:var(--surface-2);font-size:var(--fs-sm)">
  ${top}
  <div class="row wrap" style="gap:8px;padding:6px 12px">
    <b>Highlight</b>
    <${Seg} value=${hlMode} onChange=${(v) => forTargets((c) => { c.text.hlMode = v; if (!c.text.hlColor) c.text.hlColor = '#fff2c14e'; })} options=${[{ value: 'none', label: 'Off' }, { value: 'word', label: 'Spoken word' }, { value: 'keywords', label: 'Keywords' }]} />
    ${hlMode !== 'none' ? html`<input type="color" value=${hlColor} title="Highlight colour" aria-label="Highlight colour" style="width:34px;height:26px;padding:0;border:0;background:none;cursor:pointer" onInput=${(e) => forTargets((c) => { c.text.hlColor = '#ff' + e.target.value.slice(1); })} />` : null}
    ${hlMode === 'keywords' ? html`<${Button} size="sm" kind="soft" onClick=${autoPick}>Pick keywords for me</${Button}>${keywords.length ? html`<${Button} size="sm" kind="ghost" onClick=${() => setKeywords([])}>Clear</${Button}>` : null}` : null}
    ${hlMode === 'keywords' ? html`<button type="button" class="chip" aria-expanded=${showWords} onClick=${() => setShowWords(!showWords)} title="Show or hide the words to click">${showWords ? '▾' : '▸'} Words${keywords.length ? ` (${keywords.length} on)` : ''}</button>` : null}
    <span class="faint">${ids.length ? `for the ${ids.length} selected caption${ids.length > 1 ? 's' : ''}` : 'for all captions'}</span>
  </div>
  ${hlMode === 'keywords' && showWords ? html`<div class="row wrap" style="gap:4px;padding:0 12px 6px;max-height:86px;overflow:auto">
    <span class="faint" style="font-size:var(--fs-xs)">Click words to highlight:</span>
    ${wordsShown.map((w) => html`<button type="button" class="badge ${kwSet.has(normWord(w)) ? 'gold' : ''}" style="cursor:pointer;border:1px solid var(--line)" onClick=${() => toggleWord(w)}>${w}</button>`)}
  </div>` : null}
  <div class="row wrap" style="gap:8px;padding:6px 12px">
    <b>Edit captions</b>
    ${ids.length ? html`<span class="faint">${ids.length} selected</span>` : html`<span class="faint">click a caption to pick it, or Select all captions</span>`}
    <${Button} size="sm" kind="ghost" onClick=${() => setSel(all.map((c) => c.id))}>Select all captions</${Button}>
    ${!ids.length ? html`<${Button} size="sm" kind="soft" onClick=${twoWords} title="Split every caption into 2-word pieces so none run off the screen">2 words per line (all captions)</${Button}>` : null}
    ${ids.length ? html`
      <span class="faint">Size</span><${Button} size="sm" kind="ghost" onClick=${() => scale(1 / 1.1)}>A−</${Button}>
      <input class="input sm tnum" type="number" style="width:70px" value=${size} min="20" max="320" onChange=${(e) => { const v = Number(e.target.value); if (v > 0) forAll((c) => { c.text.pixelSize = Math.max(20, Math.min(320, v)); }); }} aria-label="Caption size" />
      <${Button} size="sm" kind="ghost" onClick=${() => scale(1.1)}>A+</${Button}>
      <select class="select sm" style="width:auto;font-family:'${chosen[0]?.text?.family || 'Montserrat'}'" value=${chosen[0]?.text?.family || 'Montserrat'} onChange=${(e) => forAll((c) => { c.text.family = e.target.value; c.text.bold = HEAVY.has(e.target.value); })} aria-label="Caption font">
        ${FONT_GROUPS.map(([g, list]) => html`<optgroup label=${g}>${list.map((f) => html`<option value=${f} style=${{ fontFamily: `'${f}'` }}>${f}</option>`)}</optgroup>`)}</select>
      <${Button} size="sm" kind="soft" onClick=${twoWords} title="Split every selected caption into 2-word pieces so none run off the screen">2 words per line</${Button}>
      <${Button} size="sm" kind="ghost" onClick=${() => setSel([])}>Done</${Button}>` : null}
  </div></div>`;
}

function AIPanel({ aiEdit, aiUndo, projectId, selected }) {
  const boot = useStore((st) => st.boot);
  const connected = Object.values(boot?.connections?.ai || {}).some(Boolean);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState([]);
  const send = async () => {
    const instruction = text.trim() + (selected ? ` (the selected clip is c${selected.c.id})` : '');
    if (!text.trim() || busy) return;
    setBusy(true);
    try {
      const r = await aiEdit(instruction);
      setLog((l) => [{ q: text.trim(), ...r }, ...l].slice(0, 20)); setText('');
      sfx(r.changed ? 'success' : 'error');
    } catch (e) { sfx('error'); setLog((l) => [{ q: text.trim(), errors: [e.message], done: [] }, ...l]); } finally { setBusy(false); }
  };
  return html`<div class="col" style="gap:10px;padding:2px">
    ${!connected ? html`<div class="notice gold" style="font-size:var(--fs-xs)"><${Icon} name="info" size=${14} />Connect Claude, GPT or Grok in Settings → Connections (or Agent Connections) to edit with AI.</div>` : null}
    <div class="faint" style="font-size:var(--fs-xs)">Describe the change. The AI edits the timeline with the same tools you use; every change can be undone.</div>
    <textarea class="textarea" rows="4" placeholder="e.g. Add a lower third saying “Jordan · host” at 3 seconds and zoom in slowly on the first clip" value=${text} onInput=${(e) => setText(e.target.value)} onKeyDown=${(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} aria-label="Describe the edit" />
    <div class="row"><${Button} kind="primary" size="sm" icon="sparkle" busy=${busy} disabled=${!connected || !text.trim()} onClick=${send}>Edit with AI</${Button}><${Button} kind="ghost" size="sm" icon="undo" onClick=${aiUndo}>Undo AI edit</${Button}></div>
    <div class="chips">${AI_EXAMPLES.map((x) => html`<button class="chip" style="height:auto;padding:4px 9px;text-align:left" onClick=${() => setText(x)}>${x}</button>`)}</div>
    ${log.map((r) => html`<div class="panel pad col" style="gap:4px;font-size:var(--fs-xs)"><b style="font-size:var(--fs-sm)">${r.q}</b>
      ${r.say ? html`<div class="muted">${r.say}</div>` : null}
      ${(r.done || []).map((d) => html`<div style="color:var(--moss-ink)">✓ ${d}</div>`)}
      ${(r.errors || []).map((d) => html`<div style="color:var(--coral-ink)">• ${d}</div>`)}
      ${!r.done?.length && !r.errors?.length ? html`<div class="faint">No changes were needed.</div>` : null}</div>`)}
  </div>`;
}

// ------------------------------------------------------------ export: choose where the video is saved
function ExportDialog({ id, onClose }) {
  const [d, setD] = useState(null);
  const [reveal, setReveal] = useState(true);
  useEffect(() => { api.get(`/api/projects/${id}/export-defaults`).then(setD).catch((e) => { toast(e.message, { kind: 'error' }); onClose(); }); }, [id]);
  const choose = async () => { const r = await act(() => api.post('/api/system/pick-folder', { title: 'Save the exported video in…', defaultPath: d.folder })); if (r?.path) setD({ ...d, folder: r.path }); };
  const start = () => act(() => api.post(`/api/projects/${id}/export`, { folder: d.folder, fileName: d.fileName, reveal }), { ok: 'Exporting. The folder opens when the video is ready.' }).then(onClose);
  return html`<${Modal} title="Export video" icon="upload" onClose=${onClose} footer=${html`<${Button} kind="ghost" onClick=${onClose}>Cancel</${Button}><${Button} kind="primary" icon="upload" disabled=${!d} onClick=${start}>Export</${Button}>`}>
    ${!d ? html`<${Loading} rows=${2} />` : html`<div class="col" style="gap:14px">
      <${Field} label="Save in" id="ex-folder"><div class="row"><input id="ex-folder" class="input mono grow" value=${d.folder} onInput=${(e) => setD({ ...d, folder: e.target.value })} />${d.desktop ? html`<${Button} kind="soft" icon="folder" onClick=${choose}>Choose folder…</${Button}>` : null}</div></${Field}>
      <${Field} label="File name" hint="An existing file is never overwritten; a number is added instead." id="ex-name"><input id="ex-name" class="input" value=${d.fileName} onInput=${(e) => setD({ ...d, fileName: e.target.value })} /></${Field}>
      <div class="check-row"><${Toggle} on=${reveal} label="Open folder when done" onChange=${setReveal} /><span>Open the folder when the video is ready</span></div>
      <div class="faint" style="font-size:var(--fs-sm)">MP4 (H.264 + AAC) at the sequence size. Progress shows in the status bar at the bottom.</div>
    </div>`}</${Modal}>`;
}

// ------------------------------------------------------------ left: project bin + effects
function LeftPanel({ tab, setTab, data, onAdd, selected, edit, importFiles, importPaths, importing, aiEdit, aiUndo, projectId }) {
  const fileRef = useRef(null);
  const busy = importing;
  const importDisk = async () => {
    if (!window.euclidean?.pickFiles) return fileRef.current.click();
    const r = await api.post('/api/system/pick', { multi: true, filters: [{ name: 'Video, audio and images', extensions: ['mp4', 'mov', 'm4v', 'mkv', 'webm', 'avi', 'mts', 'm2ts', 'mxf', 'wmv', 'flv', '3gp', 'mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'tif', 'tiff', 'svg'] }, { name: 'All files', extensions: ['*'] }] });
    if (r.paths?.length) await importPaths(r.paths);
  };
  const applyEffect = (fx) => {
    if (!selected || selected.c.type === 1) return toast('Select a video, image or title clip first', { kind: 'warn' });
    edit((d, s) => { const tr = [...s.videoTracks].find((x) => x.clips.some((c) => c.id === selected.c.id)); const c = tr.clips.find((x) => x.id === selected.c.id); c.effects.push({ effectId: fx.id, enabled: true, params: Object.fromEntries(fx.params.map((p) => [p[0], anim(p[4])])) }); });
    sfx('success');
  };
  const applyTransition = (tt, edge) => {
    if (!selected) return toast('Select a clip first', { kind: 'warn' });
    edit((d, s) => { for (const tr of [...s.videoTracks, ...s.audioTracks]) { const c = tr.clips.find((x) => x.id === selected.c.id); if (c) c[edge] = { type: tt.type, duration: Math.min(1, c.duration / 3) }; } });
    sfx('success');
  };
  return html`<div style="display:flex;flex-direction:column;min-height:0;background:var(--ed-panel);border-right:1px solid var(--line)">
    <div class="row" style="padding:8px 10px;border-bottom:1px solid var(--line)"><${Seg} value=${tab} onChange=${setTab} options=${[{ value: 'media', label: 'Project' }, { value: 'effects', label: 'Effects' }, { value: 'ai', label: 'AI' }]} /><div class="spacer" />${tab === 'media' ? html`<${Button} size="sm" kind="soft" icon="plus" busy=${busy} title="Import media" onClick=${importDisk} />` : null}</div>
    <input type="file" ref=${fileRef} multiple accept="video/*,audio/*,image/*" hidden onChange=${(e) => { importFiles([...e.target.files]); e.target.value = ''; }} />
    <div style="flex:1;overflow:auto;padding:8px" onDragOver=${(e) => e.preventDefault()} onDrop=${(e) => { if (e.dataTransfer.files.length) { e.preventDefault(); importFiles([...e.dataTransfer.files]); } }}>
      ${tab === 'ai' ? html`<${AIPanel} aiEdit=${aiEdit} aiUndo=${aiUndo} projectId=${projectId} selected=${selected} />` : tab === 'media' ? (data.media.length ? data.media.map((m) => html`
        <div class="review-item" draggable="true" onDragStart=${(e) => e.dataTransfer.setData('text/x-media', m.id)} onDblClick=${() => onAdd(m)} title="Double-click to add at the end of V1, or drag onto a track">
          <div class="th" style=${{ width: '58px', aspectRatio: '16/9', backgroundImage: m.kind !== 1 ? `url(${api.url(`/api/media/thumb?path=${encodeURIComponent(m.path)}&t=${m.kind >= 2 ? 0 : 1}`)})` : 'none', display: 'grid', placeItems: 'center' }}>${m.kind === 1 ? html`<${Icon} name="volume" size=${16} />` : null}</div>
          <div class="grow" style="min-width:0"><div class="ellipsis" style="font-size:var(--fs-sm);font-weight:500">${m.name}</div><div class="faint tnum" style="font-size:var(--fs-xs)">${m.kind >= 2 ? 'Image' : dur(m.duration)}${m.width ? ` · ${m.width}×${m.height}` : ''}${m.proxyPending ? ' · preparing preview…' : m.proxyError ? ' · preview unavailable' : ''}</div></div></div>`)
        : html`<div class="empty" style="padding:30px 10px"><p style="font-size:var(--fs-sm)">Import or drop video, audio and images here.</p></div>`)
      : html`${['Blur', 'Color', 'Transform', 'Stylize'].map((cat) => html`<div class="eyebrow" style="padding:8px 6px 4px">${cat}</div>${EFFECTS.filter((f) => f.cat === cat).map((f) => html`<div class="review-item" onDblClick=${() => applyEffect(f)} onClick=${() => applyEffect(f)} title="Apply to the selected clip"><${Icon} name="wand" size=${15} /><span style="font-size:var(--fs-sm)">${f.name}</span></div>`)}`)}
        ${['Dissolve', 'Wipe', 'Iris', 'Slide'].map((cat) => html`<div class="eyebrow" style="padding:12px 6px 4px">${cat === 'Dissolve' ? 'Transitions · ' : ''}${cat}</div>${TRANSITIONS.filter((x) => x.cat === cat).map((tt) => html`<div class="review-item" style="cursor:default"><${Icon} name="layers" size=${15} /><span class="grow" style="font-size:var(--fs-sm)">${tt.name}</span><${Button} size="sm" kind="ghost" onClick=${() => applyTransition(tt, 'transIn')}>In</${Button}><${Button} size="sm" kind="ghost" onClick=${() => applyTransition(tt, 'transOut')}>Out</${Button}></div>`)}`)}`}
    </div></div>`;
}

// ------------------------------------------------------------ program monitor (canvas compositor)
/** Two-finger pinch on a touch screen: calls onScale(factor, x, y) as the fingers spread or close. (Trackpad pinches arrive as Ctrl+wheel.) */
function usePinch(ref, onScale) {
  const cb = useRef(onScale); cb.current = onScale;
  useEffect(() => {
    const el = ref.current; if (!el) return; let last = 0;
    const span = (e) => Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
    const start = (e) => { if (e.touches.length === 2) last = span(e); };
    const move = (e) => { if (e.touches.length !== 2 || !last) return; e.preventDefault(); const d = span(e); cb.current(d / last, (e.touches[0].clientX + e.touches[1].clientX) / 2, (e.touches[0].clientY + e.touches[1].clientY) / 2); last = d; };
    const end = (e) => { if (e.touches.length < 2) last = 0; };
    el.addEventListener('touchstart', start, { passive: true }); el.addEventListener('touchmove', move, { passive: false }); el.addEventListener('touchend', end);
    return () => { el.removeEventListener('touchstart', start); el.removeEventListener('touchmove', move); el.removeEventListener('touchend', end); };
  }, []);
}
const wheelFactor = (e) => Math.exp(-Math.max(-60, Math.min(60, e.deltaMode === 1 ? e.deltaY * 30 : e.deltaY)) * 0.005);

function Monitor({ seq, media, t, setT, playing, setPlaying, duration, selected, sel = [], edit, setSel, onEditTitle }) {
  const canvas = useRef(null);
  const hits = useRef([]); // what's drawn where (canvas pixels), topmost last: for clicking and dragging on the monitor
  const els = useRef(new Map());   // clipId -> HTMLVideoElement | HTMLImageElement | HTMLAudioElement
  const clock = useRef({ wall: 0, t0: 0 });
  const tRef = useRef(t); tRef.current = t;
  const [qualitySel, setQuality] = useState(0.5);
  const raf = useRef(0);
  // Fit the sequence frame inside the monitor area at any window size.
  const box = useRef(null);
  const [fit, setFit] = useState({ x: 0, y: 0, w: 0, h: 0 });
  useEffect(() => {
    const el = box.current; if (!el) return;
    const ro = new ResizeObserver(() => {
      const pad = 12; const bw = el.clientWidth - pad * 2, bh = el.clientHeight - pad * 2;
      const k = Math.max(0.01, Math.min(bw / seq.width, bh / seq.height));
      const w = Math.floor(seq.width * k), h = Math.floor(seq.height * k);
      setFit({ x: Math.floor((el.clientWidth - w) / 2), y: Math.floor((el.clientHeight - h) / 2), w, h });
    });
    ro.observe(el); return () => ro.disconnect();
  }, [seq.width, seq.height]);
  // View zoom and pan (pinch, Ctrl+wheel; drag the grey area or with the middle button to move around; double-click empty space to fit).
  const [view, setView] = useState({ k: 1, x: 0, y: 0 });
  const viewRef = useRef(view); viewRef.current = view; const fitRef = useRef(fit); fitRef.current = fit;
  const zoomAt = (factor, cx, cy) => {
    const el = box.current; if (!el) return; const r = el.getBoundingClientRect(); const mx = cx - r.left, my = cy - r.top;
    const v = viewRef.current, f = fitRef.current; const k = Math.max(1, Math.min(8, v.k * factor));
    if (k === 1) { setView({ k: 1, x: 0, y: 0 }); return; }
    const left = f.x + v.x, top = f.y + v.y; const rx = (mx - left) / (f.w * v.k), ry = (my - top) / (f.h * v.k);
    setView({ k, x: mx - rx * f.w * k - f.x, y: my - ry * f.h * k - f.y });
  };
  useEffect(() => {
    const el = box.current; if (!el) return;
    const onWheel = (e) => {
      if (e.ctrlKey || e.metaKey) { e.preventDefault(); zoomAt(wheelFactor(e), e.clientX, e.clientY); return; }
      if (viewRef.current.k > 1) { e.preventDefault(); setView((v) => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY })); }
    };
    el.addEventListener('wheel', onWheel, { passive: false }); return () => el.removeEventListener('wheel', onWheel);
  }, []);
  usePinch(box, zoomAt);
  const quality = view.k > 1.4 ? 1 : qualitySel; // zoomed in: draw at full size so it stays sharp
  const pan = useRef(null);
  const onBoxDown = (e) => { if (e.target !== box.current && e.button !== 1) return; e.preventDefault(); pan.current = { x0: e.clientX, y0: e.clientY, v: viewRef.current }; e.currentTarget.setPointerCapture(e.pointerId); };
  const onBoxMove = (e) => { const p = pan.current; if (!p) return; setView({ ...p.v, x: p.v.x + e.clientX - p.x0, y: p.v.y + e.clientY - p.y0 }); };
  const onBoxUp = () => { pan.current = null; };

  const getEl = (c) => {
    let el = els.current.get(c.id); const m = media[c.mediaId]; if (!m) return null;
    const still = c.type === 2 || m.kind === 2 || m.kind === 3; const src = playUrl(m, still);
    if (el && el.__src !== src) { if (el instanceof HTMLMediaElement) { el.pause(); el.removeAttribute('src'); el.load(); } el = null; }
    if (!el) {
      if (still) { el = new Image(); el.src = src; el.onload = () => draw(); }
      else { el = document.createElement(c.type === 1 ? 'audio' : 'video'); el.preload = 'auto'; el.playsInline = true; el.muted = c.type !== 1; el.src = src; el.addEventListener('seeked', () => draw()); el.addEventListener('loadeddata', () => draw()); }
      el.__src = src; els.current.set(c.id, el);
    }
    return el;
  };
  const activeAt = (time) => {
    const v = []; const a = [];
    seq.videoTracks.forEach((tr, i) => { if (tr.muted) return; for (const c of tr.clips) if (c.enabled !== false && time >= c.start && time < c.start + c.duration) v.push({ c, i }); });
    seq.audioTracks.forEach((tr) => { if (tr.muted) return; for (const c of tr.clips) if (c.enabled !== false && time >= c.start && time < c.start + c.duration) a.push({ c, tr }); });
    return { v, a };
  };
  const sync = (time, isPlaying) => {
    const { v, a } = activeAt(time); const live = new Set();
    for (const { c } of [...v, ...a.map((x) => ({ c: x.c, tr: x.tr }))]) {
      if (c.type === 3) continue;
      const el = getEl(c); if (!el || !(el instanceof HTMLMediaElement)) { if (el) live.add(c.id); continue; }
      live.add(c.id);
      const want = (c.in || 0) + (time - c.start) * (c.speed || 1);
      if (c.type === 1) { const tr = a.find((x) => x.c.id === c.id)?.tr; el.volume = Math.max(0, Math.min(1, valAt(c.volume, time - c.start, 1) * base(tr?.volume, 1))); }
      el.playbackRate = Math.min(4, Math.max(0.25, c.speed || 1));
      if (isPlaying) { if (Math.abs(el.currentTime - want) > 0.3) el.currentTime = want; if (el.paused) el.play().catch(() => {}); }
      else { if (!el.paused) el.pause(); if (Math.abs(el.currentTime - want) > 0.02) el.currentTime = want; }
    }
    for (const [cid, el] of els.current) if (!live.has(cid) && el instanceof HTMLMediaElement && !el.paused) el.pause();
    // Get the next clips ready ahead of time (loaded and parked on their first frame), so they don't flash black when they start.
    for (const tr of seq.videoTracks) for (const c of tr.clips) {
      if (c.type === 3 || c.enabled === false || c.start <= time || c.start - time > 2.5) continue;
      const el = getEl(c); if (el instanceof HTMLMediaElement && el.paused && Math.abs(el.currentTime - (c.in || 0)) > 0.05) el.currentTime = c.in || 0;
    }
    return v;
  };
  const draw = () => {
    const cv = canvas.current; if (!cv) return;
    const W = Math.round(seq.width * quality), H = Math.round(seq.height * quality);
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
    const g = cv.getContext('2d'); g.setTransform(1, 0, 0, 1, 0, 0); g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
    const time = tRef.current; const { v } = activeAt(time); hits.current = [];
    for (const { c } of v) {
      const local = time - c.start;
      { const m0 = media[c.mediaId]; const sx0 = valAt(c.scaleX, local, 1), sy0 = c.uniformScale === false ? valAt(c.scaleY, local, 1) : sx0; const tb = c.type === 3 ? titleBox(c.text || {}, sx0 * quality) : null;
        hits.current.push({ id: c.id, cx: W / 2 + valAt(c.posX, local) * quality, cy: H / 2 + valAt(c.posY, local) * quality, w: tb ? tb.w : (m0?.width || seq.width) * Math.abs(sx0) * quality, h: tb ? tb.h : (m0?.height || seq.height) * Math.abs(sy0) * quality, rot: (valAt(c.rotation, local) * Math.PI) / 180 }); }
      let alpha = valAt(c.opacity, local, 1);
      const ti = c.transIn?.type ? c.transIn.duration : 0, to = c.transOut?.type ? c.transOut.duration : 0;
      // Titles only fade (as in export); picture clips get the full transition below.
      if (c.type === 3) { if (ti && local < ti) alpha *= local / ti; if (to && local > c.duration - to) alpha *= Math.max(0, (c.duration - local) / to); }
      g.save(); g.globalAlpha = Math.max(0, Math.min(1, alpha));
      g.translate(W / 2 + valAt(c.posX, local) * quality, H / 2 + valAt(c.posY, local) * quality);
      g.rotate((valAt(c.rotation, local) * Math.PI) / 180);
      const sx = valAt(c.scaleX, local, 1), sy = c.uniformScale === false ? valAt(c.scaleY, local, 1) : sx;
      const filters = []; let flipH = 1, flipV = 1, crop = null, vig = 0;
      for (const e of c.effects || []) {
        if (e.enabled === false) continue; const p = Object.fromEntries(Object.entries(e.params || {}).map(([k, x]) => [k, valAt(x, local)]));
        if (e.effectId === 'gaussian_blur') filters.push(`blur(${(p.radius / 2) * quality}px)`);
        if (e.effectId === 'color_correction' || e.effectId === 'color_grade') { filters.push(`brightness(${1 + (p.brightness || 0) / 200 + (p.exposure || 0) * 0.25})`, `contrast(${1 + (p.contrast || 0) / 100})`, `saturate(${(p.saturation ?? 100) / 100})`); if (p.hue) filters.push(`hue-rotate(${p.hue}deg)`); if (p.temperature) filters.push(`sepia(${Math.max(0, p.temperature) / 400})`); }
        if (e.effectId === 'black_white') filters.push(`grayscale(${(p.mix ?? 100) / 100})`);
        if (e.effectId === 'sharpen') filters.push(`contrast(${1 + p.amount / 1200})`);
        if (e.effectId === 'flip') { if (p.horizontal >= 0.5) flipH = -1; if (p.vertical >= 0.5) flipV = -1; }
        if (e.effectId === 'crop') crop = p;
        if (e.effectId === 'vignette') vig = p.amount / 100;
      }
      g.filter = filters.join(' ') || 'none';
      if (c.type === 3) drawText(g, c.text || {}, sx * quality, local, c.duration);
      else {
        const el = getEl(c); const m = media[c.mediaId];
        // A player still on the wrong spot (catching up after a jump) is skipped, so the layer underneath shows instead of a wrong or black frame.
        const onSpot = !(el instanceof HTMLVideoElement) || Math.abs(el.currentTime - ((c.in || 0) + local * (c.speed || 1))) < 0.35;
        if (el && onSpot && ((el instanceof HTMLVideoElement && el.readyState >= 2) || (el instanceof HTMLImageElement && el.complete && el.naturalWidth))) {
          const nw = (m.width || el.videoWidth || el.naturalWidth) * sx * quality, nh = (m.height || el.videoHeight || el.naturalHeight) * sy * quality;
          const iw = el.videoWidth || el.naturalWidth, ih = el.videoHeight || el.naturalHeight;
          let sxp = 0, syp = 0, sw = iw, sh = ih, dx = -nw / 2, dy = -nh / 2, dw = nw, dh = nh;
          if (crop) { sxp = iw * crop.left / 100; syp = ih * crop.top / 100; sw = iw * (1 - (crop.left + crop.right) / 100); sh = ih * (1 - (crop.top + crop.bottom) / 100); dx += nw * crop.left / 100; dy += nh * crop.top / 100; dw = nw * sw / iw; dh = nh * sh / ih; }
          const fxs = [];
          if (ti && local < ti) fxs.push(transitionFx(c.transIn.type, Math.max(0, local / ti), nw, nh, false));
          if (to && local > c.duration - to) fxs.push(transitionFx(c.transOut.type, Math.min(1, (local - (c.duration - to)) / to), nw, nh, true));
          const a0 = g.globalAlpha; let pixel = 0; const dips = [];
          for (const f of fxs) {
            g.globalAlpha *= f.alpha;
            if (f.filter) g.filter = (g.filter === 'none' ? '' : g.filter + ' ') + f.filter;
            if (f.clip || f.dx || f.dy) { g.translate(-nw / 2, -nh / 2); if (f.clip) g.clip(f.clip, 'evenodd'); else g.clip(new Path2D(`M0 0H${nw}V${nh}H0Z`)); g.translate(nw / 2 + f.dx, nh / 2 + f.dy); }
            pixel = Math.max(pixel, f.pixel); if (f.dip) dips.push(f.dip);
          }
          g.scale(flipH, flipV);
          if (sw > 0 && sh > 0 && g.globalAlpha > 0) {
            if (pixel > 1) {
              const off = document.createElement('canvas'); off.width = Math.max(1, Math.round(dw / pixel)); off.height = Math.max(1, Math.round(dh / pixel));
              off.getContext('2d').drawImage(el, sxp, syp, sw, sh, 0, 0, off.width, off.height);
              g.imageSmoothingEnabled = false; g.drawImage(off, dx, dy, dw, dh); g.imageSmoothingEnabled = true;
            } else g.drawImage(el, sxp, syp, sw, sh, dx, dy, dw, dh);
          }
          for (const d of dips) { g.filter = 'none'; g.globalAlpha = a0 * Math.max(0, Math.min(1, d.a)); g.fillStyle = d.color; g.fillRect(-nw / 2, -nh / 2, nw, nh); }
          if (vig) { g.filter = 'none'; const rg = g.createRadialGradient(0, 0, Math.min(nw, nh) * 0.25, 0, 0, Math.max(nw, nh) * 0.6); rg.addColorStop(0, 'rgba(0,0,0,0)'); rg.addColorStop(1, `rgba(0,0,0,${vig * 0.85})`); g.fillStyle = rg; g.fillRect(-nw / 2, -nh / 2, nw, nh); }
        }
      }
      g.restore();
    }
    // selection outline with a resize handle on each corner
    const hs = selected && hits.current.find((x) => x.id === selected.c.id);
    if (hs) {
      g.save(); g.translate(hs.cx, hs.cy); g.rotate(hs.rot);
      g.strokeStyle = 'rgba(102,189,180,0.95)'; g.lineWidth = 2; g.setLineDash([6, 4]); g.strokeRect(-hs.w / 2, -hs.h / 2, hs.w, hs.h); g.setLineDash([]);
      g.fillStyle = '#ffffff'; g.strokeStyle = 'rgba(35,102,95,1)'; const k = 9;
      for (const [x, y] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) { g.fillRect(x * hs.w / 2 - k / 2, y * hs.h / 2 - k / 2, k, k); g.strokeRect(x * hs.w / 2 - k / 2, y * hs.h / 2 - k / 2, k, k); }
      g.restore();
    }
    if (snapGuide.current) { g.save(); g.strokeStyle = 'rgba(208,113,95,0.9)'; g.lineWidth = 1; if (snapGuide.current.x) { g.beginPath(); g.moveTo(W / 2, 0); g.lineTo(W / 2, H); g.stroke(); } if (snapGuide.current.y) { g.beginPath(); g.moveTo(0, H / 2); g.lineTo(W, H / 2); g.stroke(); } g.restore(); }
  };
  // playback loop
  useEffect(() => {
    if (!playing) { cancelAnimationFrame(raf.current); sync(tRef.current, false); draw(); return; }
    clock.current = { wall: performance.now(), t0: tRef.current };
    const loop = () => {
      const now = clock.current.t0 + (performance.now() - clock.current.wall) / 1000;
      if (now >= duration) { setPlaying(false); setT(duration); return; }
      tRef.current = now; setT(now); sync(now, true); draw();
      raf.current = requestAnimationFrame(loop);
    };
    raf.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf.current);
  }, [playing]);
  useEffect(() => { if (!playing) { sync(t, false); draw(); } }, [t, seq, quality, selected?.c?.id]);
  useEffect(() => { const f = () => draw(); window.addEventListener('studio-redraw', f); return () => window.removeEventListener('studio-redraw', f); }, [seq, quality, selected]);
  useEffect(() => () => { for (const el of els.current.values()) if (el instanceof HTMLMediaElement) { el.pause(); el.removeAttribute('src'); el.load(); } }, []);

  // Click anything visible on the monitor to select it; drag to move it, drag a corner to resize.
  // Moves snap to the centre lines (hold Alt for free movement). Keyframed settings get a keyframe at the playhead.
  const drag = useRef(null); const snapGuide = useRef(null);
  const toCanvas = (e) => { const r = canvas.current.getBoundingClientRect(); const k = canvas.current.width / r.width; return { x: (e.clientX - r.left) * k, y: (e.clientY - r.top) * k, k }; };
  const local = (h, x, y) => { const dx = x - h.cx, dy = y - h.cy, c = Math.cos(-h.rot), s2 = Math.sin(-h.rot); return { x: dx * c - dy * s2, y: dx * s2 + dy * c }; };
  const hitAt = (p) => {
    const grab = 12 * p.k; const hsel = selected && hits.current.find((x) => x.id === selected.c.id);
    if (hsel) { const l = local(hsel, p.x, p.y); if (Math.abs(Math.abs(l.x) - hsel.w / 2) < grab && Math.abs(Math.abs(l.y) - hsel.h / 2) < grab) return { mode: 'scale', hit: hsel }; }
    for (let i = hits.current.length - 1; i >= 0; i--) { const h = hits.current[i]; const l = local(h, p.x, p.y); if (Math.abs(l.x) <= h.w / 2 && Math.abs(l.y) <= h.h / 2) return { mode: 'move', hit: h }; }
    return null;
  };
  const onHover = (e) => { if (drag.current || pan.current) return; const h = hitAt(toCanvas(e)); e.currentTarget.style.cursor = !h ? 'default' : h.mode === 'scale' ? 'nwse-resize' : 'move'; };
  const onDbl = (e) => {
    const h = hitAt(toCanvas(e));
    const c = h && [...seq.videoTracks].flatMap((tr) => tr.clips).find((x) => x.id === h.hit.id);
    if (c?.type === 3) onEditTitle?.(c.id); else if (!h) setView({ k: 1, x: 0, y: 0 });
  };
  const onDown = (e) => {
    if (e.button === 1) return; // middle button pans the view
    const p = toCanvas(e); const grab = 12 * p.k;
    // corner handle of the selected clip first, then the topmost clip under the pointer
    const hsel = selected && hits.current.find((x) => x.id === selected.c.id);
    let mode = 'move', hit = null;
    if (hsel) { const l = local(hsel, p.x, p.y); if (Math.abs(Math.abs(l.x) - hsel.w / 2) < grab && Math.abs(Math.abs(l.y) - hsel.h / 2) < grab) { mode = 'scale'; hit = hsel; } }
    if (!hit) for (let i = hits.current.length - 1; i >= 0; i--) { const h = hits.current[i]; const l = local(h, p.x, p.y); if (Math.abs(l.x) <= h.w / 2 && Math.abs(l.y) <= h.h / 2) { hit = h; break; } }
    if (!hit) { setSel([]); return; }
    const f = [...seq.videoTracks].flatMap((tr) => tr.clips).find((x) => x.id === hit.id); if (!f) return;
    if (e.ctrlKey || e.metaKey || e.shiftKey) { setSel(sel.includes(f.id) ? sel.filter((x) => x !== f.id) : [...sel, f.id]); return; }
    if (!sel.includes(f.id)) setSel([f.id]);
    const lt = Math.max(0, Math.min(f.duration, tRef.current - f.start));
    drag.current = { mode, clip: f, lt, x0: p.x, y0: p.y, k: seq.width / canvas.current.width, cx: hit.cx, cy: hit.cy, px: valAt(f.posX, lt), py: valAt(f.posY, lt), s0: valAt(f.scaleX, lt, 1), started: false };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onMove = (e) => {
    const d = drag.current; if (!d) { onHover(e); return; }
    const p = toCanvas(e); const dx = (p.x - d.x0) * d.k, dy = (p.y - d.y0) * d.k;
    if (!d.started) { if (Math.hypot(dx, dy) < 3 * d.k) return; d.started = true; }
    const c = d.clip;
    if (d.mode === 'move') {
      let nx = Math.round(d.px + dx), ny = Math.round(d.py + dy); const snap = !e.altKey ? 14 * d.k * 2 : 0;
      snapGuide.current = { x: snap && Math.abs(nx) < snap, y: snap && Math.abs(ny) < snap }; if (snapGuide.current.x) nx = 0; if (snapGuide.current.y) ny = 0;
      d.nx = nx; d.ny = ny;
      liveSet(c, 'posX', withValueAt(c.posX, d.lt, nx), c.id + 'mx'); liveSet(c, 'posY', withValueAt(c.posY, d.lt, ny), c.id + 'my');
    } else {
      const r0 = Math.hypot(d.x0 - d.cx, d.y0 - d.cy) || 1, r1 = Math.hypot(p.x - d.cx, p.y - d.cy);
      d.ns = Math.max(0.01, Math.round(d.s0 * (r1 / r0) * 1000) / 1000);
      liveSet(c, 'scaleX', withValueAt(c.scaleX, d.lt, d.ns, 1), c.id + 'msx'); liveSet(c, 'scaleY', withValueAt(c.scaleY, d.lt, d.ns, 1), c.id + 'msy');
    }
  };
  const onUp = () => {
    const d = drag.current; drag.current = null; snapGuide.current = null; if (!d?.started) { draw(); return; }
    revertLive();
    edit((dd, s) => { for (const tr of s.videoTracks) { const c = tr.clips.find((x) => x.id === d.clip.id); if (!c) continue;
      if (d.mode === 'move') { c.posX = withValueAt(c.posX, d.lt, d.nx); c.posY = withValueAt(c.posY, d.lt, d.ny); }
      else { c.scaleX = withValueAt(c.scaleX, d.lt, d.ns, 1); c.scaleY = withValueAt(c.scaleY, d.lt, d.ns, 1); } }
      // The other selected titles/captions move (or resize) by the same amount, so a group of captions stays lined up.
      if (sel.length > 1 && sel.includes(d.clip.id)) for (const tr of s.videoTracks) for (const c of tr.clips) {
        if (c.id === d.clip.id || c.type !== 3 || !sel.includes(c.id)) continue; const lt = 0;
        if (d.mode === 'move') { c.posX = withValueAt(c.posX, lt, valAt(c.posX, lt) + (d.nx - d.px)); c.posY = withValueAt(c.posY, lt, valAt(c.posY, lt) + (d.ny - d.py)); }
        else { const k = d.ns / (d.s0 || 1); c.scaleX = withValueAt(c.scaleX, lt, valAt(c.scaleX, lt, 1) * k, 1); c.scaleY = withValueAt(c.scaleY, lt, valAt(c.scaleY, lt, 1) * k, 1); }
      } });
  };

  return html`<div style="display:flex;flex-direction:column;min-width:0;min-height:0;overflow:hidden">
    <div class="row" style="padding:6px 12px;gap:8px"><span class="eyebrow grow">Program</span>
      <span class="faint" style="font-size:var(--fs-xs)" title="Pinch or Ctrl + scroll to zoom. Drag the grey area to move around. Double-click empty space to fit.">${view.k > 1 ? `${Math.round(view.k * 100)}%` : 'Pinch to zoom'}</span>
      ${view.k > 1 ? html`<${Button} size="sm" kind="ghost" onClick=${() => setView({ k: 1, x: 0, y: 0 })}>Fit</${Button}>` : null}
      <select class="select sm" style="width:90px" value=${qualitySel} onChange=${(e) => setQuality(Number(e.target.value))} aria-label="Preview quality"><option value="1">Full</option><option value="0.5">1/2</option><option value="0.25">1/4</option></select></div>
    <div ref=${box} style=${{ flex: 1, minHeight: 0, minWidth: 0, position: 'relative', overflow: 'hidden', touchAction: 'none', cursor: view.k > 1 ? 'grab' : 'default' }} onPointerDown=${onBoxDown} onPointerMove=${onBoxMove} onPointerUp=${onBoxUp} onDblClick=${(e) => { if (e.target === box.current) setView({ k: 1, x: 0, y: 0 }); }}>
      <canvas ref=${canvas} style=${{ position: 'absolute', left: fit.x + view.x + 'px', top: fit.y + view.y + 'px', width: fit.w * view.k + 'px', height: fit.h * view.k + 'px', background: '#000', borderRadius: '8px', boxShadow: 'var(--shadow-2)', cursor: 'default' }} onPointerDown=${onDown} onPointerMove=${onMove} onPointerUp=${onUp} onDblClick=${onDbl} />
    </div>
    <div class="row" style="padding:6px 12px 10px;justify-content:center;gap:6px">
      <span class="mono tnum" style="width:100px;color:var(--teal-ink)">${tc(t, seq.fps)}</span>
      <${Button} kind="ghost" size="sm" icon="skipBack" title="Go to start (Home)" onClick=${() => setT(0)} />
      <${Button} kind="ghost" size="sm" icon="chevronLeft" title="Previous frame (←)" onClick=${() => setT(Math.max(0, t - 1 / seq.fps))} />
      <button class="send-btn" style="width:36px;height:36px" aria-label=${playing ? 'Pause' : 'Play'} onClick=${() => { sfx('tap'); setPlaying(!playing); }}><${Icon} name=${playing ? 'pause' : 'play'} size=${16} /></button>
      <${Button} kind="ghost" size="sm" icon="chevronRight" title="Next frame (→)" onClick=${() => setT(t + 1 / seq.fps)} />
      <${Button} kind="ghost" size="sm" icon="skipFwd" title="Go to end (End)" onClick=${() => setT(duration)} />
      <span class="mono tnum faint" style="width:100px;text-align:right">${tc(duration, seq.fps)}</span>
    </div></div>`;
}

const easeOut = (f) => 1 - (1 - f) ** 3;
const rgbaOf = (s, d) => { const h = String(s || d).replace('#', ''); if (h.length === 8) return `rgba(${parseInt(h.slice(2, 4), 16)},${parseInt(h.slice(4, 6), 16)},${parseInt(h.slice(6, 8), 16)},${parseInt(h.slice(0, 2), 16) / 255})`; return '#' + h; };
/** Size of a title's box in canvas pixels (for selecting and dragging it on the monitor). */
let measureCtx = null;
function titleBox(st, scale) {
  measureCtx = measureCtx || document.createElement('canvas').getContext('2d');
  const size = (st.pixelSize || 96) * scale; const g = measureCtx;
  g.font = `${st.italic ? 'italic ' : ''}${st.bold === false ? 500 : 800} ${size}px ${JSON.stringify(st.family || 'Montserrat')}, Montserrat, sans-serif`;
  try { g.letterSpacing = `${(st.letterSpacing || 0) * scale}px`; } catch { /* older engines */ }
  const lines = (st.uppercase ? String(st.text || '').toUpperCase() : String(st.text || '')).split('\n');
  const pad = st.box ? (st.boxPad ?? 18) * scale : (st.outlineWidth || 0) * scale;
  return { w: Math.max(size, ...lines.map((l) => g.measureText(l).width)) + pad * 2, h: lines.length * size * 1.15 + pad * 1.2 };
}

const normWord = (w) => String(w).toLowerCase().replace(/[^a-z0-9$%']/g, '');
/** Start/end of each word in a caption: its own timings, or (text edited, or none) spread over the caption by length. Same as the export. */
function hlTimes(st, flat, dur) {
  const ws = Array.isArray(st.words) ? st.words : [];
  if (ws.length && ws.length === flat.length) return ws;
  const total = flat.reduce((n, w) => n + w.length + 1, 0) || 1; let at = 0;
  return flat.map((w) => { const s = at; at += ((dur || 1) * (w.length + 1)) / total; return { s, e: at }; });
}
/** Lines of [{ w, hl }]: which words are lit at `local` seconds (spoken word or keywords). */
function hlLines(st, text, local, dur) {
  const lines = text.split('\n').map((l) => l.split(/\s+/).filter(Boolean));
  const mode = st.hlMode; let active = -1;
  if (mode === 'word') { const times = hlTimes(st, lines.flat(), dur); for (let i = 0; i < times.length; i++) if (local >= times[i].s) active = i; }
  const kw = new Set((st.keywords || []).map(normWord)); let k = 0;
  return lines.map((ws) => ws.map((w) => { const i = k++; return { w, hl: mode === 'word' ? i === active : mode === 'keywords' && kw.has(normWord(w)) }; }));
}

/** Draw a title centred on the current origin. local = seconds into the clip (for pop / slide-up and the spoken-word highlight). */
function drawText(g, st, scale, local = 10, dur = 0) {
  const size = (st.pixelSize || 96) * scale;
  const text = st.uppercase ? String(st.text || '').toUpperCase() : String(st.text || '');
  g.font = `${st.italic ? 'italic ' : ''}${st.bold === false ? 500 : 800} ${size}px ${JSON.stringify(st.family || 'Montserrat')}, Montserrat, "Segoe UI", sans-serif`;
  g.textAlign = 'center'; g.textBaseline = 'middle';
  try { g.letterSpacing = `${(st.letterSpacing || 0) * scale}px`; } catch { /* older engines */ }
  if (st.animIn === 'pop') { const k = 0.6 + 0.4 * easeOut(Math.min(1, Math.max(0, local) / 0.25)); g.scale(k, k); }
  if (st.animIn === 'slide') g.translate(0, 70 * scale * (1 - easeOut(Math.min(1, Math.max(0, local) / 0.35))));
  const lines = text.split('\n'); const lh = size * 1.15;
  if (st.box && st.boxRadius > 0) {
    // Rounded box per line (TikTok / Instagram titles), as in the export.
    const pad = (st.boxPad ?? 18) * scale; g.fillStyle = rgbaOf(st.boxColor, 'ffffffff');
    lines.forEach((l, i) => { const w = g.measureText(l).width; const y = (i - (lines.length - 1) / 2) * lh; g.beginPath(); g.roundRect(-w / 2 - pad, y - lh / 2, w + pad * 2, lh, st.boxRadius * scale); g.fill(); });
  } else if (st.box) {
    const pad = (st.boxPad ?? 18) * scale; const w = Math.max(...lines.map((l) => g.measureText(l).width));
    g.fillStyle = rgbaOf(st.boxColor, 'cc000000');
    g.fillRect(-w / 2 - pad, -(lines.length * lh) / 2 - pad * 0.6, w + pad * 2, lines.length * lh + pad * 1.2);
  }
  const lit = st.hlMode === 'word' || st.hlMode === 'keywords' ? hlLines(st, text, local, dur) : null;
  lines.forEach((line, i) => {
    const y = (i - (lines.length - 1) / 2) * lh;
    if (st.shadow) { g.shadowColor = rgbaOf(st.shadowColor, 'b3000000'); g.shadowOffsetX = g.shadowOffsetY = st.shadow * scale; g.shadowBlur = st.shadow * scale; }
    if (!lit) {
      if (st.outlineWidth && !st.box) { g.lineJoin = 'round'; g.lineWidth = st.outlineWidth * 2 * scale; g.strokeStyle = rgbaOf(st.outlineColor, 'ff000000'); g.strokeText(line, 0, y); }
      g.fillStyle = rgbaOf(st.color, 'ffffffff'); g.fillText(line, 0, y);
    } else {
      // Word by word, so the lit words get the highlight colour.
      const parts = lit[i] || []; const sp = g.measureText(' ').width; const ws = parts.map((p) => g.measureText(p.w).width);
      const x0 = -(ws.reduce((n, w) => n + w, 0) + sp * Math.max(0, parts.length - 1)) / 2; g.textAlign = 'left';
      if (st.outlineWidth && !st.box) { g.lineJoin = 'round'; g.lineWidth = st.outlineWidth * 2 * scale; g.strokeStyle = rgbaOf(st.outlineColor, 'ff000000'); let x = x0; parts.forEach((p, k) => { g.strokeText(p.w, x, y); x += ws[k] + sp; }); }
      let x = x0; parts.forEach((p, k) => { g.fillStyle = p.hl ? rgbaOf(st.hlColor, 'fff2c14e') : rgbaOf(st.color, 'ffffffff'); g.fillText(p.w, x, y); x += ws[k] + sp; });
      g.textAlign = 'center';
    }
    g.shadowColor = 'transparent';
  });
}

// ------------------------------------------------------------ title designer (T)
const TITLE_PRESETS = [
  { name: 'TikTok', st: { family: 'TikTok Sans', pixelSize: 66, bold: false, uppercase: false, color: '#ff000000', outlineWidth: 0, shadow: 0, box: true, boxColor: '#ffffffff', boxPad: 18, boxRadius: 18, animIn: 'none' }, pos: 'top' },
  { name: 'TikTok plain', st: { family: 'TikTok Sans', pixelSize: 66, bold: false, uppercase: false, color: '#ffffffff', outlineWidth: 0, shadow: 3, shadowColor: '#b3000000', box: false, animIn: 'none' }, pos: 'top' },
  { name: 'Instagram', st: { family: 'Inter', pixelSize: 62, bold: false, uppercase: false, color: '#ff000000', outlineWidth: 0, shadow: 0, box: true, boxColor: '#ffffffff', boxPad: 18, boxRadius: 20, animIn: 'none' }, pos: 'top' },
  { name: 'Hook', st: { family: 'Anton', pixelSize: 150, bold: true, uppercase: true, color: '#ffffffff', outlineColor: '#ff000000', outlineWidth: 8, shadow: 0, box: false, animIn: 'pop' }, pos: 'top' },
  { name: 'Title', st: { family: 'Montserrat', pixelSize: 96, bold: true, color: '#ffffffff', outlineColor: '#ff111111', outlineWidth: 4, shadow: 4, box: false, animIn: 'fade' }, pos: 'center' },
  { name: 'Lower third', st: { family: 'Montserrat', pixelSize: 54, bold: true, color: '#ffffffff', outlineWidth: 0, shadow: 0, box: true, boxColor: '#e6111a22', boxPad: 22, animIn: 'slide' }, pos: 'lower' },
  { name: 'Caption', st: { family: 'Montserrat', pixelSize: 64, bold: true, uppercase: true, color: '#ffffffff', outlineColor: '#ff000000', outlineWidth: 6, shadow: 0, box: false, animIn: 'none' }, pos: 'bottom' },
  { name: 'Subscribe', st: { family: 'Montserrat', pixelSize: 58, bold: true, uppercase: true, color: '#ff111111', outlineWidth: 0, shadow: 0, box: true, boxColor: '#ffffd23f', boxPad: 24, animIn: 'pop' }, pos: 'bottom' },
  { name: 'Quote', st: { family: 'Georgia', pixelSize: 68, bold: false, italic: true, color: '#ffffffff', outlineWidth: 0, shadow: 6, box: false, animIn: 'fade' }, pos: 'center' },
];
const POS_Y = { top: -0.32, center: 0, lower: 0.26, bottom: 0.36 };
/** Every font (bundled and Windows ones), grouped like the clip panel's picker. */
const fontOptions = () => FONT_GROUPS.map(([g, list]) => html`<optgroup label=${g}>${list.map((f) => html`<option value=${f} style=${{ fontFamily: `'${f}'` }}>${f}</option>`)}</optgroup>`);
/** The look of a title (not its words, timing or highlight), copied when one style is applied to many titles/captions. */
const STYLE_KEYS = ['family', 'pixelSize', 'bold', 'italic', 'uppercase', 'color', 'outlineColor', 'outlineWidth', 'shadow', 'shadowColor', 'box', 'boxColor', 'boxPad', 'boxRadius', 'letterSpacing', 'animIn', 'hlColor'];
const hex6 = (c, d) => '#' + String(c || d).replace('#', '').slice(-6);
const withAlpha = (rgb, a) => '#' + Math.round(a * 255).toString(16).padStart(2, '0') + rgb.replace('#', '');

function TitleDesigner({ seq, clip, count = 1, onClose, onSave }) {
  const start = clip?.text ? { ...TITLE_PRESETS[1].st, ...clip.text } : { ...TITLE_PRESETS[1].st, text: 'NEW TITLE' };
  const [st, setSt] = useState(start);
  const [posY, setPosY] = useState(clip ? valAt(clip.posY, 0) : Math.round(seq.height * POS_Y.center));
  const [dur, setDur] = useState(clip?.duration || 3);
  const [fade, setFade] = useState(clip ? (clip.transIn?.type ? clip.transIn.duration : 0) : 0.25);
  const cv = useRef(null); const t0 = useRef(performance.now());
  const set = (patch) => { t0.current = performance.now(); setSt((x) => ({ ...x, ...patch })); };
  // live preview, replaying the entrance animation every 2.5 s
  useEffect(() => {
    let raf;
    const tick = () => {
      const c = cv.current; if (!c) return;
      const W = c.width, H = c.height, k = W / seq.width; const g = c.getContext('2d');
      const grad = g.createLinearGradient(0, 0, W, H); grad.addColorStop(0, '#2c3540'); grad.addColorStop(1, '#5a6b7a'); g.fillStyle = grad; g.fillRect(0, 0, W, H);
      const local = ((performance.now() - t0.current) / 1000) % 2.5;
      const a = st.animIn === 'fade' || fade ? Math.min(1, fade ? local / Math.max(0.05, fade) : local / 0.25) : 1;
      g.save(); g.globalAlpha = st.animIn === 'none' && !fade ? 1 : a; g.translate(W / 2, H / 2 + posY * k); drawText(g, st, k, local); g.restore();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick); return () => cancelAnimationFrame(raf);
  }, [st, posY, fade]);
  const save = () => onSave({ text: { ...st, text: st.text || 'TITLE' }, posY, duration: Math.max(0.2, dur), fade: st.animIn === 'fade' ? Math.max(fade, 0.2) : fade });
  const chip = (on, label, fn, title) => html`<button type="button" class=${'chip' + (on ? ' on' : '')} title=${title} onClick=${fn}>${label}</button>`;
  const prevW = 220; const prevH = Math.round((prevW * seq.height) / seq.width);
  return html`<${Modal} wide title=${count > 1 ? `Style for ${count} titles and captions (each keeps its own words)` : clip ? 'Edit title' : 'New title'} icon="type" onClose=${onClose} footer=${html`<span class="faint grow" style="font-size:var(--fs-xs)">Enter saves · Shift+Enter adds a line</span><${Button} kind="ghost" onClick=${onClose}>Cancel</${Button}><${Button} kind="primary" icon=${clip ? 'check' : 'plus'} onClick=${save}>${clip ? 'Save title' : 'Add to timeline'}</${Button}>`}>
    <div style="display:grid;grid-template-columns:${prevW}px minmax(0, 1fr);gap:18px;align-items:start">
      <div class="col" style="gap:8px;position:sticky;top:0"><canvas ref=${cv} width=${prevW * 2} height=${prevH * 2} style=${{ width: prevW + 'px', height: prevH + 'px', borderRadius: '10px', boxShadow: 'var(--shadow-1)' }} /><div class="faint" style="font-size:var(--fs-xs)">Live preview at ${seq.width}×${seq.height}</div></div>
      <div class="col" style="gap:12px">
        <div class="field"><span class="label">Style</span><div class="chips">${TITLE_PRESETS.map((pr) => chip(false, pr.name, () => { set({ ...pr.st }); setPosY(Math.round(seq.height * POS_Y[pr.pos])); if (pr.st.animIn === 'fade') setFade(0.3); }))}</div></div>
        <${Field} label="Text" id="td-text"><textarea id="td-text" class="textarea" rows="2" value=${st.text} autofocus onInput=${(e) => set({ text: e.target.value })} onKeyDown=${(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); save(); } }} /></${Field}>
        <div class="form-grid" style="grid-template-columns:repeat(auto-fit, minmax(170px, 1fr))">
          <${Field} label="Font" id="td-font"><select id="td-font" class="select" value=${st.family} style=${{ fontFamily: `'${st.family}'` }} onChange=${(e) => set({ family: e.target.value, bold: HEAVY.has(e.target.value) })}>${fontOptions()}</select></${Field}>
          <div class="field"><span class="label">Look</span><div class="chips">${chip(st.bold !== false, 'Bold', () => set({ bold: st.bold === false }))}${chip(st.italic, 'Italic', () => set({ italic: !st.italic }))}${chip(st.uppercase, 'ALL CAPS', () => set({ uppercase: !st.uppercase }))}</div></div>
        </div>
        <${ParamField} label="Size" p=${st.pixelSize} animatable=${false} min=${8} max=${600} smin=${16} smax=${300} unit="px" onLive=${(v) => set({ pixelSize: Math.round(v.base) })} onCommit=${(v) => set({ pixelSize: Math.round(v.base) })} />
        <${ParamField} label="Letter spacing" p=${st.letterSpacing || 0} animatable=${false} min=${-20} max=${80} smin=${-10} smax=${40} unit="px" onLive=${(v) => set({ letterSpacing: Math.round(v.base) })} onCommit=${(v) => set({ letterSpacing: Math.round(v.base) })} />
        <div class="row wrap" style="gap:14px">
          <label class="row" style="gap:6px;font-size:var(--fs-sm)">Text <input type="color" value=${hex6(st.color, 'ffffff')} onInput=${(e) => set({ color: withAlpha(e.target.value, 1) })} aria-label="Text colour" /></label>
          <label class="row" style="gap:6px;font-size:var(--fs-sm)">Outline <input type="color" value=${hex6(st.outlineColor, '000000')} onInput=${(e) => set({ outlineColor: withAlpha(e.target.value, 1) })} aria-label="Outline colour" /></label>
          <label class="row" style="gap:6px;font-size:var(--fs-sm)">Shadow <input type="color" value=${hex6(st.shadowColor, '000000')} onInput=${(e) => set({ shadowColor: withAlpha(e.target.value, 0.7) })} aria-label="Shadow colour" /></label>
        </div>
        <${ParamField} label="Outline" p=${st.outlineWidth || 0} animatable=${false} min=${0} max=${40} smin=${0} smax=${20} unit="px" onLive=${(v) => set({ outlineWidth: Math.round(v.base) })} onCommit=${(v) => set({ outlineWidth: Math.round(v.base) })} />
        <${ParamField} label="Shadow" p=${st.shadow || 0} animatable=${false} min=${0} max=${30} smin=${0} smax=${20} unit="px" onLive=${(v) => set({ shadow: Math.round(v.base) })} onCommit=${(v) => set({ shadow: Math.round(v.base) })} />
        <div class="row wrap" style="gap:10px"><div class="check-row"><${Toggle} on=${!!st.box} label="Background box" onChange=${(v) => set({ box: v })} /><span>Background box</span></div>
          ${st.box ? html`<label class="row" style="gap:6px;font-size:var(--fs-sm)">Colour <input type="color" value=${hex6(st.boxColor, '000000')} onInput=${(e) => set({ boxColor: withAlpha(e.target.value, 0.9) })} aria-label="Box colour" /></label>` : null}</div>
        ${st.box ? html`<${ParamField} label="Rounded corners" p=${st.boxRadius || 0} animatable=${false} min=${0} max=${80} smin=${0} smax=${40} unit="px" onLive=${(v) => set({ boxRadius: Math.round(v.base) })} onCommit=${(v) => set({ boxRadius: Math.round(v.base) })} />` : null}
        ${st.box ? html`<${ParamField} label="Box padding" p=${st.boxPad ?? 18} animatable=${false} min=${0} max=${120} smin=${0} smax=${60} unit="px" onLive=${(v) => set({ boxPad: Math.round(v.base) })} onCommit=${(v) => set({ boxPad: Math.round(v.base) })} />` : null}
        <div class="field"><span class="label">Position</span><div class="chips">${Object.entries({ top: 'Top', center: 'Centre', lower: 'Lower third', bottom: 'Bottom' }).map(([k, l]) => chip(Math.abs(posY - Math.round(seq.height * POS_Y[k])) < 2, l, () => setPosY(Math.round(seq.height * POS_Y[k]))))}</div></div>
        <${ParamField} label="Height on screen" p=${posY} animatable=${false} min=${-seq.height} max=${seq.height} smin=${-seq.height / 2} smax=${seq.height / 2} unit="px" onLive=${(v) => setPosY(Math.round(v.base))} onCommit=${(v) => setPosY(Math.round(v.base))} />
        <div class="field"><span class="label">Entrance</span><div class="chips">${[['none', 'None'], ['fade', 'Fade in'], ['pop', 'Pop'], ['slide', 'Slide up']].map(([k, l]) => chip((st.animIn || 'none') === k, l, () => { set({ animIn: k }); if (k === 'fade' && !fade) setFade(0.3); }))}</div></div>
        <div class="form-grid" style="grid-template-columns:repeat(auto-fit, minmax(170px, 1fr))">
          <${ParamField} label="On screen for" p=${dur} animatable=${false} min=${0.2} max=${600} smin=${0.5} smax=${15} step=${0.1} digits=${1} unit="s" onLive=${(v) => setDur(v.base)} onCommit=${(v) => setDur(v.base)} />
          <${ParamField} label="Fade in/out" p=${fade} animatable=${false} min=${0} max=${5} smin=${0} smax=${2} step=${0.05} digits=${2} unit="s" onLive=${(v) => setFade(v.base)} onCommit=${(v) => setFade(v.base)} />
        </div>
      </div>
    </div></${Modal}>`;
}


// ------------------------------------------------------------ effect controls
/**
 * One adjustable setting: a slider for quick changes, a box for an exact number, and (when
 * animatable) a stopwatch to start keyframing, ◆ to add/remove a key at the playhead and ◀ ▶ to jump between keys.
 * p is the stored value (plain number or Velo { base, keys }); the field shows its value at clip time lt.
 */
function ParamField({ label, p, d = 0, mult = 1, lt = 0, inClip = true, min, max, smin, smax, step = 1, digits = 0, unit = '', animatable = true, dflt, onLive, onCommit, onJump }) {
  const value = valAt(p, lt, d) * mult;
  const [draft, setDraft] = useState(null);
  const lo = smin ?? min ?? -1000, hi = smax ?? max ?? 1000;
  const clampV = (v) => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, v));
  const make = (v) => withValueAt(p, lt, clampV(v) / mult, d);
  const keyed = animatable && isAnimated(p); const onKey = keyed && hasKeyAt(p, lt);
  const keys = sortedKeys(p).map((k) => k[0]);
  const prev = keys.filter((k) => k < lt - KEY_TOL).pop(), next = keys.find((k) => k > lt + KEY_TOL);
  const commitDraft = () => { if (draft == null) return; const v = Number(String(draft).replace(',', '.')); setDraft(null); if (Number.isFinite(v)) onCommit(make(v)); };
  const ib = (on) => ({ width: '22px', height: '22px', border: 0, borderRadius: '5px', display: 'grid', placeItems: 'center', cursor: 'pointer', background: on ? 'var(--gold-soft)' : 'transparent', color: on ? 'var(--gold-ink)' : 'var(--ink-3)', padding: 0 });
  return html`<div class="col" style="gap:2px;padding:4px 0">
    <div class="row" style="gap:4px">
      ${animatable ? html`<button type="button" style=${ib(keyed)} title=${keyed ? 'Stop animating (keeps the current value)' : 'Animate: start keyframing this setting'} disabled=${!inClip && !keyed} onClick=${() => onCommit(toggleAnimation(p, lt, d))} aria-pressed=${keyed}><${Icon} name="clock" size=${13} /></button>` : null}
      <span class="grow" style="font-size:var(--fs-sm);color:var(--ink-2)" title=${dflt != null ? 'Double-click to reset' : ''} onDblClick=${() => dflt != null && onCommit(make(dflt))}>${label}</span>
      ${keyed ? html`<button type="button" style=${ib(false)} title="Previous keyframe" disabled=${prev == null} onClick=${() => onJump(prev)}>‹</button>
        <button type="button" style=${{ ...ib(onKey), fontSize: '12px' }} title=${onKey ? 'Remove keyframe here' : 'Add keyframe at the playhead'} disabled=${!inClip} onClick=${() => onCommit(toggleKeyAt(p, lt, d))}>${onKey ? '◆' : '◇'}</button>
        <button type="button" style=${ib(false)} title="Next keyframe" disabled=${next == null} onClick=${() => onJump(next)}>›</button>` : null}
      <input class="input sm tnum" style="width:70px;text-align:right" inputmode="decimal" value=${draft ?? Number(value).toFixed(digits)} onFocus=${(e) => e.target.select()} onInput=${(e) => setDraft(e.target.value)} onBlur=${commitDraft} onKeyDown=${(e) => { if (e.key === 'Enter') { e.preventDefault(); commitDraft(); e.target.blur(); } else if (e.key === 'Escape') { setDraft(null); e.target.blur(); } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') e.preventDefault(); }} aria-label=${label} />
      <span class="faint" style="width:16px;font-size:var(--fs-xs)">${unit}</span>
    </div>
    <input type="range" class="range" style="width:100%" min=${lo} max=${hi} step=${step} value=${Math.min(hi, Math.max(lo, value))} disabled=${keyed && !inClip}
      onInput=${(e) => onLive(make(Number(e.target.value)))} onChange=${(e) => onCommit(make(Number(e.target.value)))} aria-label=${`${label} slider`} />
  </div>`;
}

/** The music library on the Studio screen: every mood, listen to any track, add it at the playhead. */
function MusicLibrary({ onClose, onAdd }) {
  const { data, reload } = useApi('/api/music/catalog');
  const [mood, setMood] = useState(null); const [playing, setPlaying] = useState(null); const [busy, setBusy] = useState(null);
  const audio = useRef(null);
  useEffect(() => () => audio.current?.pause(), []);
  const listen = (id) => { if (!audio.current) { audio.current = new Audio(); audio.current.onended = () => setPlaying(null); } if (playing === id) { audio.current.pause(); setPlaying(null); return; } audio.current.src = api.url(`/api/music/play?id=${encodeURIComponent(id)}`); audio.current.volume = 0.7; audio.current.play().catch(() => toast('That track could not play.', { kind: 'warn' })); setPlaying(id); };
  const moods = data?.moods || []; const cur = moods.find((m) => m.mood === mood) || moods[0];
  const add = async (tr) => { setBusy(tr.id); try { audio.current?.pause(); setPlaying(null); await onAdd(tr.id, tr.title); onClose(); } catch (e) { toast(e.message, { kind: 'error' }); } finally { setBusy(null); } };
  return html`<${Modal} wide title="Music" icon="volume" onClose=${onClose} footer=${html`<span class="faint grow" style="font-size:var(--fs-xs)">Free to use: your own music folder, CC0/CC BY tracks (credit shown) and Euclidean originals.</span><${Button} kind="ghost" onClick=${() => act(() => api.post('/api/music/fill'), { ok: 'Getting free music. New tracks show up here in a minute.' }).then(() => setTimeout(reload, 60000))}>Get more free music</${Button}><${Button} kind="ghost" onClick=${onClose}>Close</${Button}>`}>
    ${!data ? html`<${Loading} />` : html`<div style="display:grid;grid-template-columns:170px minmax(0, 1fr);gap:16px;min-height:340px">
      <div class="col" style="gap:4px">${moods.map((m) => html`<button type="button" class=${'chip' + (cur?.mood === m.mood ? ' on' : '')} style="justify-content:space-between;width:100%" onClick=${() => setMood(m.mood)}>${m.label}<span class="faint">${m.tracks.length}</span></button>`)}</div>
      <div class="col" style="gap:6px;max-height:420px;overflow:auto">${(cur?.tracks || []).map((tr) => html`<div class="row" style="gap:10px;padding:8px 10px;border:1px solid var(--line);border-radius:10px;background:${playing === tr.id ? 'var(--surface-2)' : 'transparent'}">
        <${Button} size="sm" kind=${playing === tr.id ? 'primary' : 'soft'} icon=${playing === tr.id ? 'pause' : 'play'} onClick=${() => listen(tr.id)}>${playing === tr.id ? 'Stop' : 'Listen'}</${Button}>
        <div class="col grow" style="gap:0;min-width:0"><b class="ellipsis">${tr.title}</b><span class="faint" style="font-size:var(--fs-xs)">${tr.source} · ${tr.license}</span></div>
        <${Button} size="sm" kind="primary" icon="plus" disabled=${!!busy} onClick=${() => add(tr)}>${busy === tr.id ? 'Adding…' : 'Add'}</${Button}>
      </div>`)}</div></div>`}
  </${Modal}>`;
}

/** Text settings for several selected titles/captions at once (their words stay their own). */
function MultiTextControls({ texts, seq, edit, onEditTitle }) {
  const c = texts[0]; const st = c.text || {}; const ids = texts.map((x) => x.id); const allCaps = texts.every(isCaption);
  const setAll = (fn) => edit((d, s) => { for (const tr of s.videoTracks) for (const x of tr.clips) if (ids.includes(x.id) && x.text) fn(x.text, x); });
  const hex = (v, d) => '#' + String(v || d).replace('#', '').slice(-6);
  const col = (key, label, d) => html`<label class="row" style="gap:6px;font-size:var(--fs-sm)">${label} <input type="color" value=${hex(st[key], d)} onInput=${(e) => setAll((x) => { x[key] = '#ff' + e.target.value.slice(1); })} aria-label=${label} /></label>`;
  const slider = (key, label, min, max, d) => html`<${ParamField} label=${label} p=${st[key] ?? d} animatable=${false} min=${min} max=${max} unit="px" onLive=${(v) => { for (const x of texts) x.text[key] = Math.round(v.base); window.dispatchEvent(new Event('studio-redraw')); }} onCommit=${(v) => setAll((x) => { x[key] = Math.round(v.base); })} />`;
  return html`<div style="background:var(--ed-panel);border-left:1px solid var(--line);overflow:auto;padding:12px 14px">
    <div class="row"><span class="eyebrow grow">${allCaps ? 'Captions' : 'Text'}: ${texts.length} selected</span><span class="badge outline">${allCaps ? 'Spoken words' : 'Titles'}</span></div>
    <div class="faint" style="font-size:var(--fs-xs);margin:6px 0 10px">Changes here apply to all ${texts.length}; each keeps its own words and timing.</div>
    <div class="col" style="gap:8px">
      <${Button} size="sm" kind="lav" icon="type" onClick=${() => onEditTitle?.(c.id, ids)}>Style all ${texts.length} (full designer)…</${Button}>
      ${allCaps ? html`<div class="field"><span class="label">Caption look</span><div class="chips">${LOOKS.map((l) => html`<button type="button" class="chip" style=${{ fontFamily: `'${l.v.font}'` }} onClick=${() => setAll((x) => Object.assign(x, lookText(l.v, false)))}>${l.label}</button>`)}</div></div>` : html`<div class="field"><span class="label">Look</span><div class="chips">${TITLE_PRESETS.slice(0, 3).map((pr) => html`<button type="button" class="chip" onClick=${() => setAll((x) => { for (const k of STYLE_KEYS) if (pr.st[k] !== undefined) x[k] = pr.st[k]; if (!pr.st.box) x.box = false; })}>${pr.name}</button>`)}</div></div>`}
      <select class="select sm" value=${st.family || 'Montserrat'} style=${{ fontFamily: `'${st.family || 'Montserrat'}'` }} onChange=${(e) => setAll((x) => { x.family = e.target.value; x.bold = HEAVY.has(e.target.value); })} aria-label="Font">${fontOptions()}</select>
      ${slider('pixelSize', 'Text size', 8, 600, 96)}
      ${slider('outlineWidth', 'Outline', 0, 40, 0)}
      ${slider('shadow', 'Shadow', 0, 30, 0)}
      <div class="row wrap" style="gap:12px">${col('color', 'Text', 'ffffff')}${col('outlineColor', 'Outline', '000000')}${col('hlColor', 'Highlight', 'f2c14e')}</div>
      <div class="row wrap" style="gap:10px">
        <div class="check-row"><${Toggle} on=${!!st.box} label="Background box" onChange=${(v) => setAll((x) => { x.box = v; if (v && !x.boxColor) x.boxColor = '#ffffffff'; })} /><span>Box</span></div>
        <div class="check-row"><${Toggle} on=${!!st.uppercase} label="Capitals" onChange=${(v) => setAll((x) => { x.uppercase = v; })} /><span>CAPITALS</span></div>
        ${st.box ? col('boxColor', 'Box colour', 'ffffff') : null}
      </div>
      ${st.box ? slider('boxRadius', 'Rounded corners', 0, 80, 0) : null}
    </div></div>`;
}

function EffectControls({ selected, sel = [], findClip, seq, edit, media, t, setT, onEditTitle }) {
  const texts = findClip ? sel.map((id) => findClip(seq, id)?.c).filter((x) => x && x.type === 3 && x.text) : [];
  if (texts.length > 1 && texts.length === sel.length) return html`<${MultiTextControls} texts=${texts} seq=${seq} edit=${edit} onEditTitle=${onEditTitle} />`;
  if (!selected) return html`<div style="background:var(--ed-panel);border-left:1px solid var(--line);padding:14px"><div class="eyebrow">Effect controls</div><p class="faint" style="font-size:var(--fs-sm);margin-top:10px">Select a clip on the timeline to adjust and animate position, scale, rotation, opacity, volume, speed, effects and transitions.</p>
    <div class="divider" /><div class="eyebrow">Shortcuts</div><div class="col" style="gap:4px;margin-top:8px;font-size:var(--fs-sm)" class="muted">${[['Space', 'Play / pause'], ['J K L', 'Shuttle'], ['S', 'Split selected'], ['Shift S / Ctrl B', 'Split all tracks'], ['Ctrl A', 'Select everything'], ['Drag on empty space', 'Box-select clips'], ['Q / W', 'Delete everything before / after the playhead'], ['Del', 'Delete'], ['Alt / Shift Del', 'Ripple delete (closes the gap)'], ['V / C / T', 'Select / razor / title'], ['Ctrl Z', 'Undo'], ['Ctrl C / X / V', 'Copy / cut / paste'], ['Ctrl V a YouTube link', 'Puts its audio on the timeline'], ['Ctrl D', 'Duplicate'], ['Ctrl R', 'Speed / duration'], ['F2', 'Rename clip'], ['Shift E', 'Enable / disable'], ['Right-click', 'All clip tools'], ['Drop on a clip', 'Pushes it down a layer'], ['Shift + drop', 'Pushes it up instead'], ['Ctrl + drop', 'Replaces it'], ['+ / −', 'Zoom timeline']].map(([k, d]) => html`<div class="row"><kbd>${k}</kbd><span class="faint">${d}</span></div>`)}</div></div>`;
  const c = selected.c;
  // Live-preview while dragging a slider (mutate in place); commit one undo step on release.
  const [, force] = useState(0);
  useEffect(() => { const f = () => force((n) => n + 1); window.addEventListener('studio-redraw', f); return () => window.removeEventListener('studio-redraw', f); }, []);
  const setRaw = (fn) => { revertLive(); edit((d, s) => { for (const tr of [...s.videoTracks, ...s.audioTracks]) { const x = tr.clips.find((y) => y.id === c.id); if (x) fn(x, tr); } }); };
  const lt = Math.max(0, Math.min(c.duration, t - c.start)); const inClip = t >= c.start - 1e-6 && t <= c.start + c.duration + 1e-6;
  const jump = (kt) => { if (kt != null) setT(c.start + kt); };
  // a clip setting: live while sliding, saved on release
  const F = (key, props) => html`<${ParamField} p=${c[key]} lt=${lt} inClip=${inClip} onJump=${jump} onLive=${(v) => liveSet(c, key, v, c.id + key)} onCommit=${(v) => setRaw((x) => { x[key] = v; })} ...${props} />`;
  const scaleField = html`<${ParamField} label="Scale" p=${c.scaleX} d=${1} mult=${100} lt=${lt} inClip=${inClip} onJump=${jump} min=${1} max=${2000} smin=${1} smax=${400} step=${0.5} digits=${1} unit="%" dflt=${100}
    onLive=${(v) => { liveSet(c, 'scaleX', v, c.id + 'sx'); liveSet(c, 'scaleY', clone(v), c.id + 'sy'); }} onCommit=${(v) => setRaw((x) => { x.scaleX = v; x.scaleY = clone(v); })} />`;
  return html`<div style="background:var(--ed-panel);border-left:1px solid var(--line);overflow:auto;padding:12px 14px">
    <div class="row"><span class="eyebrow grow">Effect controls</span><span class="badge outline">${['Video', 'Audio', 'Image', 'Title', 'Nested'][c.type]}</span></div>
    <input class="input sm" style="font-weight:600;margin:6px 0 4px;width:100%" key=${c.id} value=${c.type === 3 && !c.renamed ? clipLabel(c) : c.name || media[c.mediaId]?.name || 'Clip'} title="Clip name: type a new one and press Enter (F2 also renames)" aria-label="Clip name"
      onKeyDown=${(e) => { if (e.key === 'Enter') e.target.blur(); e.stopPropagation(); }} onChange=${(e) => { const v = e.target.value.trim().slice(0, 80); if (v) setRaw((x) => { if (isHook(x)) x.isHook = true; x.name = v; x.renamed = true; }); }} />
    <div class="faint" style="font-size:var(--fs-xs);margin-bottom:8px">${inClip ? html`Playhead ${lt.toFixed(2)}s into this clip. Click <${Icon} name="clock" size=${11} /> to animate a setting, then move the playhead and change the value to add keyframes.` : 'Move the playhead over this clip to set keyframes.'}</div>
    ${c.type === 3 ? html`<div class="col" style="gap:8px;margin-bottom:10px">
      <${Button} size="sm" kind="lav" icon="type" onClick=${() => onEditTitle?.(c.id)}>Edit title, style & animation…</${Button}>
      <textarea class="textarea" rows="2" id="ec-text" value=${c.text?.text || ''} onInput=${(e) => liveSet(c.text, 'text', e.target.value, c.id + 'txt')} onBlur=${(e) => { const v = e.target.value; setRaw((x) => { x.text.text = v; x.name = v.slice(0, 40); }); }} onKeyDown=${(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.target.blur(); } }} aria-label="Title text" title="Enter applies · Shift+Enter adds a line" />
      <select class="select sm" value=${c.text?.family || 'Montserrat'} style=${{ fontFamily: `'${c.text?.family || 'Montserrat'}'` }} onChange=${(e) => setRaw((x) => { x.text.family = e.target.value; x.text.bold = HEAVY.has(e.target.value); })} aria-label="Font">${fontOptions()}</select>
      <${ParamField} label="Text size" p=${c.text?.pixelSize || 96} animatable=${false} min=${8} max=${600} smin=${12} smax=${300} unit="px" onLive=${(v) => liveSet(c.text, 'pixelSize', Math.round(v.base), c.id + 'tsize')} onCommit=${(v) => setRaw((x) => { x.text.pixelSize = Math.round(v.base); })} />
      <${ParamField} label="Outline" p=${c.text?.outlineWidth || 0} animatable=${false} min=${0} max=${40} unit="px" onLive=${(v) => liveSet(c.text, 'outlineWidth', Math.round(v.base), c.id + 'tow')} onCommit=${(v) => setRaw((x) => { x.text.outlineWidth = Math.round(v.base); })} /></div>` : null}
    ${c.type !== 1 ? html`<div class="eyebrow" style="margin-top:6px">Motion</div>
      ${F('posX', { label: 'Position X', min: -20000, max: 20000, smin: -seq.width, smax: seq.width, unit: 'px', dflt: 0 })}
      ${F('posY', { label: 'Position Y', min: -20000, max: 20000, smin: -seq.height, smax: seq.height, unit: 'px', dflt: 0 })}
      ${scaleField}
      ${F('rotation', { label: 'Rotation', min: -3600, max: 3600, smin: -180, smax: 180, step: 0.5, digits: 1, unit: '°', dflt: 0 })}
      ${F('opacity', { label: 'Opacity', d: 1, mult: 100, min: 0, max: 100, smin: 0, smax: 100, unit: '%', dflt: 100 })}` : null}
    ${c.type === 0 || c.type === 1 ? html`<div class="eyebrow" style="margin-top:10px">Time</div>
      <${ParamField} label="Speed" p=${(c.speed || 1)} mult=${100} animatable=${false} min=${10} max=${1000} smin=${10} smax=${400} unit="%" dflt=${100} onLive=${() => {}} onCommit=${(v) => setRaw((x) => { const old = x.speed || 1; x.speed = Math.max(0.1, v.base); x.duration = (x.duration * old) / x.speed; const k = old / x.speed; for (const [o, kk] of animParams(x)) if (o[kk]?.keys?.length) o[kk] = { ...o[kk], keys: o[kk].keys.map(([tt, v]) => [qt(tt * k), v]) }; })} />` : null}
    ${c.type === 1 ? html`<div class="eyebrow" style="margin-top:10px">Audio</div>${F('volume', { label: 'Volume', d: 1, mult: 100, min: 0, max: 400, smin: 0, smax: 200, unit: '%', dflt: 100 })}` : null}
    ${(c.effects || []).map((e, i) => { const def = EFFECTS.find((f) => f.id === e.effectId); return html`<div class="divider" /><div class="row"><${Toggle} on=${e.enabled !== false} label="Enable effect" onChange=${(on) => setRaw((x) => { x.effects[i].enabled = on; })} /><b class="grow" style="font-size:var(--fs-sm)">${def?.name || e.effectId}</b><${Button} size="sm" kind="ghost" icon="trash" title="Remove effect" onClick=${() => setRaw((x) => { x.effects.splice(i, 1); })} /></div>
      ${(def?.params || []).map(([k, label, mn, mx, dflt, stp]) => html`<${ParamField} label=${label} p=${e.params?.[k]} d=${dflt} lt=${lt} inClip=${inClip} onJump=${jump} min=${mn} max=${mx} step=${stp || (mx - mn > 50 ? 1 : 0.05)} digits=${stp && stp < 1 ? 2 : 0} dflt=${dflt}
        onLive=${(v) => liveSet(e.params, k, v, c.id + 'fx' + i + k)} onCommit=${(v) => setRaw((x) => { x.effects[i].params[k] = v; })} />`)}`; })}
    <div class="divider" /><div class="eyebrow">Transitions</div>
    ${['transIn', 'transOut'].map((edge) => html`<div class="row" style="padding:4px 0"><span class="muted" style="width:34px;font-size:var(--fs-sm)">${edge === 'transIn' ? 'In' : 'Out'}</span>
      <select class="select sm" style="flex:1" value=${c[edge]?.type || 0} onChange=${(e) => setRaw((x) => { x[edge] = { type: Number(e.target.value), duration: x[edge]?.duration || 0.5 }; })} aria-label=${edge}><option value="0">None</option>${['Dissolve', 'Wipe', 'Iris', 'Slide'].map((cat) => html`<optgroup label=${cat}>${TRANSITIONS.filter((tt) => tt.cat === cat).map((tt) => html`<option value=${tt.type}>${tt.name}</option>`)}</optgroup>`)}</select>
      <input class="input sm tnum" style="width:62px" inputmode="decimal" value=${c[edge]?.duration || 0.5} onChange=${(e) => { const v = Number(e.target.value); if (v > 0) setRaw((x) => { x[edge] = { ...(x[edge] || { type: 0 }), duration: Math.max(0.04, v) }; }); }} aria-label="Duration" /><span class="faint" style="font-size:var(--fs-xs)">s</span></div>`)}
  </div>`;
}

// ------------------------------------------------------------ timeline
function Timeline({ seq, media, t, setT, sel, setSel, tool, snap, zoom, setZoom, duration, edit, findClip, linked, onAdd, onDropFiles, onClipMenu, onEditTitle }) {
  const scroller = useRef(null);
  const [drag, setDrag] = useState(null);
  // Box select: drag on empty timeline space to select every clip the box touches (Shift/Ctrl adds to the selection).
  const [box, setBox] = useState(null);
  const startBox = (e) => {
    if (e.button !== 0) return;
    const b0 = { x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY, add: e.shiftKey || e.ctrlKey || e.metaKey, base: sel };
    setBox(b0);
    const move = (ev) => setBox((b) => b && { ...b, x1: ev.clientX, y1: ev.clientY });
    const up = (ev) => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); setBox(null);
      const x0 = Math.min(b0.x0, ev.clientX), x1 = Math.max(b0.x0, ev.clientX), y0 = Math.min(b0.y0, ev.clientY), y1 = Math.max(b0.y0, ev.clientY);
      if (x1 - x0 < 4 && y1 - y0 < 4) { if (!b0.add) setSel([]); return; }
      const hit = [...(scroller.current?.querySelectorAll('[data-clip]') || [])].filter((el) => { const r = el.getBoundingClientRect(); return r.right > x0 && r.left < x1 && r.bottom > y0 && r.top < y1; }).map((el) => el.dataset.clip);
      setSel(b0.add ? [...new Set([...b0.base, ...hit])] : hit); if (hit.length) sfx('tap');
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  };
  // Pinch / Ctrl+wheel zooms around the mouse; the plain wheel scrolls along the timeline.
  const zoomRef = useRef(zoom); zoomRef.current = zoom; const anchor = useRef(null);
  const zoomAround = (factor, cx) => {
    const el = scroller.current; if (!el) return; const mx = Math.max(0, cx - el.getBoundingClientRect().left - HEAD_W);
    const nz = Math.max(4, Math.min(600, zoomRef.current * factor)); if (nz === zoomRef.current) return;
    anchor.current = { at: (mx + el.scrollLeft) / zoomRef.current, mx }; zoomRef.current = nz; setZoom(nz);
  };
  useEffect(() => {
    const el = scroller.current; if (!el) return;
    const onWheel = (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) { e.preventDefault(); zoomAround(wheelFactor(e), e.clientX); return; }
      if (!e.shiftKey && Math.abs(e.deltaY) > Math.abs(e.deltaX) && el.scrollHeight <= el.clientHeight + 2) { e.preventDefault(); el.scrollLeft += e.deltaY; }
    };
    el.addEventListener('wheel', onWheel, { passive: false }); return () => el.removeEventListener('wheel', onWheel);
  }, []);
  usePinch(scroller, (f, x) => zoomAround(f, x));
  useEffect(() => { const a = anchor.current; if (a && scroller.current) { scroller.current.scrollLeft = Math.max(0, a.at * zoom - a.mx); anchor.current = null; } }, [zoom]);
  const [, force] = useState(0);
  useEffect(() => { const f = () => force((n) => n + 1); window.addEventListener('studio-redraw', f); return () => window.removeEventListener('studio-redraw', f); }, []);
  const lanes = [...seq.videoTracks.map((tr, i) => ({ tr, type: 0, i })).reverse(), ...seq.audioTracks.map((tr, i) => ({ tr, type: 1, i }))];
  const width = Math.max(800, (duration + 30) * zoom);
  const xOf = (s) => s * zoom; const sOf = (x) => Math.max(0, x / zoom);
  const fps = seq.fps || 30;
  // Snap to clip edges, the playhead, and the keyframes of selected clips.
  const snapPoints = () => [t, 0, ...[...seq.videoTracks, ...seq.audioTracks].flatMap((tr) => tr.clips.flatMap((c) => [c.start, c.start + c.duration, ...(sel.includes(c.id) ? keyTimesOf(c).map((k) => c.start + k) : [])]))];
  const doSnap = (s, alt, exclude = new Set()) => {
    if (!snap || alt) return Math.round(s * fps) / fps;
    let best = s, bd = 8 / zoom;
    for (const p of snapPoints()) { if (exclude.has(p)) continue; const d = Math.abs(p - s); if (d < bd) { bd = d; best = p; } }
    return Math.round(best * fps) / fps;
  };

  // ruler ticks
  const step = zoom > 120 ? 1 : zoom > 40 ? 2 : zoom > 15 ? 5 : zoom > 6 ? 15 : 30;
  const ticks = []; for (let s = 0; s <= duration + 30; s += step) ticks.push(s);

  const onRuler = (e) => {
    // the playhead snaps to clip edges and the selected clip's keyframes (hold Alt to scrub freely)
    const r = scroller.current.getBoundingClientRect(); const skip = new Set([t]); const move = (ev) => setT(doSnap(sOf(ev.clientX - r.left + scroller.current.scrollLeft - HEAD_W), ev.altKey, skip));
    move(e); const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  };

  const onClipDown = (e, c, lane) => {
    e.stopPropagation();
    if (lane.tr.locked) return;
    const r = e.currentTarget.getBoundingClientRect();
    const scrollerRect = scroller.current.getBoundingClientRect();
    const pointerS = sOf(e.clientX - scrollerRect.left + scroller.current.scrollLeft - HEAD_W);
    if (tool === 'razor') { setT(Math.round(pointerS * fps) / fps); setSel([c.id]); setTimeout(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 's' })), 0); return; }
    const edgeL = e.clientX - r.left < 7, edgeR = r.right - e.clientX < 7;
    const mode = edgeL ? 'trimL' : edgeR ? 'trimR' : 'move';
    const additive = e.shiftKey || e.ctrlKey;
    // A click picks that one clip (captions too; "Select all captions" picks them all). Shift/Ctrl-click adds to the
    // selection; clicking a clip that's already selected keeps the selection, so a group drags together.
    const ids = additive ? [...new Set([...sel, c.id])] : sel.includes(c.id) ? sel : [c.id];
    setSel(ids); sfx('tap');
    const group = mode === 'move' ? [...new Set(ids.flatMap((id) => { const f = findClip(seq, id); return f ? linked(seq, f.c).map((x) => x.id) : []; }))] : [c.id, ...linked(seq, c).filter((x) => x.id !== c.id).map((x) => x.id)];
    const orig = Object.fromEntries(group.map((id) => [id, clone(findClip(seq, id).c)]));
    setDrag({ mode, startX: e.clientX, startY: e.clientY, clipId: c.id, lane, group, orig, dt: 0, dTrack: 0, moved: false });
  };
  useEffect(() => {
    if (!drag) return;
    const move = (e) => {
      // Button already up (a quick click can release before this listener exists): end the drag instead of dragging a loose clip.
      if (!(e.buttons & 1)) { setDrag(null); return; }
      const ds = (e.clientX - drag.startX) / zoom; if (!drag.moved && Math.abs(e.clientX - drag.startX) < 3 && Math.abs(e.clientY - drag.startY) < 4) return;
      const o = drag.orig[drag.clipId]; let dt = ds;
      if (drag.mode === 'move') { const ns = doSnap(o.start + ds, e.altKey, new Set([o.start, o.start + o.duration])); const ne = doSnap(o.start + o.duration + ds, e.altKey, new Set([o.start, o.start + o.duration])); dt = Math.abs(ns - (o.start + ds)) <= Math.abs(ne - (o.start + o.duration + ds)) ? ns - o.start : ne - o.start - o.duration; dt = Math.max(-Math.min(...Object.values(drag.orig).map((x) => x.start)), dt); }
      const dTrack = drag.mode === 'move' ? Math.round((e.clientY - drag.startY) / TRACK_H[drag.lane.type]) : 0;
      setDrag({ ...drag, dt, dTrack, moved: true, alt: e.altKey, ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey });
    };
    const up = (ev) => {
      const d = drag; setDrag(null);
      if (!d.moved) return;
      const replace = !!(ev?.ctrlKey || ev?.metaKey) && d.mode === 'move'; const dir = ev?.shiftKey ? 'up' : 'down';
      let pushed = 0; const keep = new Set(d.group);
      edit((dd, s) => {
        for (const id of d.group) {
          const f = findClip(s, id); if (!f) continue; const o = d.orig[id]; const c = f.c;
          if (d.mode === 'move') {
            c.start = Math.max(0, Math.round((o.start + d.dt) * fps) / fps);
            const list = c.type === 1 ? s.audioTracks : s.videoTracks; let ti = list.indexOf(f.tr);
            if (id === d.clipId || sel.includes(id)) { const dir = c.type === 1 ? d.dTrack : -d.dTrack; ti = Math.max(0, Math.min(list.length - 1, ti + dir)); }
            f.tr.clips = f.tr.clips.filter((x) => x.id !== id);
            // Captions slide freely along their own track (they may overlap; nothing gets pushed to another layer).
            if (isCaption(c) && !replace && list[ti] === f.tr) { f.tr.clips.push(c); f.tr.clips.sort((a, b) => a.start - b.start); continue; }
            pushed += place(s, c.type === 1 ? 'a' : 'v', ti, c, { replace, keep, dir });
          } else if (d.mode === 'trimL') {
            const maxIn = (o.in || 0) / (o.speed || 1);
            const ns = doSnap(Math.min(o.start + o.duration - 1 / fps, Math.max(o.start - maxIn, o.start + d.dt)), d.alt);
            const delta = ns - o.start; c.start = ns; c.duration = o.duration - delta; c.in = Math.max(0, (o.in || 0) + delta * (o.speed || 1)); shiftKeys(c, -delta);
          } else {
            const m = media[o.mediaId]; const maxDur = m && m.kind < 2 ? ((m.duration - (o.in || 0)) / (o.speed || 1)) : 3600;
            const ne = doSnap(o.start + Math.max(1 / fps, Math.min(maxDur, o.duration + d.dt)), d.alt);
            c.duration = Math.max(1 / fps, Math.min(maxDur, ne - o.start));
          }
        }
      });
      sfx('press');
      if (pushed) toast(`${pushed} clip${pushed > 1 ? 's' : ''} moved ${dir} a layer. Hold Shift to push up, Ctrl to replace.`, { kind: 'info', ms: 3200 });
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
  }, [drag]);

  const view = (c) => {
    if (!drag || !drag.moved || !drag.group.includes(c.id)) return { start: c.start, duration: c.duration, dy: 0 };
    const o = drag.orig[c.id];
    if (drag.mode === 'move') return { start: Math.max(0, o.start + drag.dt), duration: o.duration, dy: c.id === drag.clipId || sel.includes(c.id) ? drag.dTrack * TRACK_H[c.type === 1 ? 1 : 0] : 0 };
    if (drag.mode === 'trimL') { const ns = Math.min(o.start + o.duration - 0.05, o.start + drag.dt); return { start: ns, duration: o.duration - (ns - o.start), dy: 0 }; }
    return { start: o.start, duration: Math.max(0.05, o.duration + drag.dt), dy: 0 };
  };

  // While dragging a clip over others, say what will happen on release.
  const dragHint = (() => {
    if (!drag || !drag.moved || drag.mode !== 'move') return '';
    const o = drag.orig[drag.clipId]; const f = findClip(seq, drag.clipId); if (!f || !o) return '';
    const list = o.type === 1 ? seq.audioTracks : seq.videoTracks;
    const ti = Math.max(0, Math.min(list.length - 1, list.indexOf(f.tr) + (o.type === 1 ? drag.dTrack : -drag.dTrack)));
    const st = o.start + drag.dt, en = st + o.duration;
    const n = list[ti].clips.filter((x) => !drag.group.includes(x.id) && x.start < en - 1e-6 && x.start + x.duration > st + 1e-6).length;
    if (!n || (isCaption(o) && !drag.ctrl && list[ti] === f.tr)) return '';
    return drag.ctrl ? `Release to replace ${n} clip${n > 1 ? 's' : ''} (Ctrl)` : `Release to push ${n} clip${n > 1 ? 's' : ''} ${drag.shift ? 'up' : 'down'} a layer · Shift = up · Ctrl = replace`;
  })();
  const toggleTrack = (lane, key) => edit((d, s) => { (lane.type === 1 ? s.audioTracks : s.videoTracks)[lane.i][key] = !(lane.type === 1 ? s.audioTracks : s.videoTracks)[lane.i][key]; });
  const addTrack = (type) => edit((d, s) => { const list = type === 1 ? s.audioTracks : s.videoTracks; list.push({ type, name: `${type === 1 ? 'A' : 'V'}${list.length + 1}`, muted: false, locked: false, volume: { base: 1 }, clips: [] }); });
  const onDropMedia = (e, lane) => {
    const r = scroller.current.getBoundingClientRect(); const at = doSnap(sOf(e.clientX - r.left + scroller.current.scrollLeft - HEAD_W), e.altKey);
    if (e.dataTransfer.files?.length) { e.preventDefault(); if (lane.tr.locked) return toast('That track is locked', { kind: 'warn' }); onDropFiles(e.dataTransfer.files, lane, at, e.ctrlKey || e.metaKey, e.shiftKey ? 'up' : 'down'); return; }
    const mid = e.dataTransfer.getData('text/x-media'); if (!mid || !media[mid]) return; e.preventDefault();
    onAdd(media[mid], lane.type === 0 ? lane.i : 0, at, lane.type === 1 ? lane.i : 0, e.ctrlKey || e.metaKey, e.shiftKey ? 'up' : 'down');
  };

  return html`<div style="flex:1;display:flex;flex-direction:column;min-height:0;min-width:0;background:var(--ed-panel);border-top:1px solid var(--line)">
    <div class="row" style="padding:6px 12px;border-bottom:1px solid var(--line);gap:10px">
      <span class="eyebrow">Timeline</span><span class="mono tnum" style="color:var(--teal-ink)">${tc(t, fps)}</span><span class="faint" style="font-size:var(--fs-xs)">${sel.length ? `${sel.length} selected` : ''}</span>${dragHint ? html`<span class="badge ${drag?.ctrl ? 'coral' : drag?.shift ? 'lav' : 'sky'}">${dragHint}</span>` : null}
      <div class="spacer" /><${Button} kind="ghost" size="sm" icon="plus" onClick=${() => addTrack(0)}>Video track</${Button}><${Button} kind="ghost" size="sm" icon="plus" onClick=${() => addTrack(1)}>Audio track</${Button}>
      <${Icon} name="zoomOut" size=${15} style="color:var(--ink-3)" /><input type="range" class="range" style="width:140px" min="4" max="600" value=${zoom} onInput=${(e) => setZoom(Number(e.target.value))} aria-label="Timeline zoom" title="Or pinch / Ctrl + scroll on the timeline" /><${Icon} name="zoomIn" size=${15} style="color:var(--ink-3)" />
    </div>
    <div ref=${scroller} style="flex:1;overflow:auto;position:relative;touch-action:pan-x pan-y" onPointerDown=${(e) => { if (e.target === e.currentTarget) startBox(e); }}>
      ${box ? html`<div style=${{ position: 'fixed', left: Math.min(box.x0, box.x1) + 'px', top: Math.min(box.y0, box.y1) + 'px', width: Math.abs(box.x1 - box.x0) + 'px', height: Math.abs(box.y1 - box.y0) + 'px', border: '1px dashed var(--teal-ink)', background: 'rgba(102,189,180,0.12)', zIndex: 50, pointerEvents: 'none' }} />` : null}
      <div style=${{ width: width + HEAD_W + 'px', position: 'relative', minHeight: '100%' }} onPointerDown=${(e) => { if (e.target === e.currentTarget) startBox(e); }}>
        <div style=${{ position: 'sticky', top: 0, zIndex: 3, display: 'flex', height: '24px', background: 'var(--ed-panel)', borderBottom: '1px solid var(--line)' }}>
          <div style=${{ width: HEAD_W + 'px', flex: 'none', position: 'sticky', left: 0, background: 'var(--ed-panel)', zIndex: 4, borderRight: '1px solid var(--line)' }} />
          <div style="position:relative;flex:1;cursor:text" onPointerDown=${onRuler}>${ticks.map((s) => html`<div style=${{ position: 'absolute', left: xOf(s) + 'px', top: 0, bottom: 0, borderLeft: '1px solid var(--line-strong)', paddingLeft: '4px', fontSize: '10px', color: 'var(--ink-3)', lineHeight: '22px' }} class="tnum">${dur(s)}</div>`)}</div>
        </div>
        ${lanes.map((lane) => html`<div style=${{ display: 'flex', height: TRACK_H[lane.type] + 'px', borderBottom: '1px solid var(--line)' }}>
          <div style=${{ width: HEAD_W + 'px', flex: 'none', position: 'sticky', left: 0, zIndex: 2, background: lane.type === 1 ? 'var(--ed-track-alt)' : 'var(--ed-track)', borderRight: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: '2px', padding: '0 6px' }}>
            <b class="ellipsis" style="font-size:var(--fs-sm);flex:1">${lane.tr.name}</b>
            <button class="btn ghost sm icon" title=${lane.type === 1 ? (lane.tr.muted ? 'Unmute' : 'Mute') : lane.tr.muted ? 'Show track' : 'Hide track'} onClick=${() => { sfx('toggle'); toggleTrack(lane, 'muted'); }}><${Icon} name=${lane.type === 1 ? (lane.tr.muted ? 'mute' : 'volume') : lane.tr.muted ? 'eyeOff' : 'eye'} size=${14} /></button>
            <button class="btn ghost sm icon" title=${lane.tr.locked ? 'Unlock' : 'Lock'} onClick=${() => { sfx('toggle'); toggleTrack(lane, 'locked'); }}><${Icon} name=${lane.tr.locked ? 'lock' : 'unlock'} size=${14} /></button>
          </div>
          <div style=${{ position: 'relative', flex: 1, background: lane.tr.locked ? 'repeating-linear-gradient(135deg, transparent 0 6px, var(--surface-3) 6px 7px)' : 'transparent', opacity: lane.tr.muted ? 0.5 : 1 }} onDragOver=${(e) => e.preventDefault()} onDrop=${(e) => onDropMedia(e, lane)} onPointerDown=${startBox}>
            ${lane.tr.clips.map((c) => { const v = view(c); const isSel = sel.includes(c.id); const colors = c.type === 1 ? ['--clip-a', '--clip-a-line'] : c.type === 3 ? ['--clip-t', '--clip-t-line'] : ['--clip-v', '--clip-v-line'];
              return html`<div key=${c.id} data-clip=${c.id} title=${clipLabel(c)} onContextMenu=${(e) => onClipMenu(e, c)} onDblClick=${() => { if (c.type === 3) onEditTitle(c.id); }} onPointerDown=${(e) => { if (e.button === 2) return; onClipDown(e, c, lane); }} style=${{ position: 'absolute', left: xOf(v.start) + 'px', width: Math.max(4, xOf(v.duration) - 1) + 'px', top: 3 + v.dy + 'px', bottom: 3 - v.dy + 'px', borderRadius: '6px', background: `var(${colors[0]})`, border: `1.5px solid ${isSel ? 'var(--ink)' : `var(${colors[1]})`}`, cursor: tool === 'razor' ? 'crosshair' : 'grab', overflow: 'hidden', zIndex: drag?.group?.includes(c.id) ? 5 : 1, boxShadow: isSel ? '0 0 0 2px var(--focus)' : 'none', opacity: c.enabled === false ? 0.45 : 1 }}>
                ${c.type === 0 && media[c.mediaId] && xOf(v.duration) > 50 ? html`<div style=${{ position: 'absolute', inset: 0, backgroundImage: `url(${api.url(`/api/media/thumb?path=${encodeURIComponent(media[c.mediaId].path)}&t=${Math.round(c.in || 0) + 1}`)})`, backgroundSize: 'auto 100%', backgroundRepeat: 'repeat-x', opacity: 0.45 }} />` : null}
                <div class="ellipsis" style="position:relative;font-size:11px;font-weight:600;padding:3px 7px;color:var(--ink)">${clipLabel(c)}${c.effects?.length ? ' ·fx' : ''}${(c.speed || 1) !== 1 ? ` · ${Math.round((c.speed || 1) * 100)}%` : ''}</div>
                ${keyTimesOf(c).map((kt) => html`<span title=${`Keyframe at ${kt.toFixed(2)}s`} style=${{ position: 'absolute', left: Math.max(0, xOf(kt) - 4) + 'px', bottom: '3px', width: '7px', height: '7px', background: 'var(--gold)', border: '1px solid var(--gold-ink)', transform: 'rotate(45deg)', pointerEvents: 'none' }} />`)}
                ${c.transIn?.type ? html`<div style=${{ position: 'absolute', left: 0, top: 0, bottom: 0, width: xOf(c.transIn.duration) + 'px', background: 'linear-gradient(90deg, rgba(0,0,0,0.25), transparent)' }} />` : null}
                ${c.transOut?.type ? html`<div style=${{ position: 'absolute', right: 0, top: 0, bottom: 0, width: xOf(c.transOut.duration) + 'px', background: 'linear-gradient(270deg, rgba(0,0,0,0.25), transparent)' }} />` : null}
              </div>`; })}
          </div></div>`)}
        <div style=${{ position: 'absolute', top: 0, bottom: 0, left: HEAD_W + xOf(t) + 'px', width: '2px', background: 'var(--playhead)', zIndex: 6, pointerEvents: 'none' }}><div style="position:absolute;top:0;left:-5px;width:12px;height:12px;border-radius:3px;background:var(--playhead)" /></div>
      </div>
    </div></div>`;
}
