// Quick cut: open a video, drag two handles to pick a stretch, crop, export. No timeline, no tracks.
import { html, useState, useEffect, useRef, useApi, useEvent, useRoute, navigate, Button, Seg, act, toast } from '../lib/ui.js';
import { api } from '../lib/api.js';
import { Icon } from '../lib/icons.js';

// Times as m:ss.hh (hundredths of a second), h:mm:ss.hh past an hour.
const fmt = (s) => { s = Math.max(0, s || 0); const cs = Math.round(s * 100); const h = Math.floor(cs / 360000), m = Math.floor((cs % 360000) / 6000), x = Math.floor((cs % 6000) / 100), c = cs % 100; return `${h ? `${h}:${String(m).padStart(2, '0')}` : m}:${String(x).padStart(2, '0')}.${String(c).padStart(2, '0')}`; };
const parse = (t) => { const p = String(t).trim().split(':'); if (!p.length) return null; const sec = Number(p.pop()); const mins = p.length ? Number(p.pop()) : 0; const hrs = p.length ? Number(p.pop()) : 0; const v = hrs * 3600 + mins * 60 + sec; return Number.isFinite(v) ? v : null; };
const ASPECTS = [{ value: 'none', label: 'Off' }, { value: '9:16', label: '9:16' }, { value: '1:1', label: '1:1' }, { value: '4:5', label: '4:5' }, { value: '16:9', label: '16:9' }, { value: 'free', label: 'Free' }];
const ratioOf = (a) => (a === '9:16' ? 9 / 16 : a === '1:1' ? 1 : a === '4:5' ? 4 / 5 : a === '16:9' ? 16 / 9 : null);

export function Clipper() {
  const route = useRoute(); const id = route.query.f;
  return id ? html`<${Editor} key=${id} id=${id} />` : html`<${Home} />`;
}

// ------------------------------------------------------------------ pick a video
function Home() {
  const { data } = useApi('/api/clipper', ['clipper']);
  const { data: assets } = useApi('/api/assets', ['assets']);
  const [drag, setDrag] = useState(false); const [up, setUp] = useState(null);
  const openPath = async (body) => { const e = await act(() => api.post('/api/clipper/open', body)); if (e?.id) navigate(`/clipper?f=${e.id}`); };
  const choose = async () => {
    if (data?.desktop) { const r = await act(() => api.post('/api/system/pick', { multi: false, filters: [{ name: 'Video', extensions: ['mp4', 'mov', 'm4v', 'mkv', 'webm', 'avi', 'mts', 'mxf'] }] })); if (r?.paths?.[0]) openPath({ path: r.paths[0] }); return; }
    const i = document.createElement('input'); i.type = 'file'; i.accept = 'video/*'; i.onchange = () => i.files[0] && upload(i.files[0]); i.click();
  };
  const upload = async (f) => {
    setUp(0);
    try { const r = await api.upload('/api/clipper/upload', [f], {}, (p) => setUp(p)); if (r?.[0]?.id) navigate(`/clipper?f=${r[0].id}`); } catch (e) { toast(e.message, { kind: 'error' }); }
    setUp(null);
  };
  const recent = data?.files || [];
  return html`<div class="page">
    <div class="page-head"><div class="grow"><h1>Quick cut</h1><div class="sub">Open a video, drag the handles to pick the part you want, crop it, export. That's it.</div></div></div>
    <div class=${'qc-drop' + (drag ? ' on' : '')} onDragOver=${(e) => { e.preventDefault(); setDrag(true); }} onDragLeave=${() => setDrag(false)}
      onDrop=${(e) => { e.preventDefault(); setDrag(false); const f = e.dataTransfer.files[0]; if (!f) return; if (f.path && data?.desktop) openPath({ path: f.path }); else upload(f); }}>
      <${Icon} name="scissors" size=${34} />
      <b style="font-size:18px">Drop a video here</b>
      <span class="faint">Any length: a two-hour video is fine.</span>
      <${Button} kind="primary" icon="upload" onClick=${choose} busy=${up != null}>${up != null ? `Bringing it in… ${Math.round(up * 100)}%` : 'Choose a video'}</${Button}>
    </div>
    ${recent.length ? html`<h3 style="margin:22px 0 8px">Opened recently</h3><div class="qc-grid">${recent.map((x) => html`<button type="button" class="qc-card" onClick=${() => navigate(`/clipper?f=${x.id}`)}>
      <div class="qc-th" style=${{ backgroundImage: `url(${api.url(`/api/media/thumb?path=${encodeURIComponent(x.path)}&t=${Math.min(5, (x.info?.duration || 10) / 3).toFixed(1)}`)})` }} />
      <div class="ellipsis" style="font-size:var(--fs-sm)">${x.name}</div><div class="faint tnum" style="font-size:var(--fs-xs)">${fmt(x.info?.duration || 0)}</div></button>`)}</div>` : null}
    ${(assets || []).length ? html`<h3 style="margin:22px 0 8px">From your footage</h3><div class="qc-grid">${(assets || []).filter((a) => a.info?.hasVideo !== false && a.path).slice(0, 24).map((a) => html`<button type="button" class="qc-card" onClick=${() => openPath({ assetId: a.id })}>
      <div class="qc-th" style=${{ backgroundImage: `url(${api.url(`/api/media/thumb?path=${encodeURIComponent(a.path)}&t=${Math.min(5, (a.info?.duration || 10) / 3).toFixed(1)}`)})` }} />
      <div class="ellipsis" style="font-size:var(--fs-sm)">${a.name}</div><div class="faint tnum" style="font-size:var(--fs-xs)">${fmt(a.info?.duration || 0)}</div></button>`)}</div>` : null}
  </div>`;
}

// ------------------------------------------------------------------ the cutter
function Editor({ id }) {
  const { data: e, reload } = useApi(`/api/clipper/${id}`, ['clipper']);
  const { data: meta } = useApi('/api/clipper', []);
  const { data: wv } = useApi(`/api/clipper/${id}/wave`, []);
  const D = e?.info?.duration || 0; const fps = Math.round(e?.info?.fps || 30) || 30;
  const vid = useRef(null); const ruler = useRef(null); const head = useRef(null); const canvas = useRef(null); const stage = useRef(null);
  const [inP, setIn] = useState(0); const [outP, setOut] = useState(0);
  const [view, setView] = useState([0, 0]); // visible seconds on the ruler
  const [playing, setPlaying] = useState(false); const [loop, setLoop] = useState(true);
  const [aspect, setAspect] = useState('none'); const [crop, setCrop] = useState({ x: 0, y: 0, w: 1, h: 1 });
  const [size, setSize] = useState('original'); const [name, setName] = useState(''); const [clientId, setClientId] = useState('');
  const [folder, setFolder] = useState(''); const [job, setJob] = useState(null); const [done, setDone] = useState(null); const [proxyPct, setProxyPct] = useState(null);
  const [rw, setRw] = useState(800); const [box, setBox] = useState(null);
  const st = useRef({}); st.current = { inP, outP, view, loop, D, fps, rw };

  // first open: the whole video selected and in view
  useEffect(() => { if (D && !outP) { setOut(D); setView([0, D]); } }, [D]);
  useEffect(() => { if (meta?.folder && !folder) setFolder(meta.folder); }, [meta]);
  // ruler width
  useEffect(() => { const el = ruler.current; if (!el) return; const ro = new ResizeObserver(() => setRw(el.clientWidth)); ro.observe(el); return () => ro.disconnect(); }, [e]);
  // where the video sits inside the stage (for the crop box)
  useEffect(() => {
    const el = stage.current; if (!el || !e) return;
    const fit = () => { const W = el.clientWidth, H = el.clientHeight, vw = e.info.width, vh = e.info.height; const k = Math.min(W / vw, H / vh); setBox({ x: (W - vw * k) / 2, y: (H - vh * k) / 2, w: vw * k, h: vh * k }); };
    fit(); const ro = new ResizeObserver(fit); ro.observe(el); return () => ro.disconnect();
  }, [e]);

  const x = (t) => ((t - view[0]) / Math.max(0.001, view[1] - view[0])) * rw;
  const tAt = (px) => { const [a, b] = st.current.view; return Math.max(0, Math.min(st.current.D, a + (px / st.current.rw) * (b - a))); };

  // playhead: moved every frame straight on the element (no re-render), loops the selection
  useEffect(() => {
    let raf;
    const tick = () => {
      const v = vid.current; const s = st.current;
      if (v && head.current) {
        const t = v.currentTime;
        if (!v.paused && t >= s.outP - 0.02) { if (s.loop) v.currentTime = s.inP; else { v.pause(); v.currentTime = s.outP; } }
        const [a, b] = s.view; const px = ((t - a) / Math.max(0.001, b - a)) * s.rw;
        head.current.style.transform = `translateX(${px}px)`; head.current.style.opacity = px < -2 || px > s.rw + 2 ? 0 : 1;
        const tc = document.getElementById('qc-time'); if (tc) tc.textContent = fmt(t, s.fps);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick); return () => cancelAnimationFrame(raf);
  }, []);

  // waveform under the filmstrip
  useEffect(() => {
    const c = canvas.current; const peaks = wv?.peaks || []; if (!c || !D) return;
    const dpr = window.devicePixelRatio || 1; c.width = rw * dpr; c.height = 36 * dpr; const g = c.getContext('2d'); g.scale(dpr, dpr); g.clearRect(0, 0, rw, 36);
    if (!peaks.length) return; g.fillStyle = 'rgba(255,255,255,.55)';
    for (let px = 0; px < rw; px += 2) { const t = view[0] + (px / rw) * (view[1] - view[0]); const v = peaks[Math.min(peaks.length - 1, Math.floor((t / D) * peaks.length))] || 0; const h = Math.max(1, v * 32); g.fillRect(px, 18 - h / 2, 1.4, h); }
  }, [wv, view, rw, D]);

  const seek = (t, fast = false) => { const v = vid.current; if (!v) return; t = Math.max(0, Math.min(D, t)); if (fast && v.fastSeek) v.fastSeek(t); else v.currentTime = t; };
  const play = (fromIn = false) => { const v = vid.current; if (!v) return; if (!v.paused) { v.pause(); return; } if (fromIn || v.currentTime >= outP - 0.05 || v.currentTime < inP) v.currentTime = inP; v.play().catch(() => {}); };
  const frame = 1 / fps;

  // ruler pointer: handles, the selection (move), or anywhere else (scrub)
  const down = (ev) => {
    if (ev.button !== 0) return; ev.preventDefault();
    const r = ruler.current.getBoundingClientRect(); const px = ev.clientX - r.left; const t = tAt(px);
    const xi = x(inP), xo = x(outP);
    // the yellow handles sit just inside the selection's ends (so they're grabbable at the very edges of the ruler)
    let mode = 'scrub'; if (px >= xi - 8 && px <= xi + 18 && px < (xi + xo) / 2) mode = 'in'; else if (px >= xo - 18 && px <= xo + 8) mode = 'out'; else if (px > xi && px < xo && ev.target.closest('.qc-sel-bar')) mode = 'move';
    const v = vid.current; const was = v && !v.paused; if (v && mode !== 'scrub') v.pause();
    const start = { t, inP, outP };
    const move = (e2) => {
      const t2 = tAt(e2.clientX - r.left); const minLen = frame * 2;
      if (mode === 'scrub') seek(t2, true);
      else if (mode === 'in') { const n = Math.min(t2, st.current.outP - minLen); setIn(n); seek(n, true); }
      else if (mode === 'out') { const n = Math.max(t2, st.current.inP + minLen); setOut(n); seek(n, true); }
      else { const len = start.outP - start.inP; let a = start.inP + (t2 - start.t); a = Math.max(0, Math.min(D - len, a)); setIn(a); setOut(a + len); seek(a, true); }
    };
    const upH = (e2) => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', upH); const t2 = tAt(e2.clientX - r.left); if (mode === 'scrub') seek(t2); if (was && mode === 'scrub') v.play().catch(() => {}); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', upH);
    if (mode === 'scrub') seek(t, true);
  };
  // wheel: pinch / Ctrl+wheel zooms around the pointer, plain wheel pans
  const wheel = (ev) => {
    ev.preventDefault(); const r = ruler.current.getBoundingClientRect(); const [a, b] = st.current.view; const span = b - a;
    if (ev.ctrlKey || ev.metaKey) {
      const at = a + ((ev.clientX - r.left) / r.width) * span; const k = Math.exp(ev.deltaY * 0.01); const ns = Math.max(2, Math.min(D, span * k));
      let na = at - ((at - a) / span) * ns; na = Math.max(0, Math.min(D - ns, na)); setView([na, na + ns]);
    } else { const d = ((ev.deltaX || ev.deltaY) / r.width) * span; const na = Math.max(0, Math.min(D - span, a + d)); setView([na, na + span]); }
  };
  useEffect(() => { const el = ruler.current; if (!el) return; el.addEventListener('wheel', wheel, { passive: false }); return () => el.removeEventListener('wheel', wheel); }, [e, D]);
  const zoomBy = (k) => { const [a, b] = view; const span = b - a; const c = vid.current?.currentTime ?? (a + b) / 2; const ns = Math.max(2, Math.min(D, span * k)); let na = c - ns / 2; na = Math.max(0, Math.min(D - ns, na)); setView([na, na + ns]); };
  const fitSel = () => { const pad = Math.max(1, (outP - inP) * 0.08); const a = Math.max(0, inP - pad), b = Math.min(D, outP + pad); setView([a, b]); };

  // keys
  useEffect(() => {
    const k = (ev) => {
      if (/input|textarea|select/i.test(ev.target.tagName)) return; const v = vid.current; if (!v) return; const s = st.current;
      if (ev.key === ' ') { ev.preventDefault(); play(); }
      else if (ev.key === 'i' || ev.key === 'I') { setIn(Math.min(v.currentTime, s.outP - s.fps ** -1 * 2)); }
      else if (ev.key === 'o' || ev.key === 'O') { setOut(Math.max(v.currentTime, s.inP + (1 / s.fps) * 2)); }
      else if (ev.key === 'ArrowLeft') { ev.preventDefault(); v.pause(); seek(v.currentTime - (ev.shiftKey ? 1 : 1 / s.fps)); }
      else if (ev.key === 'ArrowRight') { ev.preventDefault(); v.pause(); seek(v.currentTime + (ev.shiftKey ? 1 : 1 / s.fps)); }
      else if (ev.key === 'Home') seek(s.inP); else if (ev.key === 'End') seek(s.outP);
      else if (ev.key === 'l' || ev.key === 'L') setLoop((x2) => !x2);
    };
    window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k);
  }, [e]);

  // crop
  const setAsp = (a) => {
    setAspect(a); const r = ratioOf(a); if (!e) return;
    if (a === 'none') return setCrop({ x: 0, y: 0, w: 1, h: 1 });
    if (a === 'free') return setCrop({ x: 0.1, y: 0.1, w: 0.8, h: 0.8 });
    const vr = e.info.width / e.info.height; let w = 1, h = 1; if (r < vr) w = r / vr; else h = vr / r;
    setCrop({ x: (1 - w) / 2, y: (1 - h) / 2, w, h });
  };
  const cropDown = (ev, corner) => {
    ev.preventDefault(); ev.stopPropagation(); if (!box) return; const s0 = { ...crop }; const p0 = { x: ev.clientX, y: ev.clientY }; const r = ratioOf(aspect); const vr = e.info.width / e.info.height;
    const move = (e2) => {
      const dx = (e2.clientX - p0.x) / box.w, dy = (e2.clientY - p0.y) / box.h; let c = { ...s0 };
      if (!corner) { c.x = Math.max(0, Math.min(1 - c.w, s0.x + dx)); c.y = Math.max(0, Math.min(1 - c.h, s0.y + dy)); }
      else {
        let w = Math.max(0.08, s0.w + (corner.includes('r') ? dx : -dx)); let h = Math.max(0.08, s0.h + (corner.includes('b') ? dy : -dy));
        if (r) { h = (w * vr) / r; if (h > 1) { h = 1; w = (h * r) / vr; } }
        w = Math.min(w, corner.includes('r') ? 1 - s0.x : s0.x + s0.w); h = Math.min(h, corner.includes('b') ? 1 - s0.y : s0.y + s0.h);
        if (r) { const hh = (w * vr) / r; if (hh > h) w = (h * r) / vr; else h = hh; }
        c = { w, h, x: corner.includes('r') ? s0.x : s0.x + s0.w - w, y: corner.includes('b') ? s0.y : s0.y + s0.h - h };
      }
      setCrop(c);
    };
    const upH = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', upH); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', upH);
  };

  // export
  useEvent('job', (j) => { if (job && j.id === job.id) setJob({ ...job, ...j }); if (j.type === 'clipper.proxy' && j.status === 'running') setProxyPct(j.progress || 0); }, [job]);
  useEvent('clipper.exported', (x2) => { if (x2.id === id) { setDone(x2.path); setJob(null); toast(`Saved: ${x2.path}`, { kind: 'ok', title: 'Cut exported' }); } }, [id]);
  useEvent('clipper', (x2) => { if (x2.id === id) { setProxyPct(null); reload(); } }, [id]);
  const doExport = async () => {
    setDone(null);
    const j = await act(() => api.post(`/api/clipper/${id}/export`, { start: inP, end: outP, crop: aspect === 'none' ? null : crop, size, name, folder, clientId: clientId || null }));
    if (j?.id) setJob({ id: j.id, progress: 0, status: 'queued' });
  };
  const chooseFolder = async () => { const r = await act(() => api.post('/api/system/pick-folder', { title: 'Save cuts in…', defaultPath: folder })); if (r?.path) setFolder(r.path); };

  // When the smooth copy arrives the player switches to it in place: same spot, same play/pause.
  const srcPath = e ? (e.proxy || (e.playable !== false ? e.path : null)) : null;
  const lastSrc = useRef(null);
  useEffect(() => {
    const v = vid.current; if (!v || !srcPath || lastSrc.current === srcPath) return;
    const t = lastSrc.current ? v.currentTime : 0; const was = lastSrc.current && !v.paused; lastSrc.current = srcPath;
    const back = () => { v.currentTime = t; if (was) v.play().catch(() => {}); v.removeEventListener('loadedmetadata', back); };
    if (t) v.addEventListener('loadedmetadata', back);
  }, [srcPath]);
  if (!e) return html`<div class="page"><div class="faint"><span class="spinner" /> Opening…</div></div>`;
  const src = srcPath ? api.url(`/api/media?path=${encodeURIComponent(srcPath)}`) : '';
  const span = Math.max(0.001, view[1] - view[0]);
  const step = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800].find((s) => (s / span) * rw >= 90) || 3600;
  const ticks = []; for (let t = Math.ceil(view[0] / step) * step; t <= view[1]; t += step) ticks.push(t);
  const stripW = (D / span) * rw; const stripX = -(view[0] / span) * rw;
  const xi = x(inP), xo = x(outP);
  const exporting = job && !['done', 'failed', 'canceled'].includes(job.status);
  return html`<div class="qc">
    <div class="qc-top">
      <${Button} kind="ghost" size="sm" icon="chevronLeft" onClick=${() => navigate('/clipper')}>Videos</${Button}>
      <b class="ellipsis" style="max-width:420px">${e.name}</b><span class="faint tnum" style="font-size:var(--fs-sm)">${e.info.width}×${e.info.height} · ${fmt(D, fps)}</span>
      <span class="grow" />
      ${e.proxyPending && srcPath ? html`<span class="badge gold" title="A light copy for smoother scrubbing; you can keep working meanwhile">Smoothing playback${proxyPct != null ? ` ${Math.round(proxyPct * 100)}%` : '…'}</span>` : null}
    </div>
    <div class="qc-main">
      <div class="qc-stage" ref=${stage} onClick=${() => play()}>
        ${!srcPath ? html`<div class="qc-wait"><span class="spinner" /> This video needs a preview copy before it can play here${proxyPct != null ? ` (${Math.round(proxyPct * 100)}%)` : ''}. You can already set the start and end below.</div>` : null}
        <video ref=${vid} src=${src} preload="auto" playsinline onPlay=${() => setPlaying(true)} onPause=${() => setPlaying(false)} style=${box ? { position: 'absolute', left: box.x + 'px', top: box.y + 'px', width: box.w + 'px', height: box.h + 'px' } : { width: '100%', height: '100%' }} />
        ${box && aspect !== 'none' ? html`<div class="qc-crop" style=${{ left: box.x + crop.x * box.w + 'px', top: box.y + crop.y * box.h + 'px', width: crop.w * box.w + 'px', height: crop.h * box.h + 'px' }} onPointerDown=${(ev) => cropDown(ev, null)} onClick=${(ev) => ev.stopPropagation()}>
          ${['tl', 'tr', 'bl', 'br'].map((c) => html`<i class=${'qc-cr ' + c} onPointerDown=${(ev) => cropDown(ev, c)} />`)}<span class="qc-crop-grid" /></div>` : null}
      </div>
      <div class="qc-side">
        <div class="qc-card2"><b>Crop</b><${Seg} value=${aspect} onChange=${setAsp} options=${ASPECTS} /><span class="faint" style="font-size:var(--fs-xs)">${aspect === 'none' ? 'The whole frame.' : 'Drag the box to move it, the corners to resize.'}</span></div>
        <div class="qc-card2"><b>Selection</b>
          <div class="qc-times">
            <label>Start<input class="input tnum" value=${fmt(inP, fps)} onChange=${(ev) => { const v = parse(ev.target.value, fps); if (v != null) setIn(Math.max(0, Math.min(outP - 0.1, v))); }} /></label>
            <label>End<input class="input tnum" value=${fmt(outP, fps)} onChange=${(ev) => { const v = parse(ev.target.value, fps); if (v != null) setOut(Math.min(D, Math.max(inP + 0.1, v))); }} /></label>
            <label>Length<input class="input tnum" value=${fmt(outP - inP, fps)} onChange=${(ev) => { const v = parse(ev.target.value, fps); if (v != null && v > 0.1) setOut(Math.min(D, inP + v)); }} /></label>
          </div>
          <div class="row wrap" style="gap:6px"><${Button} size="sm" kind="ghost" onClick=${() => setIn(Math.min(vid.current?.currentTime || 0, outP - 0.1))}>Start here (I)</${Button}><${Button} size="sm" kind="ghost" onClick=${() => setOut(Math.max(vid.current?.currentTime || 0, inP + 0.1))}>End here (O)</${Button}></div>
        </div>
        <div class="qc-card2"><b>Export</b>
          <input class="input" placeholder=${`${e.name.replace(/\.[^.]+$/, '')} (name, optional)`} value=${name} onInput=${(ev) => setName(ev.target.value)} />
          <div class="row" style="gap:6px;align-items:center"><span class="faint" style="font-size:var(--fs-xs);width:44px">Size</span><${Seg} value=${size} onChange=${setSize} options=${[{ value: 'original', label: 'Original' }, { value: '1080', label: '1080' }, { value: '720', label: '720' }]} /></div>
          <div class="row" style="gap:6px;align-items:center"><span class="faint ellipsis grow" style="font-size:var(--fs-xs)" title=${folder}>Saves to ${folder}</span>${meta?.desktop ? html`<${Button} size="sm" kind="ghost" onClick=${chooseFolder}>Change</${Button}>` : null}</div>
          <select class="input" value=${clientId} onChange=${(ev) => setClientId(ev.target.value)}><option value="">Don't add to Production</option>${(meta?.clients || []).map((c) => html`<option value=${c.id}>Also add to Production: ${c.name}</option>`)}</select>
          <${Button} kind="primary" icon="download" busy=${exporting} disabled=${exporting} onClick=${doExport}>${exporting ? `Exporting ${Math.round((job.progress || 0) * 100)}%` : `Export ${fmt(outP - inP, fps)}`}</${Button}>
          ${job?.status === 'failed' ? html`<span style="color:var(--coral);font-size:var(--fs-xs)">${job.error || 'The export failed.'}</span>` : null}
          ${done ? html`<span class="faint selectable" style="font-size:var(--fs-xs)">Saved: ${done}</span>` : null}
        </div>
      </div>
    </div>
    <div class="qc-bar">
      <button type="button" class="qc-play" title="Play / pause (Space)" onClick=${() => play()}><${Icon} name=${playing ? 'pause' : 'play'} size=${18} /></button>
      <span id="qc-time" class="tnum qc-tc">0:00.00</span>
      <button type="button" class=${'chip' + (loop ? ' on' : '')} title="Loop the selection (L)" onClick=${() => setLoop(!loop)}>Loop</button>
      <${Button} size="sm" kind="ghost" onClick=${() => play(true)}>Play selection</${Button}>
      <span class="grow" />
      <span class="faint" style="font-size:var(--fs-xs)">Pinch or Ctrl+scroll to zoom · scroll to move · ← → one frame (Shift: 1 s)</span>
      <${Button} size="sm" kind="ghost" onClick=${() => zoomBy(1.6)}>−</${Button}><${Button} size="sm" kind="ghost" onClick=${() => zoomBy(1 / 1.6)}>+</${Button}>
      <${Button} size="sm" kind="ghost" onClick=${fitSel}>Zoom to selection</${Button}><${Button} size="sm" kind="ghost" onClick=${() => setView([0, D])}>Whole video</${Button}>
    </div>
    <div class="qc-ruler" ref=${ruler} onPointerDown=${down}>
      <div class="qc-ticks">${ticks.map((t) => html`<span style=${{ left: x(t) + 'px' }}>${step < 1 ? `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}` : fmt(t, fps).replace(/\.\d+$/, '')}</span>`)}</div>
      <div class="qc-strip" style=${{ backgroundImage: `url(${api.url(`/api/clipper/${id}/strip`)})`, backgroundSize: `${stripW}px 100%`, backgroundPositionX: `${stripX}px` }} />
      <canvas ref=${canvas} class="qc-wave" style=${{ width: rw + 'px' }} />
      <div class="qc-shade" style=${{ left: 0, width: Math.max(0, xi) + 'px' }} /><div class="qc-shade" style=${{ left: Math.min(rw, xo) + 'px', right: 0 }} />
      <div class="qc-sel" style=${{ left: xi + 'px', width: Math.max(0, xo - xi) + 'px' }}><div class="qc-sel-bar" /><i class="qc-h l" /><i class="qc-h r" /></div>
      <div class="qc-head" ref=${head}><i /></div>
    </div>
  </div>`;
}
