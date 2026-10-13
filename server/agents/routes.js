'use strict';
/** REST routes for Settings → Agent Connections and the Agent Conversations panel. */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ctx = require('../core/ctx');
const audit = require('../core/audit');
const secrets = require('../core/secrets');
const { HttpError, now, id: makeId } = require('../core/util');
const registry = require('./registry');
const broker = require('./broker');
const herdr = require('./herdr');
const tools = require('./tools');

const OWNER = ['owner'];
const STAFF = ['owner', 'contractor'];
const AGENT = ['owner', 'agent'];
const actorOf = (req) => req.user?.id || 'unknown';
const human = (req) => `human:${actorOf(req)}`;

// Settings an agent card may change (anything else is ignored).
const CONF_KEYS = ['enabled', 'connection', 'model', 'path', 'command', 'args', 'shareApiKey', 'baseUrl', 'url', 'mailbox', 'autoReply', 'workspaces', 'note'];

async function saveResult(id, r) {
  if (r?.save) registry.setConf(id, r.save);
  registry.invalidate(id);
  return r;
}
async function runTest(id) {
  let r;
  try { r = await registry.adapter(id).test(); } catch (e) { r = { ok: false, error: e.message }; }
  registry.setConf(id, { lastTest: { ok: !!r.ok, at: now(), message: r.message || null, error: r.ok ? null : r.error || 'Test failed', needsLogin: !!r.needsLogin } });
  registry.invalidate(id);
  return r;
}

module.exports = function mount(r) {
  // ---------------------------------------------------------- setup (owner)
  r.get('/api/agentnet/agents', async (req) => ({ agents: await registry.list({ fresh: req.query.fresh === '1' }), node: !!tools.findNode(), platform: process.platform }), { roles: STAFF });

  r.patch('/api/agentnet/agents/:id', (req, b, p) => {
    if (!registry.def(p.id)) throw new HttpError(404, 'Unknown agent');
    const patch = {};
    for (const k of CONF_KEYS) if (b[k] !== undefined) patch[k] = b[k];
    if (patch.connection && !registry.def(p.id).connections.includes(patch.connection)) throw new HttpError(400, 'That connection type isn\'t available for this agent');
    if (patch.args && !Array.isArray(patch.args)) patch.args = String(patch.args).split(/\s+/).filter(Boolean);
    if (patch.workspaces && patch.workspaces !== 'all' && !Array.isArray(patch.workspaces)) throw new HttpError(400, 'Workspaces must be "all" or a list');
    if (patch.connection || patch.path || patch.command || patch.url || patch.baseUrl) patch.lastTest = null; // a changed connection must be re-tested
    const c = registry.setConf(p.id, patch);
    audit.log(actorOf(req), 'agentnet.agent_updated', { agentId: p.id, keys: Object.keys(patch) });
    return c;
  }, { roles: OWNER });

  r.post('/api/agentnet/agents/:id/key', async (req, b, p) => {
    const list = await registry.list(); const a = list.find((x) => x.id === p.id);
    if (!a?.keyName) throw new HttpError(400, 'This connection doesn\'t use an API key');
    const key = String(b.key || '').trim();
    if (!key) throw new HttpError(400, 'Paste the API key first');
    secrets.set(a.keyName, key);
    audit.log(actorOf(req), 'credentials.updated', { keys: [a.keyName], via: 'agent-connections' });
    registry.invalidate(p.id);
    require('../core/events').publish('connections', {});
    return runTest(p.id);
  }, { roles: OWNER });

  r.post('/api/agentnet/agents/:id/install', async (req, b, p) => {
    audit.log(actorOf(req), 'agentnet.install_started', { agentId: p.id });
    try {
      const res = await saveResult(p.id, await registry.adapter(p.id).install());
      if (!res.ok) return res;
      audit.log(actorOf(req), 'agentnet.installed', { agentId: p.id, path: res.path });
      return { ...(await runTest(p.id)), installed: true, path: res.path };
    } catch (e) { return { ok: false, error: e.message, needsNode: !!e.needsNode }; }
  }, { roles: OWNER });

  r.post('/api/agentnet/agents/:id/configure', async (req, b, p) => {
    const res = await saveResult(p.id, await registry.adapter(p.id).configure());
    if (!res.ok) return res;
    return { ...(await runTest(p.id)), path: res.path };
  }, { roles: OWNER });

  r.post('/api/agentnet/agents/:id/test', async (req, b, p) => runTest(p.id), { roles: OWNER });

  r.post('/api/agentnet/agents/:id/reconnect', async (req, b, p) => {
    registry.invalidate(p.id);
    const a = registry.adapter(p.id);
    const c = await a.configure().catch((e) => ({ ok: false, error: e.message }));
    if (c?.save) registry.setConf(p.id, c.save);
    broker.cancel(p.id, actorOf(req));
    return runTest(p.id);
  }, { roles: OWNER });

  r.post('/api/agentnet/agents/:id/login', async (req, b, p) => registry.adapter(p.id).login(), { roles: OWNER });

  /** A token so an agent outside Euclidean can fetch its inbox and send messages (mailbox mode). */
  r.post('/api/agentnet/agents/:id/token', (req, b, p) => {
    if (!registry.def(p.id)) throw new HttpError(404, 'Unknown agent');
    ctx.store.removeWhere('users', (u) => u.role === 'agent' && u.agentId === p.id);
    const token = 'eu_' + crypto.randomBytes(24).toString('base64url');
    ctx.store.insert('users', { id: makeId('u_'), name: registry.def(p.id).name, role: 'agent', agentId: p.id, token });
    audit.log(actorOf(req), 'agentnet.token_created', { agentId: p.id });
    return { token, base: `http://${ctx.lanAddress || '127.0.0.1'}:${ctx.port}` };
  }, { roles: OWNER });

  r.post('/api/agentnet/custom', (req, b) => ({ id: registry.addCustom(b.name, actorOf(req)) }), { roles: OWNER });
  r.del('/api/agentnet/custom/:id', (req, b, p) => { registry.removeCustom(p.id, actorOf(req)); ctx.store.removeWhere('users', (u) => u.role === 'agent' && u.agentId === p.id); return { ok: true }; }, { roles: OWNER });

  r.post('/api/agentnet/node/install', async (req) => { audit.log(actorOf(req), 'agentnet.node_install', {}); try { return await tools.installNode(); } catch (e) { return { ok: false, error: e.message }; } }, { roles: OWNER });

  // ---------------------------------------------------------- Herdr (terminal runtime for CLI agents)
  r.get('/api/agentnet/herdr', async () => {
    const s = await herdr.status();
    const usedBy = (await registry.list()).filter((a) => a.connection === 'herdr').map((a) => ({ id: a.id, name: a.name }));
    return { ...s, usedBy };
  }, { roles: STAFF });
  r.post('/api/agentnet/herdr/install', async (req) => { try { return await herdr.install(actorOf(req)); } catch (e) { return { ok: false, error: e.message }; } }, { roles: OWNER });
  r.post('/api/agentnet/herdr/install-file', async (req, b) => {
    let file = b.path;
    if (!file) {
      if (!ctx.pickFiles) throw new HttpError(400, 'Choosing a file is only available in the desktop app');
      [file] = await ctx.pickFiles({ multi: false, filters: [{ name: 'Herdr download', extensions: ['zip', 'exe', 'gz', 'tgz'] }] });
      if (!file) return { ok: false, canceled: true };
    }
    try { return await herdr.installFromFile(file, actorOf(req)); } catch (e) { return { ok: false, error: e.message }; }
  }, { roles: OWNER });
  r.post('/api/agentnet/herdr/configure', async () => herdr.configure(), { roles: OWNER });
  r.post('/api/agentnet/herdr/test', async () => herdr.test(), { roles: OWNER });

  // ---------------------------------------------------------- conversations
  r.get('/api/agentnet/status', () => broker.status(), { roles: STAFF });
  r.post('/api/agentnet/pause', (req, b) => broker.setGlobalPause(!!b.paused, actorOf(req)), { roles: STAFF });
  r.get('/api/agentnet/threads', (req) => broker.threads({ workspaceId: req.query.workspaceId, status: req.query.status }), { roles: STAFF });
  r.post('/api/agentnet/threads', (req, b) => {
    const t = broker.createThread({ title: b.title, workspaceId: b.workspaceId, participants: b.participants || [], createdBy: actorOf(req) });
    if (b.body) broker.send({ threadId: t.id, from: human(req), to: b.to || ['*'], type: b.type || 'message', body: b.body, context: b.context || [] });
    return t;
  }, { roles: STAFF });
  r.get('/api/agentnet/threads/:id/messages', (req, b, p) => broker.messages(p.id), { roles: STAFF });
  r.post('/api/agentnet/threads/:id/messages', (req, b, p) => broker.send({ ...b, threadId: p.id, from: human(req) }, { actor: human(req) }), { roles: STAFF });
  r.post('/api/agentnet/threads/:id/join', (req, b, p) => broker.join(p.id, b.agentId, human(req)), { roles: STAFF });
  r.post('/api/agentnet/threads/:id/pause', (req, b, p) => broker.setPaused(p.id, !!b.paused, human(req)), { roles: STAFF });
  r.post('/api/agentnet/threads/:id/archive', (req, b, p) => { ctx.store.update('agentThreads', p.id, { status: b.archived === false ? 'active' : 'archived' }); audit.log(actorOf(req), 'agentnet.thread_archived', { threadId: p.id }); return { ok: true }; }, { roles: STAFF });
  /** Attach files: they're copied into the conversation's own workspace folder, never shared across workspaces. */
  r.post('/api/agentnet/threads/:id/attach', async (req, b, p) => {
    const t = ctx.store.get('agentThreads', p.id); if (!t) throw new HttpError(404, 'Conversation not found');
    let files = b.paths || [];
    if (!files.length && ctx.pickFiles) files = await ctx.pickFiles({ multi: true });
    const dir = path.join(broker.workspaceDir(t.workspaceId), 'agent-shared'); fs.mkdirSync(dir, { recursive: true });
    return files.filter((f) => fs.existsSync(f) && fs.statSync(f).isFile()).map((f) => {
      const dest = path.join(dir, `${Date.now().toString(36)}-${path.basename(f)}`);
      fs.copyFileSync(f, dest);
      return { kind: 'file', name: path.basename(f), path: dest };
    });
  }, { roles: STAFF });
  r.post('/api/agentnet/messages/:id/retry', (req, b, p) => broker.retry(p.id, b.agentId, actorOf(req)), { roles: STAFF });
  r.post('/api/agentnet/agents/:id/stop', (req, b, p) => broker.cancel(p.id, actorOf(req)), { roles: STAFF });
  r.get('/api/agentnet/agents/:id/inbox', (req, b, p) => broker.inbox(p.id), { roles: STAFF });
  r.get('/api/agentnet/agents/:id/outbox', (req, b, p) => broker.outbox(p.id), { roles: STAFF });
  r.get('/api/agentnet/failed', () => broker.failed(), { roles: STAFF });
  r.get('/api/agentnet/approvals', (req) => broker.approvals(req.query.status ?? 'pending'), { roles: STAFF });
  r.post('/api/agentnet/approvals/:id/decide', async (req, b, p) => broker.decide(p.id, !!b.approve, actorOf(req), b.note), { roles: OWNER });

  // ---------------------------------------------------------- mailbox API for agents running outside Euclidean
  const agentOf = (req) => { const a = req.user.agentId; if (!a) throw new HttpError(403, 'This token isn\'t linked to an agent. Create one in Settings → Agent Connections.'); return a; };
  r.get('/api/agentnet/mailbox', (req) => ({ agent: agentOf(req), inbox: broker.inbox(agentOf(req), { limit: Number(req.query.limit || 50) }).filter((m) => !req.query.unread || m.deliveries?.[agentOf(req)]?.status !== 'read'), threads: broker.threads().filter((t) => t.participants.includes(agentOf(req))) }), { roles: AGENT });
  r.post('/api/agentnet/mailbox/send', (req, b) => {
    const a = agentOf(req);
    const m = broker.send({ ...b, from: a });
    if (b.inReplyTo) { const orig = ctx.store.get('agentMessages', b.inReplyTo); if (orig?.deliveries?.[a]) ctx.store.update('agentMessages', orig.id, (x) => ({ deliveries: { ...x.deliveries, [a]: { ...x.deliveries[a], status: 'replied', replyId: m.id, at: now() } } })); }
    return m;
  }, { roles: AGENT });
  r.post('/api/agentnet/mailbox/:id/read', (req, b, p) => { const a = agentOf(req); const m = ctx.store.get('agentMessages', p.id); if (m?.deliveries?.[a] && m.deliveries[a].status === 'delivered') ctx.store.update('agentMessages', m.id, (x) => ({ deliveries: { ...x.deliveries, [a]: { ...x.deliveries[a], status: 'read', at: now() } } })); return { ok: true }; }, { roles: AGENT });
};
