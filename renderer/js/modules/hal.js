// HAL: the assistant in the bottom-right corner of every page (server/hal). Type or talk to him; he knows which page
// and which clip you're on ("re-edit this video..."), runs the app for you, looks things up on the web, and anything
// that sends, posts or approves waits for your click (Approvals, or the Confirm button on his reply).
import { html, useState, useEffect, useRef, useApi, useRoute, navigate, Button, Seg, act, toast } from '../lib/ui.js';
import { api } from '../lib/api.js';
import { Icon } from '../lib/icons.js';
import { play } from '../lib/sound.js';

const PREF = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } };
const SAVE = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private window */ } };

/** Text with links you can click (URLs HAL puts on their own line). */
function Rich({ text }) {
  const parts = String(text || '').split(/(https?:\/\/[^\s)>\]]+)/g);
  return html`<span>${parts.map((p, i) => (i % 2 ? html`<a href=${p} target="_blank" rel="noreferrer" class="hal-link">${p.replace(/^https?:\/\/(www\.)?/, '').slice(0, 60)}${p.length > 70 ? '…' : ''}</a>` : p))}</span>`;
}

/** Read a reply out loud (Windows' own voices), without the links. */
function speak(text) {
  try {
    const s = window.speechSynthesis; if (!s) return; s.cancel();
    const u = new SpeechSynthesisUtterance(String(text).replace(/https?:\/\/\S+/g, '').slice(0, 600));
    const vs = s.getVoices(); u.voice = vs.find((v) => /david|guy|mark|daniel|george|male/i.test(v.name) && /^en/i.test(v.lang)) || vs.find((v) => /^en/i.test(v.lang)) || null;
    u.rate = 1.02; u.pitch = 0.82; s.speak(u);
  } catch { /* no voices */ }
}

/** What HAL can see of the page you're on: the open clip (Production / Approvals) or prospect. */
function useContext() {
  const route = useRoute();
  const clipId = route?.query?.clip || null;
  const { data: clip } = useApi(clipId ? `/api/clips/${clipId}` : null, []);
  return { context: { route: route?.path || '', clipId, prospectId: route?.query?.prospect || null }, label: clip ? `Clip #${clip.ref}: ${clip.title}` : null };
}

export function HalDock() {
  const [open, setOpen] = useState(() => PREF('eu.halOpen', false));
  // The button can be dragged anywhere (some pages have their own buttons in the corner); it remembers the spot.
  const [pos, setPos] = useState(() => PREF('eu.halPos', { right: 18, bottom: 92 }));
  const drag = useRef(null);
  const down = (e) => { drag.current = { x: e.clientX, y: e.clientY, right: pos.right, bottom: pos.bottom, moved: false }; e.currentTarget.setPointerCapture(e.pointerId); };
  const move = (e) => {
    const d = drag.current; if (!d) return; const dx = e.clientX - d.x, dy = e.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) < 5) return; d.moved = true;
    setPos({ right: Math.max(6, Math.min(window.innerWidth - 56, d.right - dx)), bottom: Math.max(28, Math.min(window.innerHeight - 60, d.bottom - dy)) });
  };
  const up = () => { const d = drag.current; drag.current = null; if (d?.moved) SAVE('eu.halPos', pos); else toggle(); };
  const [voice, setVoice] = useState(() => PREF('eu.halSpeak', false));
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [rec, setRec] = useState(null);
  const { data: history, reload, setData } = useApi('/api/hal/history', ['hal']);
  const { data: status, reload: reStatus } = useApi(open ? '/api/hal/status' : null, []);
  const { context, label } = useContext();
  const list = useRef(null); const input = useRef(null);
  const toggle = (v = !open) => { setOpen(v); SAVE('eu.halOpen', v); if (v) { play('open'); setTimeout(() => input.current?.focus(), 60); } };
  useEffect(() => { if (list.current) list.current.scrollTop = list.current.scrollHeight; }, [history?.length, open, busy]);
  useEffect(() => { const k = (e) => { if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'h') { e.preventDefault(); toggle(); } }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [open]);

  const send = async (msg = text) => {
    const t = String(msg || '').trim(); if (!t || busy) return;
    setText(''); setBusy(true);
    setData([...(history || []), { id: `tmp${Date.now()}`, who: 'you', text: t }]);
    try {
      const r = await api.post('/api/hal/chat', { text: t, context });
      if (voice && r.text) speak(r.text);
      if (r.navigate) navigate(r.navigate);
      play('receive');
    } catch (e) { toast(e.message, { kind: 'warn' }); }
    setBusy(false); reload();
  };
  const ok = async (m) => {
    try { const r = await api.post('/api/hal/confirm', { id: m.confirm.id }); if (voice && r.text) speak(r.text); if (r.navigate) navigate(r.navigate); play('success'); } catch (e) { toast(e.message, { kind: 'warn' }); }
    reload();
  };
  const setBrain = (b) => act(() => api.post('/api/hal/brain', { brain: b }), { ok: b === 'grok' ? 'HAL is using Grok' : 'HAL is using the local brain on this PC', sound: 'tap' }).then(reStatus);

  // Talk to HAL: click the mic, speak, click again; the free speech-to-text turns it into text and sends it.
  const mic = async () => {
    if (rec) { rec.stop(); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const r = new MediaRecorder(stream); const chunks = [];
      r.ondataavailable = (e) => chunks.push(e.data);
      r.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop()); setRec(null); setBusy(true);
        try {
          const file = new File(chunks, 'hal.webm', { type: r.mimeType || 'audio/webm' });
          const res = await api.upload('/api/hal/listen', [file], {});
          setBusy(false);
          if (res.text) send(res.text); else toast("I didn't catch that. Try again a little closer to the mic.", { kind: 'warn' });
        } catch (e) { setBusy(false); toast(e.message, { kind: 'warn' }); }
      };
      r.start(); setRec(r); play('tap');
    } catch { toast('Euclidean needs your microphone to hear you. Allow it in Windows Settings → Privacy → Microphone.', { kind: 'warn' }); }
  };

  const offline = status && ((status.brain === 'local' && !status.local) || (status.brain === 'grok' && !status.grok));
  return html`
    <button type="button" class=${'hal-fab' + (open ? ' on' : '') + (busy ? ' busy' : '')} style=${{ right: `${pos.right}px`, bottom: `${pos.bottom}px` }} title="HAL (Ctrl+Shift+H). Drag to move." aria-label="Open HAL" onPointerDown=${down} onPointerMove=${move} onPointerUp=${up} onKeyDown=${(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } }}><span class="hal-eye" /></button>
    ${open ? html`<section class="hal-panel" role="dialog" aria-label="HAL" style=${{ right: `${Math.min(pos.right, Math.max(6, window.innerWidth - 440))}px`, bottom: `${Math.min(pos.bottom + 54, Math.max(10, window.innerHeight - 640))}px` }}>
      <header class="hal-head"><span class="hal-eye sm" /><b class="grow">HAL</b>
        <${Seg} value=${status?.brain || 'local'} onChange=${setBrain} options=${[{ value: 'local', label: 'Local' }, { value: 'grok', label: 'Grok' }]} />
        <button type="button" class=${'hal-ico' + (voice ? ' on' : '')} title=${voice ? 'Reading replies out loud' : 'Read replies out loud'} onClick=${() => { const v = !voice; setVoice(v); SAVE('eu.halSpeak', v); if (!v) window.speechSynthesis?.cancel(); }}><${Icon} name=${voice ? 'volume' : 'mute'} size=${15} /></button>
        <button type="button" class="hal-ico" title="Clear the conversation" onClick=${() => act(() => api.del('/api/hal/history'), { ok: 'Cleared', sound: 'tap' }).then(reload)}><${Icon} name="trash" size=${15} /></button>
        <button type="button" class="hal-ico" title="Close" onClick=${() => toggle(false)}><${Icon} name="x" size=${16} /></button></header>
      ${offline ? html`<div class="hal-note">${status.brain === 'local' ? "My local brain (Llama) isn't running. Open Ollama, or switch me to Grok." : 'Grok needs your xAI key in Settings → Connections, or switch me to Local.'}${status.any ? ' Until then I use whatever AI is connected.' : ''}</div>` : null}
      ${label ? html`<div class="hal-ctx"><${Icon} name="eye" size=${12} /> Looking at ${label}</div>` : null}
      <div class="hal-list" ref=${list}>
        ${!(history || []).length ? html`<div class="hal-empty"><span class="hal-eye lg" /><p>Good evening. I can research candidates and the news, run the pipeline and calendar, draft outreach for Approvals, and drive the app: "re-edit this clip, start at the reveal", "what's in the queue", "make clips from Stringer's new footage".</p></div>` : null}
        ${(history || []).map((m) => html`<div key=${m.id} class=${'hal-msg ' + (m.who === 'hal' ? 'hal' : 'you')}>
          <div class="hal-bubble"><${Rich} text=${m.text} /></div>
          ${m.draft ? html`<div class="hal-draft"><pre>${m.draft}</pre><${Button} size="sm" kind="ghost" icon="paperclip" onClick=${() => { navigator.clipboard?.writeText(m.draft); toast('Copied', { kind: 'success' }); }}>Copy</${Button}></div>` : null}
          ${m.confirm ? html`<div class="hal-confirm">${m.confirm.done ? html`<span class="faint">Done</span>` : html`<${Button} size="sm" kind="primary" icon="check" onClick=${() => ok(m)}>Confirm: ${m.confirm.label}</${Button}>`}</div>` : null}
          ${m.who === 'hal' && m.by ? html`<div class="hal-by">${/ollama/.test(m.by) ? 'local brain' : /xai/.test(m.by) ? 'Grok' : m.by.split(':')[0]}</div>` : null}
        </div>`)}
        ${busy ? html`<div class="hal-msg hal"><div class="hal-bubble hal-dots"><i /><i /><i /></div></div>` : null}
      </div>
      <div class="hal-chips">${[["What's in the news?", "what's in the news today"], ['Best targets', 'who are our best targets'], ['Queue', '/queue'], ['Scan protests', 'scan protests']].map(([l, q]) => html`<button type="button" class="chip" onClick=${() => send(q)}>${l}</button>`)}</div>
      <div class="hal-input">
        <textarea ref=${input} rows="1" placeholder=${rec ? 'Listening… click the mic again when you are done' : label ? 'Tell HAL what to change in this clip, or ask anything' : 'Ask HAL anything, or tell him what to do'} value=${text} onInput=${(e) => setText(e.target.value)} onKeyDown=${(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} />
        <button type="button" class=${'hal-ico mic' + (rec ? ' rec' : '')} title=${rec ? 'Stop and send' : 'Talk to HAL'} onClick=${mic}><${Icon} name="mic" size=${17} /></button>
        <button type="button" class="hal-ico send" title="Send (Enter)" disabled=${!text.trim() || busy} onClick=${() => send()}><${Icon} name="send" size=${16} /></button>
      </div>
    </section>` : null}`;
}
