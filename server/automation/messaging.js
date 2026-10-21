'use strict';
/**
 * Unified communications: one conversation per contact across SMS and email.
 * Outbound policy (enforced here, not in the UI):
 *  - prospecting, pricing, commitments, complaints, contracts, sensitive
 *    matters and unknown contacts always wait for founder approval;
 *  - opted-out contacts are never messaged;
 *  - quiet hours defer delivery; an hourly cap prevents bursts;
 *  - the test environment redirects every message to the sandbox recipient;
 *  - mass unsolicited messaging is not possible: outreach is one approved
 *    message per prospect.
 */
const path = require('path');
const ctx = require('../core/ctx');
const events = require('../core/events');
const audit = require('../core/audit');
const twilio = require('../integrations/twilio');
const email = require('../integrations/email');
const queue = require('../jobs/queue');
const paths = require('../core/paths');
const { now } = require('../core/util');

const STOP_WORDS = /^\s*(stop|stopall|unsubscribe|cancel|end|quit|opt[\s-]?out)\s*$/i;
const START_WORDS = /^\s*(start|unstop|yes)\s*$/i;

// ------------------------------------------------------------ contacts & conversations
function findContactByAddress({ phone, emailAddr }) {
  const p = phone ? twilio.normalize(phone) : null; const e = emailAddr ? emailAddr.toLowerCase() : null;
  return ctx.store.find('contacts', (c) => (p && (c.phones || []).includes(p)) || (e && (c.emails || []).map((x) => x.toLowerCase()).includes(e)));
}

function ensureConversation(contact) {
  let conv = ctx.store.find('conversations', (c) => c.contactId === contact.id && c.kind === 'contact');
  if (!conv) conv = ctx.store.insert('conversations', { kind: 'contact', contactId: contact.id, clientId: contact.clientId || null, title: contact.name, lastMessageAt: now(), unread: 0, preview: '', pinned: false, archived: false });
  return conv;
}

function commandConversation() {
  let conv = ctx.store.find('conversations', (c) => c.kind === 'command');
  if (!conv) conv = ctx.store.insert('conversations', { id: 'cv_command', kind: 'command', title: 'Euclidean', lastMessageAt: now(), unread: 0, preview: 'Type / for commands', pinned: true });
  return conv;
}

function touchConversation(conv, msg) {
  ctx.store.update('conversations', conv.id, (c) => ({
    lastMessageAt: msg.createdAt, preview: (msg.subject ? `${msg.subject} · ` : '') + (msg.body || (msg.attachments?.length ? `${msg.attachments.length} attachment(s)` : '')).slice(0, 140),
    unread: msg.direction === 'in' ? (c.unread || 0) + 1 : c.unread, lastChannel: msg.channel || c.lastChannel, archived: false,
  }));
  events.publish('conversation', ctx.store.get('conversations', conv.id), { coalesceKey: `conv:${conv.id}` });
}

function addMessage(conv, data) {
  const msg = ctx.store.insert('messages', { conversationId: conv.id, clientId: conv.clientId || null, contactId: conv.contactId || null, attachments: [], ...data });
  touchConversation(conv, msg);
  events.publish('message', msg);
  return msg;
}

// ------------------------------------------------------------ policy
function inQuietHours(d = new Date()) {
  const q = ctx.setting('messaging.quietHours', {});
  if (!q.enabled) return false;
  const tz = ctx.setting('agency.timezone', 'America/New_York');
  const h = Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: tz }).format(d));
  return q.start > q.end ? (h >= q.start || h < q.end) : (h >= q.start && h < q.end);
}
function nextAllowedTime() {
  const d = new Date();
  for (let i = 0; i < 48 && inQuietHours(d); i++) d.setTime(d.getTime() + 30 * 60000);
  return d.toISOString();
}

function needsApproval({ contact, category, aiGenerated }) {
  const required = ctx.setting('messaging.approvalRequired', []);
  if (!contact) return true;
  if (contact.role === 'prospect') return true;
  if (!contact.clientId && contact.role !== 'founder') return true;
  if (category && required.includes(category)) return true;
  if (aiGenerated && !ctx.setting('messaging.autoSendRoutine', true)) return true;
  if (aiGenerated && category !== 'routine') return true;
  return false;
}

/**
 * Create an outbound message. Humans sending from the composer skip approval
 * for their own words unless the contact is a prospect being contacted for
 * the first time; AI drafts follow the policy above.
 */
function createOutbound({ conversationId, contactId, channel, body, subject, aiGenerated = false, agent, category = 'routine', sendAt, actor = 'user', attachments = [], skipApproval = false }) {
  let conv = conversationId ? ctx.store.get('conversations', conversationId) : null;
  const contact = ctx.store.get('contacts', contactId || conv?.contactId);
  if (!contact) throw new Error('Contact not found');
  if (!conv) conv = ensureConversation(contact);
  channel = channel || (contact.preferredChannel) || (contact.phones?.length ? 'sms' : 'email');
  if (channel === 'sms' && !contact.phones?.length) throw new Error(`${contact.name} has no phone number`);
  if (channel === 'email' && !contact.emails?.length) throw new Error(`${contact.name} has no email address`);
  if (contact.optedOut?.[channel]) throw new Error(`${contact.name} opted out of ${channel === 'sms' ? 'texts' : 'email'}`);
  const firstContact = !ctx.store.find('messages', (m) => m.contactId === contact.id && m.direction === 'in');
  const approval = !skipApproval && (aiGenerated ? needsApproval({ contact, category, aiGenerated }) : (contact.role === 'prospect' && firstContact));
  const msg = addMessage(conv, {
    direction: 'out', channel, body, subject: channel === 'email' ? (subject || defaultSubject(conv)) : undefined, aiGenerated, agent: agent || null, category,
    status: approval ? 'pending_approval' : 'queued', sendAt: sendAt || null, createdBy: actor, attachments,
  });
  if (approval) {
    const a = ctx.store.insert('approvals', { kind: 'message', refId: msg.id, clientId: conv.clientId || null, title: `${aiGenerated ? 'AI draft' : 'Message'} to ${contact.name}`, summary: body.slice(0, 240), status: 'pending', stage: 'internal', category, createdBy: actor });
    ctx.store.update('messages', msg.id, { approvalId: a.id });
    events.publish('approval', a);
  } else {
    scheduleSend(msg);
  }
  audit.log(actor, approval ? 'message.awaiting_approval' : 'message.queued', { messageId: msg.id, clientId: conv.clientId, to: contact.name, channel, aiGenerated, category });
  return ctx.store.get('messages', msg.id);
}

function defaultSubject(conv) {
  const lastIn = ctx.store.all('messages', (m) => m.conversationId === conv.id && m.subject).pop();
  if (lastIn?.subject) return /^re:/i.test(lastIn.subject) ? lastIn.subject : `Re: ${lastIn.subject}`;
  return ctx.setting('agency.name', 'Euclidean Media');
}

function scheduleSend(msg) {
  const runAt = [msg.sendAt, inQuietHours() ? nextAllowedTime() : null, now()].filter(Boolean).sort().pop();
  if (runAt > now()) ctx.store.update('messages', msg.id, { status: 'scheduled', sendAt: runAt });
  queue.enqueue('message.send', { messageId: msg.id }, { runAt, clientId: msg.clientId, dedupeKey: `send:${msg.id}`, priority: 8, title: 'Send message' });
}

function approveMessage(messageId, actor, editedBody) {
  const msg = ctx.store.get('messages', messageId);
  if (!msg || msg.status !== 'pending_approval') throw new Error('Message is not awaiting approval');
  ctx.store.update('messages', messageId, { status: 'queued', body: editedBody || msg.body, approvedBy: actor, approvedAt: now() });
  if (msg.approvalId) ctx.store.update('approvals', msg.approvalId, { status: 'approved', decidedBy: actor, decidedAt: now() });
  audit.log(actor, 'message.approved', { messageId, clientId: msg.clientId });
  scheduleSend(ctx.store.get('messages', messageId));
  events.publish('message', ctx.store.get('messages', messageId));
}
function rejectMessage(messageId, actor) {
  const msg = ctx.store.get('messages', messageId); if (!msg) return;
  ctx.store.update('messages', messageId, { status: 'discarded' });
  if (msg.approvalId) ctx.store.update('approvals', msg.approvalId, { status: 'rejected', decidedBy: actor, decidedAt: now() });
  audit.log(actor, 'message.discarded', { messageId, clientId: msg.clientId });
  events.publish('message', ctx.store.get('messages', messageId));
}

/** Job handler: deliver one message, re-checking every safeguard at send time. */
async function deliver(job, h) {
  const msg = ctx.store.get('messages', job.payload.messageId);
  if (!msg) return { skipped: 'message deleted' };
  if (['sent', 'discarded', 'pending_approval'].includes(msg.status)) return { skipped: msg.status };
  if (queue.paused) throw Object.assign(new Error('Emergency stop is active'), { permanent: false });
  const contact = ctx.store.get('contacts', msg.contactId);
  if (!contact) throw Object.assign(new Error('Contact missing'), { permanent: true });
  if (contact.optedOut?.[msg.channel]) { ctx.store.update('messages', msg.id, { status: 'failed', error: 'Recipient opted out' }); return { skipped: 'opted out' }; }
  if (inQuietHours()) { const t = nextAllowedTime(); ctx.store.update('jobs', job.id, {}); throw Object.assign(new Error(`Quiet hours: will send at ${t}`), { deferUntil: t }); }
  const hourAgo = new Date(Date.now() - 3600000).toISOString();
  const sentLastHour = ctx.store.all('messages', (m) => m.direction === 'out' && m.status === 'sent' && (m.sentAt || '') > hourAgo).length;
  if (sentLastHour >= ctx.setting('messaging.maxOutboundPerHour', 40)) throw Object.assign(new Error('Hourly sending cap reached; sending again in 10 minutes'), { deferUntil: new Date(Date.now() + 600000).toISOString() });

  const test = ctx.setting('environment', 'test') !== 'production';
  let to = msg.channel === 'sms' ? contact.phones[0] : contact.emails[0];
  let body = msg.body;
  if (test) {
    const sb = msg.channel === 'sms' ? ctx.setting('sandbox.phone', '') : ctx.setting('sandbox.email', '');
    if (!sb) throw Object.assign(new Error(`Test environment: set a sandbox ${msg.channel === 'sms' ? 'phone number' : 'email'} in Settings → General, or switch to Production`), { permanent: true, notConnected: true });
    body = `[TEST → ${contact.name} ${to}]\n${body}`; to = sb;
  }
  h.progress(0.3, `Sending ${msg.channel.toUpperCase()}`);
  let r;
  if (msg.channel === 'sms') r = await twilio.send({ to, body });
  else {
    const prevIn = ctx.store.all('messages', (m) => m.conversationId === msg.conversationId && m.direction === 'in' && m.channel === 'email').pop();
    const sig = ctx.setting('messaging.signature', '');
    r = await email.send({ to, subject: msg.subject, text: sig ? `${body}\n\n${sig}` : body, inReplyTo: prevIn?.providerId, references: prevIn?.providerId, attachments: (msg.attachments || []).filter((a) => a.path).map((a) => ({ filename: a.name, path: a.path })) });
  }
  ctx.store.update('messages', msg.id, { status: 'sent', sentAt: now(), providerId: r.providerId, error: null, testRedirect: test || undefined });
  audit.log(msg.aiGenerated ? `agent:${msg.agent || 'ai'}` : (msg.createdBy || 'user'), 'message.sent', { messageId: msg.id, clientId: msg.clientId, channel: msg.channel, to: contact.name, test });
  events.publish('message', ctx.store.get('messages', msg.id));
  return { sent: true, providerId: r.providerId };
}

// ------------------------------------------------------------ inbound
function alreadyProcessed(key) {
  if (ctx.store.find('processed', (p) => p.key === key)) return true;
  ctx.store.insert('processed', { key });
  const all = ctx.store.data.processed; if (all.length > 20000) all.splice(0, all.length - 15000);
  return false;
}

/**
 * Record an inbound message from any channel. Idempotent per provider id.
 * @param m { channel, providerId, from, fromName?, subject?, body, at, attachments? }
 */
function receive(m) {
  if (m.providerId && alreadyProcessed(`${m.channel}:${m.providerId}`)) return null;
  let contact = findContactByAddress(m.channel === 'sms' ? { phone: m.from } : { emailAddr: m.from });
  if (!contact) {
    contact = ctx.store.insert('contacts', { name: m.fromName || m.from, phones: m.channel === 'sms' ? [twilio.normalize(m.from)] : [], emails: m.channel === 'email' ? [m.from] : [], role: 'unknown', clientId: null, optedOut: {}, source: `inbound ${m.channel}` });
    events.publish('contacts', contact);
  }
  const conv = ensureConversation(contact);
  // Email opt-out: "stop"/"unsubscribe" as the first line (or the subject) of a reply.
  const firstLine = String(m.body || '').split(/\r?\n/).find((l) => l.trim()) || '';
  if (m.channel === 'email' && (STOP_WORDS.test(firstLine) || STOP_WORDS.test(String(m.subject || '').replace(/^re:\s*/i, '')))) {
    ctx.store.update('contacts', contact.id, (c) => ({ optedOut: { ...(c.optedOut || {}), email: true } }));
    audit.log('system', 'contact.opted_out', { contactId: contact.id, clientId: contact.clientId, channel: 'email' }, 'warn');
  }
  // A reply from a prospect moves them to "Replied" and stops automatic follow-up.
  for (const pr of ctx.store.all('prospects', (x) => x.contactId === contact.id && ['new', 'drafted', 'contacted'].includes(x.stage || 'new'))) {
    ctx.store.update('prospects', pr.id, { stage: 'replied', repliedAt: now() }); events.publish('prospects', { id: pr.id });
  }
  if (m.channel === 'sms' && STOP_WORDS.test(m.body || '')) {
    ctx.store.update('contacts', contact.id, (c) => ({ optedOut: { ...(c.optedOut || {}), sms: true } }));
    audit.log('system', 'contact.opted_out', { contactId: contact.id, clientId: contact.clientId, channel: 'sms' }, 'warn');
  } else if (m.channel === 'sms' && START_WORDS.test(m.body || '') && contact.optedOut?.sms) {
    ctx.store.update('contacts', contact.id, (c) => ({ optedOut: { ...(c.optedOut || {}), sms: false } }));
  }
  const msg = addMessage(conv, { direction: 'in', channel: m.channel, body: m.body || '', subject: m.subject, status: 'received', receivedAt: m.at || now(), providerId: m.providerId, attachments: m.attachments || [], fromAddress: m.from });
  audit.log('system', 'message.received', { messageId: msg.id, clientId: contact.clientId, channel: m.channel, from: contact.name });
  events.publish('notify', { title: contact.name, body: (m.subject ? m.subject + ' — ' : '') + (m.body || '').slice(0, 120), conversationId: conv.id });

  // Client footage arriving as attachments goes straight into intake.
  if (contact.clientId) {
    for (const a of m.attachments || []) if (a.path && /\.(mp4|mov|m4v|mkv|webm|avi|mts|mxf)$/i.test(a.path)) require('./pipeline').addAsset({ clientId: contact.clientId, filePath: a.path, source: `${m.channel} from ${contact.name}`, actor: `contact:${contact.id}` });
  }
  if ((contact.role !== 'unknown' || contact.clientId) && require('../integrations/ai').anyConnected()) queue.enqueue('message.triage', { messageId: msg.id }, { clientId: contact.clientId, dedupeKey: `triage:${msg.id}`, priority: 7, title: `Triage message from ${contact.name}` });
  return msg;
}

// ------------------------------------------------------------ pollers
const pollState = { sms: { since: null, timer: null }, email: { timer: null } };
function attachmentSaver({ filename, fromEmail }, buf) {
  const contact = findContactByAddress({ emailAddr: fromEmail });
  const dir = contact?.clientId ? paths.clientDir(contact.clientId, 'inbox') : paths.tmp('unassigned-attachments');
  return email.saveTo(dir, filename, buf);
}
async function pollSms() {
  if (!twilio.configured()) return;
  const since = ctx.store.settings._smsSince || new Date(Date.now() - 864e5).toISOString();
  const msgs = await twilio.pollInbound(since);
  for (const m of msgs.sort((a, b) => a.at.localeCompare(b.at))) receive({ channel: 'sms', ...m });
  ctx.store.settings._smsSince = new Date(Date.now() - 3600000).toISOString(); ctx.store.touch();
}
async function pollEmail() {
  if (!email.configured()) return;
  const lastUid = ctx.store.settings._imapUid || 0;
  const r = await email.pollInbound(lastUid, attachmentSaver);
  for (const m of r.messages) receive({ channel: 'email', providerId: m.providerId, from: m.from, fromName: m.fromName, subject: m.subject, body: m.body, at: m.at, attachments: m.attachments });
  ctx.store.settings._imapUid = r.lastUid; ctx.store.touch();
}
function startPollers() {
  const loop = (fn, key, secsKey, def) => {
    const go = async () => {
      try { await fn(); } catch (e) { events.publish('health', { key, error: e.message }); }
      const lite = ctx.setting('resources.mode', 'full') === 'lite';
      pollState[key].timer = setTimeout(go, ctx.setting(secsKey, def) * 1000 * (lite ? 3 : 1));
    };
    pollState[key].timer = setTimeout(go, 3000);
  };
  loop(pollSms, 'sms', 'messaging.smsPollSeconds', 20);
  loop(pollEmail, 'email', 'messaging.emailPollSeconds', 60);
}

module.exports = { createOutbound, approveMessage, rejectMessage, deliver, receive, ensureConversation, commandConversation, addMessage, findContactByAddress, startPollers, pollSms, pollEmail, inQuietHours };
