// Rich cards rendered under command responses in the Euclidean thread.
import { html, useApi, navigate, StatusBadge, Progress, Avatar, Button, act, gcls } from '../lib/ui.js';
import { api } from '../lib/api.js';
import { Icon } from '../lib/icons.js';
import { money, dateTime, ago, PLATFORM_LABEL, actorName } from '../lib/format.js';

export function Card({ card, onCommand }) {
  const C = CARDS[card.type];
  return C ? html`<div class="card">${C({ data: card.data, onCommand })}</div>` : null;
}

function QuotaBar({ q }) {
  if (!q) return null;
  const cells = Array.from({ length: Math.min(q.slotsAhead, 24) }, (_, i) => (i < q.scheduled ? 's' : i < q.scheduled + q.inReview ? 'r' : i < q.scheduled + q.inReview + q.inProduction ? 'p' : ''));
  return html`<div class="quota" title=${`${q.scheduled} scheduled · ${q.inReview} in review · ${q.inProduction} in production · ${q.open} open of ${q.slotsAhead} upcoming slots`}>${cells.map((c) => html`<i class=${c} />`)}</div>`;
}
export { QuotaBar };

const CARDS = {
  clips: ({ data }) => data.length ? html`<div class="card-grid">${data.map((c) => html`
    <div class="mini-clip" onClick=${() => navigate(`/production?clip=${c.id}`)}>
      <div class="th" style=${c.thumb ? { backgroundImage: `url(${api.url(c.thumb)})` } : {}}><span class="badge ref" style="background:var(--surface);color:var(--ink)">#${c.ref}</span></div>
      <div class="cap"><div class="ellipsis" style="font-weight:600">${c.title}</div><div class="row" style="margin-top:4px;gap:6px"><${StatusBadge} status=${c.status} /><span class="faint tnum">${c.duration}s</span></div></div>
    </div>`)}</div>` : null,
  clients: ({ data }) => html`<div class="list">${data.map((c) => html`
    <div class="list-row click" onClick=${() => navigate(`/clients/${c.id}`)}>
      <${Avatar} name=${c.name} size="sm" /><div class="grow"><div class="row"><b class="ellipsis">${c.name}</b><span class=${'badge ' + (c.type === 'political' ? 'slate' : 'teal')}>${c.type}</span>${c.autopilot ? html`<span class="badge moss">${c.perDay}/day autopilot</span>` : null}</div></div>
      <${QuotaBar} q=${c.quota} /><span class="tnum muted" style="width:80px;text-align:right">${money(c.retainer)}/mo</span></div>`)}</div>`,
  conversations: ({ data }) => data.length ? html`<div class="list">${data.map((c) => html`
    <div class="list-row click" onClick=${() => navigate(`/messages/${c.id}`)}><${Avatar} name=${c.title} size="sm" /><div class="grow"><b>${c.title}</b><div class="muted ellipsis" style="font-size:var(--fs-sm)">${c.reason || c.preview}</div></div><span class="faint" style="font-size:var(--fs-xs)">${ago(c.at)}</span></div>`)}</div>` : null,
  posts: ({ data }) => data.length ? html`<div class="list">${data.map((p) => html`
    <div class="list-row"><${Icon} name="calendar" size=${16} /><div class="grow"><b class="ellipsis">${p.title}</b><div class="muted" style="font-size:var(--fs-sm)">${p.client} · ${p.platforms.map((x) => PLATFORM_LABEL[x] || x).join(', ')}</div></div><span class="tnum">${dateTime(p.at)}</span></div>`)}</div>` : null,
  jobs: ({ data }) => html`<${LiveJobs} snapshot=${data} />`,
  job: ({ data }) => html`<${LiveJob} id=${data.id} />`,
  message: () => null,
  agents: ({ data }) => html`<div class="list">${Object.entries(data.providers).map(([k, p]) => html`
    <div class="list-row"><span class=${'led ' + (!p.connected ? '' : p.health && !p.health.ok ? 'err' : p.busy ? 'live' : 'ok')} /><b style="width:70px">${p.label}</b><span class="muted grow">${p.connected ? (p.busy ? `${p.busy} active call${p.busy > 1 ? 's' : ''}` : 'Idle') : 'Not connected'}</span><span class="tnum muted">${money(p.spendUsd, 2)} / ${money(p.budgetUsd)}</span></div>`)}
    <div class="list-row"><span class=${'led ' + (data.computerUse.online ? 'ok' : '')} /><b style="width:70px">Astra</b><span class="muted grow">${data.computerUse.online ? 'Online' : 'No computer-use agent connected'}${data.computerUse.waiting ? ` · ${data.computerUse.waiting} waiting` : ''}</span></div></div>`,
  health: ({ data }) => html`<div class="list">${data.items.filter((i) => i.level !== 'ok').slice(0, 10).map((i) => html`
    <div class="list-row"><span class=${'led ' + (i.level === 'error' ? 'err' : 'warn')} /><div class="grow"><b>${i.label}</b><div class="muted" style="font-size:var(--fs-sm)">${i.text}</div></div></div>`)}
    ${data.items.every((i) => i.level === 'ok') ? html`<div class="list-row"><span class="led ok" />Everything is connected and healthy.</div>` : null}</div>`,
  revenue: ({ data }) => html`<div class="grid c4" style="padding:12px;gap:10px">
    ${[['MRR', money(data.mrr)], ['Profit', money(data.profit)], ['AI cost', money(data.aiCost, 2)], ['Distributable', money(data.distributable)]].map(([l, v]) => html`<div><div class="eyebrow">${l}</div><div style="font:600 18px var(--font-display)" class="tnum">${v}</div></div>`)}</div>
    <div class="list">${data.founders.map((f) => html`<div class="list-row"><${Avatar} name=${f.name} size="sm" /><span class="grow">${f.name} <span class="faint">· ${f.distributionPct}% of distributions</span></span><b class="tnum">${money(f.distribution)}</b></div>`)}</div>`,
  logs: ({ data }) => html`<div class="list">${data.slice(0, 15).map((e) => html`<div class="list-row" style="padding:7px 14px"><span class=${'led ' + (e.level === 'error' ? 'err' : e.level === 'warn' ? 'warn' : '')} /><span class="mono" style="width:150px">${e.action}</span><span class="muted grow ellipsis">${actorName(e.actor)}</span><span class="faint" style="font-size:var(--fs-xs)">${ago(e.at)}</span></div>`)}</div>`,
  help: ({ data, onCommand }) => {
    const groups = [...new Set(data.map((c) => c.group))];
    return html`<div>${groups.map((g) => html`<div style="padding:12px 16px 0" class=${'slash-group eyebrow ' + gcls(g)}>${g}</div><div class=${'help-grid ' + gcls(g)} style="padding-top:6px">${data.filter((c) => c.group === g).map((c) => html`<div class="help-row" onClick=${() => onCommand?.(c.usage.split(' ')[0] + ' ')}><span class="cmd-chip">${c.usage}</span><span class="d">${c.description}</span></div>`)}</div>`)}</div>`;
  },
  digest: ({ data }) => html`<div class="list">${data.rows.map((r) => html`
    <div class="list-row click" onClick=${() => navigate(`/clients/${r.id}`)}><${Avatar} name=${r.name} size="sm" /><div class="grow"><b>${r.name}</b><div class="muted" style="font-size:var(--fs-sm)">${r.postedToday} posted today · ${r.scheduled} scheduled · ${r.inReview} in review${r.open ? ` · ${r.open} open slots` : ''}</div></div><${QuotaBar} q=${r} /></div>`)}</div>`,
};

/**
 * The /queue card, live: refreshed from the job updates the app already gets, so bars move as the work happens, finished
 * jobs drop off and new ones show up (it used to be a snapshot from when the command ran, frozen mid-bar).
 */
function LiveJobs({ snapshot }) {
  const { data } = useApi('/api/jobs?status=running,queued,waiting_agent,failed', ['job']);
  const live = data ? [...data].sort((x, y) => (x.status === 'running' ? -1 : 1) - (y.status === 'running' ? -1 : 1)).slice(0, 15) : snapshot;
  const finished = data ? snapshot.filter((j) => ['running', 'queued', 'waiting_agent'].includes(j.status) && !data.some((x) => x.id === j.id)).length : 0;
  const n = (st) => (data || []).filter((j) => j.status === st).length;
  return html`<div class="col" style="gap:6px">
    ${data ? html`<div class="row faint" style="gap:8px;font-size:var(--fs-xs);padding:0 4px"><span class="led" style="background:var(--moss, #3a9d6a);box-shadow:none" /><span>Live · ${n('running')} running · ${n('queued')} queued${finished ? ` · ${finished} finished since` : ''}</span></div>` : null}
    ${live.length ? html`<div class="list">${live.map((j) => html`<${JobRow} key=${j.id} j=${j} />`)}</div>` : html`<div class="faint" style="font-size:var(--fs-sm);padding:6px 4px">Nothing running or waiting.</div>`}
  </div>`;
}

export function JobRow({ j, actions = true }) {
  return html`<div class="list-row">
    <div style="width:118px"><${StatusBadge} status=${j.status} /></div>
    <div class="grow"><div class="ellipsis" style="font-weight:500">${j.title}</div><div class="faint ellipsis" style="font-size:var(--fs-xs)">${j.error ? html`<span style="color:var(--coral-ink)">${j.error}</span>` : j.note || j.type}</div>
      ${j.status === 'running' ? html`<div style="margin-top:5px"><${Progress} value=${j.progress} indeterminate=${!j.progress} /></div>` : null}</div>
    ${actions && j.status === 'failed' ? html`<${Button} size="sm" kind="ghost" icon="refresh" onClick=${() => act(() => api.post(`/api/jobs/${j.id}/retry`), { ok: 'Retrying' })}>Retry</${Button}>` : null}
    ${actions && ['queued', 'running', 'waiting_agent'].includes(j.status) ? html`<${Button} size="sm" kind="ghost" icon="x" title="Cancel" onClick=${() => act(() => api.post(`/api/jobs/${j.id}/cancel`), { ok: 'Canceled', sound: 'tap' })} />` : null}
  </div>`;
}

function LiveJob({ id }) {
  const { data } = useApi(`/api/jobs/${id}`, ['job']);
  if (!data) return null;
  return html`<div class="list"><${JobRow} j=${data} /></div>`;
}
