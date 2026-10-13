'use strict';
/**
 * Studio editing operations: the one vocabulary people's AI agents (and the AI edit box in
 * Studio) use to change a project. Every operation is validated, applied to the same Velo-format
 * project data the editor uses, logged, and undoable (the previous version is kept).
 *
 *   apply(data, ops)        → { data, done: [plain-English lines], errors: [...] }
 *   summarize(project)      → a compact description of the timeline for an AI to read
 *   aiEdit({ project, instruction, ... }) → asks the connected AI for operations and applies them
 */
const ctx = require('../core/ctx');
const audit = require('../core/audit');
const events = require('../core/events');

const clone = (o) => JSON.parse(JSON.stringify(o));
const anim = (v) => ({ base: v });
const qt = (t) => Math.round(t * 1000) / 1000;
const r2 = (n) => Math.round(n * 100) / 100;
const base = (p, d = 0) => (p && typeof p === 'object' ? (p.base ?? d) : (p ?? d));

const EFFECTS = {
  gaussian_blur: { name: 'Gaussian Blur', params: { radius: [0, 200, 10] } },
  color_correction: { name: 'Color Correction', params: { brightness: [-100, 100, 0], contrast: [-100, 100, 0], saturation: [0, 200, 100], temperature: [-100, 100, 0] } },
  color_grade: { name: 'Color Grade', params: { exposure: [-4, 4, 0], contrast: [-100, 100, 0], highlights: [-100, 100, 0], shadows: [-100, 100, 0], temperature: [-100, 100, 0], tint: [-100, 100, 0], hue: [-180, 180, 0], saturation: [0, 200, 100], vibrance: [-100, 100, 0] } },
  sharpen: { name: 'Sharpen', params: { amount: [0, 300, 50] } },
  black_white: { name: 'Black & White', params: { mix: [0, 100, 100] } },
  crop: { name: 'Crop', params: { left: [0, 100, 0], right: [0, 100, 0], top: [0, 100, 0], bottom: [0, 100, 0] } },
  vignette: { name: 'Vignette', params: { amount: [0, 100, 40] } },
  flip: { name: 'Flip', params: { horizontal: [0, 1, 1], vertical: [0, 1, 0] } },
};
const TRANSITIONS = {
  'cross dissolve': 1, fade: 2, 'dip to black': 3, 'dip to white': 4, 'dither dissolve': 5, 'fade through gray': 6, 'blur dissolve': 7, pixelate: 8,
  'wipe left': 10, 'wipe right': 11, 'wipe up': 12, 'wipe down': 13, 'soft wipe left': 14, 'soft wipe right': 15, 'soft wipe up': 16, 'soft wipe down': 17,
  'corner wipe': 18, diagonal: 22, 'clock wipe': 26, 'slats left': 27, 'slats right': 28, 'slats up': 29, 'slats down': 30,
  'iris round': 31, 'iris round close': 32, 'split open': 33, 'split close': 34, 'barn doors open': 35, 'barn doors close': 36,
  'push left': 40, 'push right': 41, 'push up': 42, 'push down': 43, 'slide left': 44, 'slide right': 45, 'slide up': 46, 'slide down': 47, 'squeeze horizontal': 48, 'squeeze vertical': 49,
};
const TITLE_PRESETS = {
  hook: { family: 'Anton', pixelSize: 150, bold: true, uppercase: true, color: '#ffffffff', outlineColor: '#ff000000', outlineWidth: 8, animIn: 'pop', pos: -0.32 },
  title: { family: 'Montserrat', pixelSize: 96, bold: true, color: '#ffffffff', outlineColor: '#ff111111', outlineWidth: 4, shadow: 4, animIn: 'fade', pos: 0 },
  'lower third': { family: 'Montserrat', pixelSize: 54, bold: true, color: '#ffffffff', outlineWidth: 0, box: true, boxColor: '#e6111a22', boxPad: 22, animIn: 'slide', pos: 0.26 },
  caption: { family: 'Montserrat', pixelSize: 64, bold: true, uppercase: true, color: '#ffffffff', outlineColor: '#ff000000', outlineWidth: 6, animIn: 'none', pos: 0.36 },
  subscribe: { family: 'Montserrat', pixelSize: 58, bold: true, uppercase: true, color: '#ff111111', outlineWidth: 0, box: true, boxColor: '#ffffd23f', boxPad: 24, animIn: 'pop', pos: 0.36 },
  quote: { family: 'Georgia', pixelSize: 68, bold: false, italic: true, color: '#ffffffff', outlineWidth: 0, shadow: 6, animIn: 'fade', pos: 0 },
};
const POS = { top: -0.32, center: 0, centre: 0, middle: 0, lower: 0.26, 'lower third': 0.26, bottom: 0.36 };
/** Settings an operation can change, with the units the AI works in. */
const PROPS = {
  scale: { keys: ['scaleX', 'scaleY'], mul: 0.01, d: 1, unit: '%' }, positionx: { keys: ['posX'], mul: 1, d: 0, unit: 'px' }, positiony: { keys: ['posY'], mul: 1, d: 0, unit: 'px' },
  rotation: { keys: ['rotation'], mul: 1, d: 0, unit: '°' }, opacity: { keys: ['opacity'], mul: 0.01, d: 1, unit: '%' }, volume: { keys: ['volume'], mul: 0.01, d: 1, unit: '%' },
};
const propOf = (name) => PROPS[String(name || '').toLowerCase().replace(/[\s_-]/g, '')] || null;

function seqOf(data) { return data.sequences.find((s) => s.id === data.activeSequence) || data.sequences[0]; }
function nextId(data) { const n = Number(data.nextClipId || 1); data.nextClipId = String(n + 1); return String(n); }
function allClips(s) { return [...s.videoTracks.map((tr, i) => ({ tr, kind: 'v', i })), ...s.audioTracks.map((tr, i) => ({ tr, kind: 'a', i }))].flatMap((x) => x.tr.clips.map((c) => ({ ...x, c }))); }
const trackName = (kind, i) => `${kind === 'v' ? 'V' : 'A'}${i + 1}`;
function findClip(s, ref) {
  if (ref == null) throw new Error('Which clip? Give its id (like "c12") or its name.');
  const id = String(ref).replace(/^c(?=\d)/, '');
  const all = allClips(s);
  return all.find((x) => x.c.id === id) || all.find((x) => (x.c.name || x.c.text?.text || '').toLowerCase() === String(ref).toLowerCase())
    || all.find((x) => (x.c.name || x.c.text?.text || '').toLowerCase().includes(String(ref).toLowerCase())) || (() => { throw new Error(`No clip called "${ref}".`); })();
}
function trackRef(s, name, fallbackKind = 'v') {
  const m = /^([VA])(\d+)$/i.exec(String(name || '').trim());
  const kind = m ? (m[1].toUpperCase() === 'V' ? 'v' : 'a') : fallbackKind;
  const list = kind === 'v' ? s.videoTracks : s.audioTracks;
  let i = m ? Number(m[2]) - 1 : 0;
  while (list.length <= i) list.push({ type: kind === 'v' ? 0 : 1, name: trackName(kind, list.length), muted: false, locked: false, volume: { base: 1 }, clips: [] });
  return { kind, i: Math.max(0, i), list };
}
const linked = (s, c) => (c.linkId && c.linkId !== '0' ? allClips(s).filter((x) => x.c.linkId === c.linkId) : allClips(s).filter((x) => x.c.id === c.id));

// ---- placement: same rules as the editor (push what's underneath down a layer; 'up'; or 'replace')
function overwrite(track, c) {
  const st = c.start, en = c.start + c.duration; const out = [];
  for (const x of track.clips) {
    if (x.id === c.id) continue; const xe = x.start + x.duration;
    if (xe <= st + 1e-6 || x.start >= en - 1e-6) { out.push(x); continue; }
    if (x.start < st - 1e-6) { out.push({ ...x, duration: st - x.start }); if (xe > en + 1e-6) out.push({ ...clone(x), id: x.id + 'r' + Math.round(en * 1000), start: en, duration: xe - en, in: (x.in || 0) + (en - x.start) * (x.speed || 1) }); }
    else if (xe > en + 1e-6) out.push({ ...x, start: en, duration: xe - en, in: (x.in || 0) + (en - x.start) * (x.speed || 1) });
  }
  out.push(c); out.sort((a, b) => a.start - b.start); track.clips = out.filter((x) => x.duration > 0.01);
}
function place(s, kind, ti, c, mode = 'down') {
  const list = kind === 'v' ? s.videoTracks : s.audioTracks; ti = Math.max(0, Math.min(list.length - 1, ti));
  if (mode === 'replace') return overwrite(list[ti], c);
  const tr = list[ti];
  const hit = tr.clips.filter((x) => x.id !== c.id && x.start < c.start + c.duration - 1e-6 && x.start + x.duration > c.start + 1e-6);
  tr.clips = [...tr.clips.filter((x) => !hit.includes(x) && x.id !== c.id), c].sort((a, b) => a.start - b.start);
  for (const x of hit) {
    const step = (kind === 'v') === (mode === 'down') ? -1 : 1; let nt = list.indexOf(tr) + step;
    if (nt < 0 || nt >= list.length) { const fresh = { type: kind === 'v' ? 0 : 1, name: '', muted: false, locked: false, volume: { base: 1 }, clips: [] }; if (nt < 0) { list.unshift(fresh); nt = 0; } else { list.push(fresh); nt = list.length - 1; } list.forEach((t, i) => { if (!t.name || /^[VA]\d+$/.test(t.name)) t.name = trackName(kind, i); }); }
    place(s, kind, nt, x, mode);
  }
}
function animParams(c) { const out = ['posX', 'posY', 'scaleX', 'scaleY', 'rotation', 'opacity', 'volume'].filter((k) => c[k] && typeof c[k] === 'object').map((k) => [c, k]); for (const e of c.effects || []) for (const k of Object.keys(e.params || {})) out.push([e.params, k]); return out; }
function shiftKeys(c, dt) { for (const [o, k] of animParams(c)) if (o[k]?.keys?.length) o[k] = { ...o[k], keys: o[k].keys.map(([t, v]) => [qt(t + dt), v]) }; }
const num = (v, name) => { const n = Number(v); if (!Number.isFinite(n)) throw new Error(`${name} must be a number.`); return n; };

/** Apply a list of operations. Stops nothing on a bad op: it's skipped and reported. */
function apply(dataIn, ops, { mediaLookup } = {}) {
  const data = clone(dataIn); const s = seqOf(data); const done = []; const errors = []; let exportRequested = false;
  const media = (ref) => {
    const list = data.media || []; const r = String(ref || '').toLowerCase();
    const m = list.find((x) => x.id === ref) || list.find((x) => x.name.toLowerCase() === r) || list.find((x) => x.name.toLowerCase().includes(r));
    if (!m) throw new Error(`"${ref}" isn't in this project's media. Available: ${list.map((x) => x.name).join(', ') || 'none'}.`);
    return m;
  };
  for (const [n, raw] of (Array.isArray(ops) ? ops : []).slice(0, 200).entries()) {
    const o = raw || {};
    try {
      switch (String(o.op || '').toLowerCase()) {
        case 'add_clip': {
          const m = media(o.media); const at = Math.max(0, num(o.at ?? 0, 'at'));
          const inn = Math.max(0, Number(o.in ?? 0) || 0); const len = Math.max(0.1, Number(o.duration) || (m.kind >= 2 ? 5 : Math.max(0.1, (m.duration || 5) - inn)));
          const { kind, i } = trackRef(s, o.track, m.kind === 1 ? 'a' : 'v');
          const fit = m.width ? Math.max(s.width / m.width, s.height / m.height) : 1;
          const link = m.hasVideo && m.hasAudio && m.kind === 0 ? nextId(data) : '0';
          const mk = (type) => ({ id: nextId(data), type, mediaId: m.id, name: m.name, start: at, duration: len, in: inn, speed: 1, preservePitch: false, linkId: link, enabled: true, posX: anim(0), posY: anim(0), scaleX: anim(type === 1 ? 1 : fit), scaleY: anim(type === 1 ? 1 : fit), rotation: anim(0), opacity: anim(1), volume: anim(1), uniformScale: true, effects: [], transIn: { type: 0, duration: 1 }, transOut: { type: 0, duration: 1 } });
          const mode = o.push === 'up' ? 'up' : o.push === 'replace' ? 'replace' : 'down';
          if (m.kind !== 1) place(s, 'v', kind === 'v' ? i : 0, mk(m.kind >= 2 ? 2 : 0), mode);
          if (m.hasAudio && m.kind !== 2) place(s, 'a', kind === 'a' ? i : 0, mk(1), mode);
          done.push(`Added ${m.name} at ${r2(at)}s (${r2(len)}s long)`); break;
        }
        case 'add_title': {
          const pr = TITLE_PRESETS[String(o.preset || 'title').toLowerCase()] || TITLE_PRESETS.title;
          const { pos, ...look } = pr; const st = { ...look, ...(o.style || {}), text: String(o.text || 'TITLE').slice(0, 300) };
          const at = Math.max(0, num(o.at ?? 0, 'at')); const len = Math.max(0.2, Number(o.duration) || 3);
          const y = o.position != null ? (typeof o.position === 'number' ? o.position : Math.round(s.height * (POS[String(o.position).toLowerCase()] ?? 0))) : Math.round(s.height * pos);
          const fade = st.animIn === 'fade' ? 0.3 : 0;
          const c = { id: nextId(data), type: 3, mediaId: '', name: st.text.slice(0, 40), start: at, duration: len, in: 0, speed: 1, preservePitch: false, linkId: '0', enabled: true, posX: anim(0), posY: anim(y), scaleX: anim(1), scaleY: anim(1), rotation: anim(0), opacity: anim(1), volume: anim(1), uniformScale: true, effects: [], transIn: { type: fade ? 2 : 0, duration: fade || 0.25 }, transOut: { type: fade ? 2 : 0, duration: fade || 0.25 }, text: st };
          const { i } = trackRef(s, o.track || `V${s.videoTracks.length}`, 'v');
          place(s, 'v', i, c); done.push(`Added title "${st.text}" at ${r2(at)}s`); break;
        }
        case 'edit_title': {
          const { c } = findClip(s, o.clip); if (c.type !== 3) throw new Error(`${c.name} isn't a title.`);
          if (o.text != null) { c.text.text = String(o.text).slice(0, 300); c.name = c.text.text.slice(0, 40); }
          if (o.preset) { const pr = TITLE_PRESETS[String(o.preset).toLowerCase()]; if (pr) { const { pos, ...look } = pr; Object.assign(c.text, look); } }
          if (o.style) Object.assign(c.text, o.style);
          if (o.position != null) c.posY = anim(typeof o.position === 'number' ? o.position : Math.round(s.height * (POS[String(o.position).toLowerCase()] ?? 0)));
          done.push(`Updated title "${c.text.text}"`); break;
        }
        case 'move': {
          const { c, kind, i } = findClip(s, o.clip); const dt = o.at != null ? Math.max(0, num(o.at, 'at')) - c.start : 0;
          for (const x of linked(s, c)) {
            const target = x.c.id === c.id && o.track ? trackRef(s, o.track, kind) : { kind: x.kind, i: x.i };
            x.tr.clips = x.tr.clips.filter((y) => y.id !== x.c.id); x.c.start = Math.max(0, qt(x.c.start + dt));
            place(s, x.kind, target.kind === x.kind ? target.i : x.i, x.c, o.push === 'up' ? 'up' : o.push === 'replace' ? 'replace' : 'down');
          }
          done.push(`Moved ${c.name} to ${r2(c.start)}s${o.track ? ` on ${o.track}` : ''}`); void i; break;
        }
        case 'trim': {
          const { c } = findClip(s, o.clip);
          for (const x of linked(s, c)) {
            const cc = x.c;
            if (o.start != null) { const ns = Math.max(0, num(o.start, 'start')); const d = ns - cc.start; if (d >= cc.duration - 0.05) throw new Error('That would remove the whole clip.'); cc.start = qt(ns); cc.duration = qt(cc.duration - d); cc.in = Math.max(0, (cc.in || 0) + d * (cc.speed || 1)); shiftKeys(cc, -d); }
            if (o.end != null) { const ne = num(o.end, 'end'); if (ne <= cc.start + 0.05) throw new Error('End must be after the start.'); cc.duration = qt(ne - cc.start); }
          }
          done.push(`Trimmed ${c.name} to ${r2(c.start)}–${r2(c.start + c.duration)}s`); break;
        }
        case 'split': {
          const at = num(o.at, 'at'); const targets = o.clip ? linked(s, findClip(s, o.clip).c) : allClips(s).filter((x) => !x.tr.locked && at > x.c.start + 0.03 && at < x.c.start + x.c.duration - 0.03);
          const links = {}; let k = 0;
          for (const x of targets) {
            const c = x.c; if (!(at > c.start + 0.03 && at < c.start + c.duration - 0.03)) continue;
            const right = clone(c); right.id = nextId(data); const off = at - c.start;
            right.start = qt(at); right.duration = qt(c.duration - off); right.in = (c.in || 0) + off * (c.speed || 1); right.transIn = { type: 0, duration: 1 }; shiftKeys(right, -off);
            c.duration = qt(off); c.transOut = { type: 0, duration: 1 };
            if (c.linkId && c.linkId !== '0') { links[c.linkId] = links[c.linkId] || nextId(data); right.linkId = links[c.linkId]; }
            x.tr.clips.push(right); x.tr.clips.sort((a, b) => a.start - b.start); k++;
          }
          done.push(`Split ${k} clip${k === 1 ? '' : 's'} at ${r2(at)}s`); break;
        }
        case 'delete': {
          const { c } = findClip(s, o.clip); const g = linked(s, c);
          for (const x of g) { x.tr.clips = x.tr.clips.filter((y) => y.id !== x.c.id); if (o.ripple) for (const y of x.tr.clips) if (y.start >= x.c.start + x.c.duration - 1e-6) y.start = qt(y.start - x.c.duration); }
          done.push(`${o.ripple ? 'Ripple-deleted' : 'Deleted'} ${c.name}`); break;
        }
        case 'set': {
          const { c } = findClip(s, o.clip); const name = String(o.prop || '').toLowerCase();
          if (name === 'speed') { const v = num(o.value, 'speed') / 100; if (v < 0.1 || v > 10) throw new Error('Speed must be 10–1000%.'); for (const x of linked(s, c)) { const old = x.c.speed || 1; x.c.speed = v; x.c.duration = qt((x.c.duration * old) / v); } done.push(`Set ${c.name} speed to ${o.value}%`); break; }
          if (name === 'enabled') { for (const x of linked(s, c)) x.c.enabled = !!o.value; done.push(`${o.value ? 'Enabled' : 'Disabled'} ${c.name}`); break; }
          if (name === 'name') { c.name = String(o.value).slice(0, 80); done.push(`Renamed to ${c.name}`); break; }
          const p = propOf(name); if (!p) throw new Error(`"${o.prop}" isn't a setting (use scale, positionX, positionY, rotation, opacity, volume, speed, enabled or name).`);
          for (const k of p.keys) c[k] = anim(num(o.value, o.prop) * p.mul);
          done.push(`Set ${c.name} ${o.prop} to ${o.value}${p.unit}`); break;
        }
        case 'keyframes': {
          const { c } = findClip(s, o.clip); const p = propOf(o.prop); if (!p) throw new Error(`"${o.prop}" can't be animated (use scale, positionX, positionY, rotation, opacity or volume).`);
          const keys = (o.keys || []).map((k) => (Array.isArray(k) ? k : [k.time ?? k.t, k.value ?? k.v])).map(([t, v]) => [qt(Math.max(0, Math.min(c.duration, num(t, 'time')))), num(v, 'value') * p.mul]).sort((a, b) => a[0] - b[0]);
          if (!keys.length) { for (const k of p.keys) c[k] = anim(base(c[k], p.d)); done.push(`Removed ${o.prop} animation from ${c.name}`); break; }
          for (const k of p.keys) c[k] = { base: keys[0][1], keys: clone(keys) };
          done.push(`Animated ${c.name} ${o.prop}: ${keys.map(([t, v]) => `${r2(v / p.mul)}${p.unit} at ${r2(t)}s`).join(' → ')}`); break;
        }
        case 'transition': {
          const { c } = findClip(s, o.clip); const name = String(o.type || 'cross dissolve').toLowerCase();
          const type = name === 'none' ? 0 : TRANSITIONS[name]; if (type == null) throw new Error(`Unknown transition "${o.type}". Options: ${Object.keys(TRANSITIONS).join(', ')}.`);
          const d = Math.max(0.04, Number(o.duration) || 0.5); const edges = o.edge === 'in' ? ['transIn'] : o.edge === 'out' ? ['transOut'] : ['transIn', 'transOut'];
          for (const x of linked(s, c)) for (const e of edges) x.c[e] = { type, duration: Math.min(d, x.c.duration / 2) };
          done.push(`${type ? `Added ${o.type}` : 'Removed transition'} on ${c.name} (${edges.map((e) => e.replace('trans', '').toLowerCase()).join(' + ')})`); break;
        }
        case 'effect': {
          const { c } = findClip(s, o.clip); const key = Object.keys(EFFECTS).find((k) => k === o.effect || EFFECTS[k].name.toLowerCase() === String(o.effect || '').toLowerCase());
          if (!key) throw new Error(`Unknown effect "${o.effect}". Options: ${Object.values(EFFECTS).map((e) => e.name).join(', ')}.`);
          const def = EFFECTS[key]; const params = {};
          for (const [k, [mn, mx, d]] of Object.entries(def.params)) params[k] = anim(Math.min(mx, Math.max(mn, o.params?.[k] != null ? num(o.params[k], k) : d)));
          c.effects = [...(c.effects || []).filter((e) => e.effectId !== key), { effectId: key, enabled: true, params }];
          done.push(`Applied ${def.name} to ${c.name}`); break;
        }
        case 'remove_effects': { const { c } = findClip(s, o.clip); c.effects = []; done.push(`Removed effects from ${c.name}`); break; }
        case 'export': exportRequested = true; done.push('Export requested'); break;
        default: throw new Error(`Unknown operation "${o.op}".`);
      }
    } catch (e) { errors.push(`Step ${n + 1} (${o.op || '?'}): ${e.message}`); }
  }
  void mediaLookup;
  return { data, done, errors, exportRequested };
}

/** The timeline in a form an AI can read and refer to. Clip ids are written as c<id>. */
function summarize(project) {
  const data = project.data; const s = seqOf(data);
  const fmt = (c) => {
    const bits = [`c${c.id}`, c.type === 3 ? `title "${c.text?.text || ''}"` : `${['video', 'audio', 'image'][c.type] || 'clip'} "${c.name}"`, `${r2(c.start)}–${r2(c.start + c.duration)}s`];
    if (c.type !== 3 && c.type !== 2) bits.push(`source ${r2(c.in || 0)}s+`);
    if ((c.speed || 1) !== 1) bits.push(`speed ${Math.round(c.speed * 100)}%`);
    for (const [k, label, mul] of [['scaleX', 'scale', 100], ['posX', 'x', 1], ['posY', 'y', 1], ['rotation', 'rotation', 1], ['opacity', 'opacity', 100], ['volume', 'volume', 100]]) {
      const p = c[k]; if (!p) continue;
      if (p.keys?.length) bits.push(`${label} keyframes ${p.keys.map(([t, v]) => `${r2(v * mul)}@${r2(t)}s`).join(',')}`);
      else if ((k === 'scaleX' && c.type !== 1) || (['posX', 'posY', 'rotation'].includes(k) && base(p) !== 0) || (['opacity', 'volume'].includes(k) && base(p, 1) !== 1)) bits.push(`${label} ${r2(base(p) * mul)}`);
    }
    if (c.transIn?.type) bits.push(`in-transition ${c.transIn.type}`); if (c.transOut?.type) bits.push(`out-transition ${c.transOut.type}`);
    if (c.effects?.length) bits.push(`effects ${c.effects.map((e) => e.effectId).join(',')}`);
    if (c.enabled === false) bits.push('disabled');
    if (c.linkId && c.linkId !== '0') bits.push(`linked ${c.linkId}`);
    return bits.join(' · ');
  };
  const end = Math.max(0, ...allClips(s).map((x) => x.c.start + x.c.duration));
  return [
    `Project "${project.name || 'Untitled edit'}" · ${s.width}×${s.height} · ${s.fps} fps · ${r2(end)}s long`,
    `Media in the project: ${(data.media || []).map((m) => `"${m.name}" (${m.kind === 1 ? 'audio' : m.kind >= 2 ? 'image' : 'video'}${m.duration ? `, ${r2(m.duration)}s` : ''}${m.width ? `, ${m.width}×${m.height}` : ''})`).join('; ') || 'none'}`,
    'Tracks (V1 is the bottom video layer; higher V tracks draw on top):',
    ...[...s.videoTracks.map((tr, i) => ['v', tr, i]).reverse(), ...s.audioTracks.map((tr, i) => ['a', tr, i])].map(([k, tr, i]) => `  ${trackName(k, i)}${tr.muted ? ' (hidden)' : ''}${tr.locked ? ' (locked)' : ''}: ${tr.clips.length ? tr.clips.map(fmt).join(' | ') : 'empty'}`),
  ].join('\n');
}

const OPS_DOC = `Respond with JSON {"ops":[...], "say":"one short sentence for the editor"}. Operations (times in seconds; clip = id like "c12" or the clip's name):
- {"op":"add_clip","media":"<name>","at":0,"track":"V1","in":0,"duration":5,"push":"down|up|replace"}
- {"op":"add_title","text":"...","at":0,"duration":3,"preset":"hook|title|lower third|caption|subscribe|quote","position":"top|center|lower|bottom","style":{"color":"#ffffffff","pixelSize":96,"uppercase":true,"box":true,"boxColor":"#e6000000","animIn":"none|fade|pop|slide"}}
- {"op":"edit_title","clip":"c5","text":"...","preset":"...","style":{...},"position":"..."}
- {"op":"move","clip":"c3","at":2.5,"track":"V2"}   {"op":"trim","clip":"c3","start":1,"end":4}   {"op":"split","at":3,"clip":"c3"}
- {"op":"delete","clip":"c3","ripple":true}
- {"op":"set","clip":"c3","prop":"scale|positionX|positionY|rotation|opacity|volume|speed|enabled|name","value":120}   (scale/opacity/volume/speed in %, positions in px from centre)
- {"op":"keyframes","clip":"c3","prop":"scale|positionX|positionY|rotation|opacity|volume","keys":[[0,100],[2,130]]}   (times are seconds from the clip's start; [] removes the animation)
- {"op":"transition","clip":"c3","edge":"in|out|both","type":"cross dissolve|dip to black|dip to white|wipe left|iris round|push left|slide up|clock wipe|pixelate|...","duration":0.5}
- {"op":"effect","clip":"c3","effect":"Color Grade|Color Correction|Gaussian Blur|Sharpen|Black & White|Crop|Vignette|Flip","params":{"saturation":120}}   {"op":"remove_effects","clip":"c3"}
- {"op":"export"}
Placing a clip on top of another pushes the existing one down a layer unless "push" says otherwise. Use the fewest operations that do what was asked. Never invent media that isn't listed.`;

/**
 * Ask the connected AI to turn an instruction into operations, apply them, save, and tell open editors.
 * The previous version is kept on the project so the change can be undone.
 */
async function aiEdit({ project, instruction, actor = 'system', agent = null, provider }) {
  const ai = require('../integrations/ai');
  const r = await ai.ask({
    role: 'analysis', json: true, maxTokens: 2500, clientId: project.clientId || null, provider,
    system: `You are the editor's assistant inside Euclidean Studio, a vertical-video (shorts) editor. You edit by returning operations.\n${OPS_DOC}`,
    prompt: `${summarize(project)}\n\nInstruction: ${instruction}`,
  });
  const ops = Array.isArray(r.json?.ops) ? r.json.ops : [];
  const res = commit(project, ops, { actor, via: agent ? `agent:${agent}` : `ai:${r.provider}`, instruction });
  return { ...res, say: String(r.json?.say || '').slice(0, 300), provider: r.provider, ops };
}

/** Apply operations to a stored project, keep an undo copy, log, notify editors, queue export if asked. */
function commit(project, ops, { actor = 'system', via = 'api', instruction = '' } = {}) {
  const res = apply(project.data, ops);
  if (!res.done.length) return { ...res, changed: false };
  const prev = (project.aiHistory || []).slice(-9);
  ctx.store.update('projects', project.id, { data: res.data, aiHistory: [...prev, { at: new Date().toISOString(), via, instruction: instruction.slice(0, 300), done: res.done, before: project.data }] });
  audit.log(via.startsWith('agent:') ? via : actor, 'studio.ai_edit', { projectId: project.id, clientId: project.clientId || null, via, instruction: instruction.slice(0, 200), steps: res.done.length, errors: res.errors.length });
  events.publish('studio.updated', { projectId: project.id, via, done: res.done });
  if (res.exportRequested) require('../jobs/queue').enqueue('studio.export', { projectId: project.id }, { clientId: project.clientId || null, actor, title: `Export ${project.name}` });
  return { ...res, changed: true };
}

/** Put back the version from before the last AI/agent edit. */
function undo(project, actor) {
  const h = project.aiHistory || []; const last = h[h.length - 1];
  if (!last) throw new Error('There is no AI edit to undo.');
  ctx.store.update('projects', project.id, { data: last.before, aiHistory: h.slice(0, -1) });
  audit.log(actor, 'studio.ai_edit_undone', { projectId: project.id });
  events.publish('studio.updated', { projectId: project.id, via: 'undo', done: [`Undid: ${last.done.join('; ')}`] });
  return { undone: last.done };
}

module.exports = { apply, summarize, aiEdit, commit, undo, OPS_DOC, EFFECTS, TRANSITIONS };
