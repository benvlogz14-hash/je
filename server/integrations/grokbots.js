'use strict';
/**
 * Your GrokBots as workers, by email (no API keys, no per-request cost).
 *
 * A task goes out as an email from Euclidean's outreach mailbox to the bot's address, tagged [JEV-<id>]
 * in the subject. The bot does the thinking on your Grok subscription and replies to that email; the
 * reply comes in through the normal inbox (messaging.receive), is matched by the tag and saved as the
 * answer. Only addresses you add as GrokBots are ever emailed this way, and only when you press Send.
 */
const ctx = require('../core/ctx');
const audit = require('../core/audit');
const events = require('../core/events');
const { now } = require('../core/util');

const TAG = /\[JEV-([A-Za-z0-9_-]+)\]/i;
const bots = () => (ctx.setting('grokbots.list', []) || []).filter((b) => b && b.email);
const isBot = (addr) => bots().some((b) => b.email.toLowerCase() === String(addr || '').toLowerCase());

/**
 * The weekly allowance for questions Euclidean's own bots send (so they never use up the GrokBot plan's weekly
 * limit). Founders pressing "Email the task" are counted too but never stopped. Weeks start Monday 00:00.
 */
function weekStart(at = new Date()) { const d = new Date(at); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d; }
function budget() {
  const from = weekStart().toISOString();
  const sent = ctx.store.all('botTasks').filter((t) => t.sentAt && t.sentAt >= from);
  const byBots = sent.filter((t) => String(t.actor || '').startsWith('bot:')).length;
  const cap = Math.max(0, Number(ctx.setting('grokbots.weeklyCap', 15)) || 0);
  const next = weekStart(); next.setDate(next.getDate() + 7);
  return { cap, usedByBots: byBots, usedTotal: sent.length, left: Math.max(0, cap - byBots), resetsAt: next.toISOString() };
}
const ready = () => bots().length > 0 && require('./email').configured();

/** Send one task to a bot. Returns the task record. */
async function send({ bot, task, title, actor = 'user', context = null }) {
  const email = require('./email');
  const b = bots().find((x) => x.name === bot || x.email === bot) || bots()[0];
  if (!b) throw new Error('Add a GrokBot first (its email address) on the AI apps page.');
  if (!email.configured()) throw new Error('Connect the outreach email account first (Settings → Connections → Email), so Euclidean can email your GrokBot.');
  if (String(actor).startsWith('bot:') && budget().left <= 0) { const bd = budget(); throw new Error(`This week's GrokBot allowance for the bots is used up (${bd.usedByBots} of ${bd.cap}). It resets ${new Date(bd.resetsAt).toLocaleDateString('en-US', { weekday: 'long' })}; raise it on the Bots page under GrokBots by email.`); }
  const t = ctx.store.insert('botTasks', { bot: b.name, email: b.email, title: String(title || task).slice(0, 80), task: String(task).slice(0, 20000), context, status: 'sending', answer: null, sentAt: null, answeredAt: null, actor });
  const tag = `[JEV-${t.id.replace(/^[a-z]+_/i, '').slice(-10)}]`;
  try {
    await email.send({ to: b.email, subject: `${tag} ${t.title}`, text: `${t.task}\n\n---\nPlease reply to this email with your answer, and keep ${tag} in the subject so Euclidean can match it. This task was sent by Euclidean (your agency app).` });
    ctx.store.update('botTasks', t.id, { status: 'sent', tag, sentAt: now() });
    audit.log(actor, 'grokbot.task_sent', { bot: b.name, taskId: t.id });
  } catch (e) { ctx.store.update('botTasks', t.id, { status: 'failed', error: e.message }); throw e; }
  events.publish('botTasks', { id: t.id });
  return ctx.store.get('botTasks', t.id);
}

/** Called for every incoming email: a reply from a GrokBot to one of our tasks is saved as its answer. Returns true when handled. */
function receive(m) {
  if (m.channel !== 'email' || !isBot(m.from)) return false;
  const tag = (String(m.subject || '').match(TAG) || [])[0]; if (!tag) return false;
  const t = ctx.store.find('botTasks', (x) => x.tag && x.tag.toLowerCase() === tag.toLowerCase()); if (!t) return false;
  // The bot's own words: drop the quoted original below its reply.
  const body = String(m.body || '').split(/\r?\n(?:On .+wrote:|-{2,}\s*Original Message|>)/)[0].trim();
  ctx.store.update('botTasks', t.id, { status: 'answered', answer: body.slice(0, 50000), answeredAt: now() });
  audit.log('system', 'grokbot.answered', { bot: t.bot, taskId: t.id });
  events.publish('botTasks', { id: t.id });
  // Asked by one of Euclidean's bots: the answer goes back into that bot's chat and it carries on with the job.
  // Asked from an agent conversation: the answer goes back into that conversation as Grok.
  if (t.context?.agentThread) { try { require('../agents/broker').lateReply({ threadId: t.context.agentThread, agentId: 'grok', body }); } catch { /* the answer is still on the task */ } }
  if (t.context?.botId) { try { require('../bots').deliver(t.context.botId, t.context.question || t.title, body, t.bot || 'GrokBot'); } catch { /* the answer is still on the task */ } }
  return true;
}

/** Wait for an answer (for Euclidean's own background work). Resolves with the answer text or null after timeoutMs. */
function waitFor(taskId, timeoutMs = 30 * 60000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const tick = () => { const t = ctx.store.get('botTasks', taskId); if (t?.status === 'answered') return resolve(t.answer); if (Date.now() - t0 > timeoutMs || t?.status === 'failed') return resolve(null); setTimeout(tick, 15000); };
    tick();
  });
}

module.exports = { budget, ready, weekStart, bots, isBot, send, receive, waitFor, TAG };
