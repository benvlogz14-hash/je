'use strict';
/**
 * Bots: Euclidean's own team of AI bots (sidebar "Bots", /bots). The GrokBot alternative, built into the app.
 *
 * Like a messaging app: each bot is a contact with its own name, job, instructions, brain (the free local Llama by
 * default, or Claude / GPT / Grok / your own AI account), thread, and computer (a walled-off browser in the desktop
 * app, or its own Linux virtual machine through Docker). Bots look things up on the live web for free (DuckDuckGo,
 * no key), read pages, use the shared notebook and Euclidean's records, hand work to each other, and ask before
 * anything that acts on the world. They never send, post or change records (the house rules).
 *
 * Collections: `bots` (the roster), `botMessages` (threads, last 400 per bot), `botRuns` (each turn with its steps,
 * last 300). Ideas from OpenMausBot (https://github.com/milind-soni/OpenMausBot, Apache 2.0: a roster of agent
 * contacts, each with its own model and computer, permission cards); the code is Euclidean's own.
 */
const ctx = require('../core/ctx');
const events = require('../core/events');
const audit = require('../core/audit');
const { now } = require('../core/util');
const agent = require('./agent');

const BRAINS = ['auto', 'ollama', 'anthropic', 'openai', 'xai', 'bridge'];
const COMPUTERS = ['none', 'browser', 'vm'];

// The team every install starts with (Ryan, Nov 9: "a master bot, a client bot, and a scouting bot with the ability to
// add more bots"). Templates are the ready-made bots in New bot. `kind` only picks the default tools.
const HOUSE = 'House rules: no em dashes or en dashes. Public, professional information only: never home addresses or family details. Never invent a number, name, email or quote: if you could not confirm it with a link, say UNKNOWN. Prefer campaign emails over official .gov ones for anything about paid work. You draft; Ben and Ryan send.';
const IN_APP = `HOW THIS WORKS INSIDE EUCLIDEAN (the app replaced Grok Bot; you now run here):
- Your lists, call sheets, winners lists, research packs and briefs are in the Data tab: data_search finds people and passages, data_read opens a list. Save anything you build (a call sheet, a list, a research table) with data_save so the founders see it there.
- The leads board: lead_lookup before researching anyone; propose_leads to add confirmed people (they wait for a founder's OK); draft_outreach runs the outreach guide for a lead (drafts only).
- Live internet: DuckDuckGo is free and unlimited (research, web_search, read_page, news): use it first for quick facts and summaries. google_search (Google through Serper, about a tenth of a cent each, cached) is for a full inquiry when DuckDuckGo comes back thin. Never repeat a search you already did. Cite the link for every fact.
- Videos and ads: find_videos lists a politician's public videos from Google's Videos tab (floor sessions, hearings, council meetings, interviews); make_ads starts the ad machine for leads on our board, hands-off (it finds and downloads their videos itself, cuts the ads, makes the one-pager and drafts the email in Approvals).
- Other bots: ask_bot hands them a piece of work. HAL: ask_hal talks to him in his chat (news watch, calendar, commands, the outreach kit). Claude: ask_claude asks the founders' Claude; if it isn't open, the answer comes back to your chat later and you carry on. The notebook (notebook_recall / notebook_learn) is what Euclidean has learned.
- Email: email_inbox / email_read / email_check read the outreach mailbox; email_draft writes a draft (it waits in Approvals); attach_document puts a PDF or Word file on a waiting draft.
- Documents: make_document writes playbooks, plans, briefs, proposals and reports as a designed PDF + Word file; revise_document changes one from a note; build_call_list makes a checked call sheet; contact_book shows everyone we reached and what came back.
- Your GrokBot: ask_grokbot emails a hard research question to the founders' GrokBot; its answer comes back to your chat. Use your own tools first; GrokBot questions are limited each week.
- Scheduled tasks: schedule_task adds your own tasks (every N minutes or hours, daily, weekdays, weekly, or at set times) for scrapes, briefs and news checks.
- Nothing you do sends or posts. Messages are drafts for Ben.`;
// Each starter bot's own job comes from its GrokBot master prompt (server/bots/seed/*.md), the part before the data.
function promptRole(file) {
  try {
    const t = require('fs').readFileSync(require('path').join(__dirname, 'seed', file), 'utf8');
    const cut = t.search(/^(=====|# EMBEDDED DATA)/m);
    return (cut > 0 ? t.slice(0, cut) : t.slice(0, 9000)).split('\n').filter((l) => !/^Paste this entire file/i.test(l)).join('\n')
      .replace(/Grok Bot usage is nearly exhausted[^.]*\.\s*/gi, '').replace(/Usage on Grok Bot is nearly exhausted[^.]*\.\s*/gi, '').replace(/Do (\w[\w ]*)'s job until then\.?/g, '').trim();
  } catch { return ''; }
}
const TEMPLATES = {
  master: { kind: 'master', name: 'Corbin', emoji: '🧠', color: 'lav', computer: 'browser', tools: { web: true, notebook: true, app: true, team: true, leads: true, clients: true }, maxSteps: 20,
    role: 'Master bot (team lead and ops): runs the daily plan, keeps Ben pointed at the next call, email and video, builds call sheets and winners lists, fact-checks every hook, and hands work to Juno, Scout and Data Bot.',
    instructions: () => `${promptRole('corbin.md')}\n\nAS THE MASTER BOT: for video picks, find_videos to check each one has usable public footage, then make_ads for the picks. For a big job, plan it, hand pieces to the other bots with ask_bot (one clear task each), check what comes back against the sources, and end with what Ben should do next in under 5 bullets.\n\n${IN_APP}\n\n${HOUSE}` },
  client: { kind: 'client', name: 'Juno', emoji: '🤝', color: 'teal', computer: 'browser', tools: { web: true, notebook: true, app: true, team: true, clients: true, leads: true }, maxSteps: 16,
    role: 'Client bot: drafts first-touch emails, voicemails and DMs and the follow-ups, scores fit and pay, suggests the package, and owns creator/YouTube clients and prospects (Stringer model). Knows each client\'s file.',
    instructions: () => `${promptRole('juno.md')}\n\nFor a current client, open their file first (client_overview) and follow their voice and "never" list.\n\n${IN_APP}\n\n${HOUSE}` },
  scout: { kind: 'scout', name: 'Scout', emoji: '🔎', color: 'coral', computer: 'browser', tools: { web: true, notebook: true, app: true, team: true, leads: true }, maxSteps: 18,
    role: 'Scouting bot: finds and researches new leads (low-level local Democrats who won or hold office in CT, NY, MA, RI, NJ, and creators with weak Shorts), with verified contacts and a sharp hook, and proposes them for New prospects.',
    instructions: () => `Scouting brief (from Juno's master prompt): research only, never contact anyone. Ideal political targets: state reps and senators, small-town mayors and first selectmen, council members and alders, school boards, registrars; incumbents or winners; Connecticut first, then NY, MA, RI, NJ. NEVER governors, Congress, US senators, big-city mayors or party committees. Ideal creators: active long-form with weak or missing Shorts, roughly 10K to 1M subs, urbex/exploration, true crime, commentary, political/news commentary.\nNever include: Silent Hills Urbex, Urbex Ontario, Isaiah Martin, Stringer Media, Paula Kay, Republicans, Holstein, Pepper-Macias, Joey. Anyone too broke (under about $3K raised and no wealth signal): drop.\nFor each person:\n1. lead_lookup and data_search first: skip anyone already on our board or in our lists (say so).\n2. Research: office and district, 2026 result (multistate.us, NYS BOE), party, money raised (state filings, SEEC for CT) with the number and link, the campaign email printed on their own site (government emails only in the official_email column), Instagram handle with rough followers and whether it's active, phones (campaign, district, Albany), and ONE verified hook. Watch for a predecessor's record credited to the new member.\n3. Score fit_score and pay_score 1 to 5, suggested package ($949 political; $1,500 only with $10K+ of their own money in filings; creators $1,200 Stringer model), one-line pitch angle.\n4. Save the table with data_save (Juno's CSV columns: type, name, office_or_channel, state, why_incumbent_or_likely_winner, public_contact, ig_handle, ig_active, ig_followers_approx, business_email, source_url, fit_score, pay_score, suggested_package, pitch_angle, official_email, campaign_site, race_status_2026), then propose_leads for the ones worth pitching, and write each confirmed fact in the notebook.\nLean output: top 10 at most, plus "Ready for Ben to approve".\n\n${IN_APP}\n\n${HOUSE}` },
  data: { kind: 'custom', name: 'Data Bot', emoji: '📊', color: 'gold', computer: 'browser', tools: { web: true, notebook: true, app: true, team: true, leads: true, clients: true }, maxSteps: 14,
    role: 'Data and sales materials: keeps the Data tab clean (parses new lists into tables and leads), and builds pitch decks, one-pagers, case studies, pricing leave-behinds and per-prospect pitch packs with Ben-approved numbers.',
    instructions: () => `${promptRole('databot.md')}\n\nIN THE DATA TAB: when someone hands you a list, page or file, read it (data_read), clean it into a table (name, office, status, email, phones, hook, source) and save it with data_save; say who is new versus already on our board (lead_lookup).\n\n${IN_APP}\n\n${HOUSE}` },
  research: { kind: 'custom', name: 'Researcher', emoji: '📚', color: 'sky', computer: 'browser', tools: { web: true, notebook: true, app: true, team: true },
    role: 'Finds out anything on the live web: searches, reads the pages, and answers with the links.', instructions: `Read at least two sources for anything important. Say when sources disagree. Lead with the answer, then the links.\n${HOUSE}` },
  trends: { kind: 'custom', name: 'Trend watcher', emoji: '📈', color: 'gold', computer: 'browser', tools: { web: true, notebook: true, app: true, team: true, clients: true },
    role: 'Watches what is working in short-form video right now (TikTok, Reels, Shorts) and turns it into titles, hooks and ideas for our clients.', instructions: `Use recent sources (this week or month). Give concrete examples with links, then 3 to 5 ideas we could make.\n${HOUSE}` },
  builder: { kind: 'custom', name: 'Builder', emoji: '🛠️', color: 'moss', computer: 'vm', tools: { web: true, notebook: true, app: true, team: true },
    role: 'Does hands-on work in its own Linux computer: writes and runs small scripts, collects data from websites into spreadsheets (CSV), checks files.', instructions: 'Explain what a command will do before running it. Save results as files in /work and say where they are.' },
  blank: { kind: 'custom', name: 'New bot', emoji: '🤖', color: 'sky', computer: 'browser', tools: { web: true, notebook: true, app: true, team: true }, role: '', instructions: '' },
};
const STARTERS = ['master', 'client', 'scout', 'data'];

const clean = (s, n) => String(s ?? '').replace(/\s+$/g, '').slice(0, n);
function sanitize(b, cur = {}) {
  const out = {};
  if (b.name !== undefined) out.name = clean(b.name, 40).trim() || cur.name || 'Bot';
  if (b.emoji !== undefined) out.emoji = clean(b.emoji, 8).trim() || '🤖';
  if (b.color !== undefined) out.color = ['sky', 'coral', 'gold', 'lav', 'moss', 'teal', 'rose'].includes(b.color) ? b.color : 'sky';
  if (b.role !== undefined) out.role = clean(b.role, 400);
  if (b.instructions !== undefined) out.instructions = clean(b.instructions, 20000);
  if (b.kind !== undefined) out.kind = ['master', 'client', 'scout', 'custom'].includes(b.kind) ? b.kind : 'custom';
  if (b.brain !== undefined) out.brain = BRAINS.includes(b.brain) ? b.brain : 'auto';
  if (b.computer !== undefined) out.computer = COMPUTERS.includes(b.computer) ? b.computer : 'browser';
  if (b.tools !== undefined) out.tools = { web: b.tools.web !== false, notebook: b.tools.notebook !== false, app: b.tools.app !== false, team: b.tools.team !== false, leads: !!b.tools.leads, clients: !!b.tools.clients, email: b.tools.email !== false, docs: b.tools.docs !== false, schedule: b.tools.schedule !== false };
  if (b.routines !== undefined) out.routines = cleanRoutines(b.routines);
  if (b.schedulesOn !== undefined) out.schedulesOn = b.schedulesOn !== false;
  if (b.grokAuto !== undefined) out.grokAuto = !!b.grokAuto;
  if (b.autoBrowse !== undefined) out.autoBrowse = !!b.autoBrowse;
  if (b.autoRun !== undefined) out.autoRun = !!b.autoRun;
  if (b.maxSteps !== undefined) out.maxSteps = Math.max(3, Math.min(30, Number(b.maxSteps) || 12));
  if (b.pinned !== undefined) out.pinned = !!b.pinned;
  return out;
}

const fromTemplate = (key, extra = {}) => { const t0 = TEMPLATES[key] || TEMPLATES.blank; const t = { ...t0, instructions: typeof t0.instructions === 'function' ? t0.instructions() : t0.instructions }; return { ...sanitize({ brain: 'auto', ...t, ...extra }), template: key, autoBrowse: false, autoRun: false, maxSteps: t.maxSteps || 12, routines: [], createdAt: now() }; };

/**
 * The roster. First time: the starter team (Master, Client, Scout). Installs that got the first team (Scout,
 * Lead finder, Trend watcher, Builder) get Master and Client added, and their web-research Scout becomes the
 * scouting bot (_botsV2); the others stay as extra bots.
 */
function list() {
  if (!ctx.store.settings._botsV2) {
    const have = ctx.store.all('bots');
    if (!have.length) STARTERS.forEach((k, i) => ctx.store.insert('bots', { ...fromTemplate(k), order: i }));
    else {
      const oldScout = have.find((b) => b.name === 'Scout' && !b.kind && /^Finds out anything on the live web/.test(b.role || ''));
      if (oldScout) { const { order, routines, createdAt, ...t } = fromTemplate('scout'); ctx.store.update('bots', oldScout.id, { ...t, order: 2 }); }
      if (!have.some((b) => b.kind === 'master')) ctx.store.insert('bots', { ...fromTemplate('master'), order: 0 });
      if (!have.some((b) => b.kind === 'client')) ctx.store.insert('bots', { ...fromTemplate('client'), order: 1 });
      if (!oldScout && !have.some((b) => b.kind === 'scout')) ctx.store.insert('bots', { ...fromTemplate('scout'), order: 2 });
      if (!have.some((b) => b.template === 'data')) ctx.store.insert('bots', { ...fromTemplate('data'), order: 3 });
      for (const b of have) if (b.id !== oldScout?.id && (b.order ?? 0) < 4) ctx.store.update('bots', b.id, { order: (b.order ?? 0) + 4 });
    }
    ctx.store.setSettings({ _botsV1: true, _botsV2: true });
  }
  return ctx.store.all('bots').sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || (a.order ?? 99) - (b.order ?? 99));
}
function findBot(nameOrId) {
  const k = String(nameOrId || '').toLowerCase().trim(); if (!k) return null;
  const all = list();
  const byKind = { master: 'master', client: 'client', scout: 'scout', scouting: 'scout' }[k.replace(/\s*bot$/, '')];
  return all.find((b) => b.id === nameOrId) || all.find((b) => b.name.toLowerCase() === k) || (byKind && all.find((b) => b.kind === byKind)) || all.find((b) => b.name.toLowerCase().startsWith(k)) || all.find((b) => k.includes(b.name.toLowerCase())) || null;
}
function get(id) { return ctx.store.get('bots', id); }

function summary(b) {
  const last = ctx.store.all('botMessages', (m) => m.botId === b.id).slice(-1)[0] || null;
  const running = ctx.store.find(agent.RUNS, (r) => r.botId === b.id && ['working', 'waiting'].includes(r.status));
  return { ...b, last: last ? { role: last.role, text: String(last.text).slice(0, 120), at: last.at } : null, busy: running ? { status: running.status, note: running.note, runId: running.id } : null, queued: queued(b.id).length };
}

/**
 * A new bot: from a template (master, client, scout, research, trends, builder, blank), and/or from a pasted master
 * prompt (a GrokBot's or any other): the prompt becomes its instructions, and its name and job are read from it
 * ("You are X, ..." / a first heading) unless given.
 */
function create(b, actor = 'user') {
  // Only the prompt's own instructions: embedded lists ("===== BEGIN ..." blocks) belong in the Data tab.
  let prompt = String(b.masterPrompt || '').trim(); { const cut = prompt.search(/^(=====|# EMBEDDED DATA)/m); if (cut > 200) prompt = prompt.slice(0, cut).trim(); }
  prompt = prompt.split('\n').filter((l) => !/^Paste this entire file/i.test(l)).join('\n');
  const base = fromTemplate(TEMPLATES[b.template] ? b.template : 'blank');
  const extra = {};
  if (prompt) {
    const named = /^#\s*([A-Z][A-Za-z ]{1,30}?)\s+MASTER PROMPT/m.exec(prompt) || /\byou are\s+(?:called\s+|named\s+)?["“]?([A-Z][\w'’-]*(?:\s+[A-Z][\w'’-]*){0,3})["”]?/.exec(prompt) || /^#+\s*(.{2,40})$/m.exec(prompt) || /^name\s*:\s*(.{2,40})$/im.exec(prompt);
    if (named && !b.name) extra.name = named[1].replace(/[,.:;]+$/, '').trim().replace(/\b([A-Z])([A-Z]+)\b/g, (m, x, y) => x + y.toLowerCase());
    const job = /\b(?:your (?:job|role|purpose|mission) is|you (?:help|are responsible for))\s+([^.\n]{10,300})/i.exec(prompt);
    if (job && !b.role) extra.role = job[1].trim().replace(/^to\s+/i, '').replace(/^./, (c) => c.toUpperCase());
    extra.instructions = `${prompt}\n\n${IN_APP}\n\n${HOUSE}`;
    if (/\b(lead|prospect|candidate|politic|scout|campaign)/i.test(prompt)) extra.tools = { ...base.tools, leads: true };
    if (/\bclient/i.test(prompt)) extra.tools = { ...(extra.tools || base.tools), clients: true };
  }
  const bot = ctx.store.insert('bots', { ...base, order: list().length, ...sanitize({ ...extra, ...Object.fromEntries(Object.entries(b).filter(([k, v]) => v !== undefined && v !== '' && !['template', 'masterPrompt'].includes(k))) }) });
  audit.log(actor, 'bot.created', { botId: bot.id, name: bot.name, template: b.template || null, fromPrompt: !!prompt });
  events.publish('bots', { botId: bot.id });
  return bot;
}
function update(id, b, actor = 'user') {
  const cur = get(id); if (!cur) throw new Error('No such bot.');
  const bot = ctx.store.update('bots', id, sanitize(b, cur));
  audit.log(actor, 'bot.updated', { botId: id, name: bot.name });
  events.publish('bots', { botId: id });
  return bot;
}
function remove(id, actor = 'user') {
  const cur = get(id); if (!cur) return { ok: true };
  for (const r of ctx.store.all(agent.RUNS, (x) => x.botId === id)) ctx.store.remove(agent.RUNS, r.id);
  for (const m of ctx.store.all('botMessages', (x) => x.botId === id)) ctx.store.remove('botMessages', m.id);
  ctx.store.remove('bots', id);
  try { ctx.botBrowser?.close(id); } catch { /* none open */ }
  require('./computer').reset(id).catch(() => {});
  audit.log(actor, 'bot.deleted', { name: cur.name });
  events.publish('bots', { botId: id });
  return { ok: true };
}

/** The thread with its runs (steps) attached to the person's messages. */
function thread(botId, limit = 120) {
  // In the order things happened (a queued message moves to when it was actually sent), waiting ones at the end.
  const msgs = ctx.store.all('botMessages', (m) => m.botId === botId).sort((a, b) => (a.queued ? 1 : 0) - (b.queued ? 1 : 0) || String(a.at).localeCompare(String(b.at))).slice(-limit);
  const runIds = new Set(msgs.map((m) => m.runId).filter(Boolean));
  const runs = Object.fromEntries(ctx.store.all(agent.RUNS, (r) => runIds.has(r.id)).map((r) => [r.id, { ...r, steps: (r.steps || []).map(({ forModel, ...s }) => s) }]));
  return { messages: msgs, runs };
}

/** The person writes to a bot: the message goes in the thread and the bot starts working on it. */
/**
 * Someone answered a bot's question (Claude through the inbox): their answer shows in the bot's chat, and when the bot
 * isn't busy it picks the job back up with that answer. Returns the run, or null when it only left the message.
 */
function deliver(botId, question, answer, from = 'Claude') {
  const bot = get(botId); if (!bot) return null;
  const busy = ctx.store.find(agent.RUNS, (r) => r.botId === botId && ['working', 'waiting'].includes(r.status));
  return send(botId, `${from} answered your question "${String(question).slice(0, 400)}":\n${String(answer).slice(0, 6000)}\n\nCarry on with the job that needed this, then answer.`, 'claude', { role: 'claude', shown: String(answer).slice(0, 8000), from });
}

function send(botId, text, actor = 'user', { role = 'you', shown = null, from = null, focus = null } = {}) {
  const bot = get(botId); if (!bot) throw new Error('No such bot.');
  const t = String(text || '').trim(); if (!t) throw new Error('Write something first.');
  // Busy (working, or waiting for an Allow card): the message waits in line and goes next, in the order sent.
  const busy = ctx.store.find(agent.RUNS, (r) => r.botId === botId && ['working', 'waiting'].includes(r.status));
  if (busy || queued(botId).length) {
    const m = ctx.store.insert('botMessages', { botId, role, text: (shown ?? t).slice(0, 8000), question: t.slice(0, 8000), queued: true, at: now(), by: actor, ...(from ? { from } : {}), ...(focus ? { focus: String(focus).slice(0, 4000) } : {}) });
    events.publish('bots', { botId });
    if (!busy) setImmediate(() => next(botId));
    return { queued: true, messageId: m.id, ahead: queued(botId).length - 1 };
  }
  const run = ctx.store.insert(agent.RUNS, { botId, question: t.slice(0, 8000), ...(focus ? { focus: String(focus).slice(0, 4000) } : {}), status: 'working', steps: [], by: actor, startedAt: now() });
  ctx.store.insert('botMessages', { botId, role, text: (shown ?? t).slice(0, 8000), runId: run.id, at: now(), by: actor, ...(from ? { from } : {}) });
  audit.log(actor, 'bot.asked', { botId, bot: bot.name, text: t.slice(0, 120) });
  prune(botId);
  setImmediate(() => agent.drive(run.id).catch(() => {}));
  return run;
}

const queued = (botId) => ctx.store.all('botMessages', (m) => m.botId === botId && m.queued);
/** Start the oldest queued message once the bot is free (called when a run ends, is stopped, or the app starts). */
function next(botId) {
  if (ctx.store.find(agent.RUNS, (r) => r.botId === botId && ['working', 'waiting'].includes(r.status))) return null;
  const m = queued(botId)[0]; if (!m) return null;
  const run = ctx.store.insert(agent.RUNS, { botId, question: m.question || m.text, ...(m.focus ? { focus: m.focus } : {}), status: 'working', steps: [], by: m.by, startedAt: now() });
  ctx.store.update('botMessages', m.id, { queued: false, runId: run.id, at: now() });
  audit.log(m.by || 'user', 'bot.asked', { botId, text: String(m.question || m.text).slice(0, 120), fromQueue: true });
  events.publish('bots', { botId, runId: run.id });
  setImmediate(() => agent.drive(run.id).catch(() => {}));
  return run;
}
/** Take a message out of the line before it's sent. */
function unqueue(messageId) {
  const m = ctx.store.get('botMessages', messageId);
  if (!m || !m.queued) throw new Error('That message already went to the bot.');
  ctx.store.remove('botMessages', messageId); events.publish('bots', { botId: m.botId });
  return { ok: true };
}

/** Allow or deny the step a run is waiting on. */
function decide(runId, allow, actor = 'user') {
  const run = ctx.store.get(agent.RUNS, runId); if (!run) throw new Error('That request is gone.');
  if (run.status !== 'waiting') throw new Error('Nothing is waiting for an answer here.');
  const steps = (run.steps || []).map((s) => (s.waiting && s.allowed === undefined ? { ...s, allowed: !!allow, decidedBy: actor } : s));
  ctx.store.update(agent.RUNS, runId, { steps, status: 'working' });
  const step = steps.find((s) => s.waiting);
  audit.log(actor, allow ? 'bot.allowed' : 'bot.denied', { runId, tool: step?.tool, args: JSON.stringify(step?.args || {}).slice(0, 300) });
  setImmediate(() => agent.drive(runId).catch(() => {}));
  return { ok: true };
}

function stop(runId, actor = 'user') {
  const run = ctx.store.get(agent.RUNS, runId); if (!run) return { ok: true };
  if (run.status === 'waiting') { ctx.store.update(agent.RUNS, runId, { status: 'stopped', cancel: true, endedAt: now(), note: 'Stopped' }); setImmediate(() => next(run.botId)); }
  else ctx.store.update(agent.RUNS, runId, { cancel: true, note: 'Stopping…' });
  audit.log(actor, 'bot.stopped', { runId });
  events.publish('bots', { botId: run.botId, runId });
  return { ok: true };
}

function clear(botId) {
  for (const m of ctx.store.all('botMessages', (x) => x.botId === botId)) ctx.store.remove('botMessages', m.id);
  for (const r of ctx.store.all(agent.RUNS, (x) => x.botId === botId && !['working', 'waiting'].includes(x.status))) ctx.store.remove(agent.RUNS, r.id);
  events.publish('bots', { botId });
  return { ok: true };
}

function prune(botId) {
  const msgs = ctx.store.all('botMessages', (m) => m.botId === botId);
  for (const m of msgs.slice(0, Math.max(0, msgs.length - 400))) ctx.store.remove('botMessages', m.id);
  const runs = ctx.store.all(agent.RUNS);
  for (const r of runs.slice(0, Math.max(0, runs.length - 300))) if (!['working', 'waiting'].includes(r.status)) ctx.store.remove(agent.RUNS, r.id);
}

/** At start: turns that were mid-way when the app closed are marked stopped (waiting ones keep their card). */
function start() {
  for (const r of ctx.store.all(agent.RUNS, (x) => x.status === 'working')) {
    ctx.store.update(agent.RUNS, r.id, { status: 'stopped', endedAt: now(), note: 'Euclidean was closed while this was running. Send it again.', steps: (r.steps || []).map((s) => ({ ...s, running: false })) });
  }
  // Messages still in line when the app closed go out now.
  setTimeout(() => { for (const b of ctx.store.all('bots')) { try { next(b.id); } catch { /* next bot */ } } }, 3000);
}

/** Ask a bot and wait for its answer (HAL and other parts of the app). Resolves the answer text. */
async function ask(nameOrId, text, actor = 'hal', opts = {}) {
  const bot = findBot(nameOrId); if (!bot) throw new Error(`No bot called ${nameOrId}.`);
  const sent = send(bot.id, text, actor, opts);
  let runId = sent.queued ? null : sent.id;
  for (let i = 0; i < 900; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    if (!runId) { const m = ctx.store.get('botMessages', sent.messageId); if (!m) throw new Error('The message was taken out of the line.'); runId = m.runId || null; if (!runId) continue; }
    const r = ctx.store.get(agent.RUNS, runId);
    if (!r || r.status === 'done') return { bot, answer: r?.answer || '', run: r };
    if (r.status === 'failed' || r.status === 'stopped') throw new Error(r.error || r.note || 'The bot stopped.');
    if (r.status === 'waiting') return { bot, answer: null, waiting: true, run: r };
  }
  return { bot, answer: null, run: runId ? ctx.store.get(agent.RUNS, runId) : null };
}

/**
 * Scheduled tasks (like Grok's tasks): each bot can have routines, e.g. "every weekday at 8:00, find officials sworn in
 * yesterday in NY and CT". Checked every minute by the scheduler; a routine runs only while the app is open, never
 * twice for the same time, and skips while the bot is still busy.
 */
/**
 * Scheduled tasks: every N minutes / every N hours (from a start time), every day / weekday / week at a time, or at
 * several set times each day (`times`). `on` per task; the bot's Auto-run switch (`schedulesOn`) and the all-bots
 * switch (`bots.autoRun`) pause them all without touching the bot itself (you can still chat with it).
 */
const EVERY = ['minutes', 'hours', 'hour', 'day', 'weekday', 'week', 'times'];
const HHMM = /^([01]?\d|2[0-3]):[0-5]\d$/;
function cleanRoutines(list) {
  return (Array.isArray(list) ? list : []).filter((r) => r && String(r.task || '').trim()).slice(0, 20).map((r, i) => {
    const every = EVERY.includes(r.every) ? r.every : 'day';
    return {
      id: String(r.id || `r${Date.now().toString(36)}${i}`).slice(0, 24), task: clean(r.task, 2000).trim(), every,
      at: HHMM.test(r.at || '') ? r.at : '08:00', day: Math.max(0, Math.min(6, Number(r.day ?? 1) || 0)),
      ...(every === 'minutes' ? { minutes: Math.max(10, Math.min(1440, Math.round(Number(r.minutes) || 60))) } : {}),
      ...(every === 'hours' ? { hours: Math.max(1, Math.min(24, Math.round(Number(r.hours) || 2))) } : {}),
      ...(every === 'times' ? { times: [...new Set((Array.isArray(r.times) ? r.times : String(r.times || '').split(/[,\s]+/)).filter((x) => HHMM.test(x)))].sort().slice(0, 12) } : {}),
      ...(Array.isArray(r.days) ? { days: r.days.map(Number).filter((d) => d >= 0 && d <= 6) } : {}),
      on: r.on !== false, lastRun: r.lastRun || null, by: r.by ? clean(r.by, 60) : undefined,
    };
  });
}
/** When this task last should have run, at or before `at` (null = not due on this day). */
function dueAt(r, at) {
  const due = new Date(at); due.setSeconds(0, 0);
  const [hh, mm] = String(r.at || '08:00').split(':').map(Number);
  const dow = at.getDay();
  if (Array.isArray(r.days) && r.days.length && !r.days.includes(dow)) return null;
  if (r.every === 'minutes' || r.every === 'hours') {
    const step = (r.every === 'minutes' ? r.minutes || 60 : (r.hours || 2) * 60) * 60000;
    const start = new Date(at); start.setHours(hh, mm, 0, 0); if (start > at) start.setDate(start.getDate() - 1);
    return new Date(start.getTime() + Math.floor((at - start) / step) * step);
  }
  if (r.every === 'times') { const ts = (r.times || []).map((t) => { const d = new Date(due); const [h, m] = t.split(':').map(Number); d.setHours(h, m); return d; }).filter((d) => d <= at); return ts.length ? ts[ts.length - 1] : null; }
  if (r.every === 'hour') due.setMinutes(mm); else due.setHours(hh, mm);
  if (due > at) return null;
  if (r.every === 'weekday' && (dow === 0 || dow === 6)) return null;
  if (r.every === 'week' && dow !== Number(r.day ?? 1)) return null;
  return due;
}
/** The next time a task will run (for the page and the bots' own answers). */
function nextRun(r, from = new Date()) {
  for (let m = 1; m <= 8 * 24 * 60; m += m < 180 ? 1 : 15) { const t = new Date(from.getTime() + m * 60000); const d = dueAt(r, t); if (d && d > from && (!r.lastRun || d > new Date(r.lastRun))) return d.toISOString(); }
  return null;
}
function describe(r) {
  const D = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const days = Array.isArray(r.days) && r.days.length ? ` on ${r.days.map((d) => D[d]).join(', ')}` : '';
  return r.every === 'minutes' ? `every ${r.minutes} minutes${days}` : r.every === 'hours' ? `every ${r.hours} hours from ${r.at}${days}` : r.every === 'times' ? `each day at ${(r.times || []).join(', ')}${days}` : r.every === 'hour' ? `every hour at :${String(r.at).split(':')[1]}` : r.every === 'weekday' ? `weekdays at ${r.at}` : r.every === 'week' ? `${D[r.day ?? 1]}s at ${r.at}` : `every day at ${r.at}${days}`;
}
const autoRunOn = (b) => b.schedulesOn !== false && ctx.setting('bots.autoRun', true) !== false;

function routinesTick(at = new Date()) {
  for (const b of ctx.store.all('bots')) {
    const rs = b.routines || []; if (!rs.length || !autoRunOn(b)) continue;
    let changed = false;
    const next = rs.map((r) => {
      if (!r.on || !r.task) return r;
      const due = dueAt(r, at); if (!due) return r;
      if (r.lastRun && new Date(r.lastRun) >= due) return r;
      const slack = r.every === 'minutes' ? Math.min(r.minutes || 60, 30) : r.every === 'hours' || r.every === 'hour' ? 50 : r.every === 'times' ? 60 : 180;
      if (at - due > slack * 60000) return r; // missed while closed: wait for the next one
      if (ctx.store.find(agent.RUNS, (x) => x.botId === b.id && ['working', 'waiting'].includes(x.status))) return r;
      try { send(b.id, `(Scheduled task) ${r.task}`, 'routine'); } catch { return r; }
      changed = true; return { ...r, lastRun: at.toISOString() };
    });
    if (changed) ctx.store.update('bots', b.id, { routines: next });
  }
}

module.exports = { cleanRoutines, dueAt, nextRun, describe, autoRunOn, next, unqueue, queued, deliver, routinesTick, TEMPLATES, HOUSE, list, findBot, get, summary, create, update, remove, thread, send, decide, stop, clear, start, ask, BRAINS, COMPUTERS, STARTERS };
