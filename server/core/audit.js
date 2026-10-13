'use strict';
/**
 * Append-only audit log. Every automated or human action that touches the
 * outside world (messages, publishing, credential changes, approvals) is
 * written to logs/audit-YYYY-MM.jsonl and mirrored in memory for the UI.
 */
const fs = require('fs');
const path = require('path');
const paths = require('./paths');
const events = require('./events');
const { now, id } = require('./util');

const recent = [];
const MAX = 3000;

function file() { return path.join(paths.logs(), `audit-${new Date().toISOString().slice(0, 7)}.jsonl`); }

function loadRecent() {
  try {
    const files = fs.readdirSync(paths.logs()).filter((f) => f.startsWith('audit-')).sort().slice(-2);
    for (const f of files) {
      for (const line of fs.readFileSync(path.join(paths.logs(), f), 'utf8').split('\n')) {
        if (!line) continue;
        try { recent.push(JSON.parse(line)); } catch { /* skip partial line */ }
      }
    }
    while (recent.length > MAX) recent.shift();
  } catch { /* first run */ }
}

/**
 * @param actor  'ryan' | 'ben' | 'agent:claude' | 'system' | 'portal:<client>' ...
 * @param action short verb, e.g. 'message.sent', 'publish.scheduled'
 * @param level  'info' | 'warn' | 'error'
 */
function log(actor, action, detail = {}, level = 'info') {
  const entry = { id: id('au_'), at: now(), actor, action, level, clientId: detail.clientId || null, detail };
  recent.push(entry);
  if (recent.length > MAX) recent.shift();
  try { fs.appendFileSync(file(), JSON.stringify(entry) + '\n'); } catch (e) { console.error('[audit] write failed', e.message); }
  events.publish('audit', entry);
  return entry;
}

function query({ clientId, level, q, limit = 300 } = {}) {
  let r = recent;
  if (clientId) r = r.filter((e) => e.clientId === clientId);
  if (level) r = r.filter((e) => e.level === level);
  if (q) { const s = q.toLowerCase(); r = r.filter((e) => (e.action + ' ' + e.actor + ' ' + JSON.stringify(e.detail)).toLowerCase().includes(s)); }
  return r.slice(-limit).reverse();
}

module.exports = { log, query, loadRecent };
