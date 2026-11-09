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

const STARTERS = [
  { name: 'Scout', emoji: '🔎', color: 'sky', role: 'Finds out anything on the live web: searches, reads the pages, and answers with the links.', instructions: 'Read at least two sources for anything important. Say when sources disagree. Lead with the answer, then the links.', computer: 'browser' },
  { name: 'Lead finder', emoji: '🗳️', color: 'coral', role: 'Researches politicians and campaigns for outreach: office, district, campaign website, the public campaign or press email, recent news and a good hook for a short video.', instructions: 'Only public, professional information: never home addresses or family details. Emails must be printed on the campaign\'s own site (never .gov). Check Euclidean\'s records first so we don\'t research someone twice, and write what you confirmed in the notebook.', computer: 'browser' },
  { name: 'Trend watcher', emoji: '📈', color: 'gold', role: 'Watches what is working in short-form video right now (TikTok, Reels, Shorts) and turns it into titles, hooks and ideas for our clients.', instructions: 'Use recent sources (this week or month). Give concrete examples with links, then 3 to 5 ideas we could make.', computer: 'browser' },
  { name: 'Builder', emoji: '🛠️', color: 'lav', role: 'Does hands-on work in its own Linux computer: writes and runs small scripts, collects data from websites into spreadsheets (CSV), checks files.', instructions: 'Explain what a command will do before running it. Save results as files in /work and say where they are.', computer: 'vm' },
];

const clean = (s, n) => String(s ?? '').replace(/\s+$/g, '').slice(0, n);
function sanitize(b, cur = {}) {
  const out = {};
  if (b.name !== undefined) out.name = clean(b.name, 40).trim() || cur.name || 'Bot';
  if (b.emoji !== undefined) out.emoji = clean(b.emoji, 8).trim() || '🤖';
  if (b.color !== undefined) out.color = ['sky', 'coral', 'gold', 'lav', 'moss', 'teal', 'rose'].includes(b.color) ? b.color : 'sky';
  if (b.role !== undefined) out.role = clean(b.role, 400);
  if (b.instructions !== undefined) out.instructions = clean(b.instructions, 4000);
  if (b.brain !== undefined) out.brain = BRAINS.includes(b.brain) ? b.brain : 'auto';
  if (b.computer !== undefined) out.computer = COMPUTERS.includes(b.computer) ? b.computer : 'browser';
  if (b.tools !== undefined) out.tools = { web: b.tools.web !== false, notebook: b.tools.notebook !== false, app: b.tools.app !== false, team: b.tools.team !== false };
  if (b.autoBrowse !== undefined) out.autoBrowse = !!b.autoBrowse;
  if (b.autoRun !== undefined) out.autoRun = !!b.autoRun;
  if (b.maxSteps !== undefined) out.maxSteps = Math.max(3, Math.min(30, Number(b.maxSteps) || 12));
  if (b.pinned !== undefined) out.pinned = !!b.pinned;
  return out;
}

/** The roster (made with the starter team the first time). */
function list() {
  if (!ctx.store.settings._botsV1) {
    if (!ctx.store.all('bots').length) STARTERS.forEach((s, i) => ctx.store.insert('bots', { ...sanitize({ brain: 'auto', tools: {}, ...s }), autoBrowse: false, autoRun: false, maxSteps: 12, order: i, createdAt: now() }));
    ctx.store.setSettings({ _botsV1: true });
  }
  return ctx.store.all('bots').sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || (a.order ?? 99) - (b.order ?? 99));
}
function findBot(nameOrId) {
  const k = String(nameOrId || '').toLowerCase().trim(); if (!k) return null;
  const all = list();
  return all.find((b) => b.id === nameOrId) || all.find((b) => b.name.toLowerCase() === k) || all.find((b) => b.name.toLowerCase().startsWith(k)) || all.find((b) => k.includes(b.name.toLowerCase())) || null;
}
function get(id) { return ctx.store.get('bots', id); }

function summary(b) {
  const last = ctx.store.all('botMessages', (m) => m.botId === b.id).slice(-1)[0] || null;
  const running = ctx.store.find(agent.RUNS, (r) => r.botId === b.id && ['working', 'waiting'].includes(r.status));
  return { ...b, last: last ? { role: last.role, text: String(last.text).slice(0, 120), at: last.at } : null, busy: running ? { status: running.status, note: running.note, runId: running.id } : null };
}

function create(b, actor = 'user') {
  const bot = ctx.store.insert('bots', { brain: 'auto', computer: 'browser', tools: { web: true, notebook: true, app: true, team: true }, autoBrowse: false, autoRun: false, maxSteps: 12, emoji: '🤖', color: 'sky', role: '', instructions: '', order: list().length, createdAt: now(), ...sanitize({ name: 'New bot', ...b }) });
  audit.log(actor, 'bot.created', { botId: bot.id, name: bot.name });
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

module.exports = { list, findBot, get, summary, create, update, remove, thread, send, decide, stop, clear, start, ask, BRAINS, COMPUTERS, STARTERS };
