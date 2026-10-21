// Political outreach: names or a scout query in, finished packages out
// (cited brief, vertical + horizontal video, one-page sheet, email draft waiting in Approvals).
import { html, useState, useApi, navigate, Button, Drawer, Field, Tabs, Progress, Toggle, act, toast, confirmDialog, store } from '../lib/ui.js';
import { api } from '../lib/api.js';
import { Icon } from '../lib/icons.js';
import { ago, providerLabel } from '../lib/format.js';

const STATUS = { running: ['Working', 'sky'], ready: ['Ready to review', 'moss'], failed: ['Needs attention', 'coral'], needs_contact: ['Needs an email', 'gold'] };
const STEP_ICON = { done: '✓', running: '…', failed: '!', skipped: '–' };

export function Political({ prospects, reload }) {
  const { data: jobs } = useApi('/api/jobs?status=running,queued', ['job']);
  const { data: steps } = useApi('/api/political/steps');
  const [names, setNames] = useState('');
  const [query, setQuery] = useState('');
  const [count, setCount] = useState(10);
  const [auto, setAuto] = useState(true);
  const [open, setOpen] = useState(null);
  const [picked, setPicked] = useState(new Set());
  const [showSettings, setShowSettings] = useState(false);
  const list = (prospects || []).filter((p) => p.type === 'political');
  const jobFor = (id) => (jobs || []).find((j) => j.type === 'political.package' && j.payload?.prospectId === id);
  const scouting = (jobs || []).filter((j) => j.type === 'political.scout');
  const ready = list.filter((p) => p.pkg?.status === 'ready' && p.pkg?.messageId);
  const make = () => act(() => api.post('/api/political/packages', { names }), { ok: (r) => `${r.queued} package${r.queued === 1 ? '' : 's'} started` }).then(() => { setNames(''); reload(); });
  const scout = () => act(() => api.post('/api/political/scout', { query, count, autoPackage: auto }), { ok: 'Scouting started. New leads appear below.' }).then(() => setQuery(''));
  const approve = async () => {
    const ids = [...picked].filter((id) => ready.some((p) => p.id === id));
    if (!ids.length) return toast('Tick the packages you reviewed first.');
    if (!(await confirmDialog({ title: `Send ${ids.length} email${ids.length === 1 ? '' : 's'}?`, text: 'Each goes out with its videos and sheet attached, within your hourly sending limit and quiet hours. In Test mode they go to your sandbox address.', confirm: 'Send', kind: 'moss' }))) return;
    act(() => api.post('/api/political/approve', { ids }), { ok: (r) => `${r.approved} approved${r.errors.length ? ` · ${r.errors.length} skipped` : ''}` }).then(() => { setPicked(new Set()); reload(); });
  };
  const toggle = (id) => setPicked((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const cur = open && list.find((p) => p.id === open);

  return html`<div class="col" style="gap:16px">
    <div class="grid-2" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:16px">
      <div class="panel pad col" style="gap:10px">
        <div class="row"><div class="avatar" style="background:var(--sky-soft);color:var(--sky-ink)"><${Icon} name="sparkle" size=${16} /></div><h4 class="grow">Make packages</h4></div>
        <div class="muted" style="font-size:var(--fs-sm)">One name per line. Add the office or state after a dash if the name is common.</div>
        <textarea class="input" rows="5" id="pol-names" placeholder=${'Jane Rivera — Texas House District 12\nJohn Smith, Ohio State Senate'} value=${names} onInput=${(e) => setNames(e.target.value)} style="resize:vertical;font-family:inherit;height:120px;min-height:90px" />
        <div class="row"><span class="faint grow" style="font-size:var(--fs-xs)">Each: brief, 2 videos, sheet, email draft</span><${Button} kind="primary" icon="sparkle" disabled=${!names.trim()} onClick=${make}>Make packages</${Button}></div>
      </div>
      <div class="panel pad col" style="gap:10px">
        <div class="row"><div class="avatar" style="background:var(--lav-soft);color:var(--lav-ink)"><${Icon} name="search" size=${16} /></div><h4 class="grow">Scout new leads</h4></div>
        <input class="input" id="pol-scout" placeholder="e.g. Ohio state house candidates 2026 with little video on social" value=${query} onInput=${(e) => setQuery(e.target.value)} onKeyDown=${(e) => { if (e.key === 'Enter' && query.trim()) scout(); }} />
        <div class="row wrap" style="gap:12px"><label class="row" style="gap:6px">How many <input class="input" type="number" min="1" max="100" value=${count} onInput=${(e) => setCount(e.target.value)} style="width:72px" /></label>
          <${Toggle} on=${auto} onChange=${setAuto} label="Make packages automatically" /><div class="spacer" /><${Button} kind="lav" icon="search" disabled=${query.trim().length < 4} onClick=${scout}>Scout</${Button}></div>
        ${scouting.length ? html`<div class="notice lav"><span class="spinner" />${scouting.map((j) => j.title).join(' · ')}</div>` : html`<div class="faint" style="font-size:var(--fs-xs)">Uses Open States (state legislators) and your research agent. Duplicates are skipped.</div>`}
      </div>
    </div>

    <div class="panel pad col" style="gap:10px">
      <div class="row"><h4 class="grow">Package settings</h4><${Button} size="sm" kind="ghost" onClick=${() => setShowSettings(!showSettings)}>${showSettings ? 'Hide' : 'Show'}</${Button}></div>
      ${showSettings ? html`<${PackageSettings} />` : html`<div class="faint" style="font-size:var(--fs-sm)">Ad style and lengths, your plan, booking link, who signs, your email templates, colours, contrast ads and narrator voice.</div>`}
    </div>

    <div class="panel">
      <div class="row pad" style="gap:10px;border-bottom:1px solid var(--line)"><h4 class="grow">Packages <span class="faint">${list.length}</span></h4>
        ${ready.length ? html`<${Button} size="sm" kind="ghost" onClick=${() => setPicked(new Set(ready.map((p) => p.id)))}>Select all ready</${Button}>` : null}
        <${Button} size="sm" kind="moss" icon="check" disabled=${!picked.size} onClick=${approve}>Approve & send ${picked.size || ''}</${Button}></div>
      ${!list.length ? html`<div class="pad faint">No political prospects yet. Paste names above or scout for leads.</div>` : html`<div class="table-wrap"><table class="table"><thead><tr><th></th><th>Name</th><th>Office</th><th>Package</th><th>Contact</th><th>Videos</th><th></th></tr></thead><tbody>
        ${list.map((p) => { const j = jobFor(p.id); const st = j ? 'running' : p.pkg?.status; const [label, tone] = STATUS[st] || ['Not started', 'slate']; return html`<tr class="click" onClick=${() => setOpen(p.id)}>
          <td onClick=${(e) => e.stopPropagation()}>${p.pkg?.status === 'ready' && p.pkg?.messageId ? html`<input type="checkbox" checked=${picked.has(p.id)} onChange=${() => toggle(p.id)} />` : null}</td>
          <td><b>${p.name}</b>${!p.verified ? html` <span class="badge gold">verify</span>` : null}</td>
          <td class="muted ellipsis" style="max-width:240px">${p.pkg?.profile?.office || p.location || '—'}</td>
          <td style="min-width:170px"><span class=${'badge ' + tone}>${label}</span>${j ? html`<div style="margin-top:6px"><${Progress} value=${j.progress || 0} /><div class="faint" style="font-size:var(--fs-xs)">${j.note || ''}</div></div>` : p.pkg?.error ? html`<div class="faint ellipsis" style="font-size:var(--fs-xs);max-width:240px">${p.pkg.error}</div>` : null}</td>
          <td class="muted ellipsis" style="max-width:200px">${p.publicContact || p.pkg?.profile?.contact || '—'}</td>
          <td>${p.pkg?.files?.posterV ? html`<div class="row" style="gap:4px"><img src=${api.url(`/api/prospects/${p.id}/file/posterV`)} style="height:44px;border-radius:6px" /><img src=${api.url(`/api/prospects/${p.id}/file/posterH`)} style="height:44px;border-radius:6px" /></div>` : '—'}</td>
          <td onClick=${(e) => e.stopPropagation()}>${!j ? html`<${Button} size="sm" kind="ghost" icon="sparkle" onClick=${() => act(() => api.post(`/api/prospects/${p.id}/package`, {}), { ok: 'Started' })}>${p.pkg ? 'Redo' : 'Make'}</${Button}>` : null}</td></tr>`; })}
      </tbody></table></div>`}
    </div>
    ${cur ? html`<${PackageDrawer} p=${cur} steps=${steps || []} job=${jobFor(cur.id)} onClose=${() => setOpen(null)} reload=${reload} />` : null}
  </div>`;
}

function PackageSettings() {
  const boot = store.get().boot || {};
  const init = boot.settings?.political || {};
  const [v, setV] = useState({ videoStyle: 'campaign', shortSeconds: 20, videoSeconds: 60, longVideo: true, contrastAds: false, brandColors: true, plan: '12 posts a week for $949', bookingUrl: '', senderName: '', offer: '', templates: '', theme: 'auto', narration: false, musicDir: '', ...init });
  const set = (k) => (e) => setV({ ...v, [k]: e && e.target ? (e.target.type === 'number' ? Number(e.target.value) : e.target.value) : e });
  const save = () => act(() => api.patch('/api/settings', { political: v }), { ok: 'Saved' }).then((s) => { const b = store.get().boot; if (b && s) store.set({ boot: { ...b, settings: s } }); });
  return html`<div class="col" style="gap:12px">
    <div class="form-grid">
      <${Field} label="Ad style" id="pol-style"><select id="pol-style" class="input" value=${v.videoStyle} onChange=${set('videoStyle')}><option value="campaign">Campaign ad (like real political ads)</option><option value="pop">Bubbly and poppy</option></select></${Field}>
      <${Field} label="Short ads (seconds)" hint="Vertical and horizontal, 10 to 90" id="pol-short"><input id="pol-short" class="input" type="number" min="10" max="90" value=${v.shortSeconds} onInput=${set('shortSeconds')} /></${Field}>
      <${Field} label="Long ad (seconds)" hint="Horizontal, 30 to 240" id="pol-len"><input id="pol-len" class="input" type="number" min="30" max="240" value=${v.videoSeconds} onInput=${set('videoSeconds')} /></${Field}>
      <${Field} label="Your political plan (one line)" id="pol-plan"><input id="pol-plan" class="input" value=${v.plan} onInput=${set('plan')} placeholder="12 posts a week for $949 a month" /></${Field}>
      <${Field} label="Booking link" hint="Shown in the email and on the sheet" id="pol-book"><input id="pol-book" class="input" placeholder="https://calendly.com/..." value=${v.bookingUrl} onInput=${set('bookingUrl')} /></${Field}>
      <${Field} label="Who signs the email" id="pol-sender"><input id="pol-sender" class="input" placeholder="Ryan Rosario" value=${v.senderName} onInput=${set('senderName')} /></${Field}>
      <${Field} label="Colours (bubbly style)" id="pol-theme"><select id="pol-theme" class="input" value=${v.theme} onChange=${set('theme')}>${[['auto', 'Match their party'], ['blue', 'Blue'], ['red', 'Red'], ['purple', 'Purple'], ['green', 'Green']].map(([k, l]) => html`<option value=${k}>${l}</option>`)}</select></${Field}>
      <${Field} label="Music folder (optional)" hint="One track is picked for each video" id="pol-music"><div class="row" style="gap:6px"><input id="pol-music" class="input" value=${v.musicDir} onInput=${set('musicDir')} placeholder="C:\\Music\\Upbeat" />${window.euclidean?.pickFolder || boot.electron ? html`<${Button} size="sm" kind="ghost" onClick=${() => api.post('/api/system/pick-folder', {}).then((r) => r.path && setV({ ...v, musicDir: r.path })).catch(() => {})}>Choose</${Button}>` : null}</div></${Field}>
    </div>
    <div class="col" style="gap:8px">${[['longVideo', 'Make the long horizontal ad too'], ['brandColors', "Use the colours from the candidate's own website (campaign style)"], ['contrastAds', 'Allow contrast ads against a researched opponent (cited facts only; always needs your review)'], ['narration', 'AI narrator voice over the long ad (needs OpenAI)']].map(([k, l]) => html`<label class="row" style="gap:8px"><${Toggle} on=${!!v[k]} onChange=${(x) => setV({ ...v, [k]: x })} label=${l} /><span>${l}</span></label>`)}</div>
    <div class="faint" style="font-size:var(--fs-xs)">Music: put tracks in a "positive" and a "contrast" subfolder of your music folder to match the mood of each ad.</div>
    <${Field} label="Your offer, in your words (optional)" id="pol-offer"><textarea id="pol-offer" class="input" rows="2" value=${v.offer} onInput=${set('offer')} placeholder="Two free videos, yours to use whether or not we talk. Could you give us 20 minutes?" style="font-family:inherit;height:64px" /></${Field}>
    <${Field} label="Your best outreach emails" hint="Paste 1-3 emails that worked. The writer matches their voice and structure." id="pol-tpl"><textarea id="pol-tpl" class="input" rows="6" value=${v.templates} onInput=${set('templates')} style="font-family:inherit;height:150px" /></${Field}>
    <div class="row"><${Button} kind="primary" onClick=${save}>Save settings</${Button}><span class="faint" style="font-size:var(--fs-xs)">Data keys (Open States, api.data.gov) are in Settings → Connections.</span></div>
  </div>`;
}

function PackageDrawer({ p, steps, job, onClose, reload }) {
  const [tab, setTab] = useState('videos');
  const [email, setEmail] = useState(p.publicContact || '');
  const pkg = p.pkg || {}; const b = pkg.brief || {}; const c = pkg.creative || {};
  const run = (body, ok = 'Started') => act(() => api.post(`/api/prospects/${p.id}/package`, body), { ok });
  const file = (k) => api.url(`/api/prospects/${p.id}/file/${k}`);
  const saveEmail = () => act(() => api.patch(`/api/prospects/${p.id}`, { publicContact: email.trim() }), { ok: 'Saved' }).then(reload);
  return html`<${Drawer} wide title=${p.name} sub=${[pkg.profile?.office || p.location, pkg.profile?.party].filter(Boolean).join(' · ')} onClose=${onClose}>
    <div class="col" style="gap:14px">
      <div class="panel pad col" style="gap:8px">
        <div class="row"><h4 class="grow">Steps</h4>${job ? html`<span class="badge sky">${Math.round((job.progress || 0) * 100)}% · ${job.note || 'working'}</span>` : html`<${Button} size="sm" kind="primary" icon="sparkle" onClick=${() => run({})}>${pkg.status ? 'Redo everything' : 'Make package'}</${Button}>`}</div>
        <div class="row wrap" style="gap:6px">${steps.map((s) => { const st = pkg.steps?.[s.key]; return html`<button class=${'chip' + (st?.status === 'done' ? ' on' : '')} title=${st?.error || st?.note || 'Not run yet'} disabled=${!!job} onClick=${() => run({ only: s.key }, `${s.label}: started`)}>${STEP_ICON[st?.status] || '○'} ${s.label}</button>`; })}</div>
        <div class="faint" style="font-size:var(--fs-xs)">Click a step to re-run just that step (for example after editing the email address).</div>
        ${pkg.error ? html`<div class="notice coral">${pkg.error}</div>` : null}
      </div>
      <${Tabs} value=${tab} onChange=${setTab} tabs=${[{ value: 'videos', label: 'Videos & sheet' }, { value: 'email', label: 'Email' }, { value: 'brief', label: 'Brief' }, { value: 'call', label: 'Call' }, { value: 'sources', label: `Sources ${pkg.sources?.length || ''}` }]} />
      ${tab === 'videos' ? html`<div class="col" style="gap:12px">
        ${pkg.files?.v || pkg.files?.h ? html`<div class="row" style="gap:12px;align-items:flex-start">
          ${pkg.files?.v ? html`<div class="col" style="gap:6px;width:200px"><video src=${file('v')} poster=${pkg.files?.posterV ? file('posterV') : undefined} controls playsinline style="width:200px;border-radius:12px;background:#000" /><a class="faint" href=${file('v') + '&download=1'}>Download vertical</a></div>` : null}
          ${pkg.files?.h ? html`<div class="col grow" style="gap:6px"><video src=${file('h')} poster=${pkg.files?.posterH ? file('posterH') : undefined} controls playsinline style="width:100%;border-radius:12px;background:#000" /><a class="faint" href=${file('h') + '&download=1'}>Download horizontal</a></div>` : null}
        </div>` : html`<div class="faint">Videos appear here when the package is made.</div>`}
        ${pkg.files?.sheet ? html`<div class="row" style="gap:8px"><${Icon} name="film" size=${16} /><a href=${file('sheet')} target="_blank">Open the one-page sheet (PDF)</a></div>` : null}
        ${c.storyboard?.length ? html`<details><summary class="muted">Storyboard (${c.storyboard.length} scenes)</summary><ol style="padding-left:18px;font-size:var(--fs-sm)">${c.storyboard.map((s) => html`<li><b>${s.type}</b> · ${[s.headline, s.value, s.label, s.quote, (s.items || []).join(', '), s.sub].filter(Boolean).join(' · ')}</li>`)}</ol></details>` : null}
      </div>` : null}
      ${tab === 'email' ? html`<div class="col" style="gap:10px">
        <${Field} label="Campaign or press email" hint="Not an official .gov office address" id="pp-email"><div class="row" style="gap:6px"><input id="pp-email" class="input" value=${email} onInput=${(e) => setEmail(e.target.value)} placeholder="press@campaign.com" /><${Button} size="sm" kind="ghost" onClick=${saveEmail}>Save</${Button}><${Button} size="sm" kind="primary" onClick=${() => saveEmail().then(() => run({ only: 'email' }, 'Draft updated'))}>Save & redo draft</${Button}></div></${Field}>
        ${(pkg.profile?.emails || []).length ? html`<div class="row wrap" style="gap:6px">${pkg.profile.emails.slice(0, 6).map((e) => html`<button class="chip" onClick=${() => setEmail(e.email)}>${e.email}</button>`)}</div>` : null}
        ${c.email ? html`<div class="panel pad col" style="gap:6px"><b>${c.email.subject}</b><div class="selectable" style="white-space:pre-wrap;font-size:var(--fs-sm);line-height:1.55">${c.email.body}</div><div class="faint" style="font-size:var(--fs-xs)">${providerLabel(c.agent)}</div></div>` : html`<div class="faint">The email is written with the storyboard.</div>`}
        ${pkg.conversationId ? html`<${Button} kind="ghost" icon="messages" onClick=${() => navigate(`/messages/${pkg.conversationId}`)}>Open the draft (edit, then approve)</${Button}>` : null}
      </div>` : null}
      ${tab === 'brief' ? html`<div class="col selectable" style="gap:10px;font-size:var(--fs-sm);line-height:1.55">
        ${b.headline ? html`<h3>${b.headline}</h3>` : null}${b.summary ? html`<p>${b.summary}</p>` : null}
        ${(b.sections || []).map((s) => html`<div><h4>${s.title}</h4><ul style="padding-left:18px">${(s.points || []).map((x) => html`<li>${x}</li>`)}</ul></div>`)}
        ${b.themes?.length ? html`<div><h4>Issues they care about</h4><div class="row wrap" style="gap:6px">${b.themes.map((t) => html`<span class="badge lav">${t}</span>`)}</div></div>` : null}
        ${b.contentGaps?.length ? html`<div><h4>Video & social opportunities</h4><ul style="padding-left:18px">${b.contentGaps.map((x) => html`<li>${x}</li>`)}</ul></div>` : null}
        ${b.angle ? html`<div class="notice sky">${b.angle}</div>` : null}
        ${!b.headline ? html`<div class="faint">The brief appears after research.</div>` : html`<div class="faint" style="font-size:var(--fs-xs)">${providerLabel(b.agent)} · numbers in brackets are sources (see the Sources tab)</div>`}
      </div>` : null}
      ${tab === 'call' ? html`<div class="col" style="gap:10px">
        <div class="notice gold">Calls are made by a person. Automated or prerecorded calls to people who haven't agreed to them are illegal under federal robocall law (the TCPA), including AI-cloned voices.</div>
        ${pkg.profile?.officePhone ? html`<div class="row" style="gap:8px"><b>Office phone</b><a href=${'tel:' + pkg.profile.officePhone}>${pkg.profile.officePhone}</a><span class="faint" style="font-size:var(--fs-xs)">(government office; ask for the campaign contact)</span></div>` : null}
        ${c.callScript ? html`<div class="panel pad selectable" style="white-space:pre-wrap;font-size:var(--fs-sm);line-height:1.55">${c.callScript}</div>` : html`<div class="faint">The call script is written with the storyboard.</div>`}
        ${c.voiceNote ? html`<div><h4>Voice note script</h4><div class="panel pad selectable" style="white-space:pre-wrap;font-size:var(--fs-sm)">${c.voiceNote}</div><div class="faint" style="font-size:var(--fs-xs)">Record it in your own voice and attach it to the email if you like.</div></div>` : null}
        <div class="row wrap" style="gap:6px">${[['contacted', 'Called: left a message'], ['replied', 'Called: talked to them'], ['meeting', 'Booked a meeting'], ['lost', 'Not interested']].map(([k, l]) => html`<button class="chip" onClick=${() => act(() => api.patch(`/api/prospects/${p.id}`, { stage: k, notes: `${p.notes ? p.notes + '\n' : ''}${new Date().toLocaleDateString()}: ${l}` }), { ok: 'Logged' }).then(reload)}>${l}</button>`)}</div>
      </div>` : null}
      ${tab === 'sources' ? html`<ol class="selectable" style="padding-left:22px;font-size:var(--fs-sm);line-height:1.6">${(pkg.sources || []).map((s) => html`<li value=${s.n}><a href=${s.url} target="_blank" rel="noreferrer">${s.title}</a></li>`)}${pkg.researchErrors?.length ? html`<div class="faint" style="margin-top:8px;font-size:var(--fs-xs)">Unavailable: ${pkg.researchErrors.join(' · ')}</div>` : null}</ol>` : null}
      <div class="faint" style="font-size:var(--fs-xs)">${pkg.finishedAt ? `Made ${ago(pkg.finishedAt)}` : ''}</div>
    </div></${Drawer}>`;
}
