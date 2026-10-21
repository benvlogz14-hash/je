'use strict';
/** House rules shared by every outreach lane (creators and political). */
const ctx = require('../core/ctx');

/** Never use em dashes in outreach copy (house style). */
function noDashes(s) {
  return String(s || '').replace(/\s*—\s*/g, ', ').replace(/\s–\s/g, ' - ').replace(/–/g, '-').replace(/,\s*,/g, ',');
}

function mailingAddress() {
  return String(ctx.setting('outreach.mailingAddress', '') || ctx.setting('political.mailingAddress', '') || '').trim();
}

/** Every commercial email carries an opt-out line and the sender's postal address (CAN-SPAM). */
function withFooter(body) {
  let b = noDashes(String(body || '').trim());
  if (!/\bstop\b|unsubscribe|opt[\s-]?out|rather not hear/i.test(b)) b += `\n\nIf you'd rather not hear from us, just reply "stop" and we won't email again.`;
  const addr = mailingAddress();
  if (addr && !b.includes(addr.split('\n')[0])) b += `\n\n${ctx.setting('agency.name', 'Euclidean Media')} · ${addr.replace(/\n+/g, ', ')}`;
  return b;
}

/** Government addresses (federal, state, local) are never pitched. */
const isGov = (email) => /\.gov$|\.gov\.|\.state\.[a-z]{2}\.us$|\.[a-z]{2}\.us$|\.mil$/i.test(String(email || '').split('@')[1] || '');

/** Names, organisations or email domains on the exclusions list are never contacted. */
function excluded({ name, email, handle } = {}) {
  const lines = String(ctx.setting('outreach.exclusions', '') || '').split(/\r?\n/).map((l) => l.trim().toLowerCase()).filter(Boolean);
  if (!lines.length) return null;
  const hay = [name, email, handle, String(email || '').split('@')[1]].filter(Boolean).map((x) => String(x).toLowerCase());
  return lines.find((l) => hay.some((h) => h === l || h.includes(l))) || null;
}

module.exports = { noDashes, withFooter, isGov, excluded, mailingAddress };
