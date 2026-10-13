// Agent Connections (Settings → Advanced) and Agent Conversations.
// Grok, Claude, GPT/Codex, Cursor, opencode and custom agents talk to each other as peers.
// Euclidean only routes, logs and asks you before anything leaves the app.
import { html, useState, useEffect, useRef, useStore, useApi, navigate, Button, HoldButton, Seg, Toggle, Field, Loading, Empty, Avatar, Modal, Tabs, act, toast, confirmDialog } from '../lib/ui.js';
import { api } from '../lib/api.js';
import { Icon } from '../lib/icons.js';
import { ago } from '../lib/format.js';

const CONN_LABEL = { api: 'API key', cli: 'On this computer', herdr: 'Herdr terminal', local: 'Local / network' };
const CONN_HINT = {
  api: 'Talks to the provider over the internet with your API key. Easiest to set up.',
  cli: 'Runs the agent\'s own app on this computer (installed and kept up to date from here).',
  herdr: 'Runs the agent\'s app inside a Herdr terminal session that stays open between messages.',
  local: 'An agent on this computer or your network that Euclidean reaches over HTTP, or one that collects its own messages.',
};
const HEALTH = { connected: ['moss', 'Connected'], not_connected: ['', 'Not connected'], needs_attention: ['gold', 'Needs attention'] };
const TYPE_LABEL = { message: 'Message', reply: 'Reply', question: 'Question', critique_request: 'Critique request', task_request: 'Task request', context: 'Context / files', join: 'Joined', action_request: 'Needs approval', system: 'Note' };
const TYPE_TONE = { question: 'sky', critique_request: 'lav', task_request: 'teal', action_request: 'gold', system: 'slate', join: 'slate', context: 'moss' };
const DELIVERY = { queued: ['slate', 'Waiting'], running: ['teal', 'Thinking'], replied: ['moss', 'Answered'], delivered: ['', 'In inbox'], read: ['', 'Read'], held: ['gold', 'Paused'], failed: ['coral', 'Failed'] };

function Health({ h }) { const [tone, label] = HEALTH[h?.state] || HEALTH.not_connected; return html`<span class=${'badge ' + tone}><span class="led" style=${{ background: tone ? `var(--${tone})` : 'var(--ink-3)' }} />${label}</span>`; }
const resultToast = (r, ok) => { if (r && r.ok === false) { toast(r.error || 'That didn\'t work', { kind: 'error', title: 'Not connected yet' }); throw Object.assign(new Error(r.error), { shown: true }); } if (ok) toast(typeof ok === 'function' ? ok(r) : ok, { kind: 'ok' }); return r; };
const quiet = (p) => p.catch((e) => { if (!e.shown) toast(e.message, { kind: 'error' }); });

// ================================================================= Settings → Agent Connections
export function AgentConnections() {
  const { data, reload, error } = useApi('/api/agentnet/agents', ['agentnet', 'connections']);
  const { data: st } = useApi('/api/agentnet/status', ['agentnet']);
  const [adding, setAdding] = useState('');
  if (error) return html`<div class="notice coral"><${Icon} name="alert" size=${16} />${error.message}</div>`;
  if (!data) return html`<${Loading} rows=${5} />`;
  const counts = data.agents.reduce((c, a) => ({ ...c, [a.health.state]: (c[a.health.state] || 0) + 1 }), {});
  return html`<div class="col" style="gap:14px">
    <div class="panel pad col" style="gap:10px;background:linear-gradient(135deg, var(--lav-soft), var(--teal-soft))">
      <div class="row wrap" style="gap:10px"><div class="grow" style="min-width:260px"><h3>Agent Connections</h3>
        <div class="muted" style="font-size:var(--fs-sm);margin-top:2px">Connect your AI agents so they can message each other, ask questions, critique work and hand off tasks as equals. No agent is in charge. Every message is logged, stays inside its workspace, and nothing reaches clients or accounts without your approval.</div></div>
        <div class="row" style="gap:6px"><span class="badge moss">${counts.connected || 0} connected</span>${counts.needs_attention ? html`<span class="badge gold">${counts.needs_attention} need attention</span>` : null}<span class="badge">${counts.not_connected || 0} not set up</span></div></div>
      <div class="row wrap" style="gap:8px">
        <${Button} kind="primary" icon="messages" onClick=${() => navigate('/system?tab=conversations')}>Open Agent Conversations</${Button}>
        <${Button} kind="ghost" icon="refresh" onClick=${() => act(() => api.get('/api/agentnet/agents?fresh=1').then(reload), { ok: 'Checked every connection' })}>Check all again</${Button}>
        <div class="grow" />
        ${st ? html`<div class="check-row"><${Toggle} on=${!st.paused} label="Agents may talk" onChange=${(v) => act(() => api.post('/api/agentnet/pause', { paused: !v }), { ok: v ? 'Agents can talk again' : 'All agent conversations paused' })} /><span>${st.paused ? 'All agent conversations are paused' : 'Agents may talk to each other'}</span></div>` : null}
      </div>
    </div>
    ${!data.node && data.platform === 'win32' ? html`<div class="notice gold"><${Icon} name="info" size=${16} /><span class="grow">Claude Code, Codex and opencode install with Node.js, which isn't on this computer yet.</span><${Button} size="sm" kind="gold" onClick=${() => quiet(api.post('/api/agentnet/node/install').then((r) => resultToast(r, 'Node.js installed')).then(reload))}>Install Node.js</${Button}></div>` : null}
    <div style="display:grid;grid-template-columns:repeat(auto-fill, minmax(min(100%, 420px), 1fr));gap:14px">
      ${data.agents.map((a) => html`<${AgentCard} key=${a.id} a=${a} reload=${reload} />`)}
      <${HerdrCard} />
      <div class="panel pad col" style="gap:10px;border-style:dashed">
        <div class="row"><${Avatar} name="+" icon="plus" /><div class="grow"><b>Custom agent</b><div class="faint" style="font-size:var(--fs-sm)">Any other agent: an OpenAI-compatible API, a command-line tool, or an agent on this computer or network.</div></div></div>
        <div class="row"><input class="input grow" placeholder="Name, e.g. Gemini, Astra, My research bot" value=${adding} onInput=${(e) => setAdding(e.target.value)} aria-label="Custom agent name" />
          <${Button} kind="soft" icon="plus" disabled=${!adding.trim()} onClick=${() => act(() => api.post('/api/agentnet/custom', { name: adding.trim() }), { ok: `${adding.trim()} added` }).then(() => { setAdding(''); reload(); })}>Add</${Button}></div>
      </div>
    </div>
  </div>`;
}

function AgentCard({ a, reload }) {
  const [adv, setAdv] = useState(false);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState('');
  const [needsNode, setNeedsNode] = useState(false);
  const [customModel, setCustomModel] = useState(false);
  const [f, setF] = useState(a.config);
  useEffect(() => setF(a.config), [JSON.stringify(a.config)]);
  const patch = (p, msg) => act(() => api.patch(`/api/agentnet/agents/${a.id}`, p), { ok: msg, quiet: false }).then(reload);
  const run = (name, fn) => async () => { setBusy(name); try { await fn(); } finally { setBusy(''); reload(); } };
  const install = run('install', () => quiet(api.post(`/api/agentnet/agents/${a.id}/install`).then((r) => { if (r.needsNode) setNeedsNode(true); return resultToast(r, `${a.name} installed and ready`); })));
  const configure = run('configure', () => quiet(api.post(`/api/agentnet/agents/${a.id}/configure`).then((r) => resultToast(r, `${a.name} found and connected`))));
  const test = run('test', () => quiet(api.post(`/api/agentnet/agents/${a.id}/test`).then((r) => resultToast(r, (x) => x.message || 'Connection works'))));
  const reconnect = run('reconnect', () => quiet(api.post(`/api/agentnet/agents/${a.id}/reconnect`).then((r) => resultToast(r, 'Reconnected'))));
  const saveKey = run('key', () => quiet(api.post(`/api/agentnet/agents/${a.id}/key`, { key }).then((r) => { setKey(''); return resultToast(r, (x) => x.message || 'Saved and verified'); })));
  const login = () => quiet(api.post(`/api/agentnet/agents/${a.id}/login`).then((r) => resultToast(r, (x) => x.message)));
  const local = a.connection === 'cli' || a.connection === 'herdr';
  const models = a.models || [];
  return html`<div class="panel pad col" style="gap:12px">
    <div class="row" style="gap:10px">
      <div class="avatar" style=${{ background: `var(--${a.tone}-soft)`, color: `var(--${a.tone}-ink)` }}>${a.name.slice(0, 2)}</div>
      <div class="grow" style="min-width:0"><div class="row" style="gap:6px"><b>${a.name}</b><span class="faint" style="font-size:var(--fs-xs)">${a.vendor}</span></div><div class="faint ellipsis" style="font-size:var(--fs-sm)">${a.blurb}</div></div>
      <${Health} h=${a.health} />
    </div>
    ${a.connections.length > 1 ? html`<div class="col" style="gap:4px"><${Seg} value=${a.connection} onChange=${(v) => patch({ connection: v }, `${a.name} now connects via ${CONN_LABEL[v]}`)} options=${a.connections.map((c) => ({ value: c, label: CONN_LABEL[c] }))} /><div class="faint" style="font-size:var(--fs-xs)">${CONN_HINT[a.connection]}</div></div>` : html`<div class="faint" style="font-size:var(--fs-xs)"><b>${CONN_LABEL[a.connection]}.</b> ${CONN_HINT[a.connection]}</div>`}
    <div class=${'notice' + (a.health.state === 'needs_attention' ? ' gold' : a.health.state === 'connected' ? ' teal' : '')} style="align-items:center"><${Icon} name=${a.health.state === 'connected' ? 'check' : a.health.state === 'needs_attention' ? 'alert' : 'info'} size=${15} /><span class="grow">${a.health.reason}</span></div>

    ${a.needsKey ? html`<div class="row" style="gap:8px"><input class="input grow" type="password" autocomplete="off" placeholder=${a.keySaved ? '•••••••• saved (paste to replace)' : `Paste your ${a.vendor} API key`} value=${key} onInput=${(e) => setKey(e.target.value)} aria-label=${`${a.name} API key`} />
      <${Button} kind="primary" busy=${busy === 'key'} disabled=${!key.trim()} onClick=${saveKey}>Save & test</${Button}></div>` : null}

    ${local ? html`<div class="row wrap" style="gap:8px;font-size:var(--fs-sm)">
      <span class=${'badge ' + (a.detect.installed ? 'moss' : '')}>${a.detect.installed ? 'Installed' : a.detect.herdrMissing ? 'Herdr missing' : 'Not installed'}</span>
      ${a.detect.version ? html`<span class="faint">${a.detect.version}</span>` : null}
      <div class="grow" />
      ${!a.detect.installed && a.installable ? html`<${Button} size="sm" kind="primary" icon="download" busy=${busy === 'install'} onClick=${install}>Install</${Button}>` : null}
      ${needsNode ? html`<${Button} size="sm" kind="gold" onClick=${() => quiet(api.post('/api/agentnet/node/install').then((r) => resultToast(r, 'Node.js installed. Now click Install again.')))}>Install Node.js</${Button}>` : null}
      <${Button} size="sm" kind="soft" icon="wand" busy=${busy === 'configure'} onClick=${configure}>Configure automatically</${Button}>
      ${a.canLogin && a.detect.installed ? html`<${Button} size="sm" kind="ghost" icon="key" onClick=${login}>Sign in</${Button}>` : null}
    </div>` : null}
    ${a.connection === 'herdr' && a.detect.herdrMissing ? html`<div class="notice"><${Icon} name="info" size=${15} />This agent runs inside Herdr. Install Herdr on the Herdr card below (one click).</div>` : null}
    ${a.connection === 'local' ? html`<div class="col" style="gap:8px">
      <${Field} label="Agent address" hint="Where Euclidean sends messages, e.g. http://127.0.0.1:8080/agent. Leave empty to use mailbox mode." id=${`u-${a.id}`}><input id=${`u-${a.id}`} class="input mono" value=${f.url} onInput=${(e) => setF({ ...f, url: e.target.value })} onBlur=${() => f.url !== a.config.url && patch({ url: f.url.trim(), mailbox: !f.url.trim() }, 'Saved')} placeholder="http://127.0.0.1:8080/agent" /></${Field}>
    </div>` : null}

    ${(models.length || a.connection === 'api') && a.connection !== 'local' ? html`<${Field} label="Model" id=${`m-${a.id}`}>${customModel || (f.model && !models.includes(f.model))
      ? html`<div class="row"><input id=${`m-${a.id}`} class="input mono grow" value=${f.model} onInput=${(e) => setF({ ...f, model: e.target.value })} onBlur=${() => patch({ model: f.model.trim() }, 'Model saved')} placeholder="model name" /><${Button} size="sm" kind="ghost" onClick=${() => { setCustomModel(false); patch({ model: '' }); }}>List</${Button}></div>`
      : html`<select id=${`m-${a.id}`} class="select" value=${f.model} onChange=${(e) => { if (e.target.value === '__custom') { setCustomModel(true); return; } patch({ model: e.target.value }, 'Model saved'); }}><option value="">Recommended (default)</option>${models.map((m) => html`<option value=${m}>${m}</option>`)}<option value="__custom">Other model…</option></select>`}</${Field}>` : null}

    <div class="row wrap" style="gap:8px">
      <${Button} kind="soft" icon="bolt" busy=${busy === 'test'} onClick=${test}>Test</${Button}>
      <${Button} kind="ghost" icon="refresh" busy=${busy === 'reconnect'} onClick=${reconnect}>Reconnect</${Button}>
      <div class="grow" />
      <div class="check-row"><${Toggle} on=${f.enabled} label=${`${a.name} on`} onChange=${(v) => patch({ enabled: v }, v ? `${a.name} turned on` : `${a.name} turned off`)} /><span class="faint" style="font-size:var(--fs-sm)">${f.enabled ? 'On' : 'Off'}</span></div>
    </div>
    ${a.lastTest ? html`<div class="faint" style="font-size:var(--fs-xs)">Last tested ${ago(a.lastTest.at)} ago: ${a.lastTest.ok ? 'worked' : 'failed'}</div>` : null}

    <button class="btn ghost sm" style="align-self:flex-start" onClick=${() => setAdv(!adv)}><${Icon} name=${adv ? 'chevronDown' : 'chevronRight'} size=${14} />${adv ? 'Hide advanced' : 'Show advanced'}</button>
    ${adv ? html`<div class="col" style="gap:12px;padding:12px;border-radius:var(--r-md);background:var(--surface-2)">
      <div class="check-row"><${Toggle} on=${f.autoReply} label="Answers automatically" onChange=${(v) => patch({ autoReply: v }, 'Saved')} /><span>Answer messages automatically (off: messages wait in its inbox)</span></div>
      <${WorkspacePicker} value=${f.workspaces} onChange=${(w) => patch({ workspaces: w }, 'Workspace access saved')} />
      ${local ? html`
        <${Field} label="Program location" hint=${a.detect.path ? `Found at ${a.detect.path}` : 'Filled in by "Configure automatically". Only change it if the agent lives somewhere unusual.'} id=${`p-${a.id}`}><input id=${`p-${a.id}`} class="input mono" value=${f.command || f.path} placeholder=${a.defaults.bins.join(' or ') || 'path to the program'} onInput=${(e) => setF({ ...f, command: e.target.value })} onBlur=${() => f.command !== a.config.command && patch({ command: f.command.trim() }, 'Saved')} /></${Field}>
        <${Field} label="Command options" hint="{prompt} is replaced by the message, {model} by the model. Leave empty for the recommended options." id=${`a-${a.id}`}><input id=${`a-${a.id}`} class="input mono" value=${(f.args || []).join(' ')} placeholder=${a.defaults.args.join(' ')} onInput=${(e) => setF({ ...f, args: e.target.value.split(/\s+/).filter(Boolean) })} onBlur=${() => patch({ args: f.args }, 'Saved')} /></${Field}>
        ${a.id === 'claude' || a.id === 'codex' ? html`<div class="check-row"><${Toggle} on=${f.shareApiKey} label="Use saved API key" onChange=${(v) => patch({ shareApiKey: v }, 'Saved')} /><span>Use the API key saved in Euclidean instead of the app's own sign-in</span></div>` : null}` : null}
      ${a.custom && a.connection === 'api' ? html`<${Field} label="API address (OpenAI-compatible)" hint="For example https://api.together.xyz/v1 or http://127.0.0.1:11434/v1 for Ollama" id=${`b-${a.id}`}><input id=${`b-${a.id}`} class="input mono" value=${f.baseUrl} onInput=${(e) => setF({ ...f, baseUrl: e.target.value })} onBlur=${() => patch({ baseUrl: f.baseUrl.trim() }, 'Saved')} /></${Field}>` : null}
      ${a.connection === 'local' ? html`<div class="col" style="gap:6px"><div class="check-row"><${Toggle} on=${f.mailbox} label="Mailbox mode" onChange=${(v) => patch({ mailbox: v }, 'Saved')} /><span>The agent collects its own messages from Euclidean with a token</span></div>
        <div class="row"><${Button} size="sm" kind="soft" icon="key" onClick=${() => act(() => api.post(`/api/agentnet/agents/${a.id}/token`)).then((r) => toast(`Token for ${a.name}: ${r.token}  ·  Inbox: GET ${r.base}/api/agentnet/mailbox  ·  Send: POST ${r.base}/api/agentnet/mailbox/send`, { kind: 'info', title: 'Copy this now: it is shown once', ms: 60000 }))}>Create agent token</${Button}></div></div>` : null}
      <${Field} label="Extra instructions for this agent" hint="Added to every message it receives, e.g. its role or style." id=${`n-${a.id}`}><textarea id=${`n-${a.id}`} class="textarea" rows="2" value=${f.note} onInput=${(e) => setF({ ...f, note: e.target.value })} onBlur=${() => f.note !== a.config.note && patch({ note: f.note }, 'Saved')} placeholder="You are our harshest critic. Keep answers under 120 words." /></${Field}>
      ${a.custom ? html`<div><${Button} size="sm" kind="coral" icon="trash" onClick=${async () => { if (await confirmDialog({ title: `Remove ${a.name}?`, text: 'Its settings and token are removed. Past messages stay in the log.', confirm: 'Remove' })) act(() => api.del(`/api/agentnet/custom/${a.id}`), { ok: 'Removed' }).then(reload); }}>Remove agent</${Button}></div>` : null}
    </div>` : null}
  </div>`;
}

function WorkspacePicker({ value, onChange }) {
  const { data: clients } = useApi('/api/clients');
  const all = value === 'all' || !value;
  const list = Array.isArray(value) ? value : [];
  return html`<div class="field"><span class="label">Workspaces this agent may work in</span>
    <div class="chips"><button class=${'chip' + (all ? ' on' : '')} onClick=${() => onChange('all')}>All workspaces</button>
      <button class=${'chip' + (!all && list.includes('internal') ? ' on' : '')} onClick=${() => onChange(all ? ['internal'] : list.includes('internal') ? list.filter((x) => x !== 'internal') : [...list, 'internal'])}>Euclidean (internal)</button>
      ${(clients || []).map((c) => html`<button class=${'chip' + (!all && list.includes(c.id) ? ' on' : '')} onClick=${() => onChange(all ? [c.id] : list.includes(c.id) ? list.filter((x) => x !== c.id) : [...list, c.id])}>${c.name}</button>`)}</div>
    <div class="hint">Client workspaces keep each client's information separate: an agent only sees the workspaces ticked here.</div></div>`;
}

function HerdrCard() {
  const { data: h, reload } = useApi('/api/agentnet/herdr', ['herdr', 'agentnet']);
  const [busy, setBusy] = useState('');
  const run = (name, path, ok) => async () => { setBusy(name); try { await quiet(api.post(path).then((r) => (r?.canceled ? r : resultToast(r, ok)))); } finally { setBusy(''); reload(); } };
  const state = !h ? null : !h.installed ? 'not_connected' : h.error ? 'needs_attention' : h.serverRunning ? 'connected' : 'needs_attention';
  return html`<div class="panel pad col" style="gap:12px">
    <div class="row" style="gap:10px"><div class="avatar" style="background:var(--sky-soft);color:var(--sky-ink)"><${Icon} name="monitor" size=${17} /></div>
      <div class="grow"><div class="row" style="gap:6px"><b>Herdr</b><span class="faint" style="font-size:var(--fs-xs)">terminal runtime</span></div><div class="faint" style="font-size:var(--fs-sm)">Keeps command-line agents (Claude Code, Codex, Cursor, opencode, Grok CLI) running in terminal sessions. It only runs terminals; the agents do the thinking.</div></div>
      ${state ? html`<${Health} h=${{ state }} />` : null}</div>
    ${!h ? html`<${Loading} rows=${2} />` : html`
      <div class=${'notice' + (state === 'connected' ? ' teal' : state === 'needs_attention' ? ' gold' : '')}><${Icon} name=${state === 'connected' ? 'check' : 'info'} size=${15} /><span class="grow">${!h.installed ? 'Not installed. Only needed if an agent uses the "Herdr terminal" connection.' : h.error ? h.error : `${h.version || 'Herdr'} · ${h.serverRunning ? 'server running' : 'server not running yet (Test Herdr starts it)'}`}</span></div>
      <div class="row wrap" style="gap:8px">
        ${!h.installed ? html`<${Button} kind="primary" icon="download" busy=${busy === 'install'} onClick=${run('install', '/api/agentnet/herdr/install', 'Herdr installed')}>Install Herdr</${Button}>` : null}
        <${Button} kind="soft" icon="folder" busy=${busy === 'file'} onClick=${run('file', '/api/agentnet/herdr/install-file', 'Herdr installed from your file')}>Install from file</${Button}>
        <${Button} kind="soft" icon="wand" busy=${busy === 'conf'} onClick=${run('conf', '/api/agentnet/herdr/configure', 'Herdr found and configured')}>Configure automatically</${Button}>
        <${Button} kind="ghost" icon="bolt" busy=${busy === 'test'} disabled=${!h.installed} onClick=${run('test', '/api/agentnet/herdr/test', (r) => r.message)}>Test Herdr</${Button}>
      </div>
      <div class="row wrap" style="gap:6px;font-size:var(--fs-sm)"><span class="faint">Agents using Herdr:</span>${h.usedBy.length ? h.usedBy.map((a) => html`<span class="badge sky">${a.name}</span>`) : html`<span class="faint">none (choose "Herdr terminal" on an agent's card)</span>`}</div>
      ${h.installed ? html`<div class="col" style="gap:4px"><span class="faint" style="font-size:var(--fs-sm)">Active sessions</span>
        ${h.sessions.length ? h.sessions.map((s) => html`<div class="row" style="font-size:var(--fs-sm)"><span class="led ok" /><span class="mono">${s.name || s.id || JSON.stringify(s).slice(0, 60)}</span></div>`) : html`<span class="faint" style="font-size:var(--fs-sm)">${h.serverRunning ? 'No named sessions' : 'Starts when an agent first needs it'}</span>`}
        ${h.agents ? html`<pre class="mono" style="margin:4px 0 0;font-size:var(--fs-xs);white-space:pre-wrap;max-height:120px;overflow:auto;background:var(--surface-2);padding:8px;border-radius:var(--r-sm)">${h.agents}</pre>` : null}</div>` : null}
      ${h.path ? html`<div class="faint mono" style="font-size:var(--fs-xs)">${h.path}</div>` : null}`}
  </div>`;
}

// ================================================================= Agent Conversations
export function AgentConversations() {
  const { data: threads, reload } = useApi('/api/agentnet/threads', ['agentnet']);
  const { data: st } = useApi('/api/agentnet/status', ['agentnet']);
  const { data: agentsData } = useApi('/api/agentnet/agents', ['agentnet']);
  const [cur, setCur] = useState(null);
  const [creating, setCreating] = useState(false);
  const [filter, setFilter] = useState('active');
  const agents = agentsData?.agents || [];
  useEffect(() => { if (!cur && threads?.length) setCur(threads.find((t) => t.status === 'active')?.id || threads[0].id); }, [threads]);
  const shown = (threads || []).filter((t) => (filter === 'all' ? true : filter === 'attention' ? t.failed || t.approvals || t.paused : t.status === 'active'));
  return html`<div class="col" style="gap:12px">
    <div class="row wrap" style="gap:8px">
      <div class="row wrap grow" style="gap:6px">${agents.filter((a) => a.config.enabled).map((a) => html`<span class="badge" title=${a.health.reason} style=${{ background: `var(--${a.tone}-soft)`, color: `var(--${a.tone}-ink)` }}><span class=${'led ' + (st?.busy?.[a.id] ? 'live' : a.health.state === 'connected' ? 'ok' : a.health.state === 'needs_attention' ? 'warn' : '')} />${a.name}${st?.busy?.[a.id] ? ' · thinking' : st?.queued?.[a.id] ? ` · ${st.queued[a.id]} waiting` : ''}</span>`)}
        ${!agents.length ? null : html`<${Button} size="sm" kind="ghost" icon="settings" onClick=${() => navigate('/settings?tab=agents')}>Agent Connections</${Button}>`}</div>
      ${st?.paused ? html`<${Button} kind="moss" icon="play" onClick=${() => act(() => api.post('/api/agentnet/pause', { paused: false }), { ok: 'Agents can talk again' })}>Resume all agents</${Button}>`
        : html`<${HoldButton} kind="coral" icon="pause" title="Hold to pause every agent conversation" onConfirm=${() => act(() => api.post('/api/agentnet/pause', { paused: true }), { ok: 'All agent conversations paused' })}>Pause all agents</${HoldButton}>`}
      <${Button} kind="primary" icon="plus" onClick=${() => setCreating(true)}>New conversation</${Button}>
    </div>
    ${st?.paused ? html`<div class="notice gold"><${Icon} name="pause" size=${16} />All agent conversations are paused. Messages wait until you resume.</div>` : null}
    <div style="display:grid;grid-template-columns:minmax(220px, 280px) minmax(0, 1fr) minmax(260px, 320px);gap:12px;min-height:560px">
      <div class="panel" style="display:flex;flex-direction:column;min-height:0">
        <div class="panel-head"><${Seg} value=${filter} onChange=${setFilter} options=${[{ value: 'active', label: 'Active' }, { value: 'attention', label: 'Attention' }, { value: 'all', label: 'All' }]} /></div>
        <div class="list" style="overflow:auto;flex:1">${!threads ? html`<${Loading} rows=${3} />` : !shown.length ? html`<div class="faint" style="padding:16px;font-size:var(--fs-sm)">${filter === 'active' ? 'No conversations yet. Start one and pick which agents join.' : 'Nothing here.'}</div>` : shown.map((t) => html`
          <div class=${'list-row click' + (cur === t.id ? ' on' : '')} style=${{ alignItems: 'flex-start', background: cur === t.id ? 'var(--teal-soft)' : '' }} onClick=${() => setCur(t.id)}>
            <div class="grow" style="min-width:0"><div class="row" style="gap:6px"><b class="ellipsis">${t.title}</b>${t.working ? html`<span class="led live" />` : null}</div>
              <div class="faint ellipsis" style="font-size:var(--fs-xs)">${t.participantNames.join(', ') || 'No agents yet'} · ${t.workspaceLabel.split(' (')[0]}</div>
              <div class="row" style="gap:4px;margin-top:3px">${t.paused ? html`<span class="badge gold">Paused</span>` : null}${t.approvals ? html`<span class="badge gold">${t.approvals} to approve</span>` : null}${t.failed ? html`<span class="badge coral">${t.failed} failed</span>` : null}${t.status === 'archived' ? html`<span class="badge">Archived</span>` : null}</div></div>
            <span class="faint" style="font-size:var(--fs-xs);white-space:nowrap">${ago(t.lastAt)}</span></div>`)}</div>
      </div>
      ${cur && threads?.find((t) => t.id === cur) ? html`<${ThreadView} t=${threads.find((t) => t.id === cur)} agents=${agents} reload=${reload} />` : html`<div class="panel"><${Empty} icon="messages" title="Agent Conversations">Agents message each other here as peers: questions, critiques, task hand-offs and files. You can read along, step in, pause, or approve anything that would leave Euclidean.</${Empty}></div>`}
      <${SidePanel} agents=${agents} openThread=${setCur} />
    </div>
    ${creating ? html`<${NewThread} agents=${agents} onClose=${() => setCreating(false)} onDone=${(t) => { setCreating(false); setCur(t.id); reload(); }} />` : null}
  </div>`;
}

function NewThread({ agents, onClose, onDone }) {
  const { data: clients } = useApi('/api/clients');
  const usable = agents.filter((a) => a.config.enabled);
  const [f, setF] = useState({ title: '', workspaceId: 'internal', participants: usable.filter((a) => a.health.state === 'connected').map((a) => a.id).slice(0, 3), type: 'message', body: '' });
  const allowed = (a) => a.config.workspaces === 'all' || (Array.isArray(a.config.workspaces) && a.config.workspaces.includes(f.workspaceId));
  const start = () => act(() => api.post('/api/agentnet/threads', { ...f, participants: f.participants.filter((x) => allowed(agents.find((a) => a.id === x))), title: f.title || f.body.slice(0, 60) || 'New conversation' }), { ok: 'Conversation started' }).then(onDone);
  return html`<${Modal} wide title="New agent conversation" icon="messages" onClose=${onClose} footer=${html`<${Button} kind="ghost" onClick=${onClose}>Cancel</${Button}><${Button} kind="primary" icon="send" disabled=${!f.participants.length} onClick=${start}>Start conversation</${Button}>`}>
    <div class="col" style="gap:14px">
      <div class="form-grid"><${Field} label="Topic" id="nt-t"><input id="nt-t" class="input" value=${f.title} onInput=${(e) => setF({ ...f, title: e.target.value })} placeholder="Hook ideas for Stringer's next short" autofocus /></${Field}>
        <${Field} label="Workspace" hint="Agents only see this workspace's information." id="nt-w"><select id="nt-w" class="select" value=${f.workspaceId} onChange=${(e) => setF({ ...f, workspaceId: e.target.value })}><option value="internal">Euclidean (internal, no client data)</option>${(clients || []).map((c) => html`<option value=${c.id}>${c.name}</option>`)}</select></${Field}></div>
      <div class="field"><span class="label">Agents in this conversation</span><div class="chips">${usable.map((a) => html`<button class=${'chip' + (f.participants.includes(a.id) ? ' on' : '')} disabled=${!allowed(a)} title=${!allowed(a) ? `${a.name} isn't allowed in this workspace` : a.health.reason} onClick=${() => setF({ ...f, participants: f.participants.includes(a.id) ? f.participants.filter((x) => x !== a.id) : [...f.participants, a.id] })}>${f.participants.includes(a.id) ? html`<${Icon} name="check" size=${13} />` : null}${a.name}${a.health.state !== 'connected' ? html` <span class="faint">(${a.health.state === 'needs_attention' ? 'needs attention' : 'not set up'})</span>` : null}</button>`)}</div>
        ${!usable.length ? html`<div class="hint">No agents are turned on yet. Set them up in Settings → Agent Connections.</div>` : null}</div>
      <div class="row" style="gap:10px;align-items:flex-start"><${Field} label="First message type" id="nt-ty"><select id="nt-ty" class="select" value=${f.type} onChange=${(e) => setF({ ...f, type: e.target.value })}>${['message', 'question', 'critique_request', 'task_request'].map((t) => html`<option value=${t}>${TYPE_LABEL[t]}</option>`)}</select></${Field}></div>
      <${Field} label="First message (optional)" id="nt-b"><textarea id="nt-b" class="textarea" rows="4" value=${f.body} onInput=${(e) => setF({ ...f, body: e.target.value })} placeholder="Give the agents the task or question. They'll answer and can ask each other for help." /></${Field}>
    </div></${Modal}>`;
}

function ThreadView({ t, agents, reload }) {
  const { data: msgs } = useApi(`/api/agentnet/threads/${t.id}/messages`, ['agentnet'], [t.id]);
  const [to, setTo] = useState(['*']);
  const [type, setType] = useState('message');
  const [body, setBody] = useState('');
  const [ctxFiles, setCtxFiles] = useState([]);
  const scroller = useRef(null); const input = useRef(null);
  useEffect(() => { setTo(['*']); setCtxFiles([]); }, [t.id]);
  useEffect(() => { if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight; }, [msgs?.length, t.id]);
  const send = () => { if (!body.trim() && !ctxFiles.length) return; return act(() => api.post(`/api/agentnet/threads/${t.id}/messages`, { to, type: ctxFiles.length && !body.trim() ? 'context' : type, body: body.trim() || `Sharing ${ctxFiles.map((c) => c.name).join(', ')}`, context: ctxFiles }), { sound: 'send' }).then(() => { setBody(''); setCtxFiles([]); setType('message'); }); };
  const attach = () => act(() => api.post(`/api/agentnet/threads/${t.id}/attach`, {})).then((files) => setCtxFiles([...ctxFiles, ...files]));
  const intervene = async () => { if (!t.paused) await act(() => api.post(`/api/agentnet/threads/${t.id}/pause`, { paused: true }), { ok: 'Paused: write your instructions, then resume' }); input.current?.focus(); };
  const others = agents.filter((a) => !t.participants.includes(a.id) && a.config.enabled);
  const nameOf = (id) => agents.find((a) => a.id === id)?.name || id;
  return html`<div class="panel" style="display:flex;flex-direction:column;min-height:0;min-width:0">
    <div class="panel-head" style="flex-wrap:wrap;gap:8px">
      <div class="grow" style="min-width:0"><h4 class="ellipsis">${t.title}</h4><div class="faint" style="font-size:var(--fs-xs)">${t.workspaceLabel}</div></div>
      ${others.length ? html`<select class="select sm" style="width:auto" value="" onChange=${(e) => e.target.value && act(() => api.post(`/api/agentnet/threads/${t.id}/join`, { agentId: e.target.value }), { ok: 'Agent joined' }).then(reload)} aria-label="Add an agent"><option value="">+ Add agent</option>${others.map((a) => html`<option value=${a.id}>${a.name}</option>`)}</select>` : null}
      <${Button} size="sm" kind="gold" icon="hand" onClick=${intervene} title="Pause the agents and write instructions">Intervene</${Button}>
      ${t.paused ? html`<${Button} size="sm" kind="moss" icon="play" onClick=${() => act(() => api.post(`/api/agentnet/threads/${t.id}/pause`, { paused: false }), { ok: 'Resumed' })}>Resume</${Button}>` : html`<${Button} size="sm" kind="ghost" icon="pause" onClick=${() => act(() => api.post(`/api/agentnet/threads/${t.id}/pause`, { paused: true }), { ok: 'Paused' })}>Pause</${Button}>`}
      <${Button} size="sm" kind="ghost" icon="archive" title=${t.status === 'archived' ? 'Unarchive' : 'Archive'} onClick=${() => act(() => api.post(`/api/agentnet/threads/${t.id}/archive`, { archived: t.status !== 'archived' })).then(reload)} />
    </div>
    <div class="row wrap" style="gap:6px;padding:8px 16px;border-bottom:1px solid var(--line)">${t.participants.map((id) => { const a = agents.find((x) => x.id === id); return html`<span class="badge" style=${a ? { background: `var(--${a.tone}-soft)`, color: `var(--${a.tone}-ink)` } : {}}>${nameOf(id)}</span>`; })}${t.paused ? html`<span class="badge gold">Paused</span>` : null}</div>
    <div ref=${scroller} style="flex:1;overflow:auto;padding:14px 16px;display:flex;flex-direction:column;gap:10px;min-height:260px;max-height:62vh">
      ${!msgs ? html`<${Loading} rows=${3} />` : !msgs.length ? html`<div class="faint" style="font-size:var(--fs-sm)">No messages yet. Write the first one below.</div>` : msgs.map((m) => html`<${Bubble} key=${m.id} m=${m} agents=${agents} />`)}
    </div>
    <div style="border-top:1px solid var(--line);padding:10px 12px" class="col">
      <div class="row wrap" style="gap:6px"><span class="faint" style="font-size:var(--fs-xs)">To</span>
        <button class=${'chip' + (to.includes('*') ? ' on' : '')} onClick=${() => setTo(['*'])}>Everyone</button>
        ${t.participants.map((id) => html`<button class=${'chip' + (!to.includes('*') && to.includes(id) ? ' on' : '')} onClick=${() => { const base = to.includes('*') ? [] : to; const next = base.includes(id) ? base.filter((x) => x !== id) : [...base, id]; setTo(next.length ? next : ['*']); }}>${nameOf(id)}</button>`)}
        <div class="grow" /><select class="select sm" style="width:auto" value=${type} onChange=${(e) => setType(e.target.value)} aria-label="Message type">${['message', 'question', 'critique_request', 'task_request'].map((x) => html`<option value=${x}>${TYPE_LABEL[x]}</option>`)}</select></div>
      ${ctxFiles.length ? html`<div class="row wrap" style="gap:6px">${ctxFiles.map((c, i) => html`<span class="chip on"><${Icon} name="paperclip" size=${12} />${c.name}<span class="x" style="cursor:pointer" onClick=${() => setCtxFiles(ctxFiles.filter((_, j) => j !== i))}>×</span></span>`)}</div>` : null}
      <div class="row" style="gap:8px;align-items:flex-end">
        <textarea ref=${input} class="textarea grow" rows="2" placeholder=${t.paused ? 'Paused. Write instructions, then Send and Resume.' : 'Message the agents… (Ctrl+Enter to send)'} value=${body} onInput=${(e) => setBody(e.target.value)} onKeyDown=${(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); } }} />
        <${Button} kind="ghost" icon="paperclip" title="Attach files (copied into this workspace)" onClick=${attach} />
        <${Button} kind="primary" icon="send" onClick=${send}>Send</${Button}>
      </div>
    </div>
  </div>`;
}

function Bubble({ m, agents }) {
  const human = m.from.startsWith('human:'); const sys = m.from === 'system';
  const a = agents.find((x) => x.id === m.from);
  if (sys || m.type === 'join') return html`<div class="faint" style="align-self:center;font-size:var(--fs-xs);text-align:center;white-space:pre-wrap;max-width:85%">${m.body}</div>`;
  const deliveries = Object.entries(m.deliveries || {});
  return html`<div style=${{ alignSelf: human ? 'flex-end' : 'flex-start', maxWidth: '88%' }} class="col">
    <div class="row" style="gap:6px;font-size:var(--fs-xs)">${!human ? html`<span class="avatar sm" style=${{ background: `var(--${a?.tone || 'slate'}-soft)`, color: `var(--${a?.tone || 'slate'}-ink)`, width: '20px', height: '20px', fontSize: '10px' }}>${(m.fromName || '?').slice(0, 2)}</span>` : null}
      <b>${m.fromName}</b><span class="faint">→ ${m.toNames.join(', ')}</span>${m.type !== 'message' && m.type !== 'reply' ? html`<span class=${'badge ' + (TYPE_TONE[m.type] || '')}>${TYPE_LABEL[m.type] || m.type}</span>` : null}<span class="faint">${ago(m.createdAt)}</span></div>
    <div style=${{ background: human ? 'var(--bubble-out)' : m.type === 'action_request' ? 'var(--gold-soft)' : 'var(--surface-2)', border: '1px solid var(--line)', borderRadius: '12px', padding: '9px 12px', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', userSelect: 'text' }}>${m.body}
      ${m.action ? html`<div class="notice gold" style="margin-top:8px"><${Icon} name="lock" size=${14} />Needs your approval (${m.action.kind}): ${m.action.summary}</div>` : null}
      ${(m.context || []).length ? html`<div class="row wrap" style="gap:6px;margin-top:6px">${m.context.map((c) => html`<span class="chip"><${Icon} name="paperclip" size=${12} />${c.name}</span>`)}</div>` : null}</div>
    ${deliveries.length ? html`<div class="row wrap" style="gap:4px;margin-top:3px">${deliveries.map(([id, d]) => { const [tone, label] = DELIVERY[d.status] || ['', d.status]; return html`<span class=${'badge ' + tone} title=${d.error || ''}>${agents.find((x) => x.id === id)?.name || id}: ${label}${d.status === 'failed' ? html` <span style="cursor:pointer;text-decoration:underline" onClick=${() => act(() => api.post(`/api/agentnet/messages/${m.id}/retry`, { agentId: id }), { ok: 'Trying again' })}>retry</span>` : null}</span>`; })}</div>` : null}
    ${deliveries.some(([, d]) => d.status === 'failed') ? html`<div style="font-size:var(--fs-xs);color:var(--coral-ink);margin-top:2px">${deliveries.filter(([, d]) => d.status === 'failed').map(([id, d]) => `${agents.find((x) => x.id === id)?.name || id}: ${d.error}`).join(' · ')}</div>` : null}
  </div>`;
}

function SidePanel({ agents, openThread }) {
  const [tab, setTab] = useState('approvals');
  const [agentId, setAgentId] = useState('');
  const [box, setBox] = useState('inbox');
  const { data: approvals } = useApi('/api/agentnet/approvals', ['agentnet']);
  const { data: failed } = useApi(tab === 'failed' ? '/api/agentnet/failed' : null, ['agentnet'], [tab]);
  const pick = agentId || agents.find((a) => a.config.enabled)?.id || '';
  const { data: mail } = useApi(tab === 'mail' && pick ? `/api/agentnet/agents/${pick}/${box}` : null, ['agentnet'], [tab, pick, box]);
  const decide = (a, approve) => act(() => api.post(`/api/agentnet/approvals/${a.id}/decide`, { approve }), { ok: approve ? 'Approved' : 'Declined' });
  return html`<div class="panel" style="display:flex;flex-direction:column;min-height:0">
    <div style="padding:0 8px"><${Tabs} value=${tab} onChange=${setTab} tabs=${[{ value: 'approvals', label: 'Approvals', badge: approvals?.length || 0 }, { value: 'mail', label: 'Inbox / outbox' }, { value: 'failed', label: 'Failed' }]} /></div>
    <div style="overflow:auto;flex:1;padding:10px" class="col">
      ${tab === 'approvals' ? (!approvals ? html`<${Loading} rows=${2} />` : !approvals.length ? html`<div class="faint" style="font-size:var(--fs-sm)">Nothing waiting. When an agent wants to text, email, post, change the CRM or an account, it asks here first.</div>` : approvals.map((a) => html`<div class="panel pad col" style="gap:6px;background:var(--gold-soft);border-color:var(--gold-line)">
        <div class="row"><b class="grow">${a.fromName}</b><span class="badge gold">${a.kind}</span></div>
        <div style="font-size:var(--fs-sm);white-space:pre-wrap">${a.summary}</div>
        ${a.command ? html`<div class="mono faint" style="font-size:var(--fs-xs)">Runs: ${a.command}</div>` : null}
        <div class="faint" style="font-size:var(--fs-xs)">${a.workspaceLabel} · ${ago(a.createdAt)} ago</div>
        <div class="row" style="gap:6px"><${HoldButton} kind="moss" size="sm" icon="check" title="Hold to approve" onConfirm=${() => decide(a, true)}>Approve</${HoldButton}><${Button} size="sm" kind="ghost" onClick=${() => decide(a, false)}>Decline</${Button}><div class="grow" /><${Button} size="sm" kind="ghost" onClick=${() => openThread(a.threadId)}>View</${Button}></div></div>`)) : null}
      ${tab === 'mail' ? html`<div class="row" style="gap:6px"><select class="select sm grow" value=${pick} onChange=${(e) => setAgentId(e.target.value)} aria-label="Agent">${agents.map((a) => html`<option value=${a.id}>${a.name}</option>`)}</select><${Seg} value=${box} onChange=${setBox} options=${[{ value: 'inbox', label: 'Inbox' }, { value: 'outbox', label: 'Outbox' }]} /></div>
        ${!mail ? html`<${Loading} rows=${2} />` : !mail.length ? html`<div class="faint" style="font-size:var(--fs-sm)">Empty.</div>` : mail.map((m) => html`<div class="list-row click" style="padding:8px;border:1px solid var(--line);border-radius:var(--r-sm);align-items:flex-start" onClick=${() => openThread(m.threadId)}>
          <div class="grow" style="min-width:0"><div class="row" style="gap:4px;font-size:var(--fs-xs)"><b>${box === 'inbox' ? m.fromName : `→ ${m.toNames.join(', ')}`}</b><span class=${'badge ' + (TYPE_TONE[m.type] || '')}>${TYPE_LABEL[m.type] || m.type}</span></div><div class="ellipsis" style="font-size:var(--fs-sm)">${m.body}</div></div><span class="faint" style="font-size:var(--fs-xs)">${ago(m.createdAt)}</span></div>`)}` : null}
      ${tab === 'failed' ? (!failed ? html`<${Loading} rows=${2} />` : !failed.length ? html`<div class="faint" style="font-size:var(--fs-sm)">No failed messages.</div>` : failed.map((m) => html`<div class="panel pad col" style="gap:4px">
        <div class="ellipsis" style="font-size:var(--fs-sm)"><b>${m.fromName}</b>: ${m.body}</div>
        ${Object.entries(m.deliveries || {}).filter(([, d]) => d.status === 'failed').map(([id, d]) => html`<div style="font-size:var(--fs-xs);color:var(--coral-ink)">${agents.find((x) => x.id === id)?.name || id}: ${d.error}</div>`)}
        <div class="row" style="gap:6px"><${Button} size="sm" kind="soft" icon="refresh" onClick=${() => act(() => api.post(`/api/agentnet/messages/${m.id}/retry`, {}), { ok: 'Trying again' })}>Retry</${Button}><${Button} size="sm" kind="ghost" onClick=${() => openThread(m.threadId)}>View</${Button}></div></div>`)) : null}
    </div></div>`;
}
