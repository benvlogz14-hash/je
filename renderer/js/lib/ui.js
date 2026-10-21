// Shared components and hooks.
import { h, render, createContext } from '../../vendor/preact.mjs';
import { useState, useEffect, useRef, useCallback, useMemo, useLayoutEffect, useContext } from '../../vendor/hooks.mjs';
import htm from '../../vendor/htm.mjs';
import { api } from './api.js';
import { play } from './sound.js';
import { Icon } from './icons.js';

export const html = htm.bind(h);
export { h, render, useState, useEffect, useRef, useCallback, useMemo, useLayoutEffect };

/** Each open screen tab gets its own route, so a hidden screen keeps its place while you work in another. */
export const RouteContext = createContext(null);
export function useRoute() { const own = useContext(RouteContext); const global = useStore((s) => s.route); return own || global; }

// ------------------------------------------------------------ global store
const state = { boot: null, route: { path: '/messages', query: {} }, toasts: [], online: true, typing: {}, modal: null };
const subs = new Set();
export const store = {
  get: () => state,
  set(patch) { Object.assign(state, typeof patch === 'function' ? patch(state) : patch); for (const fn of subs) fn(); },
  sub(fn) { subs.add(fn); return () => subs.delete(fn); },
};
export function useStore(sel) {
  const [, force] = useState(0);
  const last = useRef(sel(state));
  useEffect(() => store.sub(() => { const v = sel(state); if (v !== last.current) { last.current = v; force((n) => n + 1); } }), []);
  last.current = sel(state);
  return last.current;
}

// ------------------------------------------------------------ router (hash based; works in Electron, browser and the demo)
export function navigate(path) {
  // The interactive example keeps routing in memory (its host frame only passes plain anchors).
  if (window.EUCLIDEAN_DEMO) { const [p, q] = path.split('?'); store.set({ route: { path: p, query: Object.fromEntries(new URLSearchParams(q || '')) } }); return; }
  if (location.hash !== '#' + path) location.hash = path;
}
function parseHash() {
  const raw = location.hash.replace(/^#/, '') || '/messages';
  const [p, q] = raw.split('?');
  return { path: p, query: Object.fromEntries(new URLSearchParams(q || '')) };
}
if (!window.EUCLIDEAN_DEMO) { window.addEventListener('hashchange', () => store.set({ route: parseHash() })); store.set({ route: parseHash() }); }

// ------------------------------------------------------------ data hooks
/** Fetch a path, refetch when any of the given live event types arrive. */
export function useApi(path, events = [], deps = []) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const t = useRef(null); const alive = useRef(true);
  const load = useCallback(async () => {
    if (!path) { setLoading(false); return; }
    try { const d = await api.get(path); if (alive.current) { setData(d); setError(null); } }
    catch (e) { if (alive.current) setError(e); }
    finally { if (alive.current) setLoading(false); }
  }, [path]);
  useEffect(() => { alive.current = true; setLoading(true); load(); return () => { alive.current = false; }; }, [path, ...deps]);
  useEffect(() => {
    const offs = events.map((ev) => api.on(ev, () => { clearTimeout(t.current); t.current = setTimeout(load, 250); }));
    return () => { offs.forEach((o) => o()); clearTimeout(t.current); };
  }, [path, events.join(',')]);
  return { data, error, loading, reload: load, setData };
}
export function useEvent(type, fn, deps = []) { useEffect(() => api.on(type, fn), deps); }

/** Run an async action with toast feedback and sound. */
export async function act(fn, { ok, sound = 'success', quiet = false } = {}) {
  try {
    const r = await fn();
    if (ok) toast(typeof ok === 'function' ? ok(r) : ok, { kind: 'ok' });
    if (sound) play(sound);
    return r;
  } catch (e) {
    play('error');
    if (!quiet) toast(e.message || 'Something went wrong', { kind: 'error', title: 'Could not complete that' });
    throw e;
  }
}

// ------------------------------------------------------------ toasts
let toastId = 0;
export function toast(text, { kind = 'info', title, ms = 4200 } = {}) {
  const id = ++toastId;
  store.set((s) => ({ toasts: [...s.toasts, { id, text, kind, title }] }));
  setTimeout(() => store.set((s) => ({ toasts: s.toasts.map((t) => (t.id === id ? { ...t, out: true } : t)) })), ms);
  setTimeout(() => store.set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), ms + 220);
}
export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const icon = { ok: ['check', 'var(--moss)'], error: ['alert', 'var(--coral)'], warn: ['alert', 'var(--gold)'], info: ['info', 'var(--slate)'] };
  return html`<div class="toasts" role="status" aria-live="polite">${toasts.map((t) => html`
    <div class=${'toast' + (t.out ? ' out' : '')} key=${t.id}>
      <span style=${{ color: icon[t.kind]?.[1], marginTop: '1px' }}><${Icon} name=${icon[t.kind]?.[0] || 'info'} size=${17} /></span>
      <div class="grow">${t.title ? html`<div class="t">${t.title}</div><div class="b">${t.text}</div>` : html`<div>${t.text}</div>`}</div>
    </div>`)}</div>`;
}

// ------------------------------------------------------------ buttons
function ripple(e) {
  const b = e.currentTarget; const r = b.getBoundingClientRect();
  const d = Math.max(r.width, r.height); const s = document.createElement('span');
  s.className = 'ripple'; s.style.width = s.style.height = d + 'px';
  s.style.left = (e.clientX - r.left - d / 2) + 'px'; s.style.top = (e.clientY - r.top - d / 2) + 'px';
  b.appendChild(s); setTimeout(() => s.remove(), 560);
}
export function Button({ kind = '', size = '', icon, iconRight, children, onClick, title, disabled, busy, type = 'button', sound = 'tap', class: cls = '', style, ...rest }) {
  const [pending, setPending] = useState(false);
  const click = async (e) => {
    if (disabled || pending) return;
    ripple(e); if (sound) play(sound);
    if (!onClick) return;
    const r = onClick(e);
    if (r && typeof r.then === 'function') { setPending(true); try { await r; } catch { /* surfaced by act() */ } finally { setPending(false); } }
  };
  const isBusy = busy || pending;
  return html`<button type=${type} class=${`btn ${kind} ${size} ${!children ? 'icon' : ''} ${cls}`} onClick=${click} title=${title} aria-label=${title} disabled=${disabled} style=${style} ...${rest}>
    ${isBusy ? html`<span class="spinner" />` : icon ? html`<${Icon} name=${icon} size=${size === 'sm' ? 15 : 17} />` : null}
    ${children}${iconRight && !isBusy ? html`<${Icon} name=${iconRight} size=${15} />` : null}</button>`;
}

/** Press-and-hold to confirm. Used for consequential actions (emergency stop, sending outreach, publishing now). */
export function HoldButton({ kind = 'coral', size = '', icon, children, onConfirm, ms = 900, title, disabled }) {
  const [holding, setHolding] = useState(false);
  const timer = useRef(null); const ticks = useRef(null);
  const start = (e) => {
    if (disabled) return; e.preventDefault();
    setHolding(true); play('press');
    ticks.current = setInterval(() => play('holdTick'), ms / 4);
    timer.current = setTimeout(async () => { clearInterval(ticks.current); setHolding(false); play('confirm'); await onConfirm?.(); }, ms);
  };
  const cancel = () => { clearTimeout(timer.current); clearInterval(ticks.current); setHolding(false); };
  return html`<button type="button" class=${`btn hold ${kind} ${size} ${holding ? 'holding pressed' : ''}`} style=${{ '--hold': ms + 'ms' }} title=${title || 'Press and hold'} disabled=${disabled}
    onPointerDown=${start} onPointerUp=${cancel} onPointerLeave=${cancel} onKeyDown=${(e) => { if ((e.key === 'Enter' || e.key === ' ') && !holding) start(e); }} onKeyUp=${cancel}>
    <span class="hold-fill" />${icon ? html`<${Icon} name=${icon} size=${size === 'sm' ? 15 : 17} />` : null}${children}</button>`;
}

export function Toggle({ on, onChange, label, disabled }) {
  return html`<button type="button" role="switch" aria-checked=${!!on} aria-label=${label} class=${'toggle' + (on ? ' on' : '')} disabled=${disabled} onClick=${() => { play('toggle'); onChange?.(!on); }} />`;
}
export function Seg({ value, options, onChange }) {
  return html`<div class="btn-group" role="tablist">${options.map((o) => html`<button type="button" role="tab" aria-selected=${value === o.value} class=${value === o.value ? 'on' : ''} onClick=${() => { if (value !== o.value) { play('tap'); onChange(o.value); } }}>${o.icon ? html`<${Icon} name=${o.icon} size=${14} />` : null}${o.label}</button>`)}</div>`;
}
export function Tabs({ value, tabs, onChange }) {
  return html`<div class="tabs" role="tablist">${tabs.map((t) => html`<button type="button" role="tab" aria-selected=${value === t.value} class=${'tab' + (value === t.value ? ' on' : '')} onClick=${() => { play('tap'); onChange(t.value); }}>${t.label}${t.badge ? html`<span class="badge coral">${t.badge}</span>` : null}</button>`)}</div>`;
}

// ------------------------------------------------------------ overlays
export function Modal({ title, onClose, children, footer, wide, icon }) {
  useEffect(() => { play('open'); const k = (e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose?.(); } }; window.addEventListener('keydown', k, true); return () => { window.removeEventListener('keydown', k, true); play('close'); }; }, []);
  return html`<div class="scrim" onClick=${onClose} /><div class=${'modal' + (wide ? ' wide' : '')} role="dialog" aria-modal="true" aria-label=${title}>
    <div class="modal-head">${icon ? html`<${Icon} name=${icon} size=${19} />` : null}<h3 class="grow">${title}</h3><${Button} kind="ghost" size="sm" icon="x" title="Close" onClick=${onClose} /></div>
    <div class="modal-body">${children}</div>${footer ? html`<div class="modal-foot">${footer}</div>` : null}</div>`;
}
export function Drawer({ title, sub, onClose, children, actions, wide }) {
  useEffect(() => { play('open'); const k = (e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose?.(); } }; window.addEventListener('keydown', k, true); return () => window.removeEventListener('keydown', k, true); }, []);
  return html`<div class="scrim" onClick=${onClose} /><aside class=${'drawer' + (wide ? ' wide' : '')} role="dialog" aria-label=${typeof title === 'string' ? title : 'Details'}>
    <div class="drawer-head"><div class="grow" style="min-width:0"><h3 class="ellipsis">${title}</h3>${sub ? html`<div class="muted" style="font-size:var(--fs-sm)">${sub}</div>` : null}</div>${actions}<${Button} kind="ghost" size="sm" icon="x" title="Close" onClick=${onClose} /></div>
    <div class="drawer-body">${children}</div></aside>`;
}
/** In-app confirmation (the platform's confirm() is not used anywhere). */
export function confirmDialog({ title, text, confirm = 'Confirm', kind = 'coral' }) {
  return new Promise((resolve) => {
    const close = (v) => { store.set({ modal: null }); resolve(v); };
    store.set({ modal: html`<${Modal} title=${title} onClose=${() => close(false)} footer=${html`<${Button} kind="ghost" onClick=${() => close(false)}>Cancel</${Button}><${Button} kind=${kind} onClick=${() => close(true)}>${confirm}</${Button}>`}><p class="muted">${text}</p></${Modal}>` });
  });
}
export function promptDialog({ title, label, value = '', placeholder, confirm = 'Save', multiline }) {
  return new Promise((resolve) => {
    let v = value;
    const close = (r) => { store.set({ modal: null }); resolve(r); };
    store.set({ modal: html`<${Modal} title=${title} onClose=${() => close(null)} footer=${html`<${Button} kind="ghost" onClick=${() => close(null)}>Cancel</${Button}><${Button} kind="primary" onClick=${() => close(v)}>${confirm}</${Button}>`}>
      <div class="field">${label ? html`<label for="prompt-field">${label}</label>` : null}${multiline
        ? html`<textarea id="prompt-field" class="textarea" rows="4" placeholder=${placeholder} onInput=${(e) => { v = e.target.value; }} autofocus>${value}</textarea>`
        : html`<input id="prompt-field" class="input" value=${value} placeholder=${placeholder} onInput=${(e) => { v = e.target.value; }} onKeyDown=${(e) => { if (e.key === 'Enter') close(v); }} autofocus />`}</div></${Modal}>` });
  });
}
export function ModalHost() { const m = useStore((s) => s.modal); return m || null; }

let menuEl = null;
/** Context / overflow menu. items: [{label, icon, onClick, danger}] or 'sep'. */
export function openMenu(e, items) {
  e.preventDefault(); e.stopPropagation(); closeMenu(); play('tap');
  menuEl = document.createElement('div'); document.body.appendChild(menuEl);
  const x = Math.min(e.clientX, innerWidth - 250), y = Math.max(8, Math.min(e.clientY, innerHeight - items.filter(Boolean).length * 30 - 20));
  render(html`<div class="menu" style=${{ left: x + 'px', top: y + 'px' }} onClick=${(ev) => ev.stopPropagation()}>${items.filter(Boolean).map((it) => it === 'sep' ? html`<hr />` : it.heading ? html`<div class="menu-heading">${it.heading}</div>` : html`<button class=${it.danger ? 'danger' : ''} disabled=${it.disabled} onClick=${() => { if (it.disabled) return; closeMenu(); play('tap'); it.onClick(); }}>${it.icon ? html`<${Icon} name=${it.icon} size=${15} />` : html`<span style="width:15px" />`}<span class="grow">${it.label}</span>${it.hint ? html`<span class="menu-hint">${it.hint}</span>` : null}</button>`)}</div>`, menuEl);
  setTimeout(() => window.addEventListener('pointerdown', onAway, { once: true }), 0);
}
function onAway(e) { if (menuEl && !menuEl.contains(e.target)) closeMenu(); else if (menuEl) window.addEventListener('pointerdown', onAway, { once: true }); }
export function closeMenu() { if (menuEl) { render(null, menuEl); menuEl.remove(); menuEl = null; } }

// ------------------------------------------------------------ bits
/** CSS class giving a command group its own pastel. */
export const gcls = (group) => 'g-' + String(group || 'system').toLowerCase();
export function cmdGroup(text) { const name = String(text || '').replace(/^\//, '').split(' ')[0]; return (store.get().boot?.commands || []).find((c) => c.name === name)?.group || 'System'; }
const AV_COLORS = [['--teal-soft', '--teal-ink'], ['--gold-soft', '--gold-ink'], ['--moss-soft', '--moss-ink'], ['--coral-soft', '--coral-ink'], ['--slate-soft', '--slate-ink'], ['--lav-soft', '--lav-ink']];
export function hashColor(s) { let x = 0; for (const c of String(s || '')) x = (x * 31 + c.charCodeAt(0)) >>> 0; return AV_COLORS[x % AV_COLORS.length]; }
export function Avatar({ name = '?', size = '', icon }) {
  const [bg, fg] = hashColor(name);
  const initials = String(name).replace(/[^\p{L}\p{N} ]/gu, '').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';
  return html`<div class=${'avatar ' + size} style=${{ background: `var(${bg})`, color: `var(${fg})` }}>${icon ? html`<${Icon} name=${icon} size=${size === 'sm' ? 14 : 17} />` : initials}</div>`;
}
export function Empty({ icon = 'info', title, children, action }) {
  return html`<div class="empty"><div class="glyph"><${Icon} name=${icon} size=${24} /></div><h3>${title}</h3>${children ? html`<p>${children}</p>` : null}${action || null}</div>`;
}
export function Progress({ value, indeterminate, color }) {
  return html`<div class=${'progress' + (indeterminate ? ' indeterminate' : '')}><i style=${{ width: `${Math.round((value || 0) * 100)}%`, background: color }} /></div>`;
}
export function Field({ label, hint, children, id }) {
  return html`<div class="field">${label ? html`<label for=${id}>${label}</label>` : null}${children}${hint ? html`<div class="hint">${hint}</div>` : null}</div>`;
}
export function Loading({ rows = 4 }) {
  return html`<div class="col" style="gap:10px;padding:8px">${Array.from({ length: rows }, (_, i) => html`<div class="skeleton" style=${{ height: '44px', opacity: 1 - i * 0.15 }} />`)}</div>`;
}

const STATUS = {
  queued: ['slate', 'Queued'], rendering: ['teal', 'Rendering'], review: ['gold', 'In review'], client_review: ['lav', 'Client review'], revising: ['teal', 'Revising'],
  approved: ['moss', 'Approved'], scheduled: ['moss', 'Scheduled'], published: ['slate', 'Published'], rejected: ['coral', 'Rejected'], candidate: ['slate', 'Candidate'],
  running: ['teal', 'Running'], done: ['moss', 'Done'], failed: ['coral', 'Failed'], canceled: ['', 'Canceled'], waiting_agent: ['lav', 'Waiting for agent'], publishing: ['teal', 'Publishing'],
  pending_approval: ['gold', 'Needs approval'], sent: ['moss', 'Sent'], received: ['', 'Received'], discarded: ['', 'Discarded'],
  active: ['moss', 'Active'], lead: ['slate', 'Lead'], proposal: ['gold', 'Proposal'], paused: ['', 'Paused'], churned: ['coral', 'Churned'],
  ok: ['moss', 'OK'], warn: ['gold', 'Warning'], error: ['coral', 'Error'], draft: ['', 'Draft'], paid: ['moss', 'Paid'], void: ['', 'Void'], importing: ['teal', 'Importing'], ready: ['moss', 'Ready'], transcribing: ['teal', 'Transcribing'],
};
export function StatusBadge({ status, label }) {
  const [c, l] = STATUS[status] || ['', status];
  return html`<span class=${'badge ' + c}><span class="led" style=${{ background: c ? `var(--${c})` : 'var(--ink-3)' }} />${label || l}</span>`;
}

/** Simple sparkline (area + line + endpoint), colored from tokens. */
export function Sparkline({ values = [], width = 120, height = 32, color = 'var(--teal)', max }) {
  if (!values.length) return html`<svg width=${width} height=${height} />`;
  const m = max ?? Math.max(1, ...values); const step = width / Math.max(1, values.length - 1);
  const pts = values.map((v, i) => [i * step, height - 2 - (Math.max(0, v) / m) * (height - 4)]);
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('');
  const last = pts[pts.length - 1];
  return html`<svg class="spark" width=${width} height=${height} viewBox=${`0 0 ${width} ${height}`} aria-hidden="true">
    <path d=${`${line}L${width},${height}L0,${height}Z`} fill=${color} opacity="0.12" />
    <path d=${line} fill="none" stroke=${color} stroke-width="1.6" stroke-linejoin="round" />
    <circle cx=${last[0]} cy=${last[1]} r="2.6" fill=${color} /></svg>`;
}

/** Bar chart with a single linear scale and labelled ticks. */
export function BarChart({ data = [], height = 180, color = 'var(--teal)', format = (v) => v.toLocaleString() }) {
  const W = 640, H = height, padL = 44, padB = 22, padT = 8;
  const max = Math.max(1, ...data.map((d) => d.value));
  const nice = (v) => { const p = 10 ** Math.floor(Math.log10(v)); return Math.ceil(v / p) * p; };
  const top = nice(max); const ticks = [0, top / 2, top];
  const bw = (W - padL - 8) / Math.max(1, data.length);
  const y = (v) => padT + (H - padT - padB) * (1 - v / top);
  return html`<svg class="chart" viewBox=${`0 0 ${W} ${H}`} preserveAspectRatio="none" style=${{ height: H + 'px' }} role="img">
    <g class="grid">${ticks.map((t) => html`<line x1=${padL} x2=${W - 4} y1=${y(t)} y2=${y(t)} /><text x=${padL - 8} y=${y(t) + 3.5} text-anchor="end">${format(t)}</text>`)}</g>
    ${data.map((d, i) => html`<rect x=${padL + i * bw + bw * 0.18} y=${y(d.value)} width=${bw * 0.64} height=${Math.max(0, H - padB - y(d.value))} rx="3" fill=${d.color || color}><title>${d.label}: ${format(d.value)}</title></rect>
      ${data.length <= 16 || i % Math.ceil(data.length / 12) === 0 ? html`<text x=${padL + i * bw + bw / 2} y=${H - 6} text-anchor="middle">${d.label}</text>` : null}`)}
  </svg>`;
}
