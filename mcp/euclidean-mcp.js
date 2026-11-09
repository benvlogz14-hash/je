#!/usr/bin/env node
'use strict';
/**
 * Euclidean MCP connector: lets Claude (the Claude desktop app or Claude Code on the same PC) talk to the running
 * Euclidean app. It speaks the Model Context Protocol over stdin/stdout (JSON-RPC 2.0, one message per line) and calls
 * the engine's own API with the owner's pass code, which the engine writes to <data>/connect.json when it starts.
 *
 * What Claude can do through it: see what's running and why something stopped (jobs, logs, health), look at the
 * political candidates and their ad runs, start or re-run "Make the ads", retry or cancel a job, pause or resume the
 * work queue, and read the drafts waiting in Approvals. It can't approve, send, post or delete anything: those stay
 * with a person in the app.
 *
 * No libraries needed: run it with the Node that Start Euclidean.bat installs.
 *   node "C:\path\to\Euclidean\mcp\euclidean-mcp.js"
 * Finds the engine through EUCLIDEAN_URL + EUCLIDEAN_TOKEN, else connect.json in EUCLIDEAN_DATA, the desktop app's data
 * folder (%APPDATA%\Euclidean\data on Windows) or ~/.euclidean.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

// ------------------------------------------------------------------ finding the engine
function connection() {
  if (process.env.EUCLIDEAN_URL && process.env.EUCLIDEAN_TOKEN) return { url: process.env.EUCLIDEAN_URL.replace(/\/$/, ''), token: process.env.EUCLIDEAN_TOKEN };
  const dirs = [process.env.EUCLIDEAN_DATA,
    process.env.APPDATA && path.join(process.env.APPDATA, 'Euclidean', 'data'),
    path.join(os.homedir(), 'Library', 'Application Support', 'Euclidean', 'data'),
    path.join(os.homedir(), '.config', 'Euclidean', 'data'),
    path.join(os.homedir(), '.euclidean')].filter(Boolean);
  for (const d of dirs) {
    try { const c = JSON.parse(fs.readFileSync(path.join(d, 'connect.json'), 'utf8')); if (c.url && c.token) return { url: c.url, token: c.token, dir: d }; } catch { /* next */ }
  }
  throw new Error("Can't find Euclidean. Open the Euclidean app first (it writes its connection details when it starts), then try again.");
}

async function call(method, route, body) {
  const c = connection();
  let res;
  try {
    res = await fetch(`${c.url}${route}`, { method, headers: { authorization: `Bearer ${c.token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) });
  } catch { throw new Error(`Euclidean isn't answering at ${c.url}. Is the app open?`); }
  const text = await res.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) throw new Error(`Euclidean said ${res.status}: ${data?.error || String(text).slice(0, 300)}`);
  return data;
}
const get = (r) => call('GET', r);
const post = (r, b = {}) => call('POST', r, b);

// ------------------------------------------------------------------ tools
const brief = (j) => ({ id: j.id, type: j.type, title: j.title, status: j.status, progress: Math.round((j.progress || 0) * 100) + '%', note: j.note || '', error: j.error || null, created: j.createdAt, finished: j.finishedAt || null });
const candidate = (p) => ({
  id: p.id, name: p.name, office: p.pkg?.profile?.office || p.office || p.location || '', stage: p.stage || 'new',
  package: p.pkg?.status || 'not started', error: p.pkg?.error || null, noAds: p.pkg?.noAds || null,
  ads: Object.keys(p.pkg?.files || {}).filter((k) => ['v', 'h', 'hl', 's'].includes(k)),
  footage: { uploaded: (p.footageUploads || []).length, ticked: (p.footageUploads || []).filter((u) => !u.off).length, links: [].concat(p.footageLinks || []).length },
  look: p.pkg?.proLook?.name || null, videoLink: p.videoLink || null, email: p.publicContact || p.kit?.card?.email || null,
});

const TOOLS = [
  { name: 'status', description: "Euclidean's overall state: version, the work queue (running, waiting, paused), what's blocking production (missing tools, Lite mode, low memory) and the latest problems.",
    inputSchema: { type: 'object', properties: {} },
    run: async () => {
      const [boot, q, h, running] = await Promise.all([get('/api/bootstrap').catch(() => ({})), get('/api/queue/stats'), get('/api/production/health').catch(() => null), get('/api/jobs?status=running,queued&limit=30')]);
      return { version: boot.version || null, commit: boot.sha || null, queue: q, health: h, working: (running || []).map(brief) };
    } },
  { name: 'list_jobs', description: 'Recent jobs (renders, transcripts, ad packages, exports...) with their status and errors. status: any of running, queued, done, failed, canceled (comma separated).',
    inputSchema: { type: 'object', properties: { status: { type: 'string' }, limit: { type: 'number' } } },
    run: async ({ status = '', limit = 30 }) => (await get(`/api/jobs?limit=${Math.min(200, Number(limit) || 30)}${status ? `&status=${encodeURIComponent(status)}` : ''}`)).map(brief) },
  { name: 'get_job', description: "One job in full, with its log (the best place to see why it failed).",
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    run: async ({ id }) => { const j = await get(`/api/jobs/${encodeURIComponent(id)}`); return { ...brief(j), payload: j.payload, attempts: j.attempts, log: (j.log || []).slice(-60) }; } },
  { name: 'retry_job', description: 'Run a failed job again.', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    run: async ({ id }) => brief(await post(`/api/jobs/${encodeURIComponent(id)}/retry`)) },
  { name: 'cancel_job', description: 'Stop a running or waiting job.', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    run: async ({ id }) => brief(await post(`/api/jobs/${encodeURIComponent(id)}/cancel`)) },
  { name: 'pause_queue', description: 'Pause all background work (renders, ads, transcripts).', inputSchema: { type: 'object', properties: {} }, run: async () => post('/api/queue/pause') },
  { name: 'resume_queue', description: 'Resume background work.', inputSchema: { type: 'object', properties: {} }, run: async () => post('/api/queue/resume') },
  { name: 'activity_log', description: "Euclidean's activity log, newest first (errors, warnings, what ran). Optional search words and level (info, warn, error).",
    inputSchema: { type: 'object', properties: { q: { type: 'string' }, level: { type: 'string' }, limit: { type: 'number' } } },
    run: async ({ q = '', level = '', limit = 60 }) => get(`/api/logs?limit=${Math.min(300, Number(limit) || 60)}${q ? `&q=${encodeURIComponent(q)}` : ''}${level ? `&level=${encodeURIComponent(level)}` : ''}`) },
  { name: 'list_candidates', description: 'Political candidates (Politics page): their package status, why ads were not made, which ads exist, footage counts and look. Optional name filter.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' } } },
    run: async ({ name = '' }) => { const all = await get('/api/prospects'); const list = (Array.isArray(all) ? all : all.items || []).filter((p) => p.type === 'political' && (!name || p.name.toLowerCase().includes(name.toLowerCase()))); return list.slice(0, 100).map(candidate); } },
  { name: 'candidate_runs', description: "A candidate's last ad runs: what each step did, the reason it stopped, what a waiting run waits for, and the log.",
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    run: async ({ id }) => { const r = await get(`/api/prospects/${encodeURIComponent(id)}/runs`); return { ...r, steps: Object.entries(r.pkgSteps || {}).map(([k, v]) => ({ step: (r.steps.find((s) => s.key === k) || {}).label || k, status: v.status, note: v.note || v.error || '', at: v.at })), pkgSteps: undefined }; } },
  { name: 'list_looks', description: 'The ad styles (looks) that can be used for a candidate.', inputSchema: { type: 'object', properties: {} },
    run: async () => { const l = await get('/api/political/looks'); return (l.presets || []).map((x) => ({ id: x.id, name: x.name, about: x.about })); } },
  { name: 'make_ads', description: "Press Make the ads for a candidate: with a look id (preset) or a described style (prompt), or neither to remake from their footage. Starts a background job; check candidate_runs for progress.",
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, preset: { type: 'string' }, prompt: { type: 'string' } }, required: ['id'] },
    run: async ({ id, preset, prompt }) => brief(prompt || preset ? await post(`/api/prospects/${encodeURIComponent(id)}/look`, prompt ? { prompt } : { preset }) : await post(`/api/prospects/${encodeURIComponent(id)}/package`, { from: 'footage' })) },
  { name: 'list_drafts', description: 'Drafts waiting in Approvals (emails, texts, clips). Read only: approving and sending stay with a person in the app.',
    inputSchema: { type: 'object', properties: { limit: { type: 'number' } } },
    run: async ({ limit = 30 }) => { const a = await get('/api/approvals?status=pending'); return (Array.isArray(a) ? a : a.items || []).slice(0, Number(limit) || 30).map((x) => ({ id: x.id, kind: x.kind, title: x.title, summary: x.summary, created: x.createdAt })); } },
];

// ------------------------------------------------------------------ the protocol (JSON-RPC 2.0 over stdio, one message per line)
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

async function handle(m) {
  if (m.method === 'initialize') return reply(m.id, { protocolVersion: m.params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'euclidean', version: '1.0.0' }, instructions: 'Tools for the Euclidean app running on this PC: check jobs, logs and health, look at political candidates and their ad runs, and start Make the ads. Nothing here approves or sends messages.' });
  if (m.method === 'ping') return reply(m.id, {});
  if (m.method === 'tools/list') return reply(m.id, { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
  if (m.method === 'tools/call') {
    const t = TOOLS.find((x) => x.name === m.params?.name);
    if (!t) return fail(m.id, -32602, `Unknown tool ${m.params?.name}`);
    try { const out = await t.run(m.params?.arguments || {}); return reply(m.id, { content: [{ type: 'text', text: typeof out === 'string' ? out : JSON.stringify(out, null, 1) }] }); }
    catch (e) { return reply(m.id, { content: [{ type: 'text', text: e.message }], isError: true }); }
  }
  if (m.id !== undefined) return fail(m.id, -32601, `Method not found: ${m.method}`);
  // notifications (initialized, cancelled...) need no answer
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk; let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    let m; try { m = JSON.parse(line); } catch { fail(null, -32700, 'Parse error'); continue; }
    handle(m).catch((e) => m.id !== undefined && fail(m.id, -32603, e.message));
  }
});
process.stdin.on('end', () => process.exit(0));
