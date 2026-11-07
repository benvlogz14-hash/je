// Quick cut: open a long video (or paste a YouTube link), read and search its whole transcript, drag two handles to
// pick a stretch, crop, export. No timeline, no tracks. Follows the app's light / Night theme.
import { html, useState, useEffect, useRef, useApi, useEvent, useRoute, navigate, Button, Seg, act, toast } from '../lib/ui.js';
import { Component } from '../../vendor/preact.mjs';
import { api } from '../lib/api.js';
import { Icon } from '../lib/icons.js';

// Times as m:ss.hh (hundredths of a second), h:mm:ss.hh past an hour.
const fmt = (s) => { s = Math.max(0, s || 0); const cs = Math.round(s * 100); const h = Math.floor(cs / 360000), m = Math.floor((cs % 360000) / 6000), x = Math.floor((cs % 6000) / 100), c = cs % 100; return `${h ? `${h}:${String(m).padStart(2, '0')}` : m}:${String(x).padStart(2, '0')}.${String(c).padStart(2, '0')}`; };
const short = (s) => fmt(s).replace(/\.\d+$/, '');
const parse = (t) => { const p = String(t).trim().split(':'); if (!p.length) return null; const sec = Number(p.pop()); const mins = p.length ? Number(p.pop()) : 0; const hrs = p.length ? Number(p.pop()) : 0; const v = hrs * 3600 + mins * 60 + sec; return Number.isFinite(v) ? v : null; };
const ASPECTS = [{ value: 'none', label: 'Off' }, { value: '9:16', label: '9:16' }, { value: '1:1', label: '1:1' }, { value: '4:5', label: '4:5' }, { value: '16:9', label: '16:9' }, { value: 'free', label: 'Free' }];
const ratioOf = (a) => (a === '9:16' ? 9 / 16 : a === '1:1' ? 1 : a === '4:5' ? 4 / 5 : a === '16:9' ? 16 / 9 : null);
const norm = (w) => String(w).toLowerCase().replace(/[^a-z0-9']+/g, '');
const easeOut = (k) => 1 - Math.pow(1 - k, 3);

export function Clipper() {
  const route = useRoute(); const id = route.query.f;
  return id ? html`<${Editor} key=${id} id=${id} />` : html`<${Home} />`;
}

// ------------------------------------------------------------------ Upload ▸ with the little ↑ for links
function UploadButton({ onPick, desktop, busy }) {
  const [open, setOpen] = useState(false); const [url, setUrl] = useState(''); const [dl, setDl] = useState(null);
  useEvent('job', (j) => { if (dl && j.id === dl.id) setDl({ ...dl, ...j }); }, [dl]);
  useEvent('clipper.linked', (x) => { if (dl && x.jobId === dl.id) { setDl(null); setOpen(false); setUrl(''); navigate(`/clipper?f=${x.id}`); } }, [dl]);
  const go = async () => { const j = await act(() => api.post('/api/clipper/link', { url: url.trim() })); if (j?.id) setDl({ id: j.id, progress: 0, status: 'queued' }); };
  const failed = dl?.status === 'failed';
  return html`<div class="qc-up">
    <div class="qc-split"><${Button} kind="primary" icon="upload" busy=${busy} onClick=${onPick}>${busy || 'Upload a video'}</${Button}>
      <button type="button" class=${'qc-arrow' + (open ? ' on' : '')} title="Paste a YouTube link instead" aria-label="Paste a link" onClick=${() => setOpen(!open)}><${Icon} name="chevronDown" size=${16} style=${{ transform: 'rotate(180deg)' }} /></button></div>
    ${open ? html`<div class="qc-link"><b style="font-size:var(--fs-sm)">From a link</b>
      <div class="row" style="gap:6px"><input class="input grow" autofocus placeholder="https://www.youtube.com/watch?v=…" value=${url} onInput=${(e) => setUrl(e.target.value)} onKeyDown=${(e) => e.key === 'Enter' && url.trim() && !dl && go()} />
        <${Button} kind="primary" disabled=${!url.trim() || (dl && !failed)} onClick=${go}>Get it</${Button}></div>
      ${dl && !failed ? html`<div class="col" style="gap:4px"><div class="qc-prog"><i style=${{ width: `${Math.round((dl.progress || 0) * 100)}%` }} /></div><span class="faint" style="font-size:var(--fs-xs)">${dl.note || 'Starting the download'} · ${Math.round((dl.progress || 0) * 100)}%</span></div>` : null}
      ${failed ? html`<span style="color:var(--coral);font-size:var(--fs-xs)">${dl.error || "Couldn't download that link."}</span>` : html`<span class="faint" style="font-size:var(--fs-xs)">Downloads the video (up to 1080p) with ${desktop ? 'yt-dlp and FFmpeg' : 'yt-dlp'}, then opens it here and writes its transcript.</span>`}
    </div>` : null}
  </div>`;
}

// ------------------------------------------------------------------ pick a video
function Home() {
  const { data } = useApi('/api/clipper', ['clipper']);
  const { data: assets } = useApi('/api/assets', ['assets']);
  const [drag, setDrag] = useState(false); const [up, setUp] = useState(null);
  const openPath = async (body) => { const e = await act(() => api.post('/api/clipper/open', body)); if (e?.id) navigate(`/clipper?f=${e.id}`); };
  const upload = async (f) => {
    setUp(0);
    try { const r = await api.upload('/api/clipper/upload', [f], {}, (p) => setUp(p)); if (r?.[0]?.id) navigate(`/clipper?f=${r[0].id}`); } catch (e) { toast(e.message, { kind: 'error' }); }
    setUp(null);
  };
  const choose = async () => {
    if (data?.desktop) { const r = await act(() => api.post('/api/system/pick', { multi: false, filters: [{ name: 'Video', extensions: ['mp4', 'mov', 'm4v', 'mkv', 'webm', 'avi', 'mts', 'mxf'] }] })); if (r?.paths?.[0]) openPath({ path: r.paths[0] }); return; }
    const i = document.createElement('input'); i.type = 'file'; i.accept = 'video/*'; i.onchange = () => i.files[0] && upload(i.files[0]); i.click();
  };
  const recent = data?.files || [];
  const card = (key, name, dur, thumbPath, onClick, extra) => html`<button key=${key} type="button" class="qc-card" onClick=${onClick}>
    <div class="qc-th" style=${{ backgroundImage: `url(${api.url(`/api/media/thumb?path=${encodeURIComponent(thumbPath)}&t=${Math.min(5, (dur || 10) / 3).toFixed(1)}`)})` }} />
    <div class="ellipsis" style="font-size:var(--fs-sm)">${name}</div><div class="faint tnum" style="font-size:var(--fs-xs)">${short(dur || 0)}${extra || ''}</div></button>`;
  return html`<div class="page qc-home">
    <div class="page-head"><div class="grow"><h1>Quick cut</h1><div class="sub">Drop in a long video or a YouTube link. It writes down everything that's said, so you can search it, then drag the handles, crop and export.</div></div></div>
    <div class=${'qc-drop' + (drag ? ' on' : '')} onDragOver=${(e) => { e.preventDefault(); setDrag(true); }} onDragLeave=${() => setDrag(false)}
      onDrop=${(e) => { e.preventDefault(); setDrag(false); const f = e.dataTransfer.files[0]; if (!f) return;
        // Desktop app: open the file where it is (instant, even for a huge video). The old file.path is gone in this
        // Electron, so every drop uploaded a whole copy first (minutes for a long video, looked stuck).
        const local = (window.euclidean?.pathForFile && window.euclidean.pathForFile(f)) || f.path || '';
        if (local && data?.desktop) openPath({ path: local }); else upload(f); }}>
      <div class="qc-drop-ico"><${Icon} name="scissors" size=${30} /></div>
      <b style="font-size:18px">Drop a video here</b>
      <span class="faint">Any length: a two-and-a-half-hour debate is fine.</span>
      <${UploadButton} onPick=${choose} desktop=${data?.desktop} busy=${up != null ? `Bringing it in… ${Math.round(up * 100)}%` : ''} />
    </div>
    ${recent.length ? html`<h3 class="qc-h3">Opened recently</h3><div class="qc-grid" data-animate>${recent.map((x) => card(x.id, x.name, x.info?.duration, x.path, () => navigate(`/clipper?f=${x.id}`), x.tx?.status === 'ready' ? ' · transcript ready' : ''))}</div>` : null}
    ${(assets || []).length ? html`<h3 class="qc-h3">From your footage</h3><div class="qc-grid">${(assets || []).filter((a) => a.info?.hasVideo !== false && a.path).slice(0, 24).map((a) => card(a.id, a.name, a.info?.duration, a.path, () => openPath({ assetId: a.id })))}</div>` : null}
  </div>`;
}

// ------------------------------------------------------------------ the transcript
/** The words, drawn once per transcript (25,000 words for 2.5 hours): searching and following never redraw them. */
class Words extends Component {
  shouldComponentUpdate(np) { return np.paras !== this.props.paras; }
  render({ paras }) {
    return html`<div>${paras.map((p, pi) => html`<div key=${pi} class="qc-para" data-p=${pi}><button type="button" class="qc-ts tnum" data-ts=${p.s}>${short(p.s)}</button><p>${p.w.map(([w, t], wi) => html`<span data-t=${t} data-k=${`${pi}:${wi}`}>${w} </span>`)}</p></div>`)}</div>`;
  }
}

class Transcript extends Component {
  constructor(p) { super(p); this.state = { q: '', at: 0, count: 0, sel: null, follow: true }; this.box = null; this.input = null; this.lastScroll = 0; this.ms = []; this.marked = []; this.timer = null; }
  componentDidMount() {
    this.onKey = (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'f') return;
      const scr = this.box?.closest('.screen'); if (scr && !scr.classList.contains('on')) return;
      e.preventDefault(); this.input?.focus(); this.input?.select();
    };
    window.addEventListener('keydown', this.onKey);
    // text selected anywhere in the transcript (mouse, keyboard or touch) → offer it as the cut
    this.onSel = () => { clearTimeout(this.selT); this.selT = setTimeout(() => this.pickSelection(), 120); };
    document.addEventListener('selectionchange', this.onSel);
  }
  componentWillUnmount() { window.removeEventListener('keydown', this.onKey); document.removeEventListener('selectionchange', this.onSel); clearTimeout(this.timer); }
  componentDidUpdate(pp) { if (pp.data !== this.props.data && this.state.q) this.search(this.state.q); }
  /** Find every place the search words appear and mark them (straight on the page, no redraw). */
  search(q) {
    const paras = this.props.data?.paras || []; const toks = q.trim().toLowerCase().split(/\s+/).map(norm).filter(Boolean);
    const out = [];
    if (q.trim().length >= 2 && toks.length) paras.forEach((p, pi) => { for (let i = 0; i < p.w.length; i++) { let ok = true; for (let k = 0; k < toks.length; k++) { const w = p.w[i + k] && norm(p.w[i + k][0]); if (!w || (k === toks.length - 1 ? !w.startsWith(toks[k]) : w !== toks[k])) { ok = false; break; } } if (ok) out.push({ p: pi, i, n: toks.length }); } });
    for (const el of this.marked) el.classList.remove('hit', 'cur'); this.marked = [];
    if (this.box) for (const m of out) for (let k = 0; k < m.n; k++) { const el = this.box.querySelector(`[data-k="${m.p}:${m.i + k}"]`); if (el) { el.classList.add('hit'); this.marked.push(el); } }
    this.ms = out; this.setState({ count: out.length, at: 0 }); if (out.length) this.jump(0);
  }
  jump(k) {
    const m = this.ms; if (!m.length) return; const at = ((k % m.length) + m.length) % m.length; this.setState({ at });
    this.box?.querySelectorAll('span.cur').forEach((el) => el.classList.remove('cur'));
    const hit = m[at]; for (let j = 0; j < hit.n; j++) this.box?.querySelector(`[data-k="${hit.p}:${hit.i + j}"]`)?.classList.add('cur');
    const p = this.props.data.paras[hit.p]; this.props.onSeek(Math.max(0, p.w[hit.i][1] - 0.4), true);
    this.box?.querySelector(`[data-k="${hit.p}:${hit.i}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
  /** Text selected in the transcript → the cut runs from its first word to the end of its last word. */
  pickSelection() {
    const s = window.getSelection(); const inside = s && !s.isCollapsed && this.box && this.box.contains(s.anchorNode) && this.box.contains(s.focusNode);
    if (!inside) { if (this.state.sel && (!s || s.isCollapsed)) this.setState({ sel: null }); return; }
    const wordOf = (node) => (node?.nodeType === 3 ? node.parentElement : node)?.closest?.('[data-t]');
    const r = s.getRangeAt(0); let a = wordOf(r.startContainer), b = wordOf(r.endContainer);
    if (!a) a = r.startContainer.nodeType === 1 ? r.startContainer.querySelector?.('[data-t]') : null;
    if (!a || !b) return;
    const all = this.allWords || (this.allWords = [...this.box.querySelectorAll('[data-t]')]);
    const ia = all.indexOf(a), ib = all.indexOf(b); if (ia < 0 || ib < 0) return;
    const first = all[Math.min(ia, ib)], last = all[Math.max(ia, ib)]; const nx = all[Math.max(ia, ib) + 1];
    const t0 = Number(first.dataset.t), t1 = Number(last.dataset.t);
    const end = nx ? Math.min(Number(nx.dataset.t), t1 + 2) : t1 + 0.8;
    this.setState({ sel: { s: Math.max(0, t0 - 0.15), e: end + 0.1 } });
  }
  /** Called by the editor ~4 times a second with the playhead: the paragraph being heard is marked (and followed). */
  tick(t) {
    const paras = this.props.data?.paras; if (!paras?.length || !this.box) return;
    let lo = 0, hi = paras.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (paras[mid].s <= t) lo = mid; else hi = mid - 1; }
    if (lo === this.cur) return; this.cur = lo;
    this.box.querySelector('.qc-para.now')?.classList.remove('now'); const el = this.box.querySelector(`[data-p="${lo}"]`); el?.classList.add('now');
    if (this.state.follow && Date.now() - this.lastScroll > 2500 && el && !this.state.q && !this.state.sel) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
  render({ data, status, pct, note, onSeek, onCut, onRetry }, { q, at, count, sel, follow }) {
    const paras = data?.paras || []; if (this.lastParas !== paras) { this.lastParas = paras; this.allWords = null; this.marked = []; }
    const working = status === 'working' || status === 'queued';
    return html`<div class="qc-tx">
      <div class="qc-find">
        <${Icon} name="search" size=${15} />
        <input ref=${(el) => { this.input = el; }} class="grow" placeholder=${paras.length ? 'Search what they say (Ctrl+F)' : 'Search appears when the transcript is ready'} disabled=${!paras.length} value=${q}
          onInput=${(e) => { const v = e.target.value; this.setState({ q: v }); clearTimeout(this.timer); this.timer = setTimeout(() => this.search(v), 140); }}
          onKeyDown=${(e) => { if (e.key === 'Enter') { e.preventDefault(); this.jump(this.state.at + (e.shiftKey ? -1 : 1)); } else if (e.key === 'Escape') { this.setState({ q: '' }); this.search(''); } }} />
        ${q.trim().length >= 2 ? html`<span class="faint tnum" style="font-size:var(--fs-xs);white-space:nowrap">${count ? `${Math.min(at, count - 1) + 1} of ${count}` : 'no matches'}</span>
          <button type="button" class="qc-ib" title="Previous (Shift+Enter)" onClick=${() => this.jump(at - 1)}><${Icon} name="chevronDown" size=${14} style=${{ transform: 'rotate(180deg)' }} /></button>
          <button type="button" class="qc-ib" title="Next (Enter)" onClick=${() => this.jump(at + 1)}><${Icon} name="chevronDown" size=${14} /></button>` : null}
      </div>
      ${sel ? html`<div class="qc-selbar"><span class="tnum">${fmt(sel.s)} → ${fmt(sel.e)}</span><span class="grow" /><${Button} size="sm" kind="primary" icon="scissors" onClick=${() => { onCut(sel.s, sel.e); window.getSelection()?.removeAllRanges(); this.setState({ sel: null }); }}>Cut this part</${Button}><${Button} size="sm" kind="ghost" onClick=${() => onSeek(sel.s)}>Play it</${Button}></div>` : null}
      <div class="qc-tx-body selectable" ref=${(el) => { this.box = el; }} onScroll=${() => { this.lastScroll = Date.now(); }}
        onClick=${(e) => { const s = window.getSelection(); if (s && !s.isCollapsed) return; const ts = e.target.closest('[data-ts]'); const w = e.target.closest('[data-t]'); if (ts) onSeek(Number(ts.dataset.ts)); else if (w) onSeek(Number(w.dataset.t)); }}>
        ${paras.length ? html`<${Words} paras=${paras} />`
          : html`<div class="qc-tx-empty">${working ? html`<span class="spinner" /><b>Writing down everything that's said${pct != null ? ` · ${Math.round(pct * 100)}%` : ''}</b><span class="faint">${note || 'Long videos take a while.'} You can already scrub, cut and export.</span>`
            : status === 'failed' ? html`<b>The transcript didn't work</b><span class="faint">${data?.note || ''}</span><${Button} size="sm" onClick=${onRetry}>Try again</${Button}>`
            : status === 'none' && data?.note ? html`<span class="faint">${data.note}</span>` : html`<span class="spinner" /><span class="faint">Getting the transcript ready…</span>`}</div>`}
      </div>
      ${paras.length ? html`<label class="qc-follow"><input type="checkbox" checked=${follow} onChange=${(e) => this.setState({ follow: e.target.checked })} /> Follow along while it plays · select any words to cut that part</label>` : null}
    </div>`;
  }
}

// ------------------------------------------------------------------ the cutter
function Editor({ id }) {
  const { data: e, reload } = useApi(`/api/clipper/${id}`, ['clipper']);
  const { data: meta } = useApi('/api/clipper', []);
  const { data: wv } = useApi(`/api/clipper/${id}/wave`, []);
  const { data: tx, reload: reloadTx } = useApi(`/api/clipper/${id}/transcript`, ['clipper']);
  const D = e?.info?.duration || 0; const fps = Math.round(e?.info?.fps || 30) || 30;
  const vid = useRef(null); const ruler = useRef(null); const head = useRef(null); const canvas = useRef(null); const stage = useRef(null); const txRef = useRef(null); const root = useRef(null);
  const [inP, setIn] = useState(0); const [outP, setOut] = useState(0);
  const [view, setView] = useState([0, 0]);
  const [playing, setPlaying] = useState(false); const [loop, setLoop] = useState(true);
  const [aspect, setAspect] = useState('none'); const [crop, setCrop] = useState({ x: 0, y: 0, w: 1, h: 1 });
  const [size, setSize] = useState('original'); const [name, setName] = useState(''); const [clientId, setClientId] = useState('');
  const [folder, setFolder] = useState(''); const [job, setJob] = useState(null); const [done, setDone] = useState(null); const [proxyPct, setProxyPct] = useState(null); const [txPct, setTxPct] = useState(null); const [txNote, setTxNote] = useState('');
  const [rw, setRw] = useState(800); const [box, setBox] = useState(null); const [tab, setTab] = useState('text'); const [dragging, setDragging] = useState(null);
  const st = useRef({}); st.current = { inP, outP, view, loop, D, fps, rw };
  const anim = useRef(null);
  // Loop / stop at the end only applies to playback that's inside the cut: playing (or clicking a word) anywhere else in
  // the video plays on freely instead of snapping back to the cut's start.
  const inside = useRef(false);
  // Worked out right when you seek, play or change the cut (the player's own events come too late: a click on a word
  // past the cut was caught by the loop check in between and sent back to the cut's start).
  const markInside = (t) => { const v = vid.current; const s = st.current; const at = t ?? v?.currentTime ?? 0; inside.current = at >= s.inP - 0.05 && at < s.outP - 0.02; };

  useEffect(() => { if (D && !outP) { setOut(D); setView([0, D]); } }, [D]);
  useEffect(() => { markInside(); }, [inP, outP]);
  useEffect(() => { if (meta?.folder && !folder) setFolder(meta.folder); }, [meta]);
  useEffect(() => { const el = ruler.current; if (!el) return; const ro = new ResizeObserver(() => setRw(el.clientWidth)); ro.observe(el); return () => ro.disconnect(); }, [e]);
  useEffect(() => {
    const el = stage.current; if (!el || !e) return;
    const fit = () => { const W = el.clientWidth, H = el.clientHeight, vw = e.info.width, vh = e.info.height; const k = Math.min(W / vw, H / vh); setBox({ x: (W - vw * k) / 2, y: (H - vh * k) / 2, w: vw * k, h: vh * k }); };
    fit(); const ro = new ResizeObserver(fit); ro.observe(el); return () => ro.disconnect();
  }, [e]);

  /** Glide the ruler's view to [a, b] (a quick ease-out, so zooming feels smooth instead of jumping). */
  const glideTo = (a, b) => {
    cancelAnimationFrame(anim.current); const [a0, b0] = st.current.view; const t0 = performance.now(); const dur = 260;
    const step = (now) => { const k = easeOut(Math.min(1, (now - t0) / dur)); setView([a0 + (a - a0) * k, b0 + (b - b0) * k]); if (k < 1) anim.current = requestAnimationFrame(step); };
    anim.current = requestAnimationFrame(step);
  };
  const x = (t) => ((t - view[0]) / Math.max(0.001, view[1] - view[0])) * rw;
  const tAt = (px) => { const [a, b] = st.current.view; return Math.max(0, Math.min(st.current.D, a + (px / st.current.rw) * (b - a))); };

  // playhead every frame (straight on the element), the selection loop, and the transcript following along
  useEffect(() => {
    let raf; let lastTx = 0;
    const tick = (now) => {
      const v = vid.current; const s = st.current;
      if (v && head.current) {
        const t = v.currentTime;
        if (!v.paused && inside.current && t >= s.outP - 0.02) { if (s.loop) v.currentTime = s.inP; else { v.pause(); v.currentTime = s.outP; } }
        const [a, b] = s.view; const px = ((t - a) / Math.max(0.001, b - a)) * s.rw;
        head.current.style.transform = `translateX(${px}px)`; head.current.style.opacity = px < -2 || px > s.rw + 2 ? 0 : 1;
        const tc = document.getElementById('qc-time'); if (tc) tc.textContent = fmt(t);
        if (now - lastTx > 250) { lastTx = now; txRef.current?.tick(t); }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick); return () => cancelAnimationFrame(raf);
  }, []);

  // waveform
  useEffect(() => {
    const c = canvas.current; const peaks = wv?.peaks || []; if (!c || !D) return;
    const dpr = window.devicePixelRatio || 1; c.width = rw * dpr; c.height = 34 * dpr; const g = c.getContext('2d'); g.scale(dpr, dpr); g.clearRect(0, 0, rw, 34);
    if (!peaks.length) return; g.fillStyle = getComputedStyle(c).color || 'rgba(255,255,255,.6)';
    for (let px = 0; px < rw; px += 2) { const t = view[0] + (px / rw) * (view[1] - view[0]); const v = peaks[Math.min(peaks.length - 1, Math.floor((t / D) * peaks.length))] || 0; const h = Math.max(1, v * 30); g.fillRect(px, 17 - h / 2, 1.4, h); }
  }, [wv, view, rw, D]);

  const seek = (t, fast = false) => { const v = vid.current; if (!v) return; t = Math.max(0, Math.min(st.current.D || D, t)); markInside(t); if (fast && v.fastSeek) v.fastSeek(t); else v.currentTime = t; };
  // Reads the newest start/end (st), so Space from the keyboard handler never plays from a stale start.
  const play = (fromIn = false) => {
    const v = vid.current; if (!v) return; if (!v.paused) { v.pause(); return; } const s = st.current;
    // Sitting at the cut's end (where it stopped): start the cut again; anywhere else: play from where you are.
    if (fromIn || Math.abs(v.currentTime - s.outP) < 0.06) v.currentTime = s.inP;
    markInside(v.currentTime); v.play().catch(() => {});
  };
  const frame = 1 / fps;
  /** From the transcript: seek (and bring that moment into view on the ruler). */
  const seekFromText = (t, fromSearch) => {
    seek(t); const [a, b] = st.current.view; const span = b - a;
    if (t < a || t > b) { let na = t - span * 0.3; na = Math.max(0, Math.min(D - span, na)); glideTo(na, na + span); }
    if (!fromSearch) vid.current?.play().catch(() => {});
  };
  const cutFromText = (s, e2) => {
    if (s >= D - 0.1) { toast('That part is past the end of the video.', { kind: 'warn' }); return; }
    e2 = Math.min(D, Math.max(s + 0.2, e2));
    setIn(s); setOut(Math.min(D, e2)); seek(s); setLoop(true);
    const pad = Math.max(1, (e2 - s) * 0.15); glideTo(Math.max(0, s - pad), Math.min(D, e2 + pad));
    toast(`Cut set: ${fmt(s)} → ${fmt(e2)} (${short(e2 - s)})`, { kind: 'ok', ms: 2200 });
  };

  // ruler: mouse, trackpad and touch. One finger/button: handles, selection, scrub. Two fingers: pinch to zoom.
  const pointers = useRef(new Map()); const pinch = useRef(null);
  const down = (ev) => {
    ev.preventDefault(); ruler.current.setPointerCapture?.(ev.pointerId);
    const r = ruler.current.getBoundingClientRect();
    pointers.current.set(ev.pointerId, ev.clientX);
    if (pointers.current.size === 2) { const xs = [...pointers.current.values()]; pinch.current = { d: Math.abs(xs[0] - xs[1]) || 1, mid: (xs[0] + xs[1]) / 2 - r.left, view: [...st.current.view] }; setDragging(null); return; }
    if (ev.pointerType === 'mouse' && ev.button !== 0) return;
    const px = ev.clientX - r.left; const t = tAt(px); const xi = x(inP), xo = x(outP); const touch = ev.pointerType === 'touch' ? 10 : 0;
    let mode = 'scrub'; if (px >= xi - 8 - touch && px <= xi + 18 + touch && px < (xi + xo) / 2) mode = 'in'; else if (px >= xo - 18 - touch && px <= xo + 8 + touch) mode = 'out'; else if (px > xi && px < xo && ev.target.closest('.qc-sel-bar')) mode = 'move';
    const v = vid.current; const was = v && !v.paused; if (v && mode !== 'scrub') v.pause();
    const start = { t, inP, outP }; setDragging(mode);
    const move = (e2) => {
      if (!pointers.current.has(e2.pointerId)) return; pointers.current.set(e2.pointerId, e2.clientX);
      if (pinch.current && pointers.current.size >= 2) {
        const xs = [...pointers.current.values()]; const d = Math.abs(xs[0] - xs[1]) || 1; const pv = pinch.current.view; const span = pv[1] - pv[0];
        const at = pv[0] + (pinch.current.mid / st.current.rw) * span; const ns = Math.max(2, Math.min(st.current.D, span * (pinch.current.d / d)));
        let na = at - (pinch.current.mid / st.current.rw) * ns; na = Math.max(0, Math.min(st.current.D - ns, na)); setView([na, na + ns]); return;
      }
      const t2 = tAt(e2.clientX - r.left); const minLen = frame * 2;
      if (mode === 'scrub') seek(t2, true);
      else if (mode === 'in') { const n = Math.min(t2, st.current.outP - minLen); setIn(n); seek(n, true); }
      else if (mode === 'out') { const n = Math.max(t2, st.current.inP + minLen); setOut(n); seek(n, true); }
      else { const len = start.outP - start.inP; let a = start.inP + (t2 - start.t); a = Math.max(0, Math.min(D - len, a)); setIn(a); setOut(a + len); seek(a, true); }
    };
    const upH = (e2) => {
      pointers.current.delete(e2.pointerId); if (pointers.current.size < 2) pinch.current = null; if (pointers.current.size) return;
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', upH); window.removeEventListener('pointercancel', upH); setDragging(null);
      if (mode === 'scrub') { seek(tAt(e2.clientX - r.left)); if (was) v.play().catch(() => {}); }
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', upH); window.addEventListener('pointercancel', upH);
    if (mode === 'scrub') seek(t, true);
  };
  const wheel = (ev) => {
    ev.preventDefault(); const r = ruler.current.getBoundingClientRect(); const [a, b] = st.current.view; const span = b - a; const Dd = st.current.D;
    if (ev.ctrlKey || ev.metaKey) {
      const at = a + ((ev.clientX - r.left) / r.width) * span; const k = Math.exp(ev.deltaY * 0.01); const ns = Math.max(2, Math.min(Dd, span * k));
      let na = at - ((at - a) / span) * ns; na = Math.max(0, Math.min(Dd - ns, na)); setView([na, na + ns]);
    } else { const d = ((ev.deltaX || ev.deltaY) / r.width) * span; const na = Math.max(0, Math.min(Dd - span, a + d)); setView([na, na + span]); }
  };
  useEffect(() => { const el = ruler.current; if (!el) return; el.addEventListener('wheel', wheel, { passive: false }); return () => el.removeEventListener('wheel', wheel); }, [e, D]);
  const zoomBy = (k) => { const [a, b] = view; const span = b - a; const c = vid.current?.currentTime ?? (a + b) / 2; const ns = Math.max(2, Math.min(D, span * k)); let na = c - ns / 2; na = Math.max(0, Math.min(D - ns, na)); glideTo(na, na + ns); };
  const fitSel = () => { const pad = Math.max(1, (outP - inP) * 0.08); glideTo(Math.max(0, inP - pad), Math.min(D, outP + pad)); };

  useEffect(() => {
    const k = (ev) => {
      if (/input|textarea|select/i.test(ev.target.tagName) || ev.ctrlKey || ev.metaKey) return;
      const scr = root.current?.closest('.screen'); if (scr && !scr.classList.contains('on')) return;
      const v = vid.current; if (!v) return; const s = st.current;
      if (ev.key === ' ') { ev.preventDefault(); play(); }
      else if (ev.key === 'i' || ev.key === 'I') setIn(Math.min(v.currentTime, s.outP - 2 / s.fps));
      else if (ev.key === 'o' || ev.key === 'O') setOut(Math.max(v.currentTime, s.inP + 2 / s.fps));
      else if (ev.key === 'ArrowLeft') { ev.preventDefault(); v.pause(); seek(v.currentTime - (ev.shiftKey ? 1 : 1 / s.fps)); }
      else if (ev.key === 'ArrowRight') { ev.preventDefault(); v.pause(); seek(v.currentTime + (ev.shiftKey ? 1 : 1 / s.fps)); }
      else if (ev.key === 'Home') seek(s.inP); else if (ev.key === 'End') seek(s.outP);
      else if (ev.key === 'l' || ev.key === 'L') setLoop((v2) => !v2);
    };
    window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k);
  }, [e]);

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

  useEvent('job', (j) => {
    if (job && j.id === job.id) setJob({ ...job, ...j });
    if (j.type === 'clipper.proxy' && j.status === 'running') setProxyPct(j.progress || 0);
    if (j.type === 'clipper.transcribe' && (j.status === 'running' || j.status === 'queued')) { setTxPct(j.progress || 0); setTxNote(j.status === 'queued' ? (j.note && !/^Recovered/.test(j.note) ? `Waiting its turn: ${j.note}` : 'Waiting its turn (one transcript at a time, after work already running)') : j.note || ''); }
    if (j.type === 'clipper.transcribe' && ['done', 'failed'].includes(j.status)) { setTxPct(null); reloadTx(); reload(); }
  }, [job]);
  useEvent('clipper.exported', (x2) => { if (x2.id === id) { setDone(x2.path); setJob(null); toast(`Saved: ${x2.path}`, { kind: 'ok', title: 'Cut exported' }); } }, [id]);
  useEvent('clipper', (x2) => { if (x2.id === id) { setProxyPct(null); reload(); reloadTx(); } }, [id]);
  const doExport = async () => {
    setDone(null);
    const j = await act(() => api.post(`/api/clipper/${id}/export`, { start: inP, end: outP, crop: aspect === 'none' ? null : crop, aspect: aspect === 'none' || aspect === 'free' ? null : aspect, size, name, folder, clientId: clientId || null }));
    if (j?.id) setJob({ id: j.id, progress: 0, status: 'queued' });
  };
  const chooseFolder = async () => { const r = await act(() => api.post('/api/system/pick-folder', { title: 'Save cuts in…', defaultPath: folder })); if (r?.path) setFolder(r.path); };

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
  const txStatus = tx?.status === 'ready' ? 'ready' : e.tx?.status === 'working' || txPct != null ? 'working' : e.tx?.status || tx?.status || 'queued';
  return html`<div class="qc" ref=${root}>
    <div class="qc-top">
      <${Button} kind="ghost" size="sm" icon="chevronLeft" onClick=${() => navigate('/clipper')}>Videos</${Button}>
      <b class="ellipsis" style="max-width:420px">${e.name}</b><span class="faint tnum" style="font-size:var(--fs-sm)">${e.info.width}×${e.info.height} · ${short(D)}</span>
      <span class="grow" />
      ${txStatus === 'working' ? html`<span class="badge sky">Transcript ${txPct != null ? `${Math.round(txPct * 100)}%` : '…'}</span>` : null}
      ${e.proxyPending && srcPath ? html`<span class="badge gold" title="A light copy for smoother scrubbing; you can keep working meanwhile">Smoothing playback${proxyPct != null ? ` ${Math.round(proxyPct * 100)}%` : '…'}</span>` : null}
    </div>
    <div class="qc-main">
      <div class="qc-stage" ref=${stage} onClick=${() => play()}>
        ${!srcPath ? html`<div class="qc-wait"><span class="spinner" /> This video needs a preview copy before it can play here${proxyPct != null ? ` (${Math.round(proxyPct * 100)}%)` : ''}. You can already search the transcript and set the start and end.</div>` : null}
        <video ref=${vid} src=${src} preload="auto" playsinline onPlay=${() => setPlaying(true)} onPause=${() => setPlaying(false)} style=${box ? { position: 'absolute', left: box.x + 'px', top: box.y + 'px', width: box.w + 'px', height: box.h + 'px' } : { width: '100%', height: '100%' }} />
        ${box && aspect !== 'none' ? html`<div class="qc-crop" style=${{ left: box.x + crop.x * box.w + 'px', top: box.y + crop.y * box.h + 'px', width: crop.w * box.w + 'px', height: crop.h * box.h + 'px' }} onPointerDown=${(ev) => cropDown(ev, null)} onClick=${(ev) => ev.stopPropagation()}>
          ${['tl', 'tr', 'bl', 'br'].map((c) => html`<i class=${'qc-cr ' + c} onPointerDown=${(ev) => cropDown(ev, c)} />`)}<span class="qc-crop-grid" /></div>` : null}
      </div>
      <div class="qc-side">
        <div class="qc-tabs"><${Seg} value=${tab} onChange=${setTab} options=${[{ value: 'text', label: 'Transcript' }, { value: 'cut', label: 'Crop & export' }]} /></div>
        <div style=${{ display: tab === 'text' ? 'flex' : 'none', flex: 1, minHeight: 0 }}>
          <${Transcript} ref=${txRef} data=${tx} status=${txStatus} pct=${txPct} note=${txNote} onSeek=${seekFromText} onCut=${cutFromText} onRetry=${() => act(() => api.post(`/api/clipper/${id}/transcript`, {}), { ok: 'Writing the transcript again' }).then(() => { reload(); reloadTx(); })} />
        </div>
        <div class="qc-cutpanel" style=${{ display: tab === 'cut' ? 'flex' : 'none' }}>
          <div class="qc-card2"><b>Crop</b><${Seg} value=${aspect} onChange=${setAsp} options=${ASPECTS} /><span class="faint" style="font-size:var(--fs-xs)">${aspect === 'none' ? 'The whole frame.' : 'Drag the box to move it, the corners to resize.'}</span></div>
          <div class="qc-card2"><b>Export</b>
            <input class="input" placeholder=${`${e.name.replace(/\.[^.]+$/, '')} (name, optional)`} value=${name} onInput=${(ev) => setName(ev.target.value)} />
            <div class="row" style="gap:6px;align-items:center"><span class="faint" style="font-size:var(--fs-xs);width:44px">Size</span><${Seg} value=${size} onChange=${setSize} options=${[{ value: 'original', label: 'Original' }, { value: '1080', label: '1080' }, { value: '720', label: '720' }]} /></div>
            <div class="row" style="gap:6px;align-items:center"><span class="faint ellipsis grow" style="font-size:var(--fs-xs)" title=${folder}>Saves to ${folder}</span>${meta?.desktop ? html`<${Button} size="sm" kind="ghost" onClick=${chooseFolder}>Change</${Button}>` : null}</div>
            <select class="input" value=${clientId} onChange=${(ev) => setClientId(ev.target.value)}><option value="">Don't add to Production</option>${(meta?.clients || []).map((c) => html`<option value=${c.id}>Also add to Production: ${c.name}</option>`)}</select>
          </div>
        </div>
        <div class="qc-export">
          <${Button} kind="primary" icon="download" busy=${exporting} disabled=${exporting} onClick=${doExport}>${exporting ? `Exporting ${Math.round((job.progress || 0) * 100)}%` : `Export ${fmt(outP - inP)}${aspect !== 'none' ? ` · ${aspect}` : ''}`}</${Button}>
          ${job?.status === 'failed' ? html`<span style="color:var(--coral);font-size:var(--fs-xs)">${job.error || 'The export failed.'}</span>` : null}
          ${done ? html`<span class="faint selectable ellipsis" style="font-size:var(--fs-xs)" title=${done}>Saved: ${done}</span>` : null}
        </div>
      </div>
    </div>
    <div class="qc-bar">
      <button type="button" class="qc-play" title="Play / pause (Space)" onClick=${() => play()}><${Icon} name=${playing ? 'pause' : 'play'} size=${18} /></button>
      <button type="button" class="qc-ib" title="Back one frame (←)" onClick=${() => { vid.current?.pause(); seek((vid.current?.currentTime || 0) - frame); }}><${Icon} name="chevronLeft" size=${16} /></button>
      <button type="button" class="qc-ib" title="Forward one frame (→)" onClick=${() => { vid.current?.pause(); seek((vid.current?.currentTime || 0) + frame); }}><${Icon} name="chevronRight" size=${16} /></button>
      <span id="qc-time" class="tnum qc-tc">0:00.00</span>
      <div class="qc-times">
        <label>Start<input class="input tnum" value=${fmt(inP)} onChange=${(ev) => { const v = parse(ev.target.value); if (v != null) setIn(Math.max(0, Math.min(outP - 0.1, v))); }} /></label>
        <label>End<input class="input tnum" value=${fmt(outP)} onChange=${(ev) => { const v = parse(ev.target.value); if (v != null) setOut(Math.min(D, Math.max(inP + 0.1, v))); }} /></label>
        <label>Length<input class="input tnum" value=${fmt(outP - inP)} onChange=${(ev) => { const v = parse(ev.target.value); if (v != null && v > 0.1) setOut(Math.min(D, inP + v)); }} /></label>
      </div>
      <${Button} size="sm" kind="ghost" onClick=${() => setIn(Math.min(vid.current?.currentTime || 0, outP - 0.1))}>Start here</${Button}><${Button} size="sm" kind="ghost" onClick=${() => setOut(Math.max(vid.current?.currentTime || 0, inP + 0.1))}>End here</${Button}>
      <button type="button" class=${'chip' + (loop ? ' on' : '')} title="Loop the selection (L)" onClick=${() => setLoop(!loop)}>Loop</button>
      <span class="grow" />
      <${Button} size="sm" kind="ghost" onClick=${() => zoomBy(1.6)}>−</${Button}><${Button} size="sm" kind="ghost" onClick=${() => zoomBy(1 / 1.6)}>+</${Button}>
      <${Button} size="sm" kind="ghost" onClick=${fitSel}>Zoom to cut</${Button}><${Button} size="sm" kind="ghost" onClick=${() => glideTo(0, D)}>Whole video</${Button}>
    </div>
    <div class=${'qc-ruler' + (dragging ? ` dragging-${dragging}` : '')} ref=${ruler} onPointerDown=${down}>
      <div class="qc-ticks">${ticks.map((t) => html`<span style=${{ left: x(t) + 'px' }}>${step < 1 ? `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}` : short(t)}</span>`)}</div>
      <div class="qc-strip" style=${{ backgroundImage: `url(${api.url(`/api/clipper/${id}/strip`)})`, backgroundSize: `${stripW}px 100%`, backgroundPositionX: `${stripX}px` }} />
      <canvas ref=${canvas} class="qc-wave" style=${{ width: rw + 'px' }} />
      <div class="qc-shade" style=${{ left: 0, width: Math.max(0, xi) + 'px' }} /><div class="qc-shade" style=${{ left: Math.min(rw, xo) + 'px', right: 0 }} />
      <div class="qc-sel" style=${{ left: xi + 'px', width: Math.max(0, xo - xi) + 'px' }}><div class="qc-sel-bar" /><i class="qc-h l" /><i class="qc-h r" /></div>
      <div class="qc-head" ref=${head}><i /></div>
    </div>
    <div class="qc-hint faint">Drag the yellow handles · drag the top of the frame to move it · pinch or Ctrl+scroll to zoom · Space play · ← → one frame · Ctrl+F search what they say</div>
  </div>`;
}
