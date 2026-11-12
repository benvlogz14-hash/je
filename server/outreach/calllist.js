/**
 * Call lists: "pick two for Ben and two for Ryan, all freshly re-elected, not anyone we've pitched" → a checked,
 * sourced call sheet (PDF + Word + a Data tab copy), the way the founders' GrokBot made them, but inside Euclidean.
 *
 *  1. The pool: every political lead not lost, plus every person in the Data tab's winners lists and research packs.
 *  2. Already contacted are left out: leads past New (contacted, replied, meeting, client, passed), anyone with prior
 *     contact or an email sent, anyone named in a Data tab call log / called list / contact book / emailed list, anyone
 *     on an earlier call list (unless asked), HOLDs, Ryan's people, the exclusions list, judges, and who lost.
 *  3. Picks: each group ("two for Ben: ...") is picked by the AI from the pool lines (or by matching words without AI),
 *     with a spare or two, since some drop out at the checking step.
 *  4. Checking, one person at a time (saved after each, so a stopped run carries on): their official page (the NY
 *     Assembly and Senate member rosters, else a search limited to official sites) → district and Albany phones,
 *     office email, and one accomplishment hook taken word for word from their own bio, with its link. When a group
 *     asks for something the bio can confirm, it's checked there; a clear "no" drops them for the next pick.
 *  5. Drafts per person: call script, voicemail (about 25 seconds, number twice), email draft (to the campaign address;
 *     government addresses are for scheduling only). Nothing is sent.
 */
const ctx = require('../core/ctx');
const audit = require('../core/audit');
const events = require('../core/events');
const ai = require('../integrations/ai');
const { now } = require('../core/util');
const { isGov, excluded, noDashes } = require('./common');

const COL = 'callLists';
const CONTACTED = new Set(['contacted', 'replied', 'meeting', 'won', 'lost', 'client', 'passed']);
const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\([^)]*\)/g, ' ').replace(/[^a-z\s'-]/g, ' ').replace(/\s+/g, ' ').trim();
const lastName = (n) => norm(n).split(' ').filter((w) => !/^(jr|sr|ii|iii|iv)$/.test(w)).pop() || '';
const firstName = (n) => norm(n).split(' ')[0] || '';

function callers() {
  const set = ctx.setting('outreach.callers', null);
  const base = { ben: { name: 'Ben Gingold', phone: '917-699-4151', email: 'zspannetwork@gmail.com' }, ryan: { name: 'Ryan Rosario', phone: '', email: '' } };
  return set && typeof set === 'object' ? { ...base, ...set } : base;
}
function callerFor(who) { const c = callers(); const k = String(who || 'ben').toLowerCase().split(/\s+/)[0]; return c[k] || { name: who || 'Ben Gingold', phone: c.ben.phone, email: c.ben.email }; }

// ------------------------------------------------------------------ the pool

/** Everyone we could call: political leads + people in the Data tab, merged by name. */
function pool({ state = '' } = {}) {
  const map = new Map();
  const put = (k, x) => { const cur = map.get(k); map.set(k, cur ? { ...x, ...Object.fromEntries(Object.entries(cur).filter(([, v]) => v)), sources: [...new Set([...(cur.sources || []), ...(x.sources || [])])] } : x); };
  for (const p of ctx.store.all('prospects')) {
    if (p.type && p.type !== 'political') continue;
    put(norm(p.name), { name: p.name, office: p.office || p.grok?.office || '', state: p.state || '', email: p.email || '', phone: p.phone || p.grok?.phone || '', hook: p.kit?.card?.hook || p.grok?.hook || '', hookSource: p.grok?.sources?.[0] || '', status: p.electionResult === 'lost' ? 'lost' : p.electionResult === 'won' || /won/i.test(p.grok?.status || '') ? 'won' : '', prospectId: p.id, stage: p.stage || 'new', hold: !!p.hold, priorContact: !!p.priorContact, party: p.party || '', info: [p.race, p.grok?.status, p.grok?.hook, p.notes].filter(Boolean).join('. ').slice(0, 300), sources: ['leads board'] });
  }
  const data = require('../data');
  for (const d of ctx.store.all('datasets')) {
    if (!d.counts?.people || /\(document\)$/.test(d.name)) continue;
    const f = data.full(d.id); if (!f) continue;
    const winners = /winner|\bwon\b|re-?elected|results/i.test(d.name);
    for (const x of f.people || []) {
      if (!x.name || x.name.split(' ').length < 2) continue;
      if (!OFFICE.test(`${x.office} ${x.result}`)) continue; // creators and channels are not for political call lists
      const ph = String(x.phones || ''); const em = (x.emails || [x.email]).filter(Boolean);
      put(norm(x.name), { name: x.name, office: x.office || '', state: '', email: em.find((e) => !isGov(e)) || '', officialEmail: em.find((e) => isGov(e)) || '', phone: ph, hook: x.hook || '', why: x.why || '', hookSource: x.hookSource || '', status: /won/i.test(`${x.status} ${x.result}`) ? 'won' : /lost/i.test(`${x.status} ${x.result}`) ? 'lost' : winners ? 'won' : '', tier: x.tier || '', info: [x.result, x.why, x.hook].filter(Boolean).join('. ').slice(0, 300), sources: [d.name] });
    }
  }
  let out = [...map.values()];
  if (state) { const st = String(state).toUpperCase(); out = out.filter((p) => !p.state || p.state.toUpperCase() === st || new RegExp(`\\b${st}\\b|${st === 'NY' ? 'Assembly|AD-|SD-|New York' : st === 'CT' ? 'Connecticut' : st}`, 'i').test(`${p.office} ${p.info}`)); }
  return out;
}
const OFFICE = /\b(AD|SD|LD|HD|CD|NY|CT|NJ|MA|RI)-?\d|District|Assembly|Senat|House|Council|County|Legislat|Mayor|Supervisor|Town|City|Congress|Comptroller|Attorney|Board|Clerk|Treasurer|Selectman|Alder|Trustee|seat/i;
const LOG = /call(ed)?[\s_-]*log|called[\s_-]*list|contact[\s_-]*book|\bcalled\b|emailed|pitched|outreach[\s_-]*log|sent[\s_-]*list|already contacted/i;
const isContactLog = (d) => /call(ed)?[\s_-]*log|called[\s_-]*list|contact[\s_-]*book|called|emailed|pitched|outreach[\s_-]*log|sent[\s_-]*list/i.test(`${d.name} ${(d.sectionTitles || []).slice(0, 3).join(' ')}`);

/** Names we've already reached out to, with why. */
function contactedNames({ includePrevious = false } = {}) {
  const out = new Map();
  const add = (name, why) => { const k = norm(name); if (k && !out.has(k)) out.set(k, why); };
  for (const p of ctx.store.all('prospects')) {
    if (CONTACTED.has(p.stage)) add(p.name, `stage: ${p.stage}`);
    else if (p.priorContact) add(p.name, 'prior contact');
  }
  const sentTo = new Set(ctx.store.all('messages').filter((m) => m.direction !== 'in' && ['sent', 'delivered'].includes(m.status)).map((m) => m.conversationId));
  const convs = ctx.store.all('conversations').filter((c) => sentTo.has(c.id));
  for (const c of convs) { const k = ctx.store.get('contacts', c.contactId); if (k?.name) add(k.name, 'emailed'); }
  const data = require('../data');
  const logs = ctx.store.all('datasets').filter(isContactLog);
  const everyone = pool().map((p) => p.name);
  // Only the parts that are logs: a "CALLED LIST" section of a bigger pack counts, its winners list doesn't.
  for (const d of ctx.store.all('datasets')) {
    if (/\(document\)$/.test(d.name) && !/^call list|contact book/i.test(d.name)) continue;
    const f = data.full(d.id); if (!f) continue;
    const secs = (f.sections || []).filter((x) => LOG.test(x.title || ''));
    let text = '';
    if (secs.length) text = secs.map((x) => `${x.title}\n${x.text}`).join('\n');
    else if (logs.includes(d)) { text = f.text || ''; for (const x of f.people || []) add(x.name, `in ${d.name}`); }
    if (!text) continue;
    const t = norm(text);
    for (const n of everyone) { const nn = norm(n); if (nn.length > 5 && t.includes(nn)) add(n, `in ${d.name}${secs.length ? ` (${secs[0].title})` : ''}`); }
  }
  if (!includePrevious) for (const l of ctx.store.all(COL)) if (l.status === 'done') for (const it of l.items || []) if (it.picked) add(it.name, `on call list ${l.title}`);
  return out;
}

function reasonOut(p, contacted) {
  const g = require('./guide');
  if (contacted.has(norm(p.name))) return contacted.get(norm(p.name));
  if (p.status === 'lost') return 'lost';
  if (p.hold) return 'HOLD';
  if (g.isRyans(p)) return "Ryan's people";
  const ex = excluded({ name: p.name, email: p.email }); if (ex) return `exclusions list (${ex})`;
  if (/judge|justice|surrogate|governor\b|congress|u\.?s\.? (house|senate)|mayor of new york/i.test(p.office)) return 'office we skip';
  if (/republican|\(r\)|\br-\w\w\b/i.test(`${p.party} ${p.office}`)) return 'Republican';
  return '';
}

// ------------------------------------------------------------------ official pages

const ROSTER = new Map(); // url → { at, links }
const NYA = process.env.EUCLIDEAN_NYASSEMBLY_URL || 'https://nyassembly.gov';
const NYS = process.env.EUCLIDEAN_NYSENATE_URL || 'https://www.nysenate.gov';
async function roster(url, re) {
  const hit = ROSTER.get(url); if (hit && Date.now() - hit.at < 24 * 3600e3) return hit.links;
  const pg = await require('../integrations/websearch').read(url);
  const links = (pg.links || []).filter((l) => re.test(l.url)).map((l) => ({ text: l.text, url: l.url }));
  ROSTER.set(url, { at: Date.now(), links }); return links;
}
const matchLink = (links, name) => { const ln = lastName(name); const fn = firstName(name); return links.find((l) => { const t = norm(`${l.text} ${decodeURIComponent(l.url).replace(/[-_/]+/g, ' ')}`); return t.includes(ln) && t.includes(fn); }) || null; };
const OFFICIAL = /\.gov(\/|$)|nyassembly\.gov|nysenate\.gov|cga\.ct\.gov|housedems\.ct\.gov|senatedems\.ct\.gov|council\.nyc\.gov|legislature|\.state\.[a-z]{2}\.us|ballotpedia\.org/i;

/** The official pages for one person: [{ url, kind: 'bio'|'contact'|'page' }]. */
async function officialPages(p) {
  const ws = require('../integrations/websearch');
  const o = `${p.office} ${p.info}`;
  const pages = [];
  try {
    if (/\bAD-?\d+|Assembly/i.test(o) && !/County|Town/i.test(o)) {
      const m = matchLink(await roster(`${NYA}/mem/`, /\/mem\/[A-Z][^/?#]+\/?$/), p.name);
      if (m) { const base = m.url.replace(/\/$/, ''); pages.push({ url: `${base}/bio/`, kind: 'bio' }, { url: `${base}/contact/`, kind: 'contact' }); }
    } else if (/\bSD-?\d+|State Senate|Senate District|Senator/i.test(o) && /NY|New York|SD-/i.test(o)) {
      const m = matchLink(await roster(`${NYS}/senators-committees`, /\/senators\/[a-z-]+\/?$/), p.name);
      if (m) { const base = m.url.replace(/\/$/, ''); pages.push({ url: `${base}/about`, kind: 'bio' }, { url: `${base}/contact`, kind: 'contact' }); }
    }
  } catch { /* fall back to a search */ }
  if (!pages.length) {
    try {
      const hits = await ws.search(`"${p.name}" ${p.office} official contact`, 8);
      for (const h of hits.filter((x) => OFFICIAL.test(x.url)).slice(0, 2)) pages.push({ url: h.url, kind: /contact/i.test(h.url) ? 'contact' : 'page' });
    } catch { /* nothing found */ }
  }
  return pages;
}

const PHONE = /(?:\+?1[\s.-]?)?\(?\b(\d{3})\)?[\s.-]?(\d{3})[\s.-](\d{4})\b/g;
/** Phones with what they're for (District / Albany / DC / Campaign), emails, from an official page's text. */
function contactsFrom(text) {
  const t = String(text || ''); const phones = []; const seen = new Set();
  for (const m of t.matchAll(PHONE)) {
    const num = `${m[1]}-${m[2]}-${m[3]}`; if (seen.has(num)) continue;
    const before = t.slice(Math.max(0, m.index - 160), m.index).toLowerCase();
    if (/fax/.test(before.slice(-20))) continue;
    seen.add(num);
    const label = /albany|capitol|legislative office building|\blob\b|state street/.test(before) ? 'Albany' : /washington|d\.c\.|\bdc\b|rayburn|longworth|cannon/.test(before) ? 'DC' : /district|community office|local office/.test(before) ? 'District' : /campaign/.test(before) ? 'Campaign' : 'Office';
    phones.push({ num, label });
  }
  const emails = [...new Set((t.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || []).map((e) => e.replace(/\.$/, '')))].filter((e) => !/example|sentry|wixpress|noreply|no-reply/i.test(e));
  return { phones: phones.slice(0, 6), emails: emails.slice(0, 4) };
}
/** Accomplishment sentences in a bio, best first (numbers, firsts, laws passed, money secured, roles led). */
function hookCandidates(text) {
  const sents = String(text || '').split('\n').filter((l) => !/^\s*(#|[-*]\s|\|)/.test(l) && l.trim().split(' ').length > 5).join(' ').replace(/\s+/g, ' ').split(/(?<=[.!?])\s+(?=[A-Z])/).map((s) => s.trim()).filter((s) => s.length > 50 && s.length < 380 && !/cookie|javascript|subscribe|newsletter|copyright|privacy/i.test(s));
  const score = (s) => (/\$\s?\d|\d[\d,]*\s*(million|billion|thousand|families|people|students|homes|jobs)|\b\d{2,}\b/i.test(s) ? 3 : 0) + (/\bfirst\b/i.test(s) ? 3 : 0) + (/(passed|secured|delivered|won|authored|sponsored|led|founded|created|expanded|signed into law|became law|fought|championed|chairs?|chaired)/i.test(s) ? 2 : 0) + (/born|grew up|graduat|degree|married|lives with|children/i.test(s) ? -3 : 0);
  return sents.map((s) => ({ s, score: score(s) })).filter((x) => x.score > 0).sort((a, b) => b.score - a.score).map((x) => x.s).slice(0, 8);
}
const overlap = (a, b) => { const A = new Set(norm(a).split(' ').filter((w) => w.length > 3)); const B = norm(b); if (!A.size) return 0; return [...A].filter((w) => B.includes(w)).length / A.size; };

async function verify(p, want = '') {
  const ws = require('../integrations/websearch');
  const out = { checked: [], phones: [], emails: [], hook: '', hookSource: '', fit: '', fitWhy: '' };
  const pages = await officialPages(p);
  let bio = '';
  for (const pg of pages.slice(0, 3)) {
    try {
      const r = await ws.read(pg.url, { maxChars: 30000 });
      out.checked.push(r.url || pg.url);
      const c = contactsFrom(r.text);
      for (const ph of c.phones) if (!out.phones.some((x) => x.num === ph.num)) out.phones.push({ ...ph, source: r.url || pg.url });
      for (const e of c.emails) if (!out.emails.some((x) => x.email === e)) out.emails.push({ email: e, source: r.url || pg.url });
      if (pg.kind !== 'contact') bio += `\n${r.text.slice(0, 12000)}`;
      if (pg.kind === 'bio' || !out.bioUrl) out.bioUrl = out.bioUrl || r.url || pg.url;
    } catch (e) { out.checked.push(`${pg.url} (could not read: ${e.message.slice(0, 80)})`); }
  }
  // The hook: one accomplishment, word for word from their own page.
  const cands = hookCandidates(bio);
  if (cands.length) {
    let pick = cands[0];
    try {
      if (ai.firstFor('writing')) {
        const r = await ai.ask({ role: 'writing', json: true, maxTokens: 500, system: 'You pick facts for cold-call openers. Pick ONLY from the numbered sentences; never change their facts.', prompt: `PERSON: ${p.name}, ${p.office}\n${want ? `WHAT WE WANT IN THIS PERSON: ${want}\n` : ''}SENTENCES FROM THEIR OFFICIAL BIO:\n${cands.map((s, i) => `${i + 1}. ${s}`).join('\n')}\n${want ? `\nBIO TEXT (for the check):\n${bio.slice(0, 5000)}\n` : ''}\nReturn JSON: {"pick": number of the most impressive, concrete accomplishment (a law passed, money secured, a first, people helped),${want ? ' "fits": "yes" | "no" | "unclear" (does the bio show what we want? only from the text), "why": "one short reason quoting the bio",' : ''} "hook": "that sentence trimmed to under 30 words, same facts"}` });
        const j = r.json || {}; const k = Number(j.pick) - 1;
        if (cands[k]) pick = cands[k];
        if (j.hook && overlap(j.hook, pick) > 0.7) out.hookShort = noDashes(String(j.hook));
        if (want) { out.fit = ['yes', 'no', 'unclear'].includes(j.fits) ? j.fits : 'unclear'; out.fitWhy = String(j.why || '').slice(0, 240); }
      }
    } catch { /* the best-scored sentence */ }
    out.hook = noDashes(pick); out.hookSource = out.bioUrl || out.checked[0] || '';
  }
  return out;
}

// ------------------------------------------------------------------ drafts

/** "She chairs the caucus and secured $2 million" → "You chair the caucus and secured $2 million" (for an email to them). */
function secondPerson(sentence, name = '') {
  let s = String(sentence || '').trim(); if (!s) return s;
  const words = String(name).replace(/\([^)]*\)/g, ' ').split(/\s+/).filter(Boolean);
  const full = words.join(' '); const last = words[words.length - 1] || '';
  const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const lead = new RegExp(`^(?:(?:Assemblymember|Assemblywoman|Assemblyman|Senator|Council Member|Legislator|Rep\\.|Dr\\.)\\s+)?(?:${[full, words.length > 2 ? `${words[0]} ${last}` : null, last].filter(Boolean).map(esc).join('|')}|She|He|They)\\b`);
  const pron = (x) => x.replace(/\b(she|he)\b/g, 'you').replace(/\b(her|his)\b/g, 'your').replace(/\bherself\b|\bhimself\b/g, 'yourself');
  if (!lead.test(s)) return /\b(she|he)\b/.test(s) ? pron(s) : s;
  s = s.replace(lead, 'You');
  const base = (w) => (/ies$/.test(w) ? `${w.slice(0, -3)}y` : /(ss|sh|ch|x|zz|o)es$/.test(w) ? w.slice(0, -2) : /s$/.test(w) && !/(ss|us|is)$/.test(w) ? w.slice(0, -1) : w);
  s = s.replace(/^You (is|was|has|does)\b/, (m, v) => `You ${{ is: 'are', was: 'were', has: 'have', does: 'do' }[v]}`)
    .replace(/^You ([a-z]{3,})\b/, (m, w) => `You ${base(w)}`)
    .replace(/\b(she|he)\b/g, 'you').replace(/\b(her|his)\b/g, 'your').replace(/\bherself\b|\bhimself\b/g, 'yourself');
  return s;
}

function titleFor(p) {
  const o = `${p.office} ${p.info}`;
  if (/\bSD-?\d|Senat/i.test(o)) return 'Senator';
  if (/\bAD-?\d|Assembly/i.test(o)) return 'Assemblymember';
  if (/Council/i.test(o)) return 'Council Member';
  if (/Legislat/i.test(o)) return 'Legislator';
  if (/Supervisor/i.test(o)) return 'Supervisor';
  if (/Mayor/i.test(o)) return 'Mayor';
  if (/US House|Congress|NY-\d/i.test(o)) return 'Rep.';
  return '';
}
function drafts(p, caller) {
  const g = require('./guide');
  const title = titleFor(p); const last = p.name.replace(/\s*\([^)]*\)/g, '').trim().split(' ').filter((w) => !/^(Jr\.?|Sr\.?|II|III|IV)$/.test(w)).pop();
  const greet = title ? `${title} ${last}` : p.name.split(' ')[0];
  // Only a checked accomplishment (or a list hook that reads like one) opens the call; notes like "$469K raised" never do.
  const listHook = /\b(passed|secured|delivered|won|authored|sponsored|led|founded|created|expanded|fought|first|flipped|unseated|helped|organized|chairs?)\b/i.test(p.hook || '') && String(p.hook).split(' ').length >= 6 ? p.hook : '';
  const fact = p.hookShort || (p.hookChecked ? p.hook : listHook) || '';
  const factLine = fact ? `${fact.replace(/\.$/, '')}.` : '';
  const youLine = fact ? `${secondPerson(fact, p.name).replace(/\.$/, '')}.` : '';
  const aboutLine = fact ? factLine.replace(/^(She|He|They)\b/, (m) => m.toLowerCase()) : '';
  const phone = caller.phone || g.PHONE;
  const twice = `${phone}, that's ${phone}`;
  const won = p.status === 'won';
  const script = noDashes([
    `Hi, this is ${caller.name} with Euclidean Media. Is this ${greet}'s office? Who handles their social media or communications?`,
    `${won ? 'Congratulations on the win. ' : ''}${aboutLine ? `I was reading about ${greet}: ${aboutLine} ` : ''}That's the kind of thing people in the district should see on their phones, and most never do.`,
    `${g.CRED.replace("I've", "We've")} We'd like to make ${greet} a short video about it, free, whether or not you work with us.`,
    'Could we get 20 minutes this week to show you? And what is the best email for your communications director?',
  ].join('\n\n'));
  const voicemail = noDashes(`Hi ${greet}, it's ${caller.name} with Euclidean Media. ${won ? 'Congrats on the win. ' : ''}${youLine ? `${youLine} ` : ''}${g.CRED_VM} We'd like to make you a short video on it, free. ${twice}. I'm sending an email too.`);
  const to = p.email && !isGov(p.email) ? p.email : '';
  const email = {
    to, subject: noDashes(`${won ? 'Congrats' : 'A free video for you'}${title ? `, ${title} ${last}` : ''}${won ? ', we made you a video' : ''}`),
    body: noDashes([`Hi ${greet},`, won ? 'Congratulations on the win.' : 'Quick note.', youLine ? `${youLine} That's the kind of story people in your district should see on their phones, and most never do.` : "Most of what an office does never reaches people's phones.", g.CRED, "We'd make you a short video, free, delivered within 48 hours, yours to use whether or not we talk. Could you give us 20 minutes this week?", `${caller.name}, Euclidean Media${caller.phone ? `, ${caller.phone}` : ''}${caller.email ? `, ${caller.email}` : ''}`].join('\n\n')),
    note: to ? '' : 'No campaign email found. Ask for the communications director\'s email on the call (government addresses are for scheduling, not pitches).',
  };
  return { script, voicemail, email };
}

// ------------------------------------------------------------------ the job

function list() { return ctx.store.all(COL).map(({ items, ...l }) => ({ ...l, count: (items || []).filter((x) => x.picked).length })).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))); }
function get(id) { return ctx.store.get(COL, id) || null; }
function update(id, patch) { const l = ctx.store.update(COL, id, { ...patch, updatedAt: now() }); events.publish('calllists', { id }); return l; }
function remove(id, by = 'user') { const l = get(id); if (l) { ctx.store.remove(COL, id); audit.log(by, 'calllist.deleted', { title: l.title }); events.publish('calllists', { id }); } return { ok: true }; }

/** Turn the founders' words into groups: [{ who, count, want }]. */
async function groupsFrom(request, count) {
  const t = String(request || '');
  try {
    if (ai.firstFor('writing')) {
      const r = await ai.ask({ role: 'writing', json: true, maxTokens: 400, system: 'You turn a request for a call list into groups. Only use what the request says.', prompt: `REQUEST: ${t}\n\nThe callers are Ben (Ben Gingold) and Ryan (Ryan Rosario). Return JSON: {"groups":[{"who":"Ben"|"Ryan"|"either","count":number,"want":"what kind of person, in the request's words, or empty"}],"state":"two-letter state if named, else empty","wonOnly":true|false (true unless the request is about candidates who have not won),"title":"short list title"}` });
      const j = r.json || {};
      if (Array.isArray(j.groups) && j.groups.length) return { groups: j.groups.slice(0, 6).map((g) => ({ who: String(g.who || 'either'), count: Math.max(1, Math.min(25, Number(g.count) || 2)), want: String(g.want || '').slice(0, 200) })), state: j.state || '', wonOnly: j.wonOnly !== false, title: j.title || '' };
    }
  } catch { /* the plain reading below */ }
  const n = Number((/\b(\d{1,2})\b/.exec(t) || [])[1]) || count || 5;
  return { groups: [{ who: /ryan/i.test(t) && !/ben/i.test(t) ? 'Ryan' : 'Ben', count: n, want: t.replace(/\b(make|build|give|me|a|call list|list|of|for|tomorrow|tmrw|\d+)\b/gi, ' ').replace(/\s+/g, ' ').trim().slice(0, 200) }], state: (/\b(NY|CT|NJ|MA|RI)\b/.exec(t) || [])[1] || '', wonOnly: !/candidate|challenger|running/i.test(t), title: '' };
}

/** Start a call list (job calllist.build). */
function start(b = {}, by = 'user') {
  const request = String(b.request || b.text || '').trim();
  if (!request && !Array.isArray(b.groups)) throw new Error('Say who you want on the list (for example "two for Ben and two for Ryan, freshly re-elected NY Assembly members").');
  const l = ctx.store.insert(COL, { title: String(b.title || '').slice(0, 120) || `Call list ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`, request, groups: Array.isArray(b.groups) ? b.groups : null, state: b.state || '', wonOnly: b.wonOnly !== false, includePrevious: !!b.includePrevious, exclude: Array.isArray(b.exclude) ? b.exclude.map(String) : [], verify: b.verify !== false, status: 'working', note: 'Starting', progress: 0, items: [], by, createdAt: now(), updatedAt: now() });
  const job = require('../jobs/queue').enqueue('calllist.build', { id: l.id }, { actor: by, title: `Call list: ${request.slice(0, 60) || l.title}`, dedupeKey: `calllist:${l.id}` });
  audit.log(by, 'calllist.started', { id: l.id, request: request.slice(0, 200) });
  return update(l.id, { jobId: job.id });
}
function resume(id, by = 'user') {
  const l = get(id); if (!l) throw new Error('That call list is gone.');
  const job = require('../jobs/queue').enqueue('calllist.build', { id: l.id }, { actor: by, title: `Carry on: ${l.title}`, dedupeKey: `calllist:${l.id}` });
  return update(l.id, { status: 'working', jobId: job.id, error: null });
}

async function runBuild(job, h) {
  const id = job.payload.id;
  try { return await build(job, h); } catch (e) { if (get(id)) update(id, { status: 'failed', error: e.message, note: e.message }); throw e; }
}
async function build(job, h) {
  let l = get(job.payload.id); if (!l) throw Object.assign(new Error('That call list was removed.'), { permanent: true });
  update(l.id, { status: 'working', error: null });
  // groups
  if (!l.groups) {
    h.progress(0.03, 'Reading what you asked for');
    const g = await groupsFrom(l.request, 5);
    l = update(l.id, { groups: g.groups, state: l.state || g.state, wonOnly: l.wonOnly && g.wonOnly, title: l.title.startsWith('Call list ') && g.title ? `${g.title}` : l.title });
  }
  // pool and exclusions (worked out once)
  if (!l.items.length) {
    h.progress(0.08, 'Leaving out everyone already contacted');
    const contacted = contactedNames({ includePrevious: l.includePrevious });
    for (const n of l.exclude || []) contacted.set(norm(n), 'you said to leave them out');
    const all = pool({ state: l.state });
    const out = {}; const keep = [];
    for (const p of all) {
      const why = reasonOut(p, contacted) || (l.wonOnly && p.status !== 'won' ? 'not marked as won' : '');
      if (why) { const k = why.replace(/^in .+/, 'in a call log or contact list').replace(/^on call list .+/, 'on an earlier call list'); out[k] = (out[k] || 0) + 1; } else keep.push(p);
    }
    if (!keep.length) throw Object.assign(new Error(`Nobody is left to call: ${Object.entries(out).map(([k, v]) => `${v} ${k}`).join(', ') || 'the leads board and Data tab have no people yet'}. Add a winners list to the Data tab or import leads.`), { permanent: true });
    // picks per group, with spares
    h.progress(0.14, 'Picking who fits');
    const items = []; const taken = new Set();
    for (let gi = 0; gi < l.groups.length; gi++) {
      const g = l.groups[gi]; const want = g.want || '';
      const avail = keep.filter((p) => !taken.has(norm(p.name)));
      let order = [];
      const lines = avail.slice(0, 260).map((p, i) => `${i + 1}. ${p.name} | ${p.office || '?'}${p.tier ? ` | Tier ${p.tier}` : ''} | ${(p.info || '').slice(0, 140)}`);
      try {
        if (want && ai.firstFor('writing')) {
          const r = await ai.ask({ role: 'writing', json: true, maxTokens: 500, jobId: job.id, system: 'You pick people for a sales call list from a numbered pool. Pick only from the pool. Use public, professional information only.', prompt: `WANT: ${g.count} people: ${want}\nPOOL:\n${lines.join('\n')}\n\nReturn JSON: {"picks":[pool numbers, best first, ${g.count + Math.min(4, g.count + 1)} of them (spares included)],"why":{"number":"short reason"}}` });
          order = (r.json?.picks || []).map((n) => avail[Number(n) - 1]).filter(Boolean);
          for (const p of order) p.pickWhy = String(r.json?.why?.[avail.indexOf(p) + 1] || '').slice(0, 200);
        }
      } catch { /* word match below */ }
      if (!order.length) {
        const words = norm(want).split(' ').filter((w) => w.length > 3 && !/people|members|member|freshly|elected|reelected|call|list|tomorrow/.test(w));
        const sc = (p) => words.filter((w) => norm(`${p.office} ${p.info}`).includes(w)).length * 3 + (p.tier === 'A' ? 2 : p.tier === 'B' ? 1 : 0) + (p.hook ? 1 : 0) + (p.prospectId ? 0.5 : 0);
        order = [...avail].sort((a, b) => sc(b) - sc(a)).slice(0, g.count + Math.min(4, g.count + 1));
      }
      order.forEach((p, k) => { taken.add(norm(p.name)); items.push({ ...p, group: gi, who: g.who, spare: k >= g.count, picked: false, state2: 'waiting' }); });
    }
    l = update(l.id, { items, left: out, poolSize: all.length, keepSize: keep.length });
  }
  // check each person (saved after each one)
  const items = l.items;
  const need = (gi) => l.groups[gi].count - items.filter((x) => x.group === gi && x.picked).length;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.state2 !== 'waiting') continue;
    if (need(it.group) <= 0) { it.state2 = 'spare'; continue; }
    h.progress(0.18 + 0.72 * (i / items.length), `Checking ${it.name} on official pages`);
    update(l.id, { note: `Checking ${it.name} (${i + 1} of ${items.length})`, progress: 0.18 + 0.72 * (i / items.length) });
    let v = { phones: [], emails: [], checked: [] };
    if (l.verify) { try { v = await verify(it, l.groups[it.group].want); } catch (e) { v.checked = [`check failed: ${e.message.slice(0, 120)}`]; } }
    if (v.fit === 'no') { it.state2 = 'dropped'; it.dropWhy = v.fitWhy || 'their official bio does not show it'; ctx.store.update(COL, l.id, { items }); continue; }
    Object.assign(it, { verified: v, picked: true, state2: 'checked' });
    if (v.hook) { it.hook = v.hook; it.hookShort = v.hookShort || ''; it.hookSource = v.hookSource; it.hookChecked = true; }
    it.drafts = drafts(it, callerFor(it.who));
    ctx.store.update(COL, l.id, { items });
  }
  for (const it of items) if (it.state2 === 'waiting') it.state2 = 'spare';
  ctx.store.update(COL, l.id, { items });
  h.progress(0.92, 'Making the call sheet');
  const doc = await toDoc(l.id, job.actor || l.by);
  const done = update(l.id, { status: 'done', progress: 1, note: '', documentId: doc?.id || null, finishedAt: now() });
  const picked = done.items.filter((x) => x.picked);
  audit.log(l.by || 'system', 'calllist.done', { id: l.id, title: l.title, people: picked.length, names: picked.map((x) => x.name).slice(0, 20) });
  return { id: l.id, people: picked.map((x) => `${x.name} (${x.who})`), documentId: doc?.id || null, missing: l.groups.map((g, gi) => need(gi) > 0 ? `${g.who}: ${need(gi)} short` : null).filter(Boolean) };
}

/** The call sheet as a plain document (PDF + Word + Data tab copy). */
async function toDoc(id, by = 'system') {
  const l = get(id); if (!l) return null;
  const picked = l.items.filter((x) => x.picked);
  const ph = (it) => {
    const v = it.verified?.phones || [];
    const by2 = (lab) => v.filter((x) => x.label === lab).map((x) => x.num).join(' / ');
    const list = [['Campaign', /\d{3}.\d{3}.\d{4}/.test(it.phone || '') && !v.some((x) => String(it.phone).includes(x.num)) ? `${it.phone} (from our list)` : ''], ['District', by2('District') || by2('Office')], ['Albany', by2('Albany')], ['DC', by2('DC')]].filter(([, x]) => x);
    return list.length ? list.map(([k, x]) => `${k} ${x}`).join(' | ') : (it.phone ? `${it.phone} (from our list, not checked)` : 'none found');
  };
  const em = (it) => {
    const off = (it.verified?.emails || []).map((x) => x.email);
    const camp = it.email && !isGov(it.email) ? `${it.email} (campaign, from our list)` : '';
    const gov = [...new Set([...off, it.officialEmail].filter(Boolean))].map((e) => `${e} (${off.includes(e) ? 'confirmed on the official page' : 'from our list'}; office, for scheduling)`);
    return [camp, ...gov].filter(Boolean).join('; ') || 'none found: ask for the comms director\'s email on the call';
  };
  const sections = [];
  sections.push({ title: 'Who to call', blocks: [
    { type: 'text', text: `${l.request ? `Asked for: "${l.request}". ` : ''}${picked.length} people, all checked against official pages where we could find them${l.wonOnly ? ', all marked as won' : ''}. Left out ${Object.values(l.left || {}).reduce((a, b) => a + b, 0)} of ${l.poolSize || '?'}: ${Object.entries(l.left || {}).map(([k, v]) => `${v} ${k}`).join(', ') || 'none'}. Calling order: campaign, then district, then Albany. Drafts only, nothing sent.` },
    ...l.groups.map((g, gi) => ({ type: 'table', title: `${g.who === 'either' ? 'Either of you' : g.who}: ${g.want || `${g.count} people`}`, columns: ['#', 'Name', 'Seat', 'Phones', 'Hook (checked)'], rows: picked.filter((x) => x.group === gi).map((x, k) => [String(k + 1), x.name, x.office || '', ph(x), x.hookChecked ? 'yes' : 'from our list' ]) })),
    ...(l.items.some((x) => x.state2 === 'dropped') ? [{ type: 'callout', tone: 'warn', title: 'Dropped at the check', text: l.items.filter((x) => x.state2 === 'dropped').map((x) => `${x.name}: ${x.dropWhy}`).join('\n') }] : []),
  ] });
  let n = 0;
  sections.push({ title: 'Each person', blocks: picked.map((it) => ({
    type: 'person', n: ++n, name: it.name, seat: it.office, status: it.status === 'won' ? 'won' : '', tier: it.tier || '',
    result: it.status === 'won' ? `Won (${it.sources?.[0] || 'our list'})` : '', why: [it.pickWhy, it.verified?.fitWhy].filter(Boolean).join(' '),
    phones: ph(it), email: em(it), hook: it.hook || 'none found on their official pages', source: it.hookSource || (it.verified?.checked || [])[0] || '',
    notes: `Calls: ${it.who}. Checked: ${(it.verified?.checked || []).join(', ') || 'not checked (no official page found)'}`,
    script: it.drafts?.script, voicemail: it.drafts?.voicemail,
    emailDraft: it.drafts?.email ? { subject: it.drafts.email.subject, body: `${it.drafts.email.to ? `To: ${it.drafts.email.to}\n\n` : it.drafts.email.note ? `(${it.drafts.email.note})\n\n` : ''}${it.drafts.email.body}` } : null,
  })) });
  const D = require('../docs');
  if (l.documentId && D.get(l.documentId)) D.remove(l.documentId, by);
  return D.make({ spec: { title: l.title, subtitle: `${picked.length} people · made ${new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} ET`, note: 'Drafts only, nothing sent', look: 'plain', sections }, kind: 'calllist', about: l.request, by });
}

// ------------------------------------------------------------------ contact book

/** Everyone we reached out to in the last N days: what was sent, what came back, and the next step. */
function contactBook({ days = 14 } = {}) {
  const since = new Date(Date.now() - days * 86400e3).toISOString();
  const msgs = ctx.store.all('messages').filter((m) => (m.createdAt || '') >= since);
  const byConv = new Map(); for (const m of msgs) { if (!byConv.has(m.conversationId)) byConv.set(m.conversationId, []); byConv.get(m.conversationId).push(m); }
  const people = [];
  for (const [cid, ms] of byConv) {
    const conv = ctx.store.get('conversations', cid); const contact = conv && ctx.store.get('contacts', conv.contactId); if (!contact) continue;
    const out = ms.filter((m) => m.direction !== 'in' && ['sent', 'delivered', 'failed', 'bounced'].includes(m.status));
    if (!out.length) continue;
    const ins = ms.filter((m) => m.direction === 'in');
    const auto = (m) => require('../automation/mailbox').AUTO.test(`${m.subject} ${m.body} ${m.fromAddress || ''}`);
    const human = ins.filter((m) => !auto(m)); const autos = ins.filter(auto);
    const bounced = out.filter((m) => /fail|bounce/i.test(m.status));
    const lead = ctx.store.find('prospects', (p) => norm(p.name) === norm(contact.name) || (contact.email && p.email === contact.email));
    const t = (s) => new Date(s).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    people.push({
      name: contact.name, office: lead?.office || '', result: lead?.electionResult || '', phone: lead?.phone || contact.phone || '', email: contact.email || '',
      sent: out.map((m) => `${m.status === 'sent' || m.status === 'delivered' ? 'Sent' : m.status} ${t(m.sentAt || m.createdAt)}${m.subject ? ` "${m.subject}"` : ''}${m.to ? ` to ${m.to}` : ''}`).join('; '),
      response: human.length ? human.map((m) => `${t(m.receivedAt || m.createdAt)}: "${String(m.body || '').replace(/\s+/g, ' ').slice(0, 160)}"`).join(' ') : autos.length ? `Auto-reply ${t(autos[0].receivedAt || autos[0].createdAt)}: "${String(autos[0].body || '').replace(/\s+/g, ' ').slice(0, 120)}" (form reply, not a person)` : '',
      bounced: bounced.length > 0, stage: lead?.stage || '', notes: lead?.callNotes || lead?.lastCall || '',
      next: human.length ? (lead?.stage === 'meeting' ? 'MEETING SET' : 'REPLY to them') : bounced.length ? 'FIND A WORKING EMAIL: call and ask for the comms director' : autos.length ? 'RE-CALL: ask for the comms director\'s name and email' : 'RE-CALL: no reply yet',
      group: human.length ? 'responded' : 'waiting',
    });
  }
  people.sort((a, b) => (a.group === b.group ? a.name.localeCompare(b.name) : a.group === 'responded' ? -1 : 1));
  return { days, people, responded: people.filter((p) => p.group === 'responded').length, waiting: people.filter((p) => p.group !== 'responded').length };
}
function contactBookDoc({ days = 14, by = 'user' } = {}) {
  const b = contactBook({ days });
  if (!b.people.length) throw new Error(`No outreach in the last ${days} days to put in a contact book.`);
  const day = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const resp = b.people.filter((p) => p.group === 'responded'); const wait = b.people.filter((p) => p.group !== 'responded');
  const sections = [
    ...(resp.length ? [{ title: 'Part 1. People who responded', blocks: [{ type: 'people', items: resp.map((p, i) => ({ n: i + 1, name: p.name, seat: p.office, result: p.result, phones: p.phone, email: `${p.email}${p.bounced ? ' (bounced)' : ''}`, notes: `Sent: ${p.sent}`, why: p.response ? `Response: ${p.response}` : '', next: p.next })) }] }] : []),
    ...(wait.length ? [{ title: `Part ${resp.length ? 2 : 1}. Re-call list (no reply yet)`, blocks: [{ type: 'table', columns: ['#', 'Name and office', 'Phone', 'Email (sent)', 'Next'], rows: wait.map((p, i) => [String(i + 1), `${p.name}${p.office ? `, ${p.office}` : ''}`, p.phone || 'none on file', `${p.email}${p.bounced ? ' (bounced)' : ''}`, p.next]) }] }] : []),
  ];
  return require('../docs').make({ spec: { title: `Contact Book, ${day}`, subtitle: `Everyone we reached out to in the last ${days} days. Times are Eastern.`, look: 'plain', sections }, kind: 'contactbook', by });
}

module.exports = { secondPerson, start, resume, runBuild, list, get, remove, pool, contactedNames, verify, contactsFrom, hookCandidates, drafts, contactBook, contactBookDoc, toDoc, groupsFrom, COL };
