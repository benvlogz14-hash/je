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

// Installed as a Claude extension, this file is a copy frozen at install time. The app writes where its own copy lives
// (connect.json → mcp), so the extension runs that one: every Euclidean update reaches Claude with no re-install
// (Claude picks it up the next time it starts).
if (!process.env.EUCLIDEAN_MCP_INNER) {
  for (const d of dataDirs()) {
    try {
      const c = JSON.parse(fs.readFileSync(path.join(d, 'connect.json'), 'utf8'));
      if (c.mcp && fs.existsSync(c.mcp) && path.resolve(c.mcp) !== path.resolve(__filename)) { process.env.EUCLIDEAN_MCP_INNER = '1'; require(c.mcp); return; }
      break;
    } catch { /* next */ }
  }
}
function dataDirs() {
  return [process.env.EUCLIDEAN_DATA,
    process.env.APPDATA && path.join(process.env.APPDATA, 'Euclidean', 'data'),
    path.join(os.homedir(), 'Library', 'Application Support', 'Euclidean', 'data'),
    path.join(os.homedir(), '.config', 'Euclidean', 'data'),
    path.join(os.homedir(), '.euclidean')].filter(Boolean);
}

// ------------------------------------------------------------------ finding the engine
function connection() {
  if (process.env.EUCLIDEAN_URL && process.env.EUCLIDEAN_TOKEN) return { url: process.env.EUCLIDEAN_URL.replace(/\/$/, ''), token: process.env.EUCLIDEAN_TOKEN };
  for (const d of dataDirs()) {
    try { const c = JSON.parse(fs.readFileSync(path.join(d, 'connect.json'), 'utf8')); if (c.url && c.token) return { url: c.url, token: c.token, dir: d }; } catch { /* next */ }
  }
  throw new Error("Can't find Euclidean. Open the Euclidean app first (it writes its connection details when it starts), then try again.");
}

async function call(method, route, body, { via = 'claude', timeout = 60000 } = {}) {
  const c = connection();
  let res;
  try {
    res = await fetch(`${c.url}${route}`, { method, headers: { authorization: `Bearer ${c.token}`, 'content-type': 'application/json', 'x-euclidean-via': via }, body: body && method !== 'GET' ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeout) });
  } catch { throw new Error(`Euclidean isn't answering at ${c.url}. Is the app open?`); }
  const type = res.headers.get('content-type') || '';
  if (res.ok && !/json|text/.test(type)) return { file: true, type, bytes: Number(res.headers.get('content-length')) || null, note: 'This is a file (video, image or download). Open it in the app, or use show_in_app.' };
  const text = await res.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) throw new Error(`Euclidean said ${res.status}: ${data?.error || String(text).slice(0, 300)}`);
  return data;
}
const get = (r) => call('GET', r);
const post = (r, b = {}) => call('POST', r, b);
const patch = (r, b = {}) => call('PATCH', r, b);

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

  // ---------------------------------------------------------------- HAL's chat with Claude
  { name: 'hal_inbox', description: "Messages left for you (Claude) in HAL's chat inside Euclidean, not answered yet: Ryan's (\"@claude ...\") and questions from Euclidean's bots (from says which; answering one with reply_in_hal and its replyTo sends the answer back to that bot, which carries on with its job), plus the recent chat between Ryan, HAL and Claude. Check it when Ryan says to check HAL's inbox, or at the start of a session.",
    annotations: { readOnlyHint: true }, inputSchema: { type: 'object', properties: {} },
    run: async () => get('/api/hal/claude-inbox') },
  { name: 'reply_in_hal', description: "Post in HAL's chat inside Euclidean, as Claude (Ryan reads it in HAL's panel; HAL's notebook keeps what's worth keeping). Use it (1) to answer what Ryan left in hal_inbox (replyTo = that message's id), and (2) to keep HAL's chat a copy of this conversation: after each answer you give Ryan here about Euclidean, call it with your answer as text and Ryan's message as asked. To ask HAL something and get his answer, use talk_to_hal instead.",
    inputSchema: { type: 'object', properties: { text: { type: 'string', description: 'Your answer, as you gave it to Ryan.' }, asked: { type: 'string', description: "Ryan's message to you in this chat, word for word." }, replyTo: { type: 'string', description: 'The hal_inbox message id you are answering.' } }, required: ['text'] },
    run: async ({ text, replyTo, asked }) => post('/api/hal/claude-reply', { text, replyTo, asked }) },

  // ---------------------------------------------------------------- the notebook (what Euclidean and HAL have learned)
  { name: 'notebook_recall', description: "Euclidean's notebook (HAL's memory): what the app has learned, as dated notes with their source: every lead and client (one living note each), scouts and imports, replies, emails, finished ads, clip approvals and rejections with the reason, news from HAL's watch, his lookups, and notes people or Claude added. Give a search or a name; empty = newest. Read it before writing to or about someone.",
    annotations: { readOnlyHint: true },
    inputSchema: { type: 'object', properties: { search: { type: 'string' }, about: { type: 'string', description: 'A person or client name.' }, kind: { type: 'string', enum: ['fact', 'event', 'lesson', 'news', 'lookup', 'note'] }, limit: { type: 'number' } } },
    run: async ({ search = '', about = '', kind = '', limit = 25 }) => (await get(`/api/hal/memory?q=${encodeURIComponent(search)}&about=${encodeURIComponent(about)}&kind=${kind}&limit=${Math.min(200, Number(limit) || 25)}`)).map((n) => ({ id: n.id, at: n.at, kind: n.kind, about: n.about, text: n.text, source: n.source, link: n.link || undefined, pinned: n.pinned || undefined, key: n.key || undefined })) },
  { name: 'notebook_learn', description: "Teach Euclidean something so HAL and the app use it from now on: a fact you found (with its link), a lesson (what worked, what the founders like), a note about a lead or client. Only things that are true and sourced. To correct a note, pass its id and the new text (the old text is kept in its history); pinned keeps it forever; ttl_days makes passing news expire.",
    inputSchema: { type: 'object', properties: { text: { type: 'string' }, about: { type: 'array', items: { type: 'string' } }, kind: { type: 'string', enum: ['fact', 'lesson', 'note', 'news', 'event'] }, link: { type: 'string' }, id: { type: 'string', description: 'Correct this note instead of adding one.' }, pinned: { type: 'boolean' }, ttl_days: { type: 'number' } }, required: ['text'] },
    run: async ({ text, about, kind, link, id, pinned, ttl_days: ttlDays }) => (id ? call('PATCH', `/api/hal/memory/${encodeURIComponent(id)}`, { text, about, kind, link, pinned, ttlDays }) : post('/api/hal/memory', { text, about, kind: kind || 'note', link, pinned, ttlDays })) },

  // ---------------------------------------------------------------- everything else in the app
  { name: 'find_features', description: "Search everything Euclidean can do (about 300 features: clients, footage, clips, Studio projects, Quick cut, music, political leads and ads, outreach, messages, approvals, finance, analytics, SEO lab, HAL, settings, setup). Give a few words (e.g. 'studio export', 'prospect footage', 'invoice'); empty lists all. Each result: method, path, kind (read = looks only, change = works inside Euclidean, outward = sends/approves/posts/deletes and needs the person's OK), what it does, and upload type if it takes a file. Then call it with use_feature, look, or send_or_publish.",
    annotations: { readOnlyHint: true },
    inputSchema: { type: 'object', properties: { search: { type: 'string' } } },
    run: async ({ search = '' }) => { const l = await get(`/api/_endpoints?q=${encodeURIComponent(search)}`); return l.length ? l.map((e) => `${e.method} ${e.path} [${e.kind}${e.upload ? `, upload ${e.upload}` : ''}]${e.about ? ` ${e.about}` : ''}`).join('\n') : 'Nothing matches. Try fewer or other words.'; } },
  { name: 'look', description: 'Read anything in Euclidean (a GET path from find_features, with ids and ?query filled in), e.g. /api/clients, /api/prospects/<id>, /api/clips?status=review, /api/projects/<id>.',
    annotations: { readOnlyHint: true },
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    run: async ({ path: p }) => clip(await get(route(p))) },
  { name: 'use_feature', description: "Do something inside Euclidean (a POST/PUT/PATCH path whose kind is change): make clips, render, edit a Studio project, add or update a lead, make ads, start transcripts, change a clip's captions, run a scout, draft an email (drafts wait in Approvals)... The engine refuses anything that sends, approves, posts or deletes: use send_or_publish for those.",
    inputSchema: { type: 'object', properties: { method: { type: 'string', enum: ['POST', 'PUT', 'PATCH'] }, path: { type: 'string' }, body: { type: 'object' } }, required: ['method', 'path'] },
    run: async ({ method, path: p, body }) => clip(await call(String(method).toUpperCase(), route(p), body || {})) },
  { name: 'send_or_publish', description: "For things that reach people or can't be undone (kind outward): approve or send a message or email, approve or publish a clip, call, start outreach autopilot, press a HAL Confirm button, delete anything, change safety settings or keys. ONLY after the person has said yes in this chat to this exact action: first tell them exactly what will happen (who gets what), wait for their yes, then call this with their words in person_said.",
    annotations: { destructiveHint: true, openWorldHint: true },
    inputSchema: { type: 'object', properties: { method: { type: 'string', enum: ['POST', 'PUT', 'PATCH', 'DELETE'] }, path: { type: 'string' }, body: { type: 'object' }, person_said: { type: 'string', description: "The person's own words agreeing to this action." } }, required: ['method', 'path', 'person_said'] },
    run: async ({ method, path: p, body, person_said: ok }) => { if (!String(ok || '').trim()) throw new Error('Ask the person first and put their answer in person_said.'); return clip(await call(String(method).toUpperCase(), route(p), body || {}, { via: 'claude-approved' })); } },
  { name: 'talk_to_hal', description: "Talk to HAL, the assistant built into Euclidean (he knows the app's commands, news watch, prospects, calendar, outreach guide). His reply comes back here and shows in his panel in the app. If he offers a Confirm button, pressing it is send_or_publish POST /api/hal/confirm { id }.",
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    run: async ({ text }) => { const r = await post('/api/hal/chat', { text, context: { from: 'Claude' } }); return { hal: r.text, confirm: r.confirm ? { id: r.confirm.id, label: r.confirm.label || r.confirm.text || 'Confirm' } : null, draft: r.draft || null, page: r.navigate || null, arcade: r.arcade || null }; } },
  { name: 'show_in_app', description: 'Bring the Euclidean window forward and open a page: /messages, /production, /studio, /clipper, /growth, /approvals, /clients, /finance, /analytics, /seo, /bridge, /system, /settings (add ?query as the app uses it).',
    inputSchema: { type: 'object', properties: { page: { type: 'string' } }, required: ['page'] },
    run: async ({ page }) => post('/api/ui/navigate', { path: page.startsWith('/') ? page : `/${page}` }) },
  { name: 'upload_file', description: "Send a file from this PC into Euclidean: a video for a client's footage (/api/clients/<id>/upload), a candidate's footage (/api/prospects/<id>/footage/upload), Quick cut (/api/clipper/upload), a best short (/api/winners/upload)... Use find_features with 'upload' to see them. file = the full path on this PC.",
    inputSchema: { type: 'object', properties: { file: { type: 'string' }, to: { type: 'string' }, fields: { type: 'object', description: 'Extra form fields some uploads take.' } }, required: ['file', 'to'] },
    run: async ({ file, to, fields }) => clip(await upload(file, route(to), fields || {})) },
  // Bots (the Bots tab: Corbin the master bot, Juno the client bot, Scout, Data Bot and any added).
  { name: 'list_bots', description: "Euclidean's bots (the team that replaced the GrokBots): each bot's name, kind (master, client, scout), job, brain, computer, whether it's busy or waiting for a person's OK, and its last message.",
    inputSchema: { type: 'object', properties: {} },
    run: async () => (await get('/api/bots')).bots.map((b) => ({ id: b.id, name: b.name, kind: b.kind || 'custom', job: b.role, brain: b.brain, computer: b.computer, busy: b.busy, last: b.last, scheduled: (b.routines || []).filter((r) => r.on).map((r) => `${r.every} ${r.at}: ${r.task}`) })) },
  { name: 'ask_bot', description: "Give one of Euclidean's bots a job and wait for its answer (up to about 4 minutes): it searches the live web, reads pages, checks the Data tab, the leads board and the notebook, and can hand parts to other bots. Steps that act (adding leads, clicking on sites, running commands) wait for a person's OK on the Bots page; the result says so. bot = a name (Corbin, Juno, Scout, Data Bot) or master / client / scout.",
    inputSchema: { type: 'object', properties: { bot: { type: 'string' }, message: { type: 'string' } }, required: ['bot', 'message'] },
    run: async ({ bot, message }) => {
      const all = (await get('/api/bots')).bots; const k = String(bot).toLowerCase();
      const b = all.find((x) => x.id === bot || x.name.toLowerCase() === k) || all.find((x) => x.kind === k.replace(/\s*bot$/, '').replace('scouting', 'scout')) || all.find((x) => x.name.toLowerCase().startsWith(k));
      if (!b) throw new Error(`No bot called ${bot}. Bots: ${all.map((x) => x.name).join(', ')}`);
      const sent = await post(`/api/bots/${b.id}/send`, { text: message });
      let runId = sent.queued ? null : sent.id;
      for (let i = 0; i < 120; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const t = await get(`/api/bots/${b.id}`);
        if (!runId) { runId = (t.messages || []).find((m) => m.id === sent.messageId)?.runId || null; if (!runId) continue; }
        const r = t.runs?.[runId];
        if (!r) continue;
        const steps = (r.steps || []).filter((s) => s.tool).map((s) => `${s.tool} ${JSON.stringify(s.args || {}).slice(0, 160)}${s.waiting ? ' (WAITING FOR A PERSON)' : ''}`);
        if (r.status === 'done') return { bot: b.name, answer: r.answer, steps };
        if (r.status === 'waiting') return { bot: b.name, waiting: `It wants to ${(r.steps || []).find((s) => s.waiting)?.why || 'do something'}. A person allows or denies it on the Bots page (show_in_app /bots).`, steps };
        if (r.status === 'failed' || r.status === 'stopped') return { bot: b.name, stopped: r.error || r.note, steps };
      }
      return { bot: b.name, note: 'Still working. Its answer will be in its chat on the Bots page.' };
    } },
  // Live internet through Euclidean (free DuckDuckGo search, safe page reading).
  { name: 'web_research', description: 'Search the live web (free, through DuckDuckGo) and read the best pages: returns the results and the passages that answer the question, with links. recent: day, week, month or year.',
    inputSchema: { type: 'object', properties: { question: { type: 'string' }, pages: { type: 'number' }, recent: { type: 'string' } }, required: ['question'] },
    run: async ({ question, pages, recent }) => clip(await get(`/api/web/research?q=${encodeURIComponent(question)}&pages=${pages || 3}${recent ? `&recent=${encodeURIComponent(recent)}` : ''}`)) },
  { name: 'web_read', description: 'Read one web page as clean text (title, date, text, links), through Euclidean\'s safe reader.',
    inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
    run: async ({ url }) => clip(await get(`/api/web/read?url=${encodeURIComponent(url)}`)) },
  { name: 'google_search', description: "A real Google search through Euclidean's Serper key (about a tenth of a cent each, cached; Euclidean caps the monthly spend). type: web (default), news or videos. Use web_research (free DuckDuckGo) first for quick facts; use this for a full inquiry or to list every video of someone.",
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, type: { type: 'string', enum: ['web', 'news', 'videos'] }, recent: { type: 'string' } }, required: ['query'] },
    run: async ({ query, type, recent }) => clip(await get(`/api/web/google?q=${encodeURIComponent(query)}&type=${type === 'videos' ? 'videos' : type === 'news' ? 'news' : 'search'}${recent ? `&recent=${encodeURIComponent(recent)}` : ''}`)) },
  { name: 'find_videos', description: "Find a lead's public videos on Google's Videos tab (floor sessions, hearings, council meetings, interviews, campaign videos), only ones about them, ranked; saved on the lead for the ad machine. lead = their name or id on the leads board.",
    inputSchema: { type: 'object', properties: { lead: { type: 'string' } }, required: ['lead'] },
    run: async ({ lead }) => { const all = await get(`/api/prospects?q=${encodeURIComponent(lead)}`); const list = Array.isArray(all) ? all : all.prospects || all.items || []; const p = list.find((x) => x.id === lead) || list.find((x) => String(x.name).toLowerCase() === String(lead).toLowerCase()) || list.find((x) => String(x.name).toLowerCase().includes(String(lead).toLowerCase().trim())); if (!p) throw new Error(`${lead} is not on the leads board.`); const r = await post(`/api/prospects/${p.id}/videos/find`); return { lead: p.name, found: r.found.map((v) => ({ title: v.title, url: v.url, channel: v.channel || v.source, minutes: v.duration ? Math.round(v.duration / 60) : null, date: v.date, why: v.why })), cached: r.cached, error: r.error }; } },
  { name: 'make_ads_hands_off', description: "Start the ad machine for leads on the board, hands-off: for each it finds their videos on Google (unless footage was uploaded), downloads the best, cuts the ads from their own words, makes the one-pager and drafts the email (Approvals; nothing is sent). Skips HOLD, lost and Ryan's people; 25 at a time. Check progress with candidate_runs.",
    inputSchema: { type: 'object', properties: { names: { type: 'array', items: { type: 'string' } } }, required: ['names'] },
    run: async ({ names }) => post('/api/political/autoads', { names }) },
  // ---- batches of videos: baseline templates, typed orders, several politicians at once
  { name: 'video_templates', description: "The baseline videos the ad machine can make (About a topic, Quick video, Meet them, What they delivered, Problem then the fix, For this place, The fight, A moment, One thing explained, By the numbers, What comes next, What they believe, Who they fight for, Calling it out, Quick update, Best of the footage), each with its fill-in-the-blanks shape, plus the styles and the graphics levels.",
    inputSchema: { type: 'object', properties: {} }, run: async () => get('/api/political/templates') },
  { name: 'make_videos', description: "Make a batch of finished videos for one or more politicians, by name (a name not on the board is added; add the office after a comma, e.g. 'Anna Kelles, Assembly AD-125, NY'). Their footage is read once (what was uploaded for them, else their public videos are found and downloaded), then one video is cut per order from their own words, with graphics, sound and an automatic check. orders = one plain line per video: a topic ('housing'), a baseline plus topic ('quick video about childcare', 'intro', 'what she delivered on transit'), with optional style ('cinematic', 'to camera', 'street vlog'), 'horizontal', 'captions only' or seconds ('20 seconds'), or a whole typed prompt. With no orders, give count and it plans that many from what their footage is about. styles: a list of style ids, or 'mix' for old motion-graphics and new creator looks in turn. Nothing is sent or posted: the files wait in the Ad machine's Videos tab. Starts background jobs; check list_videos or list_jobs.",
    inputSchema: { type: 'object', properties: { names: { type: 'array', items: { type: 'string' } }, orders: { type: 'array', items: { type: 'string' } }, count: { type: 'number' }, styles: { type: 'array', items: { type: 'string' } }, graphics: { type: 'string', enum: ['full', 'light', 'minimal'] }, horizontal_too: { type: 'boolean' }, prompt: { type: 'string', description: 'A note that applies to every video in the batch.' } }, required: ['names'] },
    run: async ({ names, orders, count, styles, graphics, horizontal_too, prompt }) => post('/api/political/videos', { names, orders, count, styles: styles && styles.includes('mix') ? 'mix' : styles, density: graphics, wide: !!horizontal_too, prompt }) },
  { name: 'list_videos', description: "A politician's finished batch videos (title, baseline, topic, style, length, the lines used, which graphics appeared, the automatic check) and the last batch's result, including what was skipped and why.",
    inputSchema: { type: 'object', properties: { lead: { type: 'string' } }, required: ['lead'] },
    run: async ({ lead }) => { const all = await get(`/api/prospects?q=${encodeURIComponent(lead)}`); const list = Array.isArray(all) ? all : all.prospects || all.items || []; const p = list.find((x) => x.id === lead) || list.find((x) => String(x.name).toLowerCase() === String(lead).toLowerCase()) || list.find((x) => String(x.name).toLowerCase().includes(String(lead).toLowerCase())); if (!p) throw new Error(`No one called "${lead}" on the board.`); return clip(await get(`/api/prospects/${p.id}/videos`)); } },
  // The Data tab.
  { name: 'data_list', description: "Everything in Euclidean's Data tab: the team's lists, winners lists, call sheets, research packs, master prompts and pages, each with how many people and tables it has.",
    inputSchema: { type: 'object', properties: {} }, run: async () => (await get('/api/data')).datasets },
  { name: 'data_search', description: 'Search the Data tab for people, rows and passages (a name, an office, a word).',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    run: async ({ query }) => clip(await get(`/api/data/search?q=${encodeURIComponent(query)}`)) },
  { name: 'data_add', description: "Add something to the Data tab: text you have (a list, a markdown or CSV table, notes; give it a name) or a web page (url). Euclidean reads it into people and tables. Adding those people to the leads board is a separate step a person takes in the app (or use_feature POST /api/data/<id>/leads).",
    inputSchema: { type: 'object', properties: { name: { type: 'string' }, text: { type: 'string' }, url: { type: 'string' } } },
    run: async ({ name, text, url }) => post('/api/data', url ? { url } : { files: [{ name: name || 'From Claude', text: text || '' }] }) },
  // ---- the outreach mailbox (drafts only: a person approves and sends)
  { name: 'email_inbox', description: "Euclidean's outreach mailbox: recent emails (newest first) with who, when, subject and the first lines; auto-replies are marked. query searches names, addresses and words; sent=true lists what we sent; unread=true only unread threads.",
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, days: { type: 'number' }, unread: { type: 'boolean' }, sent: { type: 'boolean' }, limit: { type: 'number' } } },
    run: async ({ query, days, unread, sent, limit }) => get(`/api/email/inbox?q=${encodeURIComponent(query || '')}&days=${days || 14}${unread ? '&unread=1' : ''}${sent ? '&sent=1' : ''}&limit=${limit || 25}`) },
  { name: 'email_read', description: 'A whole email thread by a message id (from email_inbox): every message both ways, in order, and whether they opted out.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }, run: async ({ id }) => get(`/api/email/thread/${encodeURIComponent(id)}`) },
  { name: 'email_check', description: 'Check the outreach mailbox for new email right now.', inputSchema: { type: 'object', properties: {} }, run: async () => post('/api/email/check', {}) },
  { name: 'email_draft', description: 'Write an email draft from Euclidean\'s outreach mailbox. It waits in Approvals for a person to approve and send; it is never sent from here. to = an address or a contact/lead name; reply_to = a message id to answer in its thread; attach = a document id or title (PDF). House style: personal, one clear ask, no em dashes; political first emails go to campaign/press addresses, not .gov.',
    inputSchema: { type: 'object', properties: { to: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' }, reply_to: { type: 'string' }, attach: { type: 'string' } }, required: ['body'] },
    run: async (a) => post('/api/email/draft', a) },
  // ---- documents and call lists
  { name: 'documents', description: 'The documents Euclidean made (playbooks, platform plans, meeting briefs, call sheets, contact books) with status, pages and files. Give id to get one in full (its spec: sections and blocks).',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, id: { type: 'string' } } },
    run: async ({ query, id }) => (id ? get(`/api/docs/${encodeURIComponent(id)}`) : get(`/api/docs?q=${encodeURIComponent(query || '')}`)) },
  { name: 'make_document', description: "Make a designed PDF + Word document in Euclidean. Either let Euclidean's writer do it (kind playbook|plan|brief|proposal|report|custom, title, about, instructions, research: true to search the web) or pass a finished spec you wrote: {title, subtitle, kicker, chips, look: designed|plain, sections: [{title, kicker, blocks}]} where blocks are text {text}, bullets {items}, cards {items:[{label,title,text,tag}]}, stats {items:[{value,label}]}, table {columns, rows}, callout {title,text,tone}, steps {items}, phone {title, layout: talking|walk|stat|grid|pov|reply, labels:{top,middle,side}, text, beats:[{time,text}], facts}, tips {items:[{icon: eye|window|mic|propped|takes|silence|share|weekly|light|quiet|frame|edit|approve|idea, title, text}]}, beats, quote, checklist, email {subject, body}, person {...}, sources {items:[{text,url}]}. Facts only from real sources; tag what Euclidean adds PROPOSED.",
    inputSchema: { type: 'object', properties: { kind: { type: 'string' }, title: { type: 'string' }, about: { type: 'string' }, instructions: { type: 'string' }, research: { type: 'boolean' }, spec: { type: 'object' } } },
    run: async (a) => post('/api/docs', a.spec ? { spec: a.spec, kind: a.kind || 'custom', about: a.about || '' } : a) },
  { name: 'revise_document', description: 'Change a finished document from a note in the founders\' words ("make the filming guide one page with diagrams"). The old version is kept.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, note: { type: 'string' } }, required: ['id', 'note'] },
    run: async ({ id, note }) => post(`/api/docs/${encodeURIComponent(id)}/revise`, { note }) },
  { name: 'attach_document', description: 'Attach a finished document (pdf or docx) to an email draft waiting in Approvals (by message_id, or who it is to). Nothing is sent.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, message_id: { type: 'string' }, to: { type: 'string' }, format: { type: 'string' } }, required: ['id'] },
    run: async ({ id, message_id, to, format }) => post(`/api/docs/${encodeURIComponent(id)}/attach`, { messageId: message_id, to, format }) },
  { name: 'build_call_list', description: "Build a checked call list in Euclidean from plain words (e.g. \"two for Ben and two for Ryan, freshly re-elected NY Assembly, nobody we've pitched\"): picks from the leads and the Data tab's winners lists, leaves out everyone already called/emailed/pitched, checks each person's district and Albany phones, office email and an accomplishment hook on their official pages, writes a call script, voicemail and email draft each, and saves a call sheet (PDF + Word). Runs in the background: check it with call_list.",
    inputSchema: { type: 'object', properties: { request: { type: 'string' }, include_previous: { type: 'boolean' } }, required: ['request'] },
    run: async ({ request, include_previous }) => post('/api/calllists', { request, includePrevious: !!include_previous }) },
  { name: 'call_list', description: 'A call list by id (its picks, checked phones/emails/hooks with links, drafts and the document id), or the latest lists without an id.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } } }, run: async ({ id }) => (id ? get(`/api/calllists/${encodeURIComponent(id)}`) : get('/api/calllists')) },
  { name: 'contact_book', description: 'Everyone Euclidean reached out to lately: what was sent and when, real replies vs auto-replies, bounces, next step each. make_document=true also saves a PDF + Word contact book.',
    inputSchema: { type: 'object', properties: { days: { type: 'number' }, make_document: { type: 'boolean' } } },
    run: async ({ days, make_document }) => (make_document ? post('/api/contact-book', { days: days || 14 }) : get(`/api/contact-book?days=${days || 14}`)) },
  // ---- agent conversations (System → Agent conversations): Claude takes part here, with no API key
  { name: 'agent_inbox', description: "Messages waiting for you (Claude) in Euclidean's agent conversations, where the founders, the free Llama, Euclidean's bots (Corbin, Juno, Scout, Data Bot...), Grok, ChatGPT and you talk as a group. Answer each with agent_reply.",
    inputSchema: { type: 'object', properties: {} },
    run: async () => { const r = await get('/api/agentnet/claude/inbox'); return { waiting: (r.waiting || []).map((m) => ({ thread_id: m.threadId, thread: m.threadTitle, message_id: m.id, from: m.fromName, to: m.toNames, type: m.type, text: m.body, at: m.createdAt, in_the_conversation: (m.participants || []).map((x) => x.name) })) }; } },
  { name: 'agent_conversations', description: 'The agent conversations (group chats between the founders and the agents), or one conversation in full with thread_id.',
    inputSchema: { type: 'object', properties: { thread_id: { type: 'string' } } },
    run: async ({ thread_id }) => (thread_id ? (await get(`/api/agentnet/threads/${encodeURIComponent(thread_id)}/messages`)).map((m) => ({ id: m.id, from: m.fromName, to: m.toNames, type: m.type, text: m.body, at: m.createdAt, deliveries: Object.fromEntries(Object.entries(m.deliveries || {}).map(([k, d]) => [k, d.status])) })) : (await get('/api/agentnet/threads?status=active')).map((t) => ({ thread_id: t.id, title: t.title, agents: t.participantNames, last: t.preview, at: t.lastAt, working: t.working }))) },
  { name: 'agent_reply', description: "Post your answer (as Claude) in an agent conversation. to = names of the agents or 'everyone' (default: whoever asked you). To ask another agent something, name it in 'to', or start a line with @Name (e.g. \"@Juno find their campaign email\"): it answers in the thread. Nothing here sends emails or posts; external actions become approval requests.",
    inputSchema: { type: 'object', properties: { thread_id: { type: 'string' }, text: { type: 'string' }, to: { type: 'array', items: { type: 'string' } }, type: { type: 'string', enum: ['reply', 'message', 'question', 'critique_request', 'task_request'] } }, required: ['thread_id', 'text'] },
    run: async ({ thread_id, text, to, type }) => post(`/api/agentnet/threads/${encodeURIComponent(thread_id)}/claude`, { body: text, to: to && !to.some((x) => /^every/i.test(x)) ? to : null, type: type || 'reply' }) },
  { name: 'agent_start', description: "Start a new agent conversation as Claude with the agents you name (e.g. ['Llama', 'Corbin', 'Juno', 'Grok']) and a first message; they answer in the thread (read it with agent_conversations).",
    inputSchema: { type: 'object', properties: { title: { type: 'string' }, agents: { type: 'array', items: { type: 'string' } }, message: { type: 'string' } }, required: ['agents', 'message'] },
    run: async ({ title, agents, message }) => { const r = await post('/api/agentnet/claude/start', { title, agents, body: message }); return { thread_id: r.thread.id, title: r.thread.title, agents: r.thread.participants }; } },
  { name: 'agents_available', description: 'The agents that can take part in agent conversations, how each is connected (no-key options: Llama on this PC, the Euclidean bots, Claude through this connector, Grok through the GrokBot or a login, ChatGPT through a login) and whether it is ready.',
    inputSchema: { type: 'object', properties: {} },
    run: async () => (await get('/api/agentnet/agents')).agents.filter((a) => a.config.enabled).map((a) => ({ id: a.id, name: a.name, kind: a.bot ? 'Euclidean bot' : a.vendor, connection: a.connection, ready: a.health.state === 'connected', status: a.health.reason })) },
  // ---- bots' scheduled tasks
  { name: 'bot_schedule', description: "The bots' scheduled tasks (data scrapes, briefs, news checks): list them with their next run; add one to a bot (every: minutes|hours|day|weekday|week|times, with minutes / hours / at 'HH:MM' / times ['08:00','12:30'] / day 0-6); pause, resume or remove one by id; autorun_on / autorun_off for one bot, or for all bots when no bot is given (the bots keep working in chat; only their schedules pause).",
    inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['list', 'add', 'pause', 'resume', 'remove', 'autorun_on', 'autorun_off'] }, bot: { type: 'string' }, task: { type: 'string' }, every: { type: 'string' }, minutes: { type: 'number' }, hours: { type: 'number' }, at: { type: 'string' }, times: { type: 'array', items: { type: 'string' } }, day: { type: 'number' }, id: { type: 'string' } } },
    run: async (a) => {
      const all = await get('/api/bots/schedules'); const act = a.action || 'list';
      if (act === 'list') return all;
      if (!a.bot && (act === 'autorun_on' || act === 'autorun_off')) return post('/api/bots/schedules/autorun', { on: act === 'autorun_on' });
      const b = all.bots.find((x) => x.id === a.bot || x.name.toLowerCase() === String(a.bot || '').toLowerCase());
      if (!b) throw new Error(`Which bot? ${all.bots.map((x) => x.name).join(', ')}`);
      if (act === 'autorun_on' || act === 'autorun_off') return patch(`/api/bots/${b.id}`, { schedulesOn: act === 'autorun_on' });
      let tasks = b.tasks.map(({ when, next, ...r }) => r);
      if (act === 'add') tasks.push({ task: a.task, every: a.every || 'day', minutes: a.minutes, hours: a.hours, at: a.at, times: a.times, day: a.day, on: true, by: 'Claude' });
      else { const k = tasks.findIndex((r) => r.id === a.id); if (k < 0) throw new Error('No task with that id (list first).'); tasks = act === 'remove' ? tasks.filter((_, i) => i !== k) : tasks.map((r, i) => (i === k ? { ...r, on: act === 'resume' } : r)); }
      await patch(`/api/bots/${b.id}`, { routines: tasks });
      return (await get('/api/bots/schedules')).bots.find((x) => x.id === b.id);
    } },
];

/** /api/... with the leading slash; full URLs are cut back to their path. */
function route(p) { let s = String(p || '').trim(); s = s.replace(/^https?:\/\/[^/]+/, ''); if (!s.startsWith('/')) s = `/${s}`; if (!s.startsWith('/api/')) throw new Error('Paths start with /api/ (see find_features).'); return s; }
/** Keep answers readable for Claude: long lists are cut with a note. */
function clip(x) { const t = typeof x === 'string' ? x : JSON.stringify(x, null, 1); return t.length > 60000 ? `${t.slice(0, 60000)}\n... (cut at 60,000 characters: ask for less, e.g. with ?limit= or an id)` : x; }
async function upload(file, to, fields) {
  const c = connection();
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error(`No file at ${file}`);
  const info = ((await get(`/api/_endpoints?q=${encodeURIComponent(to.split('?')[0].split('/').filter((x) => x && !/^[a-z0-9_-]{8,}$/i.test(x)).slice(-2).join(' '))}`)) || []).find((e) => e.method === 'POST' && new RegExp('^' + e.path.replace(/:\w+/g, '[^/]+') + '$').test(to.split('?')[0]));
  const name = path.basename(file); const size = fs.statSync(file).size;
  const headers = { authorization: `Bearer ${c.token}`, 'x-euclidean-via': 'claude', 'x-file-name': encodeURIComponent(name) };
  let body;
  if (info?.upload === 'multipart') {
    const boundary = `----euclidean${Date.now().toString(16)}`;
    const head = Object.entries(fields).map(([k, v]) => `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`).join('') + `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name.replace(/"/g, '')}"\r\nContent-Type: application/octet-stream\r\n\r\n`;
    const tail = `\r\n--${boundary}--\r\n`;
    headers['content-type'] = `multipart/form-data; boundary=${boundary}`; headers['content-length'] = String(Buffer.byteLength(head) + size + Buffer.byteLength(tail));
    body = require('stream').Readable.from((async function* () { yield Buffer.from(head); for await (const ch of fs.createReadStream(file)) yield ch; yield Buffer.from(tail); })());
  } else {
    headers['content-type'] = 'application/octet-stream'; headers['content-length'] = String(size);
    body = fs.createReadStream(file);
  }
  let res; try { res = await fetch(`${c.url}${to}`, { method: 'POST', headers, body, duplex: 'half' }); } catch (e) { throw new Error(`Upload failed: ${e.message}. Is the app open?`); }
  const text = await res.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) throw new Error(`Euclidean said ${res.status}: ${data?.error || String(text).slice(0, 300)}`);
  return data;
}

const INSTRUCTIONS = `You control the Euclidean app running on this PC (Euclidean Media's video agency program: clients, footage, clips, Studio, Quick cut, political ads and outreach, messages, approvals, finance, HAL). The quick tools (status, list_jobs, list_candidates, make_ads...) cover common checks. Euclidean's own bots (list_bots, ask_bot: Corbin the master bot, Juno the client bot, Scout, Data Bot) do research and drafting inside the app; web_research and web_read give free live internet (google_search for a full Google inquiry, which costs a little); find_videos and make_ads_hands_off find a politician's public videos and make their ads without anyone uploading footage; make_videos makes a whole batch of finished videos for politicians by name from typed orders or baseline templates (video_templates lists them, list_videos shows the results); data_list, data_search and data_add work with the Data tab (the team's lists and research, PDFs included); email_inbox, email_read, email_check and email_draft work with the outreach mailbox (drafts wait in Approvals); make_document / revise_document / attach_document make designed PDF + Word documents (playbooks, plans, briefs) and put them on drafts; build_call_list, call_list and contact_book make checked call sheets and show who we reached; bot_schedule sets the bots' scheduled tasks and their auto-run switch. Agent conversations (System → Agent conversations) are group chats between the founders, the free Llama, Euclidean's bots, Grok, ChatGPT and you: check agent_inbox when asked about them or when you start working, answer each waiting message with agent_reply, and start one with agent_start. For anything else: find_features with a few words, then look (read), use_feature (do it inside the app), upload_file, or talk_to_hal (you appear as Claude in HAL's chat; hal_inbox has what Ryan left for you there, answer with reply_in_hal). Keep HAL's chat a copy of this conversation: after every answer you give Ryan here that involves Euclidean or HAL, call reply_in_hal with your answer (text) and his message (asked), so the founders can read it in Euclidean. show_in_app opens the page so the person can watch. The notebook (notebook_recall / notebook_learn) is what Euclidean and HAL have learned: read it before acting on a person or client, and add what you learn (true and sourced) so the app keeps getting smarter. Anything that sends, approves, posts, calls or deletes is send_or_publish: say exactly what will happen, wait for the person's yes in chat, then call it with their words. Political emails are sent by a person: draft them, never approve them on your own. When unsure what a feature expects, read the matching GET first.`;

// ------------------------------------------------------------------ the protocol (JSON-RPC 2.0 over stdio, one message per line)
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

async function handle(m) {
  if (m.method === 'initialize') return reply(m.id, { protocolVersion: m.params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'euclidean', version: '1.2.0' }, instructions: INSTRUCTIONS });
  if (m.method === 'ping') return reply(m.id, {});
  if (m.method === 'tools/list') return reply(m.id, { tools: TOOLS.map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, ...(annotations ? { annotations } : {}) })) });
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
