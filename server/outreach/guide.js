'use strict';
/**
 * The political outreach guide (Ben and Ryan's "full guide to our email system", Parts 1 to 8 and Appendices A and B),
 * as code. One place decides who gets drafted and how they're framed, the internal price tier, the research card, and
 * every piece of copy (first email, day-4 follow-up, live call, voicemail, text, DM), then runs the guide's QA.
 *
 * Used by HAL ("email <name>", "draft the batch") and by the Politics lane's package email step.
 *
 * Rules that are enforced here, not left to the AI:
 *  - Drafts only. Ben sends by hand from his Gmail; political drafts are never auto-sent (autopilot.js checks this).
 *  - The fixed lines are verbatim (credibility line once, youth line in calls and voicemails after the congrats and hook).
 *  - The AI only writes the hook sentences, subject, question and topic, from the research it is handed; any number or
 *    claim that isn't in the fetched material is dropped and the card says UNKNOWN.
 *  - No em or en dashes, banned phrases, governors, Isaiah Martin, prices, links or attachments in a first touch.
 *  - Ryan's people are never drafted; judges, IE committees, suspended or lost-primary candidates are excluded; anyone
 *    in a scandal is on HOLD.
 */
const ctx = require('../core/ctx');
const audit = require('../core/audit');
const { isGov, isEmail, excluded, withFooter } = require('./common');

// ------------------------------------------------------------------ fixed facts (Appendix B: do not change without Ben)
const SIGNER = 'Ben Gingold';
const PHONE = '917-699-4151';
const PHONE_TWICE = '917-699-4151, that\'s nine one seven, six nine nine, four one five one.';
const CRED = "I've helped political creators and politicians get tens of millions of views.";
const CRED_VM = "We've helped political creators and politicians get tens of millions of views.";
const YOUTH = "I just graduated, and my partner Ryan's at UConn Law.";
const YOUTH_CALL = 'We run this together and we know what people our age actually watch.';
const WHAT_WE_DO = "We turn an office's votes, wins and events into short vertical videos and graphics for Instagram, TikTok, Facebook and YouTube Shorts, and handle all the editing and posting.";
const ELECTION_DAY = '2026-11-03';

const BANNED = ['leverage', 'synergy', 'elevate', 'amplify your message', 'digital presence', 'content strategy', 'full-service', 'full service', 'partner with you', "we'd love to partner", 'flat-rate', 'flat rate', 'posts a week', 'hundreds of millions of views', 'subsidiary', 'zspan', 'high-level political officials', 'real fire', "we're confident you're going to win", 'i was particularly struck by', 'incredibly compelling story', 'low risk way to try it', 'open to a 20 minute call', 'isaiah martin', 'governor'];
const RYANS = ['lamont', 'bronin', 'jahana hayes', 'hayes', 'himes', 'delauro', 'courtney', 'connecticut democratic party', 'ct democratic party', 'werstler'];

const S = (k, d) => ctx.setting(`outreach.political.${k}`, d);
const now = () => new Date().toISOString();
const words = (s) => String(s || '').trim().split(/\s+/).filter(Boolean).length;
const firstName = (n) => String(n || '').trim().split(/\s+/)[0] || 'there';
const lastName = (n) => { const w = String(n || '').trim().replace(/,?\s+(jr|sr|ii|iii|iv)\.?$/i, '').split(/\s+/); return w[w.length - 1] || ''; };
const UNKNOWN = 'UNKNOWN';
const known = (v) => v != null && v !== '' && String(v).toUpperCase() !== UNKNOWN;

/** No em or en dashes anywhere: a comma, or "to" between numbers. */
function noDash(s) {
  return String(s || '').replace(/(\d)\s*[–—]\s*(\d)/g, '$1 to $2').replace(/\s*[—–]\s*/g, ', ').replace(/,\s*,/g, ',').replace(/ ,/g, ',');
}
/** "Governor's $2.5 million" → "state money" (rule 2). */
const noGovernor = (s) => String(s || '').replace(/\b(?:the\s+)?(?:lieutenant\s+)?governor(?:'s)?(?:\s+[A-Z][a-z]+)?(?:'s)?\s+(\$[\d.,]+\s*(?:million|billion|thousand|k|m)?)/gi, '$1 in state money').replace(/\b(?:the\s+)?(?:lieutenant\s+)?governor(?:'s)?\b/gi, 'the state');

// ------------------------------------------------------------------ who, and how they're framed (Part 2)
const isRyans = (p) => { const n = `${p.name || ''} ${p.campaign || ''}`.toLowerCase(); const extra = String(S('ryansPeople', '') || '').split(/[\n,]+/).map((x) => x.trim().toLowerCase()).filter(Boolean); return [...RYANS, ...extra].some((r) => new RegExp(`\\b${r.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(n)); };

/**
 * { draft, framing: 'win'|'only-if-win'|'post-election'|'hold'|'exclude', status, reason, flags[] } for one prospect,
 * from what's on the card (and the research card once there is one).
 */
function classify(p, card = {}) {
  const flags = [];
  const office = `${p.office || ''} ${card.office || ''}`.toLowerCase();
  const notes = `${p.why || ''} ${p.notes || ''} ${p.race || ''} ${p.hold || ''} ${p.status || ''} ${card.status || ''} ${card.avoid || ''}`.toLowerCase();
  const out = (framing, reason) => ({ draft: false, framing, status: card.status || p.ballotStatus || UNKNOWN, reason, flags });
  if (isRyans(p)) return out('exclude', "Ryan's");
  if (/\b(judge|justice|surrogate|court of|judicial)\b/.test(office)) return out('exclude', 'Judicial candidate (judicial ethics rules)');
  if (/independent[- ]expenditure|super\s?pac|\bie committee\b/.test(`${office} ${String(p.name || '').toLowerCase()}`)) return out('exclude', 'Independent-expenditure committee (conflict)');
  if (/\bsuspended\b|\bdropped out\b|\bwithdrew\b|lost (?:the |their |her |his )?primary/.test(notes)) return out('exclude', 'Suspended or lost a primary');
  if (p.electionResult === 'lost' || /\blost (?:on )?nov(?:ember)? 3\b|\bconceded\b/.test(notes)) return out('exclude', 'Lost on Nov 3: never send');
  if (p.hold || /\b(fbi|indict|investigation|under investigation|probe|scandal|arrested|charged with)\b/.test(notes)) { flags.push('HOLD: under investigation or in an active scandal; no pitch unless Ben overrides in writing'); return { ...out('hold', 'HOLD'), flags }; }
  let status = String(card.status || p.ballotStatus || '').toLowerCase();
  if (!status) status = /\bincumbent\b/.test(notes) ? 'incumbent' : /\bchallenger\b/.test(notes) ? 'challenger' : /\bopen\b/.test(notes) ? 'open' : /not on (?:the )?ballot|elected (?:in )?2025|mid-?term/.test(notes) ? 'not on ballot' : /unopposed/.test(notes) ? 'unopposed' : 'unknown';
  if (/governor|attorney general|comptroller|secretary of state/.test(office)) flags.push('Statewide executive with an in-house team: long shot');
  if (/conflict/.test(status)) { flags.push('Status conflict between sources: verify before framing'); return { draft: true, framing: 'win', status, reason: '', flags }; }
  let framing = 'win';
  if (/not on (?:the )?ballot/.test(status)) framing = 'post-election';
  else if (/challenger|open/.test(status) && p.electionResult !== 'won') { framing = 'only-if-win'; flags.push('CONTACT ONLY IF THEY WIN NOV 3'); }
  else if (/unknown/.test(status)) flags.push('Ballot status UNKNOWN: confirm on the county BOE list before sending');
  const odds = Number(String(card.odds || '').replace(/[^\d.]/g, ''));
  if (framing === 'only-if-win' && odds && odds < 5) flags.push('Near-zero odds: SKIP unless they win');
  else if (framing === 'only-if-win' && odds && odds < 50) flags.push('Long shot: only if they win');
  if (framing === 'win' && p.electionResult !== 'won' && !/unopposed/.test(status)) flags.push('Confirm the win on the county BOE list or AP before sending');
  return { draft: true, framing, status, reason: '', flags };
}

// ------------------------------------------------------------------ price tier (internal only, never in a message)
const money = (v) => { if (!known(v)) return null; const m = /\$?\s*([\d,.]+)\s*(k|m|million|thousand)?/i.exec(String(v)); if (!m) return null; let n = Number(m[1].replace(/,/g, '')); const u = (m[2] || '').toLowerCase(); if (u === 'k' || u === 'thousand') n *= 1e3; if (u === 'm' || u === 'million') n *= 1e6; return Number.isFinite(n) ? n : null; };
const fmt$ = (n) => `$${n >= 1000 ? `${Math.round(n / 100) / 10}K` : Math.round(n)}`;

/** { tier: 549|949|1500, basis, flags[] } by the guide's rules. CT state grants are not their money. */
function tier(card = {}, p = {}) {
  const flags = []; const st = String(card.state || p.state || '').toUpperCase() || (/\bCT\b|connecticut/i.test(`${card.office || p.office}`) ? 'CT' : /\bNY\b|new york/i.test(`${card.office || p.office}`) ? 'NY' : '');
  const federal = /congress|u\.s\.|us house|us senate|representative for|\bny-\d|\bct-\d/i.test(`${card.office || p.office || ''}`);
  let cash = money(card.cash_on_hand); const grant = money(card.state_grant); const receipts = money(card.receipts); const match = money(card.public_match);
  const wealth = known(card.wealth_signal) && !/^none|^no\b/i.test(card.wealth_signal) ? String(card.wealth_signal) : '';
  const strong = wealth && /self[- ]?(fund|loan)|top donor|loaned|\$\d{2,}/i.test(wealth);
  if (st === 'CT' && cash != null && grant != null) cash = Math.max(0, cash - grant);
  const party = /committee|democratic party|dems\b/i.test(p.name || '') ? 'Party money, not personal' : '';
  if (party) flags.push(party);
  if (federal && cash == null) return { tier: 1500, basis: '$1,500 (unverified, pull FEC)', flags };
  const recNY = st === 'NY' && receipts != null ? receipts : null;
  let t = 549; let basis = 'Default: no finance data found (UNKNOWN)';
  if ((cash != null && cash >= 50000) || (recNY != null && recNY >= 100000) || strong) { t = 1500; basis = cash != null && cash >= 50000 ? `Cash on hand ${fmt$(cash)}${st === 'CT' && grant != null ? ' after the CEP grant' : ''}` : recNY != null && recNY >= 100000 ? `NY receipts incl. match ${fmt$(recNY)}${match ? ` (${fmt$(match)} match, campaign-only money)` : ''}` : `Wealth signal: ${wealth}`; }
  else if ((cash != null && cash >= 15000) || (recNY != null && recNY >= 30000) || wealth) { t = 949; basis = cash != null && cash >= 15000 ? `Cash on hand ${fmt$(cash)}${st === 'CT' && grant != null ? ' after the CEP grant' : ''}` : recNY != null && recNY >= 30000 ? `NY receipts incl. match ${fmt$(recNY)}` : `Moderate wealth signal: ${wealth}`; }
  else if (cash != null || recNY != null) basis = `${cash != null ? `Cash on hand ${fmt$(cash)}${st === 'CT' && grant != null ? ' after the CEP grant' : ''}` : `Receipts ${fmt$(recNY)}`}`;
  const usable = cash != null ? cash : recNY;
  if (usable != null && usable < 3000 && !wealth) flags.push('TOO BROKE, SKIP');
  if (st === 'CT' && cash != null && grant == null) flags.push('CT: CEP grant not found; check SEEC (cash may be pre-grant)');
  return { tier: t, basis, flags };
}

// ------------------------------------------------------------------ research (Part 3)
const officeShort = (o) => String(o || '').split(/[·,(]/)[0].trim();
async function gather(p, h = { progress() {} }) {
  const web = require('../hal/web');
  const src = []; const add = (title, url, text) => { if (!url || src.some((s) => s.url === url)) return src.find((s) => s.url === url)?.n; const n = src.length + 1; src.push({ n, title: String(title || url).slice(0, 140), url, text: String(text || '').slice(0, 3500) }); return n; };
  let profile = p.pkg?.profile || p.kit?.research?.profile || null;
  // Reuse the package research when there is one; otherwise the same free public lookups the packages use.
  if (p.pkg?.sources?.length) { for (const s of p.pkg.sources) add(s.title, s.url, (p.pkg.text || []).filter((t) => t.src === s.n).map((t) => t.text).join('\n')); for (const f of p.pkg.facts || []) { const s = p.pkg.sources.find((x) => x.n === f.src); if (s) { const e = src.find((x) => x.url === s.url); if (e && !e.text.includes(f.text)) e.text = `${f.text}\n${e.text}`.slice(0, 3500); } } }
  else {
    h.progress(0.1, 'Public records');
    try {
      const r = await require('../political/sources').lookup({ name: p.name, hint: p.office || p.location || '', campaignSite: /^https?:/.test(p.handle || '') ? p.handle : null, onStep: (x) => h.progress(0.15, `Researching: ${x}`) });
      profile = r.profile; for (const s of r.sources) add(s.title, s.url, [...r.facts.filter((f) => f.src === s.n).map((f) => f.text), ...r.text.filter((t) => t.src === s.n).map((t) => t.text)].join('\n'));
    } catch { /* offline: search below */ }
  }
  const st = /\bCT\b|connecticut/i.test(`${p.office} ${p.location} ${profile?.office}`) ? 'CT' : /\bNY\b|new york/i.test(`${p.office} ${p.location} ${profile?.office}`) ? 'NY' : '';
  const o = officeShort(p.office || profile?.office);
  const qs = [
    [`${p.name} ${o} secured funding million`, 'hook'], [`${p.name} ${o} bill sponsored passed`, 'hook'], [`"${p.name}" ${o}`, 'news'],
    [`${p.name} 99chambers`, 'odds'], [st === 'CT' ? `${p.name} SEEC cash on hand` : st === 'NY' ? `${p.name} transparencyusa` : `${p.name} campaign finance cash on hand`, 'money'],
    [`${p.name} campaign email contact`, 'contact'], [`${p.name} suspended OR "primary results" OR investigation`, 'status'],
  ];
  h.progress(0.4, 'Searching the web for their wins, money and contacts');
  const results = [];
  for (const [q, kind] of qs) { try { for (const r of (await web.search(q, 5)).slice(0, 4)) results.push({ ...r, kind }); } catch { /* skip */ } }
  for (const r of results) add(r.title, r.url, r.snippet);
  try { for (const n of await web.newsAbout(p.name, 5)) add(`News: ${n.t}`, n.url, `${n.t}. ${n.b || ''}`); } catch { /* offline */ }
  // Read the most useful pages in full (their own site, local news, finance pages); no PDFs or .gov forms.
  const toRead = results.filter((r) => /^https?:/.test(r.url) && !/\.pdf($|\?)/i.test(r.url) && !/facebook|instagram|x\.com|twitter|tiktok|youtube/.test(r.url)).slice(0, 5);
  h.progress(0.55, 'Reading pages');
  for (const r of toRead) { try { const pg = await web.readPage(r.url); const e = src.find((s) => s.url === r.url); if (e) e.text = `${e.text}\n${pg.text}`.slice(0, 3500); } catch { /* unreadable */ } }
  return { profile, sources: src, state: st, at: now() };
}

const nums = (s) => (String(s || '').match(/\$?\d[\d,.]*\s*(?:million|billion|thousand|k|m|%)?/gi) || []).map((x) => x.replace(/[^\d.]/g, '').replace(/\.$/, '')).filter((x) => x.length);
/** A claim survives only if each number in it appears in the material. */
const grounded = (claim, material) => { const have = new Set(nums(material)); return nums(claim).every((n) => have.has(n) || have.has(n.replace(/\.0+$/, ''))); };

const CARD_KEYS = ['name', 'office', 'district_towns', 'status', 'framing', 'opponent', 'odds', 'odds_source', 'cash_on_hand', 'receipts', 'public_match', 'state_grant', 'finance_as_of', 'finance_source', 'wealth_signal', 'tier', 'tier_basis', 'email', 'email_source', 'email_verified', 'phone', 'phone_source', 'phone_type', 'socials', 'last_post_dates', 'existing_vendors', 'hook_email', 'hook_voicemail', 'sample_topic', 'prior_contact', 'avoid', 'flags', 'sources'];

/** Prior contact from the app's own messages (and any note on an imported list). */
function priorContact(p) {
  const contact = p.contactId ? ctx.store.get('contacts', p.contactId) : null;
  const sent = contact ? ctx.store.all('messages', (m) => m.contactId === contact.id && m.direction === 'out' && ['sent', 'delivered'].includes(m.status)) : [];
  const note = String(p.priorContact || p.prior_contact || '').trim();
  const ryan = /\bryan\b/i.test(note) || sent.some((m) => /ryan/i.test(m.createdBy || ''));
  return { count: sent.length + (note && !sent.length ? 1 : 0), last: sent[sent.length - 1] || null, note, ryan, text: sent.length ? `${sent.length} email${sent.length === 1 ? '' : 's'} sent, last ${String(sent[sent.length - 1].sentAt || sent[sent.length - 1].createdAt).slice(0, 10)} (${sent[sent.length - 1].createdBy || 'us'})` : note || 'none' };
}

/** The research card, every field sourced or UNKNOWN. */
async function researchCard(p, res) {
  const material = res.sources.map((s) => `[${s.n}] ${s.title} (${s.url})\n${s.text}`).join('\n\n').slice(0, 26000);
  const pr = res.profile || {};
  const emails = (pr.emails || []).map((e) => e.email); const own = new Set((pr.emails || []).filter((e) => /campaign|website/i.test(String(e.page || '')) || (pr.sites || []).some((s) => String(e.page || '').includes(s))).map((e) => e.email));
  let card = {};
  try {
    const r = await require('../hal/brain').think({ json: true, maxTokens: 1400, system: `You are the outreach researcher for Euclidean Media. Fill a research card for ONE elected official or candidate from the MATERIAL only. Every value must come from the material; anything not in it is "UNKNOWN". Never guess a number, an email, a phone, odds or a date. Ignore Decision Desk HQ pre-result pages for Nov 3, 2026. Never use .gov or legislature email addresses as the email. No em or en dashes. Return JSON with exactly these keys: ${CARD_KEYS.filter((k) => !['tier', 'tier_basis', 'framing', 'flags', 'sources', 'prior_contact'].includes(k)).join(', ')}, plus "hook_source" (the [n] of the hook's source), "state" (NY, CT or other) and "already_makes_short_video" (true/false/UNKNOWN). status is one of: incumbent, open, challenger, not on ballot, unopposed, suspended, lost primary, status conflict, UNKNOWN. hook_email: ONE sentence, a specific sourced fact about them from the last 90 days if possible, in this order of preference: funding they secured for the district, a bill they sponsored or passed or a committee they chair, a memorable quote of theirs in local news, a personal story from their own About page, a local fight. Rephrase anything involving a governor as "state money". hook_voicemail: the same hook in under 15 words. sample_topic: a 3 to 6 word topic for a free 30-second video. avoid: controversies, investigations, opponent attacks or sensitive personal material found (never used in copy). socials and last_post_dates: handles and last post date per platform if the material shows them.`,
      messages: [{ role: 'user', content: `Person: ${p.name}${p.office ? `, ${p.office}` : ''}${p.location ? ` (${p.location})` : ''}.\nKnown campaign emails found by the app: ${emails.join(', ') || 'none'}.\nPhone found: ${pr.officePhone || 'none'}.\n\nMATERIAL:\n${material}` }] });
    card = r.json || {};
    card._by = r.by;
  } catch (e) { card = { _error: e.message }; }
  // Keep only what the material backs up.
  for (const k of ['cash_on_hand', 'receipts', 'public_match', 'state_grant', 'odds', 'hook_email', 'hook_voicemail']) if (known(card[k]) && !grounded(card[k], material)) card[k] = UNKNOWN;
  if (known(card.hook_email) && !known(card.hook_source)) { const n = res.sources.find((s) => nums(card.hook_email).length && nums(card.hook_email).every((x) => nums(s.text).includes(x)))?.n; card.hook_source = n || UNKNOWN; }
  for (const k of CARD_KEYS) if (!known(card[k]) && !['tier', 'tier_basis', 'framing', 'flags', 'sources', 'prior_contact'].includes(k)) card[k] = UNKNOWN;
  card.name = p.name; if (!known(card.office)) card.office = p.office || pr.office || UNKNOWN;
  // Email: a real, non-.gov address the app actually found (or the one on the lead), verified only when printed by the campaign.
  // An address the AI read must literally be in the material; it counts as printed by the campaign when it sits on a
  // page of the campaign's own domain.
  const lowMat = material.toLowerCase();
  const listed = [card.email, p.publicContact, p.email, ...emails].map((x) => String(x || '').trim().toLowerCase()).filter((x) => isEmail(x) && !isGov(x));
  const pick = listed.find((x) => emails.includes(x) || x === String(p.publicContact || p.email || '').toLowerCase() || lowMat.includes(x)) || '';
  const onOwnPage = pick && res.sources.find((s) => s.text.toLowerCase().includes(pick) && (() => { try { return new URL(s.url).hostname.replace(/^www\./, '').endsWith(pick.split('@')[1]); } catch { return false; } })());
  card.email = pick || UNKNOWN;
  card.email_verified = pick ? (own.has(pick) || onOwnPage || p.contactVerified || p.imported ? 'verified' : 'unverified') : UNKNOWN;
  if (pick && !known(card.email_source)) card.email_source = own.has(pick) ? 'Campaign site' : onOwnPage ? onOwnPage.url : p.imported ? 'Imported list' : (pr.emails || []).find((e) => e.email === pick)?.page || res.sources.find((s) => s.text.toLowerCase().includes(pick))?.url || 'Search result';
  if (!pick && [p.publicContact, p.email, ...emails].some((x) => isGov(x))) card.email_note = 'Only a .gov address found: route by phone or DM and ask for a campaign address';
  if (!known(card.phone) && pr.officePhone) { card.phone = pr.officePhone; card.phone_source = card.phone_source !== UNKNOWN ? card.phone_source : 'Official listing'; card.phone_type = 'district office'; }
  if (known(card.phone) && !known(card.phone_type)) card.phone_type = 'unknown';
  card.sources = res.sources.filter((s) => s.text).map((s) => s.url);
  card.state = String(card.state || res.state || '').toUpperCase();
  return card;
}

// ------------------------------------------------------------------ copy (Part 1 templates, Part 5 examples)
const TITLES = [[/state senat|senator|\bsenate\b/i, 'Senator'], [/assembly/i, 'Assemblymember'], [/state rep|representative|house of rep|\bhouse\b|congress/i, 'Representative'], [/county legislat|legislator/i, 'Legislator'], [/council/i, 'Councilmember'], [/mayor/i, 'Mayor'], [/supervisor/i, 'Supervisor']];
const titleFor = (p, card, framing) => { if (framing !== 'win' && framing !== 'post-election') return p.name; if (!/incumbent|unopposed|not on ballot/.test(String(card.status))) return p.name; const t = TITLES.find(([re]) => re.test(`${card.office || p.office || ''}`)); return t ? `${t[1]} ${lastName(p.name)}` : p.name; };

/** The parts the AI writes (from the card only). Everything else is the guide's fixed scaffold. */
async function writeParts(p, card, framing, prior) {
  const fallback = { subject: String(card.sample_topic || 'quick idea').toLowerCase().split(/\s+/).slice(0, 3).join(' '), fact: known(card.hook_email) ? card.hook_email : '', question: 'Who handles your social, you or someone on staff?', vm_hook: known(card.hook_voicemail) ? card.hook_voicemail.replace(/[.!]+$/, '') : '', topic: known(card.sample_topic) ? card.sample_topic : '', dm: '', text: '' };
  if (!known(card.hook_email)) return { ...fallback, by: 'template' };
  try {
    const r = await require('../hal/brain').think({ json: true, maxTokens: 600, system: `You write first-touch outreach for Ben Gingold of Euclidean Media, one person writing to one person. Use ONLY the research card. Lead with THEM. Human and specific: if it could be sent to any politician by swapping the name, rewrite it. Never mention prices, packages, links, attachments, governors (say "state money"), Isaiah Martin, opponents, scandals or sensitive personal material. No em or en dashes. Never use: ${BANNED.join(', ')}. Return JSON: {"subject":"2 to 4 lowercase words tied to the hook","fact":"one or two sentences: the specific sourced fact, why it matters to people in their district, and the gap (nobody has seen it, their feed doesn't show it) only if the card shows a real gap","question":"one easy question, e.g. Who handles your social, you or someone on staff? or Want me to cut that one as a free sample?","vm_hook":"the hook in under 15 words, a noun phrase that reads before 'is a great story'","topic":"3 to 6 words, the free 30-second video's topic","dm":"under 50 words, for Instagram/X/Facebook, no price, no link, ends with a question","text":"under 40 words, identifies Ben first: Hi <first>, Ben Gingold from Euclidean Media. ..."}. ${framing === 'post-election' ? 'They were NOT on the Nov 3 ballot: never congratulate them on a win.' : 'They won on Nov 3 (or will be contacted only if they win).'}${String(card.state) === 'NY' && /rockville centre/i.test(`${card.district_towns}`) ? ' Ben lives in Rockville Centre, so "my neighbors here" is true for this one.' : ''}`,
      messages: [{ role: 'user', content: JSON.stringify({ name: p.name, office: card.office, district_towns: card.district_towns, hook: card.hook_email, hook_voicemail: card.hook_voicemail, sample_topic: card.sample_topic, socials: card.socials, last_post_dates: card.last_post_dates, prior_contact: prior.text }) }] });
    const j = r.json || {}; const out = { ...fallback };
    for (const k of Object.keys(fallback)) if (typeof j[k] === 'string' && j[k].trim()) out[k] = j[k].trim();
    // Anything the AI added that isn't in the card's facts goes back to the card's own words.
    if (!grounded(out.fact, `${card.hook_email} ${card.last_post_dates} ${card.socials}`)) out.fact = card.hook_email;
    if (!grounded(out.vm_hook, card.hook_email)) out.vm_hook = fallback.vm_hook;
    if (!grounded(out.dm, `${card.hook_email} ${card.last_post_dates}`)) out.dm = '';
    if (!grounded(out.text, card.hook_email)) out.text = '';
    out.subject = out.subject.toLowerCase().replace(/[^a-z0-9 '&]/g, '').split(/\s+/).filter(Boolean).slice(0, 4).join(' ') || fallback.subject;
    return { ...out, by: r.by };
  } catch { return { ...fallback, by: 'template' }; }
}

const clean = (s) => noDash(noGovernor(String(s || '').trim()));
const sentence = (s) => { const t = clean(s); return t && !/[.!?]$/.test(t) ? `${t}.` : t; };

function compose(p, card, parts, framing, prior) {
  const first = firstName(p.name); const title = titleFor(p, card, framing);
  const greetName = title === p.name ? first : title;
  const opener = framing === 'post-election' ? 'With the election behind us, quick note.' : 'Congrats on the win.';
  const vmOpener = framing === 'post-election' ? 'With the election over, quick call.' : 'Congrats on the win.';
  const hasEmail = known(card.email);
  const fact = sentence(parts.fact);
  const out = {};
  if (fact) {
    if (prior.count >= 1) {
      out.email = { subject: prior.last?.subject ? (/^re:/i.test(prior.last.subject) ? prior.last.subject : `Re: ${prior.last.subject}`) : parts.subject, threadReply: true,
        body: [`Hi ${greetName},`, `${opener} Different idea from my last note: ${fact.replace(/^[A-Z]/, (c) => c.toLowerCase())} I'd make you a free 30-second video on it, no strings.`, CRED, "Who's the right person to send it to?", SIGNER].join('\n\n') };
    } else {
      out.email = { subject: parts.subject, body: [`Hi ${greetName},`, `${opener} ${fact}`, "I'm Ben, a political creator and journalist. I turn moments like that into short videos people in the district actually watch.", CRED, sentence(parts.question).replace(/\.$/, '?').replace(/\?\?$/, '?'), SIGNER].join('\n\n') };
    }
  }
  out.followup = `${first}, bumping this once. Even pointing me to the right person helps. Ben`;
  const hook = clean(parts.vm_hook || card.hook_voicemail || '').replace(/[.!]+$/, '');
  const topic = clean(parts.topic || card.sample_topic || '').replace(/[.!]+$/, '');
  if (hook) {
    out.call = `Hi, this is Ben Gingold from Euclidean Media. Is ${title} available, or whoever handles their comms? ... ${framing === 'post-election' ? 'With the election behind us, quick call.' : 'Congrats on the win.'} ${hasEmail ? `I just sent ${first} an email about ${hook.replace(/^[A-Z](?=[a-z])/, (c) => c.toLowerCase())}.` : `I'm calling about ${hook.replace(/^[A-Z](?=[a-z])/, (c) => c.toLowerCase())}.`} ${YOUTH} ${YOUTH_CALL} ${CRED} ${sentence(parts.question).replace(/\.$/, '?')}`;
    const vm = (h) => [`Hi, this is Ben Gingold with Euclidean Media, calling for ${title} or whoever handles their social media.`, vmOpener, `${h.replace(/^[a-z]/, (c) => c.toUpperCase())} is a great story.`, WHAT_WE_DO, YOUTH, CRED_VM, `Got 10 minutes for a call? I'll make you a free sample, a 30-second video on ${topic || 'that'}.`, PHONE_TWICE, hasEmail ? 'I also sent a note to your email.' : '', 'Thanks.'].filter(Boolean).join(' ');
    let v = vm(hook);
    // 115 to 127 words: trim a long hook at a natural break, or use the fuller email hook when it's short.
    if (words(v) > 127) { const w = hook.split(/\s+/); for (let n = w.length - 1; n >= 6 && words(v) > 127; n--) v = vm(w.slice(0, n).join(' ').replace(/[,;:]$/, '')); }
    if (words(v) < 115 && known(card.hook_email)) { const alt = vm(clean(card.hook_email).replace(/[.!]+$/, '')); if (words(alt) >= 115 && words(alt) <= 127) v = alt; }
    out.voicemail = v; out.voicemailWords = words(v);
  }
  if (/cell|mobile|personal/i.test(String(card.phone_type)) && known(card.phone) && parts.text) out.text = clean(parts.text);
  if (!hasEmail && parts.dm) out.dm = clean(parts.dm);
  return out;
}

// ------------------------------------------------------------------ QA (Part 6)
function qa(drafts, card, framing) {
  const fails = [];
  const all = [drafts.email?.subject, drafts.email?.body, drafts.followup, drafts.call, drafts.voicemail, drafts.text, drafts.dm].filter(Boolean).join('\n');
  if (/[—–]/.test(all)) fails.push('Dash found');
  const low = all.toLowerCase(); for (const b of BANNED) if (low.includes(b)) fails.push(`Banned phrase: "${b}"`);
  if (/\$\s?(549|949|1,?500|899|700|2,?750|4,?500|2,?000)\b|\b(per|a) month\b|https?:\/\/|www\.|\b[\w-]+\.(com|org|net)\b/i.test(all)) fails.push('Price, package or link in a first touch');
  if (framing === 'post-election' && /congrat/i.test(all)) fails.push('"Congrats" to someone not on the Nov 3 ballot');
  if (/my neighbors|i'm in rockville centre|i live in/i.test(all) && !/rockville centre/i.test(`${card.district_towns} ${card.office}`)) fails.push('Local claim ("my neighbors", "I\'m in Rockville Centre") only for RVC targets');
  if (drafts.email) {
    const body = drafts.email.body; const cnt = body.split(CRED).length - 1;
    if (cnt !== 1) fails.push(`Credibility line appears ${cnt} times in the email (must be once, verbatim)`);
    const bw = words(body); if (bw >= 120) fails.push(`Email body is ${bw} words (under 120)`);
    const sw = words(drafts.email.subject); if (!drafts.email.threadReply && (sw < 2 || sw > 4 || drafts.email.subject !== drafts.email.subject.toLowerCase())) fails.push('Subject must be 2 to 4 lowercase words');
  }
  if (drafts.voicemail) {
    const v = drafts.voicemail; const n = words(v);
    if (n < 115 || n > 127) fails.push(`Voicemail is ${n} words (115 to 127)`);
    if (!v.includes(YOUTH) || v.indexOf(YOUTH) < v.indexOf('is a great story')) fails.push('Youth line missing or before the congrats and hook');
    if ((v.match(/917-699-4151/g) || []).length !== 1 || !v.includes('nine one seven')) fails.push('Phone must be said twice');
    if (/sent a note to your email/.test(v) && (!known(card.email) || !v.trim().endsWith('I also sent a note to your email. Thanks.'))) fails.push('Email line only if an email exists, and only at the end');
  }
  if (drafts.call && drafts.call.indexOf(YOUTH) < 0) fails.push('Youth line missing from the live call');
  if (drafts.text && words(drafts.text) >= 40) fails.push('Text is 40+ words');
  if (drafts.dm && words(drafts.dm) >= 50) fails.push('DM is 50+ words');
  return fails;
}

// ------------------------------------------------------------------ one person, end to end
/**
 * Research, classify, tier, write and QA one prospect. Saves everything on prospect.kit. The first email goes to
 * Approvals only when the person is draftable now (winners and post-election officials, not HOLD, not only-if-win),
 * a real non-.gov email exists, and QA passed. Nothing is ever sent from here.
 */
async function draftFor(prospectId, { actor = 'user', h = { progress() {} }, refresh = false, queue = true } = {}) {
  let p = ctx.store.get('prospects', prospectId); if (!p) throw new Error('That prospect is gone.');
  const pre = classify(p);
  if (!pre.draft && pre.framing === 'exclude') return save(p, { framing: 'exclude', excluded: pre.reason, flags: [pre.reason === "Ryan's" ? "Ryan's: don't draft" : `Excluded: ${pre.reason}`], at: now() });
  const res = !refresh && p.kit?.research?.sources?.length && Date.now() - Date.parse(p.kit.research.at) < 7 * 864e5 ? p.kit.research : await gather(p, h);
  h.progress(0.7, 'Writing the research card');
  const card = await researchCard(p, res);
  const cls = classify(p, card);
  if (!cls.draft) return save(p, { research: res, card: { ...card, framing: cls.framing }, framing: cls.framing, flags: [...cls.flags, cls.reason].filter(Boolean), excluded: cls.framing === 'exclude' ? cls.reason : null, at: now() });
  const tr = tier(card, p);
  const prior = priorContact(p);
  const flags = [...cls.flags, ...tr.flags];
  if (prior.count >= 2) flags.push(`Already had ${prior.count} touches: one more max, in ${prior.ryan ? "Ryan's" : 'the existing'} thread or not at all`);
  else if (prior.count === 1) flags.push('Prior contact: send as a reply in the thread');
  if (prior.ryan) flags.push('In a thread Ryan started: coordinate with Ryan first (Ryan replies in his thread)');
  if (known(card.existing_vendors) && !/^none/i.test(card.existing_vendors)) flags.push(`Existing vendor: ${card.existing_vendors} (position us as video help, not a replacement)`);
  if (card.already_makes_short_video === true || /^true$/i.test(String(card.already_makes_short_video))) flags.push('Already makes short-form video: weak fit');
  if (card.email_verified === 'unverified') flags.push(`Unverified email (${card.email_source}): confirm it's printed on the campaign site or SEEC Form 1A, and that the domain resolves, before sending`);
  if (!known(card.email)) flags.push(card.email_note || 'No email: route by DM or phone');
  if (!known(card.hook_email)) flags.push('No sourced hook found: needs a fact by hand before any copy');
  h.progress(0.85, 'Writing the drafts');
  const parts = await writeParts(p, card, cls.framing, prior);
  const drafts = prior.count >= 2 ? { followup: compose(p, card, parts, cls.framing, prior).followup } : compose(p, card, parts, cls.framing, prior);
  const fails = qa(drafts, card, cls.framing);
  const kit = { research: res, card: { ...card, framing: cls.framing, tier: `$${tr.tier.toLocaleString('en-US')}`, tier_basis: tr.basis, prior_contact: prior.text, flags: flags.join('; ') }, framing: cls.framing, status: cls.status, tier: tr.tier, tierBasis: tr.basis, flags, drafts, qa: fails, by: parts.by, at: now() };
  if (drafts.email) kit.gmail = `https://mail.google.com/mail/?view=cm&fs=1${known(card.email) ? `&to=${encodeURIComponent(card.email)}` : ''}&su=${encodeURIComponent(drafts.email.subject)}&body=${encodeURIComponent(withFooter(drafts.email.body))}`;
  p = save(p, kit);
  // Into Approvals (a person decides; Ben can also copy it into Gmail and send by hand).
  const blocked = !queue ? 'not queued' : !drafts.email ? 'no email draft' : !known(card.email) ? 'no email address' : cls.framing === 'only-if-win' && p.electionResult !== 'won' ? 'contact only if they win' : fails.length ? 'QA failed' : excluded({ name: p.name, email: card.email, handle: p.handle }) ? 'on the exclusions list' : flags.some((f) => /TOO BROKE|HOLD|coordinate with Ryan/.test(f)) ? 'flagged' : null;
  if (!blocked) {
    const messaging = require('../automation/messaging');
    let contact = p.contactId ? ctx.store.get('contacts', p.contactId) : ctx.store.find('contacts', (x) => (x.emails || []).includes(card.email));
    if (!contact) contact = ctx.store.insert('contacts', { name: p.name, phones: [], emails: [card.email], role: 'prospect', clientId: null, optedOut: {}, source: 'political' });
    else if ((contact.emails || [])[0] !== card.email) contact = ctx.store.update('contacts', contact.id, { emails: [card.email, ...(contact.emails || []).filter((e) => e !== card.email && !isGov(e))] });
    if (contact.optedOut?.email) return save(p, { ...kit, queued: false, blocked: 'opted out' });
    if (p.kit?.messageId) { const old = ctx.store.get('messages', p.kit.messageId); if (old?.status === 'pending_approval') messaging.rejectMessage(old.id, actor); }
    const m = messaging.createOutbound({ contactId: contact.id, conversationId: drafts.email.threadReply ? prior.last?.conversationId : undefined, channel: 'email', subject: drafts.email.subject, body: withFooter(drafts.email.body), aiGenerated: true, agent: 'Outreach guide', category: 'prospecting', actor });
    ctx.store.update('prospects', p.id, { contactId: contact.id, ...(['new', undefined, null, ''].includes(p.stage) ? { stage: 'drafted' } : {}) });
    p = save(ctx.store.get('prospects', p.id), { ...kit, queued: true, messageId: m.id, blocked: null });
  } else p = save(p, { ...kit, queued: false, blocked });
  audit.log(actor, 'outreach.guide_drafted', { prospectId: p.id, name: p.name, framing: cls.framing, tier: tr.tier, queued: !!p.kit.queued });
  return p;
}
/** Saves the kit; an earlier draft still waiting in Approvals stays linked until a new one replaces it. */
function save(p, kit) {
  const cur = ctx.store.get('prospects', p.id) || p;
  const keep = cur.kit?.messageId && kit.messageId === undefined ? { messageId: cur.kit.messageId } : {};
  const out = ctx.store.update('prospects', p.id, { kit: { ...keep, ...kit } });
  require('../core/events').publish('prospects', { id: p.id });
  return out;
}

// ------------------------------------------------------------------ batch (Part 8)
const CERT = { win: 0, 'post-election': 1, 'only-if-win': 2 };
const routeRank = (c) => (c.email_verified === 'verified' ? 0 : known(c.email) ? 1 : 2);
/** Rank per 2.2: certainty they hold office, tier, hook strength, route quality, no existing vendor. */
function bestPicks(list, n = 5) {
  return list.filter((p) => p.kit?.drafts?.email || p.kit?.drafts?.voicemail).filter((p) => !(p.kit.flags || []).some((f) => /TOO BROKE|HOLD|Ryan/.test(f)))
    .sort((a, b) => (CERT[a.kit.framing] ?? 3) - (CERT[b.kit.framing] ?? 3) || (b.kit.tier || 0) - (a.kit.tier || 0) || nums(b.kit.card.hook_email).length - nums(a.kit.card.hook_email).length || routeRank(a.kit.card) - routeRank(b.kit.card) || (known(a.kit.card.existing_vendors) ? 1 : 0) - (known(b.kit.card.existing_vendors) ? 1 : 0)).slice(0, n);
}
const channelOf = (k) => (k.card?.email_verified === 'verified' ? 'email (verified)' : known(k.card?.email) ? 'email (verify first)' : k.drafts?.dm ? 'DM' : known(k.card?.phone) ? `phone (${k.card.phone_type})` : 'UNKNOWN');
function summary(list) {
  const counts = { drafted: 0, queued: 0, onlyIfWin: 0, notOnBallot: 0, hold: 0, excluded: {} };
  for (const p of list) {
    const k = p.kit || {}; if (k.framing === 'exclude') { counts.excluded[k.excluded || 'other'] = (counts.excluded[k.excluded || 'other'] || 0) + 1; continue; }
    if (k.framing === 'hold') { counts.hold++; continue; }
    if (k.drafts) counts.drafted++; if (k.queued) counts.queued++; if (k.framing === 'only-if-win') counts.onlyIfWin++; if (k.framing === 'post-election') counts.notOnBallot++;
  }
  const best = bestPicks(list).map((p) => ({ id: p.id, name: p.name, why: `${p.kit.framing === 'only-if-win' ? 'only if they win, ' : ''}$${p.kit.tier} tier, ${channelOf(p.kit)}; hook: ${String(p.kit.card.hook_email).slice(0, 110)}` }));
  const flags = list.flatMap((p) => (p.kit?.flags || []).filter((f) => !/^Excluded/.test(f)).map((f) => `${p.name}: ${f}`));
  const table = list.map((p) => ({ id: p.id, name: p.name, office: p.kit?.card?.office || p.office || '', tier: p.kit?.tier ? `$${p.kit.tier}` : '', channel: p.kit ? channelOf(p.kit) : '', status: p.kit?.framing === 'exclude' ? `excluded: ${p.kit.excluded}` : `${p.kit?.status || ''}${p.kit?.card?.odds && known(p.kit.card.odds) ? `, ${p.kit.card.odds}` : ''}` }));
  return { counts, best, flags, table };
}
function csv(list) {
  const esc = (v) => { const s = Array.isArray(v) ? v.join(' | ') : typeof v === 'object' && v ? JSON.stringify(v) : String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [CARD_KEYS.join(','), ...list.filter((p) => p.kit?.card).map((p) => CARD_KEYS.map((k) => esc(p.kit.card[k] ?? UNKNOWN)).join(','))].join('\r\n');
}

module.exports = { draftFor, classify, tier, qa, compose, summary, bestPicks, csv, isRyans, noDash, CRED, CRED_VM, YOUTH, BANNED, CARD_KEYS, SIGNER, PHONE };
