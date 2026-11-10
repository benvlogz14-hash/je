'use strict';
/**
 * Hands-off ads (Ryan, Nov 10: "pull the videos from the internet ... have them go straight into the political ad
 * machine and generate all without us being involved"). For each lead: the whole package runs as usual (research,
 * brief, footage, the ads, the sheet, the email draft); its footage step finds their public videos on Google's Videos
 * tab first when nothing was uploaded (videofind.js, one cached Serper search), downloads the best ones and cuts the ads
 * from their own words. A lead with a package already starts again from the footage step.
 * Never: HOLD leads, people marked lost, Ryan's people. Nothing is sent: the email waits in Approvals as a draft.
 * Used by the Data tab (Make ads for ticked), the bots (make_ads), Claude, and `POST /api/political/autoads`.
 */
const ctx = require('../core/ctx');
const audit = require('../core/audit');

function resolve({ ids = [], names = [] }) {
  const all = ctx.store.all('prospects', (p) => p.type === 'political' || !p.type);
  const out = []; const missing = [];
  for (const id of ids) { const p = ctx.store.get('prospects', id); if (p) out.push(p); else missing.push(id); }
  for (const n of names) {
    const k = String(n).toLowerCase().trim(); if (!k) continue;
    const p = all.find((x) => String(x.name).toLowerCase() === k) || all.find((x) => String(x.name).toLowerCase().includes(k));
    if (p) out.push(p); else missing.push(n);
  }
  return { list: [...new Map(out.map((p) => [p.id, p])).values()], missing };
}

function start({ ids = [], names = [], actor = 'user' } = {}) {
  const queue = require('../jobs/queue');
  const { list, missing } = resolve({ ids, names });
  if (!list.length) throw new Error(missing.length ? `Not on the leads board: ${missing.join(', ')}. Add them first.` : 'Pick the leads to make ads for.');
  const started = []; const skipped = missing.map((m) => `${m} (not on the board)`);
  for (const p of list.slice(0, 25)) {
    if (p.hold) { skipped.push(`${p.name} (HOLD)`); continue; }
    if (p.electionResult === 'lost') { skipped.push(`${p.name} (lost)`); continue; }
    if (p.grok?.ryans || p.ryans) { skipped.push(`${p.name} (Ryan's person)`); continue; }
    const from = p.pkg?.steps?.research?.status === 'done' || p.pkg?.profile ? 'footage' : 'research';
    const job = queue.enqueue('political.package', { prospectId: p.id, name: p.name, from, only: null }, { actor, priority: 4, dedupeKey: `polpkg:${p.id}`, title: `Ads for ${p.name} (finding their videos)` });
    started.push({ id: p.id, name: p.name, jobId: job.id, from });
  }
  if (list.length > 25) skipped.push(`${list.length - 25} more (25 at a time)`);
  audit.log(actor, 'political.autoads', { started: started.length, skipped: skipped.length });
  return { started, skipped, google: require('../integrations/serper').status() };
}

module.exports = { start, resolve };
