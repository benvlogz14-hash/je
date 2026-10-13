// Lite window: a small, low-memory view with only the vital controls (status, approvals, commands).
import { html, useState, useStore, useApi, useEvent, Button, HoldButton, act, toast, navigate } from '../lib/ui.js';
import { api } from '../lib/api.js';
import { Icon, BrandMark } from '../lib/icons.js';
import { play } from '../lib/sound.js';

export function Lite() {
  const { data: approvals } = useApi('/api/approvals', ['approval']);
  const { data: q } = useApi('/api/queue/stats', ['job', 'queue']);
  const [res, setRes] = useState(useStore((s) => s.boot?.resources));
  const [text, setText] = useState('');
  const [reply, setReply] = useState(null);
  useEvent('resources', setRes);
  const run = async () => { const t = text.trim(); if (!t) return; setText(''); play('send'); try { const r = await api.post('/api/command', { text: t }); setReply(r); play(r.error ? 'error' : 'receive'); } catch (e) { toast(e.message, { kind: 'error' }); } };
  return html`<div class="lite">
    <header class="titlebar" style="padding-right:12px"><div class="brand"><${BrandMark} /><span>Euclidean</span></div><span class="badge moss"><${Icon} name="leaf" size=${11} />Lite</span><div class="drag" />
      <${Button} kind="soft" size="sm" icon="bolt" onClick=${() => act(() => api.post('/api/mode', { mode: 'full' }), { ok: 'Full mode' })}>Full mode</${Button}></header>
    <div style="flex:1;overflow:auto;padding:16px" class="col">
      <div class="panel pad col" style="gap:6px"><div class="row"><span class=${'led ' + (q?.paused ? 'err' : 'ok')} /><b class="grow">${q?.paused ? 'Automation paused' : 'Vital functions running'}</b></div>
        <div class="muted" style="font-size:var(--fs-sm)">Messages, approvals and publishing keep working. Rendering and transcription wait for Full mode.</div>
        ${res ? html`<div class="faint tnum" style="font-size:var(--fs-xs)">CPU ${res.cpu}% · ${(res.ramFreeMb / 1024).toFixed(1)} GB RAM free · Euclidean ${res.engineMb + (res.uiMb || 0)} MB</div>` : null}</div>
      <div class="panel pad row"><${Icon} name="approvals" size=${18} /><b class="grow">${approvals?.length || 0} waiting for approval</b><${Button} size="sm" kind="soft" onClick=${() => act(() => api.post('/api/mode', { mode: 'full' }), { sound: 'open' }).then(() => navigate('/approvals'))}>Review</${Button}></div>
      <div class="panel pad row"><${Icon} name="layers" size=${18} /><span class="grow">${q ? `${q.running} running · ${q.queued} queued` : '…'}</span>
        ${q?.paused ? html`<${Button} size="sm" kind="moss" onClick=${() => act(() => api.post('/api/queue/resume'), { ok: 'Resumed' })}>Resume</${Button}>` : html`<${HoldButton} size="sm" kind="coral" icon="power" onConfirm=${() => act(() => api.post('/api/queue/pause'), { ok: 'Stopped' })}>Stop</${HoldButton}>`}</div>
      ${reply ? html`<div class="bubble selectable" style="max-width:100%">${reply.text}</div>` : null}
    </div>
    <div class="composer-wrap"><div class="composer"><textarea rows="1" id="lite-cmd" placeholder="/status, /approve 104, /pause…" value=${text} onInput=${(e) => setText(e.target.value)} onKeyDown=${(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); run(); } }} aria-label="Command" />
      <div class="tools"><div class="spacer" /><button class="send-btn" disabled=${!text.trim()} onClick=${run} aria-label="Run"><${Icon} name="send" size=${16} /></button></div></div></div>
  </div>`;
}
