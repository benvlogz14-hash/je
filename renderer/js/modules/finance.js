// Finance: recurring revenue, client profitability, costs, tax reserve and founder distributions.
import { html, useState, useApi, Button, Loading, Avatar, StatusBadge, Modal, Field, act, BarChart } from '../lib/ui.js';
import { api } from '../lib/api.js';
import { Icon } from '../lib/icons.js';
import { money } from '../lib/format.js';

export function Finance() {
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const { data: s, loading, reload } = useApi(`/api/finance?month=${month}`, ['clients', 'posts']);
  const { data: invoices, reload: reloadInv } = useApi('/api/invoices', []);
  const [addExp, setAddExp] = useState(false);
  if (loading || !s) return html`<div class="page"><${Loading} /></div>`;
  return html`<div class="page">
    <div class="page-head"><div class="grow"><h1>Finance</h1><div class="sub">Revenue from ${s.revenueSource}. AI costs are tracked per call and charged to the client they served.</div></div>
      <input class="input" type="month" style="width:160px" value=${month} onInput=${(e) => setMonth(e.target.value)} aria-label="Month" />
      <${Button} kind="ghost" icon="plus" onClick=${() => setAddExp(true)}>Expense</${Button}>
      <${Button} kind="soft" icon="mail" onClick=${() => act(() => api.post('/api/invoices/draft'), { ok: (r) => `${r.length} draft invoice${r.length === 1 ? '' : 's'} created` }).then(reloadInv)}>Draft invoices</${Button}></div>
    <div class="grid c4">${[['Monthly recurring', money(s.mrr), `${money(s.arr)} a year · ${s.activeClients} clients`], ['Profit', money(s.profit), s.margin != null ? `${s.margin}% margin` : '—'], ['AI and compute', money(s.aiCost, 2), Object.entries(s.aiByProvider).map(([k, v]) => `${{ anthropic: 'Claude', openai: 'GPT', xai: 'Grok' }[k] || k} ${money(v, 2)}`).join(' · ') || 'No usage yet'], ['Founder hours / client', s.hoursPerClient, `${s.totalHours} h logged this month · target 2`]].map(([l, v, d]) => html`<div class="panel kpi"><div class="eyebrow">${l}</div><div class="v">${v}</div><div class="d">${d}</div></div>`)}</div>
    <div class="grid c2" style="margin-top:14px;align-items:start">
      <div class="panel"><div class="panel-head"><h4 class="grow">Where the money goes</h4></div><div class="list">
        ${[['Revenue', s.revenue, 'var(--ink)'], ['AI and compute', -s.aiCost, 'var(--coral-ink)'], ['Other expenses', -s.expenses, 'var(--coral-ink)'], ['Profit', s.profit, 'var(--ink)'], [`Tax reserve`, -s.taxReserve, 'var(--gold-ink)'], ['Retained in business', -s.retained, 'var(--slate-ink)'], ['Distributable to founders', s.distributable, 'var(--moss-ink)']].map(([l, v, c], i) => html`<div class="list-row" style=${i === 3 || i === 6 ? { fontWeight: 600, background: 'var(--surface-2)' } : null}><span class="grow">${l}</span><span class="tnum" style=${{ color: c }}>${v < 0 ? '−' : ''}${money(Math.abs(v), 2)}</span></div>`)}</div></div>
      <div class="panel"><div class="panel-head"><h4 class="grow">Founder distributions</h4><span class="faint" style="font-size:var(--fs-xs)">Ownership and distribution shares are set separately in Settings</span></div><div class="list">
        ${s.founders.map((f) => html`<div class="list-row"><${Avatar} name=${f.name} size="sm" /><div class="grow"><b>${f.name}</b><div class="faint" style="font-size:var(--fs-xs)">Owns ${f.ownershipPct}% · receives ${f.distributionPct}% of distributions</div></div><b class="tnum">${money(f.distribution, 2)}</b></div>`)}</div>
        <div class="panel-body" style="border-top:1px solid var(--line)"><${BarChart} height=${140} data=${Object.entries(s.byService).map(([k, v], i) => ({ label: k, value: v, color: ['var(--teal)', 'var(--slate)', 'var(--gold)', 'var(--moss)'][i % 4] }))} format=${(v) => money(v)} /></div></div>
    </div>
    <div class="panel" style="margin-top:14px"><div class="panel-head"><h4 class="grow">Client profitability</h4></div><div class="table-wrap"><table class="table"><thead><tr><th>Client</th><th class="num">Retainer</th><th class="num">AI cost</th><th class="num">Other</th><th class="num">Profit</th><th class="num">Margin</th><th class="num">Shorts</th><th class="num">Cost / short</th><th class="num">Hours</th></tr></thead><tbody>
      ${s.perClient.map((c) => html`<tr><td><b>${c.name}</b> <span class="faint">${c.status !== 'active' ? c.status : ''}</span></td><td class="num">${money(c.revenue)}</td><td class="num">${money(c.aiCost, 2)}</td><td class="num">${money(c.expenses)}</td><td class="num">${money(c.profit, 2)}</td><td class="num">${c.margin != null ? c.margin + '%' : '—'}</td><td class="num">${c.published}</td><td class="num">${c.costPerShort != null ? money(c.costPerShort, 2) : '—'}</td><td class="num">${c.hours}</td></tr>`)}
      ${!s.perClient.length ? html`<tr><td colspan="9" class="faint">No clients yet</td></tr>` : null}</tbody></table></div></div>
    <div class="grid c2" style="margin-top:14px;align-items:start">
      <div class="panel"><div class="panel-head"><h4 class="grow">Invoices</h4><span class="faint" style="font-size:var(--fs-sm)">${money(s.outstandingTotal)} outstanding</span></div><div class="list">
        ${(invoices || []).slice(0, 12).map((i) => html`<div class="list-row"><span class="mono" style="width:76px">${i.number}</span><span class="grow ellipsis">${i.client} · ${i.period}</span><span class="tnum" style="width:80px;text-align:right">${money(i.amount)}</span><${StatusBadge} status=${i.status} />
          ${i.status === 'draft' ? html`<${Button} size="sm" kind="ghost" onClick=${() => act(() => api.patch(`/api/invoices/${i.id}`, { status: 'sent' }), { ok: 'Marked sent' }).then(() => { reloadInv(); reload(); })}>Mark sent</${Button}>` : i.status === 'sent' ? html`<${Button} size="sm" kind="moss" onClick=${() => act(() => api.patch(`/api/invoices/${i.id}`, { status: 'paid' }), { ok: 'Marked paid' }).then(() => { reloadInv(); reload(); })}>Paid</${Button}>` : null}</div>`)}
        ${!(invoices || []).length ? html`<div class="list-row faint">No invoices. "Draft invoices" creates one per active retainer for this month; nothing is sent automatically.</div>` : null}</div></div>
      <div class="panel"><div class="panel-head"><h4 class="grow">Expenses this month</h4></div><div class="list">
        ${s.expenseItems.map((e) => html`<div class="list-row"><span class="grow">${e.label}${e.recurring ? html` <span class="badge outline">Monthly</span>` : null}</span><span class="faint">${e.category}</span><span class="tnum" style="width:80px;text-align:right">${money(e.amount, 2)}</span><${Button} size="sm" kind="ghost" icon="trash" title="Remove" onClick=${() => act(() => api.del(`/api/expenses/${e.id}`), { sound: 'tap' }).then(reload)} /></div>`)}
        ${!s.expenseItems.length ? html`<div class="list-row faint">Add software, storage, contractors and other costs to see true margins.</div>` : null}
        <div class="list-row"><span class="grow faint">Renewals in 30 days</span>${s.renewals.length ? s.renewals.map((r) => html`<span class="badge gold">${r.name} · ${r.date}</span>`) : html`<span class="faint">None</span>`}</div>
        <div class="list-row"><span class="grow faint">Prospect conversion</span><span class="tnum">${s.prospects.conversion != null ? `${s.prospects.conversion}% (${s.prospects.won} of ${s.prospects.contacted})` : '—'}</span></div>
        <div class="list-row"><span class="grow faint">Churn, last 90 days</span><span class="tnum">${s.churn90}%</span></div></div></div>
    </div>
    ${addExp ? html`<${ExpenseModal} onClose=${() => { setAddExp(false); reload(); }} />` : null}
  </div>`;
}

function ExpenseModal({ onClose }) {
  const { data: clients } = useApi('/api/clients', []);
  const [f, setF] = useState({ label: '', amount: '', category: 'software', recurring: false, clientId: '' });
  return html`<${Modal} title="Add expense" icon="finance" onClose=${onClose} footer=${html`<${Button} kind="ghost" onClick=${onClose}>Cancel</${Button}><${Button} kind="primary" disabled=${!f.label || !f.amount} onClick=${() => act(() => api.post('/api/expenses', { ...f, amount: Number(f.amount), clientId: f.clientId || null }), { ok: 'Expense added' }).then(onClose)}>Add</${Button}>`}>
    <div class="form-grid">
      <${Field} label="What" id="ex-l"><input id="ex-l" class="input" value=${f.label} onInput=${(e) => setF({ ...f, label: e.target.value })} placeholder="Ayrshare Premium" autofocus /></${Field}>
      <${Field} label="Amount (USD)" id="ex-a"><input id="ex-a" class="input tnum" type="number" value=${f.amount} onInput=${(e) => setF({ ...f, amount: e.target.value })} /></${Field}>
      <${Field} label="Category" id="ex-c"><select id="ex-c" class="select" value=${f.category} onChange=${(e) => setF({ ...f, category: e.target.value })}>${['software', 'contractor', 'equipment', 'storage', 'travel', 'ads', 'other'].map((c) => html`<option>${c}</option>`)}</select></${Field}>
      <${Field} label="Charge to client" id="ex-cl"><select id="ex-cl" class="select" value=${f.clientId} onChange=${(e) => setF({ ...f, clientId: e.target.value })}><option value="">Agency overhead</option>${(clients || []).map((c) => html`<option value=${c.id}>${c.name}</option>`)}</select></${Field}>
    </div>
    <label class="check-row"><input type="checkbox" checked=${f.recurring} onChange=${(e) => setF({ ...f, recurring: e.target.checked })} />Repeats monthly</label>
  </${Modal}>`;
}
