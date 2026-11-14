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
    bot.instructions ? `How the founders want you to work:\n${(compact ? compactInstructions(bot.instructions) : bot.instructions).replace('Nothing you do sends, posts or schedules. Messages are drafts for Ben.', 'Nothing you do sends or posts. Messages are drafts for Ben. You can read the mailbox, write email drafts, make documents and call lists, and schedule your own tasks (see TOOLS).')}` : '',
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
    'LIVE INTERNET: you have it. research, web_search and news search the live web with DuckDuckGo: free and unlimited, so use them for anything current (news, what someone said, results, prices, who holds an office). google_search costs a little: use it when the person says Google or a deep/full search, or when DuckDuckGo found nothing useful. Never say you lack real-time access or that your knowledge has a cutoff: search instead.',
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
  return { answer: readable(j) };
}
/** A JSON reply that isn't a tool call or an answer ({"abilities": [...]}) shown as plain text, never raw JSON. */
function readable(j) {
  const words = (k) => String(k).replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());
  const val = (v) => (Array.isArray(v) ? v.map((x) => (typeof x === 'object' ? JSON.stringify(x) : String(x).replace(/_/g, ' '))).join(', ') : v && typeof v === 'object' ? Object.entries(v).map(([k, x]) => `${words(k)}: ${val(x)}`).join('; ') : String(v));
  const keys = Object.keys(j);
  if (keys.length === 1 && typeof j[keys[0]] === 'string') return j[keys[0]];
  return keys.map((k) => `${words(k)}: ${val(j[k])}`).join('\n');
}

// ------------------------------------------------------------------ live web first
/** Questions about the world right now: the bot searches DuckDuckGo before it answers. */
function needsWeb(q) {
  const t = String(q || '').toLowerCase();
  if (t.split(/\s+/).length < 3) return false;
  if (/\b(our|my) (leads?|clients?|list|data|drafts?|inbox|emails?|schedule|calendar|notebook)\b|data tab|call list|playbook|this app|euclidean|approvals?\b|\b(draft|write|make|build|schedule|remind)\b/.test(t)) return false;
  return /\b(today|tonight|yesterday|this (week|morning|month|year|weekend)|last (night|week|month)|latest|recent(ly)?|currently|right now|breaking|news|update[sd]?|announce[ds]?|said|says|statement|poll(s|ing)?|won|wins|winner|elect(ed|ion)|results?|price|weather|score|who is|who's|who are|what happened|what is happening|when (is|was|did)|look (it )?up|search|google|find out|20(2[4-9]|3\d))\b/.test(t);
}
const wantsGoogle = (q) => /\bgoogle\b|deep(er)? (search|dive|research|inquiry)|full (inquiry|search|research)|thorough(ly)? (search|research)/i.test(String(q || ''));
const recentOf = (q) => (/\b(today|tonight|yesterday|last night|this morning|breaking|just now)\b/i.test(q) ? 'day' : /\b(this week|latest|recent(ly)?|news|days ago|said|says|announced)\b/i.test(q) ? 'week' : null);
const NO_WEB = /real[- ]time|training data|knowledge cut-?off|cut-?off date|don'?t have (access|the ability)|do not have (access|the ability)|can(no|')t (browse|access the internet|search the web)|as of my last update|not able to browse|up-to-date information|check reputable news/i;

// ------------------------------------------------------------------ "what can you do?"
const ABILITIES = /\b(what (can|do) you (do|have)|your (abilities|tools|skills|capabilities)|abilities|capabilities|what tools|do you have (access|internet|the internet|duckduckgo|google|serper|a computer|email)|can you (search|browse|google|use the internet|access the internet|see the web)|(do|can) you (use|access|have) (duckduckgo|serper|google))\b/i;
function abilitiesAnswer(bot, list) {
  const has = (n) => list.some((t) => t.name === n);
  let google = false; try { google = require('../integrations/serper').ready(); } catch { /* not set up */ }
  const lines = [];
  if (has('research')) lines.push(`Live internet, free and unlimited: I search DuckDuckGo (its web results and its Instant Answers) and read the pages, so ask me about anything current, like today's news or what someone said yesterday.${has('google_search') ? (google ? ' For deeper digging I can also search Google (through your Serper key; it costs about a tenth of a cent a search, so I use it when you ask for Google or a deep search, or when DuckDuckGo comes up empty).' : ' Google search is ready too once a Serper key is added in Settings → Connections → Google search.') : ''} No API key is needed for DuckDuckGo.`);
  if (has('browser_open')) lines.push('My own web browser: I can open sites, scroll, click and type (I ask you before clicking or typing). You can take it over yourself from my computer screen to log in to sites; I stay logged in after that.');
  if (has('computer_run')) lines.push('My own computer (a safe virtual machine): I can run commands, write and read files there (I ask first unless you let me run on my own).');
  if (has('ask_grokbot')) { let b = null; try { b = require('../integrations/grokbots').budget(); } catch { /* none */ } lines.push(`Your GrokBot: for deep research my own tools can't settle, I can email the question to your GrokBot and carry on when it answers${b ? ` (${b.left} of this week's ${b.cap} GrokBot questions left)` : ''}. Say "ask GrokBot" to send one straight away.`); }
  if (has('email_inbox')) lines.push('Email: I can read and search the inbox, read whole threads, check for new mail and write drafts (with documents attached). Drafts wait in Approvals; I never send.');
  if (has('make_document')) lines.push('Documents: playbooks, platform plans, meeting briefs, proposals and reports as a designed PDF and a Word file, and I can revise them from your notes.');
  if (has('build_call_list')) lines.push('Call lists: who to call by what you want (for example two for Ben and two for Ryan), leaving out anyone already called or emailed, with phones, emails and a hook checked on their official pages, plus scripts, voicemails and email drafts. Also the contact book of everyone we reached.');
  if (has('data_search')) lines.push('The Data tab: I search and read your lists, research packs, PDFs and master prompts, and save what I find there.');
  if (has('lead_lookup') || has('propose_leads')) lines.push('Leads: look people up on the board, propose new ones, find their public videos, start the ad machine and draft outreach.');
  if (has('client_overview')) lines.push("Clients: each client's file, clips, posts and title ideas.");
  if (has('notebook_recall')) lines.push("The notebook: I remember what we've learned and add to it.");
  if (has('ask_hal') || has('ask_claude') || has('ask_bot')) lines.push('The team: I can ask HAL, Claude and the other bots.');
  if (has('schedule_task')) lines.push(`Scheduled tasks: tell me "every weekday at 8, ..." or "every 2 hours, ..." and I'll do it on my own at those times.${bot.schedulesOn === false ? ' (Auto-run is off for me right now, so they wait until you turn it on.)' : ''}`);
  return `Here is what I can do:\n\n${lines.map((l) => `- ${l}`).join('\n')}\n\nNothing is ever sent, posted or bought without you.`;
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
  const r = t.long ? await t.run(step.args || {}, tctx) : await withTimeout(t.run(step.args || {}, tctx), STEP_TIMEOUT, step.tool);
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
    const asked = run.focus || run.question;
    // Big jobs ("scout 10 ...", "deep search", "overnight"): the deep research engine runs the steps in code, so a
    // small local model never answers from memory. Every step shows in the chat as it happens.
    if (!(run.steps || []).length && list.some((t) => t.name === 'research') && require('./deep').isDeepTask(asked)) {
      const res = await deepSteps(bot, run, asked);
      run = ctx.store.get(RUNS, runId);
      if (run.cancel && !res) { save(run, { status: 'stopped', endedAt: now(), note: 'Stopped' }); afterRun(bot.id); return ctx.store.get(RUNS, runId); }
      const answer = res ? res.answer : 'The deep research stopped before it found anything.';
      save(run, { status: 'done', answer, endedAt: now(), note: null, typing: null, provider: 'deep research' });
      ctx.store.insert('botMessages', { botId: bot.id, role: 'bot', text: answer, runId: run.id, at: now(), by: 'deep research' });
      events.publish('bots', { botId: bot.id, runId: run.id });
      afterRun(bot.id);
      return ctx.store.get(RUNS, runId);
    }
    // "What can you do?" / "do you have DuckDuckGo?": answered from its real tools, instantly and correctly.
    if (!(run.steps || []).length && ABILITIES.test(asked) && String(asked).split(/\s+/).length <= 25) {
      const answer = abilitiesAnswer(bot, list);
      save(run, { status: 'done', answer, endedAt: now(), note: null, typing: null });
      ctx.store.insert('botMessages', { botId: bot.id, role: 'bot', text: answer, runId: run.id, at: now(), by: 'Euclidean' });
      events.publish('bots', { botId: bot.id, runId: run.id });
      afterRun(bot.id);
      return ctx.store.get(RUNS, runId);
    }
    // Anything about the world right now: search first (DuckDuckGo, or Google when asked), so the answer is live.
    if (!(run.steps || []).length && list.some((t) => t.name === 'research') && needsWeb(asked)) await webStep(bot, run, list, asked);
    let webRetry = false;
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
      // Said it can't see the live web without having looked: search, then answer again (once).
      if (step.answer != null && !last && !webRetry && NO_WEB.test(String(step.answer)) && list.some((t) => t.name === 'research') && !(run.steps || []).some((x) => /research|web_search|news|google_search/.test(x.tool || ''))) {
        webRetry = true; await webStep(bot, run, list, asked); continue;
      }
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
      const why = t.needsOk && t.needsOk(bot, s.args, run);
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
/** One search step the bot didn't have to think of: DuckDuckGo (free) unless Google was asked for; recent when it's news. */
async function webStep(bot, run, list, question) {
  let google = false; try { google = wantsGoogle(question) && require('../integrations/serper').ready(); } catch { /* no key */ }
  const q = await searchQuery(question);
  // Asked to use its browser: open the search there first, so the person can watch it live.
  if (require('./deep').wantsBrowser(question) && list.some((t) => t.name === 'browser_open') && ctx.botBrowser) {
    const b = { id: `s${(run.steps || []).length + 1}`, say: 'Searching in its browser (DuckDuckGo)', tool: 'browser_open', args: { url: `https://duckduckgo.com/?q=${encodeURIComponent(q)}` }, at: now(), auto: true };
    save(run, { steps: [...(run.steps || []), { ...b, running: true }], note: b.say });
    let r; try { r = await useTool(bot, run, b, list); } catch (e) { r = { text: `The browser didn't open: ${e.message}`, failed: true }; }
    const c = ctx.store.get(RUNS, run.id); save(c, { steps: c.steps.map((x) => (x.id === b.id ? { ...x, running: false, result: String(r.text).slice(0, 4000), forModel: String(r.text).slice(0, 5000), shot: r.shot || null, failed: !!r.failed } : x)) });
    Object.assign(run, ctx.store.get(RUNS, run.id));
  }
  const args = { question: q, query: q, ...(recentOf(question) ? { recent: recentOf(question) } : {}), ...(google ? { full: true } : {}) };
  const s = { id: `s${(run.steps || []).length + 1}`, say: google ? 'Searching Google' : 'Searching the live web (DuckDuckGo)', tool: 'research', args, at: now(), auto: true };
  save(run, { steps: [...(run.steps || []), { ...s, running: true }], note: s.say });
  let res; try { res = await useTool(bot, run, s, list); } catch (e) { res = { text: `The search didn't work: ${e.message}`, failed: true }; }
  // Nothing recent: try again without the date limit.
  if (args.recent && /^No web results/.test(String(res.text))) { try { res = await useTool(bot, run, { ...s, args: { ...args, recent: undefined } }, list); } catch { /* keep the first */ } }
  const cur = ctx.store.get(RUNS, run.id);
  save(cur, { steps: cur.steps.map((x) => (x.id === s.id ? { ...x, running: false, result: String(res.text).slice(0, 4000), forModel: `${String(res.text).slice(0, 7000)}\n\n(Answer from these results, with the links. If they don't cover it, say what you found and offer to dig deeper${google ? '' : ' with Google'}.)`, links: res.links?.slice(0, 8) || null, failed: !!res.failed } : x)) });
}
/** A short search query from a message ("use your browser and ... what did X say yesterday about Y" → "X said Y"). */
async function searchQuery(text) {
  const deep = require('./deep');
  const web = require('../integrations/websearch');
  let q = web.queryOf(deep.cleanTask(text));
  if (q.split(/\s+/).length > 10) {
    try {
      const r = await require('../integrations/ai').ask({ role: roleOf(), json: true, maxTokens: 80, system: 'Reply with JSON only.', prompt: `Write the best web search for this request: 3 to 8 words, no quotes.\nREQUEST: ${deep.cleanTask(text).slice(0, 600)}\nJSON: {"query": "..."}` });
      const x = String(r.json?.query || '').replace(/["']/g, '').trim(); if (x.length > 3 && x.split(/\s+/).length <= 12) q = x;
    } catch { q = q.split(/\s+/).slice(0, 10).join(' '); }
  }
  return q.slice(0, 160);
}

/** Run the deep research engine as this run's steps (each search and page shows in the chat as it happens). */
async function deepSteps(bot, run, task) {
  const id0 = (run.steps || []).length;
  let n = id0;
  const top = { id: `s${++n}`, say: 'Deep research: planning, searching and reading pages', tool: 'deep_research', args: { task: String(task).slice(0, 200) }, at: now(), running: true };
  save(run, { steps: [...(run.steps || []), top], note: top.say });
  const onStep = (st) => {
    const cur = ctx.store.get(RUNS, run.id); if (!cur) return;
    const step = { id: `s${++n}`, say: st.say || '', tool: st.tool || 'research', args: st.args || {}, result: String(st.result || '').slice(0, 4000), shot: st.shot || null, links: st.links || null, failed: !!st.failed, at: now(), auto: true };
    save(cur, { steps: [...(cur.steps || []), step], note: st.say || cur.note });
  };
  let res = null;
  try { res = await require('./deep').run(bot, task, { onStep, isCancelled: () => !!ctx.store.get(RUNS, run.id)?.cancel }); }
  catch (e) { onStep({ tool: 'deep_research', say: `Deep research stopped: ${e.message}`, failed: true }); }
  const cur = ctx.store.get(RUNS, run.id);
  save(cur, { steps: cur.steps.map((x) => (x.id === top.id ? { ...x, running: false, result: res ? `Read ${res.pages} pages, confirmed ${res.found.length}.` : 'Stopped.' } : x)) });
  return res;
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
    else if (t.needsOk && t.needsOk(bot, step.args, run)) res = { text: `That needs the person's OK, which handed-off work can't ask for. Do without it.` };
    else { try { res = await withTimeout(t.run(step.args || {}, { bot, question: task, depth, run }), STEP_TIMEOUT, step.tool); } catch (e) { res = { text: `That didn't work: ${e.message}` }; } }
    run.steps.push({ ...step, forModel: String(res.text).slice(0, 6000) });
  }
  return 'No answer.';
}

module.exports = { deepSteps, searchQuery, needsWeb, wantsGoogle, readable, abilitiesAnswer, ABILITIES, compactInstructions, partialOf, SMALL_TALK, drive, runInline, parse, systemFor, messagesFor, brainLabel, RUNS };
