// Settings: general, connections (credentials), AI, messaging, production, team & tokens, backups, appearance.
import { html, useRoute, useState, useEffect, useStore, useApi, navigate, store, Button, Seg, Tabs, Toggle, Field, Loading, Avatar, Modal, act, toast, confirmDialog } from '../lib/ui.js';
import { api } from '../lib/api.js';
import { Icon } from '../lib/icons.js';
import { setSound, soundOn } from '../lib/sound.js';
import { ago } from '../lib/format.js';
import { AgentConnections } from './agents.js';

export function Settings() {
  const route = useRoute();
  const boot = useStore((s) => s.boot);
  const [tab, setTab] = useState(route.query.tab || (route.path.split('/')[2]) || 'general');
  useEffect(() => { const t = route.query.tab || route.path.split('/')[2]; if (t) setTab(t); }, [route.query.tab, route.path]);
  const isOwner = boot.user.role === 'owner';
  const tabs = [{ value: 'general', label: 'General' }, ...(isOwner ? [{ value: 'connections', label: 'Connections' }, { value: 'ai', label: 'AI' }, { value: 'messaging', label: 'Messaging' }, { value: 'production', label: 'Production' }, { value: 'team', label: 'Team & agents' }, { value: 'agents', label: 'Agent Connections' }, { value: 'backups', label: 'Backups' }] : []), { value: 'appearance', label: 'Appearance' }];
  return html`<div class="page"><div class="page-head"><div class="grow"><h1>Settings</h1><div class="sub">Data folder: <span class="mono selectable">${boot.dataDir}</span></div></div></div>
    <${Tabs} value=${tab} onChange=${setTab} tabs=${tabs} />
    <div style=${{ maxWidth: tab === 'agents' ? '1400px' : '980px' }}>${(() => { const Tab = { general: General, connections: Connections, ai: AI, messaging: Messaging, production: Production, team: Team, agents: AgentConnections, backups: Backups, appearance: Appearance }[tab]; return Tab ? html`<${Tab} key=${tab} />` : null; })()}</div></div>`;
}

function useSettings() {
  const boot = useStore((s) => s.boot);
  const [s, setS] = useState(() => JSON.parse(JSON.stringify(boot.settings)));
  const save = (patch, ok = 'Settings saved') => act(() => api.patch('/api/settings', patch), { ok }).then((x) => { store.set((st) => ({ boot: { ...st.boot, settings: x } })); setS(JSON.parse(JSON.stringify(x))); });
  return [s, setS, save, boot];
}
const Section = ({ title, sub, children, action }) => html`<div class="panel pad col" style="gap:14px;margin-bottom:14px"><div class="row"><div class="grow"><h3>${title}</h3>${sub ? html`<div class="muted" style="font-size:var(--fs-sm);margin-top:2px">${sub}</div>` : null}</div>${action}</div>${children}</div>`;

/** Use Euclidean on an iPhone: a home-screen app that connects to this computer over Wi-Fi. */
function PhoneSetup() {
  const { data: ph, reload } = useApi('/api/phone', ['settings']);
  const [, , save] = useSettings();
  if (!ph) return null;
  const step = (n, t) => html`<div class="row" style="gap:10px;align-items:flex-start"><span class="badge teal" style="flex:none">${n}</span><span style="font-size:var(--fs-sm)">${t}</span></div>`;
  const restart = () => act(() => api.post('/api/system/restart'), { ok: 'Restarting Euclidean…' });
  return html`<${Section} title="Use on your iPhone" sub="Euclidean keeps running on this computer; your phone opens it full-screen from a home-screen icon, like an app. No App Store or jailbreak needed.">
    ${!ph.lanOn && !ph.publicUrl ? html`<div class="col" style="gap:8px"><div class="notice"><${Icon} name="phone" size=${16} />Phone access is off. Turning it on lets devices on your Wi-Fi reach Euclidean (each one still needs your private link).</div>
        <div><${Button} kind="primary" icon="phone" onClick=${async () => { await save({ server: { lan: true } }, 'Phone access turned on'); if (ph.canRestart) await restart(); else reload(); }}>Turn on phone access${ph.canRestart ? ' and restart' : ''}</${Button}></div>
        <div class="faint" style="font-size:var(--fs-xs)">If Windows asks whether Euclidean may use your network, choose Allow on private networks.</div></div>`
    : !ph.lanActive && !ph.publicUrl ? html`<div class="row" style="gap:10px"><div class="notice gold grow"><${Icon} name="info" size=${16} />Phone access is on but needs a restart to start.</div>${ph.canRestart ? html`<${Button} kind="primary" icon="refresh" onClick=${restart}>Restart Euclidean</${Button}>` : null}</div>`
    : !ph.url ? html`<div><${Button} kind="primary" icon="phone" onClick=${() => act(() => api.post('/api/phone/link'), { ok: 'Phone link ready' }).then(reload)}>Create my phone link</${Button}></div>`
    : html`<div class="row wrap" style="gap:22px;align-items:flex-start">
        <div style="width:210px;height:210px;background:#fff;border-radius:12px;padding:8px;box-shadow:var(--shadow-1)" dangerouslySetInnerHTML=${{ __html: ph.qr }} aria-label="QR code with your phone link" />
        <div class="col grow" style="gap:10px;min-width:240px">
          ${step(1, 'Make sure your iPhone is on the same Wi-Fi as this computer.')}
          ${step(2, 'Open the iPhone Camera and point it at the code. Tap the link that appears; Euclidean opens in Safari.')}
          ${step(3, html`In Safari tap <b>Share</b> (the square with an arrow), then <b>Add to Home Screen</b>, then <b>Add</b>.`)}
          ${step(4, 'Open Euclidean from its new home-screen icon. It runs full-screen and stays signed in.')}
          <div class="row" style="gap:6px"><input class="input mono grow" readonly value=${ph.url} onFocus=${(e) => e.target.select()} aria-label="Phone link" /><${Button} size="sm" kind="ghost" onClick=${() => { navigator.clipboard?.writeText(ph.url).then(() => toast('Link copied', { kind: 'ok' })).catch(() => toast('Select the link and copy it', { kind: 'info' })); }}>Copy</${Button}></div>
          <div class="faint" style="font-size:var(--fs-xs)">This link signs your phone in, so keep it private. ${ph.publicUrl ? 'It works anywhere because a public address is set.' : 'It works on your home or office Wi-Fi. To use it anywhere, expose Euclidean with Cloudflare Tunnel and enter that address as the Public URL under Network below.'} The computer must be on with Euclidean running.</div>
          <div><${Button} size="sm" kind="coral" onClick=${async () => { if (await confirmDialog({ title: 'Disconnect your phone?', text: 'The home-screen app stops working until you create a new link.', confirm: 'Disconnect' })) act(() => api.post('/api/phone/unlink'), { ok: 'Phone disconnected' }).then(reload); }}>Disconnect phone</${Button}></div>
        </div></div>`}
  </${Section}>`;
}

function General() {
  const [s, setS, save] = useSettings();
  const a = s.agency;
  const setF = (i, k, v) => { const f = a.founders.slice(); f[i] = { ...f[i], [k]: v }; setS({ ...s, agency: { ...a, founders: f } }); };
  const own = a.founders.reduce((t, f) => t + Number(f.ownershipPct || 0), 0), dist = a.founders.reduce((t, f) => t + Number(f.distributionPct || 0), 0);
  const boot = useStore((st) => st.boot);
  return html`
    ${boot.user.role === 'owner' && window.euclidean ? html`<${PhoneSetup} />` : null}
    <${Section} title="Environment" sub="Rehearse safely before anything reaches real clients or audiences.">
      <${Seg} value=${s.environment} onChange=${(v) => setS({ ...s, environment: v })} options=${[{ value: 'test', label: 'Test' }, { value: 'production', label: 'Production' }]} />
      ${s.environment === 'test' ? html`<div class="notice gold"><${Icon} name="info" size=${16} />Test: every outgoing text and email is redirected to the sandbox recipient below with the real recipient in the first line. Publishing writes Manual Packs only; nothing is posted.</div>` : html`<div class="notice coral"><${Icon} name="alert" size=${16} />Production: messages reach real people and approved posts publish to connected accounts.</div>`}
      <div class="form-grid"><${Field} label="Sandbox phone (your own)" id="g-sbp"><input id="g-sbp" class="input" value=${s.sandbox.phone} onInput=${(e) => setS({ ...s, sandbox: { ...s.sandbox, phone: e.target.value } })} placeholder="+12035550142" /></${Field}>
        <${Field} label="Sandbox email (your own)" id="g-sbe"><input id="g-sbe" class="input" value=${s.sandbox.email} onInput=${(e) => setS({ ...s, sandbox: { ...s.sandbox, email: e.target.value } })} /></${Field}></div>
      <div><${Button} kind=${s.environment === 'production' ? 'coral' : 'primary'} onClick=${async () => { if (s.environment === 'production' && !(await confirmDialog({ title: 'Switch to production?', text: 'Messages will reach real contacts and approved posts will publish publicly.', confirm: 'Switch to production' }))) return; save({ environment: s.environment, sandbox: s.sandbox }); }}>Save environment</${Button}></div>
    </${Section}>
    <${Section} title="Agency" sub="Ownership is equity. Distribution share is how each period's distributable profit is split; they can differ.">
      <div class="form-grid"><${Field} label="Agency name" id="g-name"><input id="g-name" class="input" value=${a.name} onInput=${(e) => setS({ ...s, agency: { ...a, name: e.target.value } })} /></${Field}>
        <${Field} label="Timezone" id="g-tz"><input id="g-tz" class="input" value=${a.timezone} onInput=${(e) => setS({ ...s, agency: { ...a, timezone: e.target.value } })} /></${Field}>
        <${Field} label="Tax reserve %" id="g-tax"><input id="g-tax" class="input tnum" type="number" value=${a.taxReservePct} onInput=${(e) => setS({ ...s, agency: { ...a, taxReservePct: Number(e.target.value) } })} /></${Field}>
        <${Field} label="Retained in business %" id="g-ret"><input id="g-ret" class="input tnum" type="number" value=${a.retainedEarningsPct} onInput=${(e) => setS({ ...s, agency: { ...a, retainedEarningsPct: Number(e.target.value) } })} /></${Field}></div>
      <div class="table-wrap"><table class="table"><thead><tr><th>Founder</th><th class="num">Ownership %</th><th class="num">Distribution %</th></tr></thead><tbody>${a.founders.map((f, i) => html`<tr><td><div class="row"><${Avatar} name=${f.name} size="sm" /><input class="input sm" value=${f.name} onInput=${(e) => setF(i, 'name', e.target.value)} aria-label="Founder name" /></div></td><td class="num"><input class="input sm tnum" style="width:80px;text-align:right" type="number" value=${f.ownershipPct} onInput=${(e) => setF(i, 'ownershipPct', Number(e.target.value))} aria-label="Ownership" /></td><td class="num"><input class="input sm tnum" style="width:80px;text-align:right" type="number" value=${f.distributionPct} onInput=${(e) => setF(i, 'distributionPct', Number(e.target.value))} aria-label="Distribution" /></td></tr>`)}
        <tr><td class="faint">Total</td><td class="num" style=${{ color: own === 100 ? 'inherit' : 'var(--coral-ink)' }}>${own}%</td><td class="num" style=${{ color: dist === 100 ? 'inherit' : 'var(--coral-ink)' }}>${dist}%</td></tr></tbody></table></div>
      <div><${Button} kind="primary" disabled=${own !== 100 || dist !== 100} onClick=${() => save({ agency: s.agency })}>Save agency</${Button}></div>
    </${Section}>
    <${Section} title="Network" sub="Needed for the client portal, worker machines and Astra on another computer. Restart Euclidean after changing.">
      <div class="check-row"><${Toggle} on=${s.server.lan} label="LAN access" onChange=${(v) => setS({ ...s, server: { ...s.server, lan: v } })} /><span>Allow other computers on this network (worker desktop, Astra, portal on your Wi-Fi)</span></div>
      <div class="form-grid"><${Field} label="Port" id="g-port"><input id="g-port" class="input tnum" type="number" value=${s.server.port} onInput=${(e) => setS({ ...s, server: { ...s.server, port: Number(e.target.value) } })} /></${Field}>
        <${Field} label="Public URL (optional)" hint="If you expose the engine with Cloudflare Tunnel or similar, portal links and the Twilio webhook use this." id="g-pub"><input id="g-pub" class="input" value=${s.server.publicUrl || ''} onInput=${(e) => setS({ ...s, server: { ...s.server, publicUrl: e.target.value } })} placeholder="https://euclidean.example.com" /></${Field}></div>
      <div><${Button} kind="primary" onClick=${() => save({ server: s.server }, 'Saved. Restart Euclidean to apply network changes.')}>Save network</${Button}></div>
    </${Section}>`;
}

function SecretInput({ k, label, status, value, onChange, type = 'password', placeholder }) {
  return html`<${Field} label=${html`${label} ${status?.[k] ? html`<span class="badge moss" style="margin-left:4px">Saved</span>` : null}`} id=${k}><input id=${k} class="input" type=${type} placeholder=${status?.[k] ? '•••••••• (saved; type to replace)' : placeholder || ''} value=${value[k] || ''} onInput=${(e) => onChange({ ...value, [k]: e.target.value })} autocomplete="off" /></${Field}>`;
}

/** Clone your voice, hear it, and switch on voice notes and the callback assistant. */
function VoiceSetup() {
  const { data: vs, reload } = useApi('/api/voice', ['settings', 'notify']);
  const [rec, setRec] = useState(null); const [busy, setBusy] = useState(''); const [ok, setOk] = useState(false); const [secs, setSecs] = useState(0);
  const [audio, setAudio] = useState(null);
  const upload = async (blob) => {
    setBusy('Cloning your voice (about a minute)…');
    try {
      const res = await fetch(api.url('/api/voice/clone'), { method: 'POST', headers: { 'content-type': blob.type || 'audio/webm' }, body: blob });
      const j = await res.json().catch(() => ({})); if (!res.ok) throw new Error(j.error || `Failed (${res.status})`);
      toast('Your voice is ready', { kind: 'ok' }); reload();
    } catch (e) { toast(e.message, { kind: 'error' }); }
    setBusy('');
  };
  const start = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream); const chunks = []; const t0 = Date.now(); const iv = setInterval(() => setSecs(Math.round((Date.now() - t0) / 1000)), 500);
      mr.ondataavailable = (e) => chunks.push(e.data);
      mr.onstop = () => { clearInterval(iv); stream.getTracks().forEach((t) => t.stop()); upload(new Blob(chunks, { type: mr.mimeType || 'audio/webm' })); };
      mr.start(); setRec(mr); setSecs(0);
    } catch { toast('Microphone not available. Upload a recording instead.', { kind: 'warn' }); }
  };
  const pick = (e) => { const f = e.target.files?.[0]; if (f) upload(f); e.target.value = ''; };
  const preview = () => act(async () => { await api.post('/api/voice/preview', {}); setAudio(api.url('/api/voice/preview.mp3') + `&t=${Date.now()}`); }, { ok: 'Here it is' });
  const flipNote = (on) => act(() => api.patch('/api/settings', { voice: { autoVoiceNote: on } }), { ok: on ? 'Voice notes on' : 'Voice notes off' }).then(reload);
  const flipCalls = (on) => act(() => api.post('/api/voice/callbacks', { on }), { ok: on ? 'Your callback assistant is answering your Twilio number' : 'Callback assistant off' }).then(reload);
  if (!vs) return html`<${Loading} />`;
  if (busy) return html`<div class="faint"><span class="spinner" /> ${busy}</div>`;
  return html`<div class="col" style="gap:10px">
    ${!vs.cloned ? html`<div class="panel pad col" style="gap:8px;background:var(--surface-2)">
      <b>Clone your voice</b>
      <div class="faint" style="font-size:var(--fs-sm)">Talk naturally for one to two minutes in a quiet room (read an old email out loud, or talk about what Euclidean does). Only clone your own voice.</div>
      <label class="row" style="gap:8px"><input type="checkbox" checked=${ok} onChange=${(e) => setOk(e.target.checked)} /><span>This is my own voice and I agree to it being cloned for Euclidean outreach.</span></label>
      ${rec ? html`<${Button} kind="coral" icon="stop" onClick=${() => { rec.stop(); setRec(null); }}>Stop and clone (${secs}s)</${Button}>` : html`<div class="row" style="gap:6px"><${Button} kind="primary" icon="mic" disabled=${!ok} onClick=${start}>Record now</${Button}><label class=${'btn ghost' + (ok ? '' : ' disabled')} style="cursor:pointer">Upload a recording<input type="file" accept="audio/*,video/*" style="display:none" disabled=${!ok} onChange=${pick} /></label></div>`}
    </div>` : html`<div class="row wrap" style="gap:8px"><span class="badge moss">Voice cloned${vs.clonedAt ? ` ${ago(vs.clonedAt)}` : ''}</span><${Button} size="sm" kind="ghost" icon="play" onClick=${preview}>Hear it</${Button}>${audio ? html`<audio src=${audio} controls autoplay />` : null}</div>
    <label class="row" style="gap:8px"><${Toggle} on=${vs.autoVoiceNote} onChange=${flipNote} label="Voice notes" /><span>Attach a short voice note in my voice to every new outreach email (you can still change or remove it in the review queue)</span></label>
    <label class="row" style="gap:8px;align-items:flex-start"><${Toggle} on=${vs.callbacks} onChange=${flipCalls} label="Callbacks" /><span>Answer my Twilio number with an AI assistant in my voice. It says it's an AI assistant, answers simple questions about our offers and takes a message. It only answers incoming calls; it never calls anyone.</span></label>
    ${vs.calls?.length ? html`<div class="col" style="gap:6px"><b>Recent callbacks</b>${vs.calls.map((c) => html`<div class="panel pad" style="padding:8px 12px"><div class="row" style="gap:8px"><b>${c.name || c.from || 'Caller'}</b><span class="faint" style="font-size:var(--fs-xs)">${ago(c.at)} · ${Math.round(c.seconds / 60 * 10) / 10} min</span>${c.prospectId ? html`<span class="badge sky">Lead moved to Replied</span>` : null}</div><div style="font-size:var(--fs-sm)">${c.summary || 'Message taken.'}</div></div>`)}</div>` : null}
    <div class="row"><${Button} size="sm" kind="ghost" onClick=${() => act(() => api.patch('/api/settings', { voice: { voiceId: '', callbacks: false } }), { ok: 'Removed. Record again to re-clone.' }).then(() => (vs.callbacks ? flipCalls(false) : reload()))}>Re-record my voice</${Button}></div>`}
  </div>`;
}

function Connections() {
  const boot = useStore((s) => s.boot);
  const { data: st, reload } = useApi('/api/secrets/status', ['connections']);
  const [v, setV] = useState({});
  const status = st?.secrets || {};
  const saveKeys = (keys, test) => act(async () => { const body = Object.fromEntries(keys.filter((k) => v[k]).map((k) => [k, v[k]])); if (!Object.keys(body).length) throw new Error('Enter a value first'); await api.post('/api/secrets', body); setV((x) => { const y = { ...x }; keys.forEach((k) => delete y[k]); return y; }); reload(); if (test) { const r = await api.post(`/api/connections/test/${test}`); if (!r.ok) throw new Error(r.error); return r; } }, { ok: 'Saved and verified' });
  const test = (name) => act(() => api.post(`/api/connections/test/${name}`).then((r) => { if (!r.ok) throw new Error(r.error); return r; }), { ok: 'Connection works' });
  const ep = boot.emailPresets;
  const preset = (name) => setV({ ...v, 'global.email.smtpHost': ep[name].smtpHost, 'global.email.smtpPort': ep[name].smtpPort, 'global.email.imapHost': ep[name].imapHost, 'global.email.imapPort': ep[name].imapPort });
  const row = (label, ok) => html`<span class=${'badge ' + (ok ? 'moss' : '')}>${ok ? 'Connected' : 'Not connected'}</span>`;
  return html`
    <div class="notice" style="margin-bottom:14px"><${Icon} name="lock" size=${16} />Credentials are encrypted on this computer (sealed with Windows DPAPI in the desktop app) and are never shown again or sent anywhere except the service they belong to.</div>
    <${LocalAI} st=${st} test=${test} />
    <${Section} title="AI providers" sub="Claude, GPT and Grok. Each role in System → Agents picks one, with fallbacks." action=${html`${row('', st?.ai?.anthropic || st?.ai?.openai || st?.ai?.xai)}`}>
      <div class="form-grid">${[['global.anthropic.apiKey', 'Anthropic (Claude) API key', 'anthropic'], ['global.openai.apiKey', 'OpenAI (GPT + Whisper) API key', 'openai'], ['global.xai.apiKey', 'xAI (Grok) API key', 'xai']].map(([k, l, p]) => html`<div class="col" style="gap:6px"><${SecretInput} k=${k} label=${l} status=${status} value=${v} onChange=${setV} /><div class="row"><${Button} size="sm" kind="soft" onClick=${() => saveKeys([k], p)}>Save & test</${Button}>${status[k] ? html`<${Button} size="sm" kind="ghost" onClick=${() => test(p)}>Test</${Button}>` : null}</div></div>`)}</div>
    </${Section}>
    <${Section} title="Text messages (Twilio)" sub="Two-way SMS. Inbound texts are polled every 20 seconds, so no public URL is needed. US business texting requires A2P 10DLC registration in Twilio." action=${row('', st?.twilio)}>
      <div class="form-grid">${[['global.twilio.accountSid', 'Account SID', 'text'], ['global.twilio.authToken', 'Auth token', 'password'], ['global.twilio.fromNumber', 'From number', 'text'], ['global.twilio.messagingServiceSid', 'Messaging service SID (optional)', 'text']].map(([k, l, t]) => html`<${SecretInput} k=${k} label=${l} type=${t} status=${status} value=${v} onChange=${setV} />`)}</div>
      <div class="row"><${Button} kind="primary" onClick=${() => saveKeys(['global.twilio.accountSid', 'global.twilio.authToken', 'global.twilio.fromNumber', 'global.twilio.messagingServiceSid'], 'twilio')}>Save & test</${Button}>${st?.twilio ? html`<${Button} kind="ghost" onClick=${() => test('twilio')}>Test</${Button}>` : null}</div>
    </${Section}>
    <${Section} title="Your voice (ElevenLabs)" sub="Clone your own voice once. Then Euclidean can attach a voice note in your voice to outreach emails, and an AI assistant in your voice can answer people who call your Twilio number back. It never places calls itself." action=${row('', st?.secrets?.['global.elevenlabs.apiKey'])}>
      <div class="form-grid"><${SecretInput} k="global.elevenlabs.apiKey" label="ElevenLabs API key (elevenlabs.io → Profile → API keys)" status=${status} value=${v} onChange=${setV} /></div>
      <div class="row"><${Button} kind="primary" onClick=${() => saveKeys(['global.elevenlabs.apiKey'], 'elevenlabs')}>Save & test</${Button}></div>
      ${status['global.elevenlabs.apiKey'] ? html`<${VoiceSetup} />` : null}
    </${Section}>
    <${Section} title="Email" sub="Any mailbox with SMTP and IMAP. For Gmail or Google Workspace, turn on 2-step verification and create an app password." action=${row('', st?.email)}>
      <div class="row wrap"><span class="label">Presets</span>${Object.keys(ep).map((n) => html`<button class="chip" onClick=${() => preset(n)}>${n[0].toUpperCase() + n.slice(1)}</button>`)}</div>
      <div class="form-grid">${[['global.email.address', 'Email address', 'text'], ['global.email.displayName', 'Display name', 'text'], ['global.email.password', 'App password', 'password'], ['global.email.username', 'Username (if not the address)', 'text'], ['global.email.smtpHost', 'SMTP host', 'text'], ['global.email.smtpPort', 'SMTP port', 'text'], ['global.email.imapHost', 'IMAP host', 'text'], ['global.email.imapPort', 'IMAP port', 'text']].map(([k, l, t]) => html`<${SecretInput} k=${k} label=${l} type=${t} status=${status} value=${v} onChange=${setV} />`)}</div>
      <div class="row"><${Button} kind="primary" onClick=${() => saveKeys(Object.keys(v).filter((k) => k.startsWith('global.email.')), 'email')}>Save & test</${Button}>${st?.email ? html`<${Button} kind="ghost" onClick=${() => test('email')}>Test</${Button}>` : null}</div>
    </${Section}>
    <${Section} title="Crossposting (Ayrshare)" sub="One connection that posts to TikTok, Instagram Reels, YouTube Shorts, Facebook Reels, X, Threads and LinkedIn. Each client links their accounts to their own Ayrshare profile." action=${row('', st?.ayrshare)}>
      <div class="form-grid"><${SecretInput} k="global.ayrshare.apiKey" label="Ayrshare API key" status=${status} value=${v} onChange=${setV} /></div>
      <div class="row"><${Button} kind="primary" onClick=${() => saveKeys(['global.ayrshare.apiKey'], 'ayrshare')}>Save & test</${Button}></div>
    </${Section}>
    <${Section} title="Political research data" sub="Free keys that make political packages more complete. Open States covers every state legislator; api.data.gov unlocks Congress.gov and FEC fundraising at full speed. Both are optional.">
      <div class="form-grid"><${SecretInput} k="global.political.openStatesKey" label="Open States API key (open.pluralpolicy.com)" status=${status} value=${v} onChange=${setV} /><${SecretInput} k="global.political.dataGovKey" label="api.data.gov key (api.data.gov/signup)" status=${status} value=${v} onChange=${setV} /><${SecretInput} k="global.removebg.apiKey" label="remove.bg key (photo cut-outs, optional)" status=${status} value=${v} onChange=${setV} /><${SecretInput} k="global.pexels.apiKey" label="Pexels key (more background photos, free, optional)" status=${status} value=${v} onChange=${setV} /></div>
      <div class="faint" style="font-size:var(--fs-xs)">No remove.bg key? Use the free cut-out tool instead: Agent Connections → setup checklist → Photo background removal → Install free tool.</div>
      <div class="row"><${Button} kind="primary" onClick=${() => saveKeys(['global.political.openStatesKey', 'global.political.dataGovKey', 'global.removebg.apiKey', 'global.pexels.apiKey'])}>Save</${Button}></div>
    </${Section}>
    <${Section} title="YouTube direct upload (Google)" sub="Optional. Create an OAuth client of type Desktop app in Google Cloud Console with the YouTube Data API enabled." action=${row('', st?.google)}>
      <div class="form-grid"><${SecretInput} k="global.google.clientId" label="OAuth client ID" type="text" status=${status} value=${v} onChange=${setV} /><${SecretInput} k="global.google.clientSecret" label="OAuth client secret" status=${status} value=${v} onChange=${setV} /></div>
      <div class="row"><${Button} kind="primary" onClick=${() => saveKeys(['global.google.clientId', 'global.google.clientSecret'])}>Save</${Button}><span class="faint" style="font-size:var(--fs-sm)">Then connect each client's channel from their Billing & accounts tab.</span></div>
    </${Section}>`;
}

function AI() {
  const [s, setS, save] = useSettings();
  const ai = s.ai;
  return html`
    <${Section} title="Monthly budgets" sub="When a provider reaches its budget, its work moves to the fallback provider. 0 means no limit.">
      <div class="form-grid">${[['anthropic', 'Claude'], ['openai', 'GPT'], ['xai', 'Grok']].map(([k, l]) => html`<${Field} label=${`${l} (USD)`} id=${'b-' + k}><input id=${'b-' + k} class="input tnum" type="number" value=${ai.budgetsUsd[k]} onInput=${(e) => setS({ ...s, ai: { ...ai, budgetsUsd: { ...ai.budgetsUsd, [k]: Number(e.target.value) } } })} /></${Field}>`)}</div>
      <div><${Button} kind="primary" onClick=${() => save({ ai: { budgetsUsd: ai.budgetsUsd } })}>Save budgets</${Button}></div>
    </${Section}>
    <${Section} title="Transcription" sub="Word-level timestamps power captions and jump cuts. OpenAI Whisper costs about $0.36 per hour of footage; whisper.cpp runs free on your own computer (uses CPU/GPU).">
      <${Seg} value=${ai.transcription.localWhisperPath ? 'local' : 'openai'} onChange=${(m) => setS({ ...s, ai: { ...ai, transcription: { ...ai.transcription, localWhisperPath: m === 'local' ? (ai.transcription.localWhisperPath || 'C:\\whisper\\whisper-cli.exe') : '' } } })} options=${[{ value: 'openai', label: 'OpenAI Whisper' }, { value: 'local', label: 'whisper.cpp (local)' }]} />
      ${ai.transcription.localWhisperPath ? html`<div class="form-grid"><${Field} label="whisper-cli executable" id="w-bin"><input id="w-bin" class="input mono" value=${ai.transcription.localWhisperPath} onInput=${(e) => setS({ ...s, ai: { ...ai, transcription: { ...ai.transcription, localWhisperPath: e.target.value } } })} /></${Field}><${Field} label="Model file (ggml-*.bin)" id="w-model"><input id="w-model" class="input mono" value=${ai.transcription.localWhisperModel} onInput=${(e) => setS({ ...s, ai: { ...ai, transcription: { ...ai.transcription, localWhisperModel: e.target.value } } })} placeholder="C:\\whisper\\models\\ggml-small.en.bin" /></${Field}></div>` : html`<${Field} label="Model" id="w-om"><input id="w-om" class="input mono" style="max-width:240px" value=${ai.transcription.model} onInput=${(e) => setS({ ...s, ai: { ...ai, transcription: { ...ai.transcription, model: e.target.value } } })} /></${Field}>`}
      <div><${Button} kind="primary" onClick=${() => save({ ai: { transcription: ai.transcription } })}>Save transcription</${Button}></div>
    </${Section}>
    <${Section} title="Cost estimates" sub="USD per million tokens, used only for the cost figures in Finance and Agents. Adjust to your providers' current prices.">
      <div class="form-grid">${Object.entries(ai.prices).map(([p, t]) => html`<${Field} label=${`${{ anthropic: 'Claude', openai: 'GPT', xai: 'Grok' }[p]} input / output`} id=${'pr-' + p}><div class="row"><input id=${'pr-' + p} class="input tnum" type="number" step="0.01" value=${t.default[0]} onInput=${(e) => setS({ ...s, ai: { ...ai, prices: { ...ai.prices, [p]: { ...t, default: [Number(e.target.value), t.default[1]] } } } })} /><input class="input tnum" type="number" step="0.01" value=${t.default[1]} onInput=${(e) => setS({ ...s, ai: { ...ai, prices: { ...ai.prices, [p]: { ...t, default: [t.default[0], Number(e.target.value)] } } } })} aria-label="Output price" /></div></${Field}>`)}</div>
      <div><${Button} kind="primary" onClick=${() => save({ ai: { prices: ai.prices } })}>Save prices</${Button}></div>
    </${Section}>`;
}

function Messaging() {
  const [s, setS, save] = useSettings();
  const m = s.messaging;
  const set = (k, v) => setS({ ...s, messaging: { ...m, [k]: v } });
  const CATS = [['prospecting', 'First-touch prospecting'], ['pricing', 'Pricing and money'], ['commitment', 'Commitments and promises'], ['complaint', 'Complaints'], ['contract', 'Contracts and scope'], ['sensitive', 'Sensitive topics'], ['unknown_contact', 'Unknown contacts']];
  return html`
    <${Section} title="Automatic replies" sub="Routine updates to existing clients (acknowledgements, 'your videos are ready') can send without you. Everything else waits in Approvals.">
      <div class="check-row"><${Toggle} on=${m.autoSendRoutine} label="Auto-send routine" onChange=${(v) => set('autoSendRoutine', v)} /><span>Send routine AI replies to existing clients automatically</span></div>
      <div class="field"><span class="label">Always wait for a founder</span><div class="chips">${CATS.map(([k, l]) => html`<button class=${'chip' + (m.approvalRequired.includes(k) ? ' on' : '')} disabled=${k === 'prospecting'} onClick=${() => set('approvalRequired', m.approvalRequired.includes(k) ? m.approvalRequired.filter((x) => x !== k) : [...m.approvalRequired, k])}>${m.approvalRequired.includes(k) ? html`<${Icon} name="check" size=${13} />` : null}${l}</button>`)}</div><div class="hint">First-touch prospecting can't be turned off: Euclidean never sends unsolicited outreach without a person.</div></div>
    </${Section}>
    <${Section} title="Delivery">
      <div class="check-row"><${Toggle} on=${m.quietHours.enabled} label="Quiet hours" onChange=${(v) => set('quietHours', { ...m.quietHours, enabled: v })} /><span>Hold messages overnight</span>
        <input class="input tnum" style="width:70px" type="number" min="0" max="23" value=${m.quietHours.start} onInput=${(e) => set('quietHours', { ...m.quietHours, start: Number(e.target.value) })} aria-label="Quiet start hour" /><span class="faint">to</span><input class="input tnum" style="width:70px" type="number" min="0" max="23" value=${m.quietHours.end} onInput=${(e) => set('quietHours', { ...m.quietHours, end: Number(e.target.value) })} aria-label="Quiet end hour" /></div>
      <div class="form-grid"><${Field} label="Max outgoing messages per hour" id="m-cap"><input id="m-cap" class="input tnum" type="number" value=${m.maxOutboundPerHour} onInput=${(e) => set('maxOutboundPerHour', Number(e.target.value))} /></${Field}>
        <${Field} label="Check texts every (seconds)" id="m-sms"><input id="m-sms" class="input tnum" type="number" min="10" value=${m.smsPollSeconds} onInput=${(e) => set('smsPollSeconds', Number(e.target.value))} /></${Field}>
        <${Field} label="Check email every (seconds)" id="m-em"><input id="m-em" class="input tnum" type="number" min="20" value=${m.emailPollSeconds} onInput=${(e) => set('emailPollSeconds', Number(e.target.value))} /></${Field}></div>
      <${Field} label="Email signature" id="m-sig"><textarea id="m-sig" class="textarea" rows="2" value=${m.signature} onInput=${(e) => set('signature', e.target.value)} /></${Field}>
      <div><${Button} kind="primary" onClick=${() => save({ messaging: m })}>Save messaging</${Button}></div>
    </${Section}>`;
}

function Production() {
  const [s, setS, save, boot] = useSettings();
  const p = s.production; const tools = s.tools || {};
  const set = (k, v) => setS({ ...s, production: { ...p, [k]: v } });
  const setT = (k, v) => setS({ ...s, tools: { ...tools, [k]: v } });
  const caps = boot.capabilities;
  return html`
    <${Section} title="Shorts">
      <div class="form-grid">
        <${Field} label="Clip length (seconds)" id="p-min"><div class="row"><input id="p-min" class="input tnum" type="number" value=${p.minClipSec} onInput=${(e) => set('minClipSec', Number(e.target.value))} /><span class="faint">to</span><input class="input tnum" type="number" value=${p.maxClipSec} onInput=${(e) => set('maxClipSec', Number(e.target.value))} aria-label="Maximum clip length" /></div></${Field}>
        <${Field} label="Clips per footage (default)" id="p-n"><input id="p-n" class="input tnum" type="number" value=${p.defaultClipCount} onInput=${(e) => set('defaultClipCount', Number(e.target.value))} /></${Field}>
        <${Field} label="Loudness target (LUFS)" id="p-l"><input id="p-l" class="input tnum" type="number" value=${p.loudnessLufs} onInput=${(e) => set('loudnessLufs', Number(e.target.value))} /></${Field}>
        <${Field} label="Quality (CRF, lower is better)" id="p-crf"><input id="p-crf" class="input tnum" type="number" min="14" max="30" value=${p.crf} onInput=${(e) => set('crf', Number(e.target.value))} /></${Field}>
        <${Field} label="Encoder" hint=${`Available here: ${(caps.encoders || []).join(', ') || 'none'}`} id="p-enc"><select id="p-enc" class="select" value=${p.encoder} onChange=${(e) => set('encoder', e.target.value)}><option value="auto">Automatic (GPU when available)</option>${['libx264', 'h264_nvenc', 'h264_qsv', 'h264_amf'].map((x) => html`<option value=${x} disabled=${!(caps.encoders || []).includes(x)}>${x}</option>`)}</select></${Field}>
      </div>
      <div class="check-row"><${Toggle} on=${p.preferPremiere} label="Premiere" onChange=${(v) => set('preferPremiere', v)} /><span>Send every edit to Adobe Premiere through Astra instead of the built-in renderer</span></div>
      <div><${Button} kind="primary" onClick=${() => save({ production: p })}>Save</${Button}></div>
    </${Section}>
    <${Section} title="Tools" sub="Leave blank to use the versions on your PATH." action=${html`<${Button} size="sm" kind="ghost" icon="refresh" onClick=${() => act(() => api.post('/api/system/redetect'), { ok: 'Tools re-detected' }).then((c) => store.set((st) => ({ boot: { ...st.boot, capabilities: c } })))}>Re-detect</${Button}>`}>
      <div class="col" style="gap:6px">${[['FFmpeg', caps.ffmpeg, caps.ffmpegVersion], ['Caption burn-in (libass)', caps.libass], ['yt-dlp', caps.ytdlp, caps.ytdlpVersion], ['Local whisper.cpp', caps.whisper]].map(([l, ok, ver]) => html`<div class="row"><span class=${'led ' + (ok ? 'ok' : 'warn')} /><span class="grow">${l}</span><span class="faint mono">${ok ? ver || 'available' : 'not found'}</span></div>`)}</div>
      <div class="form-grid">${[['ffmpegPath', 'ffmpeg.exe path'], ['ffprobePath', 'ffprobe.exe path'], ['ytdlpPath', 'yt-dlp.exe path'], ['veloPath', 'Velo executable (for "Open in Velo")']].map(([k, l]) => html`<${Field} label=${l} id=${'t-' + k}><input id=${'t-' + k} class="input mono" value=${tools[k] || ''} onInput=${(e) => setT(k, e.target.value)} /></${Field}>`)}</div>
      <div><${Button} kind="primary" onClick=${() => save({ tools })}>Save tools</${Button}></div>
    </${Section}>`;
}

function Team() {
  const { data, reload } = useApi('/api/users', []);
  const [created, setCreated] = useState(null);
  const [f, setF] = useState({ name: '', role: 'agent' });
  const create = () => act(() => api.post('/api/users', f), { ok: 'Token created' }).then((u) => { setCreated(u); setF({ name: '', role: 'agent' }); reload(); });
  const engine = `http://${store.get().boot?.lan || 'THIS-PC'}:${store.get().boot?.settings?.server?.port || 4870}`;
  return html`
    <${Section} title="People and agents" sub="Each person, agent or worker machine gets its own token and role. Contractors can review and edit but can't see finance or credentials.">
      <div class="list panel">${(data || []).map((u) => html`<div class="list-row"><${Avatar} name=${u.name} size="sm" icon=${u.role === 'agent' ? 'robot' : u.role === 'worker' ? 'cpu' : null} /><b class="grow">${u.name}</b><span class="badge outline">${u.role}</span><span class="faint mono">…${u.tokenHint}</span>
        <${Button} size="sm" kind="ghost" icon="trash" title="Revoke" onClick=${async () => { if (await confirmDialog({ title: `Revoke ${u.name}?`, text: 'Their token stops working immediately.', confirm: 'Revoke' })) act(() => api.del(`/api/users/${u.id}`), { ok: 'Revoked' }).then(reload); }} /></div>`)}</div>
      <div class="row wrap"><input class="input" style="max-width:240px" placeholder="Name (e.g. Astra, Desktop 2, Maya)" value=${f.name} onInput=${(e) => setF({ ...f, name: e.target.value })} aria-label="Name" />
        <${Seg} value=${f.role} onChange=${(r) => setF({ ...f, role: r })} options=${[{ value: 'agent', label: 'Agent' }, { value: 'worker', label: 'Worker' }, { value: 'contractor', label: 'Contractor' }, { value: 'owner', label: 'Owner' }]} />
        <${Button} kind="primary" disabled=${!f.name} onClick=${create}>Create token</${Button}></div>
    </${Section}>
    <${Section} title="Connecting Astra (computer use)" sub="Astra drives Premiere Pro. Euclidean gives it a work order; Astra edits and exports; Euclidean takes over again for QC, approval and scheduling.">
      <pre class="panel mono selectable" style="padding:12px;font-size:11.5px;overflow:auto;margin:0;white-space:pre">GET  ${engine}/api/agent/next?capability=premiere      → { job: { brief, files[], source, range, outputPath, instructions } }
POST ${engine}/api/agent/jobs/:id/progress           { progress: 0.5, note: "Exporting" }
POST ${engine}/api/agent/jobs/:id/complete           { outputPath: "C:\\…\\output.mp4" }
POST ${engine}/api/agent/jobs/:id/fail               { error: "Premiere crashed" }
POST ${engine}/api/agent/command                     { text: "/clips stringer" }   ← any command in the list
GET  ${engine}/api/agent/commands                    → full command list
Header on every request:  Authorization: Bearer AGENT_TOKEN</pre>
    </${Section}>
    ${created ? html`<${Modal} title="Copy this token now" icon="key" onClose=${() => setCreated(null)} footer=${html`<${Button} kind="primary" onClick=${() => { navigator.clipboard?.writeText(created.token).then(() => toast('Copied', { kind: 'ok' })).catch(() => {}); }}>Copy</${Button}>`}>
      <p class="muted" style="margin-bottom:10px">It won't be shown again. ${created.role === 'worker' ? `On the worker machine run: npm run worker -- --engine ${engine} --token <token>` : created.role === 'agent' ? 'Give it to Astra (or any agent) as its bearer token.' : 'Open Euclidean in a browser with ?token=<token>.'}</p>
      <div class="panel mono selectable" style="padding:12px;overflow-wrap:anywhere">${created.token}</div></${Modal}>` : null}`;
}

function Backups() {
  const { data, reload } = useApi('/api/backups', []);
  return html`<${Section} title="Backups" sub="The database is backed up every night at 3am; the last 30 are kept. Restoring makes a fresh backup first." action=${html`<${Button} kind="soft" icon="download" onClick=${() => act(() => api.post('/api/backup'), { ok: 'Backup created' }).then(reload)}>Back up now</${Button}>`}>
    <div class="list panel">${(data || []).map((b) => html`<div class="list-row"><${Icon} name="archive" size=${16} /><span class="grow mono">${b.name}</span><span class="faint">${Math.round(b.size / 1024)} KB</span><${Button} size="sm" kind="ghost" onClick=${async () => { if (await confirmDialog({ title: 'Restore this backup?', text: `Everything returns to ${b.name}. A backup of the current state is made first.`, confirm: 'Restore' })) act(() => api.post('/api/restore', { name: b.name }), { ok: 'Restored. Reloading…' }).then(() => setTimeout(() => location.reload(), 800)); }}>Restore</${Button}></div>`)}
      ${!(data || []).length ? html`<div class="list-row faint">No backups yet.</div>` : null}</div></${Section}>`;
}

function Appearance() {
  const [theme, setTheme] = useState(() => { try { return localStorage.getItem('eu.theme') || 'light'; } catch { return 'light'; } });
  const [snd, setSnd] = useState(soundOn());
  const apply = (t) => { setTheme(t); try { localStorage.setItem('eu.theme', t); } catch { /* ignore */ } window.__applyTheme?.(t); window.euclidean?.setTheme?.(t); };
  return html`<${Section} title="Appearance">
    <div class="row"><span class="label" style="width:120px">Theme</span><${Seg} value=${theme} onChange=${apply} options=${[{ value: 'light', label: 'Light', icon: 'sun' }, { value: 'dark', label: 'Night', icon: 'moon' }, { value: 'system', label: 'Match system' }]} /></div>
    <div class="row"><span class="label" style="width:120px">Sounds</span><${Toggle} on=${snd} label="Sounds" onChange=${(v) => { setSound(v); setSnd(v); }} /><span class="muted" style="font-size:var(--fs-sm)">Soft clicks, send and receive tones</span></div>
    <div class="divider" /><div class="eyebrow">Keyboard</div>
    <div class="grid c2" style="font-size:var(--fs-sm)">${[['Ctrl K', 'Search and commands'], ['Ctrl 1–0', 'Switch module'], ['Ctrl ,', 'Settings'], ['/', 'Commands in any composer'], ['A / R / X', 'Approve, request changes, reject'], ['J / K', 'Next / previous in Approvals'], ['Space', 'Play / pause'], ['S', 'Split in Studio']].map(([k, d]) => html`<div class="row"><kbd>${k}</kbd><span class="muted">${d}</span></div>`)}</div>
  </${Section}>`;
}

/** Free AI on this computer (Ollama) and free web search, so paid keys are only used where they matter. */
function LocalAI({ st, test }) {
  const boot = useStore((s) => s.boot);
  const init = boot.settings?.ai || {};
  const [o, setO] = useState({ enabled: init.ollama?.enabled !== false, url: init.ollama?.url || 'http://127.0.0.1:11434', model: init.ollama?.model || 'llama3.2', local: init.local || 'all', searxngUrl: init.searxngUrl || '' });
  const on = !!st?.ai?.ollama;
  const save = () => act(() => api.patch('/api/settings', { ai: { ollama: { enabled: o.enabled, url: o.url, model: o.model }, local: o.local, searxngUrl: o.searxngUrl } }), { ok: 'Saved' }).then(() => test('ollama'));
  return html`<${Section} title="Free AI on this computer (Ollama)" sub="Runs Llama on your own PC at no cost. Euclidean uses it automatically whenever Ollama is open, so your paid keys are only used where they matter." action=${html`<span class=${'badge ' + (on ? 'moss' : '')}>${on ? 'Running' : 'Not running'}</span>`}>
    <div class="form-grid">
      <${Field} label="Use the free local AI for" id="loc-mode"><select id="loc-mode" class="input" value=${o.local} onChange=${(e) => setO({ ...o, local: e.target.value })}>
        <option value="most">Everything except emails and ad scripts (recommended)</option><option value="all">Everything (cheapest)</option><option value="off">Only when no paid AI works</option></select></${Field}>
      <${Field} label="Model" hint="Downloaded for you by the Turn on Ollama button" id="loc-model"><input id="loc-model" class="input" value=${o.model} onInput=${(e) => setO({ ...o, model: e.target.value })} /></${Field}>
      <${Field} label="Ollama address" id="loc-url"><input id="loc-url" class="input" value=${o.url} onInput=${(e) => setO({ ...o, url: e.target.value })} /></${Field}>
      <${Field} label="Your own search server (optional)" hint="Leave empty to use free DuckDuckGo search" id="loc-sx"><input id="loc-sx" class="input" placeholder="http://127.0.0.1:8888" value=${o.searxngUrl} onInput=${(e) => setO({ ...o, searxngUrl: e.target.value })} /></${Field}>
    </div>
    <label class="row" style="gap:8px"><${Toggle} on=${o.enabled} onChange=${(x) => setO({ ...o, enabled: x })} label="Use Ollama" /><span>Use Ollama when it's running</span></label>
    <div class="faint" style="font-size:var(--fs-xs)">Set up once with the <b>Turn on Ollama</b> button in Agent Connections. It installs Ollama and downloads the model for you. Web research works without any key (free DuckDuckGo search, Wikipedia, public records, Jina Reader). Grok's built-in search is only used if you add an xAI key.</div>
    <div class="row"><${Button} kind="primary" onClick=${save}>Save & check</${Button}></div>
  </${Section}>`;
}
