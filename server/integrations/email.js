'use strict';
/**
 * Email over standard SMTP (send) and IMAP (receive). Works with Gmail and
 * Google Workspace app passwords, Outlook/Microsoft 365, Fastmail, Zoho, etc.
 * Attachments from clients are saved into that client's isolated folder.
 */
const fs = require('fs');
const path = require('path');
const secrets = require('../core/secrets');

const K = {
  address: 'global.email.address', name: 'global.email.displayName', user: 'global.email.username', pass: 'global.email.password',
  smtpHost: 'global.email.smtpHost', smtpPort: 'global.email.smtpPort', imapHost: 'global.email.imapHost', imapPort: 'global.email.imapPort',
};
const state = { lastPoll: null, lastError: null, ok: null, lastUid: 0 };

const PRESETS = {
  gmail: { smtpHost: 'smtp.gmail.com', smtpPort: '465', imapHost: 'imap.gmail.com', imapPort: '993' },
  outlook: { smtpHost: 'smtp.office365.com', smtpPort: '587', imapHost: 'outlook.office365.com', imapPort: '993' },
  fastmail: { smtpHost: 'smtp.fastmail.com', smtpPort: '465', imapHost: 'imap.fastmail.com', imapPort: '993' },
  zoho: { smtpHost: 'smtp.zoho.com', smtpPort: '465', imapHost: 'imap.zoho.com', imapPort: '993' },
};

function configured() { return ['address', 'pass', 'smtpHost', 'imapHost'].every((k) => secrets.has(K[k])); }
function cred() { return { user: secrets.get(K.user) || secrets.get(K.address), pass: secrets.get(K.pass) }; }

let transporter = null; let transporterKey = '';
function smtp() {
  const nodemailer = require('nodemailer');
  const port = Number(secrets.get(K.smtpPort) || 465);
  const key = [secrets.get(K.smtpHost), port, cred().user].join('|');
  if (!transporter || key !== transporterKey) {
    transporter = nodemailer.createTransport({ host: secrets.get(K.smtpHost), port, secure: port === 465, auth: cred(), pool: true, maxConnections: 2 });
    transporterKey = key;
  }
  return transporter;
}

async function send({ to, subject, text, html, inReplyTo, references, attachments }) {
  if (!configured()) throw new Error('Email is not connected (Settings → Connections → Email)');
  const from = secrets.get(K.name) ? `"${secrets.get(K.name)}" <${secrets.get(K.address)}>` : secrets.get(K.address);
  const info = await smtp().sendMail({ from, to, subject, text, html, inReplyTo, references, attachments });
  state.ok = true; state.lastError = null;
  return { providerId: info.messageId };
}

/**
 * Pull new messages from INBOX since the last seen UID. Returns parsed mail.
 * saveAttachment(meta, buffer) decides where attachments go.
 */
async function pollInbound(lastUid, saveAttachment) {
  if (!configured()) return { messages: [], lastUid };
  const { ImapFlow } = require('imapflow');
  const { simpleParser } = require('mailparser');
  const client = new ImapFlow({ host: secrets.get(K.imapHost), port: Number(secrets.get(K.imapPort) || 993), secure: true, auth: cred(), logger: false });
  const out = [];
  let maxUid = lastUid || 0;
  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      const status = client.mailbox;
      // First run: only look back over the last 50 messages instead of the whole mailbox.
      const startUid = lastUid ? lastUid + 1 : Math.max(1, (status.uidNext || 1) - 50);
      for await (const msg of client.fetch(`${startUid}:*`, { uid: true, source: true, envelope: true }, { uid: true })) {
        if (msg.uid <= (lastUid || 0)) continue;
        maxUid = Math.max(maxUid, msg.uid);
        const mail = await simpleParser(msg.source);
        const from = mail.from?.value?.[0] || {};
        const atts = [];
        for (const a of mail.attachments || []) {
          if (a.size > 200 * 1024 * 1024) continue;
          const saved = saveAttachment ? await saveAttachment({ filename: a.filename, contentType: a.contentType, size: a.size, fromEmail: (from.address || '').toLowerCase() }, a.content) : null;
          atts.push({ name: a.filename, size: a.size, type: a.contentType, path: saved });
        }
        out.push({
          providerId: mail.messageId || `uid-${msg.uid}`, uid: msg.uid, from: (from.address || '').toLowerCase(), fromName: from.name || '',
          to: (mail.to?.value || []).map((v) => v.address), subject: mail.subject || '', body: (mail.text || '').trim(), html: mail.html || null,
          at: (mail.date || new Date()).toISOString(), inReplyTo: mail.inReplyTo || null, references: mail.references || null, attachments: atts,
        });
      }
    } finally { lock.release(); }
    await client.logout();
    state.ok = true; state.lastError = null;
  } catch (e) {
    state.ok = false; state.lastError = e.message;
    try { await client.logout(); } catch { /* ignore */ }
    throw new Error(`IMAP: ${e.message}`);
  } finally { state.lastPoll = new Date().toISOString(); }
  return { messages: out, lastUid: maxUid };
}

async function test() {
  if (!configured()) return { ok: false, error: 'Address, password, SMTP host and IMAP host are required' };
  try {
    await smtp().verify();
    const { ImapFlow } = require('imapflow');
    const c = new ImapFlow({ host: secrets.get(K.imapHost), port: Number(secrets.get(K.imapPort) || 993), secure: true, auth: cred(), logger: false });
    await c.connect(); await c.logout();
    state.ok = true; state.lastError = null;
    return { ok: true };
  } catch (e) { state.ok = false; state.lastError = e.message; return { ok: false, error: e.message }; }
}

function saveTo(dir, filename, buf) {
  fs.mkdirSync(dir, { recursive: true });
  const safe = path.basename(filename || 'attachment').replace(/[^\w.\- ()]+/g, '_');
  let p = path.join(dir, safe); let n = 1;
  while (fs.existsSync(p)) { const e = path.extname(safe); p = path.join(dir, `${path.basename(safe, e)} (${n++})${e}`); }
  fs.writeFileSync(p, buf);
  return p;
}

module.exports = { K, PRESETS, configured, send, pollInbound, test, state, saveTo };
