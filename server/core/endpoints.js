'use strict';
/**
 * Every feature of the engine as a list Claude can search (the Euclidean MCP connector's find_features), with what each
 * one does (the comment above its route in api.js / agents/routes.js) and how careful it has to be:
 *   read     looks only (GET)
 *   change   works inside Euclidean (make ads, render, edit a project, add a lead...): Claude may just do it
 *   outward  reaches people or can't be undone (send/approve/post/call, delete, safety settings, keys): only through the
 *            connector's send_or_publish tool, after the person said yes. The engine refuses these from Claude's
 *            ordinary tool (index.js checks the x-euclidean-via header), so it can't slip through.
 */
const fs = require('fs');
const path = require('path');

const HIDDEN = /^\/api\/(workers|agent\/jobs|_endpoints)/; // remote workers' own plumbing
const OUTWARD = [
  /\/approve$/, /\/decide$/, /\/discard$/, /\/conversations\/[^/]+\/messages$/, /\/prospects\/[^/]+\/(contact|call|outreach)$/,
  /\/outreach\/[^/]+\/start$/, /\/autopilot-now$/, /\/hal\/confirm$/, /\/grokbots\/task$/, /\/mailbox\/send$/, /\/(un|re)schedule$/,
  /\/premiere$/, /^\/api\/(secrets|users|restore|mode|settings|command)$/, /^\/api\/agent\/command$/, /\/system\/restart$/,
  /\/credentials$/, /\/youtube\/connect$/, /\/phone\/(un)?link$/, /\/voice\/(clone|callbacks)$/, /\/agentnet\/agents\/[^/]+\/(key|token|login)$/,
  /\/agentnet\/approvals\/[^/]+\/decide$/, /\/agentnet\/pause$/,
];
function kindOf(method, pattern) {
  if (method === 'GET') return 'read';
  if (method === 'DELETE') return 'outward';
  return OUTWARD.some((rx) => rx.test(pattern)) ? 'outward' : 'change';
}

let notes = null;
/** "METHOD /path" → { about, multipart } read from the source once. */
function readNotes() {
  if (notes) return notes;
  notes = {};
  for (const f of [path.join(__dirname, '..', 'api.js'), path.join(__dirname, '..', 'agents', 'routes.js')]) {
    let lines; try { lines = fs.readFileSync(f, 'utf8').split('\n'); } catch { continue; }
    const at = []; lines.forEach((l, i) => { const m = /^\s*r\.(get|post|put|patch|del)\('([^']+)'/.exec(l); if (m) at.push({ i, method: m[1] === 'del' ? 'DELETE' : m[1].toUpperCase(), path: m[2] }); });
    at.forEach((x, n) => {
      const com = []; for (let j = x.i - 1; j >= 0 && j > x.i - 12; j--) { const t = lines[j].trim(); if (/^(\/\/|\/\*\*?|\*)/.test(t)) com.unshift(t.replace(/^(\/\/+|\/\*\*?|\*\/?)\s?/, '').replace(/\*\/$/, '').trim()); else break; }
      const body = lines.slice(x.i, n + 1 < at.length ? at[n + 1].i : x.i + 40).join('\n');
      notes[`${x.method} ${x.path}`] = { about: com.filter(Boolean).join(' ').slice(0, 400), multipart: /receiveUpload\(/.test(body), fileName: /x-file-name/.test(body) };
    });
  }
  return notes;
}

function list(router, q = '') {
  const n = readNotes(); const words = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
  return router.routes.filter((r) => r.pattern && !HIDDEN.test(r.pattern)).map((r) => {
    const k = `${r.method} ${r.pattern}`; const x = n[k] || {};
    return { method: r.method, path: r.pattern, kind: kindOf(r.method, r.pattern), about: x.about || '', owner: (r.opts.roles || []).join() === 'owner' || undefined, upload: x.multipart ? 'multipart' : x.fileName || r.opts.raw ? 'raw' : undefined };
  }).filter((e) => !words.length || words.every((w) => `${e.method} ${e.path} ${e.about}`.toLowerCase().includes(w)));
}

/** How careful a request has to be, from the route it lands on. */
function classify(router, method, pathname) { const m = router.match(method, pathname); return m ? kindOf(method, m.route.pattern) : null; }

module.exports = { list, classify, kindOf, OUTWARD };
