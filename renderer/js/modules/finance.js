// Finance: recurring revenue, client profitability, costs, tax reserve and founder distributions.
import { html, useState, useApi, Button, Loading, Avatar, StatusBadge, Modal, Field, act, BarChart, promptDialog, store } from '../lib/ui.js';
import { api } from '../lib/api.js';
import { Icon } from '../lib/icons.js';
import { money } from '../lib/format.js';

export function Finance() {
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const { data: s, loading, reload } = useApi(`/api/finance?month=${month}`, ['clients', 'posts']);
  const { data: invoices, reload: reloadInv } = useApi('/api/invoices', []);
  const [addExp, setAddExp] = useState(false); const [split, setSplit] = useState(false); const [hours, setHours] = useState(false);
  const editMoney = async (title, cur, save) => { const v = await promptDialog({ title, label: 'US dollars', value: String(cur ?? ''), confirm: 'Save' }); if (v != null && v !== '') act(() => save(Number(String(v).replace(/[^\d.]/g, '')) || 0), { ok: 'Saved' }).then(() => { reload(); reloadInv(); }); };
  if (loading || !s) return html`<div class="page"><${Loading} /></div>`;
  return html`<div class="page">
    <div class="page-head"><div class="grow"><h1>Finance</h1><div class="sub">Revenue from ${s.revenueSource}. AI costs are tracked per call and charged to the client they served.</div></div>
      <input class="input" type="month" style="width:160px" value=${month} onInput=${(e) => setMonth(e.target.value)} aria-label="Month" />
      <${Button} kind="ghost" icon="plus" onClick=${() => setAddExp(true)}>Expense</${Button}>
      <${Button} kind="ghost" icon="clock" onClick=${() => setHours(true)}>Log hours</${Button}>
      <${Button} kind="soft" icon="mail" onClick=${() => act(() => api.post('/api/invoices/draft'), { ok: (r) => `${r.length} draft invoice${r.length === 1 ? '' : 's'} created` }).then(reloadInv)}>Draft invoices</${Button}></div>
    <div class="grid c4">${[['Monthly recurring', money(s.mrr), `${money(s.arr)} a year · ${s.activeClients} clients`], ['Profit', money(s.profit), s.margin != null ? `${s.margin}% margin` : '—'], ['AI and compute', money(s.aiCost, 2), Object.entries(s.aiByProvider).map(([k, v]) => `${{ anthropic: 'Claude', openai: 'GPT', xai: 'Grok' }[k] || k} ${money(v, 2)}`).join(' · ') || 'No usage yet'], ['Founder hours / client', s.hoursPerClient, `${s.totalHours} h logged this month · target 2`]].map(([l, v, d]) => html`<div class="panel kpi"><div class="eyebrow">${l}</div><div class="v">${v}</div><div class="d">${d}</div></div>`)}</div>
    <div class="grid c2" style="margin-top:14px;align-items:start">
      <div class="panel"><div class="panel-head"><h4 class="grow">Where the money goes</h4></div><div class="list">
        ${[['Revenue', s.revenue, 'var(--ink)'], ['AI and compute', -s.aiCost, 'var(--coral-ink)'], ['Other expenses', -s.expenses, 'var(--coral-ink)'], ['Profit', s.profit, 'var(--ink)'], [`Tax reserve (click to change %)`, -s.taxReserve, 'var(--gold-ink)'], ['Retained in business (click to change %)', -s.retained, 'var(--slate-ink)'], ['Distributable to founders', s.distributable, 'var(--moss-ink)']].map(([l, v, c], i) => html`<div class="list-row" style=${{ ...(i === 3 || i === 6 ? { fontWeight: 600, background: 'var(--surface-2)' } : {}), ...(i === 4 || i === 5 ? { cursor: 'pointer' } : {}) }} onClick=${() => (i === 4 || i === 5) && setSplit(true)}><span class="grow">${l}</span><span class="tnum" style=${{ color: c }}>${v < 0 ? '−' : ''}${money(Math.abs(v), 2)}</span></div>`)}</div></div>
      <div class="panel"><div class="panel-head"><h4 class="grow">Founder distributions</h4><${Button} size="sm" kind="soft" icon="edit" onClick=${() => setSplit(true)}>Edit split</${Button}></div><div class="list">
        ${s.founders.map((f) => html`<div class="list-row"><${Avatar} name=${f.name} size="sm" /><div class="grow"><b>${f.name}</b><div class="faint" style="font-size:var(--fs-xs)">Owns ${f.ownershipPct}% · receives ${f.distributionPct}% of distributions</div></div><b class="tnum">${money(f.distribution, 2)}</b></div>`)}</div>
        <div class="panel-body" style="border-top:1px solid var(--line)"><${BarChart} height=${140} data=${Object.entries(s.byService).map(([k, v], i) => ({ label: k, value: v, color: ['var(--teal)', 'var(--slate)', 'var(--gold)', 'var(--moss)'][i % 4] }))} format=${(v) => money(v)} /></div></div>
    </div>
    <div class="panel" style="margin-top:14px"><div class="panel-head"><h4 class="grow">Client profitability</h4></div><div class="table-wrap"><table class="table"><thead><tr><th>Client</th><th class="num">Retainer</th><th class="num">AI cost</th><th class="num">Other</th><th class="num">Profit</th><th class="num">Margin</th><th class="num">Shorts</th><th class="num">Cost / short</th><th class="num">Hours</th></tr></thead><tbody>
      ${s.perClient.map((c) => html`<tr><td><b>${c.name}</b> <span class="faint">${c.status !== 'active' ? c.status : ''}</span></td><td class="num"><button class="chip tnum" title="Change what this client pays" onClick=${() => editMoney(`Monthly retainer for ${c.name}`, c.revenue, (v) => api.patch(`/api/clients/${c.id}`, { retainer: { amount: v } }))}>${money(c.revenue)} ✎</button></td><td class="num">${money(c.aiCost, 2)}</td><td class="num">${money(c.expenses)}</td><td class="num">${money(c.profit, 2)}</td><td class="num">${c.margin != null ? c.margin + '%' : '—'}</td><td class="num">${c.published}</td><td class="num">${c.costPerShort != null ? money(c.costPerShort, 2) : '—'}</td><td class="num">${c.hours}</td></tr>`)}
      ${!s.perClient.length ? html`<tr><td colspan="9" class="faint">No clients yet</td></tr>` : null}</tbody></table></div></div>
    <div class="grid c2" style="margin-top:14px;align-items:start">
      <div class="panel"><div class="panel-head"><h4 class="grow">Invoices</h4><span class="faint" style="font-size:var(--fs-sm)">${money(s.outstandingTotal)} outstanding</span></div><div class="list">
        ${(invoices || []).slice(0, 12).map((i) => html`<div class="list-row"><span class="mono" style="width:76px">${i.number}</span><span class="grow ellipsis">${i.client} · ${i.period}</span>${i.status === 'draft' ? html`<button class="chip tnum" title="Change the amount" onClick=${() => editMoney(`Invoice ${i.number} amount`, i.amount, (v) => api.patch(`/api/invoices/${i.id}`, { amount: v }))}>${money(i.amount)} ✎</button>` : html`<span class="tnum" style="width:80px;text-align:right">${money(i.amount)}</span>`}<${StatusBadge} status=${i.status} />
          ${i.status === 'draft' ? html`<${Button} size="sm" kind="ghost" onClick=${() => act(() => api.patch(`/api/invoices/${i.id}`, { status: 'sent' }), { ok: 'Marked sent' }).then(() => { reloadInv(); reload(); })}>Mark sent</${Button}>` : i.status === 'sent' ? html`<${Button} size="sm" kind="moss" onClick=${() => act(() => api.patch(`/api/invoices/${i.id}`, { status: 'paid' }), { ok: 'Marked paid' }).then(() => { reloadInv(); reload(); })}>Paid</${Button}>` : null}</div>`)}
        ${!(invoices || []).length ? html`<div class="list-row faint">No invoices. "Draft invoices" creates one per active retainer for this month; nothing is sent automatically.</div>` : null}</div></div>
      <div class="panel"><div class="panel-head"><h4 class="grow">Expenses this month</h4></div><div class="list">
        ${s.expenseItems.map((e) => html`<div class="list-row" style="cursor:pointer" title="Click to edit" onClick=${(ev) => { if (!ev.target.closest('button')) setAddExp(e); }}><span class="grow">${e.label}${e.recurring ? html` <span class="badge outline">Monthly</span>` : null}</span><span class="faint">${e.category}</span><span class="tnum" style="width:80px;text-align:right">${money(e.amount, 2)}</span><${Button} size="sm" kind="ghost" icon="trash" title="Remove" onClick=${() => act(() => api.del(`/api/expenses/${e.id}`), { sound: 'tap' }).then(reload)} /></div>`)}
        ${!s.expenseItems.length ? html`<div class="list-row faint">Add software, storage, contractors and other costs to see true margins.</div>` : null}
        <div class="list-row"><span class="grow faint">Renewals in 30 days</span>${s.renewals.length ? s.renewals.map((r) => html`<span class="badge gold">${r.name} · ${r.date}</span>`) : html`<span class="faint">None</span>`}</div>
        <div class="list-row"><span class="grow faint">Prospect conversion</span><span class="tnum">${s.prospects.conversion != null ? `${s.prospects.conversion}% (${s.prospects.won} of ${s.prospects.contacted})` : '—'}</span></div>
        <div class="list-row"><span class="grow faint">Churn, last 90 days</span><span class="tnum">${s.churn90}%</span></div></div></div>
    </div>
    ${addExp ? html`<${ExpenseModal} exp=${addExp === true ? null : addExp} onClose=${() => { setAddExp(false); reload(); }} />` : null}
    ${split ? html`<${SplitModal} onClose=${() => { setSplit(false); reload(); }} />` : null}
    ${hours ? html`<${HoursModal} month=${month} onClose=${() => { setHours(false); reload(); }} />` : null}
  </div>`;
}

function ExpenseModal({ onClose, exp = null }) {
  const { data: clients } = useApi('/api/clients', []);
  const [f, setF] = useState(exp ? { label: exp.label, amount: String(exp.amount), category: exp.category || 'other', recurring: !!exp.recurring, clientId: exp.clientId || '' } : { label: '', amount: '', category: 'software', recurring: false, clientId: '' });
  const save = () => (exp ? api.patch(`/api/expenses/${exp.id}`, { ...f, amount: Number(f.amount), clientId: f.clientId || null }) : api.post('/api/expenses', { ...f, amount: Number(f.amount), clientId: f.clientId || null }));
  return html`<${Modal} title=${exp ? 'Edit expense' : 'Add expense'} icon="finance" onClose=${onClose} footer=${html`<${Button} kind="ghost" onClick=${onClose}>Cancel</${Button}><${Button} kind="primary" disabled=${!f.label || !f.amount} onClick=${() => act(save, { ok: exp ? 'Saved' : 'Expense added' }).then(onClose)}>${exp ? 'Save' : 'Add'}</${Button}>`}>
    <div class="form-grid">
      <${Field} label="What" id="ex-l"><input id="ex-l" class="input" value=${f.label} onInput=${(e) => setF({ ...f, label: e.target.value })} placeholder="Ayrshare Premium" autofocus /></${Field}>
      <${Field} label="Amount (USD)" id="ex-a"><input id="ex-a" class="input tnum" type="number" value=${f.amount} onInput=${(e) => setF({ ...f, amount: e.target.value })} /></${Field}>
      <${Field} label="Category" id="ex-c"><select id="ex-c" class="select" value=${f.category} onChange=${(e) => setF({ ...f, category: e.target.value })}>${['software', 'contractor', 'equipment', 'storage', 'travel', 'ads', 'other'].map((c) => html`<option>${c}</option>`)}</select></${Field}>
      <${Field} label="Charge to client" id="ex-cl"><select id="ex-cl" class="select" value=${f.clientId} onChange=${(e) => setF({ ...f, clientId: e.target.value })}><option value="">Agency overhead</option>${(clients || []).map((c) => html`<option value=${c.id}>${c.name}</option>`)}</select></${Field}>
    </div>
    <label class="check-row"><input type="checkbox" checked=${f.recurring} onChange=${(e) => setF({ ...f, recurring: e.target.checked })} />Repeats monthly</label>
  </${Modal}>`;
}

/** Who owns what, who gets what, and how much is set aside before distributions. */
function SplitModal({ onClose }) {
  const ag = store.get().boot?.settings?.agency || {};
  const [fs, setFs] = useState((ag.founders || []).map((f) => ({ ...f })));
  const [tax, setTax] = useState(ag.taxReservePct ?? 30); const [ret, setRet] = useState(ag.retainedEarningsPct ?? 10);
  const sum = (k) => fs.reduce((t, f) => t + (Number(f[k]) || 0), 0);
  const set = (i, k, v) => setFs(fs.map((f, j) => (j === i ? { ...f, [k]: k === 'name' ? v : Number(v) } : f)));
  const ok = sum('ownershipPct') === 100 && sum('distributionPct') === 100;
  const save = () => act(() => api.patch('/api/settings', { agency: { founders: fs, taxReservePct: Number(tax), retainedEarningsPct: Number(ret) } }), { ok: 'Saved' }).then((st) => { const b = store.get().boot; if (b && st) store.set({ boot: { ...b, settings: st } }); onClose(); });
  return html`<${Modal} title="Founders and set-asides" icon="finance" onClose=${onClose} footer=${html`<${Button} kind="ghost" onClick=${onClose}>Cancel</${Button}><${Button} kind="primary" disabled=${!ok} onClick=${save}>Save</${Button}>`}>
    <div class="col" style="gap:10px">
      ${fs.map((f, i) => html`<div class="form-grid" style="grid-template-columns:2fr 1fr 1fr 32px;align-items:end">
        <${Field} label="Founder" id=${`fn-${i}`}><input id=${`fn-${i}`} class="input" value=${f.name} onInput=${(e) => set(i, 'name', e.target.value)} /></${Field}>
        <${Field} label="Owns %" id=${`fo-${i}`}><input id=${`fo-${i}`} class="input tnum" type="number" min="0" max="100" value=${f.ownershipPct} onInput=${(e) => set(i, 'ownershipPct', e.target.value)} /></${Field}>
        <${Field} label="Gets % of payouts" id=${`fd-${i}`}><input id=${`fd-${i}`} class="input tnum" type="number" min="0" max="100" value=${f.distributionPct} onInput=${(e) => set(i, 'distributionPct', e.target.value)} /></${Field}>
        <${Button} size="sm" kind="ghost" icon="trash" title="Remove" onClick=${() => setFs(fs.filter((_, j) => j !== i))} /></div>`)}
      <div class="row"><${Button} size="sm" kind="ghost" icon="plus" onClick=${() => setFs([...fs, { id: `f${Date.now()}`, name: '', ownershipPct: 0, distributionPct: 0 }])}>Add founder</${Button}><span class="grow" /><span class=${ok ? 'faint' : ''} style=${ok ? '' : 'color:var(--coral-ink)'}>Ownership ${sum('ownershipPct')}% · payouts ${sum('distributionPct')}% ${ok ? '' : '(both must add up to 100%)'}</span></div>
      <div class="form-grid">
        <${Field} label="Tax reserve (% of profit set aside)" id="f-tax"><input id="f-tax" class="input tnum" type="number" min="0" max="80" value=${tax} onInput=${(e) => setTax(e.target.value)} /></${Field}>
        <${Field} label="Kept in the business (% of profit)" id="f-ret"><input id="f-ret" class="input tnum" type="number" min="0" max="80" value=${ret} onInput=${(e) => setRet(e.target.value)} /></${Field}>
      </div>
      <div class="faint" style="font-size:var(--fs-xs)">Payouts are what's left after the tax reserve and what the business keeps, split by each founder's payout %.</div>
    </div></${Modal}>`;
}

/** Log time spent per client (it shows as hours per client and cost per short). */
function HoursModal({ onClose, month }) {
  const { data: clients } = useApi('/api/clients', []);
  const { data: logs, reload } = useApi(`/api/timelogs?month=${month}`, []);
  const [f, setF] = useState({ clientId: '', hours: '', note: '', date: new Date().toISOString().slice(0, 10) });
  const add = () => act(() => api.post('/api/timelogs', { clientId: f.clientId || null, minutes: Math.round(Number(f.hours) * 60), note: f.note, date: f.date }), { ok: 'Logged' }).then(() => { setF({ ...f, hours: '', note: '' }); reload(); });
  const name = (id) => (clients || []).find((c) => c.id === id)?.name || 'Agency';
  return html`<${Modal} title="Log hours" icon="clock" onClose=${onClose} footer=${html`<${Button} kind="ghost" onClick=${onClose}>Done</${Button}><${Button} kind="primary" disabled=${!Number(f.hours)} onClick=${add}>Log it</${Button}>`}>
    <div class="form-grid">
      <${Field} label="Client" id="h-c"><select id="h-c" class="select" value=${f.clientId} onChange=${(e) => setF({ ...f, clientId: e.target.value })}><option value="">Agency (no client)</option>${(clients || []).map((c) => html`<option value=${c.id}>${c.name}</option>`)}</select></${Field}>
      <${Field} label="Hours" id="h-h"><input id="h-h" class="input tnum" type="number" step="0.25" min="0" value=${f.hours} onInput=${(e) => setF({ ...f, hours: e.target.value })} placeholder="1.5" /></${Field}>
      <${Field} label="Date" id="h-d"><input id="h-d" class="input" type="date" value=${f.date} onInput=${(e) => setF({ ...f, date: e.target.value })} /></${Field}>
      <${Field} label="What for (optional)" id="h-n"><input id="h-n" class="input" value=${f.note} onInput=${(e) => setF({ ...f, note: e.target.value })} placeholder="Edited 6 shorts" /></${Field}>
    </div>
    ${(logs || []).length ? html`<div class="list" style="margin-top:10px">${logs.slice(0, 12).map((t) => html`<div class="list-row"><span class="grow">${name(t.clientId)}${t.note ? ` · ${t.note}` : ''}</span><span class="faint">${t.date}</span><span class="tnum">${Math.round((t.minutes / 60) * 100) / 100} h</span><${Button} size="sm" kind="ghost" icon="trash" title="Remove" onClick=${() => act(() => api.del(`/api/timelogs/${t.id}`), { sound: 'tap' }).then(reload)} /></div>`)}</div>` : null}
  </${Modal}>`;
}
