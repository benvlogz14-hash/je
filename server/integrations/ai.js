'use strict';
/**
 * Multi-agent orchestrator. Agents are roles (operations, analysis, research,
 * writing) mapped to providers in Settings, never hard-coded. Each call:
 *  - injects the client's profile when a clientId is given (client memory),
 *  - checks the provider's monthly budget,
 *  - falls back to the next provider on failure or budget exhaustion,
 *  - records token usage and estimated cost against the client.
 * Agents never talk to each other directly; they exchange structured results
 * through the job database.
 */
const ctx = require('../core/ctx');
const secrets = require('../core/secrets');
const audit = require('../core/audit');
const events = require('../core/events');
const { safeJson, monthKey, now } = require('../core/util');

const PROVIDERS = {
  anthropic: { label: 'Claude', vendor: 'Anthropic', keyName: 'global.anthropic.apiKey', base: 'https://api.anthropic.com/v1' },
  openai: { label: 'GPT', vendor: 'OpenAI', keyName: 'global.openai.apiKey', base: 'https://api.openai.com/v1' },
  xai: { label: 'Grok', vendor: 'xAI', keyName: 'global.xai.apiKey', base: 'https://api.x.ai/v1' },
  ollama: { label: 'Llama (local)', vendor: 'Ollama', keyName: null, local: true },
  // Your own Grok/Claude/ChatGPT login through the desktop app (no API key); off unless a founder turns it on.
  bridge: { label: 'Your AI account', vendor: 'Your account', keyName: null, bridge: true },
};

// ------------------------------------------------------------ Ollama (free, runs on this computer)
const ollamaState = { ok: false, at: 0, models: [], error: null };
const ollamaBase = () => String(ctx.setting('ai.ollama.url', 'http://127.0.0.1:11434') || '').replace(/\/$/, '');
const wantedModel = () => ctx.setting('ai.ollama.model', 'llama3.2');
// The chosen model when it's downloaded, else any chat model this PC already has (so a running Ollama just works).
const ollamaModel = () => ollamaState.using || wantedModel();
/** Check (at most every 30 s) whether Ollama is running and has the chosen model. */
async function pingOllama(force = false) {
  if (!force && Date.now() - ollamaState.at < 30000) return ollamaState.ok;
  ollamaState.at = Date.now();
  if (ctx.setting('ai.ollama.enabled', true) === false) { ollamaState.ok = false; ollamaState.error = 'Turned off'; return false; }
  try {
    const res = await fetch(`${ollamaBase()}/api/tags`, { signal: AbortSignal.timeout(2500) });
    const j = await res.json(); ollamaState.models = (j.models || []).map((m) => m.name);
    const want = wantedModel();
    const exact = ollamaState.models.find((m) => m === want || m.split(':')[0] === want.split(':')[0]);
    const chat = ollamaState.models.filter((m) => !/vision|embed|llava|minilm|nomic|bge|whisper/i.test(m));
    ollamaState.using = exact || chat.find((m) => /llama|qwen|mistral|gemma|phi|deepseek/i.test(m)) || chat[0] || null;
    ollamaState.ok = !!ollamaState.using;
    ollamaState.error = ollamaState.ok ? null : `Ollama is running but has no AI model yet. Press "Set up free AI" in Settings → AI to download ${want}.`;
  } catch { ollamaState.ok = false; ollamaState.error = 'Ollama is not running'; }
  return ollamaState.ok;
}
setInterval(() => { pingOllama().catch(() => {}); }, 30000).unref?.();
setTimeout(() => { pingOllama(true).catch(() => {}); }, 1500).unref?.();

const health = {}; // provider -> { ok, at, error }
const inflight = {}; // provider -> count

class AIError extends Error { constructor(msg, { provider, status, retryable } = {}) { super(msg); this.provider = provider; this.status = status; this.retryable = retryable; } }

function connected(provider) { if (PROVIDERS[provider]?.bridge) return require('./bridge').usable(); return PROVIDERS[provider]?.local ? ollamaState.ok : secrets.has(PROVIDERS[provider].keyName); }
function anyConnected() { return Object.keys(PROVIDERS).some(connected); }

function monthSpend(provider) {
  const m = monthKey();
  return ctx.store.all('usage', (u) => u.provider === provider && u.month === m).reduce((s, u) => s + (u.costUsd || 0), 0);
}
function overBudget(provider) {
  const b = ctx.setting(`ai.budgetsUsd.${provider}`, 0);
  return b > 0 && monthSpend(provider) >= b;
}

function price(provider, model) {
  const table = ctx.setting(`ai.prices.${provider}`, {}) || {};
  return table[model] || table.default || [0, 0];
}

function recordUsage({ provider, model, role, clientId, jobId, inTok = 0, outTok = 0, costUsd, kind = 'chat' }) {
  const [pi, po] = price(provider, model);
  const cost = costUsd != null ? costUsd : (inTok * pi + outTok * po) / 1e6;
  ctx.store.insert('usage', { provider, model, role, clientId: clientId || null, jobId: jobId || null, inTok, outTok, costUsd: Math.round(cost * 1e5) / 1e5, kind, month: monthKey() });
}

async function httpJson(url, opts, provider) {
  let res;
  try { res = await fetch(url, { ...opts, signal: opts.signal || AbortSignal.timeout(opts.timeoutMs || 120000) }); }
  catch (e) { throw new AIError(`${PROVIDERS[provider].vendor} unreachable: ${e.message}`, { provider, retryable: true }); }
  const text = await res.text();
  const body = safeJson(text, { raw: text });
  if (!res.ok) {
    const msg = body?.error?.message || body?.error || body?.message || text.slice(0, 300);
    const retryable = res.status === 429 || res.status >= 500;
    if (res.status === 401 || res.status === 403) health[provider] = { ok: false, at: now(), error: 'Authentication failed: check the API key' };
    throw new AIError(`${PROVIDERS[provider].vendor} ${res.status}: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`, { provider, status: res.status, retryable });
  }
  return body;
}

/** Attach still frames (JPEG/PNG files) to the last user message in each provider's format. */
function withImages(provider, messages, images) {
  const fs = require('fs');
  const pics = images.slice(0, 20).map((f) => ({ data: fs.readFileSync(f).toString('base64'), type: /\.png$/i.test(f) ? 'image/png' : 'image/jpeg' }));
  const out = messages.map((m) => ({ ...m })); const last = out[out.length - 1]; const text = String(last.content || '');
  if (provider === 'ollama') last.images = pics.map((p) => p.data);
  else if (provider === 'anthropic') last.content = [...pics.map((p) => ({ type: 'image', source: { type: 'base64', media_type: p.type, data: p.data } })), { type: 'text', text }];
  else last.content = [{ type: 'text', text }, ...pics.map((p) => ({ type: 'image_url', image_url: { url: `data:${p.type};base64,${p.data}`, detail: 'low' } }))];
  return out;
}
const visionModel = () => ctx.setting('ai.ollama.visionModel', 'llama3.2-vision');
const hasVisionModel = () => (ollamaState.models || []).some((m) => m === visionModel() || m.split(':')[0] === visionModel().split(':')[0]);

/** Low-level provider call. messages: [{role:'user'|'assistant', content:string}] */
async function callProvider(provider, { model, system, messages, json, maxTokens = 2000, temperature, search, images }) {
  if (provider === 'bridge') return { ...(await require('./bridge').complete({ system, prompt: (messages || []).map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n\n'), json })), inTok: 0, outTok: 0 };
  if (images?.length) messages = withImages(provider, messages, images);
  if (provider === 'ollama') {
    const msgs = [...(system ? [{ role: 'system', content: system + (json ? '\n\nRespond with a single valid JSON object only.' : '') }] : []), ...messages];
    const r = await httpJson(`${ollamaBase()}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, timeoutMs: 600000,
      body: JSON.stringify({ model: model || ollamaModel(), messages: msgs, stream: false, format: json ? 'json' : undefined, options: { num_ctx: Number(ctx.setting('ai.ollama.context', 16384)), num_predict: maxTokens, ...(temperature != null ? { temperature } : {}) } }) }, provider);
    return { text: r.message?.content || '', inTok: r.prompt_eval_count || 0, outTok: r.eval_count || 0, model: r.model || model };
  }
  const key = secrets.get(PROVIDERS[provider].keyName);
  if (!key) throw new AIError(`${PROVIDERS[provider].label} is not connected (add an API key in Settings → Connections)`, { provider });
  if (provider === 'anthropic') {
    const body = { model, max_tokens: maxTokens, messages, system: json ? `${system || ''}\n\nRespond with a single valid JSON object only. No prose, no code fences.`.trim() : system || undefined };
    if (temperature != null) body.temperature = temperature;
    const r = await httpJson(`${PROVIDERS.anthropic.base}/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' }, body: JSON.stringify(body),
    }, provider);
    const text = (r.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
    return { text, inTok: r.usage?.input_tokens || 0, outTok: r.usage?.output_tokens || 0, model: r.model || model };
  }
  // OpenAI and xAI share the chat completions wire format.
  const msgs = system ? [{ role: 'system', content: system + (json ? '\n\nRespond with a single valid JSON object only.' : '') }, ...messages] : messages;
  const body = { model, messages: msgs, max_completion_tokens: maxTokens };
  if (provider === 'xai') { delete body.max_completion_tokens; body.max_tokens = maxTokens; if (search) body.search_parameters = { mode: 'auto' }; }
  if (json) body.response_format = { type: 'json_object' };
  if (temperature != null && provider === 'xai') body.temperature = temperature;
  let r;
  try {
    r = await httpJson(`${PROVIDERS[provider].base}/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify(body),
    }, provider);
  } catch (e) {
    // Older/other models may reject optional parameters; retry once with the minimal request.
    if (e.status === 400 && (body.search_parameters || body.response_format || body.max_completion_tokens)) {
      const minimal = { model, messages: msgs };
      r = await httpJson(`${PROVIDERS[provider].base}/chat/completions`, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify(minimal),
      }, provider);
    } else throw e;
  }
  const text = r.choices?.[0]?.message?.content || '';
  return { text, inTok: r.usage?.prompt_tokens || 0, outTok: r.usage?.completion_tokens || 0, model: r.model || model };
}

/** Client memory: compact profile text injected into every client-scoped agent call. */
function clientContext(clientId) {
  if (!clientId) return '';
  const c = ctx.store.get('clients', clientId);
  if (!c) return '';
  const p = c.profile || {};
  const mem = (c.memory || []).filter((m) => m.active !== false).map((m) => `- ${m.text}`).join('\n');
  return [
    `CLIENT PROFILE (apply to everything you produce for this client; never use other clients' information):`,
    `Name: ${c.name} | Type: ${c.type} | Status: ${c.status}`,
    p.about ? `About: ${p.about}` : '',
    p.audience ? `Audience: ${p.audience}` : '',
    p.voice ? `Voice/tone: ${p.voice}` : '',
    p.topics ? `Core topics: ${p.topics}` : '',
    p.avoid ? `Never do: ${p.avoid}` : '',
    p.hashtags ? `Standard hashtags: ${p.hashtags}` : '',
    c.style ? `Caption style: font ${c.style.font}, ${c.style.uppercase ? 'UPPERCASE' : 'sentence case'}, highlight ${c.style.highlight}, ${c.style.wordsPerLine} words/line, position ${c.style.position}` : '',
    mem ? `Remembered preferences and past feedback:\n${mem}` : '',
  ].filter(Boolean).join('\n');
}

/**
 * High-level agent call with role routing, budget checks and fallback.
 * @returns {{text, json, provider, model}}
 */
async function ask({ role = 'operations', system, prompt, messages, json = false, clientId, jobId, maxTokens, search, images, provider: forceProvider }) {
  const cfg = ctx.setting(`ai.roles.${role}`) || ctx.setting('ai.roles.operations');
  await pingOllama();
  // Local-first: "all" sends every task to Llama on this computer; "most" keeps only emails/ad writing on the paid
  // provider; "off" uses Llama only as a last resort. Llama is always the final fallback when it's running.
  const local = ctx.setting('ai.local', 'all');
  const useLocalFirst = local === 'all' || (local === 'most' && role !== 'writing');
  let chain = forceProvider ? [forceProvider] : [cfg.provider, ...(cfg.fallbacks || [])];
  if (!forceProvider) chain = useLocalFirst ? ['ollama', ...chain] : [...chain, 'ollama'];
  // Your own AI account (no API key): first in line, or just before the free local AI, when switched on.
  const viaAccount = ctx.setting('ai.bridge.use', 'off');
  if (!forceProvider && viaAccount === 'first') chain = ['bridge', ...chain];
  else if (!forceProvider && viaAccount === 'fallback') chain = chain[chain.length - 1] === 'ollama' ? [...chain.slice(0, -1), 'bridge', 'ollama'] : [...chain, 'bridge'];
  chain = chain.filter((p, i, a) => PROVIDERS[p] && a.indexOf(p) === i);
  // Looking at pictures: the local AI only when its vision model is downloaded.
  if (images?.length) chain = chain.filter((p) => (p !== 'ollama' || hasVisionModel()) && p !== 'bridge');
  // Free web search for providers without built-in search (everything except Grok): results go in as context.
  if (search && !(chain.find((p) => connected(p) && !overBudget(p)) === 'xai')) {
    try { const ws = await require('./websearch').forPrompt(prompt || (messages || []).slice(-1)[0]?.content || ''); if (ws) system = `${system || ''}\n\n${ws}`; } catch { /* search unavailable */ }
  }
  const sys = [system, clientContext(clientId)].filter(Boolean).join('\n\n');
  const msgs = messages || [{ role: 'user', content: prompt }];
  const errors = [];
  for (const provider of chain) {
    if (!connected(provider)) { errors.push(`${PROVIDERS[provider].label}: not connected`); continue; }
    if (overBudget(provider)) { errors.push(`${PROVIDERS[provider].label}: monthly budget reached`); continue; }
    const model = provider === 'bridge' ? 'account' : provider === 'ollama' ? (images?.length ? visionModel() : ollamaModel()) : provider === cfg.provider ? cfg.model : (ctx.setting(`ai.defaultModels.${provider}`) || defaultModelFor(provider));
    inflight[provider] = (inflight[provider] || 0) + 1;
    events.publish('agents', agentStatus(), { coalesceKey: 'agents' });
    try {
      let r; let attempt = 0;
      for (;;) {
        try { r = await callProvider(provider, { model, system: sys, messages: msgs, json, maxTokens, search, images }); break; }
        catch (e) { if (e.retryable && attempt++ < 2) { await new Promise((ok) => setTimeout(ok, 1500 * attempt)); continue; } throw e; }
      }
      recordUsage({ provider, model: r.model, role, clientId, jobId, inTok: r.inTok, outTok: r.outTok });
      health[provider] = { ok: true, at: now() };
      const out = { text: r.text, provider, model: r.model };
      if (json) {
        out.json = safeJson(r.text);
        if (!out.json) throw new AIError(`${PROVIDERS[provider].label} returned invalid JSON`, { provider, retryable: false });
      }
      return out;
    } catch (e) {
      errors.push(`${PROVIDERS[provider].label}: ${e.message}`);
      audit.log(`agent:${provider}`, 'agent.error', { role, clientId, jobId, error: e.message }, 'warn');
      if (e.status && e.status !== 401 && e.status !== 403 && e.status !== 429 && e.status < 500) { /* request problem: still try fallback */ }
    } finally {
      inflight[provider]--;
      events.publish('agents', agentStatus(), { coalesceKey: 'agents' });
    }
  }
  const err = new AIError(chain.length ? `No agent could complete the ${role} task. ${errors.join(' · ')}` : 'No AI provider configured for this role');
  err.notConnected = errors.every((e) => /not connected/.test(e));
  throw err;
}

function defaultModelFor(p) { return { anthropic: 'claude-sonnet-5-5', openai: 'gpt-5', xai: 'grok-4', ollama: 'llama3.2' }[p]; }

/** Verify a key with a cheap models-list call. */
async function test(provider) {
  if (provider === 'ollama') { const ok = await pingOllama(true); return ok ? { ok: true, models: ollamaState.models } : { ok: false, error: ollamaState.error }; }
  const key = secrets.get(PROVIDERS[provider].keyName);
  if (!key) return { ok: false, error: 'No API key saved' };
  try {
    const headers = provider === 'anthropic' ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' } : { authorization: `Bearer ${key}` };
    const r = await httpJson(`${PROVIDERS[provider].base}/models`, { method: 'GET', headers, timeoutMs: 20000 }, provider);
    const models = (r.data || r.models || []).map((m) => m.id).filter(Boolean).sort();
    health[provider] = { ok: true, at: now() };
    return { ok: true, models };
  } catch (e) {
    health[provider] = { ok: false, at: now(), error: e.message };
    return { ok: false, error: e.message };
  }
}

/** Transcribe an audio file (≤25 MB) with OpenAI; returns words + segments with timestamps. */
async function transcribeOpenAI(file, { clientId, jobId, durationSec, model } = {}) {
  const key = secrets.get(PROVIDERS.openai.keyName);
  if (!key) throw new AIError('Transcription needs OpenAI connected (or a local whisper.cpp path in Settings)', { provider: 'openai' });
  const fs = require('fs');
  const fd = new FormData();
  fd.append('file', new Blob([fs.readFileSync(file)], { type: 'audio/mpeg' }), require('path').basename(file));
  fd.append('model', model || 'whisper-1');
  fd.append('response_format', 'verbose_json');
  fd.append('timestamp_granularities[]', 'word');
  fd.append('timestamp_granularities[]', 'segment');
  const r = await httpJson(`${PROVIDERS.openai.base}/audio/transcriptions`, { method: 'POST', headers: { authorization: `Bearer ${key}` }, body: fd, timeoutMs: 600000 }, 'openai');
  recordUsage({ provider: 'openai', model: model || 'whisper-1', role: 'transcription', clientId, jobId, kind: 'transcription', costUsd: ((durationSec || r.duration || 0) / 60) * ctx.setting('ai.whisperPerMinuteUsd', 0.006) });
  return {
    text: r.text || '',
    language: r.language,
    words: (r.words || []).map((w) => ({ w: w.word, s: w.start, e: w.end })),
    segments: (r.segments || []).map((s) => ({ s: s.start, e: s.end, t: (s.text || '').trim() })),
  };
}

function agentStatus() {
  const roles = ctx.setting('ai.roles', {});
  return {
    providers: Object.fromEntries(Object.entries(PROVIDERS).map(([k, p]) => [k, {
      ...p, keyName: undefined, connected: connected(k), busy: inflight[k] || 0, health: k === 'ollama' ? { ok: ollamaState.ok, error: ollamaState.error, models: ollamaState.models } : health[k] || null,
      spendUsd: Math.round(monthSpend(k) * 100) / 100, budgetUsd: ctx.setting(`ai.budgetsUsd.${k}`, 0), overBudget: overBudget(k),
    }])),
    roles,
    computerUse: require('../automation/handoff').status(),
  };
}

/** Can any connected AI look at pictures right now? */
function canSee() { return ['anthropic', 'openai', 'xai'].some((p) => connected(p) && !overBudget(p)) || (ollamaState.ok && hasVisionModel()); }

module.exports = { canSee, pingOllama, ollamaState, PROVIDERS, ask, test, transcribeOpenAI, connected, anyConnected, agentStatus, recordUsage, clientContext, AIError, monthSpend, callProvider, overBudget, defaultModelFor };
