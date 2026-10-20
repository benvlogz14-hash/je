// Growth: prospect research, audits and approved one-to-one outreach.
import { html, useState, useApi, navigate, Button, HoldButton, Seg, Empty, Loading, Drawer, Field, Avatar, act, toast, promptDialog, confirmDialog } from '../lib/ui.js';
import { api } from '../lib/api.js';
import { Icon } from '../lib/icons.js';
import { ago, providerLabel } from '../lib/format.js';
import { Political } from './political.js';

const STAGES = [['new', 'New'], ['drafted', 'Draft ready'], ['contacted', 'Contacted'], ['replied', 'Replied'], ['meeting', 'Meeting'], ['proposal', 'Proposal'], ['won', 'Won'], ['lost', 'Lost']];

export function Growth() {
  const { data, loading, reload } = useApi('/api/prospects', ['prospects', 'job']);
  const { data: jobs } = useApi('/api/jobs?status=running,queued', ['job']);
  const [query, setQuery] = useState('');
  const [view, setView] = useState('board');
  const [open, setOpen] = useState(null);
  const researching = (jobs || []).filter((j) => j.type === 'prospect.research' || j.type === 'prospect.audit');
  const research = () => act(() => api.post('/api/command', { text: `/prospect ${query}` }), { ok: 'Research started. Results appear here.' }).then(() => setQuery(''));
  const cur = open && (data || []).find((p) => p.id === open);
  return html`<div class="page">
    <div class="page-head"><div class="grow"><h1>Growth</h1><div class="sub">Find political and creator clients. Agents research; you approve every first message.</div></div>
      <${Seg} value=${view} onChange=${setView} options=${[{ value: 'board', label: 'Pipeline' }, { value: 'table', label: 'Table' }, { value: 'political', label: 'Political packages' }]} />
      <${Button} kind="ghost" icon="plus" onClick=${async () => { const name = await promptDialog({ title: 'Add prospect', label: 'Name or handle', confirm: 'Add' }); if (name) act(() => api.post('/api/prospects', { name }), { ok: 'Added' }).then(reload); }}>Add manually</${Button}></div>
    ${view === 'political' ? html`<${Political} prospects=${data} reload=${reload} />` : html`<div class="panel pad row" style="gap:10px;margin-bottom:16px">
      <div class="avatar" style="background:var(--lav-soft);color:var(--lav-ink)"><${Icon} name="search" size=${17} /></div>
      <input class="input" id="prospect-query" placeholder="Who do you want? e.g. Connecticut state house candidates 2026 posting less than weekly on TikTok" value=${query} onInput=${(e) => setQuery(e.target.value)} onKeyDown=${(e) => { if (e.key === 'Enter' && query.trim()) research(); }} />
      <${Button} kind="lav" icon="sparkle" disabled=${!query.trim()} onClick=${research}>Research</${Button}>
    </div>
    ${researching.length ? html`<div class="notice lav" style="margin-bottom:14px"><span class="spinner" />${researching.map((j) => j.title).join(' · ')}</div>` : null}
    ${loading ? html`<${Loading} />` : !(data || []).length ? html`<div class="panel"><${Empty} icon="growth" title="No prospects yet">Describe who you want above. Grok (or your research agent) returns qualified, publicly listed prospects with a pitch angle. Nothing is ever sent without you.</${Empty}></div>`
      : view === 'board' ? html`<div class="board">${STAGES.map(([k, l]) => { const items = data.filter((p) => (p.stage || 'new') === k); return html`<section class="lane"><div class="lane-head"><b class="grow">${l}</b><span class="count">${items.length}</span></div><div class="lane-body">${items.map((p) => html`
          <div class="clip-card" style="grid-template-columns:1fr" onClick=${() => setOpen(p.id)}><div><div class="row"><b class="grow ellipsis">${p.name}</b><span class=${'badge ' + (p.type === 'political' ? 'slate' : 'teal')}>${p.type}</span></div>
            <div class="m">${p.handle ? html`<span class="ellipsis">${p.handle}</span>` : null}${p.followers ? html`<span>${p.followers}</span>` : null}${p.confidence ? html`<span class=${'badge ' + (p.confidence === 'high' ? 'moss' : p.confidence === 'low' ? 'coral' : 'gold')}>${p.confidence}</span>` : null}${p.audit ? html`<span class="badge lav">Audited</span>` : null}</div></div></div>`)}</div></section>`; })}</div>`
      : html`<div class="panel"><div class="table-wrap"><table class="table"><thead><tr><th>Name</th><th>Type</th><th>Handle</th><th>Why</th><th>Stage</th><th>Found</th></tr></thead><tbody>${data.map((p) => html`<tr class="click" onClick=${() => setOpen(p.id)}><td><b>${p.name}</b></td><td>${p.type}</td><td class="muted">${p.handle}</td><td class="muted ellipsis" style="max-width:320px">${p.why}</td><td>${STAGES.find((s) => s[0] === (p.stage || 'new'))?.[1]}</td><td class="faint">${ago(p.createdAt)}</td></tr>`)}</tbody></table></div></div>`}
    `}
    ${cur ? html`<${ProspectDrawer} p=${cur} onClose=${() => setOpen(null)} reload=${reload} />` : null}
  </div>`;
}

function ProspectDrawer({ p, onClose, reload }) {
  const [email, setEmail] = useState(/@/.test(p.publicContact || '') ? p.publicContact : '');
  const setStage = (stage) => act(() => api.patch(`/api/prospects/${p.id}`, { stage }), { sound: 'tap' }).then(reload);
  return html`<${Drawer} title=${p.name} sub=${[p.type, p.location, p.followers].filter(Boolean).join(' · ')} onClose=${onClose}>
    <div class="col" style="gap:16px">
      <div class="row wrap">${STAGES.map(([k, l]) => html`<button class=${'chip' + ((p.stage || 'new') === k ? ' on' : '')} onClick=${() => setStage(k)}>${l}</button>`)}</div>
      ${!p.verified ? html`<div class="notice gold"><${Icon} name="info" size=${16} /><div>Found by ${providerLabel(p.agent)} with ${p.confidence || 'unknown'} confidence. Verify details before reaching out.<div style="margin-top:6px"><${Button} size="sm" kind="gold" onClick=${() => act(() => api.patch(`/api/prospects/${p.id}`, { verified: true }), { ok: 'Marked verified' }).then(reload)}>Mark verified</${Button}></div></div></div>` : null}
      <dl class="kv"><dt>Handle</dt><dd class="selectable">${p.handle || '—'}</dd><dt>Platforms</dt><dd>${(p.platforms || []).join(', ') || '—'}</dd><dt>Public contact</dt><dd class="selectable">${p.publicContact || '—'}</dd><dt>Why</dt><dd>${p.why || '—'}</dd><dt>Angle</dt><dd>${p.angle || '—'}</dd></dl>
      <div class="panel pad col" style="gap:8px"><div class="row"><h4 class="grow">Social audit</h4><${Button} size="sm" kind="lav" icon="sparkle" onClick=${() => act(() => api.post(`/api/prospects/${p.id}/audit`), { ok: 'Audit started' })}>${p.audit ? 'Redo audit' : 'Run audit'}</${Button}></div>
        ${p.audit ? html`<div class="selectable" style="white-space:pre-wrap;font-size:var(--fs-sm);line-height:1.55">${p.audit}</div><div class="faint" style="font-size:var(--fs-xs)">${providerLabel(p.auditAgent)} · ${ago(p.auditedAt)}</div>` : html`<div class="faint" style="font-size:var(--fs-sm)">A short assessment of their current posting and three short-form opportunities, useful as the hook for outreach.</div>`}</div>
      <div class="panel pad col" style="gap:10px"><h4>Outreach</h4>
        <div class="muted" style="font-size:var(--fs-sm)">The writing agent drafts one personal message. It waits in the conversation until a founder holds to send it, and it includes an opt-out line.</div>
        ${!p.contactId ? html`<${Field} label="Public business email" id="pr-email"><input id="pr-email" class="input" value=${email} onInput=${(e) => setEmail(e.target.value)} placeholder="press@campaign.com" /></${Field}>` : null}
        <div class="row"><${Button} kind="primary" icon="sparkle" disabled=${!p.contactId && !email} onClick=${() => act(() => api.post(`/api/prospects/${p.id}/outreach`, { email }), { ok: 'Draft ready for approval' }).then((r) => { reload(); navigate(`/messages/${r.conversationId}`); })}>Draft outreach</${Button}>
          <div class="spacer" /><${Button} kind="moss" icon="check" onClick=${async () => { if (await confirmDialog({ title: `Convert ${p.name} to a client?`, text: 'Creates their client workspace and moves the prospect to Won.', confirm: 'Convert', kind: 'moss' })) act(() => api.post(`/api/prospects/${p.id}/convert`), { ok: 'Client created' }).then((c) => navigate(`/clients/${c.id}`)); }}>Convert to client</${Button}></div></div>
      <${Button} kind="ghost" icon="trash" onClick=${() => act(() => api.del(`/api/prospects/${p.id}`), { ok: 'Removed' }).then(() => { onClose(); reload(); })}>Remove prospect</${Button}>
    </div></${Drawer}>`;
}
