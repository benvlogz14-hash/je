'use strict';
/**
 * Agent Registry: which agents exist, how each one is connected, and whether it
 * is ready. Built-in agents are listed here; custom agents are added from
 * Settings → Agent Connections. Every agent is a peer: there is no lead agent.
 */
const ctx = require('../core/ctx');
const secrets = require('../core/secrets');
const audit = require('../core/audit');
const events = require('../core/events');
const { id: makeId, now, slug } = require('../core/util');
const adapters = require('./adapters');

const BUILT_IN = [
  {
    id: 'grok', name: 'Grok', vendor: 'xAI', tone: 'gold', connections: ['grokbot', 'account', 'api', 'cli', 'herdr'], defaultConnection: 'grokbot', site: 'grok',
    blurb: 'Fast research and trend scouting. No key needed: your GrokBot by email, or your Grok login. Or an xAI API key.',
    api: { provider: 'xai', models: ['grok-4', 'grok-4-fast', 'grok-code-fast-1'] },
    cli: { bins: ['grok'], npm: '@vibe-kit/grok-cli', args: ['--prompt', '{prompt}'], keyEnv: { GROK_API_KEY: 'global.xai.apiKey' }, alwaysShareKey: true, herdrKind: 'grok', interactiveArgs: [], loginArgs: [] },
  },
  {
    id: 'claude', name: 'Claude', vendor: 'Anthropic', tone: 'coral', connections: ['connector', 'account', 'api', 'cli', 'herdr'], defaultConnection: 'connector', site: 'claude',
    blurb: 'Writing, critique and careful reasoning. No key needed: through the Claude app (Euclidean connector) or your Claude login. Or an API key / Claude Code.',
    api: { provider: 'anthropic', models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'] },
    cli: { bins: ['claude'], npm: '@anthropic-ai/claude-code', args: ['-p', '--output-format', 'text', '--model', '{model}'], promptVia: 'stdin', keyEnv: { ANTHROPIC_API_KEY: 'global.anthropic.apiKey' }, herdrKind: 'claude', interactiveArgs: [], loginArgs: [] },
  },
  {
    id: 'codex', name: 'GPT / Codex', vendor: 'OpenAI', tone: 'teal', connections: ['account', 'api', 'cli', 'herdr'], defaultConnection: 'account', site: 'chatgpt',
    blurb: 'Analysis and code. No key needed: your ChatGPT login. Or an API key, or the Codex command-line agent.',
    api: { provider: 'openai', models: ['gpt-5', 'gpt-5-mini', 'gpt-5-codex'] },
    cli: { bins: ['codex'], npm: '@openai/codex', args: ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '--model', '{model}', '-'], promptVia: 'stdin', keyEnv: { OPENAI_API_KEY: 'global.openai.apiKey' }, herdrKind: 'codex', interactiveArgs: [], loginArgs: ['login'] },
  },
  {
    id: 'cursor', name: 'Cursor', vendor: 'Anysphere', tone: 'slate', connections: ['cli', 'herdr'], defaultConnection: 'cli',
    blurb: 'Cursor\'s agent, run from its command-line tool. Uses your Cursor account.',
    models: ['auto', 'sonnet-4.5', 'gpt-5'],
    cli: { bins: ['cursor-agent'], script: { windows: "irm 'https://cursor.com/install?win32=true' | iex", unix: 'curl https://cursor.com/install -fsS | bash' }, args: ['-p', '{prompt}', '--output-format', 'text', '--model', '{model}'], herdrKind: 'cursor', interactiveArgs: [], loginArgs: ['login'] },
  },
  {
    id: 'opencode', name: 'opencode', vendor: 'open source', tone: 'lav', connections: ['cli', 'herdr'], defaultConnection: 'cli',
    blurb: 'Open-source coding agent that works with many model providers.',
    models: ['anthropic/claude-sonnet-5-5', 'openai/gpt-5', 'xai/grok-4'],
    cli: { bins: ['opencode'], npm: 'opencode-ai', args: ['run', '--model', '{model}', '{prompt}'], herdrKind: 'opencode', interactiveArgs: [], loginArgs: ['auth', 'login'] },
  },
];

// Free and always there: the local Llama (Ollama) as its own agent.
BUILT_IN.push({ id: 'llama', name: 'Llama', vendor: 'Ollama (free, on this PC)', tone: 'moss', connections: ['ollama'], defaultConnection: 'ollama', blurb: 'The free AI running on this computer. No key, no limits; quickest for everyday questions.' });

const BOT_TONE = { sky: 'sky', coral: 'coral', gold: 'gold', lav: 'lav', moss: 'moss', teal: 'teal', rose: 'coral' };
/** Euclidean's own bots (Corbin, Juno, Scout, Data Bot, ...) as agents: they bring their tools, web and Data tab. */
function botDefs() {
  return ctx.store.all('bots').map((b) => ({ id: `bot-${String(b.id).toLowerCase()}`, botId: b.id, name: b.name, vendor: `Euclidean bot${b.role ? ` · ${String(b.role).split(/[.:(]/)[0].slice(0, 40)}` : ''}`, tone: BOT_TONE[b.color] || 'sky', connections: ['bot'], defaultConnection: 'bot', bot: true,
    blurb: `${b.emoji || '🤖'} ${b.role || 'One of your Euclidean bots'} It uses its own tools (live web, Data tab, leads, documents) and answers in this conversation.` }));
}

/**
 * The connection an agent uses when none was picked: an API key wins when one is saved; otherwise the free ways
 * (Claude through the Claude app, Grok through your GrokBot or login, ChatGPT through your login).
 */
function defaultConnection(d) {
  const keys = { claude: 'anthropic', grok: 'xai', codex: 'openai' };
  if (keys[d.id]) {
    const ai = require('../integrations/ai');
    if (secrets.has(ai.PROVIDERS[keys[d.id]].keyName)) return 'api';
    if (d.id === 'grok') { try { if (require('../integrations/grokbots').bots().length) return 'grokbot'; } catch { /* none */ } return 'account'; }
  }
  return d.defaultConnection;
}

const CUSTOM_BASE = { vendor: 'Custom', tone: 'sky', connections: ['api', 'cli', 'local'], defaultConnection: 'local', custom: true, blurb: 'Any other agent: an OpenAI-compatible API, a command-line tool, or an agent on this computer or network.', cli: { bins: [], args: ['{prompt}'] } };

function conf(id) { return ctx.setting(`agentNet.agents.${id}`, {}) || {}; }
function customList() { return ctx.setting('agentNet.custom', []) || []; }

function definitions() {
  return [...BUILT_IN, ...botDefs(), ...customList().map((c) => ({ ...CUSTOM_BASE, ...c, cli: { ...CUSTOM_BASE.cli } }))];
}
function def(id) { const k = String(id || '').toLowerCase(); return definitions().find((d) => d.id === k) || null; }
/** The connection in use: the one picked in Agent Connections, else the best free one. */
function connectionOf(id) { const d = def(id); const c = conf(id); return c.connection && d?.connections.includes(c.connection) ? c.connection : d ? defaultConnection(d) : null; }

function adapter(id) {
  const d = def(id); if (!d) throw new Error(`There's no agent called "${id}".`);
  return adapters.create(d, { ...conf(d.id), connection: connectionOf(d.id) });
}

/** Save part of an agent's setup. Writes the whole agents map (settings merge is shallow per key). */
function setConf(id, patch) {
  const all = JSON.parse(JSON.stringify(ctx.setting('agentNet.agents', {}) || {}));
  all[id] = { ...(all[id] || {}), ...patch };
  ctx.store.data.settings.agentNet = { ...(ctx.store.settings.agentNet || {}), agents: all };
  ctx.store.touch(); ctx.store.emit('settings', 'update', ctx.store.settings);
  invalidate(id);
  events.publish('agentnet', { agentId: id, kind: 'agent' });
  return all[id];
}

function addCustom(name, actor) {
  const label = String(name || 'Custom agent').slice(0, 40);
  let id = slug(label).slice(0, 24) || 'custom';
  if (def(id)) id = `${id}-${makeId('').slice(0, 4).toLowerCase()}`;
  const list = [...customList(), { id, name: label }];
  ctx.store.data.settings.agentNet = { ...(ctx.store.settings.agentNet || {}), custom: list };
  ctx.store.touch();
  setConf(id, { enabled: true, connection: 'local', autoReply: true });
  audit.log(actor, 'agentnet.agent_added', { agentId: id, name: label });
  return id;
}
function removeCustom(id, actor) {
  const d = def(id); if (!d?.custom) throw new Error('Only custom agents can be removed.');
  ctx.store.data.settings.agentNet = { ...(ctx.store.settings.agentNet || {}), custom: customList().filter((c) => c.id !== id) };
  const all = { ...(ctx.setting('agentNet.agents', {}) || {}) }; delete all[id]; ctx.store.data.settings.agentNet.agents = all;
  ctx.store.touch(); secrets.set(adapters.customKeyName(id), '');
  audit.log(actor, 'agentnet.agent_removed', { agentId: id });
}

// detect() can spawn processes, so results are cached briefly.
const detectCache = new Map();
function invalidate(id) { if (id) detectCache.delete(id); else detectCache.clear(); }
async function detect(id, { fresh } = {}) {
  const c = detectCache.get(id);
  if (!fresh && c && Date.now() - c.at < 60000) return c.v;
  let v;
  try { v = await adapter(id).detect(); } catch (e) { v = { installed: false, note: e.message }; }
  detectCache.set(id, { at: Date.now(), v });
  return v;
}

/** connected | not_connected | needs_attention, with a one-line plain-English reason. */
function health(d, c, det, failed) {
  if (c.enabled === false) return { state: 'not_connected', reason: 'Turned off' };
  if (!det.installed) {
    if (c.lastTest?.ok) return { state: 'needs_attention', reason: det.herdrMissing ? 'Herdr is missing' : `${d.name} was moved or uninstalled` };
    return { state: 'not_connected', reason: det.note || 'Not set up yet' };
  }
  if (c.lastTest && !c.lastTest.ok && !det.ready) return { state: 'needs_attention', reason: c.lastTest.error };
  if (failed && !det.ready) return { state: 'needs_attention', reason: `${failed} message${failed > 1 ? 's' : ''} failed recently` };
  if (det.ready) return { state: 'connected', reason: det.note || 'Ready' };
  if (!c.lastTest) return { state: 'needs_attention', reason: 'Set up, not tested yet. Click Test.' };
  return { state: 'connected', reason: c.lastTest.message || 'Ready' };
}

async function list({ fresh } = {}) {
  const since = Date.now() - 24 * 3600e3;
  const msgs = ctx.store.all('agentMessages', (m) => new Date(m.createdAt).getTime() > since);
  return Promise.all(definitions().map(async (d) => {
    const c = conf(d.id);
    const det = await detect(d.id, { fresh });
    const failed = msgs.filter((m) => m.deliveries?.[d.id]?.status === 'failed').length;
    const connection = connectionOf(d.id);
    const keyName = connection === 'api' ? (d.api?.provider ? require('../integrations/ai').PROVIDERS[d.api.provider].keyName : adapters.customKeyName(d.id)) : connection === 'local' ? adapters.customKeyName(d.id) : null;
    return {
      id: d.id, name: d.name, vendor: d.vendor, tone: d.tone, blurb: d.blurb, custom: !!d.custom, bot: !!d.bot, connections: d.connections, connection,
      models: d.api?.models && connection === 'api' ? d.api.models : d.models || d.api?.models || [],
      installable: connection === 'cli' || connection === 'herdr' ? !!(d.cli?.npm || d.cli?.script) : false,
      needsKey: connection === 'api', keyName, keySaved: keyName ? secrets.has(keyName) : false,
      canLogin: (connection === 'cli' || connection === 'herdr') && Array.isArray(d.cli?.loginArgs) && !d.custom,
      defaults: { args: d.cli?.args || [], bins: d.cli?.bins || [] },
      config: { enabled: c.enabled !== false, model: c.model || '', path: c.path || '', command: c.command || '', args: c.args || [], shareApiKey: !!c.shareApiKey, baseUrl: c.baseUrl || '', url: c.url || '', mailbox: !!c.mailbox, autoReply: c.autoReply !== false, workspaces: c.workspaces || 'all', note: c.note || '' },
      detect: det, lastTest: c.lastTest || null, health: health(d, c, det, failed), usesHerdr: connection === 'herdr',
    };
  }));
}

function name(id) {
  if (!id) return 'Unknown';
  if (id.startsWith('human:')) { const u = ctx.store.get('users', id.slice(6)); return u ? u.name : 'You'; }
  if (id === 'system') return 'Euclidean';
  return def(id)?.name || id;
}
/** An agent id from what someone typed: "juno", "@Corbin", "claude", "llama". */
function findId(word) {
  const w = String(word || '').replace(/^@/, '').toLowerCase().trim(); if (!w) return null;
  const ds = definitions();
  return (ds.find((d) => d.id === w) || ds.find((d) => d.name.toLowerCase() === w) || ds.find((d) => d.name.toLowerCase().split(/[\s/]+/)[0] === w) || ds.find((d) => d.id === `bot-${w}`))?.id || null;
}

/** May this agent see this workspace? ('all' or a list of workspace ids) */
function allowedIn(id, workspaceId) {
  const w = conf(id).workspaces || 'all';
  return w === 'all' || (Array.isArray(w) && w.includes(workspaceId));
}

module.exports = { findId, connectionOf, botDefs, BUILT_IN, definitions, def, conf, setConf, adapter, addCustom, removeCustom, detect, invalidate, list, name, allowedIn };
