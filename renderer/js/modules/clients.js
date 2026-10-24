// Clients: CRM and each client's isolated workspace (profile, memory, style, schedule, footage, billing, portal).
import { html, useRoute, useState, useEffect, useStore, useApi, navigate, Button, Toggle, Seg, Tabs, Field, Empty, Loading, Avatar, StatusBadge, Modal, act, toast, confirmDialog, promptDialog } from '../lib/ui.js';
import { api } from '../lib/api.js';
import { Icon } from '../lib/icons.js';
import { money, dateTime, ago, dur, PLATFORM_LABEL } from '../lib/format.js';
import { QuotaBar } from './cards.js';

export function Clients() {
  const route = useRoute();
  const id = route.path.split('/')[2];
  return id ? html`<${ClientWorkspace} key=${id} id=${id} />` : html`<${ClientList} />`;
}

function ClientList() {
  const { data, loading } = useApi('/api/clients', ['clients', 'clips', 'posts']);
  const [creating, setCreating] = useState(false); const [removing, setRemoving] = useState(null);
  const [filter, setFilter] = useState('active');
  const list = (data || []).filter((c) => filter === 'all' || (filter === 'active' ? c.status === 'active' : c.status !== 'active'));
  const mrr = (data || []).filter((c) => c.status === 'active').reduce((t, c) => t + (c.monthly || 0), 0);
  const isOwner = useStore((s) => s.boot?.user?.role === 'owner');
  return html`<div class="page">
    <div class="page-head"><div class="grow"><h1>Clients</h1><div class="sub">${(data || []).filter((c) => c.status === 'active').length} active · ${money(mrr)} monthly recurring</div></div>
      <${Seg} value=${filter} onChange=${setFilter} options=${[{ value: 'active', label: 'Active' }, { value: 'other', label: 'Leads & past' }, { value: 'all', label: 'All' }]} />
      ${isOwner ? html`<${Button} kind="primary" icon="plus" onClick=${() => setCreating(true)}>New client</${Button}>` : null}</div>
    ${loading ? html`<${Loading} />` : !list.length ? html`<div class="panel"><${Empty} icon="clients" title="No clients here" action=${isOwner ? html`<${Button} kind="soft" icon="plus" onClick=${() => setCreating(true)}>Add your first client</${Button}>` : null}>Each client gets an isolated workspace: their own footage, style, memory, schedule and portal link.</${Empty}></div>` : html`
      <div class="panel"><div class="table-wrap"><table class="table"><thead><tr><th>Client</th><th>Type</th><th>Status</th><th>Production</th><th>Next ${2} days</th><th class="num">Retainer</th><th>Approval</th>${isOwner ? html`<th></th>` : null}</tr></thead><tbody>
        ${list.map((c) => html`<tr class="click" onClick=${() => navigate(`/clients/${c.id}`)}>
          <td><div class="row"><${Avatar} name=${c.name} size="sm" /><b>${c.name}</b></div></td>
          <td><span class=${'badge ' + (c.type === 'political' ? 'slate' : 'teal')}>${c.type === 'political' ? 'Political' : 'Creator'}</span></td>
          <td><${StatusBadge} status=${c.status} /></td>
          <td>${c.schedule?.autopilot ? html`<span class="badge moss"><${Icon} name="bolt" size=${11} />${c.schedule.shortsPerDay}/day</span>` : html`<span class="faint">Manual</span>`}</td>
          <td>${c.quota ? html`<${QuotaBar} q=${c.quota} />` : html`<span class="faint">—</span>`}</td>
          <td class="num">${money(c.monthly)}</td>
          <td class="muted">${{ founder: 'Founder', 'founder+client': 'Founder + client', auto: 'Auto after QC' }[c.approval?.mode]}</td>
          ${isOwner ? html`<td class="num" onClick=${(e) => e.stopPropagation()}><${Button} size="sm" kind="ghost" icon="trash" title=${`Remove ${c.name}`} onClick=${() => setRemoving(c)} /></td>` : null}</tr>`)}
      </tbody></table></div></div>`}
    ${creating ? html`<${NewClient} onClose=${() => setCreating(false)} />` : null}
    ${removing ? html`<${RemoveClient} c=${removing} onClose=${() => setRemoving(null)} />` : null}
  </div>`;
}

/** Remove a client: archive (hidden from Active, everything kept, can be brought back) or delete for good. */
function RemoveClient({ c, onClose, after }) {
  const archive = () => act(() => api.del(`/api/clients/${c.id}?mode=archive`), { ok: `${c.name} archived. Find it under "Leads & past".` }).then(() => { onClose(); after?.(); });
  const del = async () => {
    if (!(await confirmDialog({ title: `Delete ${c.name} for good?`, text: 'The client, its footage list, clips, posts, approvals and contacts are removed from Euclidean. Video files stay on your PC. This cannot be undone.', confirm: 'Delete for good' }))) return;
    act(() => api.del(`/api/clients/${c.id}?mode=delete`), { ok: `${c.name} deleted` }).then(() => { onClose(); after?.(); navigate('/clients'); });
  };
  return html`<${Modal} title=${`Remove ${c.name}`} icon="clients" onClose=${onClose} footer=${html`<${Button} kind="ghost" onClick=${onClose}>Cancel</${Button}><${Button} kind="soft" onClick=${archive}>Archive</${Button}><${Button} kind="coral" icon="trash" onClick=${del}>Delete for good</${Button}>`}>
    <div class="col" style="gap:8px"><div><b>Archive</b> hides them from your active clients and stops their production and posting. Everything is kept, and you can make them active again any time.</div>
    <div><b>Delete for good</b> removes the client and all of its records from Euclidean.</div></div></${Modal}>`;
}

function NewClient({ onClose }) {
  const [f, setF] = useState({ name: '', type: 'creator', amount: '', perDay: 3, contactName: '', phone: '', email: '' });
  const set = (k) => (e) => setF({ ...f, [k]: e.target ? e.target.value : e });
  const create = async () => {
    const slots = { 1: ['12:00'], 2: ['11:00', '18:00'], 3: ['10:00', '14:00', '19:00'], 4: ['09:00', '12:30', '16:00', '19:30'], 5: ['08:30', '11:30', '14:30', '17:30', '20:30'], 6: ['08:00', '10:30', '13:15', '15:45', '18:30', '21:00'] }[f.perDay] || ['10:00', '14:00', '19:00'];
    const c = await act(() => api.post('/api/clients', { name: f.name, type: f.type, retainer: { amount: Number(f.amount) || 0, interval: 'monthly', billingDay: 1 }, schedule: { shortsPerDay: Number(f.perDay), slots, autopilot: false } }), { ok: 'Client created' });
    if (f.contactName && (f.phone || f.email)) await api.post('/api/contacts', { name: f.contactName, phone: f.phone, email: f.email, role: 'client', clientId: c.id });
    navigate(`/clients/${c.id}`);
  };
  return html`<${Modal} title="New client" icon="clients" onClose=${onClose} footer=${html`<${Button} kind="ghost" onClick=${onClose}>Cancel</${Button}><${Button} kind="primary" disabled=${!f.name} onClick=${create}>Create workspace</${Button}>`}>
    <div class="col" style="gap:14px">
      <div class="form-grid"><${Field} label="Name" id="nc-name"><input id="nc-name" class="input" value=${f.name} onInput=${set('name')} placeholder="Stringer Media" autofocus /></${Field}>
        <${Field} label="Monthly retainer (USD)" id="nc-amt"><input id="nc-amt" class="input tnum" type="number" value=${f.amount} onInput=${set('amount')} placeholder="949" /></${Field}></div>
      <div class="field"><span class="label">Type</span><${Seg} value=${f.type} onChange=${set('type')} options=${[{ value: 'creator', label: 'Creator' }, { value: 'political', label: 'Political' }]} />
        <div class="hint">${f.type === 'political' ? 'Political content always gets founder and client approval before anything is published.' : 'Creators can later be switched to auto-approve after technical QC.'}</div></div>
      <div class="field"><span class="label">Shorts per day</span><div class="chips">${[1, 2, 3, 4, 5, 6].map((n) => html`<button class=${'chip' + (Number(f.perDay) === n ? ' on' : '')} onClick=${() => setF({ ...f, perDay: n })}>${n}</button>`)}</div></div>
      <div class="divider" /><div class="eyebrow">Main contact</div>
      <div class="form-grid"><${Field} label="Name" id="nc-cn"><input id="nc-cn" class="input" value=${f.contactName} onInput=${set('contactName')} /></${Field}>
        <${Field} label="Mobile" id="nc-ph"><input id="nc-ph" class="input" value=${f.phone} onInput=${set('phone')} /></${Field}>
        <${Field} label="Email" id="nc-em"><input id="nc-em" class="input" value=${f.email} onInput=${set('email')} /></${Field}></div>
    </div></${Modal}>`;
}

function ClientWorkspace({ id }) {
  const { data: c, reload } = useApi(`/api/clients/${id}`, ['clients', 'assets', 'clips', 'posts', 'contacts']);
  const [tab, setTab] = useState('overview'); const [removing, setRemoving] = useState(false);
  const isOwner = useStore((s) => s.boot?.user?.role === 'owner');
  if (!c) return html`<div class="page"><${Loading} /></div>`;
  const patch = (body, ok = 'Saved') => act(() => api.patch(`/api/clients/${id}`, body), { ok }).then(reload);
  return html`<div class="page">
    <div class="page-head"><${Button} kind="ghost" size="sm" icon="chevronLeft" title="All clients" onClick=${() => navigate('/clients')} /><${Avatar} name=${c.name} size="lg" />
      <div class="grow"><h1>${c.name}</h1><div class="row" style="margin-top:4px"><span class=${'badge ' + (c.type === 'political' ? 'slate' : 'teal')}>${c.type === 'political' ? 'Political' : 'Creator'}</span>${isOwner ? html`<select class="select sm" style="width:auto;height:26px" value=${c.status} title="Change status" aria-label="Client status" onChange=${(e) => patch({ status: e.target.value }, `Status: ${e.target.value}`)}>${['active', 'lead', 'paused', 'churned', 'archived'].map((x) => html`<option value=${x}>${x[0].toUpperCase() + x.slice(1)}</option>`)}</select>` : html`<${StatusBadge} status=${c.status} />`}${c.schedule?.autopilot ? html`<span class="badge moss"><${Icon} name="bolt" size=${11} />Autopilot · ${c.schedule.shortsPerDay}/day</span>` : null}</div></div>
      ${isOwner ? html`<${Button} kind="soft" icon="finance" title="How much this client pays you" onClick=${async () => { const v = await promptDialog({ title: `How much does ${c.name} pay you?`, label: `US dollars per ${c.retainer?.interval === 'weekly' ? 'week' : 'month'}`, value: String(c.retainer?.amount || ''), confirm: 'Save' }); if (v != null && v !== '') patch({ retainer: { ...(c.retainer || {}), amount: Number(String(v).replace(/[^\d.]/g, '')) || 0, interval: c.retainer?.interval || 'monthly' } }, 'Saved'); }}>${c.retainer?.amount ? `${money(c.retainer.amount)} / ${c.retainer.interval === 'weekly' ? 'week' : 'month'}` : 'Add monthly revenue'}</${Button}>` : null}
      <${Button} kind="ghost" icon="production" onClick=${() => { try { localStorage.setItem('eu.prodClient', c.id); } catch { /* ignore */ } navigate('/production'); }}>Production</${Button}>
      ${isOwner ? html`<${Button} kind="ghost" icon="trash" title="Archive or delete this client" onClick=${() => setRemoving(true)}>Remove</${Button}>` : null}
      <${Button} kind="soft" icon="link" onClick=${() => { navigator.clipboard?.writeText(c.portalUrl).then(() => toast('Portal link copied', { kind: 'ok' })).catch(() => promptDialog({ title: 'Client portal link', value: c.portalUrl, confirm: 'Done' })); }}>Copy portal link</${Button}>
    </div>
    <${Tabs} value=${tab} onChange=${setTab} tabs=${[{ value: 'overview', label: 'Overview' }, { value: 'schedule', label: 'Schedule & platforms' }, { value: 'style', label: 'Captions & graphics' }, { value: 'memory', label: 'Profile & memory' }, { value: 'footage', label: 'Footage & sources' }, { value: 'contacts', label: 'Contacts' }, ...(isOwner ? [{ value: 'billing', label: 'Billing & accounts' }] : [])]} />
    ${tab === 'overview' ? html`<${Overview} c=${c} />` : tab === 'schedule' ? html`<${Schedule} c=${c} patch=${patch} />` : tab === 'style' ? html`<${StyleEditor} c=${c} patch=${patch} />` : tab === 'memory' ? html`<${Memory} c=${c} patch=${patch} reload=${reload} />` : tab === 'footage' ? html`<${Footage} c=${c} patch=${patch} />` : tab === 'contacts' ? html`<${Contacts} c=${c} reload=${reload} />` : html`<${Billing} c=${c} patch=${patch} reload=${reload} />`}
    ${removing ? html`<${RemoveClient} c=${c} onClose=${() => setRemoving(false)} after=${reload} />` : null}
  </div>`;
}

function Overview({ c }) {
  const q = c.quota;
  const { data: clips } = useApi(`/api/clips?clientId=${c.id}&limit=8`, ['clips']);
  const { data: posts } = useApi(`/api/posts?clientId=${c.id}&status=scheduled`, ['posts']);
  return html`<div class="col" style="gap:14px">
    ${q ? html`<div class="grid c4">${[['Posted today', q.postedToday, `of ${c.schedule.shortsPerDay} planned`], ['Scheduled', q.scheduled, `of ${q.slotsAhead} slots in ${c.schedule.bufferDays || 2} days`], ['Waiting on review', q.inReview, q.inReview ? 'Open Approvals' : 'Nothing waiting'], ['Unused footage', q.unusedFootage, q.unusedFootage ? 'files ready for clips' : 'Ask for more footage']].map(([l, v, d]) => html`<div class="panel kpi"><div class="eyebrow">${l}</div><div class="v">${v}</div><div class="d">${d}</div></div>`)}</div>` : null}
    <div class="grid c2">
      <div class="panel"><div class="panel-head"><h4 class="grow">Up next</h4><a href="#/calendar">Calendar</a></div><div class="list">${(posts || []).sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt)).slice(0, 7).map((p) => html`<div class="list-row"><span class="tnum muted" style="width:130px">${dateTime(p.scheduledAt)}</span><span class="grow ellipsis">${p.title}</span><span class="faint" style="font-size:var(--fs-xs)">${p.platforms.length} platforms</span></div>`)}${!(posts || []).length ? html`<div class="list-row faint">Nothing scheduled</div>` : null}</div></div>
      <div class="panel"><div class="panel-head"><h4 class="grow">Recent clips</h4><a href="#/production">Production</a></div><div class="list">${(clips || []).map((x) => html`<div class="list-row click" onClick=${() => navigate(`/production?clip=${x.id}`)}><span class="tnum faint" style="width:40px">#${x.ref}</span><span class="grow ellipsis">${x.title}</span><${StatusBadge} status=${x.status} /></div>`)}${!(clips || []).length ? html`<div class="list-row faint">No clips yet</div>` : null}</div></div>
    </div></div>`;
}

const ALL_PLATFORMS = ['tiktok', 'instagram', 'youtube', 'facebook', 'twitter', 'threads', 'linkedin'];
function Schedule({ c, patch }) {
  const [s, setS] = useState(c.schedule);
  const [ap, setAp] = useState(c.approval);
  const [prod, setProd] = useState(c.production);
  const dirty = JSON.stringify([s, ap, prod]) !== JSON.stringify([c.schedule, c.approval, c.production]);
  const setSlot = (i, v) => { const slots = s.slots.slice(); slots[i] = v; setS({ ...s, slots }); };
  return html`<div class="col" style="gap:14px;max-width:920px">
    <div class="panel pad col" style="gap:14px">
      <div class="row"><div class="grow"><h3>Autopilot</h3><div class="muted" style="font-size:var(--fs-sm)">Keeps the next ${s.bufferDays || 2} days of slots filled: finds clips in unused footage, renders them and queues them for approval.</div></div><${Toggle} on=${s.autopilot} label="Autopilot" onChange=${(v) => setS({ ...s, autopilot: v })} /></div>
      <div class="form-grid">
        <${Field} label="Shorts per day" id="sc-n"><input id="sc-n" class="input tnum" type="number" min="0" max="24" value=${s.shortsPerDay} onInput=${(e) => { const n = Math.max(0, Math.min(24, Number(e.target.value))); const slots = s.slots.slice(0, n); while (slots.length < n) slots.push('12:00'); setS({ ...s, shortsPerDay: n, slots }); }} /></${Field}>
        <${Field} label="Days to keep filled" id="sc-buf"><input id="sc-buf" class="input tnum" type="number" min="1" max="7" value=${s.bufferDays || 2} onInput=${(e) => setS({ ...s, bufferDays: Number(e.target.value) })} /></${Field}>
        <${Field} label="Timezone" id="sc-tz"><input id="sc-tz" class="input" value=${s.timezone} onInput=${(e) => setS({ ...s, timezone: e.target.value })} /></${Field}>
      </div>
      <div class="field"><span class="label">Posting times</span><div class="row wrap">${s.slots.map((t, i) => html`<input type="time" class="input tnum" style="width:120px" value=${t} onInput=${(e) => setSlot(i, e.target.value)} aria-label=${`Slot ${i + 1}`} />`)}</div></div>
      <div class="field"><span class="label">Crosspost to</span><div class="chips">${ALL_PLATFORMS.map((p) => html`<button class=${'chip' + (s.platforms.includes(p) ? ' on' : '')} onClick=${() => setS({ ...s, platforms: s.platforms.includes(p) ? s.platforms.filter((x) => x !== p) : [...s.platforms, p] })}>${s.platforms.includes(p) ? html`<${Icon} name="check" size=${13} />` : null}${PLATFORM_LABEL[p]}</button>`)}</div></div>
    </div>
    <div class="panel pad col" style="gap:12px">
      <h3>Approval</h3>
      <${Seg} value=${ap.mode} onChange=${(v) => setAp({ ...ap, mode: v })} options=${[{ value: 'founder', label: 'Founder approves' }, { value: 'founder+client', label: 'Founder, then client' }, ...(c.type === 'political' ? [] : [{ value: 'auto', label: 'Auto after QC' }])]} />
      <div class="muted" style="font-size:var(--fs-sm)">${ap.mode === 'auto' ? 'Clips that pass technical QC are approved and scheduled without a person. Spot-check from Production.' : ap.mode === 'founder+client' ? 'After a founder approves, the client gets one batched message with a review link. Replies like "approve all" or "change #2" are handled automatically.' : 'A founder approves each clip before it is scheduled.'}${c.type === 'political' ? ' Political clients cannot use auto-approval.' : ''}</div>
      ${ap.mode === 'founder+client' ? html`<div class="row"><span class="label">Notify the client by</span><${Seg} value=${ap.clientChannel} onChange=${(v) => setAp({ ...ap, clientChannel: v })} options=${[{ value: 'sms', label: 'Text' }, { value: 'email', label: 'Email' }]} /></div>` : null}
    </div>
    <div class="panel pad col" style="gap:12px">
      <h3>Editing defaults</h3>
      <div class="row wrap" style="gap:20px">
        <div class="col" style="gap:5px"><span class="label">Reframe to 9:16</span><${Seg} value=${prod.reframe} onChange=${(v) => setProd({ ...prod, reframe: v })} options=${[{ value: 'face', label: 'Track the speaker' }, { value: 'smart-blur', label: 'Blurred fill' }, { value: 'crop', label: 'Crop' }, { value: 'fit', label: 'Fit' }]} /></div>
        <div class="col" style="gap:5px"><span class="label">Clips per footage file</span><input class="input tnum" style="width:90px" type="number" min="1" max="12" value=${prod.clipsPerFootage} onInput=${(e) => setProd({ ...prod, clipsPerFootage: Number(e.target.value) })} aria-label="Clips per footage" /></div>
        <div class="row"><${Toggle} on=${prod.silenceCut !== false} label="Jump cuts" onChange=${(v) => setProd({ ...prod, silenceCut: v })} /><span>Remove pauses</span></div>
        <div class="row"><${Toggle} on=${prod.retakeCut !== false} label="Cut retakes" onChange=${(v) => setProd({ ...prod, retakeCut: v })} /><span>Cut repeated takes and false starts (keeps the last take)</span></div>
        <div class="row"><${Toggle} on=${prod.punchIns !== false} label="Punch-ins" onChange=${(v) => setProd({ ...prod, punchIns: v })} /><span>AI punch-in zooms</span></div>
      </div>
    </div>
    <div class="row"><${Button} kind="primary" disabled=${!dirty} onClick=${() => patch({ schedule: s, approval: ap, production: prod })}>Save changes</${Button}>${dirty ? html`<${Button} kind="ghost" onClick=${() => { setS(c.schedule); setAp(c.approval); setProd(c.production); }}>Discard</${Button}>` : null}</div>
  </div>`;
}

// Caption preview mirrors the ASS style the renderer burns in (font, case, colours, outline, position, highlight).
export function CaptionPreview({ style, graphics, hook = 'THE HOOK GOES HERE', words = ['This', 'is', 'how', 'captions', 'look'] }) {
  const gr = graphics || {};
  const st = style; const k = 0.24; // preview scale vs 1080×1920
  const shown = words.slice(0, st.wordsPerLine || 3);
  const pos = st.position === 'upper' ? { top: '16%' } : st.position === 'center' ? { top: '50%', transform: 'translateY(-50%)' } : { bottom: '20%' };
  const txt = (w) => (st.uppercase ? w.toUpperCase() : w);
  const outline = `${Math.max(1, st.outlineWidth * k * 0.7)}px`;
  return html`<div class="phone" style="height:420px;background:linear-gradient(160deg,#5d6f7f,#2a3440 60%,#1d242c)">
    ${st.hook ? html`<div style=${{ position: 'absolute', top: '11%', left: '8%', right: '8%', textAlign: 'center' }}><span style=${{ background: st.hookBg, color: st.hookColor, font: `800 ${Math.round(st.size * 0.72 * k)}px Montserrat, "Segoe UI", sans-serif`, padding: '3px 7px', borderRadius: '3px', boxDecorationBreak: 'clone', WebkitBoxDecorationBreak: 'clone', lineHeight: 1.5 }}>${txt(hook)}</span></div>` : null}
    <div style=${{ position: 'absolute', left: '6%', right: '6%', textAlign: 'center', ...pos }}>
      <span style=${{ font: `${st.bold === false ? 600 : 800} ${Math.round(st.size * k)}px Montserrat, "Segoe UI", sans-serif`, color: st.primary, WebkitTextStroke: st.box ? '0' : `${outline} ${st.outline}`, paintOrder: 'stroke fill', background: st.box ? st.outline : 'transparent', padding: st.box ? '2px 6px' : 0, borderRadius: '4px', lineHeight: 1.25 }}>
        ${shown.map((w, i) => html`<span style=${{ color: st.highlightMode === 'word' && i === 1 ? st.highlight : st.primary, display: 'inline-block', transform: st.animation === 'pop' && i === 1 ? 'scale(1.1)' : 'none', margin: '0 0.12em' }}>${txt(w)}</span>`)}</span></div>
    ${gr.lowerThird?.enabled && gr.lowerThird.name ? html`<div style="position:absolute;left:7%;top:58%;display:flex;flex-direction:column;align-items:flex-start;gap:3px"><span style="background:rgba(21,24,27,0.88);color:#fff;font:800 13px Montserrat,sans-serif;padding:3px 6px;border-radius:2px">${gr.lowerThird.name}</span>${gr.lowerThird.title ? html`<span style=${{ background: st.highlight, color: '#15181b', font: '800 9.5px Montserrat,sans-serif', padding: '2px 5px', borderRadius: '2px' }}>${gr.lowerThird.title}</span>` : null}</div>` : null}
    ${gr.endCard?.enabled && gr.endCard.text ? html`<div style="position:absolute;left:0;right:0;top:40%;text-align:center"><span style=${{ background: st.hookBg, color: st.hookColor, font: '800 17px Montserrat,sans-serif', padding: '6px 10px', borderRadius: '3px' }}>${gr.endCard.text}</span><div style="color:rgba(255,255,255,0.7);font-size:9px;margin-top:8px">End card (last ${gr.endCard.seconds}s)</div></div>` : null}
    ${gr.progressBar?.enabled ? html`<div style=${{ position: 'absolute', left: 0, bottom: 0, height: '4px', width: '62%', background: gr.progressBar.color }} />` : null}
    ${gr.logo ? html`<div style=${{ position: 'absolute', [String(gr.logo.position || 'top-right').includes('top') ? 'top' : 'bottom']: String(gr.logo.position || '').includes('top') || !gr.logo.position ? '5%' : '8%', [String(gr.logo.position || 'top-right').includes('left') ? 'left' : 'right']: '5%', width: '30px', height: '30px', borderRadius: '8px', border: '1.5px dashed rgba(255,255,255,0.6)', display: 'grid', placeItems: 'center', color: 'rgba(255,255,255,0.75)', fontSize: '8px', opacity: gr.logo.opacity ?? 0.9 }}>LOGO</div>` : null}
  </div>`;
}

function StyleEditor({ c, patch }) {
  const boot = useStore((s) => s.boot);
  const [st, setSt] = useState({ ...boot.captionDefaults, ...c.style });
  const set = (k, v) => setSt({ ...st, [k]: v });
  const G0 = { lowerThird: { enabled: false, name: '', title: '', seconds: 4 }, endCard: { enabled: false, text: 'Follow for more', seconds: 2.5 }, progressBar: { enabled: false, color: '#6CC3B8' }, logo: { position: 'top-right', size: 150, opacity: 0.9 } };
  const g0 = { ...G0, ...(c.graphics || {}) };
  const [gr, setGr] = useState(g0);
  const setG = (sec, k, v) => setGr({ ...gr, [sec]: { ...gr[sec], [k]: v } });
  const dirty = JSON.stringify(st) !== JSON.stringify({ ...boot.captionDefaults, ...c.style }) || JSON.stringify(gr) !== JSON.stringify(g0);
  const PRESET_VALUES = { 'clean-pop': {}, boxed: { box: true, primary: '#111111', highlight: '#2E7D74', outline: '#FFFFFF', outlineWidth: 14, uppercase: false, size: 70 }, minimal: { uppercase: false, highlightMode: 'none', animation: 'none', size: 66, outlineWidth: 4, wordsPerLine: 5 }, news: { uppercase: true, highlight: '#E07A5F', wordsPerLine: 4, size: 72 }, 'karaoke-teal': { highlight: '#6CC3B8', wordsPerLine: 2, size: 96 } };
  return html`<div style="display:grid;grid-template-columns:minmax(0,1fr) 260px;gap:22px;max-width:960px">
    <div class="col" style="gap:14px">
      <div class="panel pad col" style="gap:12px"><h3>Preset</h3><div class="chips">${Object.keys(PRESET_VALUES).map((p) => html`<button class=${'chip' + (st.preset === p ? ' on' : '')} onClick=${() => setSt({ ...boot.captionDefaults, ...PRESET_VALUES[p], preset: p })}>${p.replace('-', ' ')}</button>`)}</div></div>
      <div class="panel pad col" style="gap:14px">
        <div class="form-grid">
          <${Field} label="Font" id="st-font"><select id="st-font" class="select" value=${st.font} onChange=${(e) => set('font', e.target.value)}><option>Montserrat</option><option>Anton</option><option>Arial</option></select></${Field}>
          <${Field} label=${`Size · ${st.size}px`} id="st-size"><input id="st-size" class="range" type="range" min="40" max="140" value=${st.size} onInput=${(e) => set('size', Number(e.target.value))} /></${Field}>
          <${Field} label=${`Words per line · ${st.wordsPerLine}`} id="st-wpl"><input id="st-wpl" class="range" type="range" min="1" max="6" value=${st.wordsPerLine} onInput=${(e) => set('wordsPerLine', Number(e.target.value))} /></${Field}>
          <${Field} label=${`Outline · ${st.outlineWidth}`} id="st-ow"><input id="st-ow" class="range" type="range" min="0" max="16" value=${st.outlineWidth} onInput=${(e) => set('outlineWidth', Number(e.target.value))} /></${Field}>
        </div>
        <div class="row wrap" style="gap:18px">${[['primary', 'Text'], ['highlight', 'Active word'], ['outline', 'Outline / box'], ['hookBg', 'Hook background'], ['hookColor', 'Hook text']].map(([k, l]) => html`<label class="row" style="gap:6px;font-size:var(--fs-sm)"><input type="color" value=${st[k]} onInput=${(e) => set(k, e.target.value.toUpperCase())} />${l}</label>`)}</div>
        <div class="row wrap" style="gap:18px">
          <div class="col" style="gap:5px"><span class="label">Position</span><${Seg} value=${st.position} onChange=${(v) => set('position', v)} options=${[{ value: 'upper', label: 'Top' }, { value: 'center', label: 'Middle' }, { value: 'lower', label: 'Lower third' }]} /></div>
          <div class="col" style="gap:5px"><span class="label">Highlight</span><${Seg} value=${st.highlightMode} onChange=${(v) => set('highlightMode', v)} options=${[{ value: 'word', label: 'Active word' }, { value: 'none', label: 'None' }]} /></div>
        </div>
        <div class="row wrap" style="gap:18px">${[['uppercase', 'All caps'], ['animation', 'Pop animation'], ['box', 'Boxed'], ['hook', 'Show hook'], ['punctuation', 'Keep punctuation']].map(([k, l]) => html`<div class="row"><${Toggle} on=${k === 'animation' ? st.animation === 'pop' : !!st[k]} label=${l} onChange=${(v) => set(k, k === 'animation' ? (v ? 'pop' : 'none') : v)} /><span style="font-size:var(--fs-sm)">${l}</span></div>`)}</div>
      </div>
      <div class="panel pad col" style="gap:14px"><h3>Graphics template</h3><div class="muted" style="font-size:var(--fs-sm);margin-top:-8px">Applied to every short for ${c.name}.</div>
        <div class="col" style="gap:8px"><div class="row"><${Toggle} on=${gr.lowerThird.enabled} label="Lower third" onChange=${(v) => setG('lowerThird', 'enabled', v)} /><b>Lower third</b><span class="faint" style="font-size:var(--fs-sm)">Name and title after the hook</span></div>
          ${gr.lowerThird.enabled ? html`<div class="form-grid"><${Field} label="Name" id="g-ln"><input id="g-ln" class="input" value=${gr.lowerThird.name} onInput=${(e) => setG('lowerThird', 'name', e.target.value)} placeholder="Jordan Reyes" /></${Field}><${Field} label="Title" id="g-lt"><input id="g-lt" class="input" value=${gr.lowerThird.title} onInput=${(e) => setG('lowerThird', 'title', e.target.value)} placeholder="Stringer Media" /></${Field}><${Field} label=${`On screen · ${gr.lowerThird.seconds}s`} id="g-ls"><input id="g-ls" class="range" type="range" min="2" max="8" step="0.5" value=${gr.lowerThird.seconds} onInput=${(e) => setG('lowerThird', 'seconds', Number(e.target.value))} /></${Field}></div>` : null}</div>
        <div class="col" style="gap:8px"><div class="row"><${Toggle} on=${gr.endCard.enabled} label="End card" onChange=${(v) => setG('endCard', 'enabled', v)} /><b>End card</b><span class="faint" style="font-size:var(--fs-sm)">Call to action over the last seconds</span></div>
          ${gr.endCard.enabled ? html`<div class="form-grid"><${Field} label="Text" id="g-et"><input id="g-et" class="input" value=${gr.endCard.text} onInput=${(e) => setG('endCard', 'text', e.target.value)} /></${Field}><${Field} label=${`Length · ${gr.endCard.seconds}s`} id="g-es"><input id="g-es" class="range" type="range" min="1.5" max="5" step="0.5" value=${gr.endCard.seconds} onInput=${(e) => setG('endCard', 'seconds', Number(e.target.value))} /></${Field}></div>` : null}</div>
        <div class="row wrap" style="gap:16px"><div class="row"><${Toggle} on=${gr.progressBar.enabled} label="Progress bar" onChange=${(v) => setG('progressBar', 'enabled', v)} /><b>Progress bar</b></div>${gr.progressBar.enabled ? html`<label class="row" style="gap:6px;font-size:var(--fs-sm)"><input type="color" value=${gr.progressBar.color} onInput=${(e) => setG('progressBar', 'color', e.target.value.toUpperCase())} />Color</label>` : null}</div>
        <div class="row wrap" style="gap:16px"><b>Logo</b><${Seg} value=${gr.logo.position} onChange=${(v) => setG('logo', 'position', v)} options=${[{ value: 'top-left', label: 'Top left' }, { value: 'top-right', label: 'Top right' }, { value: 'bottom-left', label: 'Bottom left' }, { value: 'bottom-right', label: 'Bottom right' }]} />
          <label class="row" style="gap:6px;font-size:var(--fs-sm)">Opacity<input class="range" style="width:110px" type="range" min="0.3" max="1" step="0.05" value=${gr.logo.opacity} onInput=${(e) => setG('logo', 'opacity', Number(e.target.value))} /></label>
          <span class="faint" style="font-size:var(--fs-sm)">${c.production?.logoPath ? 'Logo uploaded' : 'Upload a PNG logo below'}</span>
          <label class="btn sm" style="cursor:pointer"><input type="file" accept="image/png" hidden onChange=${(e) => { const f = e.target.files[0]; if (f) act(() => api.upload(`/api/clients/${c.id}/upload`, [f], { kind: 'logo' }), { ok: 'Logo saved' }); }} />Upload logo</label></div>
      </div>
      <div class="row"><${Button} kind="primary" disabled=${!dirty} onClick=${() => patch({ style: st, graphics: gr }, 'Saved. Applies to the next render.')}>Save style and graphics</${Button}><span class="faint" style="font-size:var(--fs-sm)">Applies to every future render for ${c.name}. Re-render a clip to update it.</span></div>
    </div>
    <div class="col" style="gap:8px;align-items:center;position:sticky;top:0"><span class="eyebrow">Preview</span><${CaptionPreview} style=${st} graphics=${gr} /></div>
  </div>`;
}

function Memory({ c, patch, reload }) {
  const [p, setP] = useState(c.profile);
  const dirty = JSON.stringify(p) !== JSON.stringify(c.profile);
  const add = async () => { const t = await promptDialog({ title: `Remember for ${c.name}`, label: 'Every agent and render uses this from now on.', placeholder: 'Never use the word "slay". Keep hooks under six words.', confirm: 'Remember' }); if (t) act(() => api.post(`/api/clients/${c.id}/memory`, { text: t }), { ok: 'Saved to client memory' }).then(reload); };
  return html`<div class="grid c2" style="align-items:start">
    <div class="panel pad col" style="gap:12px"><h3>Profile</h3><div class="muted" style="font-size:var(--fs-sm)">Given to every agent working on ${c.name}. Never shared with other clients.</div>
      ${[['about', 'About', 'What they do, what the channel is about'], ['audience', 'Audience', 'Who watches'], ['voice', 'Voice and tone', 'Dry, fast, never corny'], ['topics', 'Core topics', 'Local politics, zoning, school boards'], ['avoid', 'Never do', 'No clickbait claims. No profanity in captions.'], ['hashtags', 'Standard hashtags', '#localnews #ct']].map(([k, l, ph]) => html`<${Field} label=${l} id=${'pf-' + k}><textarea id=${'pf-' + k} class="textarea" rows="2" placeholder=${ph} value=${p[k] || ''} onInput=${(e) => setP({ ...p, [k]: e.target.value })} /></${Field}>`)}
      <div><${Button} kind="primary" disabled=${!dirty} onClick=${() => patch({ profile: p })}>Save profile</${Button}></div></div>
    <div class="panel"><div class="panel-head"><div class="grow"><h3>Client memory</h3><div class="muted" style="font-size:var(--fs-sm)">Preferences learned from feedback. Style changes apply automatically.</div></div><${Button} kind="gold" size="sm" icon="plus" onClick=${add}>Add</${Button}></div>
      <div class="list">${(c.memory || []).slice().reverse().map((m) => html`<div class="list-row" style="align-items:flex-start">
        <${Icon} name="pin" size=${15} style=${{ color: m.active === false ? 'var(--ink-3)' : 'var(--gold)', marginTop: '2px', flex: 'none' }} />
        <div class="grow" style=${{ opacity: m.active === false ? 0.5 : 1 }}><div class="selectable">${m.text}</div><div class="faint" style="font-size:var(--fs-xs);margin-top:2px">${m.source} · ${ago(m.at)}${m.style ? ` · style: ${Object.entries(m.style).map(([k, v]) => `${k}=${v}`).join(', ')}` : ''}</div></div>
        <${Toggle} on=${m.active !== false} label="Active" onChange=${(v) => act(() => api.patch(`/api/clients/${c.id}/memory/${m.id}`, { active: v }), { sound: null }).then(reload)} />
        <${Button} size="sm" kind="ghost" icon="trash" title="Forget" onClick=${() => act(() => api.del(`/api/clients/${c.id}/memory/${m.id}`), { ok: 'Forgotten', sound: 'tap' }).then(reload)} /></div>`)}
        ${!(c.memory || []).length ? html`<div class="list-row faint">Nothing remembered yet. When ${c.name} says something like "I hate all-caps subtitles", it's stored here and applied to every future video.</div>` : null}</div></div>
  </div>`;
}

function Footage({ c, patch }) {
  const [sources, setSources] = useState(c.sources || []);
  const dirty = JSON.stringify(sources) !== JSON.stringify(c.sources || []);
  return html`<div class="col" style="gap:14px">
    <div class="panel pad col" style="gap:12px"><div class="row"><div class="grow"><h3>Automatic footage sources</h3><div class="muted" style="font-size:var(--fs-sm)">New uploads on a source channel are downloaded and processed automatically (checked every 30 minutes; needs yt-dlp).</div></div>
      <${Button} kind="soft" size="sm" icon="plus" onClick=${() => setSources([...sources, { type: 'youtube_channel', value: '', label: '', auto: true }])}>Add YouTube channel</${Button}></div>
      ${sources.map((s, i) => html`<div class="row"><input class="input" style="flex:2" placeholder="Channel ID (starts with UC…)" value=${s.value} onInput=${(e) => { const x = sources.slice(); x[i] = { ...s, value: e.target.value.trim() }; setSources(x); }} aria-label="Channel ID" />
        <input class="input" style="flex:1" placeholder="Label" value=${s.label} onInput=${(e) => { const x = sources.slice(); x[i] = { ...s, label: e.target.value }; setSources(x); }} aria-label="Label" />
        <${Toggle} on=${s.auto} label="Auto import" onChange=${(v) => { const x = sources.slice(); x[i] = { ...s, auto: v }; setSources(x); }} /><${Button} size="sm" kind="ghost" icon="trash" title="Remove" onClick=${() => setSources(sources.filter((_, j) => j !== i))} /></div>`)}
      ${!sources.length ? html`<div class="faint" style="font-size:var(--fs-sm)">No sources. Footage can also arrive by upload, email attachment, the client portal, or a link pasted into their thread.</div>` : null}
      ${dirty ? html`<div><${Button} kind="primary" onClick=${() => patch({ sources })}>Save sources</${Button}></div>` : null}</div>
    <div class="panel"><div class="panel-head"><h4 class="grow">Footage library</h4><span class="faint" style="font-size:var(--fs-sm)">${(c.assets || []).length} files</span></div>
      <div class="table-wrap"><table class="table"><thead><tr><th>File</th><th>Length</th><th>Source</th><th>Transcript</th><th>Status</th><th>Added</th></tr></thead><tbody>
        ${(c.assets || []).map((a) => html`<tr><td class="ellipsis" style="max-width:300px">${a.name}</td><td class="tnum">${a.info ? dur(a.info.duration) : '—'}</td><td class="muted ellipsis" style="max-width:180px">${a.source}</td><td class="muted">${a.transcript ? `${a.transcript.words} words` : '—'}</td><td>${a.exhausted ? html`<span class="badge">Used up</span>` : html`<${StatusBadge} status=${a.status} />`}</td><td class="faint">${ago(a.createdAt)}</td></tr>`)}
        ${!(c.assets || []).length ? html`<tr><td colspan="6" class="faint">No footage yet</td></tr>` : null}</tbody></table></div></div>
  </div>`;
}

function Contacts({ c, reload }) {
  const add = async () => {
    const name = await promptDialog({ title: 'Add contact', label: 'Name', confirm: 'Next' }); if (!name) return;
    const phone = await promptDialog({ title: `Mobile number for ${name}`, label: 'Leave blank if none', confirm: 'Next' });
    const email = await promptDialog({ title: `Email for ${name}`, label: 'Leave blank if none', confirm: 'Add' });
    if (!phone && !email) return toast('A phone number or email is needed', { kind: 'warn' });
    act(() => api.post('/api/contacts', { name, phone, email, role: 'client', clientId: c.id }), { ok: 'Contact added' }).then(reload);
  };
  return html`<div class="panel"><div class="panel-head"><h4 class="grow">Contacts</h4><${Button} kind="soft" size="sm" icon="plus" onClick=${add}>Add contact</${Button}></div>
    <div class="list">${(c.contacts || []).map((p) => html`<div class="list-row"><${Avatar} name=${p.name} size="sm" /><div class="grow"><b>${p.name}</b>${c.primaryContactId === p.id ? html` <span class="badge teal">Primary</span>` : null}<div class="muted selectable" style="font-size:var(--fs-sm)">${[...(p.phones || []), ...(p.emails || [])].join(' · ')}</div></div>
      ${c.primaryContactId !== p.id ? html`<${Button} size="sm" kind="ghost" onClick=${() => act(() => api.patch(`/api/clients/${c.id}`, { primaryContactId: p.id }), { ok: 'Primary contact set' }).then(reload)}>Make primary</${Button}>` : null}
      <${Button} size="sm" kind="ghost" icon="messages" onClick=${async () => { const convs = await api.get('/api/conversations'); const cv = convs.find((x) => x.contactId === p.id); if (cv) navigate(`/messages/${cv.id}`); }}>Message</${Button}></div>`)}
      ${!(c.contacts || []).length ? html`<div class="list-row faint">No contacts. Add one so review links and updates have somewhere to go.</div>` : null}</div></div>`;
}

function Billing({ c, patch, reload }) {
  const [r, setR] = useState(c.retainer);
  const [status, setStatus] = useState(c.status);
  const [pkg, setPkg] = useState(c.package || '');
  const [ayr, setAyr] = useState('');
  const dirty = JSON.stringify([r, status, pkg]) !== JSON.stringify([c.retainer, c.status, c.package || '']);
  return html`<div class="grid c2" style="align-items:start">
    <div class="panel pad col" style="gap:12px"><h3>Contract</h3>
      <div class="form-grid">
        <${Field} label="Status" id="b-status"><select id="b-status" class="select" value=${status} onChange=${(e) => setStatus(e.target.value)}><option value="lead">Lead</option><option value="proposal">Proposal</option><option value="active">Active</option><option value="paused">Paused</option><option value="churned">Churned</option></select></${Field}>
        <${Field} label="Package" id="b-pkg"><input id="b-pkg" class="input" value=${pkg} onInput=${(e) => setPkg(e.target.value)} placeholder="Shorts · 6/day" /></${Field}>
        <${Field} label="Retainer (USD)" id="b-amt"><input id="b-amt" class="input tnum" type="number" value=${r.amount} onInput=${(e) => setR({ ...r, amount: Number(e.target.value) })} /></${Field}>
        <${Field} label="Billed" id="b-int"><select id="b-int" class="select" value=${r.interval} onChange=${(e) => setR({ ...r, interval: e.target.value })}><option value="weekly">Weekly</option><option value="monthly">Monthly</option><option value="quarterly">Quarterly</option><option value="annual">Annually</option></select></${Field}>
        <${Field} label="Billing day" id="b-day"><input id="b-day" class="input tnum" type="number" min="1" max="28" value=${r.billingDay} onInput=${(e) => setR({ ...r, billingDay: Number(e.target.value) })} /></${Field}>
        <${Field} label="Renewal date" id="b-ren"><input id="b-ren" class="input" type="date" value=${r.renewalDate || ''} onInput=${(e) => setR({ ...r, renewalDate: e.target.value })} /></${Field}>
      </div>
      <div><${Button} kind="primary" disabled=${!dirty} onClick=${() => patch({ retainer: r, status, package: pkg })}>Save contract</${Button}></div></div>
    <div class="panel pad col" style="gap:14px"><h3>Publishing accounts</h3>
      <div class="col" style="gap:6px"><div class="row"><b class="grow">Ayrshare profile</b>${c.hasAyrshareProfile ? html`<span class="badge moss">Linked</span>` : html`<span class="badge">Not linked</span>`}</div>
        <div class="muted" style="font-size:var(--fs-sm)">The client links their TikTok, Instagram, YouTube, Facebook and X to an Ayrshare profile; paste the profile key here so posts go to their accounts.</div>
        <div class="row"><input class="input" type="password" placeholder="Profile key" value=${ayr} onInput=${(e) => setAyr(e.target.value)} aria-label="Ayrshare profile key" /><${Button} kind="soft" disabled=${!ayr} onClick=${() => act(() => api.post(`/api/clients/${c.id}/credentials`, { ayrshareProfileKey: ayr }), { ok: 'Profile key saved (encrypted)' }).then(() => { setAyr(''); reload(); })}>Save</${Button}></div></div>
      <div class="divider" style="margin:0" />
      <div class="col" style="gap:6px"><div class="row"><b class="grow">YouTube (direct upload)</b>${c.youtubeConnected ? html`<span class="badge moss">${c.accounts?.youtube?.name || 'Connected'}</span>` : html`<span class="badge">Not connected</span>`}</div>
        <div class="muted" style="font-size:var(--fs-sm)">Signs in with Google in your browser and uploads Shorts straight to the client's channel. Needs a Google OAuth client in Settings.</div>
        <div><${Button} kind="soft" icon="external" onClick=${() => act(() => api.post(`/api/clients/${c.id}/youtube/connect`), { ok: 'Finish signing in in your browser' })}>${c.youtubeConnected ? 'Reconnect' : 'Connect YouTube'}</${Button}></div></div>
      <div class="divider" style="margin:0" />
      <div class="col" style="gap:6px"><b>Client portal</b><div class="selectable mono" style="font-size:12px;overflow-wrap:anywhere">${c.portalUrl}</div><div class="faint" style="font-size:var(--fs-xs)">Reachable from other devices only when LAN access or a public URL is set in Settings → General.</div></div>
    </div>
  </div>`;
}
