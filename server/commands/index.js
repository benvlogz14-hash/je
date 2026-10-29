'use strict';
/**
 * Command center. Every slash command performs a real backend operation and
 * returns a message (optionally with a card the UI renders). Plain-language
 * requests are routed by the operations agent to the same commands, so
 * everything an agent can do, a person can type, and vice versa.
 */
const fs = require('fs');
const ctx = require('../core/ctx');
const audit = require('../core/audit');
const queue = require('../jobs/queue');
const ai = require('../integrations/ai');
const pipeline = require('../automation/pipeline');
const messaging = require('../automation/messaging');
const resources = require('../automation/resources');
const health = require('../automation/health');
const finance = require('../automation/finance');
const { fmtDuration } = require('../core/util');

const COMMANDS = [];
function cmd(name, group, usage, description, run, opts = {}) { COMMANDS.push({ name, group, usage, description, run, ...opts }); }
class UserError extends Error {}
const fail = (m) => { throw new UserError(m); };

// ------------------------------------------------------------ resolution helpers
function findClient(q, required = true) {
  const s = String(q || '').trim().toLowerCase();
  const all = ctx.store.all('clients');
  const c = s ? (all.find((x) => x.id === q) || all.find((x) => x.name.toLowerCase() === s) || all.find((x) => x.name.toLowerCase().includes(s)) || all.find((x) => s.includes(x.name.toLowerCase().split(' ')[0]))) : null;
  if (!c && required) fail(s ? `No client matches "${q}". Try /clients.` : 'Name a client, e.g. /clips stringer');
  return c;
}
function findContact(q) {
  const s = String(q || '').trim().toLowerCase().replace(/^@/, '');
  const all = ctx.store.all('contacts');
  return all.find((x) => x.id === q) || all.find((x) => x.name.toLowerCase() === s) || all.find((x) => x.name.toLowerCase().includes(s)) || all.find((x) => (x.emails || []).includes(s) || (x.phones || []).some((p) => p.endsWith(s.replace(/\D/g, '').slice(-10)) && s.replace(/\D/g, '').length >= 7)) || null;
}
function findClip(q) {
  const s = String(q || '').replace(/^#/, '').trim();
  const c = ctx.store.find('clips', (x) => String(x.ref) === s || x.id === s);
  if (!c) fail(`No clip #${s}. Clip numbers appear on every card (e.g. #104).`);
  return c;
}
function splitFirst(text) { const t = String(text || '').trim(); const i = t.indexOf(' '); return i < 0 ? [t, ''] : [t.slice(0, i), t.slice(i + 1).trim()]; }
/** Allow "for <client>" suffixes: "/ingest C:\x.mp4 for stringer" */
function forClient(text, c) { const m = /\s+(?:for|to)\s+(.+)$/i.exec(text); if (m) return [text.slice(0, m.index).trim(), findClient(m[1])]; return [text.trim(), c.clientId ? ctx.store.get('clients', c.clientId) : null]; }
const clipCard = (clips) => ({ type: 'clips', data: clips.map((c) => ({ id: c.id, ref: c.ref, title: c.title, status: c.status, client: ctx.store.get('clients', c.clientId)?.name, duration: Math.round(c.end - c.start), score: c.score, version: c.currentVersion, thumb: c.versions?.[c.currentVersion - 1]?.thumb ? `/api/clips/${c.id}/thumb` : null })) });

// ------------------------------------------------------------ communication
cmd('inbox', 'Communication', '/inbox', 'Unread conversations and messages waiting for approval', async () => {
  const convs = ctx.store.all('conversations', (c) => c.kind === 'contact' && c.unread > 0).sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt));
  const pending = ctx.store.all('messages', (m) => m.status === 'pending_approval');
  return { text: `${convs.length} unread conversation${convs.length === 1 ? '' : 's'} · ${pending.length} message${pending.length === 1 ? '' : 's'} awaiting approval`, card: { type: 'conversations', data: convs.slice(0, 12).map((c) => ({ id: c.id, title: c.title, preview: c.preview, unread: c.unread, at: c.lastMessageAt })) } };
});
cmd('text', 'Communication', '/text <contact> <message>', 'Send a text message', async (a, c) => {
  const words = a.trim().split(/\s+/);
  let contact = null, i = words.length;
  for (; i > 0; i--) { contact = findContact(words.slice(0, i).join(' ')); if (contact) break; }
  if (!contact) fail('Who should I text? Usage: /text <contact> <message>');
  const body = words.slice(i).join(' '); if (!body) fail('Message is empty');
  const m = messaging.createOutbound({ contactId: contact.id, channel: 'sms', body, actor: c.actor, aiGenerated: !!c.viaAgent, category: c.viaAgent ? 'commitment' : 'routine' });
  return { text: m.status === 'pending_approval' ? `Draft to ${contact.name} is waiting for approval.` : `Texting ${contact.name}${m.status === 'scheduled' ? ` at ${new Date(m.sendAt).toLocaleTimeString()}` : ''}.`, card: { type: 'message', data: { id: m.id } } };
});
cmd('email', 'Communication', '/email <contact> <subject> | <message>', 'Send an email', async (a, c) => {
  const [who, rest] = a.split(/\s+(.+)/s);
  const contact = findContact(who) || fail('Usage: /email <contact> <subject> | <message>');
  const [subject, body] = rest?.includes('|') ? rest.split('|').map((s) => s.trim()) : [null, rest];
  if (!body) fail('Message is empty');
  const m = messaging.createOutbound({ contactId: contact.id, channel: 'email', subject, body, actor: c.actor, aiGenerated: !!c.viaAgent, category: c.viaAgent ? 'commitment' : 'routine' });
  return { text: m.status === 'pending_approval' ? `Email to ${contact.name} is waiting for approval.` : `Emailing ${contact.name}.` };
});
cmd('reply', 'Communication', '/reply <message>', 'Reply in the open conversation on its last channel', async (a, c) => {
  const conv = ctx.store.get('conversations', c.conversationId);
  if (!conv || conv.kind !== 'contact') fail('Open a contact conversation to use /reply');
  const m = messaging.createOutbound({ conversationId: conv.id, body: a, actor: c.actor, channel: conv.lastChannel === 'email' ? 'email' : undefined });
  return { text: `Reply ${m.status === 'pending_approval' ? 'waiting for approval' : 'queued'}.`, silent: true };
});
cmd('draft', 'Communication', '/draft <contact> <goal>', 'Have the writing agent draft a message for approval', async (a, c) => {
  const words = a.trim().split(/\s+/); let contact = null, i = words.length;
  for (; i > 0; i--) { contact = findContact(words.slice(0, i).join(' ')); if (contact) break; }
  if (!contact) fail('Usage: /draft <contact> <what the message should accomplish>');
  const goal = words.slice(i).join(' ') || 'check in';
  const conv = messaging.ensureConversation(contact);
  const history = ctx.store.all('messages', (m) => m.conversationId === conv.id && m.direction !== 'internal').slice(-10).map((m) => `${m.direction === 'in' ? contact.name : 'Us'}: ${m.body}`).join('\n');
  const channel = contact.phones?.length ? 'sms' : 'email';
  const r = await ai.ask({ role: 'writing', clientId: contact.clientId, json: true, system: 'You draft messages for Euclidean Media founders. Plain, warm, direct. No buzzwords. Never invent facts, prices or dates that were not given.', prompt: `Draft a ${channel === 'sms' ? 'text message under 320 characters' : 'short email with a subject'} to ${contact.name} (${contact.role}). Goal: ${goal}\n\nRecent thread:\n${history || '(none)'}\n\nReturn {"subject":"...","body":"..."}` });
  const m = messaging.createOutbound({ contactId: contact.id, channel, subject: r.json.subject, body: r.json.body, aiGenerated: true, agent: `${r.provider}:${r.model}`, category: contact.role === 'prospect' ? 'prospecting' : 'commitment', actor: c.actor });
  return { text: `Drafted by ${ai.PROVIDERS[r.provider].label}. It's in ${contact.name}'s thread waiting for your approval.`, card: { type: 'message', data: { id: m.id } } };
}, { needsAI: true });
cmd('followup', 'Communication', '/followup', 'Contacts who are waiting on us or have gone quiet', async () => {
  const out = [];
  for (const conv of ctx.store.all('conversations', (x) => x.kind === 'contact' && !x.archived)) {
    const msgs = ctx.store.all('messages', (m) => m.conversationId === conv.id && m.direction !== 'internal');
    const last = msgs[msgs.length - 1]; if (!last) continue;
    const contact = ctx.store.get('contacts', conv.contactId);
    const ageDays = (Date.now() - new Date(last.createdAt).getTime()) / 864e5;
    if (last.direction === 'in' && ageDays > 0.25) out.push({ id: conv.id, title: conv.title, reason: `Waiting on our reply for ${fmtAge(ageDays)}`, at: last.createdAt });
    else if (last.direction === 'out' && contact?.role === 'prospect' && ageDays > 4) out.push({ id: conv.id, title: conv.title, reason: `Prospect quiet for ${fmtAge(ageDays)}`, at: last.createdAt });
  }
  return { text: out.length ? `${out.length} conversation${out.length === 1 ? '' : 's'} need a follow-up.` : 'Nobody is waiting on you.', card: { type: 'conversations', data: out } };
});
const fmtAge = (d) => (d < 1 ? `${Math.round(d * 24)}h` : `${Math.round(d)}d`);
cmd('note', 'Communication', '/note <text>', 'Internal note in this conversation (never sent)', async (a, c) => {
  const conv = ctx.store.get('conversations', c.conversationId) || fail('Open a conversation first');
  messaging.addMessage(conv, { direction: 'internal', channel: 'note', body: a, status: 'note', createdBy: c.actor });
  return { text: 'Note added.', silent: true };
});

// ------------------------------------------------------------ clients
cmd('clients', 'Clients', '/clients', 'Active clients with quota status', async () => {
  const list = ctx.store.all('clients', (x) => x.status !== 'churned');
  return { text: `${list.filter((x) => x.status === 'active').length} active client${list.length === 1 ? '' : 's'}.`, card: { type: 'clients', data: list.map((x) => ({ id: x.id, name: x.name, type: x.type, status: x.status, retainer: finance.monthly(x.retainer), autopilot: !!x.schedule?.autopilot, perDay: x.schedule?.shortsPerDay, quota: x.status === 'active' ? pipeline.quotaStatus(x) : null })) } };
});
cmd('client', 'Clients', '/client <name>', 'Open a client workspace', async (a) => { const x = findClient(a); return { text: `${x.name}`, navigate: `/clients/${x.id}` }; });
cmd('newclient', 'Clients', '/newclient <name> [creator|political]', 'Create a client workspace', async (a, c) => {
  const m = /^(.*?)(?:\s+(creator|political))?$/i.exec(a.trim()); if (!m[1]) fail('Usage: /newclient <name> [creator|political]');
  const x = pipeline.createClient({ name: m[1].trim(), type: (m[2] || 'creator').toLowerCase() }, c.actor);
  return { text: `Created ${x.name} (${x.type}). Set their schedule, style and contacts in the client workspace.`, navigate: `/clients/${x.id}` };
});
cmd('remember', 'Clients', '/remember <client>: <preference>', 'Save a client preference applied to all future work', async (a, c) => {
  const [who, pref] = a.split(/:(.+)/s).map((s) => s && s.trim());
  const x = findClient(who); if (!pref) fail('Usage: /remember stringer: no all-caps captions');
  let style = null;
  if (ai.anyConnected()) {
    try { const r = await ai.ask({ role: 'operations', json: true, prompt: `Convert this caption/editing preference into style keys if it maps to any of: uppercase(bool), wordsPerLine(1-6), size(40-140), primary/highlight/outline("#RRGGBB"), position("lower"|"center"|"upper"), animation("pop"|"none"), highlightMode("word"|"none"), box(bool), hook(bool), preset("clean-pop"|"boxed"|"minimal"|"news"|"karaoke-teal"). Preference: "${pref}". Return {"style":{...}} with only keys that clearly apply, or {"style":{}}.` }); style = r.json.style && Object.keys(r.json.style).length ? r.json.style : null; } catch { /* stored as text only */ }
  }
  pipeline.remember(x.id, [{ text: pref, style }], { source: 'manual', actor: c.actor });
  return { text: `Saved for ${x.name}: "${pref}"${style ? ` (applied to captions: ${Object.entries(style).map(([k, v]) => `${k}=${v}`).join(', ')})` : ''}. Every agent and render will use it from now on.` };
});
cmd('quota', 'Clients', '/quota <client> <n>/day', 'Set shorts per day and turn on autopilot', async (a, c) => {
  const m = /^(.*?)\s+(\d+)\s*(?:\/\s*day|per day|a day)?$/i.exec(a.trim()) || fail('Usage: /quota stringer 6/day');
  const x = findClient(m[1]); const n = Math.min(24, Math.max(0, Number(m[2])));
  const slots = defaultSlots(n);
  ctx.store.update('clients', x.id, (cl) => ({ schedule: { ...cl.schedule, shortsPerDay: n, slots, autopilot: n > 0 } }));
  audit.log(c.actor, 'client.quota', { clientId: x.id, perDay: n });
  return { text: `${x.name}: ${n} shorts/day at ${slots.join(', ')} (${x.schedule.timezone}). Autopilot ${n > 0 ? 'on' : 'off'}.` };
});
function defaultSlots(n) {
  if (n <= 0) return [];
  const startH = 8, endH = 21; const step = n > 1 ? (endH - startH) / (n - 1) : 0;
  return Array.from({ length: n }, (_, i) => { const t = startH + step * i; const h = Math.floor(t), mm = Math.round((t - h) * 60 / 15) * 15; return `${String(h + (mm === 60 ? 1 : 0)).padStart(2, '0')}:${String(mm % 60).padStart(2, '0')}`; });
}

// ------------------------------------------------------------ production
cmd('ingest', 'Production', '/ingest <file path or link> [for <client>]', 'Import footage and start the pipeline', async (a, c) => {
  const [target, client] = forClient(a, c);
  if (!client) fail('Which client is this for? Add "for <client>"');
  if (/^https?:\/\//i.test(target)) { const j = queue.enqueue('ingest.url', { url: target, clientId: client.id, autoProcess: true }, { clientId: client.id, actor: c.actor }); return { text: `Downloading for ${client.name}. Transcription and clip discovery start automatically.`, card: { type: 'job', data: { id: j.id } } }; }
  const p = target.replace(/^"|"$/g, '');
  if (!fs.existsSync(p)) fail(`File not found: ${p}`);
  const asset = pipeline.addAsset({ clientId: client.id, filePath: p, source: 'command', actor: c.actor });
  const job = ctx.store.find('jobs', (j) => j.dedupeKey === `ingest:${asset.id}`);
  if (job) ctx.store.update('jobs', job.id, (j) => ({ payload: { ...j.payload, autoProcess: true } }));
  return { text: `Importing ${asset.name} for ${client.name}. I'll transcribe it and find clips automatically.` };
});
cmd('discover', 'Production', '/discover <client> [n]', 'Find n more clips in the client\'s newest footage', async (a, c) => {
  const m = /^(.*?)(?:\s+(\d+))?$/.exec(a.trim()); const client = findClient(m[1] || c.clientId);
  const asset = ctx.store.all('assets', (x) => x.clientId === client.id && x.status === 'ready' && !x.exhausted).pop() || fail(`${client.name} has no unused footage. /ingest some first.`);
  queue.enqueue('discover', { assetId: asset.id, count: Number(m[2] || 6) }, { clientId: client.id, actor: c.actor });
  return { text: `Looking for ${m[2] || 6} clips in "${asset.name}".` };
});
cmd('clips', 'Production', '/clips [client]', 'Recent clips and where each one is', async (a, c) => {
  const client = a.trim() ? findClient(a) : null;
  const list = ctx.store.all('clips', (x) => (!client || x.clientId === client.id) && !['rejected'].includes(x.status)).slice(-18).reverse();
  return { text: list.length ? `${list.length} recent clip${list.length === 1 ? '' : 's'}${client ? ` for ${client.name}` : ''}.` : 'No clips yet.', card: clipCard(list) };
});
cmd('edit', 'Production', '/edit <clip#> <instruction>', 'Re-edit a clip from plain-language direction (e.g. "/edit 104 start at the joke, no hook")', async (a, c) => {
  const [ref, instr] = splitFirst(a); const clip = findClip(ref); if (!instr) fail('What should change?');
  pipeline.decideClip(clip.id, 'changes', { actor: c.actor, note: instr, stage: 'internal' });
  return { text: `On it: #${clip.ref} goes back through the analysis agent and re-renders with "${instr}".` };
}, { needsAI: true });
cmd('render', 'Production', '/render <clip#|all <client>>', 'Re-render one clip, or batch re-render every clip in review for a client', async (a) => {
  if (/^all\b/i.test(a.trim())) { const client = findClient(a.trim().replace(/^all\s*/i, '')); const list = ctx.store.all('clips', (x) => x.clientId === client.id && ['review', 'client_review', 'approved'].includes(x.status)); for (const x of list) pipeline.requestRender(x, { reason: 'batch' }); return { text: `Batch re-rendering ${list.length} clip${list.length === 1 ? '' : 's'} for ${client.name} with the current style and graphics.` }; }
  const clip = findClip(a); pipeline.requestRender(clip, { reason: 'manual' }); return { text: `Re-rendering #${clip.ref}.` };
});
cmd('approve', 'Production', '/approve [clip#|all <client>]', 'Approve a clip, or open the approval queue', async (a, c) => {
  const t = a.trim();
  if (!t) { const n = ctx.store.all('approvals', (x) => x.status === 'pending').length; return { text: `${n} item${n === 1 ? '' : 's'} pending.`, navigate: '/approvals' }; }
  if (/^all\b/i.test(t)) { const client = findClient(t.replace(/^all\s*/i, '')); const list = ctx.store.all('clips', (x) => x.clientId === client.id && x.status === 'review'); for (const x of list) pipeline.decideClip(x.id, 'approve', { actor: c.actor }); return { text: `Approved ${list.length} clip${list.length === 1 ? '' : 's'} for ${client.name}.` }; }
  const clip = findClip(t); const r = pipeline.decideClip(clip.id, 'approve', { actor: c.actor });
  return { text: r.status === 'client_review' ? `#${clip.ref} approved internally and sent to the client for review.` : `#${clip.ref} approved${r.postId ? ` and scheduled for ${new Date(ctx.store.get('posts', r.postId).scheduledAt).toLocaleString()}` : ''}.` };
});
cmd('reject', 'Production', '/reject <clip#>', 'Reject a clip', async (a, c) => { const clip = findClip(a); pipeline.decideClip(clip.id, 'reject', { actor: c.actor }); return { text: `#${clip.ref} rejected.` }; });
cmd('premiere', 'Production', '/premiere <clip#>', 'Hand a clip to Astra for editing in Adobe Premiere', async (a, c) => {
  const clip = findClip(a);
  const j = queue.enqueue('premiere.handoff', { clipId: clip.id, reason: 'manual' }, { clientId: clip.clientId, actor: c.actor, title: `Premiere edit: ${clip.title}` });
  const online = require('../automation/handoff').status().online;
  return { text: `Work order for #${clip.ref} is waiting for a computer-use agent.${online ? '' : ' No agent is online right now; start Astra with the agent token from Settings → Agents.'}`, card: { type: 'job', data: { id: j.id } } };
});
cmd('studio', 'Production', '/studio [clip#]', 'Open the Studio editor (optionally with a clip loaded)', async (a) => { if (!a.trim()) return { text: 'Opening Studio.', navigate: '/studio' }; const clip = findClip(a); return { text: `Opening #${clip.ref} in Studio.`, navigate: `/studio?clip=${clip.id}` }; });

// ------------------------------------------------------------ publishing
cmd('schedule', 'Publishing', '/schedule [client]', 'Upcoming posts', async (a) => {
  const client = a.trim() ? findClient(a) : null;
  const posts = ctx.store.all('posts', (p) => p.status === 'scheduled' && (!client || p.clientId === client.id)).sort((x, y) => x.scheduledAt.localeCompare(y.scheduledAt)).slice(0, 20);
  return { text: posts.length ? `${posts.length} upcoming post${posts.length === 1 ? '' : 's'}.` : 'Nothing scheduled.', card: { type: 'posts', data: posts.map((p) => ({ id: p.id, title: p.title, at: p.scheduledAt, platforms: p.platforms, client: ctx.store.get('clients', p.clientId)?.name })) } };
});
cmd('publish', 'Publishing', '/publish <clip#> [now]', 'Schedule an approved clip into the next slot, or publish now', async (a, c) => {
  const [ref, flag] = splitFirst(a); const clip = findClip(ref);
  if (!['approved', 'scheduled'].includes(clip.status)) fail(`#${clip.ref} is "${clip.status}". Only approved clips can be published.`);
  const post = clip.postId ? ctx.store.get('posts', clip.postId) : pipeline.scheduleClip(clip.id);
  if (!post) fail('No free slot in the next 3 weeks. Add slots in the client schedule.');
  if (/now/i.test(flag)) { const j = ctx.store.find('jobs', (x) => x.dedupeKey === `publish:${post.id}`); if (j) ctx.store.update('jobs', j.id, { runAt: new Date().toISOString() }); ctx.store.update('posts', post.id, { scheduledAt: new Date().toISOString() }); audit.log(c.actor, 'post.publish_now', { postId: post.id, clientId: post.clientId }); return { text: `Publishing #${clip.ref} now.` }; }
  return { text: `#${clip.ref} scheduled for ${new Date(post.scheduledAt).toLocaleString()} on ${post.platforms.join(', ')}.` };
});

// ------------------------------------------------------------ growth
cmd('prospect', 'Growth', '/prospect <who you want>', 'Research qualified prospects (e.g. "/prospect CT state house candidates 2026 with weak TikTok")', async (a, c) => {
  if (!a.trim()) fail('Describe the prospects you want');
  const j = queue.enqueue('prospect.research', { query: a.trim(), count: 8 }, { actor: c.actor });
  return { text: 'The research agent is on it. Results land in Growth → Prospects; nothing is sent to anyone.', card: { type: 'job', data: { id: j.id } } };
}, { needsAI: true });
cmd('audit', 'Growth', '/audit <prospect>', 'Write a social media audit for a prospect', async (a, c) => {
  const s = a.trim().toLowerCase();
  let p = ctx.store.find('prospects', (x) => x.name.toLowerCase().includes(s) || (x.handle || '').toLowerCase().includes(s));
  if (!p) p = ctx.store.insert('prospects', { name: a.trim(), handle: a.trim(), type: 'creator', stage: 'new', why: '', verified: false });
  queue.enqueue('prospect.audit', { prospectId: p.id }, { actor: c.actor });
  return { text: `Auditing ${p.name}. It'll appear on their prospect card.` };
}, { needsAI: true });

// ------------------------------------------------------------ business
cmd('revenue', 'Business', '/revenue', 'Revenue, costs, profit and founder distributions this month', async () => {
  const s = finance.summary();
  return { text: `MRR $${s.mrr.toLocaleString()} · profit $${s.profit.toLocaleString()} · AI $${s.aiCost.toFixed(2)}`, card: { type: 'revenue', data: s } };
});
cmd('analytics', 'Business', '/analytics [client]', 'Performance of published posts', async (a) => {
  const client = a.trim() ? findClient(a) : null;
  const posts = ctx.store.all('posts', (p) => p.status === 'published' && (!client || p.clientId === client.id));
  const views = posts.reduce((t, p) => t + Object.values(p.stats || {}).reduce((s, v) => s + (v.views || 0), 0), 0);
  return { text: posts.length ? `${posts.length} published · ${views.toLocaleString()} tracked views${posts.some((p) => p.stats) ? '' : ' (connect Ayrshare or YouTube to pull stats)'}` : 'Nothing published yet.', navigate: '/analytics' };
});
cmd('invoice', 'Business', '/invoice', 'Draft this month\'s retainer invoices (not sent)', async (a, c) => { const list = finance.draftInvoices(c.actor); return { text: list.length ? `Drafted ${list.length} invoice${list.length === 1 ? '' : 's'} totalling $${list.reduce((t, i) => t + i.amount, 0).toLocaleString()}.` : 'All active retainers already have an invoice this month.', navigate: '/finance' }; });

// ------------------------------------------------------------ system
cmd('agents', 'System', '/agents', 'AI agents, roles, spend and computer-use status', async () => ({ text: 'Agent status', card: { type: 'agents', data: ai.agentStatus() } }));
cmd('queue', 'System', '/queue', 'Running and pending jobs', async () => {
  const st = queue.stats();
  const jobs = ctx.store.all('jobs', (j) => ['running', 'queued', 'waiting_agent', 'failed'].includes(j.status)).sort((x, y) => (x.status === 'running' ? -1 : 1) - (y.status === 'running' ? -1 : 1)).slice(0, 15);
  return { text: `${st.running} running · ${st.queued} queued · ${st.waitingAgent} waiting for an agent · ${st.failed24h} failed (24h)${st.paused ? ' · PAUSED' : ''}`, card: { type: 'jobs', data: jobs.map(queue.slim) } };
});
cmd('retry', 'System', '/retry <job id|all>', 'Retry a failed job, or all failed jobs', async (a) => {
  if (a.trim() === 'all') { const f = ctx.store.all('jobs', (j) => j.status === 'failed'); f.forEach((j) => queue.retry(j.id)); return { text: `Retrying ${f.length} job${f.length === 1 ? '' : 's'}.` }; }
  const j = queue.retry(a.trim()) || fail('Job not found'); return { text: `Retrying ${j.title}.` };
});
cmd('cancel', 'System', '/cancel <job id>', 'Cancel a job', async (a, c) => { const j = queue.cancel(a.trim(), c.actor) || fail('Job not found'); return { text: `Canceled ${j.title}.` }; });
cmd('pause', 'System', '/pause', 'Emergency stop: halt all sending, publishing and production', async (a, c) => { queue.setPaused(true); ctx.store.setSettings({ _paused: true }); audit.log(c.actor, 'automation.paused', {}, 'warn'); return { text: 'Emergency stop is on. Nothing will be sent, published or rendered until you /resume.' }; });
cmd('stop', 'System', '/stop', 'Same as /pause (the red Stop button): halt all sending, publishing and production. To stop one job, press the × on it in /queue', async (a, c) => { queue.setPaused(true); ctx.store.setSettings({ _paused: true }); audit.log(c.actor, 'automation.paused', {}, 'warn'); return { text: 'Stopped: nothing will be sent, published or rendered until you /resume. To stop just one job instead, press the × next to it in /queue.' }; });
cmd('resume', 'System', '/resume', 'Resume automation after an emergency stop', async (a, c) => { queue.setPaused(false); ctx.store.setSettings({ _paused: false }); audit.log(c.actor, 'automation.resumed', {}); return { text: 'Automation resumed.' }; });
cmd('logs', 'System', '/logs [filter]', 'Recent activity from the audit log', async (a) => ({ text: 'Recent activity', card: { type: 'logs', data: audit.query({ q: a.trim() || undefined, limit: 25 }) } }));
cmd('health', 'System', '/health', 'Check every integration, worker and tool', async () => { const r = health.check(); return { text: `${r.summary.ok} OK · ${r.summary.warn} warnings · ${r.summary.error} errors`, card: { type: 'health', data: r } }; });
cmd('lite', 'System', '/lite', 'Lite mode: vital functions only, frees RAM for Premiere', async () => { resources.setMode('lite', 'command'); return { text: 'Lite mode on. Messaging, approvals and publishing keep running; rendering, transcription and analytics are paused.' }; });
cmd('full', 'System', '/full', 'Full mode: everything runs', async () => { resources.setMode('full', 'command'); return { text: 'Full mode on.' }; });
cmd('background', 'System', '/background', 'Close the window to the tray; the engine keeps working', async () => { resources.setMode('background', 'command'); return { text: 'Moving to the background.' }; });
cmd('backup', 'System', '/backup', 'Back up the database now', async () => { queue.enqueue('backup', {}); return { text: 'Backup started.' }; });
cmd('status', 'System', '/status', 'One-line system status', async () => {
  const r = resources.last || {}; const st = queue.stats();
  return { text: `${ctx.setting('environment') === 'production' ? 'Production' : 'Test'} · ${r.mode || 'full'} mode · CPU ${r.cpu ?? '?'}% · RAM free ${r.ramFreeMb ?? '?'} MB · ${st.running} running, ${st.queued} queued${st.paused ? ' · PAUSED' : ''}` };
});
cmd('help', 'System', '/help [command]', 'All commands', async (a) => {
  const t = a.trim().replace(/^\//, '');
  if (t) { const k = COMMANDS.find((x) => x.name === t) || fail(`No command /${t}`); return { text: `${k.usage}\n${k.description}` }; }
  return { text: 'Commands. Type any of these, or just say what you want.', card: { type: 'help', data: catalog() } };
});

function catalog() { return COMMANDS.map(({ name, group, usage, description, needsAI }) => ({ name, group, usage, description, needsAI: !!needsAI })); }

// ------------------------------------------------------------ execution
async function execute(text, c) {
  const raw = String(text || '').trim();
  if (!raw.startsWith('/')) return route(raw, c);
  const [head, args] = splitFirst(raw.slice(1));
  const k = COMMANDS.find((x) => x.name === head.toLowerCase());
  if (!k) return { text: `Unknown command /${head}. Type /help for the list.`, error: true };
  if (k.needsAI && !ai.anyConnected()) return { text: `/${k.name} needs an AI provider. Add a Claude, GPT or Grok key in Settings → Connections.`, error: true, navigate: '/settings/connections' };
  try {
    const r = await k.run(args, c);
    audit.log(c.actor, 'command', { command: `/${k.name}`, args: args.slice(0, 200) });
    return r;
  } catch (e) {
    if (e instanceof UserError) return { text: e.message, error: true };
    return { text: `/${k.name} failed: ${e.message}`, error: true };
  }
}

/** Natural language → command, via the operations agent. */
async function route(text, c) {
  if (!ai.anyConnected()) return { text: 'Plain-language requests need an AI provider (Settings → Connections). Slash commands work without one: type / to see them.', error: true };
  const clients = ctx.store.all('clients').map((x) => x.name).join(', ') || 'none yet';
  const list = COMMANDS.map((k) => `${k.usage} — ${k.description}`).join('\n');
  let r;
  try {
    r = await ai.ask({
      role: 'operations', json: true, maxTokens: 900,
      system: `You are Euclidean, the operations assistant inside Euclidean Media's agency software. Translate the founder's request into at most 3 commands from the list, or answer directly if it's a question you can answer from the context. Clients: ${clients}. Never invent clip numbers or contacts.\nCOMMANDS:\n${list}\nReturn {"commands":["/..."],"say":"one short sentence to show the user"} or {"answer":"..."}.`,
      prompt: text,
    });
  } catch (e) { return { text: e.message, error: true }; }
  const j = r.json;
  if (j.answer) return { text: j.answer, agent: `${r.provider}:${r.model}` };
  const results = [];
  for (const command of (j.commands || []).slice(0, 3)) results.push({ command, ...(await execute(command, { ...c, viaAgent: true })) });
  if (!results.length) return { text: j.say || 'I wasn\'t sure what to do. Try /help.', agent: `${r.provider}:${r.model}` };
  const last = results[results.length - 1];
  return { ...last, text: [j.say, ...results.map((x) => `${x.command} → ${x.text}`)].filter(Boolean).join('\n'), agent: `${r.provider}:${r.model}` };
}

module.exports = { execute, catalog, defaultSlots, findClient };
