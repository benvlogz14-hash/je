'use strict';
/**
 * HAL's watch: while Euclidean is open he keeps reading the live internet for you, like the old HAL did all day.
 * Every `hal.watch.everyMin` minutes (default 60) he pulls the news on what you care about (your watch topics, your
 * clients, the politicians you're talking to) and looks for new leads (election winners and newly sworn-in officials in
 * NY and CT), through the free news feeds and web search, plus the founders' own Grok login when it's logged in (the
 * JEV link). Anything new lands as one message in his panel with real links. Leads are never added on their own: the
 * message carries a Confirm button that puts them in Politics → New prospects for you to wave through.
 */
const ctx = require('../core/ctx');
const events = require('../core/events');
const audit = require('../core/audit');
const web = require('./web');

const S = (k, d) => ctx.setting(`hal.watch.${k}`, d);
let busy = false;

const seen = () => new Set(ctx.store.settings._halSeen || []);
function remember(keys) { const all = [...(ctx.store.settings._halSeen || []), ...keys]; ctx.store.settings._halSeen = all.slice(-3000); ctx.store.touch(); }
const keyOf = (it) => String(it.url || it.t || '').replace(/[?#].*$/, '').toLowerCase() || String(it.t).toLowerCase();

const LEAD_QUERIES = [
  '(wins OR won OR "declares victory" OR elected OR "sworn in") ("State Senate" OR Assembly OR assemblywoman OR assemblyman) ("New York" OR "Long Island" OR Nassau OR Suffolk)',
  '(wins OR won OR elected OR "sworn in") ("county legislature" OR legislator OR "town council" OR "city council" OR supervisor) (Nassau OR Suffolk OR Westchester OR "Long Island")',
  '(wins OR won OR elected OR "sworn in") ("state representative" OR "state senator" OR "House seat" OR council) Connecticut',
];

/** Topics to follow: the watch list, active clients, and politicians already in conversation with us. */
function topics() {
  const list = String(S('topics', 'New York politics\nConnecticut politics\nLong Island politics') || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  const clients = ctx.store.all('clients', (c) => c.status === 'active').map((c) => c.name);
  const people = ctx.store.all('prospects', (p) => p.type === 'political' && ['contacted', 'replied', 'meeting', 'proposal', 'won'].includes(p.stage)).map((p) => p.name);
  // Rotate through people so a long list is covered over the day, a few per run.
  const i = Number(ctx.store.settings._halWatchI || 0); ctx.store.settings._halWatchI = i + 4;
  const rot = people.length ? Array.from({ length: Math.min(4, people.length) }, (_, k) => people[(i + k) % people.length]) : [];
  return { list, clients, people: rot };
}

/** Names of winners in headlines (the AI reads only the headline; a name must appear in it word for word). */
async function leadsFrom(items) {
  if (!items.length || !require('../integrations/ai').anyConnected()) return [];
  try {
    const r = await require('./brain').think({ json: true, maxTokens: 700, system: 'You read REAL news headlines and list people who just won or were sworn into an elected office in New York or Connecticut (state legislature, county legislature, town or city council, supervisor, mayor, Congress). Use only the headline text. Skip judges, governors and anyone who lost. Return JSON {"leads":[{"i":<headline number>,"name":"exact name as written","office":"office as written, or empty"}]}.', messages: [{ role: 'user', content: items.slice(0, 20).map((it, i) => `${i}. ${it.t}${it.b ? ` :: ${it.b}` : ''}`).join('\n') }] });
    const out = [];
    for (const l of r.json?.leads || []) {
      const it = items[Number(l.i)]; const name = String(l.name || '').trim();
      if (!it || name.split(/\s+/).length < 2 || !`${it.t} ${it.b}`.includes(name)) continue; // never a name the headline doesn't carry
      if (/governor|judge|justice/i.test(String(l.office || ''))) continue;
      out.push({ name, office: String(l.office || '').slice(0, 80), headline: it.t, url: it.url });
    }
    return out;
  } catch { return []; }
}

/** One pass. Returns { stories, leads } that were new. `force` runs it now (from HAL's panel). */
async function run({ force = false } = {}) {
  if (busy) return { stories: [], leads: [], busy: true };
  if (!force && (!S('on', true) || Date.now() - Number(ctx.store.settings._halWatchAt || 0) < Math.max(15, Number(S('everyMin', 60))) * 60000)) return null;
  busy = true; ctx.store.settings._halWatchAt = Date.now(); ctx.store.touch();
  try {
    const have = seen(); const added = [];
    const fresh = (arr) => arr.filter((it) => { if (!it?.url || have.has(keyOf(it))) return false; have.add(keyOf(it)); added.push(keyOf(it)); return true; });
    const t = topics();
    const stories = [];
    for (const q of t.list) stories.push(...(await web.newsFor(`when:1d ${q}`, 4)).map((x) => ({ ...x, about: q })));
    for (const c of t.clients) stories.push(...(await web.newsFor(`when:2d "${c}"`, 2)).map((x) => ({ ...x, about: c })));
    for (const n of t.people) stories.push(...(await web.newsAbout(n, 2)).map((x) => ({ ...x, about: n })));
    const leadHeads = [];
    for (const q of LEAD_QUERIES) leadHeads.push(...await web.newsFor(`when:2d ${q}`, 8));
    // The JEV link: the founders' Grok login browses the web live (a few times an hour at most).
    let via = '';
    if (S('useGrok', true)) {
      try { const g = await web.live('List today\'s most important New York and Connecticut political news, and anyone newly elected or sworn in to a state, county or town office there.'); if (g) { via = g.via; stories.push(...g.items.map((x) => ({ ...x, about: 'live web' }))); leadHeads.push(...g.items); } } catch { /* not available */ }
    }
    const newStories = fresh(stories).slice(0, Number(S('maxStories', 8)));
    const known = new Set(ctx.store.all('prospects').map((p) => String(p.name || '').toLowerCase()));
    const newLeads = [];
    for (const l of await leadsFrom(fresh(leadHeads))) { const k = l.name.toLowerCase(); if (!known.has(k) && !newLeads.some((x) => x.name.toLowerCase() === k) && !require('../outreach/guide').isRyans(l)) newLeads.push(l); }
    remember(added);
    if (newStories.length || newLeads.length) post(newStories, newLeads, via);
    ctx.store.settings._halWatchLast = { at: new Date().toISOString(), stories: newStories.length, leads: newLeads.length, via }; ctx.store.touch();
    return { stories: newStories, leads: newLeads };
  } finally { busy = false; }
}

/** One message in HAL's panel, links on their own lines; leads come with a Confirm button. */
function post(stories, leads, via) {
  const lines = [];
  if (stories.length) lines.push(`While you were working, ${stories.length} new stor${stories.length === 1 ? 'y' : 'ies'}${via ? ` (live web through ${via})` : ''}:`, ...stories.map((s) => `- ${s.t}${s.about && s.about !== 'live web' ? ` [${s.about}]` : ''}\n${s.url}`));
  if (leads.length) lines.push('', `${leads.length} possible lead${leads.length === 1 ? '' : 's'}, straight from the headlines (not added yet):`, ...leads.map((l) => `- ${l.name}${l.office ? `, ${l.office}` : ''}: ${l.headline}\n${l.url}`));
  const id = `ok_w${Date.now().toString(36)}`;
  const m = ctx.store.insert('halMessages', { who: 'hal', text: lines.join('\n'), by: 'watch', watch: true, confirm: leads.length ? { id, label: `Add ${leads.length} to New prospects`, action: { type: 'addLeads', leads } } : null });
  const all = ctx.store.all('halMessages'); for (const x of all.slice(0, Math.max(0, all.length - 300))) ctx.store.remove('halMessages', x.id);
  events.publish('hal', { id: m.id });
  events.publish('notify', { title: `HAL: ${[stories.length && `${stories.length} new stor${stories.length === 1 ? 'y' : 'ies'}`, leads.length && `${leads.length} possible lead${leads.length === 1 ? '' : 's'}`].filter(Boolean).join(', ')}`, body: (leads[0] ? `${leads[0].name}: ${leads[0].headline}` : stories[0]?.t || '').slice(0, 140), route: '' });
}

/** Confirmed by a person: the leads go to Politics → New prospects (waiting for approval, like scout finds). */
function addLeads(leads, actor) {
  let added = 0;
  for (const l of leads || []) {
    if (ctx.store.find('prospects', (p) => String(p.name || '').toLowerCase() === String(l.name).toLowerCase())) continue;
    ctx.store.insert('prospects', { name: l.name, type: 'political', office: l.office || '', location: l.office || '', why: `${l.headline} (${l.url})`, newsUrl: l.url, stage: 'new', triage: 'pending', source: 'hal-watch', verified: false, platforms: [], handle: '', publicContact: '' });
    added++;
  }
  audit.log(actor, 'hal.leads_added', { added });
  events.publish('prospects', {});
  return { text: added ? `${added} added to Politics → New prospects. Say "email" and a name when you want the outreach drafted.` : 'They were already on the board.', navigate: '/politics' };
}

function tick() { if (!ctx.store) return; run().catch((e) => audit.log('system', 'hal.watch_error', { error: e.message }, 'warn')); }
const status = () => ({ on: !!S('on', true), everyMin: Number(S('everyMin', 60)), topics: S('topics', ''), useGrok: !!S('useGrok', true), grok: web.grokReady(), last: ctx.store.settings._halWatchLast || null });

module.exports = { run, tick, addLeads, status };
