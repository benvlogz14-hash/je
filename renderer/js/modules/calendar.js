// Publishing calendar: a week of scheduled and published posts across clients.
import { html, useState, useApi, navigate, Button, Modal, Field, StatusBadge, act, hashColor, Empty, confirmDialog } from '../lib/ui.js';
import { api } from '../lib/api.js';
import { Icon } from '../lib/icons.js';
import { dateTime, PLATFORM_LABEL } from '../lib/format.js';

export function Calendar() {
  const [offset, setOffset] = useState(0);
  const { data: posts } = useApi('/api/posts?status=scheduled,published,publishing', ['posts', 'clips']);
  const [open, setOpen] = useState(null);
  // Calls and meetings HAL put on the calendar ("add a call with Judy Griffin Thursday at 2"), in the same grid.
  const { data: ops, reload: reOps } = useApi('/api/hal/calendar', ['hal']);
  const hourOf = (t) => { const m = /^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?$/i.exec(String(t || '').trim()); if (!m) return 9; let h = Number(m[1]) % 24; if (/pm/i.test(m[3] || '') && h < 12) h += 12; if (/am/i.test(m[3] || '') && h === 12) h = 0; if (!m[3] && h > 0 && h < 7) h += 12; return Math.max(6, Math.min(22, h)); };
  const opsIn = (d, h) => (ops || []).filter((e) => { const [y, mo, da] = String(e.date).split('-').map(Number); return y && new Date(y, mo - 1, da).toDateString() === d.toDateString() && hourOf(e.time) === h; });
  const dropOp = async (e) => { if (await confirmDialog({ title: `Remove "${e.title}"?`, text: `${e.date}${e.time ? ` at ${e.time}` : ''}, put on the calendar by HAL.`, confirm: 'Remove' })) act(() => api.del(`/api/hal/calendar/${e.id}`), { ok: 'Removed', sound: 'tap' }).then(reOps); };
  const start = new Date(); start.setHours(0, 0, 0, 0); start.setDate(start.getDate() - ((start.getDay() + 6) % 7) + offset * 7);
  const days = Array.from({ length: 7 }, (_, i) => new Date(start.getTime() + i * 864e5));
  const hours = Array.from({ length: 17 }, (_, i) => i + 6);
  const inCell = (d, h) => (posts || []).filter((p) => { const t = new Date(p.scheduledAt); return t.toDateString() === d.toDateString() && t.getHours() === h; });
  const weekPosts = (posts || []).filter((p) => { const t = new Date(p.scheduledAt); return t >= days[0] && t < new Date(days[6].getTime() + 864e5); });
  const todayStr = new Date().toDateString();
  return html`<div class="page">
    <div class="page-head"><div class="grow"><h1>Publishing</h1><div class="sub">${weekPosts.length} posts this week · ${weekPosts.filter((p) => p.status === 'published').length} published</div></div>
      <${Button} kind="ghost" size="sm" icon="chevronLeft" title="Previous week" onClick=${() => setOffset(offset - 1)} /><${Button} kind="ghost" size="sm" onClick=${() => setOffset(0)}>This week</${Button}><${Button} kind="ghost" size="sm" icon="chevronRight" title="Next week" onClick=${() => setOffset(offset + 1)} /></div>
    ${posts && !posts.length && !(ops || []).length ? html`<div class="panel"><${Empty} icon="calendar" title="Nothing scheduled yet">Approved clips drop into each client's posting slots automatically.</${Empty}></div>` : html`
    <div class="table-wrap"><div class="cal">
      <div class="cal-h" style="border-left:0" />${days.map((d) => html`<div class=${'cal-h' + (d.toDateString() === todayStr ? ' today' : '')}>${d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}</div>`)}
      ${hours.map((h) => html`<div class="cal-t">${h % 12 || 12}${h < 12 ? 'a' : 'p'}</div>${days.map((d) => html`<div class="cal-c">${inCell(d, h).map((p) => { const [bg, fg] = hashColor(p.client); return html`<div class="cal-post" style=${{ background: `var(${bg})`, color: `var(${fg})`, borderLeftColor: p.status === 'published' ? 'var(--ink-3)' : `var(${fg})` }} onClick=${() => setOpen(p)} title=${p.title}><div class="ellipsis" style="font-weight:600">${p.title}</div><div class="ellipsis" style="opacity:0.8">${new Date(p.scheduledAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })} · ${p.client}</div></div>`; })}${opsIn(d, h).map((e) => html`<div class="cal-post" style=${{ background: '#141414', color: '#f1f1f1', borderLeftColor: '#ff2a1a' }} onClick=${() => dropOp(e)} title=${`${e.title} (from HAL). Click to remove.`}><div class="ellipsis" style="font-weight:600">${e.title}</div><div class="ellipsis" style="opacity:0.8">${e.time || 'no time set'} · HAL</div></div>`)}</div>`)}`)}
    </div></div>`}
    ${open ? html`<${PostModal} p=${open} onClose=${() => setOpen(null)} />` : null}
  </div>`;
}

function PostModal({ p, onClose }) {
  const [at, setAt] = useState(() => { const d = new Date(p.scheduledAt); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); });
  const scheduled = p.status === 'scheduled';
  return html`<${Modal} title=${p.title} icon="calendar" onClose=${onClose} footer=${html`
    ${scheduled ? html`<${Button} kind="ghost" icon="x" onClick=${() => act(() => api.post(`/api/posts/${p.id}/unschedule`), { ok: 'Pulled from the schedule' }).then(onClose)}>Unschedule</${Button}>` : null}
    <div class="spacer" /><${Button} kind="ghost" onClick=${() => navigate(`/production?clip=${p.clipId}`)}>Open clip</${Button}>
    ${scheduled ? html`<${Button} kind="primary" onClick=${() => act(() => api.post(`/api/posts/${p.id}/reschedule`, { at: new Date(at).toISOString() }), { ok: 'Rescheduled' }).then(onClose)}>Save time</${Button}>` : null}`}>
    <div class="col" style="gap:12px">
      <div class="row wrap"><${StatusBadge} status=${p.status} /><span class="badge outline">${p.client}</span>${p.platforms.map((x) => html`<span class="badge teal">${PLATFORM_LABEL[x] || x}</span>`)}</div>
      ${scheduled ? html`<${Field} label="Publish at" id="pm-at"><input id="pm-at" class="input" type="datetime-local" value=${at} onInput=${(e) => setAt(e.target.value)} /></${Field}>` : html`<div class="muted">Published ${dateTime(p.publishedAt)} via ${p.mode}${p.note ? ` · ${p.note}` : ''}</div>`}
      ${p.caption ? html`<div><div class="eyebrow">Caption</div><div class="muted selectable" style="margin-top:3px">${p.caption}</div></div>` : null}
      ${Object.keys(p.results || {}).length ? html`<div class="list panel">${Object.entries(p.results).map(([k, r]) => html`<div class="list-row"><b style="width:110px">${PLATFORM_LABEL[k] || k}</b><span class="grow muted">${r.status}</span>${r.url ? html`<a href=${r.url} target="_blank" rel="noopener">View <${Icon} name="external" size=${12} /></a>` : null}</div>`)}</div>` : null}
      ${p.lastError ? html`<div class="notice coral"><${Icon} name="alert" size=${16} />${p.lastError}</div>` : null}
    </div></${Modal}>`;
}
