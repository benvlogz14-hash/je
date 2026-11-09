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
- Live internet is free and unlimited through DuckDuckGo: research (search and read the pages), web_search, read_page, news. Cite the link for every fact.
- Other bots: ask_bot hands them a piece of work. The notebook (notebook_recall / notebook_learn) is what Euclidean has learned.
- Nothing you do sends, posts or schedules. Messages are drafts for Ben.`;
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
    instructions: () => `${promptRole('corbin.md')}\n\nAS THE MASTER BOT: for a big job, plan it, hand pieces to the other bots with ask_bot (one clear task each), check what comes back against the sources, and end with what Ben should do next in under 5 bullets.\n\n${IN_APP}\n\n${HOUSE}` },
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
  if (b.tools !== undefined) out.tools = { web: b.tools.web !== false, notebook: b.tools.notebook !== false, app: b.tools.app !== false, team: b.tools.team !== false, leads: !!b.tools.leads, clients: !!b.tools.clients };
  if (b.routines !== undefined) out.routines = (Array.isArray(b.routines) ? b.routines : []).filter((r) => r && String(r.task || '').trim()).slice(0, 10).map((r, i) => ({ id: String(r.id || `r${Date.now().toString(36)}${i}`).slice(0, 24), task: clean(r.task, 2000).trim(), every: ['hour', 'day', 'weekday', 'week'].includes(r.every) ? r.every : 'day', at: /^\d{1,2}:\d{2}$/.test(r.at || '') ? r.at : '08:00', day: Math.max(0, Math.min(6, Number(r.day) || 1)), on: r.on !== false, lastRun: r.lastRun || null }));
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
  return { ...b, last: last ? { role: last.role, text: String(last.text).slice(0, 120), at: last.at } : null, busy: running ? { status: running.status, note: running.note, runId: running.id } : null };
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
  const msgs = ctx.store.all('botMessages', (m) => m.botId === botId).slice(-limit);
  const runIds = new Set(msgs.map((m) => m.runId).filter(Boolean));
  const runs = Object.fromEntries(ctx.store.all(agent.RUNS, (r) => runIds.has(r.id)).map((r) => [r.id, { ...r, steps: (r.steps || []).map(({ forModel, ...s }) => s) }]));
  return { messages: msgs, runs };
}

/** The person writes to a bot: the message goes in the thread and the bot starts working on it. */
function send(botId, text, actor = 'user') {
  const bot = get(botId); if (!bot) throw new Error('No such bot.');
  const t = String(text || '').trim(); if (!t) throw new Error('Write something first.');
  const busy = ctx.store.find(agent.RUNS, (r) => r.botId === botId && ['working', 'waiting'].includes(r.status));
  if (busy) throw new Error(`${bot.name} is still working on your last message. Wait for it, or press Stop.`);
  const run = ctx.store.insert(agent.RUNS, { botId, question: t.slice(0, 8000), status: 'working', steps: [], by: actor, startedAt: now() });
  ctx.store.insert('botMessages', { botId, role: 'you', text: t.slice(0, 8000), runId: run.id, at: now(), by: actor });
  audit.log(actor, 'bot.asked', { botId, bot: bot.name, text: t.slice(0, 120) });
  prune(botId);
  setImmediate(() => agent.drive(run.id).catch(() => {}));
  return run;
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
  if (run.status === 'waiting') ctx.store.update(agent.RUNS, runId, { status: 'stopped', cancel: true, endedAt: now(), note: 'Stopped' });
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
}

/** Ask a bot and wait for its answer (HAL and other parts of the app). Resolves the answer text. */
async function ask(nameOrId, text, actor = 'hal') {
  const bot = findBot(nameOrId); if (!bot) throw new Error(`No bot called ${nameOrId}.`);
  const run = send(bot.id, text, actor);
  for (let i = 0; i < 600; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const r = ctx.store.get(agent.RUNS, run.id);
    if (!r || r.status === 'done') return { bot, answer: r?.answer || '', run: r };
    if (r.status === 'failed' || r.status === 'stopped') throw new Error(r.error || r.note || 'The bot stopped.');
    if (r.status === 'waiting') return { bot, answer: null, waiting: true, run: r };
  }
  return { bot, answer: null, run };
}

/**
 * Scheduled tasks (like Grok's tasks): each bot can have routines, e.g. "every weekday at 8:00, find officials sworn in
 * yesterday in NY and CT". Checked every minute by the scheduler; a routine runs only while the app is open, never
 * twice for the same time, and skips while the bot is still busy.
 */
function routinesTick(at = new Date()) {
  for (const b of ctx.store.all('bots')) {
    const rs = b.routines || []; if (!rs.length) continue;
    let changed = false;
    const next = rs.map((r) => {
      if (!r.on || !r.task) return r;
      const [hh, mm] = String(r.at || '08:00').split(':').map(Number);
      const due = new Date(at); due.setSeconds(0, 0);
      if (r.every === 'hour') due.setMinutes(mm); else due.setHours(hh, mm);
      if (due > at) return r;
      const dow = at.getDay();
      if (r.every === 'weekday' && (dow === 0 || dow === 6)) return r;
      if (r.every === 'week' && dow !== Number(r.day ?? 1)) return r;
      if (r.lastRun && new Date(r.lastRun) >= due) return r;
      if (at - due > (r.every === 'hour' ? 50 : 180) * 60000) return r; // missed while closed: wait for the next one
      if (ctx.store.find(agent.RUNS, (x) => x.botId === b.id && ['working', 'waiting'].includes(x.status))) return r;
      try { send(b.id, `(Scheduled task) ${r.task}`, 'routine'); } catch { return r; }
      changed = true; return { ...r, lastRun: at.toISOString() };
    });
    if (changed) ctx.store.update('bots', b.id, { routines: next });
  }
}

module.exports = { routinesTick, TEMPLATES, HOUSE, list, findBot, get, summary, create, update, remove, thread, send, decide, stop, clear, start, ask, BRAINS, COMPUTERS, STARTERS };
