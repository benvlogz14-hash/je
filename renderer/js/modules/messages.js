// Messages: unified SMS + email inbox and the Euclidean command thread.
import { html, useRoute, useState, useEffect, useRef, useMemo, useStore, useApi, useEvent, navigate, Button, HoldButton, Avatar, Seg, Empty, Loading, Modal, Field, act, toast, openMenu, store, promptDialog, gcls, cmdGroup } from '../lib/ui.js';
import { api } from '../lib/api.js';
import { Icon, BrandMark } from '../lib/icons.js';
import { play } from '../lib/sound.js';
import { ago, time, day, dateTime, providerLabel, actorName } from '../lib/format.js';
import { Card, QuotaBar } from './cards.js';

export function Messages() {
  const route = useRoute();
  const convId = route.path.split('/')[2] || null;
  const { data: convs, loading, reload } = useApi('/api/conversations', ['conversation', 'message', 'contacts']);
  const [filter, setFilter] = useState('all');
  const [q, setQ] = useState('');
  const [hits, setHits] = useState(null);
  const [side, setSide] = useState(true);
  const [newOpen, setNewOpen] = useState(false);

  useEffect(() => { if (!convId && convs?.length) navigate(`/messages/${convs.find((c) => c.kind === 'command')?.id || convs[0].id}`); }, [convId, !!convs]);
  useEffect(() => {
    if (q.trim().length < 2) { setHits(null); return; }
    const t = setTimeout(() => api.get(`/api/search?q=${encodeURIComponent(q)}`).then(setHits).catch(() => {}), 220);
    return () => clearTimeout(t);
  }, [q]);

  const list = useMemo(() => (convs || []).filter((c) => {
    if (filter === 'clients' && c.contact?.role !== 'client') return false;
    if (filter === 'prospects' && c.contact?.role !== 'prospect') return false;
    if (filter === 'unread' && !c.unread && !c.pendingApprovals) return false;
    if (q && !hits && !(c.title || '').toLowerCase().includes(q.toLowerCase())) return false;
    return true;
  }), [convs, filter, q, hits]);
  const conv = convs?.find((c) => c.id === convId);

  return html`<div class=${'msg-layout' + (convId ? ' has-thread' : '')}>
    <section class="conv-list" aria-label="Conversations">
      <div class="conv-head">
        <div class="title-row"><h2 class="grow">Messages</h2><${Button} kind="soft" size="sm" icon="plus" title="New conversation" onClick=${() => setNewOpen(true)} /></div>
        <div class="input-group"><${Icon} name="search" size=${15} style="color:var(--ink-3)" /><input class="input sm" id="conv-search" placeholder="Search people and messages" value=${q} onInput=${(e) => setQ(e.target.value)} /></div>
        <${Seg} value=${filter} onChange=${setFilter} options=${[{ value: 'all', label: 'All' }, { value: 'clients', label: 'Clients' }, { value: 'prospects', label: 'Prospects' }, { value: 'unread', label: 'Needs you' }]} />
      </div>
      <div class="conv-scroll">
        ${loading ? html`<${Loading} rows=${6} />` : hits ? html`
          <div class="eyebrow" style="padding:6px 10px">${hits.length} message${hits.length === 1 ? '' : 's'} found</div>
          ${hits.map((m) => html`<div class="conv" onClick=${() => { navigate(`/messages/${m.conversationId}?m=${m.id}`); setQ(''); }}><${Avatar} name=${m.title} /><div class="meta"><div class="top"><span class="name">${m.title}</span><span class="time">${ago(m.at)}</span></div><div class="preview">${m.body}</div></div></div>`)}`
        : list.map((c) => html`<${ConvRow} key=${c.id} c=${c} on=${c.id === convId} />`)}
        ${!loading && !list.length && !hits ? html`<${Empty} icon="messages" title="No conversations">${filter === 'all' ? 'Connect SMS or email in Settings, or start a conversation with the + button.' : 'Nothing matches this filter.'}</${Empty}>` : null}
      </div>
    </section>
    ${conv ? html`<${Thread} key=${conv.id} conv=${conv} side=${side} toggleSide=${() => setSide(!side)} />` : html`<section class="thread"><${Empty} icon="messages" title="Select a conversation" /></section>`}
    ${conv && conv.kind === 'contact' ? html`<${SidePanel} conv=${conv} open=${side} />` : html`<div />`}
    ${newOpen ? html`<${NewConversation} onClose=${() => setNewOpen(false)} onCreated=${(id) => { setNewOpen(false); reload(); navigate(`/messages/${id}`); }} />` : null}
  </div>`;
}

function ConvRow({ c, on }) {
  const isCmd = c.kind === 'command';
  return html`<div class=${'conv' + (on ? ' on' : '') + (c.unread ? ' unread' : '')} onClick=${() => { play('tap'); navigate(`/messages/${c.id}`); }}
    onContextMenu=${(e) => !isCmd && openMenu(e, [
      { label: c.pinned ? 'Unpin' : 'Pin to top', icon: 'pin', onClick: () => act(() => api.patch(`/api/conversations/${c.id}`, { pinned: !c.pinned }), { sound: 'tap' }) },
      { label: 'Mark as read', icon: 'check', onClick: () => api.post(`/api/conversations/${c.id}/read`) },
      'sep', { label: 'Archive', icon: 'archive', onClick: () => act(() => api.patch(`/api/conversations/${c.id}`, { archived: true }), { ok: 'Archived', sound: 'tap' }) },
    ])}>
    ${isCmd ? html`<div class="avatar" style="background:var(--teal-soft)"><${BrandMark} size=${24} /></div>` : html`<${Avatar} name=${c.title} />`}
    <div class="meta">
      <div class="top"><span class="name">${c.title}</span>${c.pinned && !isCmd ? html`<${Icon} name="pin" size=${12} style="color:var(--ink-3)" />` : null}<span class="time">${isCmd ? '' : ago(c.lastMessageAt)}</span></div>
      <div class="preview">${c.preview || (isCmd ? 'Type / to run a command, or ask in plain words' : '')}</div>
      ${!isCmd && (c.contact?.role || c.pendingApprovals) ? html`<div class="tags">
        ${c.contact?.role === 'client' ? html`<span class="badge teal">Client</span>` : c.contact?.role === 'prospect' ? html`<span class="badge slate">Prospect</span>` : c.contact?.role === 'unknown' ? html`<span class="badge">New contact</span>` : null}
        ${c.pendingApprovals ? html`<span class="badge gold">${c.pendingApprovals} to approve</span>` : null}
        ${c.contact?.optedOut?.sms ? html`<span class="badge coral">Opted out</span>` : null}</div>` : null}
    </div></div>`;
}

function Thread({ conv, side, toggleSide }) {
  const { data: msgs, setData } = useApi(`/api/conversations/${conv.id}/messages`, []);
  const scroller = useRef(null);
  const [typing, setTyping] = useState(false);
  const isCmd = conv.kind === 'command';
  const commands = useStore((s) => s.boot?.commands || []);

  useEffect(() => { api.post(`/api/conversations/${conv.id}/read`).catch(() => {}); }, [conv.id, msgs?.length]);
  useEvent('message', (m) => {
    if (m.conversationId !== conv.id) return;
    setData((prev) => { const list = prev || []; const i = list.findIndex((x) => x.id === m.id); if (i >= 0) { const c = list.slice(); c[i] = m; return c; } if (m.direction === 'in') play('receive'); return [...list, m]; });
  }, [conv.id]);
  useEvent('typing', (t) => { if (t.conversationId === conv.id) setTyping(t.on); }, [conv.id]);
  useEffect(() => { const el = scroller.current; if (el) el.scrollTop = el.scrollHeight; }, [msgs?.length, typing]);

  const runCommand = async (text) => {
    play('send');
    try {
      const r = await api.post('/api/command', { text, conversationId: conv.id });
      if (r.navigate) setTimeout(() => navigate(r.navigate), 350);
      if (!isCmd && r.text && r.silent) toast(r.text, { kind: r.error ? 'error' : 'ok' });
      if (r.error) play('error');
    } catch (e) { play('error'); toast(e.message, { kind: 'error' }); }
  };

  let lastDay = null; let lastWho = null;
  return html`<section class="thread">
    <header class="thread-head">
      ${isCmd ? html`<div class="avatar" style="background:var(--teal-soft)"><${BrandMark} size=${24} /></div>` : html`<${Avatar} name=${conv.title} />`}
      <div class="grow" style="min-width:0"><h3 class="ellipsis">${conv.title}</h3>
        <div class="muted ellipsis" style="font-size:var(--fs-sm)">${isCmd ? 'Operations assistant · runs commands and routes work to Claude, GPT, Grok and Astra' : [conv.contact?.phones?.[0], conv.contact?.emails?.[0]].filter(Boolean).join(' · ') || 'No phone or email yet'}</div></div>
      ${!isCmd ? html`<${Button} kind="ghost" size="sm" icon="sidebar" title=${side ? 'Hide details' : 'Show details'} onClick=${toggleSide} />` : html`<${Button} kind="ghost" size="sm" icon="info" onClick=${() => runCommand('/help')}>Commands</${Button}>`}
    </header>
    <div class="thread-scroll" ref=${scroller}>
      ${!msgs ? html`<${Loading} rows=${3} />` : msgs.length === 0 ? (isCmd ? html`<${Welcome} onRun=${runCommand} />` : html`<${Empty} icon="messages" title="No messages yet">Say hello below. Texts go out over SMS, or switch the composer to Email.</${Empty}>`) : null}
      ${(msgs || []).map((m) => {
        const d = day(m.createdAt); const sep = d !== lastDay ? html`<div class="day-sep">${d}</div>` : null; lastDay = d;
        const who = m.direction + (m.aiGenerated ? 'ai' : ''); const showWho = who !== lastWho || sep; lastWho = who;
        return html`${sep}<${Bubble} key=${m.id} m=${m} conv=${conv} isCmd=${isCmd} showWho=${showWho} onCommand=${runCommand} />`;
      })}
      ${typing ? html`<div class="bubble-row in"><div class="typing"><i /><i /><i /></div></div>` : null}
    </div>
    <${Composer} conv=${conv} isCmd=${isCmd} commands=${commands} onCommand=${runCommand} />
  </section>`;
}

function Welcome({ onRun }) {
  const tries = ['/clients', '/clips', '/queue', '/health', '/agents', '/help'];
  return html`<div class="empty" style="padding-top:60px"><div class="glyph" style="background:var(--teal-soft)"><${BrandMark} size=${30} /></div><h3>What should Euclidean do?</h3>
    <p>Type <kbd>/</kbd> for commands, or ask in plain words once an AI provider is connected: "make Stringer six shorts from yesterday's stream" or "who hasn't replied this week?"</p>
    <div class="chips" style="justify-content:center">${tries.map((t) => html`<button class=${'chip ' + gcls(cmdGroup(t))} style="border:0;padding:0;background:none" onClick=${() => onRun(t)}><span class="cmd-chip">${t}</span></button>`)}</div></div>`;
}

function Bubble({ m, conv, isCmd, showWho, onCommand }) {
  if (m.direction === 'internal') return html`<div class="bubble-row internal"><div class="bubble-note">${m.aiGenerated ? html`<${Icon} name="sparkle" size=${12} /> ` : html`<${Icon} name="edit" size=${12} /> `}${m.body}</div></div>`;
  const out = m.direction === 'out';
  const who = isCmd ? (out ? null : 'Euclidean') : out ? (m.aiGenerated ? `Drafted by ${providerLabel(m.agent)}` : actorName(m.createdBy)) : conv.title;
  const cls = ['bubble', m.aiGenerated ? 'ai' : '', m.error ? 'err' : '', m.status === 'pending_approval' ? 'pending' : '', isCmd && out && String(m.body).startsWith('/') ? 'cmd ' + gcls(cmdGroup(m.body)) : ''].join(' ');
  return html`<div class=${'bubble-row ' + (out ? 'out' : 'in')} id=${'m-' + m.id}>
    ${showWho && who ? html`<div class="bubble-who">${m.aiGenerated ? html`<span class="badge lav"><${Icon} name="sparkle" size=${11} />AI</span>` : null}${who}${!isCmd && m.channel ? html`<span class="badge outline">${m.channel === 'sms' ? 'SMS' : m.channel === 'email' ? 'Email' : m.channel}</span>` : null}</div>` : null}
    <div class=${cls}>${m.subject ? html`<div class="subject">${m.subject}</div>` : null}${isCmd && out ? html`<span class="mono">${m.body}</span>` : m.body}
      ${m.attachments?.length ? html`<div class="row wrap" style="margin-top:6px">${m.attachments.map((a) => html`<span class="badge outline"><${Icon} name="paperclip" size=${11} />${a.name}</span>`)}</div>` : null}
      ${m.card ? html`<${Card} card=${m.card} onCommand=${(t) => store.set({ composerPrefill: t })} />` : null}
      ${m.navigate ? html`<div style="margin-top:8px"><${Button} size="sm" kind="soft" iconRight="chevronRight" onClick=${() => navigate(m.navigate)}>Open</${Button}></div>` : null}
    </div>
    ${m.status === 'pending_approval' ? html`<${ApprovalActions} m=${m} conv=${conv} />` : null}
    ${out && !isCmd ? html`<div class="bubble-status">${statusLine(m)}</div>` : null}
    ${m.triage ? html`<div class="bubble-status"><${Icon} name="sparkle" size=${11} />${providerLabel(m.triage.agent)}: ${m.triage.intent.replace(/_/g, ' ')}${m.triage.urgency === 'high' ? ' · urgent' : ''} · ${m.triage.summary}</div>` : null}
  </div>`;
}

function statusLine(m) {
  const t = time(m.sentAt || m.createdAt);
  switch (m.status) {
    case 'sent': return html`<${Icon} name="check" size=${12} />${m.testRedirect ? 'Sent to sandbox' : 'Sent'} ${t}`;
    case 'queued': return html`<span class="spinner" style="width:10px;height:10px" />Sending`;
    case 'scheduled': return html`<${Icon} name="clock" size=${12} />Scheduled for ${dateTime(m.sendAt)}`;
    case 'pending_approval': return html`<${Icon} name="hand" size=${12} />Waiting for approval`;
    case 'failed': return html`<span style="color:var(--coral-ink)"><${Icon} name="alert" size=${12} /> Not delivered${m.error ? `: ${m.error}` : ''}</span>`;
    case 'discarded': return 'Discarded';
    default: return t;
  }
}

function ApprovalActions({ m, conv }) {
  const prospect = conv.contact?.role === 'prospect';
  const edit = async () => { const v = await promptDialog({ title: 'Edit before sending', value: m.body, multiline: true, confirm: 'Approve and send' }); if (v != null) await act(() => api.post(`/api/messages/${m.id}/approve`, { body: v }), { ok: 'Approved', sound: 'send' }); };
  return html`<div class="bubble-actions">
    ${prospect
      ? html`<${HoldButton} kind="moss" size="sm" icon="send" title="Hold to approve outreach" onConfirm=${() => act(() => api.post(`/api/messages/${m.id}/approve`), { ok: 'Outreach approved', sound: 'send' })}>Hold to send</${HoldButton}>`
      : html`<${Button} kind="moss" size="sm" icon="check" sound="send" onClick=${() => act(() => api.post(`/api/messages/${m.id}/approve`), { ok: 'Approved and sending', sound: null })}>Approve and send</${Button}>`}
    <${Button} kind="ghost" size="sm" icon="edit" onClick=${edit}>Edit</${Button}>
    <${Button} kind="ghost" size="sm" icon="trash" onClick=${() => act(() => api.post(`/api/messages/${m.id}/discard`), { sound: 'tap' })}>Discard</${Button}>
  </div>`;
}

function Composer({ conv, isCmd, commands, onCommand }) {
  const [text, setText] = useState('');
  const [subject, setSubject] = useState('');
  const [channel, setChannel] = useState(conv.lastChannel === 'email' || (!conv.contact?.phones?.length && conv.contact?.emails?.length) ? 'email' : 'sms');
  const [note, setNote] = useState(false);
  const [sel, setSel] = useState(0);
  const [drafting, setDrafting] = useState(false);
  const ta = useRef(null);
  const prefill = useStore((s) => s.composerPrefill);
  useEffect(() => { if (prefill) { setText(prefill); store.set({ composerPrefill: null }); ta.current?.focus(); } }, [prefill]);
  useEffect(() => { ta.current?.focus(); }, [conv.id]);
  useEffect(() => { const el = ta.current; if (el) { el.style.height = 'auto'; el.style.height = Math.min(220, el.scrollHeight) + 'px'; } }, [text]);

  const slash = text.startsWith('/') && !text.includes('\n') ? text.slice(1).split(' ')[0].toLowerCase() : null;
  const showPop = slash !== null && !text.includes(' ');
  const matches = showPop ? commands.filter((c) => c.name.startsWith(slash) || (slash.length > 1 && c.description.toLowerCase().includes(slash))) : [];
  useEffect(() => setSel(0), [slash]);

  const send = async () => {
    const t = text.trim(); if (!t) return;
    if (t.startsWith('/') || isCmd) { setText(''); return onCommand(t); }
    try {
      await api.post(`/api/conversations/${conv.id}/messages`, note ? { body: t, internal: true } : { body: t, channel, subject: channel === 'email' ? subject : undefined });
      play('send'); setText(''); setSubject('');
    } catch (e) { play('error'); toast(e.message, { kind: 'error', title: 'Not sent' }); }
  };
  const aiDraft = async () => {
    setDrafting(true);
    try { const r = await api.post(`/api/conversations/${conv.id}/ai-draft`, { instruction: text.trim() || undefined }); setText(r.body); play('success'); toast(`Drafted by ${providerLabel(r.agent)}. Review before sending.`, { kind: 'info' }); }
    catch (e) { play('error'); toast(e.message, { kind: 'error', title: 'No draft' }); }
    finally { setDrafting(false); }
  };
  const key = (e) => {
    if (showPop && matches.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => (s + 1) % matches.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => (s - 1 + matches.length) % matches.length); return; }
      if (e.key === 'Tab' || (e.key === 'Enter' && matches[sel] && `/${matches[sel].name}` !== text.trim())) { e.preventDefault(); play('tap'); setText(`/${matches[sel].name} `); return; }
      if (e.key === 'Escape') { setText(''); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  };
  const groups = [...new Set(matches.map((m) => m.group))];
  const placeholder = isCmd ? 'Type / for commands, or tell Euclidean what you need' : note ? 'Internal note (never sent to the contact)' : channel === 'sms' ? `Text ${conv.title}` : `Email ${conv.title}`;
  return html`<div class="composer-wrap">
    ${showPop && matches.length ? html`<div class="slash-pop" role="listbox">${groups.map((g) => html`<div class=${'slash-group eyebrow ' + gcls(g)}>${g}</div>${matches.filter((m) => m.group === g).map((m) => {
      const i = matches.indexOf(m);
      return html`<div class=${'slash-item ' + gcls(g) + (i === sel ? ' on' : '')} role="option" onMouseEnter=${() => setSel(i)} onClick=${() => { play('tap'); setText(`/${m.name} `); ta.current?.focus(); }}><span><span class="cmd-chip">${m.usage}</span></span><span class="d">${m.description}</span>${m.needsAI ? html`<span class="badge lav">AI</span>` : html`<span />`}</div>`;
    })}`)}</div>` : null}
    <div class="composer" style=${note ? { borderStyle: 'dashed', background: 'var(--gold-soft)' } : null}>
      ${!isCmd && channel === 'email' && !note ? html`<input class="subject" id="composer-subject" placeholder="Subject" value=${subject} onInput=${(e) => setSubject(e.target.value)} />` : null}
      <textarea ref=${ta} id="composer-text" rows="1" placeholder=${placeholder} value=${text} onInput=${(e) => setText(e.target.value)} onKeyDown=${key} aria-label="Message" />
      <div class="tools">
        ${!isCmd ? html`
          <${Seg} value=${note ? 'note' : channel} onChange=${(v) => { if (v === 'note') setNote(true); else { setNote(false); setChannel(v); } }} options=${[
            ...(conv.contact?.phones?.length ? [{ value: 'sms', label: 'SMS', icon: 'phone' }] : []),
            ...(conv.contact?.emails?.length ? [{ value: 'email', label: 'Email', icon: 'mail' }] : []),
            { value: 'note', label: 'Note', icon: 'edit' }]} />
          <${Button} kind="ghost" size="sm" icon="sparkle" busy=${drafting} title="Draft a reply with AI (uses any text you typed as the instruction)" onClick=${aiDraft}>Draft</${Button}>` : html`<${Button} kind="ghost" size="sm" icon="slash" title="Commands" onClick=${() => { setText('/'); ta.current?.focus(); }}>Commands</${Button}>`}
        <div class="spacer" /><span class="faint" style="font-size:var(--fs-xs);margin-right:6px">${text.startsWith('/') ? 'Enter to run' : 'Enter to send · Shift+Enter for a new line'}</span>
        <button class="send-btn" disabled=${!text.trim()} onClick=${send} aria-label="Send"><${Icon} name="send" size=${17} stroke=${2.2} /></button>
      </div>
    </div></div>`;
}

function SidePanel({ conv, open }) {
  const contact = conv.contact;
  const { data: client } = useApi(contact?.clientId ? `/api/clients/${contact.clientId}` : null, ['clients', 'clips', 'posts']);
  const { data: clients } = useApi('/api/clients', []);
  const [editing, setEditing] = useState(false);
  if (!contact) return html`<aside class=${'side' + (open ? '' : ' closed')} />`;
  return html`<aside class=${'side' + (open ? '' : ' closed')} aria-label="Contact details">
    <div class="col" style="align-items:center;text-align:center;gap:6px;padding-top:4px"><${Avatar} name=${contact.name} size="lg" /><h3>${contact.name}</h3>
      <div class="row" style="justify-content:center">${contact.role === 'client' ? html`<span class="badge teal">Client</span>` : contact.role === 'prospect' ? html`<span class="badge slate">Prospect</span>` : html`<span class="badge">${contact.role}</span>`}</div></div>
    <div class="side-sec"><div class="row"><span class="eyebrow grow">Contact</span><${Button} kind="ghost" size="sm" icon="edit" title="Edit contact" onClick=${() => setEditing(true)} /></div>
      <dl class="kv"><dt>Phone</dt><dd class="selectable">${contact.phones?.join(', ') || '—'}</dd><dt>Email</dt><dd class="selectable">${contact.emails?.join(', ') || '—'}</dd>
        <dt>Texts</dt><dd>${contact.optedOut?.sms ? html`<span class="badge coral">Opted out</span>` : 'Allowed'}</dd></dl></div>
    ${client ? html`<div class="side-sec"><div class="row"><span class="eyebrow grow">Client</span><a href=${`#/clients/${client.id}`}>Open</a></div>
      <div class="panel pad" style="padding:12px"><div class="row"><b class="grow">${client.name}</b><span class=${'badge ' + (client.type === 'political' ? 'slate' : 'teal')}>${client.type}</span></div>
        ${client.quota ? html`<div style="margin-top:10px"><${QuotaBar} q=${client.quota} /><div class="faint" style="font-size:var(--fs-xs);margin-top:6px">${client.quota.scheduled} scheduled · ${client.quota.inReview} in review · ${client.schedule.shortsPerDay}/day</div></div>` : null}</div></div>
      <div class="side-sec"><span class="eyebrow">Remembered preferences</span>
        ${(client.memory || []).filter((m) => m.active !== false).slice(-5).reverse().map((m) => html`<div class="memory-item"><${Icon} name="pin" size=${13} style="flex:none;margin-top:2px;color:var(--gold-ink)" /><span>${m.text}</span></div>`)}
        ${!(client.memory || []).length ? html`<div class="faint" style="font-size:var(--fs-sm)">Nothing yet. Feedback like "no all-caps captions" is remembered automatically.</div>` : null}
      </div>` : html`<div class="side-sec"><span class="eyebrow">Link to a client</span>
        <select class="select sm" id="link-client" onChange=${(e) => e.target.value && act(() => api.patch(`/api/contacts/${contact.id}`, { clientId: e.target.value, role: 'client' }), { ok: 'Linked to client' })}>
          <option value="">Choose a client…</option>${(clients || []).map((c) => html`<option value=${c.id}>${c.name}</option>`)}</select>
        <div class="faint" style="font-size:var(--fs-xs)">Linked contacts get automatic triage, footage intake and review links.</div></div>`}
    ${api.demo || store.get().boot?.settings?.environment !== 'production' ? html`<div class="side-sec"><span class="eyebrow">Rehearse</span><${Button} kind="lav" size="sm" icon="messages" onClick=${async () => { const t = await promptDialog({ title: `Simulate a message from ${contact.name}`, label: 'Test environment only. Runs the full inbound flow: triage, actions and reply drafts.', multiline: true, placeholder: 'Love #2! Can #1 start right at the joke? Also please stop using all caps.' }); if (t) act(() => api.post('/api/sandbox/simulate-inbound', { contactId: contact.id, body: t }), { sound: 'receive' }); }}>Simulate inbound message</${Button}></div>` : null}
    ${editing ? html`<${ContactEditor} contact=${contact} clients=${clients || []} onClose=${() => setEditing(false)} />` : null}
  </aside>`;
}

function ContactEditor({ contact, clients, onClose, onCreated }) {
  const [f, setF] = useState({ name: contact?.name || '', phone: contact?.phones?.[0] || '', email: contact?.emails?.[0] || '', role: contact?.role || 'client', clientId: contact?.clientId || '' });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const save = async () => {
    const body = { name: f.name, phones: f.phone ? [f.phone] : [], emails: f.email ? [f.email] : [], role: f.role, clientId: f.clientId || null };
    if (contact) { await act(() => api.patch(`/api/contacts/${contact.id}`, body), { ok: 'Contact saved' }); onClose(); }
    else { const c = await act(() => api.post('/api/contacts', body), { ok: 'Contact created' }); const convs = await api.get('/api/conversations'); onCreated?.(convs.find((x) => x.contactId === c.id)?.id); }
  };
  return html`<${Modal} title=${contact ? 'Edit contact' : 'New conversation'} icon="user" onClose=${onClose} footer=${html`<${Button} kind="ghost" onClick=${onClose}>Cancel</${Button}><${Button} kind="primary" disabled=${!f.name || (!f.phone && !f.email)} onClick=${save}>${contact ? 'Save' : 'Create'}</${Button}>`}>
    <div class="form-grid">
      <${Field} label="Name" id="c-name"><input id="c-name" class="input" value=${f.name} onInput=${set('name')} autofocus /></${Field}>
      <${Field} label="Role" id="c-role"><select id="c-role" class="select" value=${f.role} onChange=${set('role')}><option value="client">Client</option><option value="prospect">Prospect</option><option value="other">Other</option></select></${Field}>
      <${Field} label="Mobile number" id="c-phone"><input id="c-phone" class="input" value=${f.phone} onInput=${set('phone')} placeholder="(203) 555-0142" /></${Field}>
      <${Field} label="Email" id="c-email"><input id="c-email" class="input" value=${f.email} onInput=${set('email')} placeholder="name@example.com" /></${Field}>
      <${Field} label="Client workspace" id="c-client"><select id="c-client" class="select" value=${f.clientId} onChange=${set('clientId')}><option value="">None</option>${clients.map((c) => html`<option value=${c.id}>${c.name}</option>`)}</select></${Field}>
    </div>
    ${f.role === 'prospect' ? html`<div class="notice" style="margin-top:14px"><${Icon} name="info" size=${16} />The first message to a prospect always waits for a founder to approve it.</div>` : null}
  </${Modal}>`;
}

function NewConversation({ onClose, onCreated }) {
  const { data: clients } = useApi('/api/clients', []);
  return html`<${ContactEditor} clients=${clients || []} onClose=${onClose} onCreated=${onCreated} />`;
}
