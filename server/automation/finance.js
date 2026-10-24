'use strict';
/**
 * Business intelligence. Ownership and distributions are configured
 * separately: ownership % is equity; distribution % is how this period's
 * distributable profit is split. Tax reserve and retained earnings come off
 * the top before distributions.
 */
const ctx = require('../core/ctx');
const { monthKey } = require('../core/util');

const monthly = (r) => { const a = Number(r?.amount || 0); return { weekly: a * 52 / 12, monthly: a, quarterly: a / 3, annual: a / 12 }[r?.interval || 'monthly'] ?? a; };

function summary(month = monthKey()) {
  const s = ctx.store; const agency = ctx.setting('agency', {});
  const clients = s.all('clients');
  const active = clients.filter((c) => c.status === 'active');
  const mrr = active.reduce((t, c) => t + monthly(c.retainer), 0);
  const invoices = s.all('invoices');
  const paidThisMonth = invoices.filter((i) => i.status === 'paid' && (i.paidAt || '').startsWith(month)).reduce((t, i) => t + Number(i.amount || 0), 0);
  // Numbers typed in on the Finance page for a month win over the calculated ones (empty = calculated again).
  const ov = (ctx.setting('financeOverrides', {}) || {})[month] || {};
  const autoRevenue = invoices.some((i) => (i.period || i.issuedAt || '').startsWith(month)) ? paidThisMonth : mrr;
  const revenue = ov.revenue != null ? Number(ov.revenue) : autoRevenue;
  const usage = s.all('usage', (u) => u.month === month);
  const autoAi = usage.reduce((t, u) => t + (u.costUsd || 0), 0);
  const aiCost = ov.aiCost != null ? Number(ov.aiCost) : autoAi;
  const expenses = s.all('expenses', (e) => (e.date || '').startsWith(month) || (e.recurring && (e.date || '') <= `${month}-31`));
  const expenseTotal = expenses.reduce((t, e) => t + Number(e.amount || 0), 0);
  const profit = revenue - aiCost - expenseTotal;
  const tax = Math.max(0, profit) * (agency.taxReservePct || 0) / 100;
  const retained = Math.max(0, profit - tax) * (agency.retainedEarningsPct || 0) / 100;
  const distributable = Math.max(0, profit - tax - retained);
  const founders = (agency.founders || []).map((f) => ({ ...f, distribution: Math.round(distributable * (f.distributionPct || 0)) / 100 }));
  const minutes = s.all('timelogs', (t) => (t.date || t.createdAt || '').startsWith(month));
  const perClient = clients.filter((c) => c.status !== 'lead').map((c) => {
    const rev = monthly(c.retainer) * (c.status === 'active' ? 1 : 0);
    const ai = usage.filter((u) => u.clientId === c.id).reduce((t, u) => t + (u.costUsd || 0), 0);
    const exp = expenses.filter((e) => e.clientId === c.id).reduce((t, e) => t + Number(e.amount || 0), 0);
    const hours = minutes.filter((t) => t.clientId === c.id).reduce((t, m) => t + (m.minutes || 0), 0) / 60;
    const published = s.all('posts', (p) => p.clientId === c.id && p.status === 'published' && (p.publishedAt || '').startsWith(month)).length;
    const p = rev - ai - exp;
    return { id: c.id, name: c.name, type: c.type, status: c.status, revenue: rev, aiCost: round(ai), expenses: exp, profit: round(p), margin: rev ? Math.round((p / rev) * 100) : null, hours: Math.round(hours * 10) / 10, published, costPerShort: published ? round((ai + exp) / published) : null };
  });
  const today = new Date().toISOString().slice(0, 10);
  const outstanding = invoices.filter((i) => i.status === 'sent').map((i) => ({ ...i, overdue: (i.dueDate || '9999') < today, clientName: s.get('clients', i.clientId)?.name }));
  const in30 = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);
  const renewals = active.filter((c) => c.retainer?.renewalDate && c.retainer.renewalDate >= today && c.retainer.renewalDate <= in30).map((c) => ({ id: c.id, name: c.name, date: c.retainer.renewalDate, amount: monthly(c.retainer) }));
  const d90 = new Date(Date.now() - 90 * 864e5).toISOString();
  const churned90 = clients.filter((c) => c.status === 'churned' && (c.churnedAt || c.updatedAt) > d90).length;
  const prospects = s.all('prospects');
  const contacted = prospects.filter((p) => ['contacted', 'replied', 'meeting', 'proposal', 'won', 'lost'].includes(p.stage)).length;
  const won = prospects.filter((p) => p.stage === 'won').length;
  const byService = {};
  for (const c of active) { const k = c.package || (c.type === 'political' ? 'Political retainer' : 'Creator retainer'); byService[k] = (byService[k] || 0) + monthly(c.retainer); }
  const aiByProvider = {};
  for (const u of usage) aiByProvider[u.provider] = round((aiByProvider[u.provider] || 0) + (u.costUsd || 0));
  const totalHours = perClient.reduce((t, c) => t + c.hours, 0);
  return {
    month, mrr: round(mrr), arr: round(mrr * 12), revenue: round(revenue), revenueSource: ov.revenue != null ? 'the number you entered' : revenue === mrr ? 'retainers (no invoices this month)' : 'paid invoices',
    overrides: { revenue: ov.revenue != null, aiCost: ov.aiCost != null }, autoRevenue: round(autoRevenue), autoAiCost: round(autoAi),
    aiCost: round(aiCost), aiByProvider, expenses: round(expenseTotal), expenseItems: expenses, profit: round(profit), margin: revenue ? Math.round((profit / revenue) * 100) : null,
    taxReserve: round(tax), retained: round(retained), distributable: round(distributable), founders,
    perClient, byService, outstanding, outstandingTotal: round(outstanding.reduce((t, i) => t + Number(i.amount || 0), 0)), renewals,
    activeClients: active.length, churn90: active.length + churned90 ? Math.round((churned90 / (active.length + churned90)) * 100) : 0,
    prospects: { total: prospects.length, contacted, won, conversion: contacted ? Math.round((won / contacted) * 100) : null },
    hoursPerClient: active.length ? Math.round((totalHours / active.length) * 10) / 10 : 0, totalHours: Math.round(totalHours * 10) / 10,
  };
}
const round = (v) => Math.round(v * 100) / 100;

/** Draft this month's invoices for active retainers (nothing is sent automatically). */
function draftInvoices(actor = 'user') {
  const month = monthKey(); const out = [];
  let seq = ctx.store.settings._invoiceSeq || 1000;
  for (const c of ctx.store.all('clients', (x) => x.status === 'active' && Number(x.retainer?.amount) > 0)) {
    if (ctx.store.find('invoices', (i) => i.clientId === c.id && i.period === month)) continue;
    const day = String(Math.min(28, c.retainer.billingDay || 1)).padStart(2, '0');
    const due = new Date(`${month}-${day}T12:00:00Z`); due.setUTCDate(due.getUTCDate() + 14);
    out.push(ctx.store.insert('invoices', { clientId: c.id, number: `EM-${++seq}`, amount: Math.round(monthly(c.retainer) * 100) / 100, period: month, issuedAt: `${month}-${day}`, dueDate: due.toISOString().slice(0, 10), status: 'draft', createdBy: actor }));
  }
  ctx.store.settings._invoiceSeq = seq; ctx.store.touch();
  return out;
}

module.exports = { summary, draftInvoices, monthly };
