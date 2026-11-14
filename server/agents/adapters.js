'use strict';
/**
 * AgentAdapter: the one interface every agent connection implements, so the
 * broker treats Grok, Claude, GPT/Codex, Cursor, opencode and custom agents the
 * same way.
 *
 *   detect()    → { installed, path?, version?, note? }   is it on this computer / reachable
 *   install()   → one-click install of anything needed locally
 *   configure() → find it and remember where it is (no PATH or config editing)
 *   test()      → { ok, message | error, models? }        plain-English result
 *   login()     → opens the vendor's own sign-in (CLI agents that need it)
 *   deliver({ system, prompt, model, clientId, signal }) → reply text
 *
 * Connection kinds: api (vendor HTTP API), cli (runs the vendor's command line
 * tool), herdr (the same CLI tool, kept alive in a Herdr terminal session),
 * local (an agent on this machine or network reached over HTTP, or one that
 * fetches its own inbox from Euclidean).
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const ctx = require('../core/ctx');
const secrets = require('../core/secrets');
const ai = require('../integrations/ai');
const tools = require('./tools');
const herdr = require('./herdr');

class AgentAdapter {
  constructor(def, conf) { this.def = def; this.conf = conf || {}; }
  get kind() { return 'base'; }
  async detect() { return { installed: true }; }
  async install() { return { ok: true, message: 'Nothing to install.' }; }
  async configure() { return { ok: true }; }
  async test() { throw new Error('not implemented'); }
  async login() { return { ok: false, error: 'This connection has no separate sign-in.' }; }
  async deliver() { throw new Error('not implemented'); }
}

// ------------------------------------------------------------ API
function customKeyName(id) { return `agent.${id}.apiKey`; }

class ApiAdapter extends AgentAdapter {
  get kind() { return 'api'; }
  provider() { return this.def.api?.provider || null; }
  keyName() { return this.provider() ? ai.PROVIDERS[this.provider()].keyName : customKeyName(this.def.id); }
  async detect() { return { installed: secrets.has(this.keyName()), note: secrets.has(this.keyName()) ? 'API key saved' : 'Add an API key' }; }
  async configure() { return { ok: secrets.has(this.keyName()), error: secrets.has(this.keyName()) ? undefined : 'Paste an API key first.' }; }
  async test() {
    if (!secrets.has(this.keyName())) return { ok: false, error: 'No API key saved yet. Paste your key and click Save & test.' };
    if (this.provider()) {
      const r = await ai.test(this.provider());
      return r.ok ? { ok: true, message: `${this.def.name} answered. ${r.models.length} models available.`, models: r.models } : { ok: false, error: explainHttp(r.error, this.def.name) };
    }
    const base = String(this.conf.baseUrl || '').replace(/\/$/, '');
    if (!base) return { ok: false, error: 'Add the agent\'s web address (base URL) under Show advanced.' };
    try {
      const r = await fetch(`${base}/models`, { headers: { authorization: `Bearer ${secrets.get(this.keyName())}` }, signal: AbortSignal.timeout(20000) });
      if (!r.ok) return { ok: false, error: explainHttp(`${r.status}`, this.def.name) };
      const j = await r.json().catch(() => ({}));
      const models = (j.data || []).map((m) => m.id).filter(Boolean).sort();
      return { ok: true, message: `${this.def.name} answered.`, models };
    } catch (e) { return { ok: false, error: `Couldn't reach ${base}. Check the address and that the service is running.` }; }
  }
  async deliver({ system, prompt, model, clientId }) {
    const messages = [{ role: 'user', content: prompt }];
    if (this.provider()) {
      const p = this.provider();
      if (ai.overBudget(p)) throw new Error(`${this.def.name} reached its monthly budget (Settings → AI).`);
      const m = model || this.conf.model || ai.defaultModelFor(p);
      const r = await ai.callProvider(p, { model: m, system, messages, maxTokens: 2500 });
      ai.recordUsage({ provider: p, model: r.model, role: 'agent-net', clientId, inTok: r.inTok, outTok: r.outTok });
      return r.text;
    }
    const base = String(this.conf.baseUrl || '').replace(/\/$/, '');
    const r = await fetch(`${base}/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${secrets.get(this.keyName())}` },
      body: JSON.stringify({ model: model || this.conf.model, messages: [{ role: 'system', content: system }, ...messages] }), signal: AbortSignal.timeout(180000),
    });
    const t = await r.text();
    if (!r.ok) throw new Error(explainHttp(`${r.status} ${t.slice(0, 200)}`, this.def.name));
    const j = JSON.parse(t);
    return j.choices?.[0]?.message?.content || '';
  }
}

function explainHttp(msg, name) {
  const s = String(msg || '');
  if (/\b401\b|\b403\b|auth|invalid.*key/i.test(s)) return `${name} rejected the API key. Copy it again from the provider's website and paste it here.`;
  if (/\b429\b|rate|quota|credit|billing/i.test(s)) return `${name} says the account is out of credit or rate-limited. Check billing on the provider's website.`;
  if (/\b404\b|model/i.test(s)) return `${name} doesn't recognise that model. Pick another one from the list.`;
  if (/unreachable|fetch failed|ENOTFOUND|ECONN/i.test(s)) return `Couldn't reach ${name}. Check the internet connection.`;
  return s;
}

// ------------------------------------------------------------ CLI
const LOGIN_HINT = /not (logged|signed) in|login required|please (log|sign) ?in|unauthori[sz]ed|authenticate|api key/i;

class CliAdapter extends AgentAdapter {
  get kind() { return 'cli'; }
  get cli() { return this.def.cli || {}; }
  binNames() { return this.conf.command ? [this.conf.command] : this.cli.bins || []; }
  bin() {
    if (this.conf.command && path.isAbsolute(this.conf.command) && fs.existsSync(this.conf.command)) return this.conf.command;
    return tools.findExecutable(this.binNames(), { preferred: this.conf.path });
  }
  async detect() {
    const b = this.bin();
    if (!b) return { installed: false, note: 'Not installed on this computer' };
    let version = null;
    try { const r = await tools.exec(b, this.cli.versionArgs || ['--version'], { timeoutMs: 20000 }); version = (r.out || r.err).trim().split(/\r?\n/)[0].slice(0, 80); } catch { /* still installed */ }
    return { installed: true, path: b, version };
  }
  async install() {
    if (this.cli.npm) await tools.npmInstall(this.cli.npm, this.cli.bins);
    else if (this.cli.script) await tools.runInstallScript(this.cli.script);
    else throw new Error(`${this.def.name} can't be installed from here. Install it, then click "Configure automatically".`);
    return this.configure();
  }
  async configure() {
    const b = tools.findExecutable(this.binNames());
    if (!b) return { ok: false, error: `${this.def.name} wasn't found on this computer. Click Install.` };
    return { ok: true, path: b, save: { path: b } };
  }
  env() {
    const e = {};
    // Grok CLI only works with an xAI key; others use their own sign-in unless the person opts in.
    for (const [envName, keyName] of Object.entries(this.cli.keyEnv || {})) {
      if ((this.cli.alwaysShareKey || this.conf.shareApiKey) && secrets.has(keyName)) e[envName] = secrets.get(keyName);
    }
    return e;
  }
  args(prompt, model) {
    const base = Array.isArray(this.conf.args) && this.conf.args.length ? this.conf.args : this.cli.args || [];
    const out = [];
    for (const a of base) {
      if (a === '{model}') { if (model) out.push(model); else out.pop(); continue; }
      out.push(a === '{prompt}' ? prompt : a);
    }
    return out;
  }
  async test() {
    const d = await this.detect();
    if (!d.installed) return { ok: false, error: `${this.def.name} isn't installed yet. Click Install.` };
    try {
      const reply = await this.deliver({ system: 'You are being connection-tested.', prompt: 'Reply with the single word: ready', timeoutMs: 120000 });
      return { ok: true, message: `${this.def.name} ${d.version ? `(${d.version}) ` : ''}answered: "${reply.trim().slice(0, 60)}"` };
    } catch (e) {
      if (LOGIN_HINT.test(e.message)) return { ok: false, needsLogin: true, error: `${this.def.name} is installed but not signed in. Click "Sign in" and finish in the window that opens.` };
      return { ok: false, error: e.message };
    }
  }
  async login() {
    const b = this.bin();
    if (!b) return { ok: false, error: `Install ${this.def.name} first.` };
    openTerminal(b, this.cli.loginArgs || [], `${this.def.name} sign-in`);
    return { ok: true, message: `A window opened for ${this.def.name}. Sign in there, close it, then click Test.` };
  }
  async deliver({ system, prompt, model, timeoutMs, signal }) {
    const b = this.bin();
    if (!b) throw new Error(`${this.def.name} isn't installed on this computer. Open Settings → Agent Connections and click Install.`);
    let full = `${system}\n\n${prompt}`;
    // Very long prompts go through a file the agent reads (command lines have a length limit).
    let tmp = null;
    if (this.cli.promptVia !== 'stdin' && full.length > 6000) {
      tmp = path.join(tools.toolsDir('cli-work'), `prompt-${Date.now()}.md`); fs.writeFileSync(tmp, full);
      full = `Read the file ${tmp} and respond to it. Reply with your answer only.`;
    }
    try {
      const r = await tools.exec(b, this.args(this.cli.promptVia === 'stdin' ? '' : full, model || this.conf.model).filter((a) => a !== ''), {
        input: this.cli.promptVia === 'stdin' ? full : undefined, timeoutMs: timeoutMs || (ctx.setting('agentNet.replyTimeoutSec', 300) * 1000), cwd: tools.toolsDir('cli-work'), env: this.env(), signal,
      });
      return stripAnsi(r.out).trim();
    } finally { if (tmp) { try { fs.unlinkSync(tmp); } catch { /* gone */ } } }
  }
}

function stripAnsi(s) { return String(s || '').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07]*\x07/g, ''); }

/** Open the vendor's own interactive sign-in in a visible terminal window. */
function openTerminal(bin, args, title) {
  const spec = tools.launchSpec(bin, args);
  const env = { ...process.env, ...spec.env };
  if (tools.WIN) {
    const q = (a) => `"${String(a).replace(/"/g, '""')}"`;
    const line = `start ${q(title)} ${[spec.cmd, ...spec.args].map(q).join(' ')}`;
    spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', line], { detached: true, stdio: 'ignore', windowsVerbatimArguments: true, env }).unref();
  } else if (process.platform === 'darwin') {
    const cmd = [spec.cmd, ...spec.args].map((a) => `'${String(a).replace(/'/g, "'\\''")}'`).join(' ');
    spawn('osascript', ['-e', `tell application "Terminal" to do script "${cmd.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`, '-e', 'tell application "Terminal" to activate'], { detached: true, stdio: 'ignore', env }).unref();
  } else {
    spawn('x-terminal-emulator', ['-e', spec.cmd, ...spec.args], { detached: true, stdio: 'ignore', env }).unref();
  }
}

// ------------------------------------------------------------ Herdr (CLI agent kept alive in a terminal session)
class HerdrAdapter extends CliAdapter {
  get kind() { return 'herdr'; }
  async detect() {
    const d = await super.detect();
    if (!herdr.binary()) return { ...d, installed: false, note: d.installed ? 'Herdr runtime not installed' : d.note, herdrMissing: true };
    return d;
  }
  async test() {
    if (!herdr.binary()) return { ok: false, error: 'This agent runs inside Herdr, which isn\'t installed yet. Use the Herdr card to install it.' };
    const h = await herdr.test();
    if (!h.ok) return h;
    return super.test();
  }
  async deliver({ system, prompt, timeoutMs }) {
    if (!herdr.binary()) throw new Error('Herdr isn\'t installed. Install it from Settings → Agent Connections → Herdr.');
    const b = this.bin();
    if (!b) throw new Error(`${this.def.name} isn't installed on this computer. Click Install on its card.`);
    return herdr.ask({ agentId: this.def.id, kind: this.cli.herdrKind || this.def.id, args: this.cli.interactiveArgs || [], prompt: `${system}\n\n${prompt}`, timeoutMs: timeoutMs || ctx.setting('agentNet.replyTimeoutSec', 300) * 1000 });
  }
}

// ------------------------------------------------------------ Local / HTTP
class LocalAdapter extends AgentAdapter {
  get kind() { return 'local'; }
  url() { return String(this.conf.url || '').trim(); }
  async detect() { return { installed: !!this.url() || this.conf.mailbox === true, note: this.url() ? this.url() : 'Mailbox: the agent fetches its own messages' }; }
  async test() {
    if (!this.url()) return this.conf.mailbox ? { ok: true, message: 'Mailbox mode: messages wait in this agent\'s inbox until it fetches them with its token.' } : { ok: false, error: 'Add the agent\'s address (for example http://127.0.0.1:8080/agent) under Show advanced, or switch on mailbox mode.' };
    try { const t = await this.deliver({ system: 'connection test', prompt: 'Reply with the single word: ready' }); return { ok: true, message: `Agent answered: "${t.slice(0, 60)}"` }; } catch (e) { return { ok: false, error: e.message }; }
  }
  async deliver({ system, prompt, message, thread }) {
    if (!this.url()) return null; // mailbox mode: the agent fetches it
    const headers = { 'content-type': 'application/json' };
    if (secrets.has(customKeyName(this.def.id))) headers.authorization = `Bearer ${secrets.get(customKeyName(this.def.id))}`;
    let r;
    try { r = await fetch(this.url(), { method: 'POST', headers, body: JSON.stringify({ protocol: 'euclidean-agent-net/1', system, prompt, message, thread }), signal: AbortSignal.timeout(180000) }); }
    catch { throw new Error(`Couldn't reach ${this.url()}. Make sure the agent is running.`); }
    const t = await r.text();
    if (!r.ok) throw new Error(`The agent at ${this.url()} answered with an error (${r.status}).`);
    try { const j = JSON.parse(t); return j.reply ?? j.text ?? j.body ?? t; } catch { return t; }
  }
}

// ------------------------------------------------------------ Free connections (no API keys)
/** The free Llama on this PC (Ollama). */
class OllamaAdapter extends AgentAdapter {
  get kind() { return 'ollama'; }
  async detect() {
    if (!ai.connected('ollama')) { try { await ai.test('ollama'); } catch { /* still off */ } }
    const ok = ai.connected('ollama');
    return { installed: ok, ready: ok, note: ok ? 'Running on this computer (free)' : 'The free AI isn\'t running. Set it up in Settings → AI (one click).' };
  }
  async test() { const d = await this.detect(); return d.ready ? { ok: true, message: 'Llama is running on this computer.' } : { ok: false, error: d.note }; }
  async deliver({ system, prompt }) {
    const r = await ai.ask({ role: 'operations', provider: 'ollama', system, prompt, maxTokens: 1400 });
    return r.text;
  }
}

/** One of Euclidean's own bots: it answers with its own brain and tools (web, Data tab, leads, documents...). */
class BotAdapter extends AgentAdapter {
  get kind() { return 'bot'; }
  bot() { return ctx.store.get('bots', this.def.botId); }
  async detect() { const b = this.bot(); return b ? { installed: true, ready: true, note: `${b.name} answers with its own tools` } : { installed: false, note: 'This bot was deleted.' }; }
  async test() { return this.bot() ? { ok: true, message: `${this.def.name} is ready.` } : { ok: false, error: 'This bot was deleted.' }; }
  async deliver({ prompt, thread, message }) {
    const b = this.bot(); if (!b) throw new Error('This bot was deleted.');
    // The bot keeps its own instructions and tools; it gets the conversation and how to talk to the others.
    const q = `(Agent conversation "${thread?.title || ''}" in Euclidean. Other agents and the founders are in it.)\n\n${prompt}\n\nAnswer in plain text, using your tools when the question needs facts. To ask another agent in this conversation something, start a line with @ and their name, like "@Llama what do you think?".`;
    const latest = String(message?.body || '').slice(0, 4000);
    const r = await require('../bots').ask(b.id, q, `agentnet:${thread?.id || ''}`, { focus: latest, shown: `From the agent conversation "${thread?.title || ''}" (${registry().name(message?.from)}): ${latest}` });
    if (r.waiting) return `(${b.name} is waiting for your OK on an Allow card in its own chat on the Bots page before it carries on.)`;
    if (r.answer == null) throw new Error(`${b.name} is still working. Its answer will show in its own chat on the Bots page.`);
    return r.answer;
  }
}

const registry = () => require('./registry');
const SITE_LABEL = { grok: 'Grok', claude: 'Claude', chatgpt: 'ChatGPT' };
/** Your own Grok / Claude / ChatGPT login (AI apps page), driven like a person typing. */
class AccountAdapter extends AgentAdapter {
  get kind() { return 'account'; }
  site() { return this.def.site; }
  async detect() {
    const br = require('../integrations/bridge');
    if (!br.available()) return { installed: false, note: 'Works in the Euclidean desktop app.' };
    if (!br.siteKnown(this.site())) return { installed: false, note: `Sign in to ${SITE_LABEL[this.site()]} once on the AI apps page.` };
    return { installed: true, ready: br.siteReady(this.site()), note: br.siteReady(this.site()) ? `Your ${SITE_LABEL[this.site()]} login (no key)` : 'Hourly limit reached for your login; try again soon.' };
  }
  async test() { const d = await this.detect(); return d.installed ? { ok: true, message: d.note } : { ok: false, error: d.note }; }
  async deliver({ system, prompt }) {
    const br = require('../integrations/bridge');
    const r = await br.ask(this.site(), `${system}\n\n${prompt}`.slice(0, 30000), { newChat: true, record: false, actor: 'agentnet', quiet: true });
    return r.text;
  }
}

/**
 * Claude through the Claude app on this PC (Euclidean's connector), no key: the message waits for Claude, who reads
 * it with the connector's agent_inbox and answers with agent_reply. When your Claude login is open on the AI apps
 * page, it answers at once through that instead.
 */
class ConnectorAdapter extends AgentAdapter {
  get kind() { return 'connector'; }
  async detect() {
    let viaLogin = false; try { viaLogin = require('../integrations/bridge').siteReady('claude'); } catch { /* none */ }
    return { installed: true, ready: true, note: viaLogin ? 'Answers through your Claude login' : 'Answers from the Claude app (Euclidean connector)' };
  }
  async test() { return { ok: true, message: 'Messages to Claude wait for the Claude app, which answers through the Euclidean connector.' }; }
  async deliver({ system, prompt }) {
    let br = null; try { br = require('../integrations/bridge'); } catch { /* none */ }
    if (br && br.siteReady('claude')) { const r = await br.ask('claude', `${system}\n\n${prompt}`.slice(0, 30000), { newChat: true, record: false, actor: 'agentnet', quiet: true }); return r.text; }
    return null; // waits for the Claude app
  }
}

/** Your GrokBot, by email: the message goes out tagged, its reply comes back into the conversation. */
class GrokBotAdapter extends AgentAdapter {
  get kind() { return 'grokbot'; }
  async detect() {
    const G = require('../integrations/grokbots');
    if (!G.bots().length) return { installed: false, note: 'Add your GrokBot\'s email on the Bots page (GrokBots by email).' };
    if (!require('../integrations/email').configured()) return { installed: false, note: 'Connect the outreach email first (Settings → Connections → Email).' };
    const b = G.budget();
    return { installed: true, ready: true, note: `Your GrokBot by email (${b.left} of ${b.cap} questions left this week)` };
  }
  async test() { const d = await this.detect(); return d.installed ? { ok: true, message: d.note } : { ok: false, error: d.note }; }
  async deliver({ prompt, thread, message }) {
    const G = require('../integrations/grokbots');
    await G.send({ task: `${prompt}\n\n(Reply with your answer. Keep the [JEV-...] tag in the subject.)`.slice(0, 18000), title: `Agent conversation: ${thread?.title || ''}`.slice(0, 80), actor: 'bot:Agent conversations', context: { agentThread: thread?.id || null, agentMessage: message?.id || null } });
    return null; // the reply arrives by email
  }
}

const KINDS = { api: ApiAdapter, cli: CliAdapter, herdr: HerdrAdapter, local: LocalAdapter, ollama: OllamaAdapter, bot: BotAdapter, account: AccountAdapter, connector: ConnectorAdapter, grokbot: GrokBotAdapter };

function create(def, conf) {
  const kind = conf?.connection || def.defaultConnection;
  const C = KINDS[kind];
  if (!C) throw new Error(`Unknown connection type ${kind}`);
  return new C(def, conf);
}

module.exports = { OllamaAdapter, BotAdapter, AccountAdapter, ConnectorAdapter, GrokBotAdapter, AgentAdapter, ApiAdapter, CliAdapter, HerdrAdapter, LocalAdapter, create, customKeyName, stripAnsi };
