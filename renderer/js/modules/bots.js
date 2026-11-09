// Bots: Euclidean's own team of AI bots (the GrokBot alternative). Each bot is a contact with its own job, brain,
// thread and computer; you watch it search, read, click and run things, and allow the steps that act on the world.
import { html, useState, useEffect, useRef, useApi, useRoute, navigate, Button, Seg, Toggle, Drawer, Modal, Field, Empty, act, toast, confirmDialog } from '../lib/ui.js';
import { api } from '../lib/api.js';
import { Icon } from '../lib/icons.js';
import { GrokBots } from './bridge.js';

const TOOL = {
  research: ['search', 'Searched and read'], web_search: ['search', 'Searched'], read_page: ['book', 'Read a page'], news: ['globe', 'Checked the news'],
  browser_open: ['monitor', 'Opened'], browser_read: ['eye', 'Looked at the page'], browser_scroll: ['chevronDown', 'Scrolled'], browser_click: ['pointer', 'Clicked'], browser_type: ['type', 'Typed'],
  computer_run: ['cpu', 'Ran a command'], computer_write_file: ['edit', 'Saved a file'], computer_read_file: ['folder', 'Opened a file'], computer_screenshot: ['monitor', 'Took a picture of'],
  notebook_recall: ['book', 'Checked the notebook'], notebook_learn: ['book', 'Wrote in the notebook'], app_records: ['layers', 'Looked in Euclidean'], ask_bot: ['robot', 'Asked'],
};
const COLORS = ['sky', 'coral', 'gold', 'lav', 'moss', 'teal', 'rose'];
const KINDS = { master: 'Master', client: 'Client bot', scout: 'Scouting' };
const EVERY = [{ value: 'day', label: 'Every day' }, { value: 'weekday', label: 'Weekdays' }, { value: 'week', label: 'Weekly' }, { value: 'hour', label: 'Every hour' }];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const shotUrl = (f) => api.url(`/api/bots/shot?file=${encodeURIComponent(f)}`);
const argLine = (s) => {
  const a = s.args || {};
  if (s.tool === 'research') return a.question; if (s.tool === 'web_search' || s.tool === 'news' || s.tool === 'notebook_recall') return a.query;
  if (s.tool === 'read_page' || s.tool === 'browser_open' || s.tool === 'computer_screenshot') return a.url;
  if (s.tool === 'browser_click') return a.target; if (s.tool === 'browser_type') return `"${a.text}"${a.field ? ` into ${a.field}` : ''}${a.enter ? ' + Enter' : ''}`;
  if (s.tool === 'computer_run') return a.command; if (s.tool === 'computer_write_file' || s.tool === 'computer_read_file') return a.path;
  if (s.tool === 'notebook_learn') return a.text; if (s.tool === 'app_records') return `${a.kind || ''}${a.query ? `: ${a.query}` : ''}`; if (s.tool === 'ask_bot') return `${a.bot}: ${a.task}`;
  return JSON.stringify(a);
};

function Avatar({ bot, size = 38 }) {
  return html`<div class=${`bot-av c-${bot.color || 'sky'}`} style=${{ width: size + 'px', height: size + 'px', fontSize: Math.round(size * 0.5) + 'px' }}>${bot.emoji || '🤖'}</div>`;
}

export function Bots() {
  const route = useRoute();
  const { data, reload } = useApi('/api/bots', ['bots']);
  const bots = data?.bots || [];
  const [sel, setSel] = useState(route.query.bot || localStorage.getItem('eu.bot') || '');
  useEffect(() => { if (route.query.bot) setSel(route.query.bot); }, [route.query.bot]);
  const cur = bots.find((b) => b.id === sel) || bots[0];
  useEffect(() => { if (cur) { try { localStorage.setItem('eu.bot', cur.id); } catch { /* private window */ } } }, [cur?.id]);
  const [editing, setEditing] = useState(null);
  const [side, setSide] = useState(() => { try { return localStorage.getItem('eu.botSide') !== '0'; } catch { return true; } });
  const toggleSide = () => { setSide(!side); try { localStorage.setItem('eu.botSide', side ? '0' : '1'); } catch { /* fine */ } };
  const [making, setMaking] = useState(route.query.fromData ? { fromData: route.query.fromData } : null);
  useEffect(() => { if (route.query.fromData) setMaking({ fromData: route.query.fromData }); }, [route.query.fromData]);
  const newBot = () => setMaking({});
  const made = (b) => { setMaking(null); if (b) { setSel(b.id); reload(); } navigate('/bots'); };
  return html`<div class="page bots-page">
    <div class="page-head"><div class="grow"><h1>Bots</h1><div class="sub">Your own team of AI bots. They look things up on the live web for free, use their own computer, and ask you before they act.</div></div>
      <${Button} kind="primary" icon="plus" onClick=${newBot}>New bot</${Button}></div>
    ${data && !data.brains?.auto?.ready ? html`<div class="notice gold">No AI is connected yet, so the bots can't think. Press "Set up free AI" in <a href="#" onClick=${(e) => { e.preventDefault(); navigate('/settings'); }}>Settings → AI</a> (free, runs on this PC), or add an API key.</div>` : null}
    <div class=${'bots-grid' + (side ? '' : ' no-side')}>
      <div class="panel bots-list" data-animate>
        ${bots.map((b) => html`<button type="button" class=${'bot-row' + (cur?.id === b.id ? ' on' : '')} onClick=${() => setSel(b.id)} onContextMenu=${(e) => { e.preventDefault(); setSel(b.id); setEditing(b.id); }}>
          <${Avatar} bot=${b} />
          <div class="grow" style="min-width:0;text-align:left"><div class="row" style="gap:6px"><b class="ellipsis">${b.name}</b>${KINDS[b.kind] ? html`<span class="faint" style="font-size:var(--fs-xs)">${KINDS[b.kind]}</span>` : null}${b.pinned ? html`<${Icon} name="pin" size=${12} />` : null}</div>
            <div class="faint ellipsis" style="font-size:var(--fs-xs)">${b.busy ? (b.busy.status === 'waiting' ? '⏸ Waiting for your OK' : html`<span class="spinner" style="width:9px;height:9px" /> ${b.busy.note || 'Working'}`) : b.last ? `${b.last.role === 'you' ? 'You: ' : ''}${b.last.text}` : b.role}</div></div>
          ${b.busy?.status === 'waiting' ? html`<span class="badge gold">1</span>` : null}
        </button>`)}
        ${!bots.length && data ? html`<div class="faint pad">No bots yet.</div>` : null}
      </div>
      ${cur ? html`<${Chat} key=${cur.id} bot=${cur} brains=${data?.brains} desktop=${data?.desktop} onEdit=${() => setEditing(cur.id)} side=${side} onSide=${toggleSide} />` : html`<div class="panel pad"><${Empty} icon="robot" title="Make your first bot">Press New bot.</${Empty}></div>`}
      ${cur && side ? html`<${ComputerPanel} key=${'c' + cur.id} bot=${cur} desktop=${data?.desktop} />` : null}
    </div>
    <details class="panel pad" style="margin-top:14px"><summary><b>GrokBots by email</b> <span class="faint" style="font-size:var(--fs-xs)">the older way: email a task to a GrokBot and read its reply here</span></summary><div style="margin-top:10px"><${GrokBots} /></div></details>
    ${making ? html`<${NewBot} start=${making} onClose=${() => made(null)} onMade=${made} />` : null}
    ${editing ? html`<${BotSettings} id=${editing} brains=${data?.brains} desktop=${data?.desktop} onClose=${() => { setEditing(null); reload(); }} onDeleted=${() => { setEditing(null); setSel(''); reload(); }} />` : null}
  </div>`;
}

function Chat({ bot, brains, desktop, onEdit, side, onSide }) {
  const { data, reload } = useApi(`/api/bots/${bot.id}`, ['bots']);
  const [text, setText] = useState(''); const [sending, setSending] = useState(false);
  const end = useRef(null); const box = useRef(null);
  const msgs = data?.messages || []; const runs = data?.runs || {};
  const active = Object.values(runs).find((r) => r.status === 'working' || r.status === 'waiting');
  useEffect(() => { const el = box.current; if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 260) end.current?.scrollIntoView({ block: 'end' }); }, [data]);
  useEffect(() => { setTimeout(() => end.current?.scrollIntoView({ block: 'end' }), 30); }, [bot.id]);
  const send = async () => {
    const t = text.trim(); if (!t || sending) return;
    setSending(true);
    try { await api.post(`/api/bots/${bot.id}/send`, { text: t }); setText(''); reload(); setTimeout(() => end.current?.scrollIntoView({ block: 'end' }), 50); } catch (e) { toast(e.message, { kind: 'error' }); }
    setSending(false);
  };
  const brain = brains?.[bot.brain || 'auto'];
  return html`<div class="panel bots-chat">
    <div class="bots-head">
      <${Avatar} bot=${bot} size=${42} />
      <div class="grow" style="min-width:0"><div class="row" style="gap:8px"><b style="font-size:var(--fs-lg)">${bot.name}</b>${KINDS[bot.kind] ? html`<span class="badge lav">${KINDS[bot.kind]}</span>` : null}${(bot.routines || []).some((r) => r.on) ? html`<span class="badge" title="Has scheduled tasks">⏰</span>` : null}
        <span class=${'badge ' + (brain?.ready ? 'moss' : 'coral')} title="Its brain">${brain?.label || bot.brain}${brain && !brain.ready ? ' · not connected' : ''}</span>
        <span class="badge" title="Its computer">${bot.computer === 'vm' ? 'Own computer (VM)' : bot.computer === 'browser' ? 'Own browser' : 'Web reader'}</span></div>
        <div class="faint ellipsis" style="font-size:var(--fs-sm)">${bot.role || 'No job yet. Press Settings to give it one.'}</div></div>
      <${Button} size="sm" kind="ghost" icon="monitor" title=${side ? 'Hide its computer' : 'Show its computer'} onClick=${onSide} />
      <${Button} size="sm" kind="ghost" icon="edit" onClick=${onEdit}>Settings</${Button}>
      <${Button} size="sm" kind="ghost" icon="trash" title="Clear this chat" onClick=${() => act(() => api.del(`/api/bots/${bot.id}/thread`), { ok: 'Chat cleared' }).then(reload)} />
    </div>
    <div class="bots-thread" ref=${box}>
      ${!msgs.length ? html`<div class="faint" style="padding:30px 10px;text-align:center">${bot.emoji} Ask ${bot.name} something. ${bot.role ? html`<br /><span style="font-size:var(--fs-sm)">${bot.role}</span>` : null}
        <div class="row wrap" style="gap:6px;justify-content:center;margin-top:14px">${examples(bot).map((x) => html`<button type="button" class="chip" onClick=${() => setText(x)}>${x}</button>`)}</div></div>` : null}
      ${msgs.map((m) => html`<${Message} m=${m} run=${m.role === 'you' ? runs[m.runId] : null} bot=${bot} reload=${reload} />`)}
      <div ref=${end} />
    </div>
    <div class="bots-compose">
      <textarea class="input grow" rows="2" placeholder=${`Message ${bot.name}…  (Enter to send, Shift+Enter for a new line)`} value=${text} onInput=${(e) => setText(e.target.value)} onKeyDown=${(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} />
      ${active ? html`<${Button} kind="coral" icon="stop" onClick=${() => act(() => api.post(`/api/bots/runs/${active.id}/stop`, {})).then(reload)}>Stop</${Button}>`
        : html`<${Button} kind="primary" icon="send" busy=${sending} disabled=${!text.trim()} onClick=${send}>Send</${Button}>`}
    </div>
  </div>`;
}

function examples(bot) {
  if (bot.kind === 'master') return ['Plan my day: calls, emails and videos', 'Who on the master winners list have we not contacted yet? Make me a top 5 with drafts', 'Have Scout find 5 new CT winners and Juno draft their emails'];
  if (bot.kind === 'client') return ['Draft the Day 6 follow-up for the people we called Nov 3', 'Find 5 urbex YouTubers with weak Shorts', 'What is waiting on Stringer Media?'];
  if (bot.kind === 'scout') return ['Find 5 Connecticut Democrats who won town or state seats and have no social team', 'Research Lisa Kaul (SD-39): money, socials, a hook', 'Find NJ Assembly winners from this month'];
  if (/data/i.test(bot.name)) return ['What lists are in the Data tab?', 'Clean the Master Winners list into a call sheet', 'Make a one-pager for political offices'];
  if (bot.computer === 'vm') return ['Make a CSV of the 10 biggest US cities and their population', 'Check what Python version your computer has'];
  if (/lead|politic/i.test(`${bot.name} ${bot.role}`)) return ['Find the campaign website and press email for the new mayor of Stamford, CT', 'Who won the open NY Assembly seats on Nov 3?'];
  if (/trend/i.test(`${bot.name} ${bot.role}`)) return ['What hooks are working on TikTok this week?', 'Give me 5 title ideas for an abandoned-places short'];
  return ['What happened in NY politics today?', 'Find 3 recent articles about short-form video for campaigns'];
}

function Message({ m, run, bot, reload }) {
  if (m.role === 'you') return html`<div class="bot-msg you"><div class="bubble selectable">${m.text}</div></div>${run ? html`<${Run} run=${run} bot=${bot} reload=${reload} />` : null}`;
  return html`<div class=${'bot-msg them' + (m.role === 'error' ? ' err' : '')}><div class="bubble selectable">${m.role === 'bot' ? html`<div class="faint" style="font-size:var(--fs-xs);margin-bottom:4px">${bot.emoji} ${bot.name}${m.by ? ` · ${m.by === 'ollama' ? 'Llama' : m.by}` : ''}</div>` : null}${linkify(m.text)}</div></div>`;
}

function linkify(t) {
  const parts = String(t || '').split(/(https?:\/\/[^\s)\]>"']+)/g);
  return parts.map((p, i) => (i % 2 ? html`<a href=${p} target="_blank" rel="noopener">${p.replace(/^https?:\/\/(www\.)?/, '').slice(0, 60)}${p.length > 70 ? '…' : ''}</a>` : p));
}

function Run({ run, bot, reload }) {
  const [open, setOpen] = useState(null);
  const steps = (run.steps || []).filter((s) => s.tool);
  const working = run.status === 'working';
  if (!steps.length && !working && run.status !== 'stopped') return null;
  return html`<div class="bot-run">
    ${steps.map((s) => {
      const [icon, verb] = TOOL[s.tool] || ['bolt', s.tool];
      if (s.waiting && s.allowed === undefined) return html`<div class="bot-card">
        <div class="row" style="gap:8px"><${Icon} name="hand" size=${17} /><b>${bot.name} wants to ${s.why}</b></div>
        ${s.say ? html`<div class="muted" style="font-size:var(--fs-sm)">${s.say}</div>` : null}
        <pre class="bot-code selectable">${argLine(s)}</pre>
        <div class="row" style="gap:6px"><${Button} size="sm" kind="primary" icon="check" onClick=${() => act(() => api.post(`/api/bots/runs/${run.id}/decide`, { allow: true })).then(reload)}>Allow</${Button}><${Button} size="sm" kind="ghost" icon="x" onClick=${() => act(() => api.post(`/api/bots/runs/${run.id}/decide`, { allow: false })).then(reload)}>Deny</${Button}>
          <span class="faint" style="font-size:var(--fs-xs)">Settings can let it do this on its own.</span></div>
      </div>`;
      return html`<div class=${'bot-step' + (s.failed || s.denied ? ' bad' : '')}>
        <button type="button" class="bot-step-head" onClick=${() => setOpen(open === s.id ? null : s.id)}>
          ${s.running ? html`<span class="spinner" style="width:12px;height:12px" />` : html`<${Icon} name=${icon} size=${14} />`}
          <span class="ellipsis"><b>${s.denied ? 'Not allowed: ' : /^Already done/.test(s.result || '') ? 'Skipped a repeat: ' : ''}${verb}</b> ${argLine(s)}</span>
          ${s.result ? html`<${Icon} name=${open === s.id ? 'chevronDown' : 'chevronRight'} size=${13} />` : null}</button>
        ${s.shot ? html`<a href=${shotUrl(s.shot)} target="_blank" rel="noopener"><img class="bot-shot" src=${shotUrl(s.shot)} alt="What the bot saw" loading="lazy" /></a>` : null}
        ${open === s.id && s.result ? html`<pre class="bot-result selectable">${s.result}</pre>` : null}
      </div>`;
    })}
    ${working ? html`<div class="faint row" style="gap:6px;font-size:var(--fs-sm)"><span class="spinner" style="width:12px;height:12px" /> ${run.note || 'Working'}…</div>` : null}
    ${run.status === 'stopped' ? html`<div class="faint" style="font-size:var(--fs-sm)">${run.note || 'Stopped'}</div>` : null}
  </div>`;
}

function ComputerPanel({ bot, desktop }) {
  const vm = bot.computer === 'vm';
  const { data: st, reload } = useApi(vm ? `/api/bots/${bot.id}/computer` : null, ['bots', 'jobs']);
  const { data: th } = useApi(`/api/bots/${bot.id}`, ['bots']);
  const lastShot = Object.values(th?.runs || {}).flatMap((r) => r.steps || []).filter((s) => s.shot).slice(-1)[0];
  const job = st?.setupJob;
  return html`<div class="panel pad bots-side col" style="gap:10px">
    <div class="row" style="gap:8px"><${Icon} name="monitor" size=${17} /><b class="grow">${vm ? `${bot.name}'s computer` : bot.computer === 'browser' ? `${bot.name}'s browser` : 'Web reader'}</b></div>
    ${lastShot ? html`<a href=${shotUrl(lastShot.shot)} target="_blank" rel="noopener"><img class="bot-screen" src=${shotUrl(lastShot.shot)} alt="The bot's screen" /></a><div class="faint ellipsis" style="font-size:var(--fs-xs)">${argLine(lastShot)}</div>` : html`<div class="bot-screen empty faint">${vm || bot.computer === 'browser' ? 'Pages it opens show up here.' : 'This bot reads pages as text (no screen).'}</div>`}
    ${bot.computer === 'browser' ? html`
      <div class="faint" style="font-size:var(--fs-sm)">A walled-off browser just for ${bot.name}: it can't reach this PC or your home network, can't download files, and only clicks or types after you allow it.</div>
      ${desktop ? html`<div class="row wrap" style="gap:6px"><${Button} size="sm" kind="soft" icon="external" onClick=${() => act(() => api.post(`/api/bots/${bot.id}/browser/show`, {}))}>Open it yourself</${Button}>
        <${Button} size="sm" kind="ghost" onClick=${async () => { if (await confirmDialog({ title: 'Forget its logins?', text: `${bot.name}'s browser forgets every site it was logged into.`, confirm: 'Forget' })) act(() => api.post(`/api/bots/${bot.id}/browser/clear`, {}), { ok: 'Forgotten' }); }}>Forget its logins</${Button}></div>
        <div class="faint" style="font-size:var(--fs-xs)">Open it yourself to log ${bot.name} into a site it should use. It keeps that login (only in its own browser).</div>`
      : html`<div class="notice gold" style="font-size:var(--fs-sm)">The browser works in the Euclidean desktop app. Here the bot reads pages as text.</div>`}` : null}
    ${vm ? html`
      ${!st ? html`<div class="faint"><span class="spinner" /> Checking…</div>` : st.ready ? html`
        <div class="row" style="gap:6px"><span class=${'badge ' + (st.machine === 'running' ? 'moss' : '')}>${st.machine === 'running' ? 'Running' : st.machine === 'none' ? 'Starts when needed' : 'Asleep'}</span><span class="faint" style="font-size:var(--fs-xs)">${st.runtime === 'podman' ? 'Podman' : 'Docker'} ${st.version || ''}</span></div>
        <div class="faint" style="font-size:var(--fs-sm)">Its own Linux machine (Python, Node, Chromium). It only sees its own folder, not your files. It sleeps after 30 minutes idle.</div>
        <div class="row wrap" style="gap:6px"><${Button} size="sm" kind="soft" icon="folder" onClick=${() => act(() => api.post(`/api/bots/${bot.id}/computer/folder`, {}))}>Open its folder</${Button}>
          ${st.machine === 'running' ? html`<${Button} size="sm" kind="ghost" icon="pause" onClick=${() => act(() => api.post(`/api/bots/${bot.id}/computer/stop`, {}), { ok: 'Put to sleep' }).then(reload)}>Sleep</${Button}>` : null}
          <${Button} size="sm" kind="ghost" icon="refresh" title="Throw the machine away and start clean (its files stay)" onClick=${async () => { if (await confirmDialog({ title: 'Start its computer clean?', text: 'Programs it installed are removed. Its files in /work stay.', confirm: 'Start clean' })) act(() => api.post(`/api/bots/${bot.id}/computer/reset`, {}), { ok: 'Done' }).then(reload); }}>Start clean</${Button}></div>
        ${st.files?.length ? html`<div class="bot-files">${st.files.slice(0, 40).map((f) => html`<div class="ellipsis" style="font-size:var(--fs-xs)">${f.dir ? '📁' : '📄'} ${f.path}${f.size != null && !f.dir ? html` <span class="faint">${f.size < 1024 ? `${f.size} B` : `${Math.round(f.size / 1024)} KB`}</span>` : null}</div>`)}</div>` : html`<div class="faint" style="font-size:var(--fs-xs)">No files yet.</div>`}
      ` : html`
        <div class="notice gold" style="font-size:var(--fs-sm)">${st.message}</div>
        ${job && !job.failed ? html`<div class="col" style="gap:4px"><div class="faint" style="font-size:var(--fs-xs)">${job.type === 'bots.computer.install' ? 'Installing Docker Desktop' : 'Setting up'}… ${Math.round((job.progress || 0) * 100)}%</div><div class="progress"><i style=${{ width: `${Math.round((job.progress || 0) * 100)}%` }} /></div><div class="faint ellipsis" style="font-size:var(--fs-xs)">${job.note}</div></div>` : null}
        ${job?.failed ? html`<div class="notice coral" style="font-size:var(--fs-sm)">${job.error}</div>` : null}
        <div class="row wrap" style="gap:6px">
          ${st.problem === 'no-image' && !(job && !job.failed) ? html`<${Button} size="sm" kind="primary" icon="download" onClick=${() => act(() => api.post('/api/bots/computer/setup', {}), { ok: 'Setting up the bots\' computer in the background' }).then(reload)}>Set up the computer</${Button}>` : null}
          ${st.canInstall && !(job && !job.failed) ? html`<${Button} size="sm" kind="primary" icon="download" onClick=${() => act(() => api.post('/api/bots/computer/install', {}), { ok: 'Installing Docker Desktop' }).then(reload)}>Install Docker Desktop</${Button}>` : null}
          <${Button} size="sm" kind="ghost" icon="refresh" onClick=${() => api.get(`/api/bots/${bot.id}/computer?force=1`).then(reload).catch((e) => toast(e.message, { kind: 'error' }))}>Check again</${Button}>
        </div>`}` : null}
    ${bot.computer === 'none' ? html`<div class="faint" style="font-size:var(--fs-sm)">Give ${bot.name} a browser or its own computer in Settings.</div>` : null}
  </div>`;
}

function BotSettings({ id, brains, desktop, onClose, onDeleted }) {
  const { data } = useApi(`/api/bots/${id}`, []);
  const [b, setB] = useState(null);
  useEffect(() => { if (data?.bot && !b) setB({ ...data.bot, tools: { web: true, notebook: true, app: true, team: true, leads: false, clients: false, ...(data.bot.tools || {}) } }); }, [data]);
  if (!b) return html`<${Drawer} title="Bot settings" onClose=${onClose}><div class="faint"><span class="spinner" /></div></${Drawer}>`;
  const set = (k, v) => setB({ ...b, [k]: v });
  const setTool = (k, v) => setB({ ...b, tools: { ...b.tools, [k]: v } });
  const save = () => act(() => api.patch(`/api/bots/${id}`, { name: b.name, emoji: b.emoji, color: b.color, role: b.role, instructions: b.instructions, brain: b.brain, computer: b.computer, tools: b.tools, autoBrowse: b.autoBrowse, autoRun: b.autoRun, maxSteps: b.maxSteps, pinned: b.pinned, routines: b.routines || [] }), { ok: 'Saved' }).then((r) => { if (r) onClose(); });
  const del = async () => { if (await confirmDialog({ title: `Delete ${b.name}?`, text: 'Its chat and its computer are removed.', confirm: 'Delete' })) act(() => api.del(`/api/bots/${id}`), { ok: 'Deleted' }).then(onDeleted); };
  const sw = (on, fn, label, hint) => html`<div class="row" style="gap:10px;align-items:flex-start"><${Toggle} on=${on} onChange=${fn} label=${label} /><div><div>${label}</div>${hint ? html`<div class="faint" style="font-size:var(--fs-xs)">${hint}</div>` : null}</div></div>`;
  return html`<${Drawer} title=${`${b.emoji} ${b.name}`} sub="Bot settings" onClose=${onClose} actions=${html`<${Button} kind="primary" size="sm" onClick=${save}>Save</${Button}>`}>
    <div class="col" style="gap:14px">
      <div class="row" style="gap:8px"><${Field} label="Picture"><input class="input" style="width:64px;text-align:center;font-size:20px" value=${b.emoji} onInput=${(e) => set('emoji', e.target.value)} /></${Field}>
        <div class="grow"><${Field} label="Name"><input class="input" value=${b.name} onInput=${(e) => set('name', e.target.value)} /></${Field}></div></div>
      <div class="row wrap" style="gap:6px">${COLORS.map((c) => html`<button type="button" title=${c} class=${`bot-av c-${c}` + (b.color === c ? ' picked' : '')} style="width:26px;height:26px;font-size:12px" onClick=${() => set('color', c)}>${b.color === c ? '✓' : ''}</button>`)}</div>
      <${Field} label="Its job" hint="One or two sentences: what this bot is for."><textarea class="input" rows="2" style="height:64px;font-family:inherit" value=${b.role} onInput=${(e) => set('role', e.target.value)} /></${Field}>
      <${Field} label="How it should work" hint="Rules, tone, what to always or never do."><textarea class="input" rows="4" style="height:110px;font-family:inherit" value=${b.instructions} onInput=${(e) => set('instructions', e.target.value)} /></${Field}>
      <${Field} label="Its brain" hint="Automatic follows Settings → AI (the free Llama first). Grok, Claude and ChatGPT need their key; Your AI account uses your own login (AI apps page).">
        <select class="input" value=${b.brain || 'auto'} onChange=${(e) => set('brain', e.target.value)}>${Object.entries(brains || {}).map(([k, v]) => html`<option value=${k}>${v.label}${v.ready ? '' : ' (not connected)'}</option>`)}</select></${Field}>
      <${Field} label="Its computer">
        <${Seg} value=${b.computer} onChange=${(v) => set('computer', v)} options=${[{ value: 'none', label: 'Web reader' }, { value: 'browser', label: 'Own browser' }, { value: 'vm', label: 'Own computer (VM)' }]} />
        <div class="faint" style="font-size:var(--fs-xs);margin-top:6px">${b.computer === 'vm' ? 'A Linux virtual machine on this PC (needs Docker Desktop): runs commands and code, keeps files, has a browser. It never sees your own files.' : b.computer === 'browser' ? `A walled-off browser window${desktop ? '' : ' (in the desktop app)'} that runs modern websites, with a screenshot of every page.` : 'Reads pages as plain text. Fastest, but some sites need a browser.'}</div></${Field}>
      <div class="col" style="gap:10px"><b>What it can use</b>
        ${sw(b.tools.web, (v) => setTool('web', v), 'The live web', 'Free search (DuckDuckGo, no key) and reading pages.')}
        ${sw(b.tools.notebook, (v) => setTool('notebook', v), 'The notebook', 'Reads and adds to what Euclidean and HAL have learned.')}
        ${sw(b.tools.app, (v) => setTool('app', v), "Euclidean's records (read only)", 'Leads, clients, clips and jobs.')}
        ${sw(b.tools.team, (v) => setTool('team', v), 'The other bots', 'Can hand part of a job to another bot.')}
        ${sw(!!b.tools.leads, (v) => setTool('leads', v), 'Leads and outreach', 'Checks the leads board, proposes new leads (they wait for your OK), starts outreach drafts.')}
        ${sw(!!b.tools.clients, (v) => setTool('clients', v), 'Clients', "Opens a client's file, clips and posts, and writes titles with the SEO lab.")}
      </div>
      <div class="col" style="gap:10px"><b>Asking first</b>
        ${sw(!b.autoBrowse, (v) => set('autoBrowse', !v), 'Ask before clicking or typing on websites', 'Recommended: it could otherwise fill in forms or post.')}
        ${b.computer === 'vm' ? sw(!b.autoRun, (v) => set('autoRun', !v), 'Ask before running commands in its computer', 'Its computer is walled off from your files, so turning this off is fairly safe.') : null}
        <div class="faint" style="font-size:var(--fs-xs)">Bots never send emails or messages, post, or change your records. They can write drafts for you.</div>
      </div>
      <${Routines} list=${b.routines || []} onChange=${(v) => set('routines', v)} name=${b.name} />
      <${Field} label=${`Most steps per message: ${b.maxSteps || 12}`}><input type="range" min="3" max="30" value=${b.maxSteps || 12} onInput=${(e) => set('maxSteps', Number(e.target.value))} /></${Field}>
      ${sw(!!b.pinned, (v) => set('pinned', v), 'Pin to the top of the list')}
      <div class="row" style="gap:8px;margin-top:6px"><${Button} kind="primary" onClick=${save}>Save</${Button}><span class="grow" /><${Button} kind="ghost" icon="trash" onClick=${del}>Delete bot</${Button}></div>
    </div>
  </${Drawer}>`;
}

function Routines({ list, onChange, name }) {
  const upd = (i, k, v) => onChange(list.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  return html`<div class="col" style="gap:8px"><b>Scheduled tasks</b>
    <div class="faint" style="font-size:var(--fs-xs)">Like Grok's tasks: ${name} does these on its own while Euclidean is open, and the answer lands in its chat. They only research and draft.</div>
    ${list.map((r, i) => html`<div class="panel pad col" style="gap:6px;background:var(--surface-2)">
      <textarea class="input" style="height:58px;font-family:inherit" placeholder="What to do (e.g. Morning scout: 5 to 10 new CT winners with campaign emails)" value=${r.task} onInput=${(e) => upd(i, 'task', e.target.value)} />
      <div class="row wrap" style="gap:6px;align-items:center">
        <select class="input" style="width:auto" value=${r.every} onChange=${(e) => upd(i, 'every', e.target.value)}>${EVERY.map((o) => html`<option value=${o.value}>${o.label}</option>`)}</select>
        ${r.every === 'week' ? html`<select class="input" style="width:auto" value=${r.day ?? 1} onChange=${(e) => upd(i, 'day', Number(e.target.value))}>${DAYS.map((d, k) => html`<option value=${k}>${d}</option>`)}</select>` : null}
        ${r.every === 'hour' ? html`<span class="faint">at minute</span><input class="input" style="width:70px" type="number" min="0" max="59" value=${Number(String(r.at || '08:00').split(':')[1])} onInput=${(e) => upd(i, 'at', `00:${String(Math.max(0, Math.min(59, Number(e.target.value) || 0))).padStart(2, '0')}`)} />`
          : html`<span class="faint">at</span><input class="input" style="width:110px" type="time" value=${r.at || '08:00'} onInput=${(e) => upd(i, 'at', e.target.value)} />`}
        <span class="grow" /><${Toggle} on=${r.on !== false} onChange=${(v) => upd(i, 'on', v)} label="On" /><${Button} size="sm" kind="ghost" icon="trash" title="Remove" onClick=${() => onChange(list.filter((_, j) => j !== i))} />
      </div>${r.lastRun ? html`<div class="faint" style="font-size:var(--fs-xs)">Last ran ${new Date(r.lastRun).toLocaleString()}</div>` : null}</div>`)}
    ${list.length < 10 ? html`<div><${Button} size="sm" kind="ghost" icon="plus" onClick=${() => onChange([...list, { task: '', every: 'weekday', at: '08:00', on: true }])}>Add a scheduled task</${Button}></div>` : null}
  </div>`;
}

function NewBot({ start, onClose, onMade }) {
  const { data: tpl } = useApi('/api/bots/templates', []);
  const [mode, setMode] = useState(start.fromData ? 'prompt' : 'template');
  const [prompt, setPrompt] = useState(''); const [busy, setBusy] = useState(false);
  const fileIn = useRef(null);
  useEffect(() => { if (start.fromData) api.get(`/api/data/${start.fromData}`).then((d) => setPrompt(d.preview || '')).catch(() => {}); }, [start.fromData]);
  const make = async (body) => { setBusy(true); try { const b = await api.post('/api/bots', body); toast(`${b.name} is on the team.`, { kind: 'success' }); onMade(b); } catch (e) { toast(e.message, { kind: 'error' }); } setBusy(false); };
  return html`<${Modal} title="New bot" icon="robot" wide onClose=${onClose}>
    <${Seg} value=${mode} onChange=${setMode} options=${[{ value: 'template', label: 'Ready-made' }, { value: 'prompt', label: 'From a master prompt' }]} />
    ${mode === 'template' ? html`<div class="newbot-grid">${(tpl || []).map((t) => html`<button type="button" class="newbot-card" disabled=${busy} onClick=${() => make({ template: t.id })}>
      <div class=${`bot-av c-${t.color}`} style="width:40px;height:40px;font-size:20px">${t.emoji}</div><div style="text-align:left;min-width:0"><b>${t.name}</b>${KINDS[t.kind] ? html` <span class="faint" style="font-size:var(--fs-xs)">${KINDS[t.kind]}</span>` : null}<div class="faint" style="font-size:var(--fs-xs)">${t.role || 'Start from scratch and give it a job.'}</div></div></button>`)}</div>`
    : html`<div class="col" style="gap:8px;margin-top:10px">
      <div class="faint" style="font-size:var(--fs-sm)">Paste a bot's master prompt (from Grok Bot, ChatGPT or Claude), or open the file. Euclidean reads its name, job and rules, and it gets the live web, the Data tab and the other bots. Lists inside the prompt go to the Data tab.</div>
      <textarea class="input" style="height:260px;font-family:var(--mono, monospace);font-size:var(--fs-xs)" placeholder="# NAME MASTER PROMPT ..." value=${prompt} onInput=${(e) => setPrompt(e.target.value)} />
      <input type="file" accept=".md,.txt" ref=${fileIn} style="display:none" onChange=${async (e) => { const f = e.target.files[0]; if (f) setPrompt(await f.text()); e.target.value = ''; }} />
      <div class="row" style="gap:8px"><${Button} kind="ghost" icon="upload" onClick=${() => fileIn.current.click()}>Open a file</${Button}><span class="grow" />
        <${Button} kind="primary" busy=${busy} disabled=${prompt.trim().length < 40} onClick=${async () => { if (!start.fromData && /=====\s*BEGIN/.test(prompt)) { try { await api.post('/api/data', { files: [{ name: 'Master prompt', text: prompt }] }); } catch { /* the bot still gets made */ } } make({ masterPrompt: prompt }); }}>Make the bot</${Button}></div></div>`}
  </${Modal}>`;
}
