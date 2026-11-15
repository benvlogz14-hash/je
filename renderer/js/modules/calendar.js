// Calendar (Nov 15, Ryan: "revamp the calendar ... easily add and remove things to it, use it like Google Calendar,
// sync with Gmail"). Day / Week / Month like Google Calendar: click or drag on an empty time to add, drag an event to
// move it, drag its bottom edge to change its length, click it to see, change or delete it (with Undo), type an event
// in plain words, and the scheduled posts on the same grid. Events: server/automation/calendar.js (our own, HAL's,
// Google Calendar both ways, read-only calendar links); posts: /api/posts (moving one reschedules it).
import { html, useState, useEffect, useRef, useMemo, useApi, navigate, Button, Modal, Field, StatusBadge, act, toast, Seg, Toggle } from '../lib/ui.js';
import { api } from '../lib/api.js';
import { Icon } from '../lib/icons.js';
import { dateTime, PLATFORM_LABEL } from '../lib/format.js';
import { play } from '../lib/sound.js';
import { YouTubePost, HoldBanner } from './ytpost.js';

const HOUR = 48; const SNAP = 15; const GUTTER = 56;
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const day0 = (s) => new Date(`${s}T00:00`);
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const minOf = (t) => { const [h, m] = String(t || '0:0').split(':').map(Number); return (h || 0) * 60 + (m || 0); };
const tOf = (n) => `${pad(Math.floor(Math.max(0, Math.min(1439, n)) / 60))}:${pad(Math.max(0, Math.min(1439, n)) % 60)}`;
const snap = (n) => Math.round(n / SNAP) * SNAP;
const monday = (d) => addDays(new Date(d.getFullYear(), d.getMonth(), d.getDate()), -((d.getDay() + 6) % 7));
const label12 = (t) => { const m = minOf(t); const h = Math.floor(m / 60); const mi = m % 60; return `${h % 12 || 12}${mi ? ':' + pad(mi) : ''}${h < 12 ? 'am' : 'pm'}`; };
const COLORS = ['teal', 'sky', 'lav', 'rose', 'gold', 'moss', 'coral', 'slate'];
const POST_COLOR = { scheduled: 'moss', held: 'gold', publishing: 'sky', published: 'slate' };
const loadLayers = () => { try { return { events: true, posts: true, feeds: true, ...JSON.parse(localStorage.getItem('eu.calLayers') || '{}') }; } catch { return { events: true, posts: true, feeds: true }; } };

/** Days an item covers (date strings), and its start/end as minutes on its first/last day. */
function span(it) { return { a: it.date, b: it.endDate || it.date, s: it.allDay ? 0 : minOf(it.time), e: it.allDay ? 1440 : minOf(it.end) }; }
const onRow = (it) => it.allDay || ((it.endDate || it.date) > it.date && (day0(it.endDate) - day0(it.date)) / 864e5 * 1440 + minOf(it.end) - minOf(it.time) >= 1440);

/** Side-by-side columns for overlapping events in one day (the usual calendar layout). */
function layout(segs) {
  segs.sort((x, y) => x.s - y.s || y.e - x.e); const out = []; let cl = []; let end = -1;
  const flush = () => { const cols = []; for (const g of cl) { let c = cols.findIndex((e) => e <= g.s); if (c < 0) { c = cols.length; cols.push(0); } cols[c] = Math.max(g.e, g.s + 20); g.col = c; } for (const g of cl) g.cols = cols.length; out.push(...cl); cl = []; };
  for (const g of segs) { if (g.s >= end && cl.length) flush(); cl.push(g); end = Math.max(end, g.e, g.s + 20); }
  if (cl.length) flush(); return out;
}
/** All-day / multi-day bars stacked into rows across a run of days. */
function bars(items, days) {
  const idx = new Map(days.map((d, i) => [ymd(d), i])); const first = ymd(days[0]), last = ymd(days[days.length - 1]); const rows = []; const out = [];
  for (const it of items.slice().sort((x, y) => x.date.localeCompare(y.date) || (y.endDate || y.date).localeCompare(x.endDate || x.date))) {
    const a = it.date < first ? 0 : idx.get(it.date); const b = (it.endDate || it.date) > last ? days.length - 1 : idx.get(it.endDate || it.date); if (a == null || b == null) continue;
    let r = rows.findIndex((e) => e < a); if (r < 0) { r = rows.length; rows.push(-1); } rows[r] = b; out.push({ it, a, b, r });
  }
  return { out, rows: rows.length };
}

export function Calendar() {
  const [view, setView] = useState(() => localStorage.getItem('eu.calView') || (window.innerWidth < 640 ? 'day' : 'week'));
  const [anchor, setAnchor] = useState(() => new Date());
  const [layers, setLayers] = useState(loadLayers);
  const [pop, setPop] = useState(null); // { mode: 'new'|'view'|'edit', x, y, item?, draft? }
  const [drag, setDrag] = useState(null);
  const [undo, setUndo] = useState(null);
  const [settings, setSettings] = useState(false);
  const [openPost, setOpenPost] = useState(null);
  const [quick, setQuick] = useState('');
  useEffect(() => { try { localStorage.setItem('eu.calView', view); localStorage.setItem('eu.calLayers', JSON.stringify(layers)); } catch { /* ignore */ } }, [view, layers]);

  const days = useMemo(() => {
    if (view === 'day') return [new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate())];
    if (view === 'week') { const m = monday(anchor); return Array.from({ length: 7 }, (_, i) => addDays(m, i)); }
    const m = monday(new Date(anchor.getFullYear(), anchor.getMonth(), 1)); return Array.from({ length: 42 }, (_, i) => addDays(m, i));
  }, [view, ymd(anchor)]);
  const from = ymd(days[0]), to = ymd(days[days.length - 1]);
  const { data: evs, reload } = useApi(`/api/calendar/events?from=${from}&to=${to}`, ['calendar']);
  const { data: posts, reload: rePosts } = useApi('/api/posts?status=scheduled,held,published,publishing', ['posts', 'clips']);
  const { data: gs, reload: reG } = useApi('/api/calendar/google', ['calendar', 'settings']);
  const [pending, setPending] = useState({}); // moves made but not back from the engine yet
  useEffect(() => setPending({}), [evs, posts]);

  const items = useMemo(() => {
    const out = [];
    if (layers.events) for (const e of evs || []) if (e.source !== 'feed' || layers.feeds) out.push({ ...e, key: 'e:' + e.id, kind: 'event' });
    if (layers.posts) for (const p of posts || []) {
      const t = new Date(p.scheduledAt || p.publishedAt); if (isNaN(t)) continue; const end = new Date(+t + 20 * 60000);
      out.push({ key: 'p:' + p.id, kind: 'post', id: p.id, post: p, title: `${p.yt?.title || p.title || 'Post'}`, date: ymd(t), time: hm(t), endDate: ymd(end), end: hm(end), allDay: false, color: POST_COLOR[p.status] || 'moss', editable: ['scheduled', 'held'].includes(p.status), calendar: p.client || 'Posts', fixedLength: true });
    }
    return out.map((it) => (pending[it.key] ? { ...it, ...pending[it.key] } : it));
  }, [evs, posts, layers, pending]);

  // ---- actions
  const step = (n) => { const a = new Date(anchor); if (view === 'day') a.setDate(a.getDate() + n); else if (view === 'week') a.setDate(a.getDate() + 7 * n); else a.setMonth(a.getMonth() + n, 1); setAnchor(a); };
  const save = async (draft, item) => {
    const body = { title: draft.title, date: draft.date, endDate: draft.allDay ? draft.endDate || draft.date : draft.endDate || draft.date, time: draft.allDay ? '' : draft.time, end: draft.allDay ? '' : draft.end, allDay: !!draft.allDay, notes: draft.notes || '', location: draft.location || '', color: draft.color };
    const r = item ? await act(() => api.patch(`/api/calendar/events/${item.id}`, body), { ok: 'Saved' }) : await act(() => api.post('/api/calendar/events', body), { ok: 'Added to the calendar', sound: 'success' });
    if (r?.syncError) toast(`Saved here, not on Google Calendar yet: ${r.syncError}`, { kind: 'warn', ms: 7000 });
    setPop(null); reload();
  };
  const del = async (item) => {
    if (item.kind === 'post') return;
    setPop(null); setPending((p) => ({ ...p, [item.key]: { _gone: true } }));
    try { const r = await api.del(`/api/calendar/events/${item.id}`); play('tap'); setUndo({ text: `Deleted "${item.title}"`, event: r?.event, at: Date.now() }); }
    catch (e) { toast(e.message, { kind: 'error' }); }
    reload();
  };
  const restore = async () => { const u = undo; setUndo(null); if (!u?.event) return; const e = u.event; await act(() => api.post('/api/calendar/events', { ...e, allDay: !e.time }), { ok: 'Put back' }); reload(); };
  useEffect(() => { if (!undo) return; const t = setTimeout(() => setUndo(null), 7000); return () => clearTimeout(t); }, [undo]);
  /** Move / resize: optimistic, then saved (a post is rescheduled). */
  const commit = async (it, patch) => {
    setPending((p) => ({ ...p, [it.key]: patch }));
    try {
      if (it.kind === 'post') await api.post(`/api/posts/${it.id}/reschedule`, { at: new Date(`${patch.date}T${patch.time}:00`).toISOString() });
      else { const r = await api.patch(`/api/calendar/events/${it.id}`, { date: patch.date, endDate: patch.endDate, time: it.allDay ? '' : patch.time, end: it.allDay ? '' : patch.end, allDay: !!it.allDay }); if (r?.syncError) toast(`Moved here, not on Google Calendar yet: ${r.syncError}`, { kind: 'warn' }); }
      play('tap');
    } catch (e) { toast(e.message, { kind: 'error' }); setPending((p) => { const n = { ...p }; delete n[it.key]; return n; }); }
    reload(); rePosts();
  };
  const addQuick = async () => { const t = quick.trim(); if (!t) return; const r = await act(() => api.post('/api/calendar/quick', { text: t }), { sound: 'success' }); if (r) { setQuick(''); toast(`Added: ${r.title}, ${new Date(`${r.date}T12:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}${r.time ? ` at ${label12(r.time)}` : ''}`); setAnchor(new Date(`${r.date}T12:00`)); reload(); } };
  const newAt = (date, time, x, y, allDay = false, end = null) => { const s = minOf(time); setPop({ mode: 'new', x, y, draft: { title: '', date, endDate: date, time: allDay ? '' : time, end: allDay ? '' : end || tOf(Math.min(1439, s + 60)), allDay, color: 'teal', notes: '', location: '' } }); };
  const openItem = (it, x, y, rect) => { if (it.kind === 'post') { setOpenPost(it.post); return; } setPop({ mode: 'view', x, y, rect, item: it }); };

  // ---- keyboard (only while this page is showing and nothing is being typed)
  const keys = useRef(null); keys.current = { step, setView, pop, del, newAt };
  useEffect(() => {
    const k = (e) => {
      if (document.body.dataset.screen !== '/calendar' || e.ctrlKey || e.metaKey || e.altKey) return;
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName) || document.querySelector('.modal')) return;
      const K = keys.current; const key = e.key.toLowerCase();
      if (key === 'escape' && K.pop) setPop(null);
      else if (key === 't') setAnchor(new Date());
      else if (key === 'd' || key === 'w' || key === 'm') K.setView({ d: 'day', w: 'week', m: 'month' }[key]);
      else if (key === 'arrowleft' || key === 'j' || key === 'p') K.step(-1);
      else if (key === 'arrowright' || key === 'k' || key === 'n') K.step(1);
      else if (key === 'c') { const n = new Date(); K.newAt(ymd(n), tOf(Math.ceil((n.getHours() * 60 + n.getMinutes()) / 60) * 60), window.innerWidth / 2, 200); }
      else if ((key === 'delete' || key === 'backspace') && K.pop?.mode === 'view' && K.pop.item?.editable) { e.preventDefault(); K.del(K.pop.item); }
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k);
  }, []);

  const title = view === 'month' ? anchor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
    : view === 'day' ? anchor.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
      : (() => { const a = days[0], b = days[6]; return a.getMonth() === b.getMonth() ? `${a.toLocaleDateString(undefined, { month: 'long' })} ${a.getDate()} – ${b.getDate()}, ${b.getFullYear()}` : `${a.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} – ${b.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${b.getFullYear()}`; })();
  const visible = items.filter((it) => !it._gone);
  const gLabel = !gs ? '' : gs.on ? (gs.error ? 'Google: needs a look' : 'Google Calendar on') : 'Connect Google Calendar';

  return html`<div class="page calpage">
    <div class="cal-top">
      <h1 class="cal-title"><${Icon} name="calendar" size=${22} /> Calendar</h1>
      <${Button} kind="soft" size="sm" onClick=${() => setAnchor(new Date())} title="Today (T)">Today</${Button}>
      <div class="row" style="gap:2px"><${Button} kind="ghost" size="sm" icon="chevronLeft" title="Back (←)" onClick=${() => step(-1)} /><${Button} kind="ghost" size="sm" icon="chevronRight" title="Forward (→)" onClick=${() => step(1)} /></div>
      <div class="cal-when">${title}</div>
      <div class="spacer" />
      <form class="cal-quick" onSubmit=${(e) => { e.preventDefault(); addQuick(); }}><${Icon} name="plus" size=${15} /><input class="input sm" value=${quick} placeholder='Add: "Lunch with Ben Friday 1pm for 30 min"' onInput=${(e) => setQuick(e.target.value)} aria-label="Add an event in words" /></form>
      <${Seg} value=${view} onChange=${setView} options=${[{ value: 'day', label: 'Day' }, { value: 'week', label: 'Week' }, { value: 'month', label: 'Month' }]} />
      <${Button} kind="primary" size="sm" icon="plus" title="New event (C)" onClick=${(e) => { const n = new Date(); const d = view === 'day' || (n >= days[0] && n <= addDays(days[days.length - 1], 1)) ? n : days[0]; newAt(ymd(d), tOf(Math.ceil((n.getHours() * 60 + n.getMinutes()) / 60) * 60), e.clientX, e.clientY + 20); }}>Create</${Button}>
      <${Button} kind=${gs?.on ? (gs.error ? 'gold' : 'soft') : 'ghost'} size="sm" icon=${gs?.on && !gs.error ? 'check' : 'link'} onClick=${() => setSettings(true)}>${gLabel}</${Button}>
    </div>
    ${layers.posts && (posts || []).some((p) => ['scheduled', 'held'].includes(p.status)) ? html`<div style="margin-bottom:10px"><${HoldBanner} compact /></div>` : null}
    <div class="cal-body">
      <${Side} anchor=${anchor} setAnchor=${setAnchor} items=${visible} layers=${layers} setLayers=${setLayers} gs=${gs} reG=${reG} reload=${reload} />
      <div class="cal-main">
        ${view === 'month'
          ? html`<${Month} days=${days} anchor=${anchor} items=${visible} drag=${drag} setDrag=${setDrag} commit=${commit} openItem=${openItem} newAt=${newAt} goDay=${(d) => { setAnchor(d); setView('day'); }} />`
          : html`<${TimeGrid} days=${days} items=${visible} drag=${drag} setDrag=${setDrag} commit=${commit} openItem=${openItem} newAt=${newAt} pop=${pop} />`}
      </div>
    </div>
    ${pop ? html`<${Pop} pop=${pop} setPop=${setPop} save=${save} del=${del} />` : null}
    ${undo ? html`<div class="cal-undo"><span>${undo.text}</span>${undo.event ? html`<button class="btn ghost sm" onClick=${restore}>Undo</button>` : null}<button class="btn ghost sm icon" aria-label="Close" onClick=${() => setUndo(null)}><${Icon} name="x" size=${14} /></button></div>` : null}
    ${settings ? html`<${CalSettings} gs=${gs} reG=${reG} reload=${reload} onClose=${() => setSettings(false)} />` : null}
    ${openPost ? (openPost.clipId && openPost.status !== 'published' ? html`<${YouTubePost} clipId=${openPost.clipId} onClose=${() => { setOpenPost(null); rePosts(); }} />` : html`<${PostModal} p=${openPost} onClose=${() => { setOpenPost(null); rePosts(); }} />`) : null}
  </div>`;
}

// ------------------------------------------------------------ left: mini month + calendars
function Side({ anchor, setAnchor, items, layers, setLayers, gs, reG, reload }) {
  const [m, setM] = useState(() => new Date(anchor.getFullYear(), anchor.getMonth(), 1));
  useEffect(() => { setM(new Date(anchor.getFullYear(), anchor.getMonth(), 1)); }, [anchor.getFullYear(), anchor.getMonth()]);
  const start = monday(m); const cells = Array.from({ length: 42 }, (_, i) => addDays(start, i)); const today = ymd(new Date()); const sel = ymd(anchor);
  const busy = new Set(items.map((i) => i.date));
  const show = gs?.show?.length ? gs.show : (gs?.calendars || []).map((c) => c.id);
  const toggleCal = async (id) => { const next = show.includes(id) ? show.filter((x) => x !== id) : [...show, id]; await act(() => api.post('/api/calendar/google/settings', { show: next })); reG(); reload(); };
  const L = (k, v) => setLayers({ ...layers, [k]: v });
  return html`<aside class="cal-side">
    <div class="mini"><div class="row"><b class="grow">${m.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</b>
      <button class="btn ghost sm icon" aria-label="Previous month" onClick=${() => setM(new Date(m.getFullYear(), m.getMonth() - 1, 1))}><${Icon} name="chevronLeft" size=${14} /></button><button class="btn ghost sm icon" aria-label="Next month" onClick=${() => setM(new Date(m.getFullYear(), m.getMonth() + 1, 1))}><${Icon} name="chevronRight" size=${14} /></button></div>
      <div class="mini-g">${['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d) => html`<span class="mini-h">${d}</span>`)}${cells.map((d) => { const k = ymd(d); return html`<button class=${'mini-d' + (d.getMonth() !== m.getMonth() ? ' out' : '') + (k === today ? ' today' : '') + (k === sel ? ' sel' : '') + (busy.has(k) ? ' busy' : '')} onClick=${() => setAnchor(d)}>${d.getDate()}</button>`; })}</div></div>
    <div class="cal-layers"><div class="eyebrow">Show</div>
      <label class="cal-layer"><input type="checkbox" checked=${layers.events} onChange=${(e) => L('events', e.target.checked)} /><i class="dot teal" />Events</label>
      <label class="cal-layer"><input type="checkbox" checked=${layers.posts} onChange=${(e) => L('posts', e.target.checked)} /><i class="dot moss" />Scheduled posts</label>
      ${(gs?.feeds || []).length ? html`<label class="cal-layer"><input type="checkbox" checked=${layers.feeds} onChange=${(e) => L('feeds', e.target.checked)} /><i class="dot slate" />Calendar links</label>` : null}
      ${gs?.on && (gs.calendars || []).length ? html`<div class="eyebrow" style="margin-top:10px">Google Calendar</div>${gs.calendars.map((c) => html`<label class="cal-layer" title=${c.canWrite ? '' : 'Read only'}><input type="checkbox" checked=${show.includes(c.id)} disabled=${!layers.events} onChange=${() => toggleCal(c.id)} /><i class="dot" style=${{ background: c.color || 'var(--sky)' }} /><span class="ellipsis">${c.name}</span></label>`)}` : null}
    </div>
    <div class="faint cal-keys">T today · D/W/M view · ←/→ move · C new · Delete removes the open event</div>
  </aside>`;
}

// ------------------------------------------------------------ week / day
function TimeGrid({ days, items, drag, setDrag, commit, openItem, newAt, pop }) {
  const body = useRef(null); const n = days.length; const keys = days.map(ymd); const today = ymd(new Date());
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 60000); return () => clearInterval(t); }, []);
  useEffect(() => { const el = body.current; if (el) el.scrollTop = Math.max(0, (keys.includes(today) ? now.getHours() - 1.5 : 7) * HOUR); }, [keys[0], n]);
  const rowItems = items.filter(onRow); const timed = items.filter((it) => !onRow(it));
  const { out: rowBars, rows } = bars(rowItems, days);
  // Timed events cut into one piece per day, laid out side by side when they overlap.
  const perDay = keys.map((k) => layout(timed.flatMap((it) => { const sp = span(it); if (k < sp.a || k > sp.b) return []; const s = k === sp.a ? sp.s : 0, e = k === sp.b ? sp.e : 1440; return e > s || (e === s && k === sp.a) ? [{ it, s, e: Math.max(e, s + 15), first: k === sp.a, last: k === sp.b }] : []; })));
  // Where the pointer is: which day column and which minute.
  const at = (ev) => { const el = body.current; const r = el.getBoundingClientRect(); const x = ev.clientX - r.left - GUTTER; const di = Math.max(0, Math.min(n - 1, Math.floor(x / ((r.width - GUTTER) / n)))); const min = Math.max(0, Math.min(1439, ((ev.clientY - r.top + el.scrollTop) / HOUR) * 60)); return { di, min }; };
  const down = (ev) => {
    if (ev.button !== 0 || pop?.mode === 'new') return; const blk = ev.target.closest('[data-key]'); const p = at(ev);
    if (blk) {
      const it = items.find((x) => x.key === blk.dataset.key); if (!it) return;
      const sp = span(it); const startAbs = Math.round((day0(sp.a) - day0(keys[0])) / 864e5) * 1440 + sp.s; const endAbs = Math.round((day0(sp.b) - day0(keys[0])) / 864e5) * 1440 + sp.e;
      setDrag({ mode: ev.target.closest('.ev-rs') && it.editable && !it.fixedLength ? 'resize' : 'move', it, x0: ev.clientX, y0: ev.clientY, grab: p.di * 1440 + p.min - startAbs, dur: endAbs - startAbs, moved: false, p });
    } else setDrag({ mode: 'create', di: p.di, s: snap(Math.floor(p.min / SNAP) * SNAP), e: snap(Math.floor(p.min / SNAP) * SNAP) + SNAP, x0: ev.clientX, y0: ev.clientY, moved: false });
    body.current.setPointerCapture?.(ev.pointerId); ev.preventDefault();
  };
  const move = (ev) => {
    if (!drag) return; const p = at(ev); const moved = drag.moved || Math.abs(ev.clientX - drag.x0) + Math.abs(ev.clientY - drag.y0) > 4;
    if (drag.mode === 'create') { const m = snap(p.min); setDrag({ ...drag, moved, e: p.di === drag.di ? Math.max(drag.s + SNAP, m) : drag.e }); }
    else setDrag({ ...drag, moved, p });
  };
  const up = (ev) => {
    const d = drag; if (!d) return; setDrag(null);
    if (d.mode === 'create') { const date = keys[d.di]; const s = d.s, e = d.moved ? d.e : d.s + 60; newAt(date, tOf(s), ev.clientX, ev.clientY, false, tOf(Math.min(1439, e))); return; }
    if (!d.moved) { openItem(d.it, ev.clientX, ev.clientY, rectOf(d.it.key)); return; }
    if (!d.it.editable) { toast('This one is read only here.', { kind: 'warn' }); return; }
    const pl = placed(d); if (pl) commit(d.it, pl);
  };
  // The new times while dragging (shown live, saved on release).
  const placed = (d) => {
    const p = d.p; if (!p) return null; const base = day0(keys[0]);
    // An end exactly at midnight belongs to the day before (23:59), like the export of an all-evening event.
    const endOf = (endAbs) => { const di = Math.floor((endAbs - 1) / 1440); return { endDate: ymd(addDays(base, di)), end: tOf(Math.min(1439, endAbs - di * 1440)) }; };
    if (d.mode === 'resize') { const sp = span(d.it); const startAbs = Math.round((day0(sp.a) - base) / 864e5) * 1440 + sp.s; return { date: d.it.date, time: d.it.time, ...endOf(Math.max(startAbs + SNAP, p.di * 1440 + snap(p.min))) }; }
    const startAbs = snap(p.di * 1440 + p.min - d.grab); const sd = addDays(base, Math.floor(startAbs / 1440));
    return { date: ymd(sd), time: tOf(((startAbs % 1440) + 1440) % 1440), ...endOf(startAbs + Math.max(SNAP, d.dur)) };
  };
  const live = drag && drag.moved && drag.mode !== 'create' ? placed(drag) : null;
  const ghostSegs = live ? keys.map((k) => { const it = { ...drag.it, ...live }; const sp = span(it); if (k < sp.a || k > sp.b) return null; return { s: k === sp.a ? sp.s : 0, e: k === sp.b ? sp.e : 1440, it }; }) : [];
  const allDayDown = (ev, di) => { if (ev.target.closest('[data-key]')) return; newAt(keys[di], '09:00', ev.clientX, ev.clientY, true); };
  return html`<div class="tg" style=${{ '--n': n }}>
    <div class="tg-head"><div class="tg-gut" />${days.map((d) => { const k = ymd(d); return html`<div class=${'tg-day' + (k === today ? ' today' : '')}><span class="wd">${d.toLocaleDateString(undefined, { weekday: 'short' })}</span><span class="dn">${d.getDate()}</span></div>`; })}</div>
    <div class="tg-allday" style=${{ height: Math.max(26, rows * 24 + 6) + 'px' }}><div class="tg-gut faint">all day</div>
      ${days.map((d, i) => html`<div class="tg-adc" style=${{ left: `calc(${GUTTER}px + (100% - ${GUTTER}px) * ${i} / ${n})`, width: `calc((100% - ${GUTTER}px) / ${n})` }} onClick=${(e) => allDayDown(e, i)} />`)}
      ${rowBars.map(({ it, a, b, r }) => html`<div data-key=${it.key} class=${'ev bar c-' + it.color + (it.editable ? '' : ' ro')} style=${{ left: `calc(${GUTTER}px + (100% - ${GUTTER}px) * ${a} / ${n} + 2px)`, width: `calc((100% - ${GUTTER}px) * ${b - a + 1} / ${n} - 4px)`, top: r * 24 + 3 + 'px' }} onClick=${(e) => openItem(it, e.clientX, e.clientY, e.currentTarget.getBoundingClientRect())}>${it.title}</div>`)}
    </div>
    <div class="tg-body" ref=${body} onPointerDown=${down} onPointerMove=${move} onPointerUp=${up} onPointerCancel=${() => setDrag(null)}>
      <div class="tg-grid" style=${{ height: 24 * HOUR + 'px' }}>
        ${Array.from({ length: 24 }, (_, h) => html`<div class="tg-hr" style=${{ top: h * HOUR + 'px' }}><span>${h ? `${h % 12 || 12} ${h < 12 ? 'AM' : 'PM'}` : ''}</span></div>`)}
        ${days.map((d, i) => { const k = keys[i]; return html`<div class=${'tg-col' + (k === today ? ' today' : '')} style=${{ left: `calc(${GUTTER}px + (100% - ${GUTTER}px) * ${i} / ${n})`, width: `calc((100% - ${GUTTER}px) / ${n})` }}>
          ${perDay[i].map((g) => { const it = g.it; const moving = drag?.moved && drag.it?.key === it.key; const short = g.e - g.s < 40; return html`<div data-key=${it.key} class=${'ev blk c-' + it.color + (it.editable ? '' : ' ro') + (moving ? ' moving' : '') + (it.kind === 'post' ? ' post' : '') + (short ? ' short' : '')} style=${{ top: (g.s / 60) * HOUR + 'px', height: Math.max(18, ((g.e - g.s) / 60) * HOUR - 2) + 'px', left: `calc(${(g.col / g.cols) * 100}% + 2px)`, width: `calc(${(1 / g.cols) * 100}% - ${g.cols > 1 ? 3 : 6}px)` }} title=${`${it.title} · ${label12(it.time)}–${label12(it.end)}${it.calendar ? ` · ${it.calendar}` : ''}`}>
            <div class="t">${it.kind === 'post' ? html`<${Icon} name="send" size=${11} /> ` : null}${it.title}${it.syncing ? html` <span title=${it.syncError || 'Waiting to reach Google'} class="sync">⟳</span>` : null}</div>
            ${short ? null : html`<div class="w">${label12(g.first ? it.time : '00:00')} – ${label12(g.last ? it.end : '23:59')}${it.location ? ` · ${it.location}` : ''}</div>`}
            ${it.editable && !it.fixedLength && g.last ? html`<div class="ev-rs" />` : null}
          </div>`; })}
          ${ghostSegs[i] ? html`<div class=${'ev blk ghost c-' + drag.it.color} style=${{ top: (ghostSegs[i].s / 60) * HOUR + 'px', height: Math.max(18, ((Math.max(ghostSegs[i].e, ghostSegs[i].s + 15) - ghostSegs[i].s) / 60) * HOUR - 2) + 'px', left: '2px', right: '6px' }}><div class="t">${drag.it.title}</div><div class="w">${label12(tOf(ghostSegs[i].s))} – ${label12(tOf(Math.min(1439, ghostSegs[i].e)))}</div></div>` : null}
          ${drag?.mode === 'create' && drag.di === i ? html`<div class="ev blk ghost c-teal" style=${{ top: (drag.s / 60) * HOUR + 'px', height: ((drag.e - drag.s) / 60) * HOUR - 2 + 'px', left: '2px', right: '6px' }}><div class="t">New event</div><div class="w">${label12(tOf(drag.s))} – ${label12(tOf(drag.e))}</div></div>` : null}
          ${k === today ? html`<div class="tg-now" style=${{ top: ((now.getHours() * 60 + now.getMinutes()) / 60) * HOUR + 'px' }} />` : null}
        </div>`; })}
      </div>
    </div>
  </div>`;
}

// ------------------------------------------------------------ month
function Month({ days, anchor, items, drag, setDrag, commit, openItem, newAt, goDay }) {
  const today = ymd(new Date()); const byDay = new Map();
  for (const it of items) { const sp = span(it); for (let d = day0(sp.a); ymd(d) <= sp.b; d = addDays(d, 1)) { const k = ymd(d); if (!byDay.has(k)) byDay.set(k, []); byDay.get(k).push(it); if (byDay.size > 400) break; } }
  for (const a of byDay.values()) a.sort((x, y) => (y.allDay ? 1 : 0) - (x.allDay ? 1 : 0) || (x.time || '').localeCompare(y.time || ''));
  const down = (ev, it) => { if (ev.button !== 0) return; ev.stopPropagation(); setDrag({ mode: 'mmove', it, x0: ev.clientX, y0: ev.clientY, moved: false }); ev.currentTarget.setPointerCapture?.(ev.pointerId); };
  const move = (ev) => { if (drag?.mode !== 'mmove') return; const moved = drag.moved || Math.abs(ev.clientX - drag.x0) + Math.abs(ev.clientY - drag.y0) > 4; const cell = document.elementsFromPoint(ev.clientX, ev.clientY).find((e) => e.dataset?.date); setDrag({ ...drag, moved, over: cell?.dataset.date || drag.over }); };
  const up = (ev) => {
    const d = drag; if (d?.mode !== 'mmove') return; setDrag(null);
    if (!d.moved) return openItem(d.it, ev.clientX, ev.clientY, rectOf(d.it.key));
    if (!d.it.editable) return toast('This one is read only here.', { kind: 'warn' });
    if (!d.over || d.over === d.it.date) return;
    const shift = Math.round((day0(d.over) - day0(d.it.date)) / 864e5);
    commit(d.it, { date: d.over, time: d.it.time, endDate: ymd(addDays(day0(d.it.endDate || d.it.date), shift)), end: d.it.end });
  };
  return html`<div class="mo" onPointerMove=${move} onPointerUp=${up}>
    ${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((w) => html`<div class="mo-h">${w}</div>`)}
    ${days.map((d) => { const k = ymd(d); const list = byDay.get(k) || []; const more = list.length - 3;
      return html`<div data-date=${k} class=${'mo-c' + (d.getMonth() !== anchor.getMonth() ? ' out' : '') + (k === today ? ' today' : '') + (drag?.mode === 'mmove' && drag.moved && drag.over === k ? ' over' : '')} onClick=${(e) => { if (e.target === e.currentTarget || e.target.classList.contains('mo-n')) { if (e.target.classList.contains('mo-n')) return goDay(d); newAt(k, '09:00', e.clientX, e.clientY); } }}>
        <button class="mo-n" onClick=${(e) => { e.stopPropagation(); goDay(d); }}>${d.getDate()}</button>
        ${list.slice(0, 3).map((it) => html`<div data-key=${it.key} class=${'ev chip c-' + it.color + (it.allDay ? ' allday' : '') + (it.editable ? '' : ' ro')} onPointerDown=${(e) => down(e, it)} title=${it.title}>${it.allDay ? '' : html`<b>${label12(it.time)}</b> `}${it.title}</div>`)}
        ${more > 0 ? html`<button class="mo-more" onClick=${(e) => { e.stopPropagation(); goDay(d); }}>${more} more</button>` : null}
      </div>`; })}
  </div>`;
}

// ------------------------------------------------------------ the little window: see / add / change an event
function Pop({ pop, setPop, save, del }) {
  const box = useRef(null); const titleIn = useRef(null); const [f, setF] = useState(() => (pop.mode === 'edit' ? toDraft(pop.item) : pop.draft));
  // Straight into the title (the autofocus attribute only works now and then on windows opened after the page loads).
  useEffect(() => { if (pop.mode !== 'view') setTimeout(() => { titleIn.current?.focus(); if (pop.mode === 'edit') titleIn.current?.select(); }, 0); }, [pop.mode, pop.item?.key, pop.draft]); const [more, setMore] = useState(false); const [busy, setBusy] = useState(false);
  useEffect(() => { setF(pop.mode === 'edit' ? toDraft(pop.item) : pop.draft); }, [pop]);
  useEffect(() => { const k = (e) => { if (e.key === 'Escape') setPop(null); }; const c = (e) => { if (box.current && !box.current.contains(e.target) && !e.target.closest('.modal')) setPop(null); }; window.addEventListener('keydown', k); setTimeout(() => window.addEventListener('pointerdown', c), 0); return () => { window.removeEventListener('keydown', k); window.removeEventListener('pointerdown', c); }; }, []);
  const W = 360; const phone = window.innerWidth < 640;
  // Beside the event (or the spot clicked), never on top of it, like Google Calendar.
  const r = pop.rect; const vw = window.innerWidth, vh = window.innerHeight;
  let left = r ? (r.right + 10 + W <= vw - 12 ? r.right + 10 : r.left - W - 10) : (pop.x > vw / 2 ? pop.x - W - 24 : pop.x + 24);
  left = Math.max(12, Math.min(vw - W - 12, left)); const top = Math.max(70, Math.min(vh - 400, (r ? r.top : pop.y) - 30));
  const style = phone ? {} : { left: left + 'px', top: top + 'px', width: W + 'px' };
  if (pop.mode === 'view') {
    const it = pop.item; const sameDay = it.date === it.endDate;
    const when = it.allDay ? (sameDay ? fmtDay(it.date) : `${fmtDay(it.date)} – ${fmtDay(it.endDate)}`) : sameDay ? `${fmtDay(it.date)} · ${label12(it.time)} – ${label12(it.end)}` : `${fmtDay(it.date)} ${label12(it.time)} – ${fmtDay(it.endDate)} ${label12(it.end)}`;
    return html`<div class=${'cal-pop' + (phone ? ' phone' : '')} ref=${box} style=${style} role="dialog" aria-label=${it.title}>
      <div class="row cal-pop-tools">${it.editable ? html`<button class="btn ghost sm icon" title="Edit" aria-label="Edit" onClick=${() => setPop({ ...pop, mode: 'edit' })}><${Icon} name="edit" size=${15} /></button><button class="btn ghost sm icon" title="Delete (Delete key)" aria-label="Delete" onClick=${() => del(it)}><${Icon} name="trash" size=${15} /></button>` : null}${it.link ? html`<a class="btn ghost sm icon" href=${it.link} target="_blank" rel="noopener" title="Open in Google Calendar"><${Icon} name="external" size=${15} /></a>` : null}<div class="spacer" /><button class="btn ghost sm icon" aria-label="Close" onClick=${() => setPop(null)}><${Icon} name="x" size=${15} /></button></div>
      <div class="row" style="align-items:flex-start;gap:10px"><i class=${'dot big c-' + it.color} /><div class="grow"><div class="cal-pop-title">${it.title}</div><div class="muted" style="font-size:var(--fs-sm)">${when}</div></div></div>
      ${it.location ? html`<div class="row" style="gap:8px;margin-top:8px"><${Icon} name="pin" size=${14} /><span>${it.location}</span></div>` : null}
      ${it.notes ? html`<div class="selectable" style="margin-top:8px;white-space:pre-wrap;font-size:var(--fs-sm)">${it.notes}</div>` : null}
      <div class="faint" style="font-size:var(--fs-xs);margin-top:10px">${it.calendar}${it.editable ? '' : ' · read only'}${it.createdBy && !['google', 'user'].includes(it.createdBy) ? ` · added by ${it.createdBy}` : ''}${it.syncError ? html`<div style="color:var(--coral-ink)">Not on Google Calendar yet: ${it.syncError}</div>` : null}</div>
    </div>`;
  }
  const set = (p) => setF({ ...f, ...p });
  const submit = async (e) => { e?.preventDefault(); if (busy) return; setBusy(true); try { await save({ ...f, title: f.title.trim() || 'New event' }, pop.mode === 'edit' ? pop.item : null); } finally { setBusy(false); } };
  const setStart = (t) => { const d = minOf(f.end) - minOf(f.time); set({ time: t, end: f.date === f.endDate ? tOf(minOf(t) + Math.max(SNAP, d)) : f.end }); };
  return html`<form class=${'cal-pop' + (phone ? ' phone' : '')} ref=${box} style=${style} onSubmit=${submit}>
    <div class="row cal-pop-tools"><b class="grow">${pop.mode === 'edit' ? 'Change event' : 'New event'}</b><button type="button" class="btn ghost sm icon" aria-label="Close" onClick=${() => setPop(null)}><${Icon} name="x" size=${15} /></button></div>
    <input ref=${titleIn} class="input cal-pop-input" placeholder="Add a title" value=${f.title} onInput=${(e) => set({ title: e.target.value })} aria-label="Title" />
    <div class="cal-pop-when">
      <input class="input sm" type="date" value=${f.date} onInput=${(e) => set({ date: e.target.value, endDate: e.target.value > f.endDate || f.date === f.endDate ? e.target.value : f.endDate })} aria-label="Date" />
      ${f.allDay ? html`<span class="faint">to</span><input class="input sm" type="date" value=${f.endDate} min=${f.date} onInput=${(e) => set({ endDate: e.target.value })} aria-label="Last day" />`
        : html`<input class="input sm" type="time" step="900" value=${f.time} onInput=${(e) => setStart(e.target.value)} aria-label="Starts" /><span class="faint">–</span><input class="input sm" type="time" step="900" value=${f.end} onInput=${(e) => set({ end: e.target.value })} aria-label="Ends" />`}
    </div>
    <label class="row" style="gap:6px;font-size:var(--fs-sm)"><input type="checkbox" checked=${f.allDay} onChange=${(e) => set({ allDay: e.target.checked, time: e.target.checked ? '' : f.time || '09:00', end: e.target.checked ? '' : f.end || '10:00' })} />All day</label>
    <div class="row" style="gap:6px">${COLORS.map((c) => html`<button type="button" class=${'dot pick c-' + c + (f.color === c ? ' on' : '')} aria-label=${c} onClick=${() => set({ color: c })} />`)}</div>
    ${more || f.notes || f.location ? html`<input class="input sm" placeholder="Where" value=${f.location} onInput=${(e) => set({ location: e.target.value })} aria-label="Where" /><textarea class="textarea" rows="3" placeholder="Notes" value=${f.notes} onInput=${(e) => set({ notes: e.target.value })} aria-label="Notes" />`
      : html`<button type="button" class="btn ghost sm" style="align-self:flex-start" onClick=${() => setMore(true)}>Add where and notes</button>`}
    <div class="row" style="justify-content:flex-end;gap:8px"><button type="button" class="btn ghost sm" onClick=${() => setPop(null)}>Cancel</button><${Button} kind="primary" size="sm" type="submit" busy=${busy}>Save</${Button}></div>
  </form>`;
}
const rectOf = (key) => { try { return document.querySelector(`.screen.on [data-key="${CSS.escape(key)}"]`)?.getBoundingClientRect() || null; } catch { return null; } };
const fmtDay = (s) => new Date(`${s}T12:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
const toDraft = (it) => ({ title: it.title, date: it.date, endDate: it.endDate || it.date, time: it.allDay ? '' : it.time, end: it.allDay ? '' : it.end, allDay: !!it.allDay, color: it.color || 'teal', notes: it.notes || '', location: it.location || '' });

// ------------------------------------------------------------ Google Calendar and calendar links
function CalSettings({ gs, reG, reload, onClose }) {
  const [url, setUrl] = useState(''); const [name, setName] = useState(''); const [busy, setBusy] = useState('');
  const run = async (k, fn, ok) => { setBusy(k); try { await act(fn, ok ? { ok } : {}); } finally { setBusy(''); reG(); reload(); } };
  // After "Connect", Google's page opens in the browser; this window keeps looking until it's done.
  useEffect(() => { if (busy !== 'connect') return; const t = setInterval(reG, 2500); return () => clearInterval(t); }, [busy]);
  useEffect(() => { if (busy === 'connect' && gs?.connected) { setBusy(''); toast('Google Calendar connected', { kind: 'success' }); } }, [gs?.connected]);
  const show = gs?.show?.length ? gs.show : (gs?.calendars || []).map((c) => c.id);
  return html`<${Modal} title="Calendar connections" icon="calendar" wide onClose=${onClose} footer=${html`<div class="spacer" /><${Button} kind="primary" onClick=${onClose}>Done</${Button}>`}>
    <div class="col" style="gap:16px">
      <div class="panel pad col" style="gap:10px">
        <div class="row"><b class="grow">Google Calendar (your Gmail calendar)</b>${gs?.on ? html`<span class="badge moss">On</span>` : null}</div>
        ${!gs ? html`<div class="muted">Loading…</div>`
          : !gs.configured ? html`<div class="muted" style="font-size:var(--fs-sm)">Two-way sync uses the same Google connection as YouTube direct upload. Once: in Google Cloud Console make an OAuth client of type <b>Desktop app</b> and turn on the <b>Google Calendar API</b> for it, then paste its ID and secret in Settings → Connections → Google.</div>
              <div class="row"><${Button} kind="soft" icon="settings" onClick=${() => { onClose(); navigate('/settings'); }}>Open Settings → Connections</${Button}></div>
              <div class="faint" style="font-size:var(--fs-xs)">No setup at all: add your Google calendar's private iCal link below to see it here (read only).</div>`
          : !gs.connected ? html`<div class="muted" style="font-size:var(--fs-sm)">Sign in with the Google account whose calendar you use. Events you add here go onto it, and its events (Gmail invites you've accepted included) show here. Nobody is ever invited or emailed from Euclidean.</div>
              ${gs.error ? html`<div class="notice coral"><${Icon} name="alert" size=${16} />${gs.error}</div>` : null}
              <div class="row"><${Button} kind="primary" icon="link" busy=${busy === 'connect'} onClick=${async () => { setBusy('connect'); try { const r = await api.post('/api/calendar/google/connect'); if (r?.url && !window.euclidean) window.open(r.url, '_blank', 'noopener'); } catch (e) { toast(e.message, { kind: 'error' }); setBusy(''); } }}>Connect Google Calendar</${Button}>${busy === 'connect' ? html`<span class="faint" style="font-size:var(--fs-sm)">Finish on Google's page in your browser…</span>` : null}</div>`
          : html`<div class="muted" style="font-size:var(--fs-sm)">${gs.account ? html`Connected as <b>${gs.account}</b>. ` : ''}${gs.lastSync ? `Last synced ${dateTime(gs.lastSync)}.` : 'Syncing…'} It syncs every few minutes and when this page opens.</div>
              ${gs.error ? html`<div class="notice coral"><${Icon} name="alert" size=${16} />${gs.error}</div>` : null}
              <div class="table-wrap"><table class="table"><thead><tr><th>Calendar</th><th>Show here</th><th>New events go here</th></tr></thead><tbody>
                ${(gs.calendars || []).map((c) => html`<tr><td><i class="dot" style=${{ background: c.color || 'var(--sky)', display: 'inline-block', marginRight: '6px' }} />${c.name}${c.canWrite ? '' : html` <span class="faint">(read only)</span>`}</td>
                  <td><${Toggle} on=${show.includes(c.id)} onChange=${(v) => run('show', () => api.post('/api/calendar/google/settings', { show: v ? [...show, c.id] : show.filter((x) => x !== c.id) }))} label=${`Show ${c.name}`} /></td>
                  <td>${c.canWrite ? html`<input type="radio" name="calwrite" checked=${gs.write === c.id || (gs.write === 'primary' && c.primary)} onChange=${() => run('write', () => api.post('/api/calendar/google/settings', { write: c.id }), 'Saved')} aria-label=${`Save new events to ${c.name}`} />` : null}</td></tr>`)}
              </tbody></table></div>
              <div class="row"><${Button} kind="soft" icon="refresh" busy=${busy === 'sync'} onClick=${() => run('sync', () => api.post('/api/calendar/sync'), 'Synced')}>Sync now</${Button}><div class="spacer" /><${Button} kind="ghost" icon="x" onClick=${() => { if (confirm('Disconnect Google Calendar? Its events leave this calendar; your events here stay (and stay on Google too).')) run('disc', () => api.post('/api/calendar/google/disconnect'), 'Disconnected'); }}>Disconnect</${Button}></div>`}
      </div>
      <div class="panel pad col" style="gap:10px">
        <b>Calendar links (read only, no setup)</b>
        <div class="muted" style="font-size:var(--fs-sm)">Show any calendar here from its private iCal address. Google Calendar: open calendar.google.com → Settings → your calendar → <b>Secret address in iCal format</b> → copy. Outlook and Apple Calendar have the same kind of link. Keep it private: anyone with it can see that calendar.</div>
        ${(gs?.feeds || []).map((f) => html`<div class="row"><${Icon} name="calendar" size=${14} /><b>${f.name}</b><span class="faint ellipsis grow" style="font-size:var(--fs-xs)">${f.url}</span>${f.error ? html`<span class="badge coral" title=${f.error}>problem</span>` : html`<span class="faint" style="font-size:var(--fs-xs)">${f.count} events</span>`}<button class="btn ghost sm icon" aria-label="Remove" onClick=${() => run('feed', () => api.del(`/api/calendar/feeds/${f.i}`), 'Removed')}><${Icon} name="trash" size=${14} /></button></div>`)}
        <div class="form-grid"><${Field} label="iCal address" id="cal-url"><input id="cal-url" class="input" placeholder="https://calendar.google.com/calendar/ical/.../basic.ics" value=${url} onInput=${(e) => setUrl(e.target.value)} /></${Field}><${Field} label="Name" id="cal-name"><input id="cal-name" class="input" placeholder="Work" value=${name} onInput=${(e) => setName(e.target.value)} /></${Field}></div>
        <div class="row"><${Button} kind="soft" icon="plus" disabled=${!url.trim()} busy=${busy === 'feed'} onClick=${() => run('feed', () => api.post('/api/calendar/feeds', { url, name }).then((r) => { setUrl(''); setName(''); return r; }), 'Added')}>Add calendar link</${Button}></div>
      </div>
    </div></${Modal}>`;
}

function PostModal({ p, onClose }) {
  const [at, setAt] = useState(() => { const d = new Date(p.scheduledAt); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); });
  const scheduled = p.status === 'scheduled';
  return html`<${Modal} title=${p.title} icon="calendar" onClose=${onClose} footer=${html`
    ${scheduled ? html`<${Button} kind="ghost" icon="x" onClick=${() => act(() => api.post(`/api/posts/${p.id}/unschedule`), { ok: 'Pulled from the schedule' }).then(onClose)}>Unschedule</${Button}>` : null}
    <div class="spacer" /><${Button} kind="ghost" onClick=${() => navigate(`/production?clip=${p.clipId}`)}>Open clip</${Button}>
    ${scheduled ? html`<${Button} kind="primary" onClick=${() => act(() => api.post(`/api/posts/${p.id}/reschedule`, { at: new Date(at).toISOString() }), { ok: 'Rescheduled' }).then(onClose)}>Save time</${Button}>` : null}`}>
    <div class="col" style="gap:12px">
      <div class="row wrap"><${StatusBadge} status=${p.status} /><span class="badge outline">${p.client}</span>${(p.platforms || []).map((x) => html`<span class="badge teal">${PLATFORM_LABEL[x] || x}</span>`)}</div>
      ${scheduled ? html`<${Field} label="Publish at" id="pm-at"><input id="pm-at" class="input" type="datetime-local" value=${at} onInput=${(e) => setAt(e.target.value)} /></${Field}>` : html`<div class="muted">Published ${dateTime(p.publishedAt)} via ${p.mode}${p.note ? ` · ${p.note}` : ''}</div>`}
      ${p.caption ? html`<div><div class="eyebrow">Caption</div><div class="muted selectable" style="margin-top:3px">${p.caption}</div></div>` : null}
      ${Object.keys(p.results || {}).length ? html`<div class="list panel">${Object.entries(p.results).map(([k, r]) => html`<div class="list-row"><b style="width:110px">${PLATFORM_LABEL[k] || k}</b><span class="grow muted">${r.status}</span>${r.url ? html`<a href=${r.url} target="_blank" rel="noopener">View <${Icon} name="external" size=${12} /></a>` : null}</div>`)}</div>` : null}
      ${p.lastError ? html`<div class="notice coral"><${Icon} name="alert" size=${16} />${p.lastError}</div>` : null}
    </div></${Modal}>`;
}
