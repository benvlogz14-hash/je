// Outreach lanes (Creators / Politics): autopilot switches, the review bubbles, and lead lists.
import { html, useState, useEffect, useApi, navigate, Button, Field, Toggle, Progress, act, toast, confirmDialog, promptDialog, store } from '../lib/ui.js';
import { api } from '../lib/api.js';
import { Icon } from '../lib/icons.js';
import { ago } from '../lib/format.js';

const fmtN = (n) => (n == null ? '' : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n));

// ------------------------------------------------------------------ autopilot

export function Autopilot({ lane }) {
  const { data: st, reload } = useApi('/api/outreach/status', ['prospects', 'job', 'settings']);
  const boot = store.get().boot || {};
  const init = boot.settings?.outreach?.[lane] || {};
  const [v, setV] = useState({ scout: false, autoSend: false, scoutQueries: '', scoutPerDay: 15, sendPerDay: 50, warmupStart: 15, warmupStep: 10, scoutHour: 7, ...init });
  const [rules, setRules] = useState({ mailingAddress: boot.settings?.outreach?.mailingAddress || boot.settings?.political?.mailingAddress || '', exclusions: boot.settings?.outreach?.exclusions || '', callerPhone: boot.settings?.outreach?.callerPhone || '' });
  const [open, setOpen] = useState(false);
  const s = st?.[lane] || {};
  // Pick up changes made elsewhere (the scout chat, another window) unless the settings form is open.
  useEffect(() => { if (st?.[lane] && !open) setV((cur) => ({ ...cur, ...Object.fromEntries(Object.entries(st[lane]).filter(([k]) => k in cur || ['continuous', 'scoutEveryMin', 'maxLeadsPerDay', 'lessons', 'followUps', 'followUpDays', 'autoPackage'].includes(k))) })); }, [st, open, lane]);
  const save = (next = v) => act(() => api.patch('/api/settings', { outreach: { [lane]: next, ...rules } }), { ok: 'Saved' }).then((set) => { const b = store.get().boot; if (b && set) store.set({ boot: { ...b, settings: set } }); reload(); });
  const flip = async (k, on) => {
    if (k === 'autoSend' && on && !(await confirmDialog({ title: 'Turn on auto-send?', text: `Finished ${lane === 'political' ? 'packages' : 'emails'} that pass every safety check will send without review, up to ${Math.min(v.sendPerDay, v.warmupStart)} today and rising by ${v.warmupStep} a day to ${v.sendPerDay}. Anything that fails a check (no confirmed email, government address, contrast ad, exclusions, no mailing address) still waits for you. In Test mode emails go to your sandbox address.`, confirm: 'Turn on', kind: 'moss' }))) return;
    const next = { ...v, [k]: on }; setV(next); save(next);
  };
  const set = (k) => (e) => setV({ ...v, [k]: e.target.type === 'number' ? Number(e.target.value) : e.target.value });
  return html`<div class="panel pad col" style="gap:12px">
    <div class="row wrap" style="gap:14px">
      <div class="avatar" style="background:var(--moss-soft);color:var(--moss-ink)"><${Icon} name="robot" size=${17} /></div>
      <div class="grow"><h4>Autopilot</h4><div class="faint" style="font-size:var(--fs-xs)">${s.lastScout ? `Last scout ${ago(s.lastScout.at)}: "${s.lastScout.query}"` : 'No daily scout yet'}</div></div>
      <label class="row" style="gap:6px"><${Toggle} on=${!!v.scout} onChange=${(x) => flip('scout', x)} label="Daily scout" /><span>Daily scout</span></label>
      <label class="row" style="gap:6px"><${Toggle} on=${!!v.autoSend} onChange=${(x) => flip('autoSend', x)} label="Auto-send" /><span>Auto-send</span></label>
      <label class="row" style="gap:6px" title="Polite follow-ups in the same email thread for leads who haven't replied"><${Toggle} on=${!!v.followUps} onChange=${(x) => flip('followUps', x)} label="Follow-ups" /><span>Follow-ups</span></label>
      <${Button} size="sm" kind="ghost" onClick=${() => setOpen(!open)}>${open ? 'Hide settings' : 'Settings'}</${Button}>
    </div>
    <div class="grid c4" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px">
      ${[['Sent today', `${s.sentToday ?? 0} / ${s.capToday ?? '–'}`, null], ['Waiting for you', s.waiting ?? 0, `review-${lane}`], ['New leads today', `${s.leadsToday ?? 0}${v.continuous ? ` / ${v.maxLeadsPerDay ?? 60}` : ''}`, `new-${lane}`], ['Auto-send', v.autoSend ? (s.autoSendSince ? `on since ${new Date(s.autoSendSince).toLocaleDateString()}` : 'on') : s.graduated ? 'earned (auto-graduated)' : v.autoGraduate ? `${s.learning?.unchangedRate == null ? 0 : Math.round(s.learning.unchangedRate * 100)}% of ${Math.round((v.graduateAt ?? 0.9) * 100)}% needed` : 'off']].map(([k, val, to]) => html`<div class="panel pad" style=${{ padding: '10px 12px', cursor: to ? 'pointer' : 'default' }} title=${to ? 'Show them' : ''} onClick=${() => to && document.getElementById(to)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}><div class="faint" style="font-size:var(--fs-xs)">${k}${to ? ' ›' : ''}</div><b style="font-size:18px">${val}</b></div>`)}
    </div>
    ${!rules.mailingAddress ? html`<div class="notice gold"><${Icon} name="info" size=${16} />Add your mailing address in Settings below. The law (CAN-SPAM) requires it in every outreach email, and auto-send stays paused without it.</div>` : null}
    ${open ? html`<div class="col" style="gap:12px">
      <${Field} label="Saved searches (one per line; the daily scout uses the next one each day)" id=${`q-${lane}`}><textarea id=${`q-${lane}`} class="input" style="height:110px;font-family:inherit" value=${v.scoutQueries} onInput=${set('scoutQueries')} placeholder=${lane === 'political' ? 'Connecticut Democrats running for state house 2026\nConnecticut town council candidates 2026' : 'Political commentary YouTubers under 500K subscribers\nNews TikTok creators with no YouTube channel'} /></${Field}>
      <label class="row" style="gap:8px"><${Toggle} on=${!!v.autoPackage} onChange=${(x) => setV({ ...v, autoPackage: x })} label="Skip New prospects" /><span>Send new finds straight to ${lane === 'political' ? 'packages' : 'emails'} (skip the New prospects step)</span></label>
      <label class="row" style="gap:8px"><${Toggle} on=${!!v.continuous} onChange=${(x) => setV({ ...v, continuous: x })} label="Keep scouting" /><span>Keep scouting all day while the computer is on (not just once each morning)</span></label>
      <div class="form-grid">
        <${Field} label="Scout every (minutes)" id=${`se-${lane}`}><input id=${`se-${lane}`} class="input" type="number" min="10" max="1440" value=${v.scoutEveryMin ?? 30} onInput=${set('scoutEveryMin')} /></${Field}>
        <${Field} label="Most new leads per day" id=${`ml-${lane}`}><input id=${`ml-${lane}`} class="input" type="number" min="1" max="500" value=${v.maxLeadsPerDay ?? 60} onInput=${set('maxLeadsPerDay')} /></${Field}>
        <${Field} label="Leads per search" id=${`spd-${lane}`}><input id=${`spd-${lane}`} class="input" type="number" min="1" max="100" value=${v.scoutPerDay} onInput=${set('scoutPerDay')} /></${Field}>
      </div>
      <div class="form-grid">
        <${Field} label="Scout at (hour, 0-23)" id=${`sh-${lane}`}><input id=${`sh-${lane}`} class="input" type="number" min="0" max="23" value=${v.scoutHour} onInput=${set('scoutHour')} /></${Field}>
        <${Field} label="Most emails per day" hint="After warm-up" id=${`sp-${lane}`}><input id=${`sp-${lane}`} class="input" type="number" min="1" max="1000" value=${v.sendPerDay} onInput=${set('sendPerDay')} /></${Field}>
        <${Field} label="Warm-up: first day" id=${`ws-${lane}`}><input id=${`ws-${lane}`} class="input" type="number" min="1" max="500" value=${v.warmupStart} onInput=${set('warmupStart')} /></${Field}>
        <${Field} label="Warm-up: add per day" id=${`wst-${lane}`}><input id=${`wst-${lane}`} class="input" type="number" min="0" max="500" value=${v.warmupStep} onInput=${set('warmupStep')} /></${Field}>
      </div>
      <${Field} label="Follow up after (days since the first email, comma separated)" hint="A short follow-up in the same thread for leads who haven't replied. Sends on its own only when auto-send is on; otherwise it waits in Approvals. Anyone who replies, opts out or is skipped never gets one." id=${`fu-${lane}`}><input id=${`fu-${lane}`} class="input" value=${v.followUpDays ?? '4, 10'} onInput=${set('followUpDays')} placeholder="4, 10" /></${Field}>
      <label class="row" style="gap:8px;align-items:flex-start"><${Toggle} on=${!!v.autoGraduate} onChange=${(x) => setV({ ...v, autoGraduate: x })} label="Auto-graduate" /><span><b>Auto-graduate:</b> turn auto-send on by itself once you approve at least <input class="input" type="number" min="50" max="100" style="width:64px;height:26px;display:inline-block" value=${Math.round((v.graduateAt ?? 0.9) * 100)} onInput=${(e) => setV({ ...v, graduateAt: Number(e.target.value) / 100 })} />% of your last <input class="input" type="number" min="5" max="200" style="width:64px;height:26px;display:inline-block" value=${v.graduateWindow ?? 25} onInput=${set('graduateWindow')} /> drafts without changes. It switches back off if that drops. Every safety check still applies, and contrast ads always wait for you.</span></label>
      <${Field} label="Mailing address (shown at the bottom of every email)" id="ob-addr"><textarea id="ob-addr" class="input" style="height:64px;font-family:inherit" value=${rules.mailingAddress} onInput=${(e) => setRules({ ...rules, mailingAddress: e.target.value })} placeholder="Euclidean Media, 123 Main St, Hartford, CT 06103" /></${Field}>
      <${Field} label="Your phone number (for one-click calls, Twilio rings this first)" id="ob-ph"><input id="ob-ph" class="input" value=${rules.callerPhone} onInput=${(e) => setRules({ ...rules, callerPhone: e.target.value })} placeholder="+1 203 555 0100" /></${Field}>
      <${Field} label="Never contact (names, organisations or email domains, one per line)" id="ob-ex"><textarea id="ob-ex" class="input" style="height:80px;font-family:inherit" value=${rules.exclusions} onInput=${(e) => setRules({ ...rules, exclusions: e.target.value })} /></${Field}>
      <div class="row"><${Button} kind="primary" onClick=${() => save()}>Save autopilot settings</${Button}><span class="faint" style="font-size:var(--fs-xs)">Sending also respects quiet hours, the hourly limit and opt-outs (Settings → Messaging).</span></div>
    </div>` : null}
  </div>`;
}

// ------------------------------------------------------------------ review bubbles

/** Scouted leads land here with a short blurb; approve to make their package (or email), or skip. */
export function NewProspects({ lane }) {
  const { data, reload } = useApi(`/api/outreach/${lane}/new`, ['prospects']);
  const [picked, setPicked] = useState({}); const [open, setOpen] = useState(null);
  const list = data || []; const ids = Object.keys(picked).filter((k) => picked[k]);
  const go = (path, which, ok) => act(() => api.post(`/api/outreach/${lane}/new/${path}`, { ids: which }), { ok }).then(() => { setPicked({}); reload(); });
  const pol = lane === 'political';
  return html`<div class="col" style="gap:10px" id=${`new-${lane}`}>
    <div class="row wrap" style="gap:8px"><h4 class="grow">New prospects <span class="faint">${list.length}</span></h4>
      ${list.length ? html`<${Button} size="sm" kind="ghost" onClick=${() => setPicked(ids.length === list.length ? {} : Object.fromEntries(list.map((x) => [x.id, true])))}>${ids.length === list.length ? 'Clear' : 'Select all'}</${Button}>
      <${Button} size="sm" kind="ghost" disabled=${!ids.length} onClick=${() => go('skip', ids, 'Skipped')}>Skip</${Button}>
      <${Button} size="sm" kind="primary" icon="check" disabled=${!ids.length} onClick=${() => go('approve', ids, pol ? 'Making their packages' : 'Writing their emails')}>${pol ? 'Make packages' : 'Write emails'} (${ids.length})</${Button}>` : null}</div>
    ${!list.length ? html`<div class="panel pad faint">No new prospects. Scout finds land here with a short blurb, and you choose who gets a ${pol ? 'package' : 'pitch email'}.</div>` : html`<div class="grid c2" style="gap:10px">${list.map((x) => html`<div class="panel pad col" style=${{ gap: '6px', outline: picked[x.id] ? '2px solid var(--moss)' : 'none' }}>
      <div class="row" style="gap:8px"><input type="checkbox" checked=${!!picked[x.id]} onChange=${(e) => setPicked({ ...picked, [x.id]: e.target.checked })} aria-label=${`Select ${x.name}`} />
        <b class="grow" style="cursor:pointer" onClick=${() => setOpen(open === x.id ? null : x.id)}>${x.name}</b>${x.confidence ? html`<span class=${'badge ' + (x.confidence === 'high' ? 'moss' : '')}>${x.confidence}</span>` : null}</div>
      ${x.office ? html`<div class="faint" style="font-size:var(--fs-xs)">${x.office}</div>` : null}
      <div style="font-size:var(--fs-sm);line-height:1.45">${x.why || x.angle || 'No notes from the scout.'}</div>
      ${open === x.id ? html`<div class="col" style="gap:4px;font-size:var(--fs-xs)">
        ${x.angle && x.why ? html`<div><b>Angle:</b> ${x.angle}</div>` : null}
        <div><b>Contact:</b> ${x.contact || 'not found yet (research looks for it)'}</div>
        ${x.handle ? html`<div><b>Link:</b> <a href=${/^https?:/.test(x.handle) ? x.handle : '#'} target="_blank" rel="noreferrer">${x.handle}</a></div>` : null}
        ${x.followers ? html`<div><b>Followers:</b> ${Number(x.followers).toLocaleString()}</div>` : null}
        <div class="faint">Found by ${x.source || 'the scout'}${x.query ? ` for "${x.query}"` : ''}</div></div>` : null}
      <div class="row" style="gap:6px"><${Button} size="sm" kind="primary" onClick=${() => go('approve', [x.id], pol ? 'Making the package' : 'Writing the email')}>${pol ? 'Make package' : 'Write email'}</${Button}><${Button} size="sm" kind="ghost" onClick=${() => go('skip', [x.id], 'Skipped')}>Skip</${Button}><span class="grow" /><button class="chip" onClick=${() => setOpen(open === x.id ? null : x.id)}>${open === x.id ? 'Less' : 'More'}</button></div>
    </div>`)}</div>`}
  </div>`;
}

export function ReviewQueue({ lane }) {
  const { data, reload } = useApi(`/api/outreach/${lane}/review`, ['prospects', 'message', 'approval']);
  const [picked, setPicked] = useState(new Set());
  const [edits, setEdits] = useState({});
  const [preview, setPreview] = useState(null);
  const items = data || [];
  const toggle = (id) => setPicked((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const approve = async (ids) => {
    if (!ids.length) return;
    if (ids.length > 1 && !(await confirmDialog({ title: `Send ${ids.length} emails?`, text: 'They go out within your hourly limit and quiet hours. In Test mode they go to your sandbox address.', confirm: 'Send', kind: 'moss' }))) return;
    const e = Object.fromEntries(ids.filter((id) => edits[id]).map((id) => [id, edits[id]]));
    act(() => api.post('/api/outreach/approve', { ids, edits: e }), { ok: (r) => `${r.approved} sent${r.errors.length ? ` · ${r.errors.length} skipped` : ''}` }).then(() => { setPicked(new Set()); reload(); });
  };
  const skip = async (ids) => {
    const reason = await promptDialog({ title: ids.length > 1 ? `Skip ${ids.length} leads` : 'Skip this lead', label: 'Why? (optional; the scout learns from this)', placeholder: 'e.g. not running this year, too small, wrong state', confirm: 'Skip' });
    if (reason === null || reason === undefined) return;
    act(() => api.post('/api/outreach/skip', { ids, reason }), { ok: 'Skipped' }).then(() => { setPicked(new Set()); reload(); });
  };
  return html`<div class="col" style="gap:10px">
    <div class="row" style="gap:8px"><h4 class="grow">Waiting for review <span class="faint">${items.length}</span></h4>
      ${items.length ? html`<${Button} size="sm" kind="ghost" onClick=${() => setPicked(new Set(items.filter((x) => !x.hasContrast && !x.needsContact).map((x) => x.id)))}>Select all</${Button}>` : null}
      <${Button} size="sm" kind="ghost" disabled=${!picked.size} onClick=${() => skip([...picked])}>Skip</${Button}>
      <${Button} size="sm" kind="moss" icon="check" disabled=${!picked.size} onClick=${() => approve([...picked])}>Approve & send ${picked.size || ''}</${Button}></div>
    ${!items.length ? html`<div class="panel pad faint">Nothing waiting. New ${lane === 'political' ? 'packages' : 'emails'} appear here as bubbles to approve.</div>` : null}
    <div class="col" style="gap:12px">${items.map((it) => html`<${Bubble} it=${it} lane=${lane} picked=${picked.has(it.id)} toggle=${() => toggle(it.id)} edit=${edits[it.id]} setEdit=${(e) => setEdits({ ...edits, [it.id]: { ...(edits[it.id] || {}), ...e } })} onApprove=${() => approve([it.id])} onSkip=${() => skip([it.id])} onPreview=${setPreview} />`)}</div>
    ${preview ? html`<div class="modal-back" style="position:fixed;inset:0;background:rgba(10,15,30,.55);z-index:200;display:flex;align-items:center;justify-content:center;padding:20px" onClick=${() => setPreview(null)}>
      <video src=${preview} controls autoplay playsinline style="max-width:min(92vw,1100px);max-height:86vh;border-radius:14px;background:#000" onClick=${(e) => e.stopPropagation()} /></div>` : null}
  </div>`;
}

/** A lead that only lacks a real email: type one (or pick one found on their pages) and the draft is remade to it. */
function AddEmail({ it }) {
  const [email, setEmail] = useState(it.suggestions?.[0] || '');
  const save = () => act(() => api.post(`/api/prospects/${it.id}/contact`, { email: email.trim() }), { ok: 'Saved. Remaking the email draft to that address.' });
  return html`<div class="panel pad col" style="gap:8px;background:var(--gold-soft)">
    <b>Add their campaign or press email</b>
    ${it.govFound?.length ? html`<div class="faint" style="font-size:var(--fs-xs)">Found only a government address (${it.govFound.join(', ')}). We never pitch those; look on their campaign site or social pages for a press or info@ address.</div>` : null}
    ${it.suggestions?.length ? html`<div class="row wrap" style="gap:6px">${it.suggestions.map((e) => html`<button class="chip" onClick=${() => setEmail(e)}>${e}</button>`)}</div>` : null}
    <div class="row" style="gap:6px"><input class="input grow" type="email" placeholder="press@theircampaign.com" value=${email} onInput=${(e) => setEmail(e.target.value)} onKeyDown=${(e) => e.key === 'Enter' && email.trim() && save()} /><${Button} kind="primary" disabled=${!email.trim()} onClick=${save}>Save and make the draft</${Button}></div>
  </div>`;
}

function Bubble({ it, lane, picked, toggle, edit, setEdit, onApprove, onSkip, onPreview }) {
  const [editing, setEditing] = useState(false);
  const file = (k) => api.url(`/api/prospects/${it.id}/file/${k}`);
  const vids = lane === 'political' ? [['v', 'posterV', 'Short vertical', 120], ['h', 'posterH', 'Short horizontal', 214], ['hl', 'posterHL', 'Long horizontal', 214]].filter(([k]) => it.files.includes(k)) : [];
  return html`<div class="panel pad col" style=${`gap:10px;border-radius:22px;${picked ? 'outline:2px solid var(--moss)' : ''}`}>
    <div class="row" style="gap:10px">
      ${!it.hasContrast && !it.needsContact ? html`<input type="checkbox" checked=${picked} onChange=${toggle} />` : null}
      <div class="grow"><b>${it.name}</b> <span class="faint">${it.office || it.handle || ''}${it.followers ? ` · ${fmtN(it.followers)} followers` : ''}</span><div class="faint" style="font-size:var(--fs-xs)">${it.needsContact ? html`<span class="badge gold">Needs an email</span>` : `To ${it.to}`} · ${ago(it.createdAt)}</div></div>
      ${it.hasContrast ? html`<span class="badge coral">Contrast ad: review required</span>` : null}
    </div>
    ${vids.length ? html`<div class="row wrap" style="gap:10px;align-items:flex-end">${vids.map(([k, pk, label, w]) => html`<button class="col" style="gap:4px;background:none;border:0;padding:0;cursor:pointer;text-align:left" onClick=${() => onPreview(file(k))}>
        <div style=${`position:relative;width:${w}px;height:120px;border-radius:12px;overflow:hidden;background:#111 url(${file(pk)}) center/cover`}><span style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#fff;font-size:30px;text-shadow:0 2px 8px rgba(0,0,0,.6)">▶</span></div>
        <span class="faint" style="font-size:var(--fs-xs)">${label}</span></button>`)}
      ${it.files.includes('sheet') ? html`<a class="col" style="gap:4px;width:92px;align-items:center" href=${file('sheet')} target="_blank"><div style="width:92px;height:120px;border-radius:10px;background:var(--panel-2,#f4f5f8);display:flex;align-items:center;justify-content:center;border:1px solid var(--line)"><b style="font-size:13px">PDF</b></div><span class="faint" style="font-size:var(--fs-xs)">One-pager</span></a>` : null}</div>` : null}
    ${editing ? html`<div class="col" style="gap:6px"><input class="input" value=${edit?.subject ?? it.subject} onInput=${(e) => setEdit({ subject: e.target.value })} /><textarea class="input" style="height:200px;font-family:inherit;line-height:1.5" value=${edit?.body ?? it.body} onInput=${(e) => setEdit({ body: e.target.value })} /></div>`
      : html`<div class="panel pad" style="background:var(--bg,#fafbfc)"><b>${edit?.subject ?? it.subject}</b><div class="selectable" style="white-space:pre-wrap;font-size:var(--fs-sm);line-height:1.55;margin-top:6px;max-height:220px;overflow:auto">${edit?.body ?? it.body}</div>${it.attachments.length ? html`<div class="faint" style="font-size:var(--fs-xs);margin-top:6px">📎 ${it.attachments.map((a) => a.name).join(' · ')}</div>` : null}</div>`}
    ${it.why.length ? html`<div class="row wrap" style="gap:6px">${it.why.map((w) => html`<span class="badge gold" title="Why autopilot held this">${w}</span>`)}</div>` : null}
    ${it.needsContact ? html`<${AddEmail} it=${it} />` : null}
    <${Notes} id=${it.id} lane=${lane} />
    <div class="row wrap" style="gap:8px"><${Button} kind="moss" icon="check" disabled=${it.needsContact} title=${it.needsContact ? 'Add a campaign or press email first' : ''} onClick=${onApprove}>Approve & send</${Button}><${Button} kind="ghost" icon="edit" onClick=${() => setEditing(!editing)}>${editing ? 'Done editing' : 'Edit'}</${Button}><${Button} kind="ghost" onClick=${onSkip}>Skip</${Button}>
      <${VoiceNote} id=${it.id} has=${it.attachments.some((a) => /^Voice note/.test(a.name))} /><${CallButton} id=${it.id} name=${it.name} />
      <div class="spacer" /><${Button} size="sm" kind="ghost" onClick=${() => act(() => api.post(`/api/prospects/${it.id}/redo`), { ok: 'Remaking' })}>Remake</${Button}></div>
  </div>`;
}

// ------------------------------------------------------------------ leads (import / export / start)

export function Leads({ lane }) {
  const [busy, setBusy] = useState(false);
  const pick = (e) => {
    const f = e.target.files?.[0]; if (!f) return;
    setBusy(true);
    f.text().then((csv) => act(() => api.post(`/api/outreach/${lane}/import`, { csv }), { ok: (r) => `${r.added} added, ${r.updated} updated${r.skipped.length ? `, ${r.skipped.length} skipped` : ''}` })).finally(() => { setBusy(false); e.target.value = ''; });
  };
  return html`<div class="panel pad row wrap" style="gap:10px">
    <div class="avatar" style="background:var(--sky-soft);color:var(--sky-ink)"><${Icon} name="upload" size=${16} /></div>
    <div class="grow"><b>Lead list</b><div class="faint" style="font-size:var(--fs-xs)">Import your spreadsheet (save it as CSV). Your columns are kept, and Export writes new leads back in the same layout.</div></div>
    <label class="btn ghost sm" style="cursor:pointer">${busy ? 'Importing…' : 'Import CSV'}<input type="file" accept=".csv,text/csv,.tsv,.txt" style="display:none" onChange=${pick} /></label>
    <a class="btn ghost sm" href=${api.url(`/api/outreach/${lane}/export.csv`)}>Export CSV</a>
    <${Button} size="sm" kind="primary" icon="sparkle" onClick=${() => act(() => api.post(`/api/outreach/${lane}/start`, {}), { ok: (r) => `Started ${r.started}` })}>${lane === 'political' ? 'Make packages for new leads' : 'Write emails for new leads'}</${Button}>
  </div>`;
}

// ------------------------------------------------------------------ creators lane

export function CreatorsLane({ prospects, reload }) {
  const { data: jobs } = useApi('/api/jobs?status=running,queued', ['job']);
  const boot = store.get().boot || {};
  const [query, setQuery] = useState(''); const [count, setCount] = useState(10);
  const [offers, setOffers] = useState(boot.settings?.creatorOffers || {});
  const [showOffers, setShowOffers] = useState(false);
  const list = (prospects || []).filter((p) => p.type !== 'political');
  const jobFor = (id) => (jobs || []).find((j) => j.type === 'creator.outreach' && j.payload?.prospectId === id);
  const scouting = (jobs || []).filter((j) => j.type === 'creator.scout');
  const scout = () => act(() => api.post('/api/outreach/creators/scout', { query, count }), { ok: 'Scouting started' }).then(() => setQuery(''));
  const saveOffers = () => act(() => api.patch('/api/settings', { creatorOffers: offers }), { ok: 'Saved' });
  const o = (k, f) => offers[k]?.[f] || '';
  const setO = (k, f) => (e) => setOffers({ ...offers, [k]: { ...(offers[k] || {}), [f]: e.target.value } });
  const ST = { ready: ['Email ready', 'moss'], running: ['Working', 'sky'], failed: ['Failed', 'coral'], needs_contact: ['Needs an email', 'gold'], excluded: ['Excluded', 'slate'] };
  return html`<div class="col" style="gap:14px">
    <div class="panel pad col" style="gap:10px">
      <div class="row"><div class="avatar" style="background:var(--lav-soft);color:var(--lav-ink)"><${Icon} name="search" size=${16} /></div><h4 class="grow">Scout creators</h4></div>
      <div class="row wrap" style="gap:8px"><input class="input grow" placeholder="e.g. political commentary YouTubers like Aaron Rupar, under 500K subscribers" value=${query} onInput=${(e) => setQuery(e.target.value)} onKeyDown=${(e) => { if (e.key === 'Enter' && query.trim().length > 3) scout(); }} />
        <input class="input" type="number" min="1" max="100" value=${count} onInput=${(e) => setCount(e.target.value)} style="width:80px" /><${Button} kind="lav" icon="search" disabled=${query.trim().length < 4} onClick=${scout}>Scout</${Button}></div>
      ${scouting.length ? html`<div class="notice lav"><span class="spinner" />${scouting.map((j) => j.title).join(' · ')}</div>` : html`<div class="faint" style="font-size:var(--fs-xs)">Searches YouTube plus your research agent. Creators get a tailored email only (no sample videos). Contacts the agent suggests are only used once confirmed on the creator's own pages.</div>`}
    </div>
    <div class="panel pad col" style="gap:10px">
      <div class="row"><h4 class="grow">Offers</h4><${Button} size="sm" kind="ghost" onClick=${() => setShowOffers(!showOffers)}>${showOffers ? 'Hide' : 'Edit'}</${Button}></div>
      ${showOffers ? html`<div class="col" style="gap:10px">${['shorts', 'youtube'].map((k) => html`<div class="form-grid"><${Field} label=${k === 'shorts' ? 'Shorts package name' : 'Full YouTube name'} id=${`on-${k}`}><input id=${`on-${k}`} class="input" value=${o(k, 'name')} onInput=${setO(k, 'name')} /></${Field}><${Field} label="Price" id=${`op-${k}`}><input id=${`op-${k}`} class="input" value=${o(k, 'price')} onInput=${setO(k, 'price')} /></${Field}><${Field} label="What's included" id=${`od-${k}`}><input id=${`od-${k}`} class="input" value=${o(k, 'details')} onInput=${setO(k, 'details')} /></${Field}></div>`)}
        <div class="form-grid"><${Field} label="Lead with" id="o-lead"><select id="o-lead" class="input" value=${offers.lead || 'shorts'} onChange=${(e) => setOffers({ ...offers, lead: e.target.value })}><option value="shorts">Shorts package</option><option value="youtube">Full YouTube management</option></select></${Field}>
          <${Field} label="Who signs" id="o-sender"><input id="o-sender" class="input" value=${offers.senderName || ''} onInput=${(e) => setOffers({ ...offers, senderName: e.target.value })} /></${Field}>
          <${Field} label="Booking link" id="o-book"><input id="o-book" class="input" value=${offers.bookingUrl || ''} onInput=${(e) => setOffers({ ...offers, bookingUrl: e.target.value })} /></${Field}></div>
        <${Field} label="Your best creator emails (the writer matches their voice)" id="o-tpl"><textarea id="o-tpl" class="input" style="height:120px;font-family:inherit" value=${offers.templates || ''} onInput=${(e) => setOffers({ ...offers, templates: e.target.value })} /></${Field}>
        <div class="row"><${Button} kind="primary" onClick=${saveOffers}>Save offers</${Button}><span class="faint" style="font-size:var(--fs-xs)">Creators without a YouTube channel are pitched full YouTube management automatically.</span></div></div>`
      : html`<div class="faint" style="font-size:var(--fs-sm)">${o('shorts', 'name')}: ${o('shorts', 'price')} · ${o('youtube', 'name')}: ${o('youtube', 'price')}</div>`}
    </div>
    <div class="panel">
      <div class="row pad" style="border-bottom:1px solid var(--line)"><h4 class="grow">Creators <span class="faint">${list.length}</span></h4></div>
      ${!list.length ? html`<div class="pad faint">No creators yet. Import your list or scout.</div>` : html`<div class="table-wrap"><table class="table"><thead><tr><th>Name</th><th>Channel</th><th>Followers</th><th>Email</th><th>Outreach</th><th>Stage</th><th></th></tr></thead><tbody>
        ${list.map((p) => { const j = jobFor(p.id); const [l, t] = ST[j ? 'running' : p.outreach?.status] || ['Not started', 'slate']; return html`<tr>
          <td><b>${p.name}</b></td><td class="muted ellipsis" style="max-width:220px">${p.handle || '—'}</td><td>${fmtN(p.followers) || '—'}</td>
          <td class="muted ellipsis" style="max-width:200px">${p.publicContact || '—'}${p.publicContact && !p.contactVerified ? html` <span class="badge gold" title="Not yet confirmed on their own pages">unconfirmed</span>` : null}</td>
          <td><span class=${'badge ' + t}>${l}</span>${j ? html`<${Progress} value=${j.progress || 0} />` : p.outreach?.note ? html`<div class="faint" style="font-size:var(--fs-xs)">${p.outreach.note}</div>` : null}</td>
          <td>${p.stage || 'new'}</td>
          <td>${p.outreach?.conversationId ? html`<${Button} size="sm" kind="ghost" onClick=${() => navigate(`/messages/${p.outreach.conversationId}`)}>Open</${Button}>` : html`<${Button} size="sm" kind="ghost" icon="sparkle" onClick=${() => act(() => api.post(`/api/prospects/${p.id}/redo`), { ok: 'Started' }).then(reload)}>Write email</${Button}>`}</td></tr>`; })}
      </tbody></table></div>`}
    </div>
  </div>`;
}

// ------------------------------------------------------------------ talk to the scout

export function ScoutChat({ lane }) {
  const { data, reload } = useApi(`/api/outreach/${lane}/chat`, ['outreachChat']);
  const [text, setText] = useState(''); const [busy, setBusy] = useState(false);
  const send = async () => {
    const t = text.trim(); if (!t || busy) return;
    setBusy(true); setText('');
    try { await api.post(`/api/outreach/${lane}/chat`, { text: t }); } catch (e) { toast(e.message, { kind: 'error' }); }
    setBusy(false); reload();
  };
  const msgs = data || [];
  const examples = lane === 'political'
    ? ['Find Connecticut Democrats running for state house in 2026', 'Keep going all day, 40 new leads max', 'Skip incumbents who already have a video team', 'Remember: mention their town by name in the first line']
    : ['Find political commentary YouTubers like Aaron Rupar under 300K subscribers', 'Look for TikTok news creators with no YouTube channel', 'Never contact anyone from Fox News', 'Remember: lead with the $1,200 Shorts package'];
  return html`<div class="panel pad col" style="gap:10px">
    <div class="row"><div class="avatar" style="background:var(--lav-soft);color:var(--lav-ink)"><${Icon} name="sparkle" size=${16} /></div><h4 class="grow">Talk to the scout</h4><span class="faint" style="font-size:var(--fs-xs)">It changes searches, limits, exclusions and lessons for you</span></div>
    <div class="col" style="gap:8px;max-height:300px;overflow:auto">
      ${!msgs.length ? html`<div class="row wrap" style="gap:6px">${examples.map((x) => html`<button class="chip" onClick=${() => setText(x)}>${x}</button>`)}</div>` : null}
      ${msgs.map((m) => html`<div style=${`align-self:${m.role === 'user' ? 'flex-end' : 'flex-start'};max-width:85%;background:${m.role === 'user' ? 'var(--sky-soft)' : 'var(--panel-2,#f4f5f8)'};border-radius:14px;padding:8px 12px;font-size:var(--fs-sm);line-height:1.45`}>
        <div style="white-space:pre-wrap">${m.text}</div>${(m.changes || []).length ? html`<div class="row wrap" style="gap:4px;margin-top:6px">${m.changes.map((c) => html`<span class="badge moss">${c}</span>`)}</div>` : null}</div>`)}
      ${busy ? html`<div class="faint"><span class="spinner" /> Thinking…</div>` : null}
    </div>
    <div class="row" style="gap:8px"><input class="input grow" placeholder="Tell the scout who to find, how many, or what to avoid…" value=${text} onInput=${(e) => setText(e.target.value)} onKeyDown=${(e) => { if (e.key === 'Enter') send(); }} /><${Button} kind="lav" icon="send" disabled=${!text.trim() || busy} onClick=${send}>Send</${Button}></div>
  </div>`;
}

// ------------------------------------------------------------------ what it has learned

export function Learning({ lane }) {
  const { data, reload } = useApi(`/api/outreach/${lane}/learning`, ['prospects', 'settings', 'outreachChat']);
  const [lessons, setLessons] = useState(null);
  if (!data) return null;
  const st = data.stats; const pct = (x) => (x == null ? '–' : `${Math.round(x * 100)}%`);
  const val = lessons ?? data.lessons ?? '';
  return html`<div class="panel pad col" style="gap:10px">
    <div class="row"><div class="avatar" style="background:var(--gold-soft,#fbf1d9);color:var(--gold-ink,#8a6410)"><${Icon} name="bolt" size=${16} /></div><h4 class="grow">What it has learned</h4></div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px">
      ${[['Approved unchanged', pct(st.unchangedRate), `last ${st.reviewed} reviewed`], ['You edited', st.edited, 'used as examples'], ['You skipped', st.skipped, 'scout avoids similar'], ['Reply rate', pct(st.replyRate), `${st.replies} of ${st.sent} sent`], ['Opt-outs', st.optOuts, '']].map(([k, v, sub]) => html`<div class="panel pad" style="padding:10px 12px"><div class="faint" style="font-size:var(--fs-xs)">${k}</div><b style="font-size:18px">${v}</b><div class="faint" style="font-size:var(--fs-xs)">${sub}</div></div>`)}
    </div>
    <${Field} label="Lessons (one per line; the writer and scout follow these, and the chat adds to them)" id=${`les-${lane}`}><textarea id=${`les-${lane}`} class="input" style="height:100px;font-family:inherit" value=${val} onInput=${(e) => setLessons(e.target.value)} /></${Field}>
    <div class="row"><${Button} size="sm" kind="primary" disabled=${lessons == null} onClick=${() => act(() => api.patch('/api/settings', { outreach: { [lane]: { lessons: val } } }), { ok: 'Saved' }).then(() => { setLessons(null); reload(); })}>Save lessons</${Button}><span class="faint" style="font-size:var(--fs-xs)">Every edit you make before approving is saved as an example of how you want it written.</span></div>
  </div>`;
}

// ------------------------------------------------------------------ voice note + click-to-call

async function uploadVoice(id, blob) {
  const res = await fetch(api.url(`/api/prospects/${id}/voicenote`), { method: 'POST', headers: { 'content-type': blob.type || 'audio/webm' }, body: blob });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || `Upload failed (${res.status})`);
  return j;
}

function VoiceNote({ id, has }) {
  const [rec, setRec] = useState(null); const [busy, setBusy] = useState(false);
  const start = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream); const chunks = [];
      mr.ondataavailable = (e) => chunks.push(e.data);
      mr.onstop = async () => { stream.getTracks().forEach((t) => t.stop()); setBusy(true); try { await uploadVoice(id, new Blob(chunks, { type: mr.mimeType || 'audio/webm' })); toast('Voice note attached', { kind: 'ok' }); } catch (e) { toast(e.message, { kind: 'error' }); } setBusy(false); };
      mr.start(); setRec(mr);
    } catch { toast('Microphone not available. Upload a recording instead.', { kind: 'warn' }); }
  };
  const stop = () => { rec?.stop(); setRec(null); };
  const pick = async (e) => { const f = e.target.files?.[0]; if (!f) return; setBusy(true); try { await uploadVoice(id, f); toast('Voice note attached', { kind: 'ok' }); } catch (err) { toast(err.message, { kind: 'error' }); } setBusy(false); e.target.value = ''; };
  if (busy) return html`<span class="faint"><span class="spinner" /> Attaching…</span>`;
  if (rec) return html`<${Button} kind="coral" icon="stop" onClick=${stop}>Stop recording</${Button}>`;
  const mine = store.get().boot?.settings?.voice?.voiceId;
  const ai = async () => { setBusy(true); try { await api.post(`/api/prospects/${id}/voicenote-ai`, {}); toast('Voice note in your voice attached', { kind: 'ok' }); } catch (e) { toast(e.message, { kind: 'error' }); } setBusy(false); };
  return html`<span class="row" style="gap:4px">${mine ? html`<${Button} kind="ghost" icon="sparkle" title="Read the voice-note script in your cloned voice" onClick=${ai}>In my voice</${Button}>` : null}<${Button} kind="ghost" icon="mic" onClick=${start}>${has ? 'Re-record voice note' : 'Voice note'}</${Button}><label class="btn ghost sm" style="cursor:pointer" title="Upload a recording">Upload<input type="file" accept="audio/*" style="display:none" onChange=${pick} /></label></span>`;
}

function CallButton({ id, name }) {
  const [open, setOpen] = useState(false); const [to, setTo] = useState('');
  const call = () => act(() => api.post(`/api/prospects/${id}/call`, to.trim() ? { to: to.trim() } : {}), { ok: 'Calling your phone now. Answer it to be connected.' });
  const log = (kind, outcome) => act(() => api.post(`/api/prospects/${id}/call-outcome`, { kind, outcome }), { ok: 'Logged' }).then(() => setOpen(false));
  if (!open) return html`<${Button} kind="ghost" icon="phone" onClick=${() => setOpen(true)}>Call</${Button}>`;
  return html`<span class="row wrap" style="gap:6px">
    <input class="input" style="width:170px" placeholder="Their number (optional)" value=${to} onInput=${(e) => setTo(e.target.value)} />
    <${Button} size="sm" kind="primary" icon="phone" onClick=${call}>Ring me, then ${name.split(' ')[0]}</${Button}>
    ${[['voicemail', 'Left a voicemail'], ['talked', 'Talked'], ['meeting', 'Booked a meeting'], ['no', 'Not interested']].map(([k, l]) => html`<button class="chip" onClick=${() => log(k, l)}>${l}</button>`)}
    <${Button} size="sm" kind="ghost" onClick=${() => setOpen(false)}>Close</${Button}></span>`;
}

// ------------------------------------------------------------------ notes, iterations and versions

function Notes({ id, lane }) {
  const [note, setNote] = useState(''); const [remember, setRemember] = useState(false); const [show, setShow] = useState(false);
  const { data, reload } = useApi(show ? `/api/prospects/${id}/versions` : null, ['prospects']);
  const go = (target) => act(() => api.post(`/api/prospects/${id}/revise`, { note, target, remember }), { ok: target === 'email' ? 'Rewriting the email…' : 'Remaking with your notes… (a few minutes for ads)' }).then(() => { setNote(''); setRemember(false); });
  const quick = lane === 'political' ? ['Punchier', 'Shorter email', 'Lead with their biggest win', 'More local, mention their town', 'Calmer, more serious tone'] : ['Shorter', 'More casual', 'Mention a recent video by name', 'Lead with the $2,200 full management'];
  return html`<div class="col" style="gap:8px;background:var(--surface-2);border-radius:18px;padding:12px">
    <div class="row wrap" style="gap:6px"><b style="font-size:var(--fs-sm)">Notes</b>${quick.map((q) => html`<button class="chip" onClick=${() => setNote(note ? `${note}. ${q}` : q)}>${q}</button>`)}</div>
    <div class="row wrap" style="gap:8px">
      <input class="input grow" style="min-width:240px" placeholder="Tell it what to change, e.g. use the childcare vote, less formal, shorter" value=${note} onInput=${(e) => setNote(e.target.value)} onKeyDown=${(e) => { if (e.key === 'Enter' && note.trim()) go('email'); }} />
      <${Button} size="sm" kind="lav" disabled=${!note.trim()} onClick=${() => go('email')}>Redo email</${Button}>
      ${lane === 'political' ? html`<${Button} size="sm" kind="lav" disabled=${!note.trim()} onClick=${() => go('ads')}>Redo ads</${Button}><${Button} size="sm" kind="primary" disabled=${!note.trim()} onClick=${() => go('all')}>Redo both</${Button}>` : null}
    </div>
    <div class="row wrap" style="gap:12px"><label class="row" style="gap:6px;font-size:var(--fs-sm)"><input type="checkbox" checked=${remember} onChange=${(e) => setRemember(e.target.checked)} />Remember this for all future ${lane === 'political' ? 'packages' : 'emails'}</label>
      <button class="chip" onClick=${() => { setShow(!show); if (!show) setTimeout(reload, 0); }}>${show ? 'Hide versions' : 'Versions & past notes'}</button></div>
    ${show && data ? html`<div class="col" style="gap:8px">
      ${data.notes.length ? html`<div class="faint" style="font-size:var(--fs-xs)">Notes so far: ${data.notes.map((n) => `"${n.text}"`).join(' · ')}</div>` : null}
      ${!data.versions.length ? html`<div class="faint" style="font-size:var(--fs-sm)">No earlier versions yet. Each redo keeps the one before it here.</div>` : data.versions.map((v) => html`<div class="panel pad col" style="gap:6px;padding:10px 12px">
        <div class="row"><b class="grow" style="font-size:var(--fs-sm)">${v.label}</b><span class="faint" style="font-size:var(--fs-xs)">${ago(v.at)}</span><${Button} size="sm" kind="ghost" onClick=${() => act(() => api.post(`/api/prospects/${id}/restore`, { n: v.n }), { ok: 'Restored' }).then(reload)}>Use this version</${Button}></div>
        ${v.files.includes('posterV') ? html`<div class="row" style="gap:6px">${['posterV', 'posterH', 'posterHL'].filter((k) => v.files.includes(k)).map((k) => html`<img src=${api.url(`/api/prospects/${id}/version/${v.n}/file/${k}`)} style="height:70px;border-radius:8px" />`)}</div>` : null}
        <div class="faint" style="font-size:var(--fs-xs);white-space:pre-wrap;max-height:90px;overflow:auto"><b>${v.subject}</b>${'\n'}${String(v.body || '').slice(0, 400)}</div></div>`)}
    </div>` : null}
  </div>`;
}
