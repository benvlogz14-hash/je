// Approval Center: one focused queue for clips and AI-drafted messages. Keyboard-first.
import { html, useState, useEffect, useRef, useApi, Button, HoldButton, Empty, Seg, StatusBadge, act, navigate, promptDialog } from '../lib/ui.js';
import { api } from '../lib/api.js';
import { Icon } from '../lib/icons.js';
import { play } from '../lib/sound.js';
import { dur, ago, providerLabel } from '../lib/format.js';
import { ClipPlayer } from './clip.js';

export function Approvals() {
  const { data, reload } = useApi('/api/approvals', ['approval', 'clips', 'message']);
  const [kind, setKind] = useState('all');
  const [sel, setSel] = useState(0);
  const [feedback, setFeedback] = useState('');
  const fbRef = useRef(null);
  const started = useRef(Date.now());
  const items = (data || []).filter((a) => kind === 'all' || a.kind === kind);
  const cur = items[Math.min(sel, items.length - 1)];
  useEffect(() => { if (sel >= items.length && items.length) setSel(items.length - 1); }, [items.length]);
  useEffect(() => setFeedback(''), [cur?.id]);
  // Review time is logged so Finance can show real founder hours per client.
  useEffect(() => () => { const min = Math.round((Date.now() - started.current) / 60000); if (min >= 1) api.post('/api/timelogs', { minutes: min, note: 'Approval session', clientId: null }).catch(() => {}); }, []);

  const decideClip = async (decision, note) => { if (!cur) return; await act(() => api.post(`/api/clips/${cur.refId}/decide`, { decision, note }), { ok: decision === 'approve' ? (cur.stage === 'internal' && cur.ref?.status === 'review' ? 'Approved' : 'Approved') : decision === 'reject' ? 'Rejected' : 'Revision requested', sound: decision === 'approve' ? 'success' : 'tap' }); reload(); };
  const approveMsg = async (body) => { await act(() => api.post(`/api/messages/${cur.refId}/approve`, body ? { body } : {}), { ok: 'Approved and sending', sound: 'send' }); reload(); };
  const discardMsg = async () => { await act(() => api.post(`/api/messages/${cur.refId}/discard`), { ok: 'Discarded', sound: 'tap' }); reload(); };

  useEffect(() => {
    const k = (e) => {
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === 'j' || e.key === 'ArrowDown') { e.preventDefault(); play('tap'); setSel((s) => Math.min(items.length - 1, s + 1)); }
      else if (e.key === 'k' || e.key === 'ArrowUp') { e.preventDefault(); play('tap'); setSel((s) => Math.max(0, s - 1)); }
      else if (!cur) return;
      else if (e.key === 'a') { e.preventDefault(); cur.kind === 'clip' ? decideClip('approve') : approveMsg(); }
      else if (e.key === 'r' && cur.kind === 'clip') { e.preventDefault(); fbRef.current?.focus(); }
      else if (e.key === 'x') { e.preventDefault(); cur.kind === 'clip' ? decideClip('reject') : discardMsg(); }
      else if (e.key === ' ' && cur.kind === 'clip') { e.preventDefault(); const v = document.querySelector('.stage video'); if (v) v.paused ? v.play() : v.pause(); }
    };
    window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k);
  }, [cur?.id, items.length]);

  if (data && !data.length) return html`<div class="page"><div class="page-head"><div class="grow"><h1>Approvals</h1></div></div><div class="panel"><${Empty} icon="approvals" title="You're all caught up">New clips and AI-drafted messages land here when they need a decision. Political content and first-touch outreach always do.</${Empty}></div></div>`;
  return html`<div class="review">
    <aside class="review-list">
      <div style="padding:10px 8px 8px" class="col"><div class="row"><h2 class="grow">Approvals</h2><span class="badge coral">${(data || []).length}</span></div>
        <${Seg} value=${kind} onChange=${(v) => { setKind(v); setSel(0); }} options=${[{ value: 'all', label: 'All' }, { value: 'clip', label: 'Videos' }, { value: 'message', label: 'Messages' }]} /></div>
      ${items.map((a, i) => html`<div class=${'review-item' + (a === cur ? ' on' : '')} onClick=${() => { play('tap'); setSel(i); }}>
        ${a.kind === 'clip' ? html`<div class="th" style=${a.ref?.current ? { backgroundImage: `url(${api.url(`/api/clips/${a.refId}/thumb`)})` } : {}} />` : html`<div class="avatar sm" style="background:var(--lav-soft);color:var(--lav-ink)"><${Icon} name=${a.channel === 'email' ? 'mail' : 'messages'} size=${14} /></div>`}
        <div class="grow" style="min-width:0"><div class="ellipsis" style="font-weight:600;font-size:var(--fs-sm)">${a.kind === 'clip' ? `#${a.ref.ref} ${a.title}` : a.title}</div>
          <div class="faint ellipsis" style="font-size:var(--fs-xs)">${a.client || a.contact || ''} · ${a.stage === 'client' ? 'waiting on client' : a.kind === 'clip' ? (a.qc && !a.qc.passed ? 'QC issues' : 'ready') : a.category} · ${ago(a.createdAt)}</div></div></div>`)}
    </aside>
    <div class="stage">
      ${!cur ? null : cur.kind === 'clip' ? html`<${ClipPlayer} clip=${cur.ref} />` : html`<div class="panel" style="max-width:560px;width:100%;padding:22px">
        <div class="row" style="margin-bottom:12px"><span class="badge lav"><${Icon} name="sparkle" size=${11} />${cur.ref.aiGenerated ? `Drafted by ${providerLabel(cur.ref.agent)}` : 'Written by a founder'}</span><span class="badge outline">${cur.channel === 'email' ? 'Email' : 'SMS'}</span><span class="badge gold">${cur.category}</span></div>
        <div class="faint" style="font-size:var(--fs-sm)">To ${cur.contact}</div>${cur.subject ? html`<h3 style="margin:6px 0">${cur.subject}</h3>` : null}
        <div class="bubble selectable" style="max-width:100%;margin-top:10px;background:var(--bubble-ai);border-color:var(--lav-line)">${cur.body}</div></div>`}
      <div class="kbd-hints" style="position:absolute;bottom:12px;left:0;right:0;justify-content:center"><span><kbd>J</kbd>/<kbd>K</kbd> move</span><span><kbd>A</kbd> approve</span>${cur?.kind === 'clip' ? html`<span><kbd>R</kbd> request changes</span><span><kbd>Space</kbd> play</span>` : null}<span><kbd>X</kbd> ${cur?.kind === 'clip' ? 'reject' : 'discard'}</span></div>
    </div>
    <aside class="review-side">
      ${!cur ? null : cur.kind === 'clip' ? html`
        <div><div class="faint" style="font-size:var(--fs-sm)">${cur.client} · #${cur.ref.ref}</div><h2 style="margin-top:3px">${cur.ref.title}</h2></div>
        <div class="row wrap"><${StatusBadge} status=${cur.ref.status} />${cur.stage === 'client' ? html`<span class="badge lav">Waiting on client</span>` : null}<span class="badge outline tnum">${dur(cur.ref.current?.duration)}</span>${cur.ref.method === 'ai' ? html`<span class="badge lav">${providerLabel(cur.ref.agent)}</span>` : html`<span class="badge">Heuristic</span>`}</div>
        ${cur.ref.hook ? html`<div><div class="eyebrow">Hook</div><div style="margin-top:3px">${cur.ref.hook}</div></div>` : null}
        ${cur.ref.caption ? html`<div><div class="eyebrow">Caption</div><div style="margin-top:3px" class="muted selectable">${cur.ref.caption}</div></div>` : null}
        ${cur.qc ? html`<div class="col" style="gap:5px"><div class="eyebrow">Technical QC</div>${cur.qc.issues.length ? cur.qc.issues.map((i) => html`<div class="qc-item"><${Icon} name=${i.level === 'error' ? 'alert' : 'info'} size=${14} style=${{ color: i.level === 'error' ? 'var(--coral)' : 'var(--gold)' }} />${i.text}</div>`) : html`<div class="qc-item"><${Icon} name="check" size=${14} style="color:var(--moss)" />All checks passed</div>`}</div>` : null}
        <div class="divider" />
        ${cur.stage === 'client' ? html`<div class="notice lav"><${Icon} name="info" size=${16} />The client has the review link. You can still approve on their behalf, for example after a phone call.</div>` : null}
        <div class="col" style="gap:8px">
          <${Button} kind="moss" size="lg" icon="check" onClick=${() => decideClip('approve')}>${cur.stage === 'client' ? 'Approve for client' : 'Approve'}</${Button}>
          <textarea ref=${fbRef} class="textarea" id="ap-feedback" rows="3" placeholder="What should change? Plain words work: 'tighten the start, captions smaller, no hook'" value=${feedback} onInput=${(e) => setFeedback(e.target.value)} onKeyDown=${(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && feedback.trim()) decideClip('changes', feedback); if (e.key === 'Escape') e.target.blur(); }} />
          <div class="row"><${Button} kind="gold" icon="wand" class="grow" disabled=${!feedback.trim()} onClick=${() => decideClip('changes', feedback)}>Request changes</${Button}><${Button} kind="ghost" icon="x" onClick=${() => decideClip('reject')}>Reject</${Button}></div>
          <${Button} kind="ghost" size="sm" icon="external" onClick=${() => navigate(`/production?clip=${cur.refId}`)}>Open full detail</${Button}>
        </div>` : html`
        <div><div class="faint" style="font-size:var(--fs-sm)">${cur.client || 'No client'}</div><h2 style="margin-top:3px">${cur.title}</h2></div>
        <div class="notice gold"><${Icon} name="hand" size=${16} /><div>${cur.category === 'prospecting' ? 'First-touch outreach always needs a founder. Hold to send.' : `Held because it's categorised as "${cur.category}". Routine updates to clients send automatically.`}</div></div>
        <div class="col" style="gap:8px">
          ${cur.category === 'prospecting' ? html`<${HoldButton} kind="moss" size="lg" icon="send" onConfirm=${() => approveMsg()}>Hold to approve and send</${HoldButton}>` : html`<${Button} kind="moss" size="lg" icon="send" onClick=${() => approveMsg()}>Approve and send</${Button}>`}
          <${Button} kind="ghost" icon="edit" onClick=${async () => { const v = await promptDialog({ title: 'Edit before sending', value: cur.body, multiline: true, confirm: 'Approve and send' }); if (v != null) approveMsg(v); }}>Edit, then send</${Button}>
          <${Button} kind="ghost" icon="trash" onClick=${discardMsg}>Discard</${Button}>
          <${Button} kind="ghost" size="sm" icon="messages" onClick=${() => navigate(`/messages/${cur.ref.conversationId}`)}>Open conversation</${Button}>
        </div>`}
    </aside></div>`;
}
