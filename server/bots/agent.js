'use strict';
/**
 * A bot's turn: think → use one tool → look at the result → … → answer.
 *
 * Works with any brain (the free local Llama, Claude, GPT, Grok, or your own AI account) because it needs no special
 * "tool calling" support: every reply is one small JSON object, either {"say", "tool", "args"} or {"answer"}.
 * Each step is saved on the run (`botRuns`) and pushed to the page live, so you watch the bot search, read, click
 * and run things. A step that needs a person (clicking/typing on a site, running a command in its computer, unless
 * the bot is allowed to on its own) stops the run as "waiting" with an Allow / Deny card; the answer picks it back up.
 */
const ctx = require('../core/ctx');
const events = require('../core/events');
const audit = require('../core/audit');
const { now } = require('../core/util');
const tools = require('./tools');

const RUNS = 'botRuns';
const STEP_TIMEOUT = 4 * 60000;
const brainLabel = (b) => ({ auto: 'Automatic', ollama: 'Llama (free, on this PC)', anthropic: 'Claude', openai: 'ChatGPT (GPT)', xai: 'Grok', bridge: 'Your AI account' }[b] || b);

/**
 * The free local AI (Llama on the PC's processor) reads the whole prompt again at every step, so a 10,000-character
 * master prompt plus 25 tool descriptions made every step slow. For it the instructions keep only the role and the
 * rules (the routine, formats, context and examples are left out, capped at ~3,500 characters) and each tool keeps
 * its first sentence. Paid brains get everything.
 */
function compactInstructions(text, cap = 2000) {
  const t = String(text || ''); if (t.length <= cap + 2500) return t;
  // The Euclidean part (how the app works, the master note, house rules) always stays whole; the prompt itself is trimmed.
  const at = t.search(/\n(AS THE MASTER BOT|For a current client|IN THE DATA TAB|HOW THIS WORKS INSIDE EUCLIDEAN)/);
  const head = at > 0 ? t.slice(0, at) : t; const tail = at > 0 ? t.slice(at) : '';
  const parts = head.split(/\n(?=#{1,3}\s)/);
  const keep = parts.filter((p, i) => i === 0 || /role|job|rules|never|specific|pricing|sign-?off/i.test(p.split('\n')[0]));
  let out = '';
  for (const p of keep) { if ((out + p).length > cap) { out += `\n${p.slice(0, Math.max(0, cap - out.length - 1))}`; break; } out += `${out ? '\n' : ''}${p}`; }
  return `${out.trim()}${tail}`;
}
/** A tool as a short call for the local AI: research(question, recent?) instead of the full JSON example. */
function signature(t) { const keys = [...String(t.args).matchAll(/"(\w+)"\s*:\s*("[^"]*"|\[[^\]]*\]|[^,}]*)/g)].map((m) => `${m[1]}${/optional|\(empty/i.test(m[2]) ? '?' : ''}`); return `${t.name}(${keys.join(', ')})`; }
const firstSentence = (s) => { const m = /^[\s\S]*?[.!?](?=\s|$)/.exec(String(s)); return m ? m[0] : String(s); };

function systemFor(bot, list, { depth = 0, compact = false } = {}) {
  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  return [
    `You are ${bot.name}, a bot on the team at Euclidean Media, a short-form video agency for creators and political campaigns (founders Ryan Rosario and Ben Gingold).`,
    bot.role ? `Your job: ${bot.role}` : '',
    bot.instructions ? `How the founders want you to work:\n${compact ? compactInstructions(bot.instructions) : bot.instructions}` : '',
    `Today is ${today}.`,
    depth ? 'Another bot on the team handed you this task. Do it and answer it directly.' : '',
    '',
    'HOW YOU WORK: every reply is exactly ONE JSON object and nothing else.',
    '- To use a tool: {"say": "one short line telling the person what you are doing", "tool": "<tool name>", "args": { ... }}',
    '- When you are done (or need something only the person knows): {"answer": "your reply, plain text, with the links you used"}',
    '',
    'TOOLS:',
    ...list.map((t) => (compact ? `- ${signature(t)}: ${firstSentence(t.about)}${t.needsOk && t.needsOk(bot) ? ' (asks the person first)' : ''}` : `- ${t.name} ${t.args}: ${t.about}${t.needsOk && t.needsOk(bot) ? ' (the person is asked first)' : ''}`)),
    '',
    'RULES:',
    '- Facts about the world come ONLY from tool results in this conversation; put the link next to what you use. If you could not find something, say so plainly. Never make up numbers, names, emails, quotes or links.',
    '- One tool per reply. Do not repeat a search you already did. Answer as soon as you have enough.',
    '- You never send emails or messages, post anything, buy anything or change Euclidean\'s records. You can write drafts for the person to send.',
    '- Write for a beginner: short, clear, no jargon, no em dashes.',
  ].filter((l) => l !== null && l !== undefined).join('\n');
}

/** Pull the JSON object out of whatever the model said; plain text counts as the answer. */
function parse(text) {
  const s = String(text || '').trim();
  const tryJson = (x) => { try { const j = JSON.parse(x); return j && typeof j === 'object' && !Array.isArray(j) ? j : null; } catch { return null; } };
  let j = tryJson(s) || tryJson(s.replace(/^```(?:json)?\s*|\s*```$/g, ''));
  if (!j) { const a = s.indexOf('{'); const b = s.lastIndexOf('}'); if (a >= 0 && b > a) j = tryJson(s.slice(a, b + 1)); }
  if (!j) return { answer: s };
  const tool = j.tool || j.action || j.tool_name || j.name || null;
  const args = j.args || j.arguments || j.input || j.parameters || j.params || {};
  const answer = j.answer ?? j.final ?? j.final_answer ?? j.reply ?? j.response ?? j.ask ?? null;
  if (tool && tool !== 'answer' && tool !== 'final') return { say: String(j.say || j.thought || j.note || '').slice(0, 240), tool: String(tool), args: typeof args === 'object' ? args : { query: String(args) } };
  if (answer != null) return { answer: typeof answer === 'string' ? answer : JSON.stringify(answer, null, 2) };
  if (tool === 'answer') return { answer: String(args.text || args.answer || '') };
  return { answer: s };
}

const roleOf = () => (ctx.setting('ai.roles.bots') ? 'bots' : 'research');
/** Is the local AI the one that will answer (so the prompt should be the short one)? */
function localBrain(bot) { try { return require('../integrations/ai').firstFor(roleOf(), bot.brain && bot.brain !== 'auto' ? bot.brain : null) === 'ollama'; } catch { return false; } }
/** What the person should see while it writes: the answer's words as they arrive, or the line saying what it's doing. */
function partialOf(text) {
  const s = String(text || '');
  if (!/^\s*\{/.test(s)) return { answer: s };
  const grab = (k) => { const m = new RegExp(`"${k}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`).exec(s); if (!m) return null; try { return JSON.parse(`"${m[1].replace(/\\$/, '')}"`); } catch { return m[1]; } };
  return { answer: grab('answer'), say: grab('say') };
}
async function think(bot, system, messages, { onPartial = null } = {}) {
  const ai = require('../integrations/ai');
  const opts = { role: roleOf(), system, messages, maxTokens: 900, ...(bot.brain && bot.brain !== 'auto' ? { provider: bot.brain } : {}), ...(onPartial ? { onToken: (t) => onPartial(partialOf(t)) } : {}) };
  try { return await ai.ask({ ...opts, json: true }); }
  catch (e) { if (/invalid JSON/i.test(e.message)) return ai.ask({ ...opts, json: false }); throw e; }
}

/** The conversation the model sees: recent thread, the question, then each step and its result. */
function messagesFor(bot, run) {
  const hist = ctx.store.all('botMessages', (m) => m.botId === bot.id && !m.queued && m.runId !== run.id && (m.role === 'you' || m.role === 'bot')).slice(-8)
    .map((m) => ({ role: m.role === 'you' ? 'user' : 'assistant', content: m.role === 'bot' ? JSON.stringify({ answer: String(m.text).slice(0, 1500) }) : String(m.text).slice(0, 1500) }));
  const msgs = [...hist, { role: 'user', content: run.question }];
  const steps = run.steps || []; const total = steps.reduce((t, s) => t + String(s.forModel || '').length, 0);
  steps.forEach((s, i) => {
    if (!s.tool) return;
    msgs.push({ role: 'assistant', content: JSON.stringify({ say: s.say || '', tool: s.tool, args: s.args || {} }) });
    let r = String(s.forModel || s.result || '');
    // Keep the newest results whole and shrink older ones when it's getting long (small local models forget the start).
    if (total > 22000 && i < steps.length - 2) r = `${r.slice(0, 900)}…`;
    msgs.push({ role: 'user', content: `RESULT of ${s.tool}:\n${r}\n\nNext: one JSON object (another tool, or {"answer": ...}).` });
  });
  // Some providers need the conversation to alternate and start with the person.
  const out = [];
  for (const m of msgs) { if (out.length && out[out.length - 1].role === m.role) out[out.length - 1] = { role: m.role, content: `${out[out.length - 1].content}\n\n${m.content}` }; else out.push(m); }
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}

/** Live typing: the partial answer (or what it's doing) saved on the run at most ~3 times a second. */
function typer(runId) {
  let last = 0; let pending = null; let timer = null;
  const flush = () => { timer = null; if (!pending) return; const r = ctx.store.get(RUNS, runId); if (!r || r.status !== 'working') return; const p = pending; pending = null; last = Date.now(); ctx.store.update(RUNS, runId, { ...(p.answer != null ? { typing: String(p.answer).slice(0, 8000) } : {}), ...(p.say ? { note: String(p.say).slice(0, 240) } : {}) }); events.publish('bots', { botId: r.botId, runId }, { coalesceKey: `bots:${runId}` }); };
  return (p) => { if (!p || (p.answer == null && !p.say)) return; pending = p; if (timer) return; const wait = Math.max(0, 300 - (Date.now() - last)); timer = setTimeout(flush, wait); };
}
const TALK_WORDS = new Set('hi hii hey heyy hello helloo yo sup hiya howdy good morning afternoon evening night thanks thank you u ty thx ok okay k cool nice great awesome got it test testing tested 1 2 3 123 are there how what whats up doing corbin juno scout bot again'.split(' '));
const SMALL_TALK = { test: (q) => { const w = String(q || '').toLowerCase().replace(/[^a-z0-9' ]/g, ' ').replace(/'/g, '').split(/\s+/).filter(Boolean); return w.length > 0 && w.length <= 6 && w.every((x) => TALK_WORDS.has(x)); } };

const publish = (run) => events.publish('bots', { botId: run.botId, runId: run.id }, { coalesceKey: `bots:${run.id}` });
function save(run, patch) { const r = ctx.store.update(RUNS, run.id, patch); Object.assign(run, r || patch); publish(run); return run; }
const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error(`${what} took too long.`)), ms))]);

async function useTool(bot, run, step, list, { depth = 0 } = {}) {
  const t = list.find((x) => x.name === step.tool);
  const tctx = { bot, question: run.question, depth, run };
  const r = await withTimeout(t.run(step.args || {}, tctx), STEP_TIMEOUT, step.tool);
  return r || { text: '(nothing came back)' };
}

const sameStep = (a, b) => a.tool === b.tool && JSON.stringify(a.args || {}) === JSON.stringify(b.args || {});

/**
 * Run (or resume) a saved run until it answers, waits for a person, is stopped or fails.
 * The final answer is added to the bot's thread.
 */
async function drive(runId) {
  let run = ctx.store.get(RUNS, runId); if (!run) return null;
  const bot = ctx.store.get('bots', run.botId); if (!bot) { save(run, { status: 'failed', error: 'This bot was deleted.', endedAt: now() }); return run; }
  const list = tools.forBot(bot);
  const compact = localBrain(bot);
  const system = systemFor(bot, list, { compact });
  const max = Math.max(3, Math.min(30, Number(bot.maxSteps) || 12));
  save(run, { status: 'working', note: null, typing: null });
  const onPartial = typer(runId);
  try {
    // Hello / thanks / testing: one short answer, no tools and no long prompt (seconds instead of a full turn).
    if (!(run.steps || []).length && SMALL_TALK.test(run.question)) {
      const ai = require('../integrations/ai');
      const r = await ai.ask({ role: roleOf(), maxTokens: 120, ...(bot.brain && bot.brain !== 'auto' ? { provider: bot.brain } : {}), onToken: (t) => onPartial({ answer: t }),
        system: `You are ${bot.name}, an AI bot at Euclidean Media (a short-form video agency). ${bot.role ? `Your job: ${bot.role}` : ''} Reply to this greeting in one short, friendly sentence and say in a few words what you can do. Plain text, no em dashes.`,
        messages: [{ role: 'user', content: run.question }] });
      const answer = String(r.text || '').trim() || `Hi, I'm ${bot.name}. What do you need?`;
      save(run, { status: 'done', answer, endedAt: now(), note: null, typing: null, provider: r.provider, model: r.model });
      ctx.store.insert('botMessages', { botId: bot.id, role: 'bot', text: answer, runId: run.id, at: now(), by: r.provider });
      events.publish('bots', { botId: bot.id, runId: run.id });
      afterRun(bot.id);
      return ctx.store.get(RUNS, runId);
    }
    for (;;) {
      run = ctx.store.get(RUNS, runId);
      if (run.cancel) { save(run, { status: 'stopped', endedAt: now(), note: 'Stopped' }); break; }
      const steps = run.steps || [];
      // A step the person just answered on its card.
      const pend = steps.find((s) => s.waiting);
      if (pend) {
        if (pend.allowed === undefined) { save(run, { status: 'waiting' }); return run; }
        if (pend.allowed) {
          save(run, { steps: steps.map((s) => (s === pend ? { ...s, waiting: false, running: true } : s)), note: pend.say || `Using ${pend.tool}` });
          let res; try { res = await useTool(bot, run, pend, list); } catch (e) { res = { text: `That didn't work: ${e.message}`, failed: true }; }
          run = ctx.store.get(RUNS, runId);
          save(run, { steps: run.steps.map((s) => (s.id === pend.id ? { ...s, waiting: false, running: false, result: String(res.text).slice(0, 4000), forModel: String(res.text).slice(0, 7000), shot: res.shot || null, failed: !!res.failed, at: now() } : s)) });
        } else {
          save(run, { steps: steps.map((s) => (s === pend ? { ...s, waiting: false, result: 'The person said no.', forModel: 'The person said no to this. Do not do it. Find another way, or answer with what you have.', denied: true } : s)) });
        }
        continue;
      }
      const used = steps.filter((s) => s.tool).length;
      const last = used >= max;
      const msgs = messagesFor(bot, run);
      if (last) msgs[msgs.length - 1] = { ...msgs[msgs.length - 1], content: `${msgs[msgs.length - 1].content}\n\nYou are out of steps. Reply now with {"answer": ...} using what you found.` };
      save(run, { note: used ? 'Thinking about what it found' : 'Thinking' });
      const r = await think(bot, system, msgs, { onPartial });
      run = ctx.store.get(RUNS, runId);
      if (run.cancel) continue;
      const step = parse(r.text);
      if (!run.provider) save(run, { provider: r.provider, model: r.model });
      if (step.answer != null || last) {
        const answer = String(step.answer ?? r.text).trim() || 'I could not come up with an answer.';
        save(run, { status: 'done', answer, endedAt: now(), note: null, typing: null });
        ctx.store.insert('botMessages', { botId: bot.id, role: 'bot', text: answer, runId: run.id, at: now(), by: r.provider });
        events.publish('bots', { botId: bot.id, runId: run.id });
        break;
      }
      const s = { id: `s${(run.steps || []).length + 1}`, say: step.say || '', tool: step.tool, args: step.args, at: now() };
      const t = list.find((x) => x.name === s.tool);
      if (!t) { save(run, { steps: [...(run.steps || []), { ...s, result: `No tool called "${s.tool}".`, forModel: `There is no tool called "${s.tool}". Use one of: ${list.map((x) => x.name).join(', ')}, or answer.`, failed: true }] }); continue; }
      if ((run.steps || []).some((p) => sameStep(p, s) && !p.denied)) { save(run, { steps: [...(run.steps || []), { ...s, result: 'Already done (see above).', forModel: 'You already did exactly this; its result is above. Use it, try something different, or answer.', failed: true }] }); continue; }
      const why = t.needsOk && t.needsOk(bot, s.args);
      if (why) { save(run, { status: 'waiting', steps: [...(run.steps || []), { ...s, waiting: true, why }], note: `Waiting for your OK to ${why}` }); return run; }
      save(run, { steps: [...(run.steps || []), { ...s, running: true }], note: s.say || `Using ${s.tool}`, typing: null });
      let res; try { res = await useTool(bot, run, s, list); } catch (e) { res = { text: `That didn't work: ${e.message}`, failed: true }; }
      run = ctx.store.get(RUNS, runId);
      save(run, { steps: run.steps.map((x) => (x.id === s.id ? { ...x, running: false, result: String(res.text).slice(0, 4000), forModel: String(res.text).slice(0, 7000), shot: res.shot || null, links: res.links?.slice(0, 8) || null, failed: !!res.failed } : x)) });
    }
  } catch (e) {
    const msg = e.notConnected ? 'No AI is connected for this bot. Set up the free AI (Settings → AI) or pick another brain for it.' : e.message;
    run = ctx.store.get(RUNS, runId);
    save(run, { status: 'failed', error: msg, endedAt: now(), note: null, steps: (run.steps || []).map((s) => ({ ...s, running: false })) });
    ctx.store.insert('botMessages', { botId: bot.id, role: 'error', text: msg, runId: run.id, at: now() });
    audit.log(`bot:${bot.name}`, 'bot.failed', { botId: bot.id, runId, error: msg }, 'warn');
  }
  const end = ctx.store.get(RUNS, runId);
  if (end && end.status !== 'waiting') afterRun(bot.id);
  return end;
}
/** The next queued message for this bot, if any (setImmediate: the finished run is fully saved first). */
function afterRun(botId) { setImmediate(() => { try { require('./index').next(botId); } catch { /* none */ } }); }

/**
 * A run kept in memory, for a bot that another bot handed work to (ask_bot): no cards, so tools that need a person
 * are refused. Returns the answer text.
 */
async function runInline(bot, task, { depth = 1, parent = null } = {}) {
  const list = tools.forBot(bot).filter((t) => t.name !== 'ask_bot');
  const system = systemFor(bot, list, { depth, compact: localBrain(bot) });
  const run = { id: `inline-${Date.now()}`, botId: bot.id, question: task, steps: [] };
  const max = Math.min(8, Number(bot.maxSteps) || 8);
  for (let i = 0; i <= max; i++) {
    if (parent?.run && ctx.store.get(RUNS, parent.run.id)?.cancel) return 'Stopped.';
    const msgs = messagesFor(bot, run);
    if (i === max) msgs[msgs.length - 1].content += '\n\nYou are out of steps. Reply now with {"answer": ...}.';
    const step = parse((await think(bot, system, msgs)).text);
    if (step.answer != null || i === max) return String(step.answer || 'No answer.');
    const t = list.find((x) => x.name === step.tool);
    let res;
    if (!t) res = { text: `There is no tool called "${step.tool}".` };
    else if (run.steps.some((p) => sameStep(p, step))) res = { text: 'You already did exactly this; use the result above or answer.' };
    else if (t.needsOk && t.needsOk(bot, step.args)) res = { text: `That needs the person's OK, which handed-off work can't ask for. Do without it.` };
    else { try { res = await withTimeout(t.run(step.args || {}, { bot, question: task, depth, run }), STEP_TIMEOUT, step.tool); } catch (e) { res = { text: `That didn't work: ${e.message}` }; } }
    run.steps.push({ ...step, forModel: String(res.text).slice(0, 6000) });
  }
  return 'No answer.';
}

module.exports = { compactInstructions, partialOf, SMALL_TALK, drive, runInline, parse, systemFor, messagesFor, brainLabel, RUNS };
