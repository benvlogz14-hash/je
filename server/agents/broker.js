'use strict';
/**
 * Neutral message broker for peer-to-peer agent messaging.
 *
 * It routes, logs and enforces safety. It never decides anything and no agent
 * is in charge: any agent (or person) can start a thread, message any other
 * agent, ask, critique, hand off work, pass files and join threads.
 *
 *  - Threads belong to one workspace ('internal' or a client id). Messages,
 *    files and participants can never cross into another workspace.
 *  - Every message is stored and written to the audit log.
 *  - Each agent has an inbox (messages to it) and an outbox (messages from it).
 *  - Delivery is queued per agent (one at a time each), retried on request,
 *    held while paused, and a thread pauses itself after maxAutoTurns agent
 *    replies in a row without a person, so agents can't loop forever.
 *  - Replies are delivered to the inbox but don't trigger another automatic
 *    answer unless they carry new requests.
 *  - Anything that would reach the outside world (texts, emails, posts, CRM or
 *    account changes) becomes an approval request a person decides.
 */
const fs = require('fs');
const path = require('path');
const ctx = require('../core/ctx');
const paths = require('../core/paths');
const audit = require('../core/audit');
const events = require('../core/events');
const { HttpError, now } = require('../core/util');
const protocol = require('./protocol');
const registry = require('./registry');

const RESPOND_TYPES = new Set(['message', 'question', 'critique_request', 'task_request', 'context']);
const queues = new Map();   // agentId -> [messageId]
const running = new Set();  // agentIds currently answering
const aborts = new Map();   // agentId -> AbortController

function settings() { return ctx.setting('agentNet', {}) || {}; }
function publish(kind, payload) { events.publish('agentnet', { kind, ...payload }, { coalesceKey: `agentnet:${kind}:${payload.threadId || payload.id || ''}` }); }

function workspaceLabel(ws) {
  if (!ws || ws === 'internal') return 'Euclidean (internal, no client data)';
  const c = ctx.store.get('clients', ws);
  return c ? `${c.name} (client workspace)` : ws;
}
function assertWorkspace(ws) {
  if (ws === 'internal') return 'internal';
  if (!ws || !ctx.store.get('clients', ws)) throw new HttpError(400, 'Pick a workspace: Euclidean (internal) or one of your clients.');
  return ws;
}
/** Folder whose files a thread may share. Client threads only see that client's folder. */
function workspaceDir(ws) { return ws === 'internal' ? path.join(paths.root, 'agent-files') : paths.clientDir(ws); }

// ------------------------------------------------------------ threads
function createThread({ title, workspaceId, participants = [], createdBy }) {
  const ws = assertWorkspace(workspaceId || 'internal');
  const ids = [...new Set(participants.map((x) => String(x).toLowerCase()))];
  for (const a of ids) {
    if (!registry.def(a)) throw new HttpError(400, `There's no agent called "${a}".`);
    if (!registry.allowedIn(a, ws)) throw new HttpError(403, `${registry.name(a)} isn't allowed in ${workspaceLabel(ws)}. Change that under its "Show advanced" options.`);
  }
  const t = ctx.store.insert('agentThreads', { title: String(title || 'New conversation').slice(0, 120), workspaceId: ws, participants: ids, status: 'active', paused: false, autoTurns: 0, createdBy, lastAt: now() });
  audit.log(createdBy, 'agentnet.thread_started', { threadId: t.id, workspaceId: ws, clientId: ws === 'internal' ? null : ws, participants: ids });
  publish('thread', { threadId: t.id });
  return t;
}

function thread(id) { const t = ctx.store.get('agentThreads', id); if (!t) throw new HttpError(404, 'That conversation no longer exists.'); return t; }

function join(threadId, agentId, actor) {
  const t = thread(threadId); const a = String(agentId).toLowerCase();
  if (!registry.def(a)) throw new HttpError(400, `There's no agent called "${a}".`);
  if (t.participants.includes(a)) return t;
  if (!registry.allowedIn(a, t.workspaceId)) throw new HttpError(403, `${registry.name(a)} isn't allowed in ${workspaceLabel(t.workspaceId)}.`);
  ctx.store.update('agentThreads', t.id, (x) => ({ participants: [...x.participants, a] }));
  record({ threadId: t.id, workspaceId: t.workspaceId, from: 'system', to: ['*'], type: 'join', body: `${registry.name(a)} joined the conversation${actor && actor !== a ? ` (added by ${registry.name(actor)})` : ''}.` });
  return ctx.store.get('agentThreads', t.id);
}

function setPaused(threadId, paused, actor) {
  const t = thread(threadId);
  ctx.store.update('agentThreads', t.id, { paused, autoTurns: paused ? t.autoTurns : 0 });
  record({ threadId: t.id, workspaceId: t.workspaceId, from: 'system', to: ['*'], type: 'system', body: paused ? `Paused by ${registry.name(actor)}. Agents won't reply until it's resumed.` : `Resumed by ${registry.name(actor)}.` });
  audit.log(actor, paused ? 'agentnet.thread_paused' : 'agentnet.thread_resumed', { threadId: t.id });
  if (!paused) for (const m of ctx.store.all('agentMessages', (x) => x.threadId === t.id)) for (const [a, d] of Object.entries(m.deliveries || {})) if (d.status === 'held') enqueue(a, m.id);
  if (paused) for (const [a, ac] of aborts) if (ctx.store.all('agentMessages', (x) => x.threadId === t.id && x.deliveries?.[a]?.status === 'running').length) ac.abort();
  return ctx.store.get('agentThreads', t.id);
}

function setGlobalPause(paused, actor) {
  ctx.store.setSettings({ agentNet: { paused: !!paused } });
  audit.log(actor, paused ? 'agentnet.paused_all' : 'agentnet.resumed_all', {}, paused ? 'warn' : 'info');
  if (paused) for (const ac of aborts.values()) ac.abort();
  else for (const m of ctx.store.all('agentMessages')) for (const [a, d] of Object.entries(m.deliveries || {})) if (d.status === 'held') { const t = ctx.store.get('agentThreads', m.threadId); if (t && !t.paused) enqueue(a, m.id); }
  publish('status', {});
  return { paused: !!paused };
}

// ------------------------------------------------------------ messages
/** Store + log a message without routing it (system notes, joins). */
function record(m) {
  const msg = ctx.store.insert('agentMessages', { ...m, context: m.context || [], deliveries: m.deliveries || {}, inReplyTo: m.inReplyTo || null, action: m.action || null });
  ctx.store.update('agentThreads', m.threadId, { lastAt: msg.createdAt, preview: String(m.body || '').slice(0, 140) });
  audit.log(m.from && !m.from.startsWith('human:') && m.from !== 'system' ? `agent:${m.from}` : m.from === 'system' ? 'system' : m.from.slice(6), 'agentnet.message', { threadId: m.threadId, messageId: msg.id, clientId: m.workspaceId === 'internal' ? null : m.workspaceId, type: m.type, from: m.from, to: m.to, chars: (m.body || '').length });
  publish('message', { threadId: m.threadId, id: msg.id });
  return msg;
}

/** Read text out of shared files, but only files inside the thread's workspace folder. */
function resolveContext(items, ws) {
  const base = workspaceDir(ws); fs.mkdirSync(base, { recursive: true });
  return items.map((c) => {
    if (c.kind !== 'file') return c;
    const p = path.resolve(c.path || '');
    if (!c.path || !paths.inside(base, p)) throw new HttpError(403, `"${c.name}" is outside this conversation's workspace, so it can't be shared here. Only files in ${workspaceLabel(ws)} can be attached.`);
    if (!fs.existsSync(p)) throw new HttpError(400, `"${c.name}" wasn't found.`);
    const st = fs.statSync(p);
    const textLike = /\.(txt|md|json|csv|srt|vtt|ass|xml|html?|js|ts|py|yaml|yml|log)$/i.test(p);
    return { ...c, path: p, name: c.name || path.basename(p), size: st.size, text: textLike ? fs.readFileSync(p, 'utf8').slice(0, 40000) : undefined };
  });
}

/**
 * Send a message from a person or an agent. Validates, enforces boundaries,
 * stores, logs, then routes to each recipient's inbox.
 */
function send(raw, { actor } = {}) {
  const m = protocol.normalize(raw);
  const from = m.from || actor;
  if (!from) throw new HttpError(400, 'Who is this message from?');
  const t = thread(m.threadId);
  if (t.status === 'archived') throw new HttpError(400, 'This conversation is archived.');
  if (m.workspaceId && m.workspaceId !== t.workspaceId) {
    audit.log(from.startsWith('human:') ? from.slice(6) : `agent:${from}`, 'agentnet.boundary_blocked', { threadId: t.id, attempted: m.workspaceId, workspace: t.workspaceId }, 'warn');
    throw new HttpError(403, `Blocked: this conversation belongs to ${workspaceLabel(t.workspaceId)} and messages can't cross into another workspace.`);
  }
  const isHuman = from.startsWith('human:');
  if (!isHuman) {
    if (!registry.def(from)) throw new HttpError(400, `Unknown sender "${from}".`);
    if (!t.participants.includes(from)) throw new HttpError(403, `${registry.name(from)} isn't part of this conversation. It needs to join first.`);
  }
  // Recipients: '*' means everyone else in the thread. Named agents not yet in the thread join it (if allowed).
  let to = m.to.includes('*') ? t.participants.filter((a) => a !== from) : m.to.filter((a) => a !== from);
  for (const a of to) if (!t.participants.includes(a)) join(t.id, a, from);
  to = [...new Set(to)];
  const context = resolveContext(m.context, t.workspaceId);

  const msg = record({ threadId: t.id, workspaceId: t.workspaceId, from, to: m.to.includes('*') ? ['*'] : to, type: m.type, subject: m.subject, body: m.body, inReplyTo: m.inReplyTo, context, action: m.action });
  if (isHuman) ctx.store.update('agentThreads', t.id, { autoTurns: 0 });

  if (m.type === 'action_request') { requestApproval(msg, t); return ctx.store.get('agentMessages', msg.id); }

  const deliveries = {};
  for (const a of to) {
    const conf = registry.conf(a);
    const willRespond = RESPOND_TYPES.has(m.type) && conf.autoReply !== false && conf.enabled !== false && !(conf.connection === 'local' && conf.mailbox && !conf.url);
    deliveries[a] = { status: willRespond ? 'queued' : 'delivered', at: now() };
  }
  ctx.store.update('agentMessages', msg.id, { deliveries });
  for (const [a, d] of Object.entries(deliveries)) if (d.status === 'queued') enqueue(a, msg.id);
  return ctx.store.get('agentMessages', msg.id);
}

function setDelivery(msgId, agentId, patch) {
  ctx.store.update('agentMessages', msgId, (x) => ({ deliveries: { ...(x.deliveries || {}), [agentId]: { ...(x.deliveries?.[agentId] || {}), ...patch, at: now() } } }));
  const m = ctx.store.get('agentMessages', msgId);
  publish('delivery', { threadId: m.threadId, id: msgId });
}

// ------------------------------------------------------------ delivery
function enqueue(agentId, msgId) {
  const q = queues.get(agentId) || []; if (!q.includes(msgId)) q.push(msgId); queues.set(agentId, q);
  setImmediate(() => pump(agentId));
}

async function pump(agentId) {
  if (running.has(agentId)) return;
  const q = queues.get(agentId) || [];
  while (q.length) {
    const msgId = q.shift();
    const m = ctx.store.get('agentMessages', msgId); if (!m) continue;
    const t = ctx.store.get('agentThreads', m.threadId); if (!t) continue;
    if (settings().paused || t.paused) { setDelivery(msgId, agentId, { status: 'held' }); continue; }
    if (t.autoTurns >= (settings().maxAutoTurns || 12) && !m.from.startsWith('human:')) {
      setDelivery(msgId, agentId, { status: 'held' });
      if (!t.paused) { ctx.store.update('agentThreads', t.id, { paused: true }); record({ threadId: t.id, workspaceId: t.workspaceId, from: 'system', to: ['*'], type: 'system', body: `Paused automatically after ${t.autoTurns} agent replies in a row. Read through, then resume or reply to steer it.` }); }
      continue;
    }
    running.add(agentId);
    const ac = new AbortController(); aborts.set(agentId, ac);
    setDelivery(msgId, agentId, { status: 'running' });
    try {
      const reply = await answer(agentId, m, t, ac.signal);
      setDelivery(msgId, agentId, { status: 'replied', replyId: reply?.id || null });
    } catch (e) {
      const paused = settings().paused || ctx.store.get('agentThreads', t.id)?.paused;
      setDelivery(msgId, agentId, paused && ac.signal.aborted ? { status: 'held' } : { status: 'failed', error: plain(e, agentId) });
      if (!(paused && ac.signal.aborted)) audit.log(`agent:${agentId}`, 'agentnet.delivery_failed', { threadId: t.id, messageId: msgId, clientId: t.workspaceId === 'internal' ? null : t.workspaceId, error: e.message }, 'warn');
    } finally { running.delete(agentId); aborts.delete(agentId); }
  }
}

function plain(e, agentId) {
  const s = String(e?.message || e);
  if (/abort/i.test(s)) return 'Stopped.';
  if (/timed? ?out|did not finish/i.test(s)) return `${registry.name(agentId)} took too long to answer. Try again, or raise the time limit under Show advanced.`;
  return s.slice(0, 400);
}

/** Ask one agent to respond to one message, then post its reply (and any messages it sends on). */
async function answer(agentId, m, t, signal) {
  const def = registry.def(agentId);
  if (!registry.allowedIn(agentId, t.workspaceId)) throw new Error(`${def.name} isn't allowed in this workspace.`);
  const adapter = registry.adapter(agentId);
  const peers = t.participants.filter((a) => a !== agentId).map((a) => ({ id: a, name: registry.name(a) }));
  const history = ctx.store.all('agentMessages', (x) => x.threadId === t.id && x.createdAt <= m.createdAt && x.type !== 'join').slice(-30);
  // Studio projects in this workspace (client threads only ever see that client's projects).
  const editOps = require('../video/edit-ops');
  const wsProjects = ctx.store.all('projects', (pr) => (t.workspaceId === 'internal' ? !pr.clientId : pr.clientId === t.workspaceId)).sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || '')).slice(0, 12);
  const said = history.map((x) => x.body).join(' ').toLowerCase();
  const projInfo = wsProjects.map((pr) => ({ id: pr.id, name: pr.name, summary: wsProjects.length === 1 || said.includes(String(pr.name || '').toLowerCase()) || said.includes(pr.id) ? editOps.summarize(pr) : null }));
  const system = [protocol.systemPrompt({ self: { id: agentId, name: def.name }, peers, workspaceLabel: workspaceLabel(t.workspaceId) }), registry.conf(agentId).note || '',
    t.workspaceId !== 'internal' ? require('../integrations/ai').clientContext(t.workspaceId) : '', protocol.studioPrompt(projInfo, editOps.OPS_DOC)].filter(Boolean).join('\n\n');
  const prompt = `Conversation "${t.title}" so far:\n\n${protocol.transcript(history, registry.name)}\n\n---\nRespond to the latest message from ${registry.name(m.from)} (${protocol.TYPES[m.type]}).`;
  const raw = await adapter.deliver({ system, prompt, message: m, thread: { id: t.id, title: t.title, workspaceId: t.workspaceId }, clientId: t.workspaceId === 'internal' ? null : t.workspaceId, signal });
  if (raw == null) return null; // mailbox agents fetch the message themselves
  const { text, outgoing, edits } = protocol.parseReply(raw);
  ctx.store.update('agentThreads', t.id, (x) => ({ autoTurns: (x.autoTurns || 0) + 1 }));
  let reply = null;
  if (text) reply = send({ threadId: t.id, from: agentId, to: m.from.startsWith('human:') || m.from === 'system' ? ['*'] : [m.from], type: 'reply', body: text, inReplyTo: m.id });
  // Studio edits: applied to projects in this workspace only, logged, undoable from Studio.
  for (const ed of edits) {
    const ref = String(ed.project || '').toLowerCase();
    const pr = wsProjects.find((x) => x.id === ed.project || String(x.name || '').toLowerCase() === ref) || (wsProjects.length === 1 && !ref ? wsProjects[0] : null);
    if (!pr) { record({ threadId: t.id, workspaceId: t.workspaceId, from: 'system', to: [agentId], type: 'system', body: `${def.name} tried to edit "${ed.project}", which isn't a Studio project in this workspace.` }); continue; }
    const r = editOps.commit(ctx.store.get('projects', pr.id), ed.ops || [], { actor: `agent:${agentId}`, via: `agent:${agentId}`, instruction: text.slice(0, 200) });
    record({ threadId: t.id, workspaceId: t.workspaceId, from: 'system', to: ['*'], type: 'system', body: `${def.name} edited Studio project "${pr.name}":\n${r.done.map((x) => `• ${x}`).join('\n') || '• nothing changed'}${r.errors.length ? `\nSkipped:\n${r.errors.map((x) => `• ${x}`).join('\n')}` : ''}\n(Undo from Studio → AI.)` });
  }
  for (const o of outgoing) {
    try { send({ ...o, threadId: t.id, workspaceId: t.workspaceId, from: agentId, inReplyTo: o.inReplyTo || m.id }); }
    catch (e) { record({ threadId: t.id, workspaceId: t.workspaceId, from: 'system', to: [agentId], type: 'system', body: `A message from ${def.name} wasn't sent: ${e.message}` }); }
  }
  return reply;
}

function retry(msgId, agentId, actor) {
  const m = ctx.store.get('agentMessages', msgId); if (!m) throw new HttpError(404, 'Message not found');
  const targets = agentId ? [agentId] : Object.entries(m.deliveries || {}).filter(([, d]) => d.status === 'failed' || d.status === 'held').map(([a]) => a);
  for (const a of targets) { setDelivery(m.id, a, { status: 'queued', error: null }); enqueue(a, m.id); }
  audit.log(actor, 'agentnet.retry', { messageId: m.id, agents: targets });
  return ctx.store.get('agentMessages', m.id);
}

function cancel(agentId, actor) { const ac = aborts.get(agentId); if (ac) ac.abort(); queues.set(agentId, []); audit.log(actor, 'agentnet.agent_stopped', { agentId }); return { ok: true }; }

// ------------------------------------------------------------ approvals (external actions)
function requestApproval(msg, t) {
  const a = ctx.store.insert('agentApprovals', { messageId: msg.id, threadId: t.id, workspaceId: t.workspaceId, from: msg.from, kind: msg.action.kind, summary: msg.action.summary, command: msg.action.command, status: 'pending' });
  audit.log(msg.from.startsWith('human:') ? msg.from.slice(6) : `agent:${msg.from}`, 'agentnet.approval_requested', { approvalId: a.id, threadId: t.id, clientId: t.workspaceId === 'internal' ? null : t.workspaceId, kind: a.kind, summary: a.summary }, 'warn');
  events.publish('notify', { title: `${registry.name(msg.from)} needs your approval`, body: a.summary.slice(0, 140) });
  publish('approval', { threadId: t.id, id: a.id });
  return a;
}

async function decide(approvalId, approve, actor, note) {
  const a = ctx.store.get('agentApprovals', approvalId); if (!a) throw new HttpError(404, 'Approval not found');
  if (a.status !== 'pending') throw new HttpError(400, `Already ${a.status}.`);
  let result = null;
  if (approve && a.command) {
    // The approved command runs as the person who approved it, through the same command system people use
    // (which still applies its own safeguards: quiet hours, opt-outs, test environment, outreach holds).
    const r = await require('../commands').execute(a.command, { actor, clientId: a.workspaceId === 'internal' ? null : a.workspaceId });
    result = String(r?.text || 'Done').slice(0, 2000);
  }
  ctx.store.update('agentApprovals', a.id, { status: approve ? 'approved' : 'declined', decidedBy: actor, decidedAt: now(), note: note || '', result });
  audit.log(actor, approve ? 'agentnet.approval_approved' : 'agentnet.approval_declined', { approvalId: a.id, threadId: a.threadId, clientId: a.workspaceId === 'internal' ? null : a.workspaceId, kind: a.kind, summary: a.summary }, approve ? 'info' : 'warn');
  record({ threadId: a.threadId, workspaceId: a.workspaceId, from: 'system', to: [a.from], type: 'system', body: `${registry.name(`human:${actor}`)} ${approve ? 'approved' : 'declined'}: ${a.summary}${note ? `\nNote: ${note}` : ''}${result ? `\nResult: ${result}` : approve && !a.command ? '\n(No command attached: a person will carry it out.)' : ''}` });
  publish('approval', { threadId: a.threadId, id: a.id });
  return ctx.store.get('agentApprovals', a.id);
}

// ------------------------------------------------------------ views
function view(m) { return { ...m, fromName: registry.name(m.from), toNames: (m.to || []).map((x) => (x === '*' ? 'Everyone' : registry.name(x))) }; }

function threads({ workspaceId, status } = {}) {
  return ctx.store.all('agentThreads', (t) => (!workspaceId || t.workspaceId === workspaceId) && (!status || t.status === status)).sort((a, b) => (b.lastAt || '').localeCompare(a.lastAt || '')).map((t) => {
    const msgs = ctx.store.all('agentMessages', (m) => m.threadId === t.id);
    return { ...t, workspaceLabel: workspaceLabel(t.workspaceId), messages: msgs.length, failed: msgs.filter((m) => Object.values(m.deliveries || {}).some((d) => d.status === 'failed')).length, working: msgs.some((m) => Object.values(m.deliveries || {}).some((d) => d.status === 'running' || d.status === 'queued')), approvals: ctx.store.all('agentApprovals', (a) => a.threadId === t.id && a.status === 'pending').length, participantNames: t.participants.map(registry.name) };
  });
}
function messages(threadId) { thread(threadId); return ctx.store.all('agentMessages', (m) => m.threadId === threadId).map(view); }
function inbox(agentId, { limit = 100 } = {}) {
  return ctx.store.all('agentMessages', (m) => m.from !== agentId && (m.to.includes(agentId) || (m.to.includes('*') && ctx.store.get('agentThreads', m.threadId)?.participants.includes(agentId)))).slice(-limit).reverse().map(view);
}
function outbox(agentId, { limit = 100 } = {}) { return ctx.store.all('agentMessages', (m) => m.from === agentId).slice(-limit).reverse().map(view); }
function failed() { return ctx.store.all('agentMessages', (m) => Object.values(m.deliveries || {}).some((d) => d.status === 'failed')).slice(-100).reverse().map(view); }
function approvals(status = 'pending') { return ctx.store.all('agentApprovals', (a) => !status || a.status === status).reverse().map((a) => ({ ...a, fromName: registry.name(a.from), workspaceLabel: workspaceLabel(a.workspaceId) })); }
function status() {
  const busy = {}; for (const a of running) busy[a] = true;
  const queued = {}; for (const [a, q] of queues) queued[a] = q.length;
  return { paused: !!settings().paused, busy, queued, pendingApprovals: ctx.store.all('agentApprovals', (a) => a.status === 'pending').length, failed: failed().length };
}

/** On startup: anything that was mid-delivery when the app closed goes back in line (or stays held). */
function start() {
  for (const m of ctx.store.all('agentMessages')) for (const [a, d] of Object.entries(m.deliveries || {})) if (d.status === 'running' || d.status === 'queued') { setDelivery(m.id, a, { status: 'queued' }); enqueue(a, m.id); }
}

module.exports = { createThread, join, send, setPaused, setGlobalPause, retry, cancel, decide, threads, messages, inbox, outbox, failed, approvals, status, start, workspaceLabel, workspaceDir };
