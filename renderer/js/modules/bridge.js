// Talk to your own Grok, Claude and ChatGPT accounts (your subscriptions, no API keys), back and forth.
import { html, useState, useEffect, useRef, useApi, useRoute, navigate, Button, Seg, act, toast, store } from '../lib/ui.js';
import { api } from '../lib/api.js';
import { Icon } from '../lib/icons.js';

const SITES = [{ value: 'grok', label: 'Grok' }, { value: 'claude', label: 'Claude' }, { value: 'chatgpt', label: 'ChatGPT' }];

export function Bridge() {
  const route = useRoute();
  const [site, setSite] = useState(route.query.site && SITES.some((s) => s.value === route.query.site) ? route.query.site : 'grok');
  const { data: st, reload } = useApi('/api/bridge', ['bridge', 'settings']);
  const { data: hist, reload: reloadHist } = useApi(`/api/bridge/${site}/history`, ['bridge']);
  const [text, setText] = useState(route.query.q || '');
  const [busy, setBusy] = useState(false);
  const end = useRef(null);
  const me = (st?.sites || []).find((s) => s.site === site) || {};
  const label = SITES.find((s) => s.value === site).label;
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [hist, busy]);
  const send = async (newChat = false) => {
    const t = text.trim(); if (!t || busy) return;
    setBusy(true); setText('');
    try { await api.post(`/api/bridge/${site}/ask`, { text: t, newChat }); } catch (e) { toast(e.message, { kind: 'error' }); }
    setBusy(false); reloadHist(); reload();
  };
  // Opened from the search bar with a question: send it straight away.
  useEffect(() => { if (route.query.q && st?.available) { send(); navigate(`/bridge?site=${site}`); } }, [st?.available]);
  const setUse = (use) => act(() => api.patch('/api/settings', { ai: { bridge: { use, site } } }), { ok: use === 'off' ? 'Euclidean will use its own AI only' : `Euclidean's AI work can now go through your ${label} account` }).then((s) => { const b = store.get().boot; if (b && s) store.set({ boot: { ...b, settings: s } }); reload(); });
  return html`<div class="page">
    <div class="page-head"><div class="grow"><h1>Your AI apps</h1><div class="sub">Talk to Grok, Claude and ChatGPT with your own logins and subscriptions. No API keys, no extra cost.</div></div>
      <${Seg} value=${site} onChange=${setSite} options=${SITES} /></div>
    ${st && !st.available ? html`<div class="notice gold">This works in the Euclidean desktop app (it opens ${label} in its own window).</div>` : null}
    <div class="panel pad row wrap" style="gap:10px">
      <span class=${'badge ' + (me.ready ? 'moss' : '')}>${me.ready ? `Logged in to ${label}` : me.open ? `${label}: log in in its window` : `${label} not opened yet`}</span>
      <${Button} size="sm" kind=${me.ready ? 'ghost' : 'primary'} onClick=${() => act(() => api.post(`/api/bridge/${site}/open`, {}), { ok: `${label} opened. Log in once; it remembers you.` }).then(reload)}>${me.ready ? `Show ${label} window` : `Open ${label} to log in`}</${Button}>
      <span class="grow" />
      <${Button} size="sm" kind="ghost" onClick=${() => act(() => api.del(`/api/bridge/${site}/history`), { ok: 'Cleared' }).then(reloadHist)}>Clear chat</${Button}>
    </div>
    <div class="panel pad col" style="gap:10px;margin-top:12px;min-height:320px;max-height:60vh;overflow:auto">
      ${(hist || []).length ? (hist || []).map((m) => html`<div class=${'row'} style=${{ justifyContent: m.role === 'you' ? 'flex-end' : 'flex-start' }}><div class="selectable" style=${{ maxWidth: '78%', whiteSpace: 'pre-wrap', padding: '10px 14px', borderRadius: '16px', fontSize: 'var(--fs-sm)', lineHeight: 1.5, background: m.role === 'you' ? 'var(--sky-soft)' : m.role === 'error' ? 'var(--coral-soft)' : 'var(--surface-2)' }}>${m.role === 'them' ? html`<div class="faint" style="font-size:var(--fs-xs);margin-bottom:4px">${label}</div>` : null}${m.text}</div></div>`) : html`<div class="faint">Ask ${label} anything. Replies come back here, and you can keep going back and forth.</div>`}
      ${busy ? html`<div class="faint"><span class="spinner" /> ${label} is writing…</div>` : null}
      <div ref=${end} />
    </div>
    <div class="row" style="gap:8px;margin-top:10px">
      <textarea id="br-text" class="input grow" rows="2" style="font-family:inherit;height:60px" placeholder=${`Message ${label}…  (Enter to send, Shift+Enter for a new line)`} value=${text} onInput=${(e) => setText(e.target.value)} onKeyDown=${(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} />
      <div class="col" style="gap:6px"><${Button} kind="primary" icon="send" disabled=${busy || !text.trim()} onClick=${() => send()}>Send</${Button}><${Button} size="sm" kind="ghost" disabled=${busy || !text.trim()} onClick=${() => send(true)}>New chat</${Button}></div>
    </div>
    <details class="panel pad" style="margin-top:14px"><summary><b>Use your account for Euclidean's AI work</b> <span class="faint" style="font-size:var(--fs-xs)">${st?.use === 'first' ? `On: ${label} first` : st?.use === 'fallback' ? 'On: when paid AI is out' : 'Off'}</span></summary>
      <div class="col" style="gap:8px;margin-top:8px;font-size:var(--fs-sm)">
        <div>Euclidean can send its own writing and research through your ${label} account instead of paid API keys. It works one message at a time and at most ${st?.perHour || 20} messages an hour, so it is slower than an API key.</div>
        <div class="notice gold">Grok, Claude and ChatGPT's terms don't allow heavy automated use of personal accounts, and they can limit accounts that do it. Keep this for light use; looking at video still needs an API key or Llama.</div>
        <div class="row wrap" style="gap:6px"><${Button} size="sm" kind=${st?.use === 'first' ? 'primary' : 'ghost'} onClick=${() => setUse('first')}>Use ${label} first</${Button}><${Button} size="sm" kind=${st?.use === 'fallback' ? 'primary' : 'ghost'} onClick=${() => setUse('fallback')}>Only when paid AI is out</${Button}><${Button} size="sm" kind=${st?.use === 'off' || !st?.use ? 'primary' : 'ghost'} onClick=${() => setUse('off')}>Off</${Button}></div>
      </div></details>
  </div>`;
}
