'use strict';
/**
 * HAL and Claude in one chat (Nov 9, Ryan: "Claude and HAL should be able to talk directly back and forth through HAL's
 * text chat, I can send queries to both from each respective platform, and HAL saves and memorizes from his chats").
 *
 *  - In HAL's panel, "@claude ..." (or "ask Claude ...") goes to Claude. When the founders' Claude login is open on the AI
 *    apps page (the bridge), Claude answers right away and the reply lands in HAL's chat; otherwise it waits in Claude's
 *    inbox for the Claude app, which reads it through the Euclidean connector (hal_inbox) and answers into HAL's chat
 *    (reply_in_hal). Either way HAL's chat shows who said what (you, HAL, Claude).
 *  - From the Claude app, talk_to_hal posts as Claude, and HAL answers Claude.
 *  - learnFromChat: after a message, the lasting facts in it (decisions, preferences, plans, who's who) go into HAL's
 *    notebook (server/hal/memory.js), only things actually said, never HAL's own guesses.
 */
const ctx = require('../core/ctx');
const events = require('../core/events');
const memory = require('./memory');

const ADDRESS = /^\s*(?:@claude\b[:,]?|(?:hey\s+)?claude[,:]\s+|ask claude(?:\s+(?:to|about|if|whether))?\b[:,]?)\s*/i;
/** "@claude what do you think of the batch?" → "what do you think of the batch?"; null when it isn't for Claude. */
function forClaude(text) { const m = ADDRESS.exec(String(text || '')); return m ? String(text).slice(m[0].length).trim() || null : null; }

function post(msg) {
  const m = ctx.store.insert('halMessages', msg);
  const all = ctx.store.all('halMessages'); for (const x of all.slice(0, Math.max(0, all.length - 300))) ctx.store.remove('halMessages', x.id);
  events.publish('hal', { id: m.id });
  return m;
}

/** The last few turns of HAL's chat, so Claude answers in context. */
const who = (m) => (m.who === 'hal' ? 'HAL' : m.who === 'claude' ? 'Claude' : m.who === 'bot' ? `${m.bot || 'A bot'} (bot)` : 'Ryan');
function recent(n = 8) { return ctx.store.all('halMessages').slice(-n).map((m) => `${who(m)}: ${String(m.text || '').slice(0, 600)}`).join('\n'); }

/**
 * One of Euclidean's bots asks Claude (its ask_claude tool). Same path as Ryan's "@claude": answered at once through
 * the founders' Claude login when it's open, else it waits in Claude's inbox (hal_inbox) and the Claude app's answer
 * (reply_in_hal) is handed back to that bot, which carries on. Returns { answer } or { queued, id }.
 */
async function askFromBot(bot, question, { runId = null } = {}) {
  const q = String(question || '').trim().slice(0, 4000); if (!q) throw new Error('Ask Claude something.');
  const msg = post({ who: 'bot', bot: bot.name, botId: bot.id, runId, text: q, toClaude: true, answered: false, by: `Bot: ${bot.name}` });
  const bridge = require('../integrations/bridge');
  if (bridge.available() && (ctx.store.settings._bridgeLoggedIn || {}).claude) {
    try {
      const r = await bridge.ask('claude', `You're Claude, helping ${bot.name}, one of the AI bots inside Euclidean (Ryan and Ben's video agency app). ${bot.role ? `Its job: ${bot.role}.` : ''} Answer it directly and briefly.\n\nRecent chat:\n${recent()}\n\n${bot.name} asks: ${q}`, { actor: `bot:${bot.name}`, quiet: true, record: true });
      ctx.store.update('halMessages', msg.id, { answered: true });
      post({ who: 'claude', text: r.text, by: 'Claude (your login)', forBot: bot.name });
      return { answer: r.text };
    } catch { /* waits in the inbox */ }
  }
  return { queued: true, id: msg.id };
}

/** Ryan (in HAL's panel) asks Claude. Returns HAL's reply for the panel. */
async function ask(question, actor = 'ryan') {
  const ask = post({ who: 'you', text: `@claude ${question}`, by: actor, toClaude: true, answered: false });
  const bridge = require('../integrations/bridge');
  const loggedIn = !!(ctx.store.settings._bridgeLoggedIn || {}).claude;
  if (bridge.available() && loggedIn) {
    try {
      const notes = memory.context(question);
      const r = await bridge.ask('claude', `You're Claude, talking with Ryan inside Euclidean (his video agency's desktop app) in HAL's chat. HAL is the app's own assistant. Keep it short and practical.\n\nRecent chat:\n${recent()}\n${notes ? `\nWhat the app's notebook knows about this:\n${notes}\n` : ''}\nRyan asks you: ${question}`, { actor, quiet: true, record: true });
      ctx.store.update('halMessages', ask.id, { answered: true });
      const m = post({ who: 'claude', text: r.text, by: 'Claude (your login)' });
      learnFromChat(r.text, 'Claude').catch(() => {});
      return { text: null, posted: m.id };
    } catch (e) { /* falls back to the inbox below */ }
  }
  return { text: `Sent to Claude. ${bridge.available() ? "Your Claude login isn't open on the AI apps page, so" : 'In the browser'} it waits in Claude's inbox: ask the Claude app (with Euclidean connected) to "check HAL's inbox" and the answer lands here.`, by: 'HAL' };
}

/** What waits for Claude: Ryan's @claude messages not answered yet, with the chat around them. */
function inbox() {
  const all = ctx.store.all('halMessages');
  const waiting = all.filter((m) => m.toClaude && !m.answered).map((m) => ({ id: m.id, at: m.createdAt, from: m.who === 'bot' ? `${m.bot} (one of Euclidean's bots; your reply goes back to it and it carries on)` : 'Ryan', text: String(m.text || '').replace(/^@claude\s*/i, '') }));
  return { waiting, chat: all.slice(-14).map((m) => ({ id: m.id, who: who(m), text: String(m.text || '').slice(0, 1200), at: m.createdAt })) };
}

/** Claude answers in HAL's chat (from the Claude app). replyTo: the inbox message id it answers (all waiting when omitted). */
function reply(text, replyTo = null, asked = null) {
  const t = String(text || '').trim().slice(0, 8000); if (!t) throw Object.assign(new Error('Say something first.'), { status: 400 });
  const answered = ctx.store.all('halMessages', (x) => x.toClaude && !x.answered && (!replyTo || x.id === replyTo));
  for (const m of answered) ctx.store.update('halMessages', m.id, { answered: true });
  // A bot's question: the answer goes back into that bot's chat and it carries on with the job.
  for (const m of answered.filter((x) => x.botId)) { try { require('../bots').deliver(m.botId, m.text, t, 'Claude'); } catch { /* the bot is gone */ } }
  // The conversation in the Claude app, copied here so it can be read in Euclidean: what Ryan asked Claude there, then Claude's answer.
  const q = String(asked || '').trim().slice(0, 4000);
  if (q) { post({ who: 'you', text: q, by: 'Ryan (in the Claude app)', inClaudeApp: true }); learnFromChat(q, 'Ryan').catch(() => {}); }
  const bots = [...new Set(answered.filter((x) => x.bot).map((x) => x.bot))];
  const m = post({ who: 'claude', text: t, by: 'Claude (the Claude app)', ...(bots.length ? { forBot: bots.join(', ') } : {}) });
  learnFromChat(t, 'Claude').catch(() => {});
  return { id: m.id };
}

// ------------------------------------------------------------------ HAL learns from his chats
const recentLearn = [];
/** The lasting facts in one message (decisions, preferences, plans, who's who), into the notebook. Only what the message
 *  states; questions and small talk give nothing. At most 30 an hour, and only when HAL's brain is running. */
async function learnFromChat(text, who = 'Ryan') {
  const t = String(text || '').trim();
  if (t.length < 25 || /^\s*\//.test(t) || (t.endsWith('?') && t.split(/\s+/).length < 25)) return [];
  const hour = Date.now() - 3600000; while (recentLearn.length && recentLearn[0] < hour) recentLearn.shift();
  if (recentLearn.length >= 30) return [];
  recentLearn.push(Date.now());
  let r;
  try {
    r = await require('./brain').think({ json: true, maxTokens: 400, system: 'You keep a notebook for a video agency\'s assistant. From ONE chat message, list the lasting facts worth remembering: decisions, preferences, plans with dates, rules, who someone is, what a client or candidate wants. Only what the message itself states; never guesses, never questions, never small talk. Each fact one short sentence that makes sense on its own (use names, not "he" or "they"). Return {"facts":[{"text":"...","about":["names"]}]} or {"facts":[]}.', messages: [{ role: 'user', content: `${who} said:\n${t.slice(0, 3000)}` }] });
  } catch { return []; }
  const out = [];
  for (const f of [].concat(r.json?.facts || []).slice(0, 5)) {
    const ft = String(f?.text || '').trim(); if (ft.length < 8) continue;
    // Grounded: most of the fact's words must be in the message itself.
    const words = ft.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length > 3);
    const low = t.toLowerCase(); if (words.length && words.filter((w) => low.includes(w)).length / words.length < 0.6) continue;
    const n = memory.add({ text: ft, about: [].concat(f.about || []).slice(0, 4), kind: 'note', source: `chat (${who})` });
    if (n) out.push(n.id);
  }
  return out;
}

module.exports = { forClaude, ask, askFromBot, inbox, reply, learnFromChat, recent };
