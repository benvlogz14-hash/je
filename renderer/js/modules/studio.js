// Studio: Euclidean's built-in editor. Same project model as Velo (projects open in either),
// Premiere-style layout: project bin + effects, program monitor, effect controls, multi-track timeline.
import { html, useState, useEffect, useRef, useMemo, useCallback, useStore, useApi, navigate, Button, Seg, Toggle, Empty, Loading, Modal, Field, act, toast, openMenu, confirmDialog, promptDialog } from '../lib/ui.js';
import { api } from '../lib/api.js';
import { Icon } from '../lib/icons.js';
import { play as sfx } from '../lib/sound.js';
import { tc, ago, dur } from '../lib/format.js';

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
const TRANSITIONS = [{ type: 1, name: 'Cross Dissolve' }, { type: 2, name: 'Fade' }, { type: 3, name: 'Dip to Black' }];
const PRESETS = [{ label: 'Shorts / Reels / TikTok', w: 1080, h: 1920 }, { label: 'YouTube 1080p', w: 1920, h: 1080 }, { label: 'Instagram square', w: 1080, h: 1080 }, { label: 'YouTube 4K', w: 3840, h: 2160 }];

const base = (p, d = 0) => (p && typeof p === 'object' ? (p.base ?? d) : (p ?? d));
const anim = (v) => ({ base: v });
const clone = (o) => JSON.parse(JSON.stringify(o));
const TRACK_H = { 0: 48, 1: 40 };
// Live scrubbing mutates the clip in place for instant preview; the original value is restored
// right before the committing edit() so undo snapshots stay correct.
const live = new Map();
const redraw = () => window.dispatchEvent(new Event('studio-redraw'));
function liveSet(obj, key, val, id) { if (!live.has(id)) live.set(id, { obj, key, orig: clone(obj[key]) }); obj[key] = val; redraw(); }
function revertLive() { for (const { obj, key, orig } of live.values()) obj[key] = orig; live.clear(); }
const HEAD_W = 132;

export function Studio() {
  const route = useStore((s) => s.route);
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
      <div class="grid c3">${data.map((p) => html`<div class="panel pad" style="cursor:pointer" onClick=${() => { sfx('open'); navigate(`/studio/${p.id}`); }} onContextMenu=${(e) => openMenu(e, [{ label: 'Delete project', icon: 'trash', danger: true, onClick: async () => { if (await confirmDialog({ title: 'Delete project?', text: `"${p.name}" will be removed. Media files are not deleted.`, confirm: 'Delete' })) act(() => api.del(`/api/projects/${p.id}`), { ok: 'Deleted' }).then(reload); } }])}>
        <div class="row"><div class="avatar" style="background:var(--slate-soft);color:var(--slate-ink)"><${Icon} name="studio" size=${17} /></div><div class="grow" style="min-width:0"><b class="ellipsis" style="display:block">${p.name}</b><div class="faint" style="font-size:var(--fs-sm)">${p.media} media · edited ${ago(p.updatedAt)}</div></div></div>
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
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [tool, setTool] = useState('select');
  const [snap, setSnap] = useState(true);
  const [zoom, setZoom] = useState(60); // px per second
  const [dirty, setDirty] = useState(false);
  const [leftTab, setLeftTab] = useState('media');
  const undo = useRef([]); const redo = useRef([]);
  const saveTimer = useRef(null);

  useEffect(() => { api.get(`/api/projects/${id}`).then((p) => { setProj(p); setDataRaw(p.data); }).catch((e) => toast(e.message, { kind: 'error' })); }, [id]);
  const seq = data ? (data.sequences.find((s) => s.id === data.activeSequence) || data.sequences[0]) : null;
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

  const nextId = (d) => { const n = Number(d.nextClipId || 1); d.nextClipId = String(n + 1); return String(n); };
  const findClip = (s, cid) => { for (const tr of [...s.videoTracks, ...s.audioTracks]) { const c = tr.clips.find((x) => x.id === cid); if (c) return { c, tr }; } return null; };
  const linked = (s, c) => (c.linkId && c.linkId !== '0' ? [...s.videoTracks, ...s.audioTracks].flatMap((tr) => tr.clips).filter((x) => x.linkId === c.linkId) : [c]);

  const split = (all) => edit((d, s) => {
    const targets = [];
    for (const tr of [...s.videoTracks, ...s.audioTracks]) { if (tr.locked) continue; for (const c of tr.clips) if (t > c.start + 0.03 && t < c.start + c.duration - 0.03 && (all || sel.includes(c.id) || !sel.length)) targets.push({ c, tr }); }
    const linkMap = {};
    for (const { c, tr } of targets) {
      const right = clone(c); right.id = nextId(d);
      const off = t - c.start; right.start = t; right.duration = c.duration - off; right.in = (c.in || 0) + off * (c.speed || 1); right.transIn = { type: 0, duration: 1 };
      c.duration = off; c.transOut = { type: 0, duration: 1 };
      if (c.linkId && c.linkId !== '0') { linkMap[c.linkId] = linkMap[c.linkId] || nextId(d); right.linkId = linkMap[c.linkId]; }
      tr.clips.push(right); tr.clips.sort((a, b) => a.start - b.start);
    }
    if (targets.length) sfx('press');
  });
  const remove = (ripple) => edit((d, s) => {
    const ids = new Set(sel.flatMap((cid) => { const f = findClip(s, cid); return f ? linked(s, f.c).map((x) => x.id) : []; }));
    for (const tr of [...s.videoTracks, ...s.audioTracks]) {
      const gone = tr.clips.filter((c) => ids.has(c.id));
      tr.clips = tr.clips.filter((c) => !ids.has(c.id));
      if (ripple) for (const g of gone) for (const c of tr.clips) if (c.start >= g.start + g.duration - 1e-6) c.start -= g.duration;
    }
    setSel([]);
  });
  const addMedia = (m, trackIdx = 0, at = null) => edit((d, s) => {
    const isAudio = m.kind === 1; const len = m.kind >= 2 ? 5 : Math.max(0.1, (m.srcOut > 0 ? m.srcOut : m.duration) - (m.srcIn || 0));
    const vt = s.videoTracks[trackIdx] || s.videoTracks[0]; const at_ = at ?? Math.max(0, ...(isAudio ? s.audioTracks[0].clips : vt.clips).map((c) => c.start + c.duration), 0);
    const link = m.hasVideo && m.hasAudio && m.kind === 0 ? nextId(d) : '0';
    const W = s.width, H = s.height; const fit = m.width ? Math.max(W / m.width, H / m.height) : 1;
    const mk = (type) => ({ id: nextId(d), type, mediaId: m.id, name: m.name, start: at_, duration: len, in: m.srcIn || 0, speed: 1, preservePitch: false, linkId: link, enabled: true, posX: anim(0), posY: anim(0), scaleX: anim(type === 1 ? 1 : fit), scaleY: anim(type === 1 ? 1 : fit), rotation: anim(0), opacity: anim(1), volume: anim(1), uniformScale: true, effects: [], transIn: { type: 0, duration: 1 }, transOut: { type: 0, duration: 1 } });
    if (!isAudio) overwrite(vt, mk(m.kind === 2 || m.kind === 3 ? 2 : 0));
    if (m.hasAudio && m.kind !== 2) overwrite(s.audioTracks[0], mk(1));
    sfx('press');
  });
  const addText = () => edit((d, s) => {
    const tr = s.videoTracks[s.videoTracks.length - 1];
    overwrite(tr, { id: nextId(d), type: 3, mediaId: '', name: 'Title', start: t, duration: 3, in: 0, speed: 1, preservePitch: false, linkId: '0', enabled: true, posX: anim(0), posY: anim(Math.round(s.height * 0.3)), scaleX: anim(1), scaleY: anim(1), rotation: anim(0), opacity: anim(1), volume: anim(1), uniformScale: true, effects: [], transIn: { type: 2, duration: 0.25 }, transOut: { type: 2, duration: 0.25 }, text: { text: 'NEW TITLE', family: 'Montserrat', pixelSize: 96, bold: true, italic: false, color: '#ffffffff', outlineColor: '#ff111111', outlineWidth: 4 } });
    sfx('press');
  });

  // keyboard
  useEffect(() => {
    const k = (e) => {
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;
      const mod = e.ctrlKey || e.metaKey; const key = e.key.toLowerCase();
      if (mod && key === 'z' && !e.shiftKey) { e.preventDefault(); doUndo(); }
      else if (mod && (key === 'y' || (key === 'z' && e.shiftKey))) { e.preventDefault(); doRedo(); }
      else if (mod && key === 's') { e.preventDefault(); save(); }
      else if (key === ' ') { e.preventDefault(); setPlaying((p) => !p); }
      else if (key === 'l') setPlaying(true);
      else if (key === 'k') setPlaying(false);
      else if (key === 'j') { setPlaying(false); setT((x) => Math.max(0, x - 1)); }
      else if (key === 's' && !mod) { e.preventDefault(); split(e.shiftKey); }
      else if (key === 'v') setTool('select');
      else if (key === 'c') setTool('razor');
      else if (key === 't' && !mod) addText();
      else if ((key === 'delete' || key === 'backspace') && sel.length) { e.preventDefault(); remove(e.altKey); }
      else if (key === 'arrowleft') { e.preventDefault(); setT((x) => Math.max(0, x - (e.shiftKey ? 1 : 1 / (seq?.fps || 30)))); }
      else if (key === 'arrowright') { e.preventDefault(); setT((x) => x + (e.shiftKey ? 1 : 1 / (seq?.fps || 30))); }
      else if (key === 'home') setT(0);
      else if (key === 'end') setT(duration);
      else if (key === '=' || key === '+') setZoom((z) => Math.min(600, z * 1.25));
      else if (key === '-') setZoom((z) => Math.max(4, z / 1.25));
    };
    window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k);
  }, [sel, t, duration, seq, data]);

  if (!data || !seq) return html`<div class="page"><${Loading} /></div>`;
  const selected = sel.length === 1 ? findClip(seq, sel[0]) : null;

  const exportNow = async () => { await save(true); await act(() => api.post(`/api/projects/${id}/export`), { ok: 'Export started. Track it in the status bar.' }); };
  return html`<div style="position:absolute;inset:0;display:grid;grid-template-columns:minmax(0, 1fr);grid-template-rows:46px minmax(0, 1fr) minmax(210px, 38%);background:var(--ed-bg)">
    <div class="row" style="padding:0 12px;background:var(--surface);border-bottom:1px solid var(--line);gap:10px;min-width:0;overflow-x:auto">
      <${Button} kind="ghost" size="sm" icon="chevronLeft" title="All projects" onClick=${() => { if (dirty) save(true); navigate('/studio'); }} />
      <b class="ellipsis" style="max-width:260px">${proj.name}</b><span class="faint tnum" style="font-size:var(--fs-sm)">${seq.width}×${seq.height} · ${seq.fps} fps</span>
      <span class="faint" style="font-size:var(--fs-xs)">${dirty ? 'Unsaved changes' : 'Saved'}</span>
      <div class="spacer" />
      <div class="btn-group"><button class=${tool === 'select' ? 'on' : ''} title="Selection (V)" onClick=${() => { sfx('tap'); setTool('select'); }}><${Icon} name="pointer" size=${14} /></button><button class=${tool === 'razor' ? 'on' : ''} title="Razor (C)" onClick=${() => { sfx('tap'); setTool('razor'); }}><${Icon} name="scissors" size=${14} /></button><button title="Add title (T)" onClick=${addText}><${Icon} name="type" size=${14} /></button></div>
      <button class=${'chip' + (snap ? ' on' : '')} title="Snapping (hold Alt to bypass)" onClick=${() => { sfx('toggle'); setSnap(!snap); }}><${Icon} name="magnet" size=${13} />Snap</button>
      <${Button} kind="ghost" size="sm" icon="scissors" title="Split at playhead (S, Shift+S for all tracks)" onClick=${() => split(false)} />
      <${Button} kind="ghost" size="sm" icon="undo" title="Undo (Ctrl+Z)" disabled=${!undo.current.length} onClick=${doUndo} />
      <${Button} kind="ghost" size="sm" icon="redo" title="Redo (Ctrl+Shift+Z)" disabled=${!redo.current.length} onClick=${doRedo} />
      <div style="width:1px;height:22px;background:var(--line)" />
      <${Button} kind="ghost" size="sm" icon="external" onClick=${() => act(() => api.post(`/api/projects/${id}/open-velo`), { ok: 'Opening in Velo', sound: 'open' })}>Open in Velo</${Button}>
      <${Button} kind="ghost" size="sm" onClick=${() => save()}>Save</${Button}>
      <${Button} kind="primary" size="sm" icon="upload" onClick=${exportNow}>Export</${Button}>
    </div>
    <div style="display:grid;grid-template-columns:260px minmax(0, 1fr) 300px;min-height:0">
      <${LeftPanel} tab=${leftTab} setTab=${setLeftTab} data=${data} projectId=${id} setData=${setDataRaw} onAdd=${addMedia} selected=${selected} edit=${edit} />
      <${Monitor} seq=${seq} media=${media} t=${t} setT=${setT} playing=${playing} setPlaying=${setPlaying} duration=${duration} selected=${selected} edit=${edit} />
      <${EffectControls} selected=${selected} seq=${seq} edit=${edit} media=${media} />
    </div>
    <${Timeline} seq=${seq} media=${media} t=${t} setT=${setT} sel=${sel} setSel=${setSel} tool=${tool} snap=${snap} zoom=${zoom} setZoom=${setZoom} duration=${duration} edit=${edit} findClip=${findClip} linked=${linked} onAdd=${addMedia} nextId=${nextId} />
  </div>`;
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

// ------------------------------------------------------------ left: project bin + effects
function LeftPanel({ tab, setTab, data, projectId, setData, onAdd, selected, edit }) {
  const fileRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const importFiles = async (files) => {
    setBusy(true);
    try { const added = await api.upload(`/api/projects/${projectId}/media`, files, {}, null); setData((d) => ({ ...d, media: [...d.media, ...added] })); sfx('success'); }
    catch (e) { sfx('error'); toast(e.message, { kind: 'error' }); } finally { setBusy(false); }
  };
  const importDisk = async () => {
    if (!window.euclidean?.pickFiles) return fileRef.current.click();
    const r = await api.post('/api/system/pick', { multi: true });
    if (r.paths?.length) { const added = await act(() => api.post(`/api/projects/${projectId}/media`, { paths: r.paths })); setData((d) => ({ ...d, media: [...d.media, ...added] })); }
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
    <div class="row" style="padding:8px 10px;border-bottom:1px solid var(--line)"><${Seg} value=${tab} onChange=${setTab} options=${[{ value: 'media', label: 'Project' }, { value: 'effects', label: 'Effects' }]} /><div class="spacer" />${tab === 'media' ? html`<${Button} size="sm" kind="soft" icon="plus" busy=${busy} title="Import media" onClick=${importDisk} />` : null}</div>
    <input type="file" ref=${fileRef} multiple accept="video/*,audio/*,image/*" hidden onChange=${(e) => { importFiles([...e.target.files]); e.target.value = ''; }} />
    <div style="flex:1;overflow:auto;padding:8px" onDragOver=${(e) => e.preventDefault()} onDrop=${(e) => { e.preventDefault(); if (e.dataTransfer.files.length) importFiles([...e.dataTransfer.files]); }}>
      ${tab === 'media' ? (data.media.length ? data.media.map((m) => html`
        <div class="review-item" draggable="true" onDragStart=${(e) => e.dataTransfer.setData('text/x-media', m.id)} onDblClick=${() => onAdd(m)} title="Double-click to add at the end of V1, or drag onto a track">
          <div class="th" style=${{ width: '58px', aspectRatio: '16/9', backgroundImage: m.kind !== 1 ? `url(${api.url(`/api/media/thumb?path=${encodeURIComponent(m.path)}&t=1`)})` : 'none', display: 'grid', placeItems: 'center' }}>${m.kind === 1 ? html`<${Icon} name="volume" size=${16} />` : null}</div>
          <div class="grow" style="min-width:0"><div class="ellipsis" style="font-size:var(--fs-sm);font-weight:500">${m.name}</div><div class="faint tnum" style="font-size:var(--fs-xs)">${m.kind >= 2 ? 'Image' : dur(m.duration)}${m.width ? ` · ${m.width}×${m.height}` : ''}</div></div></div>`)
        : html`<div class="empty" style="padding:30px 10px"><p style="font-size:var(--fs-sm)">Import or drop video, audio and images here.</p></div>`)
      : html`${['Blur', 'Color', 'Transform', 'Stylize'].map((cat) => html`<div class="eyebrow" style="padding:8px 6px 4px">${cat}</div>${EFFECTS.filter((f) => f.cat === cat).map((f) => html`<div class="review-item" onDblClick=${() => applyEffect(f)} onClick=${() => applyEffect(f)} title="Apply to the selected clip"><${Icon} name="wand" size=${15} /><span style="font-size:var(--fs-sm)">${f.name}</span></div>`)}`)}
        <div class="eyebrow" style="padding:12px 6px 4px">Transitions</div>${TRANSITIONS.map((tt) => html`<div class="review-item" style="cursor:default"><${Icon} name="layers" size=${15} /><span class="grow" style="font-size:var(--fs-sm)">${tt.name}</span><${Button} size="sm" kind="ghost" onClick=${() => applyTransition(tt, 'transIn')}>In</${Button}><${Button} size="sm" kind="ghost" onClick=${() => applyTransition(tt, 'transOut')}>Out</${Button}></div>`)}`}
    </div></div>`;
}

// ------------------------------------------------------------ program monitor (canvas compositor)
function Monitor({ seq, media, t, setT, playing, setPlaying, duration, selected, edit }) {
  const canvas = useRef(null);
  const els = useRef(new Map());   // clipId -> HTMLVideoElement | HTMLImageElement | HTMLAudioElement
  const clock = useRef({ wall: 0, t0: 0 });
  const tRef = useRef(t); tRef.current = t;
  const [quality, setQuality] = useState(0.5);
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

  const getEl = (c) => {
    let el = els.current.get(c.id); const m = media[c.mediaId]; if (!m) return null;
    if (!el) {
      if (c.type === 2 || m.kind === 2 || m.kind === 3) { el = new Image(); el.src = api.url(`/api/media?path=${encodeURIComponent(m.path)}`); }
      else { el = document.createElement(c.type === 1 ? 'audio' : 'video'); el.preload = 'auto'; el.playsInline = true; el.muted = c.type !== 1; el.src = api.url(`/api/media?path=${encodeURIComponent(m.path)}`); el.addEventListener('seeked', () => draw()); el.addEventListener('loadeddata', () => draw()); }
      els.current.set(c.id, el);
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
      if (c.type === 1) { const tr = a.find((x) => x.c.id === c.id)?.tr; el.volume = Math.min(1, base(c.volume, 1) * base(tr?.volume, 1)); }
      el.playbackRate = Math.min(4, Math.max(0.25, c.speed || 1));
      if (isPlaying) { if (Math.abs(el.currentTime - want) > 0.3) el.currentTime = want; if (el.paused) el.play().catch(() => {}); }
      else { if (!el.paused) el.pause(); if (Math.abs(el.currentTime - want) > 0.02) el.currentTime = want; }
    }
    for (const [cid, el] of els.current) if (!live.has(cid) && el instanceof HTMLMediaElement && !el.paused) el.pause();
    return v;
  };
  const draw = () => {
    const cv = canvas.current; if (!cv) return;
    const W = Math.round(seq.width * quality), H = Math.round(seq.height * quality);
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
    const g = cv.getContext('2d'); g.setTransform(1, 0, 0, 1, 0, 0); g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
    const time = tRef.current; const { v } = activeAt(time);
    for (const { c } of v) {
      const local = time - c.start;
      let alpha = base(c.opacity, 1);
      const ti = c.transIn?.type ? c.transIn.duration : 0, to = c.transOut?.type ? c.transOut.duration : 0;
      if (ti && local < ti) alpha *= local / ti; if (to && local > c.duration - to) alpha *= Math.max(0, (c.duration - local) / to);
      g.save(); g.globalAlpha = Math.max(0, Math.min(1, alpha));
      g.translate(W / 2 + base(c.posX) * quality, H / 2 + base(c.posY) * quality);
      g.rotate((base(c.rotation) * Math.PI) / 180);
      const sx = base(c.scaleX, 1), sy = c.uniformScale === false ? base(c.scaleY, 1) : sx;
      const filters = []; let flipH = 1, flipV = 1, crop = null, vig = 0;
      for (const e of c.effects || []) {
        if (e.enabled === false) continue; const p = Object.fromEntries(Object.entries(e.params || {}).map(([k, x]) => [k, base(x)]));
        if (e.effectId === 'gaussian_blur') filters.push(`blur(${(p.radius / 2) * quality}px)`);
        if (e.effectId === 'color_correction' || e.effectId === 'color_grade') { filters.push(`brightness(${1 + (p.brightness || 0) / 200 + (p.exposure || 0) * 0.25})`, `contrast(${1 + (p.contrast || 0) / 100})`, `saturate(${(p.saturation ?? 100) / 100})`); if (p.hue) filters.push(`hue-rotate(${p.hue}deg)`); if (p.temperature) filters.push(`sepia(${Math.max(0, p.temperature) / 400})`); }
        if (e.effectId === 'black_white') filters.push(`grayscale(${(p.mix ?? 100) / 100})`);
        if (e.effectId === 'sharpen') filters.push(`contrast(${1 + p.amount / 1200})`);
        if (e.effectId === 'flip') { if (p.horizontal >= 0.5) flipH = -1; if (p.vertical >= 0.5) flipV = -1; }
        if (e.effectId === 'crop') crop = p;
        if (e.effectId === 'vignette') vig = p.amount / 100;
      }
      g.filter = filters.join(' ') || 'none';
      if (c.type === 3) drawText(g, c.text || {}, sx * quality);
      else {
        const el = getEl(c); const m = media[c.mediaId];
        if (el && ((el instanceof HTMLVideoElement && el.readyState >= 2) || (el instanceof HTMLImageElement && el.complete && el.naturalWidth))) {
          const nw = (m.width || el.videoWidth || el.naturalWidth) * sx * quality, nh = (m.height || el.videoHeight || el.naturalHeight) * sy * quality;
          const iw = el.videoWidth || el.naturalWidth, ih = el.videoHeight || el.naturalHeight;
          let sxp = 0, syp = 0, sw = iw, sh = ih, dx = -nw / 2, dy = -nh / 2, dw = nw, dh = nh;
          if (crop) { sxp = iw * crop.left / 100; syp = ih * crop.top / 100; sw = iw * (1 - (crop.left + crop.right) / 100); sh = ih * (1 - (crop.top + crop.bottom) / 100); dx += nw * crop.left / 100; dy += nh * crop.top / 100; dw = nw * sw / iw; dh = nh * sh / ih; }
          g.scale(flipH, flipV);
          if (sw > 0 && sh > 0) g.drawImage(el, sxp, syp, sw, sh, dx, dy, dw, dh);
          if (vig) { g.filter = 'none'; const rg = g.createRadialGradient(0, 0, Math.min(nw, nh) * 0.25, 0, 0, Math.max(nw, nh) * 0.6); rg.addColorStop(0, 'rgba(0,0,0,0)'); rg.addColorStop(1, `rgba(0,0,0,${vig * 0.85})`); g.fillStyle = rg; g.fillRect(-nw / 2, -nh / 2, nw, nh); }
        }
      }
      g.restore();
    }
    // selection outline on the monitor
    if (selected && v.some((x) => x.c.id === selected.c.id) && selected.c.type !== 1) {
      g.save(); g.strokeStyle = 'rgba(102,189,180,0.95)'; g.lineWidth = 2; g.setLineDash([6, 4]);
      const c = selected.c; const m = media[c.mediaId]; const s = base(c.scaleX, 1);
      const w = (c.type === 3 ? (c.text?.pixelSize || 96) * Math.max(4, (c.text?.text || '').length * 0.6) : (m?.width || seq.width)) * s * quality, hh = (c.type === 3 ? (c.text?.pixelSize || 96) * 1.3 : (m?.height || seq.height)) * s * quality;
      g.translate(W / 2 + base(c.posX) * quality, H / 2 + base(c.posY) * quality); g.rotate((base(c.rotation) * Math.PI) / 180); g.strokeRect(-w / 2, -hh / 2, w, hh); g.restore();
    }
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

  // drag the selected clip directly on the monitor (like Velo)
  const drag = useRef(null);
  const onDown = (e) => {
    if (!selected || selected.c.type === 1) return;
    const r = canvas.current.getBoundingClientRect(); const k = seq.width / r.width;
    drag.current = { x: e.clientX, y: e.clientY, px: base(selected.c.posX), py: base(selected.c.posY), k, started: false };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onMove = (e) => {
    const d = drag.current; if (!d) return;
    const dx = (e.clientX - d.x) * d.k, dy = (e.clientY - d.y) * d.k;
    if (!d.started) { if (Math.hypot(dx, dy) < 3) return; d.started = true; }
    d.nx = Math.round(d.px + dx); d.ny = Math.round(d.py + dy);
    liveSet(selected.c, 'posX', anim(d.nx), selected.c.id + 'mx'); liveSet(selected.c, 'posY', anim(d.ny), selected.c.id + 'my');
  };
  const onUp = () => { const d = drag.current; drag.current = null; if (!d?.started) return; revertLive(); edit((dd, s) => { for (const tr of s.videoTracks) { const c = tr.clips.find((x) => x.id === selected.c.id); if (c) { c.posX = anim(d.nx); c.posY = anim(d.ny); } } }); };

  return html`<div style="display:flex;flex-direction:column;min-width:0;min-height:0;overflow:hidden">
    <div class="row" style="padding:6px 12px;gap:8px"><span class="eyebrow grow">Program</span>
      <select class="select sm" style="width:90px" value=${quality} onChange=${(e) => setQuality(Number(e.target.value))} aria-label="Preview quality"><option value="1">Full</option><option value="0.5">1/2</option><option value="0.25">1/4</option></select></div>
    <div ref=${box} style="flex:1;min-height:0;min-width:0;position:relative;overflow:hidden">
      <canvas ref=${canvas} style=${{ position: 'absolute', left: fit.x + 'px', top: fit.y + 'px', width: fit.w + 'px', height: fit.h + 'px', background: '#000', borderRadius: '8px', boxShadow: 'var(--shadow-2)', cursor: selected && selected.c.type !== 1 ? 'move' : 'default' }} onPointerDown=${onDown} onPointerMove=${onMove} onPointerUp=${onUp} />
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

function drawText(g, st, scale) {
  const size = (st.pixelSize || 96) * scale;
  g.font = `${st.italic ? 'italic ' : ''}${st.bold === false ? 500 : 800} ${size}px ${JSON.stringify(st.family || 'Montserrat')}, Montserrat, "Segoe UI", sans-serif`;
  g.textAlign = 'center'; g.textBaseline = 'middle';
  const col = (s, d) => { const h = String(s || d).replace('#', ''); if (h.length === 8) return `rgba(${parseInt(h.slice(2, 4), 16)},${parseInt(h.slice(4, 6), 16)},${parseInt(h.slice(6, 8), 16)},${parseInt(h.slice(0, 2), 16) / 255})`; return '#' + h; };
  const lines = String(st.text || '').split('\n');
  lines.forEach((line, i) => {
    const y = (i - (lines.length - 1) / 2) * size * 1.15;
    if (st.outlineWidth) { g.lineJoin = 'round'; g.lineWidth = st.outlineWidth * 2 * scale; g.strokeStyle = col(st.outlineColor, 'ff000000'); g.strokeText(line, 0, y); }
    g.fillStyle = col(st.color, 'ffffffff'); g.fillText(line, 0, y);
  });
}

// ------------------------------------------------------------ effect controls
function NumField({ label, value, onChange, step = 1, min, max, unit = '', digits = 0 }) {
  const down = useRef(null);
  const start = (e) => { down.current = { x: e.clientX, v: value, last: null }; e.currentTarget.setPointerCapture(e.pointerId); };
  const move = (e) => { if (!down.current) return; const dx = e.clientX - down.current.x; let v = down.current.v + dx * step * (e.shiftKey ? 10 : 1); if (min != null) v = Math.max(min, v); if (max != null) v = Math.min(max, v); v = Number(v.toFixed(digits + 1)); down.current.last = v; onChange(v, true); };
  const up = () => { const d = down.current; down.current = null; if (d && d.last != null) onChange(d.last, false); };
  return html`<div class="row" style="justify-content:space-between;gap:8px;padding:3px 0">
    <span style="cursor:ew-resize;font-size:var(--fs-sm);color:var(--ink-2)" title="Drag to scrub (Shift = 10×)" onPointerDown=${start} onPointerMove=${move} onPointerUp=${up}>${label}</span>
    <div class="row" style="gap:4px"><input class="input sm tnum" style="width:78px;text-align:right" type="number" step=${step} value=${Number(value).toFixed(digits)} onChange=${(e) => onChange(Number(e.target.value), false)} aria-label=${label} /><span class="faint" style="width:14px;font-size:var(--fs-xs)">${unit}</span></div></div>`;
}

function EffectControls({ selected, seq, edit, media }) {
  if (!selected) return html`<div style="background:var(--ed-panel);border-left:1px solid var(--line);padding:14px"><div class="eyebrow">Effect controls</div><p class="faint" style="font-size:var(--fs-sm);margin-top:10px">Select a clip on the timeline to adjust position, scale, opacity, speed, effects and transitions. Drag any label to scrub its value.</p>
    <div class="divider" /><div class="eyebrow">Shortcuts</div><div class="col" style="gap:4px;margin-top:8px;font-size:var(--fs-sm)" class="muted">${[['Space', 'Play / pause'], ['J K L', 'Shuttle'], ['S', 'Split selected'], ['Shift S', 'Split all tracks'], ['Del', 'Delete'], ['Alt Del', 'Ripple delete'], ['V / C / T', 'Select / razor / title'], ['Ctrl Z', 'Undo'], ['+ / −', 'Zoom timeline']].map(([k, d]) => html`<div class="row"><kbd>${k}</kbd><span class="faint">${d}</span></div>`)}</div></div>`;
  const c = selected.c;
  // Live-preview while scrubbing (mutate in place); commit an undo step on release.
  const [, force] = useState(0);
  useEffect(() => { const f = () => force((n) => n + 1); window.addEventListener('studio-redraw', f); return () => window.removeEventListener('studio-redraw', f); }, []);
  const setRaw = (fn) => { revertLive(); edit((d, s) => { for (const tr of [...s.videoTracks, ...s.audioTracks]) { const x = tr.clips.find((y) => y.id === c.id); if (x) fn(x, tr); } }); };
  const setP = (k, v, isLive) => { if (isLive) return liveSet(c, k, anim(v), c.id + k); setRaw((x) => { x[k] = anim(v); }); };
  return html`<div style="background:var(--ed-panel);border-left:1px solid var(--line);overflow:auto;padding:12px 14px">
    <div class="row"><span class="eyebrow grow">Effect controls</span><span class="badge outline">${['Video', 'Audio', 'Image', 'Title', 'Nested'][c.type]}</span></div>
    <div class="ellipsis" style="font-weight:600;margin:6px 0 10px">${c.name || media[c.mediaId]?.name || 'Clip'}</div>
    ${c.type === 3 ? html`<div class="col" style="gap:8px;margin-bottom:10px"><textarea class="textarea" rows="2" id="ec-text" value=${c.text?.text || ''} onChange=${(e) => setRaw((x) => { x.text.text = e.target.value; x.name = e.target.value.slice(0, 40); })} aria-label="Title text" />
      <div class="row"><input class="input sm" style="flex:1" value=${c.text?.family || 'Montserrat'} onChange=${(e) => setRaw((x) => { x.text.family = e.target.value; })} aria-label="Font family" />
        <input type="color" value=${'#' + String(c.text?.color || 'ffffffff').slice(-6)} onChange=${(e) => setRaw((x) => { x.text.color = '#ff' + e.target.value.slice(1); })} aria-label="Text color" />
        <input type="color" value=${'#' + String(c.text?.outlineColor || 'ff000000').slice(-6)} onChange=${(e) => setRaw((x) => { x.text.outlineColor = '#ff' + e.target.value.slice(1); })} aria-label="Outline color" /></div>
      <${NumField} label="Size" value=${c.text?.pixelSize || 96} min=${8} max=${600} onChange=${(v, isLive) => { if (isLive) liveSet(c.text, 'pixelSize', v, c.id + 'tsize'); else setRaw((x) => { x.text.pixelSize = Math.round(v); }); }} />
      <${NumField} label="Outline" value=${c.text?.outlineWidth || 0} min=${0} max=${40} onChange=${(v, isLive) => { if (isLive) liveSet(c.text, 'outlineWidth', v, c.id + 'tow'); else setRaw((x) => { x.text.outlineWidth = Math.round(v); }); }} /></div>` : null}
    ${c.type !== 1 ? html`<div class="eyebrow" style="margin-top:6px">Motion</div>
      <${NumField} label="Position X" value=${base(c.posX)} onChange=${(v, l) => setP('posX', v, l)} unit="px" />
      <${NumField} label="Position Y" value=${base(c.posY)} onChange=${(v, l) => setP('posY', v, l)} unit="px" />
      <${NumField} label="Scale" value=${base(c.scaleX, 1) * 100} step=${0.5} min=${1} max=${2000} onChange=${(v, l) => { if (l) { liveSet(c, 'scaleX', anim(v / 100), c.id + 'sx'); liveSet(c, 'scaleY', anim(v / 100), c.id + 'sy'); } else setRaw((x) => { x.scaleX = anim(v / 100); x.scaleY = anim(v / 100); }); }} unit="%" />
      <${NumField} label="Rotation" value=${base(c.rotation)} step=${0.5} onChange=${(v, l) => setP('rotation', v, l)} unit="°" />
      <${NumField} label="Opacity" value=${base(c.opacity, 1) * 100} min=${0} max=${100} onChange=${(v, l) => setP('opacity', v / 100, l)} unit="%" />` : null}
    ${c.type === 0 || c.type === 1 ? html`<div class="eyebrow" style="margin-top:10px">Time</div>
      <${NumField} label="Speed" value=${(c.speed || 1) * 100} step=${1} min=${10} max=${1000} unit="%" onChange=${(v, l) => { if (!l) setRaw((x) => { const old = x.speed || 1; x.speed = v / 100; x.duration = x.duration * old / x.speed; }); }} />` : null}
    ${c.type === 1 ? html`<div class="eyebrow" style="margin-top:10px">Audio</div><${NumField} label="Volume" value=${base(c.volume, 1) * 100} min=${0} max=${400} unit="%" onChange=${(v, l) => setP('volume', v / 100, l)} />` : null}
    ${(c.effects || []).map((e, i) => { const def = EFFECTS.find((f) => f.id === e.effectId); return html`<div class="divider" /><div class="row"><${Toggle} on=${e.enabled !== false} label="Enable effect" onChange=${(on) => setRaw((x) => { x.effects[i].enabled = on; })} /><b class="grow" style="font-size:var(--fs-sm)">${def?.name || e.effectId}</b><${Button} size="sm" kind="ghost" icon="trash" title="Remove effect" onClick=${() => setRaw((x) => { x.effects.splice(i, 1); })} /></div>
      ${(def?.params || []).map(([k, label, mn, mx, dflt, stp]) => html`<${NumField} label=${label} value=${base(e.params?.[k], dflt)} min=${mn} max=${mx} step=${stp || (mx - mn > 50 ? 1 : 0.05)} digits=${stp && stp < 1 ? 2 : 0} onChange=${(v, l) => { if (l) liveSet(e.params, k, anim(v), c.id + 'fx' + i + k); else setRaw((x) => { x.effects[i].params[k] = anim(v); }); }} />`)}`; })}
    <div class="divider" /><div class="eyebrow">Transitions</div>
    ${['transIn', 'transOut'].map((edge) => html`<div class="row" style="padding:4px 0"><span class="muted" style="width:34px;font-size:var(--fs-sm)">${edge === 'transIn' ? 'In' : 'Out'}</span>
      <select class="select sm" style="flex:1" value=${c[edge]?.type || 0} onChange=${(e) => setRaw((x) => { x[edge] = { type: Number(e.target.value), duration: x[edge]?.duration || 0.5 }; })} aria-label=${edge}><option value="0">None</option>${TRANSITIONS.map((tt) => html`<option value=${tt.type}>${tt.name}</option>`)}</select>
      <input class="input sm tnum" style="width:62px" type="number" step="0.05" min="0.04" value=${c[edge]?.duration || 0.5} onChange=${(e) => setRaw((x) => { x[edge] = { ...(x[edge] || { type: 0 }), duration: Math.max(0.04, Number(e.target.value)) }; })} aria-label="Duration" /></div>`)}
  </div>`;
}

// ------------------------------------------------------------ timeline
function Timeline({ seq, media, t, setT, sel, setSel, tool, snap, zoom, setZoom, duration, edit, findClip, linked, onAdd }) {
  const scroller = useRef(null);
  const [drag, setDrag] = useState(null);
  const [, force] = useState(0);
  useEffect(() => { const f = () => force((n) => n + 1); window.addEventListener('studio-redraw', f); return () => window.removeEventListener('studio-redraw', f); }, []);
  const lanes = [...seq.videoTracks.map((tr, i) => ({ tr, type: 0, i })).reverse(), ...seq.audioTracks.map((tr, i) => ({ tr, type: 1, i }))];
  const width = Math.max(800, (duration + 30) * zoom);
  const xOf = (s) => s * zoom; const sOf = (x) => Math.max(0, x / zoom);
  const fps = seq.fps || 30;
  const snapPoints = () => [t, 0, ...[...seq.videoTracks, ...seq.audioTracks].flatMap((tr) => tr.clips.flatMap((c) => [c.start, c.start + c.duration]))];
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
    const r = scroller.current.getBoundingClientRect(); const move = (ev) => setT(Math.round(sOf(ev.clientX - r.left + scroller.current.scrollLeft - HEAD_W) * fps) / fps);
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
    const ids = additive ? [...new Set([...sel, c.id])] : sel.includes(c.id) ? sel : [c.id];
    setSel(ids); sfx('tap');
    const group = mode === 'move' ? [...new Set(ids.flatMap((id) => { const f = findClip(seq, id); return f ? linked(seq, f.c).map((x) => x.id) : []; }))] : [c.id, ...linked(seq, c).filter((x) => x.id !== c.id).map((x) => x.id)];
    const orig = Object.fromEntries(group.map((id) => [id, clone(findClip(seq, id).c)]));
    setDrag({ mode, startX: e.clientX, startY: e.clientY, clipId: c.id, lane, group, orig, dt: 0, dTrack: 0, moved: false });
  };
  useEffect(() => {
    if (!drag) return;
    const move = (e) => {
      const ds = (e.clientX - drag.startX) / zoom; if (!drag.moved && Math.abs(e.clientX - drag.startX) < 3 && Math.abs(e.clientY - drag.startY) < 4) return;
      const o = drag.orig[drag.clipId]; let dt = ds;
      if (drag.mode === 'move') { const ns = doSnap(o.start + ds, e.altKey, new Set([o.start, o.start + o.duration])); const ne = doSnap(o.start + o.duration + ds, e.altKey, new Set([o.start, o.start + o.duration])); dt = Math.abs(ns - (o.start + ds)) <= Math.abs(ne - (o.start + o.duration + ds)) ? ns - o.start : ne - o.start - o.duration; dt = Math.max(-Math.min(...Object.values(drag.orig).map((x) => x.start)), dt); }
      const dTrack = drag.mode === 'move' ? Math.round((e.clientY - drag.startY) / TRACK_H[drag.lane.type]) : 0;
      setDrag({ ...drag, dt, dTrack, moved: true, alt: e.altKey });
    };
    const up = () => {
      const d = drag; setDrag(null);
      if (!d.moved) return;
      edit((dd, s) => {
        for (const id of d.group) {
          const f = findClip(s, id); if (!f) continue; const o = d.orig[id]; const c = f.c;
          if (d.mode === 'move') {
            c.start = Math.max(0, Math.round((o.start + d.dt) * fps) / fps);
            const list = c.type === 1 ? s.audioTracks : s.videoTracks; let ti = list.indexOf(f.tr);
            if (id === d.clipId || sel.includes(id)) { const dir = c.type === 1 ? d.dTrack : -d.dTrack; ti = Math.max(0, Math.min(list.length - 1, ti + dir)); }
            f.tr.clips = f.tr.clips.filter((x) => x.id !== id); overwrite(list[ti], c);
          } else if (d.mode === 'trimL') {
            const maxIn = (o.in || 0) / (o.speed || 1);
            const ns = doSnap(Math.min(o.start + o.duration - 1 / fps, Math.max(o.start - maxIn, o.start + d.dt)), d.alt);
            const delta = ns - o.start; c.start = ns; c.duration = o.duration - delta; c.in = Math.max(0, (o.in || 0) + delta * (o.speed || 1));
          } else {
            const m = media[o.mediaId]; const maxDur = m && m.kind < 2 ? ((m.duration - (o.in || 0)) / (o.speed || 1)) : 3600;
            const ne = doSnap(o.start + Math.max(1 / fps, Math.min(maxDur, o.duration + d.dt)), d.alt);
            c.duration = Math.max(1 / fps, Math.min(maxDur, ne - o.start));
          }
        }
      });
      sfx('press');
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

  const toggleTrack = (lane, key) => edit((d, s) => { (lane.type === 1 ? s.audioTracks : s.videoTracks)[lane.i][key] = !(lane.type === 1 ? s.audioTracks : s.videoTracks)[lane.i][key]; });
  const addTrack = (type) => edit((d, s) => { const list = type === 1 ? s.audioTracks : s.videoTracks; list.push({ type, name: `${type === 1 ? 'A' : 'V'}${list.length + 1}`, muted: false, locked: false, volume: { base: 1 }, clips: [] }); });
  const onDropMedia = (e, lane) => {
    const mid = e.dataTransfer.getData('text/x-media'); if (!mid) return; e.preventDefault();
    const r = scroller.current.getBoundingClientRect(); const at = doSnap(sOf(e.clientX - r.left + scroller.current.scrollLeft - HEAD_W), e.altKey);
    onAdd(media[mid], lane.type === 0 ? lane.i : 0, at);
  };

  return html`<div style="display:flex;flex-direction:column;min-height:0;min-width:0;background:var(--ed-panel);border-top:1px solid var(--line)">
    <div class="row" style="padding:6px 12px;border-bottom:1px solid var(--line);gap:10px">
      <span class="eyebrow">Timeline</span><span class="mono tnum" style="color:var(--teal-ink)">${tc(t, fps)}</span><span class="faint" style="font-size:var(--fs-xs)">${sel.length ? `${sel.length} selected` : ''}</span>
      <div class="spacer" /><${Button} kind="ghost" size="sm" icon="plus" onClick=${() => addTrack(0)}>Video track</${Button}><${Button} kind="ghost" size="sm" icon="plus" onClick=${() => addTrack(1)}>Audio track</${Button}>
      <${Icon} name="zoomOut" size=${15} style="color:var(--ink-3)" /><input type="range" class="range" style="width:140px" min="4" max="400" value=${zoom} onInput=${(e) => setZoom(Number(e.target.value))} aria-label="Timeline zoom" /><${Icon} name="zoomIn" size=${15} style="color:var(--ink-3)" />
    </div>
    <div ref=${scroller} style="flex:1;overflow:auto;position:relative" onPointerDown=${(e) => { if (e.target === e.currentTarget) setSel([]); }}>
      <div style=${{ width: width + HEAD_W + 'px', position: 'relative', minHeight: '100%' }}>
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
          <div style=${{ position: 'relative', flex: 1, background: lane.tr.locked ? 'repeating-linear-gradient(135deg, transparent 0 6px, var(--surface-3) 6px 7px)' : 'transparent', opacity: lane.tr.muted ? 0.5 : 1 }} onDragOver=${(e) => e.preventDefault()} onDrop=${(e) => onDropMedia(e, lane)} onPointerDown=${() => setSel([])}>
            ${lane.tr.clips.map((c) => { const v = view(c); const isSel = sel.includes(c.id); const colors = c.type === 1 ? ['--clip-a', '--clip-a-line'] : c.type === 3 ? ['--clip-t', '--clip-t-line'] : ['--clip-v', '--clip-v-line'];
              return html`<div key=${c.id} title=${c.name} onPointerDown=${(e) => onClipDown(e, c, lane)} style=${{ position: 'absolute', left: xOf(v.start) + 'px', width: Math.max(4, xOf(v.duration) - 1) + 'px', top: 3 + v.dy + 'px', bottom: 3 - v.dy + 'px', borderRadius: '6px', background: `var(${colors[0]})`, border: `1.5px solid ${isSel ? 'var(--ink)' : `var(${colors[1]})`}`, cursor: tool === 'razor' ? 'crosshair' : 'grab', overflow: 'hidden', zIndex: drag?.group?.includes(c.id) ? 5 : 1, boxShadow: isSel ? '0 0 0 2px var(--focus)' : 'none', opacity: c.enabled === false ? 0.45 : 1 }}>
                ${c.type === 0 && media[c.mediaId] && xOf(v.duration) > 50 ? html`<div style=${{ position: 'absolute', inset: 0, backgroundImage: `url(${api.url(`/api/media/thumb?path=${encodeURIComponent(media[c.mediaId].path)}&t=${Math.round(c.in || 0) + 1}`)})`, backgroundSize: 'auto 100%', backgroundRepeat: 'repeat-x', opacity: 0.45 }} />` : null}
                <div class="ellipsis" style="position:relative;font-size:11px;font-weight:600;padding:3px 7px;color:var(--ink)">${c.type === 3 ? (c.text?.text || 'Title') : c.name}${c.effects?.length ? ' ·fx' : ''}${(c.speed || 1) !== 1 ? ` · ${Math.round((c.speed || 1) * 100)}%` : ''}</div>
                ${c.transIn?.type ? html`<div style=${{ position: 'absolute', left: 0, top: 0, bottom: 0, width: xOf(c.transIn.duration) + 'px', background: 'linear-gradient(90deg, rgba(0,0,0,0.25), transparent)' }} />` : null}
                ${c.transOut?.type ? html`<div style=${{ position: 'absolute', right: 0, top: 0, bottom: 0, width: xOf(c.transOut.duration) + 'px', background: 'linear-gradient(270deg, rgba(0,0,0,0.25), transparent)' }} />` : null}
              </div>`; })}
          </div></div>`)}
        <div style=${{ position: 'absolute', top: 0, bottom: 0, left: HEAD_W + xOf(t) + 'px', width: '2px', background: 'var(--playhead)', zIndex: 6, pointerEvents: 'none' }}><div style="position:absolute;top:0;left:-5px;width:12px;height:12px;border-radius:3px;background:var(--playhead)" /></div>
      </div>
    </div></div>`;
}
