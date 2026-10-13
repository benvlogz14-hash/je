// In-browser backend for the interactive example. Serves a snapshot of a sample workspace and
// simulates the main actions (approvals, messages, commands, modes) so the interface can be tried
// without the engine. Nothing is sent or posted from the example.
const D = window.EUCLIDEAN_DEMO_DATA;
const MEDIA = window.EUCLIDEAN_DEMO_MEDIA || {};
let emit = () => {};
const now = () => new Date().toISOString();
const uid = (p) => p + Math.random().toString(36).slice(2, 10);
const clone = (o) => JSON.parse(JSON.stringify(o));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function clipView(c) {
  const v = c.versions?.[c.currentVersion - 1];
  return { ...c, current: v ? { n: v.n, duration: v.duration, qc: v.qc, renderedAt: v.renderedAt, captioned: v.captioned, encoder: v.encoder } : null, post: c.postId ? D.posts.find((p) => p.id === c.postId) || null : null };
}
function approvalsView() {
  return D.approvals.filter((a) => a.status === 'pending').map((a) => {
    if (a.kind === 'clip') { const c = D.clips.find((x) => x.id === a.refId); return c ? { ...a, ref: clipView(c) } : null; }
    const m = Object.values(D.messages).flat().find((x) => x.id === a.refId);
    return m ? { ...a, ref: m, body: m.body, subject: m.subject, channel: m.channel, contact: D.conversations.find((c) => c.id === m.conversationId)?.title } : null;
  }).filter(Boolean);
}
function addMsg(convId, m) {
  const msg = { id: uid('me_'), createdAt: now(), conversationId: convId, attachments: [], ...m };
  (D.messages[convId] = D.messages[convId] || []).push(msg);
  const conv = D.conversations.find((c) => c.id === convId);
  if (conv) { conv.lastMessageAt = msg.createdAt; conv.preview = (msg.body || '').slice(0, 140); emit('conversation', conv); }
  emit('message', msg);
  return msg;
}
const CMD_ID = () => D.conversations.find((c) => c.kind === 'command').id;

async function command(text, convId) {
  const cmdConv = CMD_ID();
  const inThread = !convId || convId === cmdConv;
  if (inThread) addMsg(cmdConv, { direction: 'out', channel: 'command', body: text, status: 'sent', createdBy: 'ryan' });
  emit('typing', { conversationId: cmdConv, on: true });
  await wait(650);
  emit('typing', { conversationId: cmdConv, on: false });
  const name = text.startsWith('/') ? text.slice(1).split(' ')[0].toLowerCase() : null;
  let res;
  const card = (type, data) => ({ type, data });
  if (!name) res = { text: 'In the desktop app, plain-language requests go to the operations agent (Claude, GPT or Grok) and become commands. This example has no AI connected, so try a slash command: type / to see them all.' };
  else if (name === 'help') res = { text: 'Commands. Type any of these, or just say what you want.', card: card('help', D.bootstrap.commands) };
  else if (name === 'clients') res = { text: `${D.clients.filter((c) => c.status === 'active').length} active clients.`, card: card('clients', D.clients.map((c) => ({ id: c.id, name: c.name, type: c.type, status: c.status, retainer: c.monthly, autopilot: c.schedule?.autopilot, perDay: c.schedule?.shortsPerDay, quota: c.quota }))) };
  else if (name === 'clips') res = { text: `${D.clips.length} recent clips.`, card: card('clips', D.clips.slice(0, 12).map((c) => ({ id: c.id, ref: c.ref, title: c.title, status: c.status, client: c.client, duration: Math.round(c.end - c.start), score: c.score, version: c.currentVersion, thumb: c.versions?.length ? `/api/clips/${c.id}/thumb` : null }))) };
  else if (name === 'queue') res = { text: `${D.queueStats.running} running · ${D.queueStats.queued} queued`, card: card('jobs', D.jobs.slice(0, 8)) };
  else if (name === 'health') res = { text: `${D.health.summary.ok} OK · ${D.health.summary.warn} warnings · ${D.health.summary.error} errors`, card: card('health', D.health) };
  else if (name === 'agents') res = { text: 'Agent status', card: card('agents', D.agents) };
  else if (name === 'revenue') res = { text: `MRR $${D.finance.mrr.toLocaleString()} · profit $${D.finance.profit.toLocaleString()}`, card: card('revenue', D.finance) };
  else if (name === 'schedule') res = { text: `${D.posts.filter((p) => p.status === 'scheduled').length} upcoming posts.`, card: card('posts', D.posts.filter((p) => p.status === 'scheduled').map((p) => ({ id: p.id, title: p.title, at: p.scheduledAt, platforms: p.platforms, client: p.client }))) };
  else if (name === 'status') res = { text: `Test · ${D.bootstrap.settings.resources.mode} mode · CPU 18% · ${D.queueStats.running} running, ${D.queueStats.queued} queued` };
  else if (name === 'logs') res = { text: 'Recent activity', card: card('logs', D.logs.slice(0, 15)) };
  else if (name === 'approve' && !text.split(' ')[1]) res = { text: `${approvalsView().length} items pending.`, navigate: '/approvals' };
  else if (name === 'studio') res = { text: 'Opening Studio.', navigate: '/studio' };
  else if (name === 'lite' || name === 'full') { D.bootstrap.settings.resources.mode = name; emit('mode', { mode: name }); res = { text: name === 'lite' ? 'Lite mode on. Messaging, approvals and publishing keep running; rendering, transcription and analytics pause.' : 'Full mode on.' }; }
  else if (name === 'pause' || name === 'resume') { D.queueStats.paused = name === 'pause'; emit('queue', { paused: D.queueStats.paused }); res = { text: name === 'pause' ? 'Emergency stop is on. Nothing will be sent, published or rendered until you /resume.' : 'Automation resumed.' }; }
  else if (D.bootstrap.commands.some((c) => c.name === name)) res = { text: `/${name} runs for real in the desktop app. In this example it's shown but not executed.` };
  else res = { text: `Unknown command /${name}. Type /help for the list.`, error: true };
  if (inThread || !res.silent) addMsg(inThread ? cmdConv : convId, { direction: inThread ? 'in' : 'internal', channel: inThread ? 'system' : 'note', body: res.text, status: inThread ? 'received' : 'note', card: res.card || null, navigate: res.navigate || null, error: !!res.error });
  return res;
}

function decide(id, decision, note) {
  const c = D.clips.find((x) => x.id === id); if (!c) throw new Error('Clip not found');
  const appr = D.approvals.find((a) => a.refId === id && a.status === 'pending');
  if (appr) appr.status = decision === 'approve' ? 'approved' : decision === 'reject' ? 'rejected' : 'changes';
  if (decision === 'approve') {
    const client = D.clients.find((x) => x.id === c.clientId);
    const taken = new Set(D.posts.filter((p) => p.clientId === c.clientId).map((p) => p.scheduledAt));
    const slot = (D.slots[c.clientId] || []).find((s) => !taken.has(s)) || new Date(Date.now() + 864e5).toISOString();
    const post = { id: uid('po_'), clientId: c.clientId, client: c.client, clipId: c.id, ref: c.ref, title: c.title, caption: c.caption, hashtags: c.hashtags, platforms: client?.schedule?.platforms || [], scheduledAt: slot, status: 'scheduled', results: {} };
    D.posts.push(post); c.status = 'scheduled'; c.postId = post.id; emit('posts', post);
  } else if (decision === 'reject') c.status = 'rejected';
  else {
    c.status = 'revising'; c.feedback = [...(c.feedback || []), { id: uid('fb_'), at: now(), from: 'ryan', stage: 'internal', text: note }];
    const job = { id: uid('jo_'), type: 'clip.revise', title: `Revise: ${c.title}`, status: 'running', progress: 0.1, note: 'Interpreting feedback', clientId: c.clientId };
    D.jobs.unshift(job); emit('job', job);
    let p = 0.1;
    const t = setInterval(() => {
      p += 0.18; job.progress = Math.min(1, p); job.note = p < 0.4 ? 'Interpreting feedback' : 'Rendering v' + (c.versions.length + 1);
      emit('job', job);
      if (p >= 1) {
        clearInterval(t); job.status = 'done';
        c.versions = [...c.versions, { ...c.versions[c.versions.length - 1], n: c.versions.length + 1, renderedAt: now(), changes: { applied: { note: 'simulated' } } }];
        c.currentVersion = c.versions.length; c.status = 'review';
        D.approvals.push({ id: uid('ap_'), kind: 'clip', refId: c.id, clientId: c.clientId, client: c.client, title: c.title, status: 'pending', stage: 'internal', createdAt: now(), qc: c.versions[c.versions.length - 1].qc });
        emit('job', job); emit('clips', { id: c.id }); emit('approval', {});
      }
    }, 700);
  }
  emit('clips', { id }); emit('approval', {});
  return clipView(c);
}

const routes = [
  ['GET', /^\/api\/bootstrap$/, () => D.bootstrap],
  ['GET', /^\/api\/conversations$/, () => D.conversations.map((c) => ({ ...c, pendingApprovals: (D.messages[c.id] || []).filter((m) => m.status === 'pending_approval').length })).sort((a, b) => (b.pinned - a.pinned) || b.lastMessageAt.localeCompare(a.lastMessageAt))],
  ['GET', /^\/api\/conversations\/([^/]+)\/messages$/, (m) => D.messages[m[1]] || []],
  ['POST', /^\/api\/conversations\/([^/]+)\/read$/, (m) => { const c = D.conversations.find((x) => x.id === m[1]); if (c) c.unread = 0; return { ok: true }; }],
  ['POST', /^\/api\/conversations\/([^/]+)\/messages$/, (m, b) => {
    const msg = addMsg(m[1], b.internal ? { direction: 'internal', channel: 'note', body: b.body, status: 'note' } : { direction: 'out', channel: b.channel || 'sms', subject: b.subject, body: b.body, status: 'queued', createdBy: 'ryan' });
    if (!b.internal) setTimeout(() => { msg.status = 'sent'; msg.sentAt = now(); msg.testRedirect = true; emit('message', msg); }, 900);
    return msg;
  }],
  ['POST', /^\/api\/conversations\/([^/]+)\/ai-draft$/, () => { throw new Error('AI drafting needs Claude, GPT or Grok connected. It works in the desktop app once a key is added.'); }],
  ['POST', /^\/api\/messages\/([^/]+)\/(approve|discard)$/, (m, b) => {
    const msg = Object.values(D.messages).flat().find((x) => x.id === m[1]); if (!msg) throw new Error('Message not found');
    const a = D.approvals.find((x) => x.refId === msg.id && x.status === 'pending'); if (a) a.status = m[2] === 'approve' ? 'approved' : 'rejected';
    if (m[2] === 'approve') { msg.status = 'queued'; if (b?.body) msg.body = b.body; setTimeout(() => { msg.status = 'sent'; msg.sentAt = now(); msg.testRedirect = true; emit('message', msg); }, 900); } else msg.status = 'discarded';
    emit('message', msg); emit('approval', {}); return msg;
  }],
  ['POST', /^\/api\/command$/, (m, b) => command(String(b.text || ''), b.conversationId)],
  ['GET', /^\/api\/search$/, (m, b, q) => { const s = (q.get('q') || '').toLowerCase(); return Object.values(D.messages).flat().filter((x) => (x.body || '').toLowerCase().includes(s)).slice(-20).map((x) => ({ id: x.id, conversationId: x.conversationId, body: x.body, at: x.createdAt, title: D.conversations.find((c) => c.id === x.conversationId)?.title })); }],
  ['GET', /^\/api\/approvals$/, () => approvalsView()],
  ['GET', /^\/api\/clips$/, (m, b, q) => D.clips.filter((c) => (!q.get('clientId') || c.clientId === q.get('clientId')) && (!q.get('status') || q.get('status').split(',').includes(c.status))).map(clipView)],
  ['GET', /^\/api\/clips\/([^/]+)$/, (m) => clipView(D.clips.find((c) => c.id === m[1]))],
  ['PATCH', /^\/api\/clips\/([^/]+)$/, (m, b) => { const c = D.clips.find((x) => x.id === m[1]); Object.assign(c, b); emit('clips', { id: c.id }); return clipView(c); }],
  ['POST', /^\/api\/clips\/([^/]+)\/decide$/, (m, b) => decide(m[1], b.decision, b.note)],
  ['POST', /^\/api\/clips\/([^/]+)\/render$/, (m) => decide(m[1], 'changes', 'Re-render with current settings')],
  ['POST', /^\/api\/clips\/([^/]+)\/studio$/, () => D.projectSummaries[0] ? { id: D.projectSummaries[0].id } : { id: 'none' }],
  ['POST', /^\/api\/clips\/([^/]+)\/(premiere|open-velo)$/, () => { throw new Error('Handing off to Premiere (Astra) and Velo happens on your computer in the desktop app.'); }],
  ['GET', /^\/api\/assets$/, (m, b, q) => D.assets.filter((a) => !q.get('clientId') || a.clientId === q.get('clientId'))],
  ['GET', /^\/api\/jobs$/, (m, b, q) => D.jobs.filter((j) => !q.get('status') || q.get('status').split(',').includes(j.status))],
  ['GET', /^\/api\/jobs\/([^/]+)$/, (m) => D.jobs.find((j) => j.id === m[1]) || { id: m[1], title: 'Job', status: 'done', log: [] }],
  ['GET', /^\/api\/queue\/stats$/, () => D.queueStats],
  ['POST', /^\/api\/queue\/(pause|resume)$/, (m) => { D.queueStats.paused = m[1] === 'pause'; emit('queue', { paused: D.queueStats.paused }); return D.queueStats; }],
  ['POST', /^\/api\/mode$/, (m, b) => { D.bootstrap.settings.resources.mode = b.mode; emit('mode', { mode: b.mode }); return { mode: b.mode }; }],
  ['GET', /^\/api\/clients$/, () => D.clients],
  ['GET', /^\/api\/clients\/([^/]+)$/, (m) => D.clientDetail[m[1]]],
  ['PATCH', /^\/api\/clients\/([^/]+)$/, (m, b) => { const c = D.clientDetail[m[1]]; for (const k of Object.keys(b)) c[k] = typeof b[k] === 'object' && !Array.isArray(b[k]) ? { ...c[k], ...b[k] } : b[k]; const l = D.clients.find((x) => x.id === m[1]); Object.assign(l, { name: c.name, schedule: c.schedule, approval: c.approval, status: c.status }); emit('clients', { id: c.id }); return c; }],
  ['POST', /^\/api\/clients\/([^/]+)\/memory$/, (m, b) => { const c = D.clientDetail[m[1]]; c.memory = [...(c.memory || []), { id: uid('me_'), text: b.text, at: now(), source: 'manual', active: true }]; emit('clients', {}); return c.memory; }],
  ['GET', /^\/api\/posts$/, (m, b, q) => D.posts.filter((p) => (!q.get('clientId') || p.clientId === q.get('clientId')) && (!q.get('status') || q.get('status').split(',').includes(p.status)))],
  ['POST', /^\/api\/posts\/([^/]+)\/unschedule$/, (m) => { const p = D.posts.find((x) => x.id === m[1]); p.status = 'canceled'; const c = D.clips.find((x) => x.id === p.clipId); if (c) { c.status = 'approved'; c.postId = null; } emit('posts', {}); return { ok: true }; }],
  ['POST', /^\/api\/posts\/([^/]+)\/reschedule$/, (m, b) => { const p = D.posts.find((x) => x.id === m[1]); p.scheduledAt = new Date(b.at).toISOString(); emit('posts', {}); return p; }],
  ['GET', /^\/api\/prospects$/, () => D.prospects],
  ['PATCH', /^\/api\/prospects\/([^/]+)$/, (m, b) => { const p = D.prospects.find((x) => x.id === m[1]); Object.assign(p, b); emit('prospects', {}); return p; }],
  ['GET', /^\/api\/finance$/, () => D.finance],
  ['GET', /^\/api\/invoices$/, () => D.invoices],
  ['GET', /^\/api\/analytics$/, () => D.analytics],
  ['GET', /^\/api\/agents$/, () => D.agents],
  ['GET', /^\/api\/health$/, () => D.health],
  ['GET', /^\/api\/resources$/, () => ({ current: res(), history: D.history, gate: { ok: true } })],
  ['GET', /^\/api\/logs$/, () => D.logs],
  ['GET', /^\/api\/workers$/, () => []],
  ['GET', /^\/api\/users$/, () => D.users],
  ['GET', /^\/api\/backups$/, () => D.backups],
  ['GET', /^\/api\/secrets\/status$/, () => D.bootstrap.connections],
  ['GET', /^\/api\/projects$/, () => D.projectSummaries],
  ['GET', /^\/api\/projects\/([^/]+)$/, (m) => clone(D.projects[m[1]] || Object.values(D.projects)[0])],
  ['PUT', /^\/api\/projects\/([^/]+)$/, (m, b) => { if (D.projects[m[1]]) D.projects[m[1]].data = b.data; return D.projects[m[1]]; }],
  ['PATCH', /^\/api\/settings$/, (m, b) => { Object.assign(D.bootstrap.settings, b); return D.bootstrap.settings; }],
];

let cpu = 18;
function res() {
  cpu = Math.max(4, Math.min(64, cpu + (Math.random() - 0.5) * 9));
  return { ...D.resources, cpu: Math.round(cpu), mode: D.bootstrap.settings.resources.mode };
}

export const demoBackend = {
  setEmitter(fn) { emit = fn; },
  connect() {
    setTimeout(() => emit('connection', { online: true }), 50);
    setInterval(() => { const r = res(); D.history.push({ t: Date.now(), cpu: r.cpu, ram: r.ramTotalMb - r.ramFreeMb, gpu: null }); if (D.history.length > 120) D.history.shift(); emit('resources', r); }, 4000);
  },
  async request(method, path, body) {
    const u = new URL(path, 'http://demo');
    await wait(60 + Math.random() * 80);
    for (const [m, rx, fn] of routes) {
      if (m !== method) continue;
      const mm = rx.exec(u.pathname); if (!mm) continue;
      const r = await fn(mm, body || {}, u.searchParams);
      return r === undefined ? { ok: true } : clone(r);
    }
    if (method === 'GET') return [];
    throw new Error('This action runs in the desktop app. The example only simulates the main flows.');
  },
  async upload() { throw new Error('Uploading footage works in the desktop app. The example has sample footage already processed.'); },
  url(path) {
    const u = new URL(path, 'http://demo');
    let m;
    if ((m = /^\/api\/clips\/([^/]+)\/(video|thumb)$/.exec(u.pathname))) { const c = D.clips.find((x) => x.id === m[1]); return MEDIA[`${m[2]}:${c?.mediaKey || ''}`] || ''; }
    if ((m = /^\/api\/assets\/([^/]+)\/thumb$/.exec(u.pathname))) return MEDIA['asset-thumb'] || '';
    if (u.pathname === '/api/media/thumb') return MEDIA['asset-thumb'] || '';
    if (u.pathname === '/api/media') return MEDIA['source'] || '';
    return '';
  },
};
