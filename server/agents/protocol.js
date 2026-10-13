'use strict';
/**
 * Shared message protocol for peer-to-peer agent messaging.
 *
 * Every message between agents (or between a person and agents) has the same
 * shape, whichever adapter carries it:
 *
 *   {
 *     id, threadId, workspaceId,          // workspaceId: 'internal' or a client id; never crosses
 *     from: 'grok' | 'claude' | 'human:ryan' | ...,
 *     to: ['claude', 'cursor'] | ['*'],   // '*' = every agent in the thread
 *     type: one of TYPES,
 *     body: string,
 *     inReplyTo: messageId | null,
 *     context: [{ kind: 'file' | 'text' | 'link', name, path?, text?, url? }],
 *     action: { kind, summary, command? } | null   // only on type 'action_request'
 *   }
 *
 * Nobody is in charge: the broker only routes, logs and enforces safety.
 */
const { HttpError } = require('../core/util');

const TYPES = {
  message: 'Message',
  reply: 'Reply',
  question: 'Question',
  critique_request: 'Critique request',
  task_request: 'Task request',
  context: 'Context / files',
  join: 'Joined thread',
  action_request: 'Needs approval',
  system: 'System',
};

// Anything that reaches the outside world. These are never carried out by an agent;
// they become approval requests that a person decides.
const EXTERNAL_ACTIONS = ['text', 'email', 'post', 'publish', 'crm', 'account', 'payment', 'other'];

const MAX_BODY = 20000;

function clean(s, n) { return String(s == null ? '' : s).slice(0, n); }

/** Validate and normalise an incoming message. Throws HttpError(400) with a plain-English reason. */
function normalize(m) {
  if (!m || typeof m !== 'object') throw new HttpError(400, 'The message is empty.');
  const type = m.type || 'message';
  if (!TYPES[type]) throw new HttpError(400, `"${type}" is not a message type agents understand.`);
  const to = (Array.isArray(m.to) ? m.to : m.to ? [m.to] : ['*']).map((x) => clean(x, 60).toLowerCase()).filter(Boolean);
  const body = clean(m.body, MAX_BODY).trim();
  if (!body && type !== 'join' && type !== 'context') throw new HttpError(400, 'The message has no text.');
  const context = (Array.isArray(m.context) ? m.context : []).slice(0, 20).map((c) => ({
    kind: ['file', 'text', 'link'].includes(c.kind) ? c.kind : 'text',
    name: clean(c.name || c.path || 'context', 200),
    path: c.path ? clean(c.path, 1000) : undefined,
    text: c.text ? clean(c.text, 40000) : undefined,
    url: c.url ? clean(c.url, 1000) : undefined,
  }));
  let action = null;
  if (type === 'action_request' || m.action) {
    const a = m.action || {};
    action = { kind: EXTERNAL_ACTIONS.includes(a.kind) ? a.kind : 'other', summary: clean(a.summary || body, 1000), command: a.command ? clean(a.command, 2000) : null };
  }
  return {
    threadId: m.threadId || null,
    workspaceId: m.workspaceId ? clean(m.workspaceId, 80) : null,
    from: clean(m.from, 80),
    to: to.length ? to : ['*'],
    type: action ? 'action_request' : type,
    subject: m.subject ? clean(m.subject, 200) : undefined,
    body,
    inReplyTo: m.inReplyTo || null,
    context,
    action,
  };
}

/**
 * Instructions every agent receives, whichever vendor it is. Agents talk in plain
 * text; to address other agents or ask for something that needs a person they
 * add an "agent-messages" JSON block, which the broker parses.
 */
function systemPrompt({ self, peers, workspaceLabel }) {
  return [
    `You are "${self.name}" (id: ${self.id}), one of several AI agents working together as equal peers inside Euclidean, a creator-media agency app. No agent is in charge; a person supervises.`,
    `Other agents in this conversation: ${peers.length ? peers.map((p) => `${p.name} (id: ${p.id})`).join(', ') : 'none yet'}.`,
    `Workspace: ${workspaceLabel}. Only use information from this workspace. Never mention or use other clients' information.`,
    'Reply in plain text. Your reply is posted to the whole thread.',
    'To send something to specific agents (ask a question, request a critique, hand off a task), add one fenced block at the end:',
    '```agent-messages',
    '[{"to": ["claude"], "type": "question", "body": "..."}]',
    '```',
    'Allowed types: message, question, critique_request, task_request, reply.',
    'You cannot send texts or emails, post to social media, change CRM records, or change any account. If one of those is needed, add an item with type "action_request" and an "action" object: {"kind": "text|email|post|crm|account|other", "summary": "what and why", "command": "optional Euclidean /command"}. A person will approve or decline it.',
    'Keep replies focused. Do not restate the whole thread.',
  ].join('\n');
}

/** Pull the optional agent-messages block out of a reply. Returns { text, outgoing[] }. */
function parseReply(raw) {
  const text = String(raw || '');
  const rx = /```agent-messages\s*([\s\S]*?)```/i;
  const m = rx.exec(text);
  if (!m) return { text: text.trim(), outgoing: [] };
  let items = [];
  try { const j = JSON.parse(m[1].trim()); items = Array.isArray(j) ? j : [j]; } catch { items = []; }
  return { text: text.replace(rx, '').trim(), outgoing: items.filter((x) => x && typeof x === 'object').slice(0, 8) };
}

/** Render a thread as a transcript for an agent that has no memory of its own. */
function transcript(messages, nameOf) {
  return messages.map((m) => {
    const head = `[${nameOf(m.from)} → ${m.to.includes('*') ? 'everyone' : m.to.map(nameOf).join(', ')} · ${TYPES[m.type] || m.type}]`;
    const ctx = (m.context || []).map((c) => `  (attached ${c.kind}: ${c.name}${c.text ? `)\n${c.text}` : ')'}`).join('\n');
    return `${head}\n${m.body}${ctx ? '\n' + ctx : ''}`;
  }).join('\n\n');
}

module.exports = { TYPES, EXTERNAL_ACTIONS, normalize, systemPrompt, parseReply, transcript };
