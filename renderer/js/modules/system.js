// System: agents, job queue, health, resources (power modes) and the audit log.
import { html, useState, useEffect, useStore, useApi, useEvent, navigate, Button, HoldButton, Seg, Tabs, Toggle, Field, StatusBadge, Progress, Loading, Empty, Sparkline, act, toast } from '../lib/ui.js';
import { api } from '../lib/api.js';
import { Icon } from '../lib/icons.js';
import { money, ago, actorName, dateTime } from '../lib/format.js';
import { JobRow } from './cards.js';
import { AgentConversations } from './agents.js';

export function System() {
  const route = useStore((s) => s.route);
  const [tab, setTab] = useState(route.query.tab || 'agents');
  useEffect(() => { if (route.query.tab) setTab(route.query.tab); }, [route.query.tab]);
  const { data: q } = useApi('/api/queue/stats', ['job', 'queue']);
  return html`<div class="page">
    <div class="page-head"><div class="grow"><h1>System</h1><div class="sub">Everything Euclidean is doing, and everything it is connected to.</div></div></div>
    <${Tabs} value=${tab} onChange=${(t) => { setTab(t); navigate(`/system?tab=${t}`); }} tabs=${[{ value: 'agents', label: 'Agents' }, { value: 'conversations', label: 'Agent conversations' }, { value: 'queue', label: 'Queue', badge: q?.failed24h || 0 }, { value: 'health', label: 'Health' }, { value: 'resources', label: 'Resources' }, { value: 'logs', label: 'Activity log' }]} />
    ${tab === 'agents' ? html`<${Agents} />` : tab === 'conversations' ? html`<${AgentConversations} />` : tab === 'queue' ? html`<${Queue} />` : tab === 'health' ? html`<${Health} />` : tab === 'resources' ? html`<${Resources} />` : html`<${Logs} />`}
  </div>`;
}

function Agents() {
  const { data } = useApi('/api/agents', ['agents']);
  const boot = useStore((s) => s.boot);
  const [roles, setRoles] = useState(null);
  useEffect(() => { if (data && !roles) setRoles(JSON.parse(JSON.stringify(data.roles))); }, [data]);
  if (!data || !roles) return html`<${Loading} />`;
  const dirty = JSON.stringify(roles) !== JSON.stringify(data.roles);
  const P = data.providers;
  return html`<div class="col" style="gap:14px">
    <div class="grid c4">${Object.entries(P).map(([k, p]) => html`<div class="panel pad col" style="gap:8px">
      <div class="row"><span class=${'led ' + (!p.connected ? '' : p.health && !p.health.ok ? 'err' : p.busy ? 'live' : 'ok')} /><b class="grow">${p.label}</b><span class="faint" style="font-size:var(--fs-xs)">${p.vendor}</span></div>
      <div class="muted" style="font-size:var(--fs-sm)">${!p.connected ? 'Not connected' : p.health && !p.health.ok ? p.health.error : p.busy ? `${p.busy} call${p.busy > 1 ? 's' : ''} running` : 'Ready'}</div>
      <div><div class="row" style="font-size:var(--fs-xs)"><span class="faint grow">This month</span><span class="tnum">${money(p.spendUsd, 2)} of ${money(p.budgetUsd)}</span></div><${Progress} value=${p.budgetUsd ? p.spendUsd / p.budgetUsd : 0} color=${p.overBudget ? 'var(--coral)' : 'var(--teal)'} /></div>
      ${p.connected ? html`<${Button} size="sm" kind="ghost" icon="refresh" onClick=${() => act(() => api.post(`/api/agents/test/${k}`), { ok: (r) => (r.ok ? `${p.label} responded · ${r.models?.length || 0} models available` : r.error) })}>Test</${Button}>` : html`<${Button} size="sm" kind="soft" onClick=${() => navigate('/settings?tab=connections')}>Connect</${Button}>`}</div>`)}
      <div class="panel pad col" style="gap:8px">
        <div class="row"><span class=${'led ' + (data.computerUse.online ? 'ok' : '')} /><b class="grow">Astra</b><span class="faint" style="font-size:var(--fs-xs)">Computer use</span></div>
        <div class="muted" style="font-size:var(--fs-sm)">${data.computerUse.online ? `Online · ${data.computerUse.agents.filter((a) => a.online).map((a) => a.name).join(', ')}` : 'Not checked in. Edits for Premiere wait in the queue.'}</div>
        <div class="faint" style="font-size:var(--fs-xs)">${data.computerUse.waiting} work order${data.computerUse.waiting === 1 ? '' : 's'} waiting</div>
        <${Button} size="sm" kind="ghost" onClick=${() => navigate('/settings?tab=team')}>Agent tokens</${Button}></div>
    </div>
    <div class="panel"><div class="panel-head"><div class="grow"><h4>Roles</h4><div class="muted" style="font-size:var(--fs-sm)">Which model does which job. If one fails or hits its budget, the next provider in the fallback list takes over.</div></div>${dirty ? html`<${Button} kind="primary" size="sm" onClick=${() => act(() => api.patch('/api/settings', { ai: { roles } }), { ok: 'Agent roles saved' })}>Save roles</${Button}>` : null}</div>
      <div class="table-wrap"><table class="table"><thead><tr><th>Role</th><th>Primary</th><th>Model</th><th>Fallbacks</th></tr></thead><tbody>
        ${Object.entries(roles).map(([k, r]) => html`<tr><td><b style="text-transform:capitalize">${k}</b><div class="faint" style="font-size:var(--fs-xs)">${r.description}</div></td>
          <td><select class="select sm" style="width:120px" value=${r.provider} onChange=${(e) => setRoles({ ...roles, [k]: { ...r, provider: e.target.value } })} aria-label=${`${k} provider`}>${Object.entries(P).map(([pk, p]) => html`<option value=${pk}>${p.label}</option>`)}</select></td>
          <td><input class="input sm mono" style="width:190px" value=${r.model} onInput=${(e) => setRoles({ ...roles, [k]: { ...r, model: e.target.value } })} aria-label=${`${k} model`} /></td>
          <td><div class="chips">${Object.entries(P).filter(([pk]) => pk !== r.provider).map(([pk, p]) => html`<button class=${'chip' + ((r.fallbacks || []).includes(pk) ? ' on' : '')} onClick=${() => setRoles({ ...roles, [k]: { ...r, fallbacks: (r.fallbacks || []).includes(pk) ? r.fallbacks.filter((x) => x !== pk) : [...(r.fallbacks || []), pk] } })}>${p.label}</button>`)}</div></td></tr>`)}
      </tbody></table></div></div>
    <div class="panel"><div class="panel-head"><h4 class="grow">Recent agent calls</h4><span class="faint" style="font-size:var(--fs-sm)">${data.usage.length} this month</span></div><div class="table-wrap"><table class="table"><thead><tr><th>When</th><th>Agent</th><th>Role</th><th>Model</th><th class="num">Tokens in / out</th><th class="num">Cost</th></tr></thead><tbody>
      ${data.usage.slice(0, 25).map((u) => html`<tr><td class="faint">${ago(u.createdAt)}</td><td>${{ anthropic: 'Claude', openai: 'GPT', xai: 'Grok' }[u.provider]}</td><td class="muted">${u.role}</td><td class="mono muted">${u.model}</td><td class="num">${u.inTok.toLocaleString()} / ${u.outTok.toLocaleString()}</td><td class="num">${money(u.costUsd, 4)}</td></tr>`)}
      ${!data.usage.length ? html`<tr><td colspan="6" class="faint">No agent calls yet this month.</td></tr>` : null}</tbody></table></div></div>
  </div>`;
}

function Queue() {
  const [filter, setFilter] = useState('active');
  const status = { active: 'running,queued,waiting_agent', failed: 'failed', done: 'done', all: '' }[filter];
  const { data } = useApi(`/api/jobs?limit=200${status ? `&status=${status}` : ''}`, ['job']);
  const { data: st } = useApi('/api/queue/stats', ['job', 'queue']);
  const [open, setOpen] = useState(null);
  return html`<div class="col" style="gap:14px">
    <div class="row wrap"><${Seg} value=${filter} onChange=${setFilter} options=${[{ value: 'active', label: 'Active' }, { value: 'failed', label: 'Failed' }, { value: 'done', label: 'Done' }, { value: 'all', label: 'All' }]} />
      <span class="faint" style="font-size:var(--fs-sm)">${st ? `${st.running} running · ${st.queued} queued · ${st.done24h} done and ${st.failed24h} failed in 24h` : ''}</span><div class="spacer" />
      ${filter === 'failed' && data?.length ? html`<${Button} kind="soft" size="sm" icon="refresh" onClick=${() => act(() => api.post('/api/command', { text: '/retry all' }), { ok: 'Retrying failed jobs' })}>Retry all</${Button}>` : null}
      ${st?.paused ? html`<${Button} kind="moss" size="sm" icon="play" onClick=${() => act(() => api.post('/api/queue/resume'), { ok: 'Resumed' })}>Resume automation</${Button}>` : html`<${HoldButton} kind="coral" size="sm" icon="pause" onConfirm=${() => act(() => api.post('/api/queue/pause'), { ok: 'Paused' })}>Hold to pause all</${HoldButton}>`}</div>
    <div class="panel">${!data ? html`<${Loading} />` : !data.length ? html`<${Empty} icon="layers" title="Nothing here">Jobs survive restarts and retry automatically with backoff.</${Empty}>` : html`<div class="list">${data.map((j) => html`<div onClick=${() => setOpen(j.id)} style="cursor:pointer"><${JobRow} j=${j} /></div>`)}</div>`}</div>
    ${open ? html`<${JobDetail} id=${open} onClose=${() => setOpen(null)} />` : null}
  </div>`;
}

function JobDetail({ id, onClose }) {
  const { data: j } = useApi(`/api/jobs/${id}`, ['job']);
  if (!j) return null;
  return html`<div class="scrim" onClick=${onClose} /><aside class="drawer" role="dialog"><div class="drawer-head"><div class="grow"><h3>${j.title}</h3><div class="muted mono" style="font-size:var(--fs-xs)">${j.type} · ${j.id}</div></div><${Button} kind="ghost" size="sm" icon="x" onClick=${onClose} /></div>
    <div class="drawer-body col" style="gap:12px"><div class="row wrap"><${StatusBadge} status=${j.status} /><span class="badge outline">Attempt ${j.attempts} of ${j.maxAttempts}</span><span class="badge outline">${j.heavy ? 'Heavy' : 'Light'}</span>${j.workerId ? html`<span class="badge outline">${j.workerId}</span>` : null}</div>
      ${j.status === 'running' ? html`<${Progress} value=${j.progress} />` : null}
      ${j.error ? html`<div class="notice coral"><${Icon} name="alert" size=${16} /><div class="selectable">${j.error}</div></div>` : null}
      <dl class="kv"><dt>Created</dt><dd>${dateTime(j.createdAt)} by ${actorName(j.createdBy)}</dd><dt>Run at</dt><dd>${dateTime(j.runAt)}</dd><dt>Finished</dt><dd>${dateTime(j.finishedAt) || '—'}</dd><dt>Note</dt><dd>${j.note || '—'}</dd></dl>
      <div class="eyebrow">Log</div><div class="panel mono selectable" style="padding:10px;font-size:11.5px;max-height:300px;overflow:auto;white-space:pre-wrap">${(j.log || []).map((l) => `${l.at.slice(11, 19)}  ${l.msg}`).join('\n') || 'No log entries'}</div>
      ${j.result ? html`<div class="eyebrow">Result</div><pre class="panel mono selectable" style="padding:10px;font-size:11.5px;overflow:auto;margin:0">${JSON.stringify(j.result, null, 2)}</pre>` : null}
      <div class="row">${j.status === 'failed' || j.status === 'canceled' ? html`<${Button} kind="soft" icon="refresh" onClick=${() => act(() => api.post(`/api/jobs/${j.id}/retry`), { ok: 'Retrying' })}>Retry</${Button}>` : null}${['queued', 'running', 'waiting_agent'].includes(j.status) ? html`<${Button} kind="ghost" icon="x" onClick=${() => act(() => api.post(`/api/jobs/${j.id}/cancel`), { ok: 'Canceled' })}>Cancel</${Button}>` : null}</div></div></aside>`;
}

function Health() {
  const { data, reload } = useApi('/api/health', ['health']);
  if (!data) return html`<${Loading} />`;
  const order = { error: 0, warn: 1, setup: 2, ok: 3 };
  return html`<div class="col" style="gap:14px">
    <div class="row"><span class="badge moss">${data.summary.ok} OK</span><span class="badge gold">${data.summary.warn} warnings</span><span class="badge coral">${data.summary.error} errors</span>${data.summary.setup ? html`<span class="badge slate" title="Optional services you can connect later">${data.summary.setup} optional, not set up</span>` : null}<span class="faint" style="font-size:var(--fs-sm)">Checked ${ago(data.at)} ago · every minute</span><div class="spacer" /><${Button} kind="ghost" size="sm" icon="refresh" onClick=${reload}>Check now</${Button}></div>
    <div class="panel"><div class="list">${data.items.slice().sort((a, b) => order[a.level] - order[b.level]).map((i) => html`<div class="list-row" style="align-items:flex-start">
      <span class=${'led ' + (i.level === 'error' ? 'err' : i.level === 'warn' ? 'warn' : i.level === 'setup' ? '' : 'ok')} style="margin-top:6px" /><div class="grow"><b>${i.label}</b><div class="muted" style="font-size:var(--fs-sm)">${i.text}</div>${i.level !== 'ok' && i.fix ? html`<div class="faint" style="font-size:var(--fs-xs);margin-top:2px">${i.level === 'setup' ? 'To set up' : 'Fix'}: ${i.fix}</div>` : null}</div></div>`)}</div></div></div>`;
}

function Resources() {
  const { data, reload } = useApi('/api/resources', []);
  const boot = useStore((s) => s.boot);
  const [cur, setCur] = useState(null);
  const [r, setR] = useState(boot.settings.resources);
  useEvent('resources', (x) => setCur(x));
  useEffect(() => { const t = setInterval(reload, 8000); return () => clearInterval(t); }, []);
  const now = cur || data?.current; const hist = data?.history || [];
  const dirty = JSON.stringify(r) !== JSON.stringify(boot.settings.resources);
  if (!now) return html`<${Loading} />`;
  return html`<div class="col" style="gap:14px">
    <div class="panel pad col" style="gap:12px"><h3>Power mode</h3>
      <div class="grid c3">${[['full', 'bolt', 'Full', 'Everything runs: rendering, transcription, discovery, analytics.'], ['lite', 'leaf', 'Lite', 'Vital functions only: messages, approvals, publishing and safety. Frees RAM and CPU for Premiere and Astra.'], ['background', 'archive', 'Background', 'Closes the window to the tray. The engine keeps doing all the work; reopen from the tray icon.']].map(([k, ic, l, d]) => html`
        <button class="panel pad" style=${{ textAlign: 'left', cursor: 'pointer', borderColor: now.mode === k ? 'var(--teal)' : 'var(--line)', background: now.mode === k ? 'var(--teal-soft)' : 'var(--surface)', boxShadow: now.mode === k ? '0 0 0 2px var(--focus)' : 'none' }} onClick=${() => act(() => api.post('/api/mode', { mode: k }), { ok: `${l} mode`, sound: 'toggle' })}>
          <div class="row"><${Icon} name=${ic} size=${18} /><b>${l}</b>${now.mode === k ? html`<span class="badge teal" style="margin-left:auto">On</span>` : null}</div><div class="muted" style="font-size:var(--fs-sm);margin-top:6px">${d}</div></button>`)}</div></div>
    <div class="grid c4">
      <div class="panel kpi"><div class="eyebrow">CPU</div><div class="v">${now.cpu}%</div><div class="d">${now.cores} cores</div><${Sparkline} values=${hist.map((h) => h.cpu)} width=${200} max=${100} /></div>
      <div class="panel kpi"><div class="eyebrow">Memory</div><div class="v">${((now.ramTotalMb - now.ramFreeMb) / 1024).toFixed(1)} GB</div><div class="d">${(now.ramFreeMb / 1024).toFixed(1)} GB free of ${(now.ramTotalMb / 1024).toFixed(0)} GB</div><${Sparkline} values=${hist.map((h) => h.ram)} width=${200} max=${now.ramTotalMb} color="var(--slate)" /></div>
      <div class="panel kpi"><div class="eyebrow">GPU</div><div class="v">${now.gpu ? now.gpu.util + '%' : '—'}</div><div class="d">${now.gpu ? `${now.gpu.name} · ${Math.round(now.gpu.memUsedMb / 1024 * 10) / 10}/${Math.round(now.gpu.memTotalMb / 1024)} GB` : 'No NVIDIA GPU detected'}</div>${now.gpu ? html`<${Sparkline} values=${hist.map((h) => h.gpu || 0)} width=${200} max=${100} color="var(--lav)" />` : null}</div>
      <div class="panel kpi"><div class="eyebrow">Euclidean itself</div><div class="v">${now.engineMb + (now.uiMb || 0)} MB</div><div class="d">Engine ${now.engineMb} MB${now.uiMb ? ` · window ${now.uiMb} MB` : ''}${now.disk ? ` · ${now.disk.freeGb} GB disk free` : ''}</div></div>
    </div>
    ${data?.gate && !data.gate.ok ? html`<div class="notice gold"><${Icon} name="clock" size=${16} />${data.gate.reason}</div>` : null}
    <div class="panel pad col" style="gap:14px"><div class="row"><h3 class="grow">Limits</h3>${dirty ? html`<${Button} kind="primary" size="sm" onClick=${() => act(() => api.patch('/api/settings', { resources: r }), { ok: 'Limits saved' })}>Save limits</${Button}>` : null}</div>
      <div class="form-grid">
        <${Field} label=${`Keep free for editing · ${(r.reserveRamMb / 1024).toFixed(1)} GB`} hint="Renders wait if free RAM drops below this, so Premiere and Astra always have room." id="rs-ram"><input id="rs-ram" class="range" type="range" min="0" max=${Math.max(2048, now.ramTotalMb - 1024)} step="256" value=${r.reserveRamMb} onInput=${(e) => setR({ ...r, reserveRamMb: Number(e.target.value) })} /></${Field}>
        <${Field} label=${`Pause renders above CPU · ${r.pauseHeavyWhenCpuAbove}%`} id="rs-cpu"><input id="rs-cpu" class="range" type="range" min="40" max="100" value=${r.pauseHeavyWhenCpuAbove} onInput=${(e) => setR({ ...r, pauseHeavyWhenCpuAbove: Number(e.target.value) })} /></${Field}>
        <${Field} label="Renders at once" id="rs-max"><input id="rs-max" class="input tnum" type="number" min="0" max="8" value=${r.maxConcurrentRenders} onInput=${(e) => setR({ ...r, maxConcurrentRenders: Number(e.target.value) })} /></${Field}>
        <${Field} label="FFmpeg threads (0 = auto)" id="rs-thr"><input id="rs-thr" class="input tnum" type="number" min="0" max="64" value=${r.renderThreads} onInput=${(e) => setR({ ...r, renderThreads: Number(e.target.value) })} /></${Field}>
        <${Field} label="Render priority" id="rs-pri"><select id="rs-pri" class="select" value=${r.renderPriority} onChange=${(e) => setR({ ...r, renderPriority: e.target.value })}><option value="low">Low (gentlest)</option><option value="below_normal">Below normal</option><option value="normal">Normal</option></select></${Field}>
      </div>
      <div class="col" style="gap:4px">${[['pauseHeavyWhenPremiereOpen', 'Pause renders while Premiere Pro is open'], ['autoLiteWhenPremiereOpen', 'Switch to Lite mode automatically when Premiere opens'], ['runHeavyJobsLocally', 'Render on this computer (turn off to leave renders for the editing desktop worker)']].map(([k, l]) => html`<div class="check-row"><${Toggle} on=${!!r[k]} label=${l} onChange=${(v) => setR({ ...r, [k]: v })} /><span>${l}</span></div>`)}</div>
    </div>
    <${Workers} />
  </div>`;
}

function Workers() {
  const { data } = useApi('/api/workers', ['job']);
  return html`<div class="panel"><div class="panel-head"><div class="grow"><h4>Worker machines</h4><div class="muted" style="font-size:var(--fs-sm)">Old desktops that render for this engine. On the worker: <span class="mono">npm run worker -- --engine http://THIS-PC:4870 --token WORKER_TOKEN</span></div></div></div>
    <div class="list">${(data || []).map((w) => html`<div class="list-row"><span class=${'led ' + (w.online ? 'ok' : '')} /><b class="grow">${w.name}</b><span class="faint">${w.capabilities.join(', ')}</span><span class="faint" style="font-size:var(--fs-xs)">${w.online ? 'Online' : `Last seen ${ago(w.lastSeen)} ago`}</span></div>`)}${!(data || []).length ? html`<div class="list-row faint">No workers registered. Create a worker token in Settings → Team, then start the worker on the other machine.</div>` : null}</div></div>`;
}

function Logs() {
  const [q, setQ] = useState('');
  const [level, setLevel] = useState('');
  const { data } = useApi(`/api/logs?limit=400${q ? `&q=${encodeURIComponent(q)}` : ''}${level ? `&level=${level}` : ''}`, ['audit']);
  return html`<div class="col" style="gap:12px">
    <div class="row"><div class="input-group" style="flex:1;max-width:420px"><${Icon} name="search" size=${15} style="color:var(--ink-3)" /><input class="input sm" placeholder="Filter: message.sent, Stringer, publish…" value=${q} onInput=${(e) => setQ(e.target.value)} aria-label="Filter log" /></div>
      <${Seg} value=${level} onChange=${setLevel} options=${[{ value: '', label: 'All' }, { value: 'warn', label: 'Warnings' }, { value: 'error', label: 'Errors' }]} /></div>
    <div class="panel"><div class="table-wrap"><table class="table"><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Detail</th></tr></thead><tbody>
      ${(data || []).map((e) => html`<tr><td class="faint tnum" style="white-space:nowrap">${dateTime(e.at)}</td><td>${actorName(e.actor)}</td><td><span class=${'led ' + (e.level === 'error' ? 'err' : e.level === 'warn' ? 'warn' : '')} style="display:inline-block;margin-right:6px" /><span class="mono">${e.action}</span></td><td class="muted mono selectable" style="font-size:11px;max-width:520px;overflow-wrap:anywhere">${JSON.stringify(e.detail)}</td></tr>`)}</tbody></table></div></div></div>`;
}
