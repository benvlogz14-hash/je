/**
 * The mailbox for the bots and Claude's connector: read and search the inbox (what messaging.receive saved from the
 * outreach mailbox over IMAP), read whole threads, check for new mail now, and write email drafts. A draft always
 * waits in Approvals: nothing here sends (a person approves it, and delivery still checks opt-outs, quiet hours,
 * the hourly cap and Test mode).
 */
const ctx = require('../core/ctx');
const audit = require('../core/audit');
const events = require('../core/events');
const { noDashes } = require('../outreach/common');

const day = (s) => { try { return new Date(s).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); } catch { return ''; } };
const AUTO = /auto.?reply|automatic(ally)? reply|automated (message|response)|out of (the )?office|thank you for (contacting|reaching out to|your email|emailing)|(we|i) receive (a )?(many|large number|high volume)|try to respond to as many|will respond (to you )?(as soon|from this)|this (inbox|mailbox) is (not )?monitored|do not reply|noreply|no-reply|mailer-daemon|delivery status|undeliverable/i;

function who(m) {
  const conv = ctx.store.get('conversations', m.conversationId); const c = conv && ctx.store.get('contacts', conv.contactId);
  return { name: c?.name || m.fromName || '', email: m.fromAddress || c?.emails?.[0] || '', contactId: c?.id || null, conversationId: conv?.id || null };
}

/** Email messages, newest first: { id, at, direction, from/to, subject, preview, status, auto, conversationId }. */
function inbox({ query = '', days = 14, unread = false, direction = 'in', limit = 25 } = {}) {
  const since = new Date(Date.now() - Math.max(1, Number(days) || 14) * 86400e3).toISOString();
  const q = String(query || '').toLowerCase().trim(); const words = q.split(/\s+/).filter((w) => w.length > 1);
  const convUnread = new Set(ctx.store.all('conversations').filter((c) => c.unread > 0).map((c) => c.id));
  const out = [];
  for (const m of ctx.store.all('messages')) {
    if (m.channel !== 'email') continue;
    if (direction !== 'all' && (direction === 'in' ? m.direction !== 'in' : m.direction === 'in')) continue;
    const at = m.receivedAt || m.sentAt || m.createdAt || '';
    if (at < since) continue;
    if (unread && !convUnread.has(m.conversationId)) continue;
    const w = who(m);
    const hay = `${w.name} ${w.email} ${m.subject || ''} ${m.body || ''}`.toLowerCase();
    if (words.length && !words.every((x) => hay.includes(x))) continue;
    out.push({ id: m.id, at, when: day(at), direction: m.direction, name: w.name, email: w.email, subject: m.subject || '', preview: String(m.body || '').replace(/\s+/g, ' ').slice(0, 220), status: m.status, auto: AUTO.test(`${m.subject} ${m.body} ${w.email}`), conversationId: m.conversationId, attachments: (m.attachments || []).map((a) => a.name).filter(Boolean) });
  }
  return out.sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, Math.max(1, Math.min(100, Number(limit) || 25)));
}

/** A whole thread (by a message id or a conversation id). */
function thread(id, { limit = 20 } = {}) {
  const m = ctx.store.get('messages', id);
  const convId = m ? m.conversationId : id;
  const conv = ctx.store.get('conversations', convId); if (!conv) throw new Error('No email thread with that id.');
  const contact = ctx.store.get('contacts', conv.contactId);
  const msgs = ctx.store.all('messages').filter((x) => x.conversationId === conv.id && (x.channel === 'email' || !x.channel)).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))).slice(-limit);
  return { conversationId: conv.id, contact: contact ? { id: contact.id, name: contact.name, emails: contact.emails || [], optedOut: !!contact.optedOut?.email } : null,
    messages: msgs.map((x) => ({ id: x.id, when: day(x.receivedAt || x.sentAt || x.createdAt), direction: x.direction, status: x.status, subject: x.subject || '', body: String(x.body || '').slice(0, 6000), attachments: (x.attachments || []).map((a) => a.name).filter(Boolean) })) };
}

/** Check the mailbox now (instead of waiting for the next automatic check). */
async function check() {
  const email = require('../integrations/email');
  if (!email.configured()) return { ok: false, connected: false, message: 'The outreach mailbox is not connected yet (Settings → Connections → Email).' };
  const before = ctx.store.all('messages').filter((m) => m.direction === 'in' && m.channel === 'email').length;
  await require('./messaging').pollEmail();
  const after = ctx.store.all('messages').filter((m) => m.direction === 'in' && m.channel === 'email').length;
  return { ok: true, connected: true, newMessages: after - before };
}

/** Find (or, for a new email address, add) the contact a draft goes to. */
function contactFor(to) {
  const t = String(to || '').trim(); if (!t) throw new Error('Who is the email to? Give an email address or a contact name.');
  const addr = (/[^\s<>()"',;]+@[^\s<>()"',;]+\.[A-Za-z]{2,}/.exec(t) || [])[0];
  const m = require('./messaging');
  if (addr) {
    const found = m.findContactByAddress({ emailAddr: addr }); if (found) return found;
    const name = t.replace(addr, '').replace(/[<>"]/g, '').trim() || addr.split('@')[0];
    const lead = ctx.store.find('prospects', (p) => String(p.email || '').toLowerCase() === addr.toLowerCase());
    return ctx.store.insert('contacts', { name: lead?.name || name, emails: [addr], phones: [], role: lead ? 'prospect' : 'contact', prospectId: lead?.id || null, clientId: null, createdBy: 'mailbox' });
  }
  const low = t.toLowerCase();
  const c = ctx.store.find('contacts', (x) => String(x.name || '').toLowerCase() === low) || ctx.store.find('contacts', (x) => String(x.name || '').toLowerCase().includes(low) && (x.emails || []).length);
  if (c) return c;
  const lead = ctx.store.find('prospects', (p) => String(p.name || '').toLowerCase().includes(low) && p.email);
  if (lead) return contactFor(`${lead.name} <${lead.email}>`);
  throw new Error(`No email address on file for "${t}". Give the address.`);
}

/**
 * Write an email draft (Approvals; never sent from here). `replyTo` = a message id to answer in its thread.
 * `attach` = a document id or title from the Documents list.
 */
function draft({ to, subject = '', body, replyTo = null, attach = null, by = 'bot', note = '' } = {}) {
  const text = noDashes(String(body || '').trim()); if (!text) throw new Error('The draft needs a body.');
  const m = require('./messaging');
  let conversationId = null; let contact;
  if (replyTo) { const prev = ctx.store.get('messages', replyTo); if (!prev) throw new Error('No message with that id to reply to.'); conversationId = prev.conversationId; const conv = ctx.store.get('conversations', conversationId); contact = conv && ctx.store.get('contacts', conv.contactId); if (!subject && prev.subject) subject = /^re:/i.test(prev.subject) ? prev.subject : `Re: ${prev.subject}`; }
  if (!contact) contact = contactFor(to);
  if (contact.optedOut?.email) throw new Error(`${contact.name} opted out of email. No draft written.`);
  const msg = m.createOutbound({ conversationId, contactId: contact.id, channel: 'email', subject: noDashes(String(subject || '').slice(0, 200)), body: text, aiGenerated: true, actor: by, category: 'bot_draft', approvalNote: note || `Drafted by ${String(by).replace(/^bot:/, '')}. Waiting for a person to approve.` });
  let attached = null;
  if (attach) { try { attached = require('../docs').attach(resolveDoc(attach), { messageId: msg.id, by }).attached; } catch (e) { attached = `not attached: ${e.message}`; } }
  audit.log(by, 'mailbox.drafted', { messageId: msg.id, to: contact.name });
  events.publish('approvals', {});
  return { messageId: msg.id, to: contact.name, email: contact.emails?.[0] || '', status: ctx.store.get('messages', msg.id).status, attached };
}
function resolveDoc(x) {
  const D = require('../docs'); const d = D.get(x) || D.list({ q: String(x) })[0];
  if (!d) throw new Error(`No document called "${x}".`);
  return d.id;
}

module.exports = { AUTO, inbox, thread, check, draft, contactFor, resolveDoc };
