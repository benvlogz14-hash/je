// Political outreach: names or a scout query in, finished packages out
// (cited brief, vertical + horizontal video, one-page sheet, email draft waiting in Approvals).
import { html, useState, useEffect, useRef, useApi, navigate, Button, Drawer, Modal, Field, Tabs, Progress, Toggle, act, toast, confirmDialog, store } from '../lib/ui.js';
import { api } from '../lib/api.js';
import { Icon } from '../lib/icons.js';
import { ago, providerLabel } from '../lib/format.js';
import { CopyStyle } from './reverse.js';

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
  // Names entered here this session: their progress shows right under the box until each one is done.
  const [tracked, setTracked] = useState([]);
  const make = () => act(() => api.post('/api/political/packages', { names }), { ok: (r) => `${r.queued} package${r.queued === 1 ? '' : 's'} started` }).then((r) => { if (r?.ids) setTracked((t) => [...r.ids, ...t.filter((x) => !r.ids.includes(x))]); setNames(''); reload(); });
  const scout = () => act(() => api.post('/api/political/scout', { query, count, autoPackage: auto }), { ok: 'Scouting started. New leads appear below.' }).then(() => setQuery(''));
  const approve = async () => {
    const ids = [...picked].filter((id) => ready.some((p) => p.id === id));
    if (!ids.length) return toast('Tick the packages you reviewed first.');
    if (!(await confirmDialog({ title: `Send ${ids.length} email${ids.length === 1 ? '' : 's'}?`, text: 'Each goes out with its videos and sheet attached, within your hourly sending limit and quiet hours. In Test mode they go to your sandbox address.', confirm: 'Send', kind: 'moss' }))) return;
    act(() => api.post('/api/political/approve', { ids }), { ok: (r) => `${r.approved} approved${r.errors.length ? ` · ${r.errors.length} skipped` : ''}` }).then(() => { setPicked(new Set()); reload(); });
  };
  const toggle = (id) => setPicked((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const cur = open && list.find((p) => p.id === open);
  // The ad machine at the top of the page opens a lead's panel here.
  useEffect(() => { const h = (e) => setOpen(e.detail); window.addEventListener('eu:openLead', h); return () => window.removeEventListener('eu:openLead', h); }, []);

  return html`<div class="col" style="gap:16px">
    <div class="grid-2" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:16px">
      <div class="panel pad col" style="gap:10px">
        <div class="row"><div class="avatar" style="background:var(--sky-soft);color:var(--sky-ink)"><${Icon} name="sparkle" size=${16} /></div><h4 class="grow">Make packages</h4></div>
        <div class="muted" style="font-size:var(--fs-sm)">One name per line. Add the office or state after a dash if the name is common.</div>
        <textarea class="input" rows="5" id="pol-names" placeholder=${'Jane Rivera — Texas House District 12\nJohn Smith, Ohio State Senate'} value=${names} onInput=${(e) => setNames(e.target.value)} style="resize:vertical;font-family:inherit;height:120px;min-height:90px" />
        <div class="row"><span class="faint grow" style="font-size:var(--fs-xs)">Each: brief, 2 videos, sheet, email draft</span><${Button} kind="primary" icon="sparkle" disabled=${!names.trim()} onClick=${make}>Make packages</${Button}></div>
        <${MakeProgress} ids=${[...new Set([...tracked, ...(jobs || []).filter((j) => j.type === 'political.package' && j.payload?.prospectId).map((j) => j.payload.prospectId)])]} list=${list} jobFor=${jobFor} steps=${steps || []} onOpen=${setOpen} onClear=${(id) => setTracked((t) => t.filter((x) => x !== id))} />
      </div>
      <div class="panel pad col" style="gap:10px">
        <div class="row"><div class="avatar" style="background:var(--lav-soft);color:var(--lav-ink)"><${Icon} name="search" size=${16} /></div><h4 class="grow">Scout new leads</h4></div>
        <input class="input" id="pol-scout" placeholder="e.g. Ohio state house candidates 2026 with little video on social" value=${query} onInput=${(e) => setQuery(e.target.value)} onKeyDown=${(e) => { if (e.key === 'Enter' && query.trim()) scout(); }} />
        <div class="row wrap" style="gap:12px"><label class="row" style="gap:6px">How many <input class="input" type="number" min="1" max="100" value=${count} onInput=${(e) => setCount(e.target.value)} style="width:72px" /></label>
          <${Toggle} on=${auto} onChange=${setAuto} label="Make packages automatically" /><div class="spacer" /><${Button} kind="lav" icon="search" disabled=${query.trim().length < 4} onClick=${scout}>Scout</${Button}></div>
        ${scouting.length ? html`<div class="col" style="gap:8px">${scouting.map((j) => html`<div class="col" style="gap:4px"><div class="row" style="gap:8px;font-size:var(--fs-sm)"><span class="spinner" /><b class="grow ellipsis">${j.title}</b><span class="faint tnum">${j.status === 'queued' ? 'Waiting' : `${Math.round((j.progress || 0) * 100)}%`}</span></div><${Progress} value=${j.progress || 0} indeterminate=${j.status === 'queued' || !j.progress} /><div class="faint ellipsis" style="font-size:var(--fs-xs)">${j.note || 'Starting'}</div></div>`)}</div>` : html`<div class="faint" style="font-size:var(--fs-xs)">Uses Open States (state legislators) and your research agent. Duplicates are skipped.</div>`}
      </div>
    </div>

    <div class="panel pad col" style="gap:10px">
      <div class="row"><h4 class="grow">Package settings</h4><${Button} size="sm" kind="ghost" onClick=${() => setShowSettings(!showSettings)}>${showSettings ? 'Hide' : 'Show'}</${Button}></div>
      ${showSettings ? html`<${PackageSettings} />` : html`<div class="faint" style="font-size:var(--fs-sm)">Ad style and lengths, your plan, booking link, who signs, your email templates, colours, contrast ads and narrator voice.</div>`}
    </div>
    <${CopyStyle} />

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

/**
 * Progress for the names just entered: one bar per politician with the step it's on (Research, Brief, Videos...),
 * the step dots, and when it's done, the result (ready to review, needs an email, needs attention) with Open.
 */
function MakeProgress({ ids, list, jobFor, steps, onOpen, onClear }) {
  if (!ids.length) return null;
  const rows = ids.map((id) => list.find((p) => p.id === id)).filter(Boolean);
  if (!rows.length) return null;
  return html`<div class="col" style="gap:10px;border-top:1px solid var(--line);padding-top:10px">
    ${rows.map((p) => {
      const j = jobFor(p.id); const st = p.pkg?.status;
      const done = !j && st && st !== 'running'; const n = steps.length || 7;
      const frac = j ? (j.progress || 0) : done ? 1 : 0;
      const at = j ? Math.min(n - 1, Math.floor(frac * n)) : done ? n : -1;
      const label = j ? (j.status === 'queued' ? 'Waiting for the last one to finish' : j.note || 'Starting') : done ? (st === 'failed' && p.pkg?.error ? `Needs attention: ${p.pkg.error}` : (STATUS[st] || ['Done'])[0]) : 'Starting';
      const tone = done ? (st === 'ready' ? 'var(--moss, #3a9d6a)' : st === 'failed' ? 'var(--coral, #e0674f)' : 'var(--gold, #d9a520)') : null;
      return html`<div class="col" style="gap:5px">
        <div class="row" style="gap:8px;font-size:var(--fs-sm)">${j ? html`<span class="spinner" />` : html`<span style=${{ color: tone, fontWeight: 700 }}>${st === 'ready' ? '✓' : '!'}</span>`}
          <b class="grow ellipsis">${p.name}</b><span class="faint tnum">${j ? (j.status === 'queued' ? 'Queued' : `${Math.round(frac * 100)}%`) : ''}</span>
          ${done ? html`<${Button} size="sm" kind="ghost" onClick=${() => onOpen(p.id)}>Open</${Button}><button class="icon-btn" title="Hide" aria-label="Hide" onClick=${() => onClear(p.id)}>×</button>` : null}</div>
        <${Progress} value=${frac} color=${tone} indeterminate=${!!j && (j.status === 'queued' || !j.progress)} />
        <div class="row" style="gap:8px"><span class="faint grow ellipsis" style="font-size:var(--fs-xs)">${label}</span>
          ${steps.length ? html`<span class="row" style="gap:3px" title=${steps.map((s) => s.label || s.id || s).join(' → ')}>${steps.map((s, i) => html`<i style=${{ display: 'block', width: '7px', height: '7px', borderRadius: '50%', background: i < at ? 'var(--teal-ink, #2a8a7a)' : i === at ? 'var(--sky-ink, #3b82c4)' : 'var(--line)' }} />`)}</span>` : null}</div>
      </div>`;
    })}
  </div>`;
}

function PackageSettings() {
  const boot = store.get().boot || {};
  const init = boot.settings?.political || {};
  const [v, setV] = useState({ backgrounds: 'photo', photoMode: 'auto', photoCutout: true, campaignPhotos: true, videoStyle: 'pro', shortSeconds: 20, videoSeconds: 60, longVideo: true, socialVideo: true, contrastAds: false, brandColors: true, plan: '12 posts a week for $949', bookingUrl: '', senderName: '', offer: '', templates: '', theme: 'auto', narration: false, musicDir: '', musicOn: true, ...init });
  const set = (k) => (e) => setV({ ...v, [k]: e && e.target ? (e.target.type === 'number' ? Number(e.target.value) : e.target.value) : e });
  const save = () => act(() => { const { proLook: _l, ...rest } = v; return api.patch('/api/settings', { political: rest }); }, { ok: 'Saved' }).then((s) => { const b = store.get().boot; if (b && s) store.set({ boot: { ...b, settings: s } }); });
  return html`<div class="col" style="gap:12px">
    <div class="form-grid">
      <${Field} label="Ad style" id="pol-style"><select id="pol-style" class="input" value=${v.videoStyle} onChange=${set('videoStyle')}><option value="pro">Pro motion graphics from their footage (recommended)</option><option value="campaign">Campaign ad (graphics, like real political ads)</option><option value="speech">Their own speeches, with B-roll and captions</option><option value="pop">Bubbly and poppy</option></select></${Field}>
      <${Field} label="Short ads (seconds)" hint="Vertical and horizontal, 10 to 90" id="pol-short"><input id="pol-short" class="input" type="number" min="10" max="90" value=${v.shortSeconds} onInput=${set('shortSeconds')} /></${Field}>
      <${Field} label="Long ad (seconds)" hint="Horizontal, 30 to 240" id="pol-len"><input id="pol-len" class="input" type="number" min="30" max="240" value=${v.videoSeconds} onInput=${set('videoSeconds')} /></${Field}>
      <${Field} label="Your political plan (one line)" id="pol-plan"><input id="pol-plan" class="input" value=${v.plan} onInput=${set('plan')} placeholder="12 posts a week for $949 a month" /></${Field}>
      <${Field} label="Booking link" hint="Shown in the email and on the sheet" id="pol-book"><input id="pol-book" class="input" placeholder="https://calendly.com/..." value=${v.bookingUrl} onInput=${set('bookingUrl')} /></${Field}>
      <${Field} label="Who signs the email" id="pol-sender"><input id="pol-sender" class="input" placeholder="Ryan Rosario" value=${v.senderName} onInput=${set('senderName')} /></${Field}>
      <${Field} label="Backgrounds" id="pol-bg"><select id="pol-bg" class="input" value=${v.backgrounds || 'photo'} onChange=${set('backgrounds')}><option value="photo">Real photos of their town and state (free, credited)</option><option value="vector">Plain colour graphics</option></select></${Field}>
      <${Field} label="Candidate photo in the ads" id="pol-photo"><select id="pol-photo" class="input" value=${v.photoMode || 'auto'} onChange=${set('photoMode')}><option value="auto">Best available (cut-out, then photo, then silhouette)</option><option value="cutout">Cut-out only</option><option value="full">Full photo</option><option value="silhouette">"Your photo here" placeholder</option></select></${Field}>
      <${Field} label="Colours (bubbly style)" id="pol-theme"><select id="pol-theme" class="input" value=${v.theme} onChange=${set('theme')}>${[['auto', 'Match their party'], ['blue', 'Blue'], ['red', 'Red'], ['purple', 'Purple'], ['green', 'Green']].map(([k, l]) => html`<option value=${k}>${l}</option>`)}</select></${Field}>
      <${Field} label="Music folder (optional)" hint="One track is picked for each video" id="pol-music"><div class="row" style="gap:6px"><input id="pol-music" class="input" value=${v.musicDir} onInput=${set('musicDir')} placeholder="C:\\Music\\Upbeat" />${window.euclidean?.pickFolder || boot.electron ? html`<${Button} size="sm" kind="ghost" onClick=${() => api.post('/api/system/pick-folder', {}).then((r) => r.path && setV({ ...v, musicDir: r.path })).catch(() => {})}>Choose</${Button}>` : null}</div></${Field}>
    </div>
    ${v.videoStyle === 'pro' ? html`<div class="panel pad" style="background:var(--surface-2)"><${DefaultLook} /></div>` : null}
    <div class="col" style="gap:8px">${[['photoCutout', 'Remove photo backgrounds with AI (needs a remove.bg key or the free rembg tool)'], ['campaignPhotos', "Also use the photo from the candidate's own website (credited)"], ['longVideo', 'Make the long horizontal ad too'], ['socialVideo', 'Also make a social media video (not an ad) about what they have been doing, for incumbents to post'], ['brandColors', "Use the colours from the candidate's own website (campaign style)"], ['contrastAds', 'Allow contrast ads against a researched opponent (cited facts only; always needs your review)'], ['narration', 'AI narrator voice over the long ad (needs OpenAI)'], ['musicOn', 'Add mood-matched royalty-free music (your folder, a free licensed library, or music Euclidean makes itself)']].map(([k, l]) => html`<label class="row" style="gap:8px"><${Toggle} on=${!!v[k]} onChange=${(x) => setV({ ...v, [k]: x })} label=${l} /><span>${l}</span></label>`)}</div>
    <div class="faint" style="font-size:var(--fs-xs)">Music: put tracks in a "positive" and a "contrast" subfolder of your music folder to match the mood of each ad.</div>
    <${Field} label="Your offer, in your words (optional)" id="pol-offer"><textarea id="pol-offer" class="input" rows="2" value=${v.offer} onInput=${set('offer')} placeholder="Two free videos, yours to use whether or not we talk. Could you give us 20 minutes?" style="font-family:inherit;height:64px" /></${Field}>
    <${Field} label="Your best outreach emails" hint="Paste 1-3 emails that worked. The writer matches their voice and structure." id="pol-tpl"><textarea id="pol-tpl" class="input" rows="6" value=${v.templates} onInput=${set('templates')} style="font-family:inherit;height:150px" /></${Field}>
    <div class="row"><${Button} kind="primary" onClick=${save}>Save settings</${Button}><span class="faint" style="font-size:var(--fs-xs)">Data keys (Open States, api.data.gov) are in Settings → Connections.</span></div>
  </div>`;
}

function PackageDrawer({ p, steps, job, onClose, reload }) {
  const [tab, setTab] = useState(() => (p.pkg?.files?.v || p.pkg?.files?.h ? 'videos' : 'about'));
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
        ${!pkg.error && pkg.noAds ? html`<div class="notice gold">${pkg.noAds}</div>` : null}
      </div>
      <${FootageLinks} p=${p} pkg=${pkg} run=${run} busy=${!!job} reload=${reload} />
      <${LookPanel} p=${p} pkg=${pkg} busy=${!!job} reload=${reload} />
      <${Tabs} value=${tab} onChange=${setTab} tabs=${[{ value: 'about', label: 'About' }, { value: 'videos', label: 'Videos & sheet' }, { value: 'email', label: 'Email' }, { value: 'brief', label: 'Brief' }, { value: 'call', label: 'Call' }, { value: 'sources', label: `Sources ${pkg.sources?.length || ''}` }, ...(p.grok ? [{ value: 'grok', label: 'GrokBot' }] : [])]} />
      ${tab === 'grok' && p.grok ? html`<div class="col" style="gap:10px"><${ElectionResult} p=${p} reload=${reload} /><${GrokTab} g=${p.grok} /></div>` : null}
      ${tab === 'about' ? html`<div class="col selectable" style="gap:10px;font-size:var(--fs-sm);line-height:1.55">
        <${ElectionResult} p=${p} reload=${reload} />
        ${b.headline ? html`<h3>${b.headline}</h3>` : null}
        <div class="grid c2" style="gap:8px">${[['Office', pkg.profile?.office || p.location], ['Party', pkg.profile?.party], ['Stage', p.stage || 'new'], ['Contact email', p.publicContact || pkg.profile?.contact || 'not found yet'], ['Office phone', pkg.profile?.officePhone], ['Found by', p.source ? `${p.source}${p.query ? ` ("${p.query}")` : ''}` : '']].filter(([, v]) => v).map(([k, v]) => html`<div class="panel pad" style="padding:8px 12px"><div class="faint" style="font-size:var(--fs-xs)">${k}</div><b style="overflow-wrap:anywhere">${v}</b></div>`)}</div>
        ${p.why || p.angle || b.angle ? html`<div class="notice sky">${b.angle || p.angle || p.why}</div>` : null}
        ${b.summary ? html`<p>${b.summary}</p>` : null}
        ${b.themes?.length ? html`<div><b>Their issues</b><div class="row wrap" style="gap:6px;margin-top:4px">${b.themes.map((t) => html`<span class="badge lav">${t}</span>`)}</div></div>` : null}
        ${(pkg.profile?.sites || []).length || (pkg.profile?.socials || []).length ? html`<div><b>Online</b><div class="col" style="gap:2px;margin-top:4px">${[...(pkg.profile?.sites || []), ...(pkg.profile?.socials || [])].slice(0, 10).map((u) => html`<a href=${u} target="_blank" rel="noreferrer">${String(u).replace(/^https?:\/\/(www\.)?/, '')}</a>`)}</div></div>` : null}
        ${p.notes ? html`<div><b>Notes</b><div style="white-space:pre-wrap">${p.notes}</div></div>` : null}
        ${!b.headline && !pkg.profile ? html`<div class="faint">Details fill in as the research step runs.</div>` : null}
      </div>` : null}
      ${tab === 'videos' ? html`<div class="col" style="gap:12px">
        ${pkg.files?.v || pkg.files?.h || pkg.files?.hl || pkg.files?.s ? html`<${FinishedAds} p=${p} compact />` : html`<div class="faint">Videos appear here when the package is made.</div>`}
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

/** Won or lost on Nov 3. Everyone counts as having won (an officeholder now) unless marked Lost; Lost is never contacted. */
function ElectionResult({ p, reload }) {
  const lost = p.electionResult === 'lost';
  const set = (v) => act(() => api.patch(`/api/prospects/${p.id}`, { electionResult: v }), { ok: v === 'lost' ? `${p.name} marked Lost: nothing will be sent` : `${p.name} marked Won` }).then(reload);
  return html`<div class=${`notice ${lost ? 'coral' : ''}`} style="align-items:center">
    <span class="grow">${lost ? `${p.name} lost on Nov 3, so nothing is drafted or sent to them.` : `${p.name} is treated as an officeholder (won Nov 3 or in office). Mark Lost if they lost.`}</span>
    <${Button} size="sm" kind=${lost ? 'primary' : 'ghost'} onClick=${() => set(lost ? 'won' : 'lost')}>${lost ? 'They won' : 'They lost'}</${Button}></div>`;
}

/** GrokBot's research and drafts for this candidate (imported from its Oct 28 packs), each draft with Copy. */
function GrokTab({ g }) {
  const copy = (t) => { navigator.clipboard?.writeText(t).then(() => toast('Copied', { kind: 'ok', ms: 1200 })).catch(() => toast('Select the text and copy it', { kind: 'warn' })); };
  const D = g.drafts || {};
  const block = (title, text, extra) => (text ? html`<div class="panel pad col" style="gap:6px"><div class="row"><b class="grow" style="font-size:var(--fs-sm)">${title}</b>${extra || null}<${Button} size="sm" kind="ghost" onClick=${() => copy(text)}>Copy</${Button}></div><div class="selectable" style="white-space:pre-wrap;font-size:var(--fs-sm);line-height:1.55">${text}</div></div>` : null);
  const words = (t) => String(t || '').split(/\s+/).filter(Boolean).length;
  return html`<div class="col" style="gap:10px">
    ${g.flags?.length ? html`<div class="row wrap" style="gap:6px">${g.flags.map((f) => html`<span class=${`badge ${/HOLD|Ryan/.test(f) ? 'coral' : 'gold'}`}>${f}</span>`)}</div>` : null}
    <div class="grid c2" style="gap:8px;font-size:var(--fs-sm)">${[['Status', g.status], ['Tier (internal)', [g.tier, g.finance].filter(Boolean).join(' · ')], ['Best channel', g.bestChannel], ['Email', g.emailNote], ['Phone', g.phone], ['Social', g.social], ['Prior contact', g.priorContact]].filter(([, v]) => v).map(([k, v]) => html`<div class="panel pad" style="padding:8px 12px"><div class="faint" style="font-size:var(--fs-xs)">${k}</div><span class="selectable" style="overflow-wrap:anywhere">${v}</span></div>`)}</div>
    ${g.hook ? html`<div class="notice sky selectable">${g.hook}</div>` : null}
    ${block(`First email${D.subject ? `: "${D.subject}"` : ''}`, D.email ? `${D.subject ? `Subject: ${D.subject}\n\n` : ''}${D.email}` : '')}
    ${block('Follow-up (day 4, same thread)', D.followup)}
    ${block('Live call', D.call)}
    ${block(`Voicemail (${words(D.voicemail)} words)`, D.voicemail)}
    ${block('DM', D.dm)}${block('Text', D.text)}
    <span class="faint" style="font-size:var(--fs-xs)">From ${g.pack} (GrokBot, Oct 28). Sources: ${g.sources || 'see the pack'}. Drafts only: nothing was sent.</span>
  </div>`;
}

/** Upload video files to a lead's footage, one at a time, reporting { name, frac, n, of } (null when done). */
async function uploadFootage(pid, files, setUp) {
  const list = [...files].filter((f) => /^video\//.test(f.type) || /\.(mp4|mov|m4v|mkv|webm|avi)$/i.test(f.name));
  if (!list.length) { toast('Choose video files (MP4, MOV...).', { kind: 'error' }); return; }
  for (let i = 0; i < list.length; i++) {
    const f = list[i];
    setUp({ name: f.name, frac: 0, n: i + 1, of: list.length });
    try {
      await new Promise((ok, bad) => {
        const x = new XMLHttpRequest(); x.open('POST', api.url(`/api/prospects/${pid}/footage/upload`));
        x.setRequestHeader('content-type', f.type || 'video/mp4'); x.setRequestHeader('x-file-name', encodeURIComponent(f.name));
        x.upload.onprogress = (e) => e.lengthComputable && setUp({ name: f.name, frac: e.loaded / e.total, n: i + 1, of: list.length });
        x.onload = () => { let d = {}; try { d = JSON.parse(x.responseText); } catch { /* text */ } x.status < 300 ? ok(d) : bad(new Error(d.error || `Upload failed (${x.status})`)); };
        x.onerror = () => bad(new Error('Upload failed: connection lost')); x.send(f);
      });
    } catch (e) { toast(`${f.name}: ${e.message}`, { kind: 'error' }); }
  }
  setUp(null);
}

/** Every uploaded video as a still with its length: hover to play, tick which ones the ads may use, remove. */
function FootageBank({ p, reload }) {
  const ups = p.footageUploads || [];
  if (!ups.length) return null;
  const usedFiles = new Set((p.pkg?.footage?.clips || []).map((c) => c.file).filter(Boolean));
  const on = ups.filter((u) => !u.off).length;
  const mins = (s) => `${Math.floor((s || 0) / 60)}:${String(Math.round((s || 0) % 60)).padStart(2, '0')}`;
  const toggle = (u) => api.patch(`/api/prospects/${p.id}/footage/${u.id}`, { off: !u.off }).then(reload).catch((e) => toast(e.message, { kind: 'error' }));
  const all = (v) => act(() => api.post(`/api/prospects/${p.id}/footage/select`, { all: v })).then(reload);
  const remove = async (u) => { if (await confirmDialog({ title: `Remove ${u.name}?`, text: 'The file is deleted from this candidate. Ads already made keep their copy.', confirm: 'Remove' })) act(() => api.del(`/api/prospects/${p.id}/footage/${u.id}`)).then(reload); };
  const hover = (e, u, play) => { const v = e.currentTarget.querySelector('video'); if (!v) return; if (play) { if (!v.src) v.src = api.url(`/api/prospects/${p.id}/footage/${u.id}/media`); v.currentTime = Math.min(5, (u.duration || 10) / 4); v.play().catch(() => {}); v.style.opacity = 1; } else { v.pause(); v.style.opacity = 0; } };
  return html`<div class="col" style="gap:8px">
    <div class="row wrap" style="gap:8px;align-items:center"><b style="font-size:var(--fs-sm)" class="grow">Footage bank <span class="faint" style="font-weight:400">${on} of ${ups.length} will be used</span></b>
      <button class="btn ghost sm" onClick=${() => all(true)}>Use all</button><button class="btn ghost sm" onClick=${() => all(false)}>Use none</button></div>
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(132px,1fr));gap:10px;max-height:420px;overflow:auto;padding:2px">
      ${ups.map((u) => html`<div key=${u.id} class="col" style=${`gap:4px;min-width:0;opacity:${u.off ? 0.45 : 1}`}>
        <div style=${`position:relative;aspect-ratio:16/10;border-radius:10px;overflow:hidden;background:#111;cursor:pointer;outline:3px solid ${u.off ? 'transparent' : 'var(--accent, #6c5ce7)'};outline-offset:-3px`}
          onClick=${() => toggle(u)} onMouseEnter=${(e) => hover(e, u, true)} onMouseLeave=${(e) => hover(e, u, false)} title=${u.off ? 'Not used: click to use it' : 'Used in the ads: click to leave it out'}>
          <img src=${api.url(`/api/prospects/${p.id}/footage/${u.id}/thumb`)} loading="lazy" alt="" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover" onError=${(e) => { e.target.style.display = 'none'; }} />
          <video muted playsinline preload="none" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;opacity:0;transition:opacity .15s" />
          <span style="position:absolute;left:6px;top:6px;width:22px;height:22px;border-radius:6px;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:14px;background:${u.off ? 'rgba(0,0,0,0.55)' : 'var(--accent, #6c5ce7)'};color:#fff;border:2px solid #fff">${u.off ? '' : '✓'}</span>
          <span style="position:absolute;right:6px;bottom:6px;background:rgba(0,0,0,0.7);color:#fff;font-size:11px;padding:1px 6px;border-radius:6px">${mins(u.duration)}</span>
          ${usedFiles.has(u.file) ? html`<span style="position:absolute;left:6px;bottom:6px;background:var(--moss, #2e9e5b);color:#fff;font-size:10px;padding:1px 6px;border-radius:6px">in the ads</span>` : null}
          ${u.hasAudio === false ? html`<span style="position:absolute;right:6px;top:6px;background:rgba(0,0,0,0.7);color:#fff;font-size:10px;padding:1px 6px;border-radius:6px">B-roll</span>` : null}
        </div>
        <div class="row" style="gap:4px;align-items:center;min-width:0"><span class="ellipsis grow" style="font-size:11px" title=${u.name}>${u.name}</span><button class="btn ghost sm" style="padding:0 6px" title="Remove" onClick=${() => remove(u)}>×</button></div>
      </div>`)}
    </div>
    <span class="faint" style="font-size:var(--fs-xs)">Hover to play. Click a video to leave it out of the ads, or back in. Silent videos are used as B-roll.</span>
  </div>`;
}

/**
 * The Drive link for the video email. The first email tells them the video is coming separately (no attachment, so it
 * stays out of spam); once that email has gone out and the link is here, the second email with the link follows in the
 * same thread 5 minutes later.
 */
function VideoLink({ p }) {
  const [v, setV] = useState(p.videoLink || ''); const [busy, setBusy] = useState(false);
  useEffect(() => { setV(p.videoLink || ''); }, [p.id, p.videoLink]);
  const ok = /^https?:\/\/\S+$/i.test(v.trim());
  const save = async () => { setBusy(true); try { await act(() => api.patch(`/api/prospects/${p.id}`, { videoLink: v.trim() }), { ok: 'Link saved' }); } catch { /* shown */ } setBusy(false); };
  const k = p.kit || {};
  const state = k.videoMessageId ? 'The video email is queued or sent (in their Messages thread).'
    : !k.videoEmail ? 'Make their email again after the ads are done, so it says the video is coming separately.'
    : !k.messageId ? 'Their first email isn\'t written yet (it needs a campaign email address).'
    : !p.videoLink ? 'Paste the Drive link below. The video email goes out 5 minutes after their first email is sent.'
    : 'Ready: the video email goes out 5 minutes after their first email is approved and sent.';
  return html`<div class="panel pad col" style="gap:8px;background:var(--surface-2)">
    <b style="font-size:var(--fs-sm)">Video email (sent after the first email, with the Drive link)</b>
    <div class="row" style="gap:6px"><input class="input grow" id=${`vl-${p.id}`} placeholder="https://drive.google.com/file/d/..." value=${v} onInput=${(e) => setV(e.target.value)} />
      <${Button} size="sm" kind="primary" disabled=${busy || (v.trim() && !ok) || v.trim() === (p.videoLink || '')} onClick=${save}>Save link</${Button}></div>
    <span class="faint" style="font-size:var(--fs-xs)">${v.trim() && !ok ? 'Paste the full link, starting with https://' : state} In Google Drive: right-click the video, Share, set "Anyone with the link", Copy link.</span>
  </div>`;
}

/**
 * The finished ads for one candidate, playable right where they were made: vertical, horizontal, long and social,
 * each with Download and Show in folder (desktop). A stamp on the address makes a remade ad load fresh.
 */
function FinishedAds({ p, compact = false }) {
  const pkg = p?.pkg || {}; const f = pkg.files || {};
  const kinds = [['v', 'Vertical', 'posterV', 'video_v'], ['h', 'Horizontal', 'posterH', 'video_h'], ['hl', 'Long horizontal', 'posterHL', 'video_hl'], ['s', 'Social video', 'posterS', 'video_s']].filter(([k]) => f[k]);
  if (!kinds.length) return null;
  const desktop = !!(window.euclidean || store.get().boot?.electron);
  const url = (k, st, extra = '') => api.url(`/api/prospects/${p.id}/file/${k}?at=${encodeURIComponent(pkg.steps?.[st]?.at || pkg.finishedAt || '')}${extra}`);
  const reveal = (k) => api.get(`/api/prospects/${p.id}/file/${k}?reveal=1`).catch((e) => toast(e.message, { kind: 'error' }));
  const name = (file) => String(file || '').split(/[\\/]/).pop();
  return html`<div class="col" style="gap:10px">
    <${VideoLink} p=${p} />
    <div class="row" style="gap:8px;align-items:center"><b style="font-size:var(--fs-sm)" class="grow">${p.name}'s ads${pkg.finishedAt ? html` <span class="faint" style="font-weight:400">· made ${ago(pkg.finishedAt)}${pkg.pro?.v?.look ? ` · ${pkg.pro.v.look}` : ''}</span>` : null}</b>
      ${desktop ? html`<${Button} size="sm" kind="ghost" icon="folder" onClick=${() => reveal(kinds[0][0])}>Open the folder</${Button}>` : null}</div>
    <div class="row wrap" style="gap:12px;align-items:flex-start">
      ${kinds.map(([k, label, poster, st]) => { const vert = k === 'v' || k === 's'; const w = vert ? (compact ? 150 : 200) : (compact ? 300 : 420);
        return html`<div class="col" style=${`gap:5px;width:${w}px;max-width:100%`}>
          <video key=${url(k, st)} src=${url(k, st)} poster=${f[poster] ? url(poster, st) : undefined} controls playsinline preload="metadata" style=${`width:100%;aspect-ratio:${k === 'v' || k === 's' ? '9/16' : '16/9'};border-radius:12px;background:#000;object-fit:contain`} />
          <b style="font-size:var(--fs-xs)">${label}</b>
          <span class="faint ellipsis" style="font-size:10px" title=${f[k]}>${name(f[k])}</span>
          <div class="row" style="gap:10px;font-size:var(--fs-xs)"><a href=${url(k, st, '&download=1')}>Download</a>${f[k + 'Mail'] ? html`<a href=${url(k + 'Mail', st, '&download=1')} title="A smaller 720p copy for attaching to an email">Email size</a>` : null}${desktop ? html`<a href="#" onClick=${(e) => { e.preventDefault(); reveal(k); }}>Show in folder</a>` : null}</div>
        </div>`; })}
    </div>
  </div>`;
}

/**
 * What happened with the last "Make the ads" for this candidate, always on show: working (with the step), waiting (and
 * exactly what for), finished (what was made or why no ads), or stopped (the reason and the last lines of its log).
 */
function RunStatus({ p, onWatch }) {
  const { data: r } = useApi(`/api/prospects/${p.id}/runs`, ['job', 'prospects']);
  const [open, setOpen] = useState(false);
  if (!r) return null;
  const j = r.jobs?.[0];
  if (!j) return html`<div class="faint" style="font-size:var(--fs-xs)">${p.name} has no ads yet. Tick their footage, pick a style, then press Make the ads.</div>`;
  const since = (t) => (t ? ago(t) : '');
  const took = j.startedAt && j.finishedAt ? Math.max(1, Math.round((new Date(j.finishedAt) - new Date(j.startedAt)) / 1000)) : null;
  const tookTxt = took == null ? '' : took < 90 ? `${took} s` : `${Math.round(took / 60)} min`;
  const label = (k) => r.steps.find((x) => x.key === k)?.label || k;
  // The steps this run touched (by their time), in order.
  const from = j.startedAt || j.createdAt;
  const ran = r.steps.map((x) => ({ ...x, st: r.pkgSteps[x.key] })).filter((x) => x.st && x.st.at && x.st.at >= from);
  const made = ['v', 'h', 'hl', 's'].some((k) => p.pkg?.files?.[k]);
  const icon = { done: '✓', failed: '!', skipped: '–', running: '…' };
  const tone = j.status === 'failed' ? 'coral' : j.status === 'queued' ? 'gold' : j.status === 'running' ? 'sky' : r.noAds ? 'gold' : 'moss';
  const head = j.status === 'running' ? `Working: ${j.note || 'starting'} (${Math.round(j.progress * 100)}%)`
    : j.status === 'queued' ? `Waiting to start. ${r.waiting || ''}`
    : j.status === 'failed' ? `Stopped ${since(j.finishedAt)}: ${j.error || r.error || 'no reason was given'}`
    : j.status === 'canceled' ? `Canceled ${since(j.finishedAt)}.`
    : r.noAds ? `Finished ${since(j.finishedAt)}${tookTxt ? ` in ${tookTxt}` : ''}, but no ads were made: ${r.noAds}`
    : `Finished ${since(j.finishedAt)}${tookTxt ? ` in ${tookTxt}` : ''}.`;
  return html`<div class=${`notice ${tone}`} style="display:grid;gap:8px">
    <div class="row" style="gap:8px;align-items:flex-start"><b class="grow" style="font-weight:600">${head}</b>
      ${made && !['running', 'queued'].includes(j.status) ? html`<${Button} size="sm" kind="moss" icon="play" onClick=${onWatch}>Watch the ads</${Button}>` : null}
      ${ran.length || j.log?.length ? html`<${Button} size="sm" kind="ghost" onClick=${() => setOpen(!open)}>${open ? 'Hide steps' : 'Show steps'}</${Button}>` : null}</div>
    ${open ? html`<div class="col" style="gap:3px;font-size:var(--fs-xs)">
      ${ran.map((x) => html`<div class="row" style="gap:6px;align-items:baseline"><b style="width:14px;text-align:center">${icon[x.st.status] || '○'}</b><span style="min-width:190px">${x.label}</span><span class="faint grow" style="overflow-wrap:anywhere">${x.st.error || x.st.note || ''}</span></div>`)}
      ${j.log?.length ? html`<details style="margin-top:4px"><summary class="faint">Log</summary><pre class="selectable" style="white-space:pre-wrap;font-size:11px;margin:4px 0 0">${j.log.join('\n')}</pre></details>` : null}
      <span class="faint">Run started ${since(j.createdAt)} · ${j.type === 'political.restyle' ? 'new look' : 'package'} · job ${j.id}</span>
    </div>` : null}
  </div>`;
}

/** Every candidate's finished ads as cards, newest first: click one to open it and play, download or find the files. */
function FinishedGallery({ list, jobs, onOpen }) {
  const done = list.filter((x) => ['v', 'h', 'hl', 's'].some((k) => x.pkg?.files?.[k])).sort((a, b) => String(b.pkg?.finishedAt || '').localeCompare(String(a.pkg?.finishedAt || '')));
  if (!done.length) return html`<div class="faint pad" style="text-align:center">No finished ads yet. Make some on the Make ads tab and they show up here.</div>`;
  const busy = (id) => (jobs || []).some((j) => ['political.package', 'political.restyle'].includes(j.type) && j.payload?.prospectId === id);
  return html`<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:14px">
    ${done.map((x) => { const f = x.pkg.files; const n = ['v', 'h', 'hl', 's'].filter((k) => f[k]).length; const pk = f.posterV ? 'posterV' : f.posterH ? 'posterH' : f.posterHL ? 'posterHL' : 'posterS';
      return html`<button type="button" key=${x.id} onClick=${() => onOpen(x.id)} title=${`Open ${x.name}'s ads`}
        style="display:flex;flex-direction:column;gap:6px;padding:8px;border-radius:14px;border:1px solid var(--line);background:var(--surface);cursor:pointer;text-align:left;min-width:0">
        <div style="position:relative;width:100%;aspect-ratio:9/12;border-radius:10px;overflow:hidden;background:#111">
          <img src=${api.url(`/api/prospects/${x.id}/file/${pk}?at=${encodeURIComponent(x.pkg?.finishedAt || '')}`)} alt="" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover" onError=${(e) => { e.target.style.display = 'none'; }} />
          <span style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center"><span style="width:44px;height:44px;border-radius:50%;background:rgba(0,0,0,0.55);color:#fff;display:flex;align-items:center;justify-content:center"><${Icon} name="play" size=${20} /></span></span>
          <span style="position:absolute;right:6px;bottom:6px;background:rgba(0,0,0,0.7);color:#fff;font-size:11px;padding:1px 7px;border-radius:6px">${n} video${n === 1 ? '' : 's'}</span>
          ${busy(x.id) ? html`<span style="position:absolute;left:6px;top:6px;background:var(--sky-ink, #3b82c4);color:#fff;font-size:10px;padding:1px 7px;border-radius:6px">Remaking</span>` : null}
        </div>
        <b class="ellipsis" style="font-size:var(--fs-sm)">${x.name}</b>
        <span class="faint ellipsis" style="font-size:var(--fs-xs)">${[x.pkg?.pro?.v?.look || x.pkg?.proLook?.name, x.pkg?.finishedAt ? ago(x.pkg.finishedAt) : ''].filter(Boolean).join(' · ') || (x.pkg?.profile?.office || x.location || '')}</span>
      </button>`; })}
  </div>`;
}

/** The ad machine, up front on Politics: pick the candidate, drop their footage, pick or describe a style, make the ads. */
export function AdMachine({ list, jobs, onOpen, reload }) {
  const { data: looks } = useApi('/api/political/looks');
  const [pid, setPid] = useState(() => list[0]?.id || '');
  const [newName, setNewName] = useState(''); const [newOffice, setNewOffice] = useState('');
  const [sel, setSel] = useState(null); const [prompt, setPrompt] = useState('');
  const [up, setUp] = useState(null); const [over, setOver] = useState(false);
  // Make ads | Finished: every finished ad as a card; click one to open it (`viewing`).
  const [tab, setTab] = useState('make'); const [viewing, setViewing] = useState(null);
  useEffect(() => { if (list.length && !list.some((x) => x.id === pid)) setPid(list[list.length - 1].id); }, [list.length]);
  const p = list.find((x) => x.id === pid);
  const busy = p && (jobs || []).some((j) => ['political.package', 'political.restyle'].includes(j.type) && j.payload?.prospectId === p.id);
  const job = p && (jobs || []).find((j) => ['political.package', 'political.restyle'].includes(j.type) && j.payload?.prospectId === p.id);
  const add = () => act(() => api.post('/api/prospects', { name: newName.trim(), type: 'political', location: newOffice.trim() }), { ok: 'Candidate added' }).then((r) => { if (r?.id) { setPid(r.id); setNewName(''); setNewOffice(''); reload(); } });
  const drop = (files) => { if (!p) { toast('Pick or add the candidate first.', { kind: 'error' }); return; } uploadFootage(p.id, files, setUp).then(reload); };
  const make = () => {
    if (!p) return;
    const t0 = Date.now();
    const body = prompt.trim() ? { prompt: prompt.trim() } : sel ? { preset: sel } : null;
    const req = body ? api.post(`/api/prospects/${p.id}/look`, body) : api.post(`/api/prospects/${p.id}/package`, p.pkg?.creative ? { from: 'footage' } : {});
    // A run already open for this candidate comes back instead of a new one: say so rather than pretending to start.
    return act(() => req, { ok: (j) => (j?.createdAt && new Date(j.createdAt).getTime() < t0 - 3000 ? `Already working on ${p.name}'s ads (${j.status === 'queued' ? 'waiting to start' : `${Math.round((j.progress || 0) * 100)}%`}). See below.` : `Making ${p.name}'s ads. Progress shows below.`) }).then(() => { setPrompt(''); reload(); });
  };
  const made = list.filter((x) => x.pkg?.files?.posterV).slice(-6).reverse();
  const nDone = list.filter((x) => ['v', 'h', 'hl', 's'].some((k) => x.pkg?.files?.[k])).length;
  // When the ads being made finish, the Finished tab opens with them playing.
  const wasBusy = useRef(new Set());
  useEffect(() => {
    const now = new Set((jobs || []).filter((j) => ['political.package', 'political.restyle'].includes(j.type) && j.payload?.prospectId).map((j) => j.payload.prospectId));
    for (const id of wasBusy.current) if (!now.has(id)) { const x = list.find((y) => y.id === id); if (x && ['v', 'h', 'hl', 's'].some((k) => x.pkg?.files?.[k])) { setTab('finished'); setViewing(id); } }
    wasBusy.current = now;
  }, [jobs, list]);
  const viewed = viewing && list.find((x) => x.id === viewing);
  const curLook = p?.pkg?.proLook?.name || looks?.current?.name || 'Bold blocks';
  return html`<div class="panel pad col" style="gap:14px">
    <div class="row" style="gap:10px;align-items:center"><div class="avatar" style="background:var(--coral-soft, var(--sky-soft));color:var(--coral-ink, var(--sky-ink))"><${Icon} name="film" size=${16} /></div>
      <div class="col grow" style="gap:2px"><h4>Ad machine</h4><span class="faint" style="font-size:var(--fs-xs)">Upload a candidate's footage. Their best lines, word for word, become motion-graphics ads in 9:16 and 16:9, in 15 styles or one you describe.</span></div></div>
    <${Tabs} value=${tab} onChange=${setTab} tabs=${[{ value: 'make', label: 'Make ads' }, { value: 'styles', label: `Styles (${(looks?.presets || []).length || 15})` }, { value: 'finished', label: `Finished${nDone ? ` (${nDone})` : ''}` }]} />
    ${viewed ? html`<${Modal} wide title=${`${viewed.name}'s ads`} onClose=${() => setViewing(null)} footer=${html`<${Button} kind="ghost" onClick=${() => { setViewing(null); onOpen(viewed.id); }}>Open ${viewed.name.split(' ')[0]}'s lead</${Button}><${Button} kind="ghost" onClick=${() => { setPid(viewed.id); setViewing(null); setTab('make'); }}>Make them again</${Button}><${Button} kind="primary" onClick=${() => setViewing(null)}>Done</${Button}>`}><${FinishedAds} p=${viewed} /></${Modal}>` : null}
    ${tab === 'styles' ? html`<${StylesGallery} presets=${looks?.presets || []} sel=${sel} onUse=${(id) => { setSel(id); setPrompt(''); setTab('make'); toast(`${(looks?.presets || []).find((x) => x.id === id)?.name || 'Style'} picked. Pick the candidate and press Make the ads.`, { kind: 'ok' }); }} />`
    : tab === 'finished' ? html`<${FinishedGallery} list=${list} jobs=${jobs} onOpen=${setViewing} />` : html`<div class="col" style="gap:14px">
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:16px;align-items:start">
      <div class="col" style="gap:10px;min-width:0">
        <b style="font-size:var(--fs-sm)">1 · The candidate</b>
        <select class="input" id="am-lead" value=${pid} onChange=${(e) => setPid(e.target.value)}>${!list.length ? html`<option value="">No candidates yet: add one below</option>` : null}${list.map((x) => html`<option value=${x.id}>${x.name}${x.pkg?.profile?.office || x.location ? ` · ${x.pkg?.profile?.office || x.location}` : ''}</option>`)}</select>
        <div class="row" style="gap:6px"><input class="input grow" id="am-new" placeholder="Or add someone: name" value=${newName} onInput=${(e) => setNewName(e.target.value)} /><input class="input" id="am-office" style="width:42%" placeholder="Office, e.g. Assembly AD-35, NY" value=${newOffice} onInput=${(e) => setNewOffice(e.target.value)} /><${Button} size="sm" kind="ghost" disabled=${!newName.trim()} onClick=${add}>Add</${Button}></div>
        <b style="font-size:var(--fs-sm);margin-top:4px">2 · Their footage</b>
        <label style=${`display:flex;flex-direction:column;align-items:center;gap:4px;padding:18px;border:2px dashed var(--line-strong, var(--line));border-radius:12px;cursor:pointer;text-align:center;background:${over ? 'var(--surface-2)' : 'transparent'}`}
          onDragOver=${(e) => { e.preventDefault(); setOver(true); }} onDragLeave=${() => setOver(false)} onDrop=${(e) => { e.preventDefault(); setOver(false); drop(e.dataTransfer.files); }}>
          <b>${up ? `Uploading ${up.n} of ${up.of}: ${Math.round(up.frac * 100)}%` : 'Drop their videos here, or click to choose'}</b>
          <span class="faint" style="font-size:var(--fs-xs)">${p ? `${(p.footageUploads || []).length} uploaded for ${p.name}` : 'Pick the candidate first'} · speeches, interviews, rallies, B-roll</span>
          <input type="file" accept="video/*" multiple style="display:none" disabled=${!!up || !p} onChange=${(e) => { drop(e.target.files); e.target.value = ''; }} />
        </label>
        ${up ? html`<${Progress} value=${up.frac} />` : null}
        ${p ? html`<${FootageBank} p=${p} reload=${reload} />` : null}
        ${made.length ? html`<b style="font-size:var(--fs-sm);margin-top:4px">Made recently</b><div class="row wrap" style="gap:8px">${made.map((x) => html`<button class="ghost" title=${`Show ${x.name}'s ads`} onClick=${() => setViewing(x.id)} style="padding:0;border:0;background:none;cursor:pointer;display:flex;flex-direction:column;gap:3px;align-items:center"><img src=${api.url(`/api/prospects/${x.id}/file/posterV?at=${encodeURIComponent(x.pkg?.steps?.video_v?.at || '')}`)} alt="" style="height:96px;border-radius:8px;border:1px solid var(--line)" onError=${(e) => { e.target.closest('button').style.display = 'none'; }} /><span class="faint ellipsis" style="font-size:10px;max-width:70px">${x.name.split(' ').slice(-1)[0]}</span></button>`)}</div>` : null}
      </div>
      <div class="col" style="gap:10px;min-width:0">
        <b style="font-size:var(--fs-sm)">3 · The style <span class="faint" style="font-weight:400">now: ${curLook}</span></b>
        <div style="max-height:420px;overflow:auto;padding-right:4px"><${LookPicker} presets=${looks?.presets || []} sel=${sel} onSel=${(id) => { setSel(id); if (id) setPrompt(''); }} /></div>
        <textarea class="input" rows="2" id="am-prompt" placeholder=${'Or describe it: "Zohran-style street vlog, orange and blue", "dark and cinematic, black and gold"'} value=${prompt} onInput=${(e) => { setPrompt(e.target.value); if (e.target.value.trim()) setSel(null); }} />
      </div>
    </div>
    <div class="row wrap" style="gap:10px;align-items:center">
      ${job ? html`<div class="col grow" style="gap:4px;min-width:200px"><${Progress} value=${job.progress || 0} /><span class="faint" style="font-size:var(--fs-xs)">${Math.round((job.progress || 0) * 100)}% · ${job.note || 'working'}</span></div>` : html`<span class="faint grow" style="font-size:var(--fs-xs)">${p ? `${p.name}: ${(p.footageUploads || []).length ? `${(p.footageUploads || []).filter((u) => !u.off).length} of ${(p.footageUploads || []).length} videos ticked` : 'no footage yet (it will look for public videos)'} · ${prompt.trim() ? 'your described style' : sel ? (looks?.presets || []).find((x) => x.id === sel)?.name : curLook}` : ''}</span>`}
      ${p ? html`<${Button} kind="ghost" size="sm" onClick=${() => onOpen(p.id)}>Open ${p.name.split(' ')[0]}</${Button}>` : null}
      <${Button} kind="primary" icon="sparkle" disabled=${!p || busy || !!up} title=${!p ? 'Pick or add the candidate first' : busy ? 'Already making this candidate\'s ads: see the progress below' : up ? 'Wait for the upload to finish' : ''} onClick=${make}>${busy ? 'Making the ads…' : up ? 'Uploading…' : 'Make the ads'}</${Button}>
    </div>
    ${p ? html`<${RunStatus} key=${p.id} p=${p} onWatch=${() => setViewing(p.id)} />` : null}
    </div>`}
  </div>`;
}

/** Sample ad for a preset look (built in: renderer/assets/looks/<id>.mp4 + .jpg, made by the ad engine itself). */
const lookVideo = (id) => `/ui/assets/looks/${id}.mp4`;
const lookPoster = (id) => `/ui/assets/looks/${id}.jpg`;

/** Every ad style as a moving sample (the showcase, in the app): watch them all, pick one with Use this style. */
function StylesGallery({ presets, sel, onUse }) {
  if (!presets?.length) return html`<div class="faint pad">Loading the styles…</div>`;
  return html`<div class="col" style="gap:10px">
    <span class="faint" style="font-size:var(--fs-xs)">A sample ad in each style, made by the ad engine from a real candidate's footage. Pick one, or describe your own on the Make ads tab.</span>
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:14px">
      ${presets.map((x) => html`<div key=${x.id} class="col" style=${`gap:6px;padding:8px;border-radius:14px;background:var(--surface);border:2px solid ${sel === x.id ? 'var(--accent, #6c5ce7)' : 'var(--line)'}`}>
        <div style=${`position:relative;width:100%;aspect-ratio:9/16;border-radius:10px;overflow:hidden;background:linear-gradient(${x.colors.slice(0, 3).join(',')})`}>
          <img src=${lookPoster(x.id)} alt="" loading="lazy" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover" onError=${(e) => { e.target.style.display = 'none'; }} />
          <video src=${lookVideo(x.id)} muted loop playsinline autoplay preload="metadata" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover" onError=${(e) => { e.target.style.display = 'none'; }} />
        </div>
        <b style="font-size:var(--fs-sm)">${x.name}</b>
        <span class="faint" style="font-size:var(--fs-xs);line-height:1.35;min-height:2.7em">${x.about}</span>
        <${Button} size="sm" kind=${sel === x.id ? 'primary' : 'ghost'} onClick=${() => onUse(x.id)}>${sel === x.id ? 'Picked' : 'Use this style'}</${Button}>
      </div>`)}
    </div>
  </div>`;
}

/** Preset looks as real preview stills (drawn by the ad engine itself), click to pick. */
function LookPicker({ presets, sel, onSel }) {
  // Hover plays the style's sample ad (built in), so you see it move before picking.
  const hover = (e, id, on) => { const v = e.currentTarget.querySelector('video'); if (!v) return; if (on) { if (!v.src) v.src = lookVideo(id); v.play().then(() => { v.style.opacity = 1; }).catch(() => {}); } else { v.pause(); v.style.opacity = 0; } };
  return html`<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(112px,1fr));gap:10px">${presets.map((x) => html`<button type="button" class=${'look-card' + (sel === x.id ? ' on' : '')} title=${x.about} onMouseEnter=${(e) => hover(e, x.id, true)} onMouseLeave=${(e) => hover(e, x.id, false)} onClick=${() => onSel(sel === x.id ? null : x.id)}
      style=${`display:flex;flex-direction:column;gap:4px;padding:6px;border-radius:12px;cursor:pointer;text-align:left;background:var(--surface);border:2px solid ${sel === x.id ? 'var(--accent, #6c5ce7)' : 'var(--line)'}`}>
      <div style=${`position:relative;width:100%;aspect-ratio:9/16;border-radius:8px;overflow:hidden;background:linear-gradient(${x.colors.slice(0, 3).join(',')})`}>
        <img src=${lookPoster(x.id)} loading="lazy" alt="" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover" onError=${(e) => { if (!e.target.dataset.fb) { e.target.dataset.fb = '1'; e.target.src = api.url(`/api/political/looks/preview?preset=${x.id}`); } else e.target.style.display = 'none'; }} />
        <video muted loop playsinline preload="none" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;opacity:0;transition:opacity .15s" onError=${(e) => { e.target.remove(); }} />
      </div>
      <b style="font-size:var(--fs-xs)">${x.name}</b>
      <span class="faint" style="font-size:10px;line-height:1.3">${x.about}</span>
    </button>`)}</div>`;
}
const LOOK_EXAMPLES = 'Or describe the style you want, in your own words: "dark and cinematic, black and gold, slow and serious", "bright TikTok style with giant captions", "breaking-news look with a ticker, red and black", "like the Larinda ad but green and white"';

/** How this lead's pro ads look: pick a preset or describe one; the ads are remade and the old ones kept as a version. */
function LookPanel({ p, pkg, busy, reload }) {
  const { data } = useApi('/api/political/looks');
  const own = pkg.proLook;
  const [sel, setSel] = useState(null);
  const [prompt, setPrompt] = useState('');
  const go = () => act(() => api.post(`/api/prospects/${p.id}/look`, prompt.trim() ? { prompt: prompt.trim() } : { preset: sel }), { ok: 'Remaking the ads in that look. The earlier ones are kept as a version.' }).then(() => { setPrompt(''); setSel(null); reload(); });
  const clear = () => act(() => api.post(`/api/prospects/${p.id}/look`, { clear: true }), { ok: 'This lead uses the default look again (remake the ads to see it).' }).then(reload);
  return html`<details class="panel pad">
    <summary><b>How the ads look</b> <span class="faint">${own ? `${own.name}${own.prompt ? ` · "${own.prompt.slice(0, 70)}${own.prompt.length > 70 ? '…' : ''}"` : ''}` : `the default look: ${data?.current?.name || 'Bold blocks'}`}</span></summary>
    <div class="col" style="gap:10px;margin-top:10px">
      ${own ? html`<div class="row" style="gap:12px;align-items:flex-start"><img src=${api.url(`/api/political/looks/preview?prospect=${p.id}&v=${encodeURIComponent(own.at || '')}`)} alt="" style="width:90px;border-radius:8px;border:1px solid var(--line)" onError=${(e) => { e.target.style.display = 'none'; }} />
        <div class="col" style="gap:4px;font-size:var(--fs-sm)"><b>${own.name}</b>${own.prompt ? html`<span class="faint">"${own.prompt}"</span>` : null}${own.notes ? html`<span class="faint">Editor notes: ${own.notes}</span>` : null}<span class="faint" style="font-size:var(--fs-xs)">${own.by === 'preset' ? 'Preset' : own.by === 'built-in' ? 'Read without an AI (connect one for finer control)' : `Designed by ${providerLabel ? providerLabel(String(own.by).split(':')[0]) : own.by}`}</span></div></div>` : null}
      <${LookPicker} presets=${data?.presets || []} sel=${sel} onSel=${(id) => { setSel(id); if (id) setPrompt(''); }} />
      <textarea class="input" rows="2" placeholder=${LOOK_EXAMPLES} value=${prompt} onInput=${(e) => { setPrompt(e.target.value); if (e.target.value.trim()) setSel(null); }} />
      <div class="row wrap" style="gap:6px"><${Button} size="sm" kind="primary" icon="sparkle" disabled=${busy || (!sel && !prompt.trim())} onClick=${go}>Make the ads in this look</${Button}>${own ? html`<${Button} size="sm" kind="ghost" onClick=${clear}>Use the default look</${Button}>` : null}</div>
      <div class="faint" style="font-size:var(--fs-xs)">A description can also steer the edit ("open on the housing line, keep it under 20 seconds"). Words on screen are always the candidate's own.</div>
    </div></details>`;
}

/** The default look for every lead's pro ads (Package settings). */
function DefaultLook() {
  const { data, reload } = useApi('/api/political/looks');
  const [sel, setSel] = useState(null); const [prompt, setPrompt] = useState(''); const [busy, setBusy] = useState(false);
  const cur = data?.current;
  const save = async () => { setBusy(true); await act(() => api.post('/api/political/looks/design', { ...(prompt.trim() ? { prompt: prompt.trim() } : { preset: sel }), save: true }), { ok: 'Saved as the default look' }); setBusy(false); setSel(null); setPrompt(''); reload(); };
  return html`<div class="col" style="gap:10px">
    <div class="row" style="gap:12px;align-items:center">${cur ? html`<img src=${api.url(`/api/political/looks/preview?default=1&v=${encodeURIComponent(cur.at || '')}`)} alt="" style="width:64px;border-radius:8px;border:1px solid var(--line)" onError=${(e) => { e.target.style.display = 'none'; }} />` : null}
      <div class="col" style="gap:2px"><b>Default look for the pro ads: ${cur?.name || 'Bold blocks (the reference ad)'}</b>${cur?.prompt ? html`<span class="faint" style="font-size:var(--fs-xs)">"${cur.prompt}"</span>` : null}<span class="faint" style="font-size:var(--fs-xs)">Each lead can have its own look too (open the lead → How the ads look).</span></div></div>
    <${LookPicker} presets=${data?.presets || []} sel=${sel} onSel=${(id) => { setSel(id); if (id) setPrompt(''); }} />
    <textarea class="input" rows="2" placeholder=${LOOK_EXAMPLES} value=${prompt} onInput=${(e) => { setPrompt(e.target.value); if (e.target.value.trim()) setSel(null); }} />
    <div class="row" style="gap:6px"><${Button} size="sm" kind="primary" disabled=${busy || (!sel && !prompt.trim())} onClick=${save}>${busy ? 'Designing…' : 'Save as the default look'}</${Button}></div>
  </div>`;
}

/** Their footage: videos the founders upload (first choice), pasted links, and what was picked from them. */
function FootageLinks({ p, pkg, run, busy, reload }) {
  const [links, setLinks] = useState([].concat(p.footageLinks || []).join('\n'));
  const [up, setUp] = useState(null); // { name, frac, n, of }
  const [over, setOver] = useState(false);
  const ft = pkg.footage; const uploads = p.footageUploads || [];
  const save = () => act(() => api.patch(`/api/prospects/${p.id}`, { footageLinks: links.split(/\s+/).filter((x) => /^https?:\/\//.test(x)) }), { ok: 'Saved' }).then(reload);
  const send = (files) => uploadFootage(p.id, files, setUp).then(reload);
  const mins = (s) => (s >= 60 ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}` : `${Math.round(s)}s`);
  return html`<details class="panel pad" open=${!!ft || uploads.length > 0}>
    <summary><b>Their footage</b> <span class="faint">${uploads.length ? `${uploads.length} uploaded · ` : ''}${ft ? `${ft.clips?.length || 0} videos used · ${ft.bites?.short?.length || 0} + ${ft.bites?.long?.length || 0} lines` : 'for the ads made from their own videos'}</span></summary>
    <div class="col" style="gap:8px;margin-top:8px">
      <label class=${`drop${over ? ' over' : ''}`} style="display:flex;flex-direction:column;align-items:center;gap:4px;padding:16px;border:2px dashed var(--line-strong, var(--line));border-radius:12px;cursor:pointer;text-align:center;background:${over ? 'var(--surface-2)' : 'transparent'}"
        onDragOver=${(e) => { e.preventDefault(); setOver(true); }} onDragLeave=${() => setOver(false)} onDrop=${(e) => { e.preventDefault(); setOver(false); send(e.dataTransfer.files); }}>
        <b>${up ? `Uploading ${up.n} of ${up.of}: ${up.name} (${Math.round(up.frac * 100)}%)` : 'Upload their videos'}</b>
        <span class="faint" style="font-size:var(--fs-xs)">Drop speeches, interviews, rallies, B-roll of the district. All of it gets used: the best lines become the ads.</span>
        <input type="file" accept="video/*" multiple style="display:none" disabled=${!!up} onChange=${(e) => { const fs = e.target.files; send(fs); e.target.value = ''; }} />
      </label>
      ${up ? html`<${Progress} value=${up.frac} />` : null}
      <${FootageBank} p=${p} reload=${reload} />
      ${(ft?.clips || []).filter((c) => c.url).length ? html`<ul style="padding-left:18px;font-size:var(--fs-sm)">${ft.clips.filter((c) => c.url).map((c) => html`<li><a href=${c.url} target="_blank" rel="noreferrer">${c.title || c.url}</a> <span class="faint">${c.platform}${c.uploader ? ` · ${c.uploader}` : ''}</span></li>`)}</ul>` : null}
      ${(ft?.bites?.short || []).length ? html`<div class="col" style="gap:4px;font-size:var(--fs-sm)"><b>Lines in the short ads</b>${ft.bites.short.map((b) => html`<div>${b.label ? html`<span class="badge lav">${b.label}</span> ` : null}"${b.text}"</div>`)}</div>` : null}
      ${ft?.errors?.length ? html`<div class="faint" style="font-size:var(--fs-xs)">${ft.errors.slice(-3).join(' · ')}</div>` : null}
      <textarea class="input" rows="2" placeholder="Or paste links to their videos, one per line (Facebook, YouTube, X, Instagram). Public videos only." value=${links} onInput=${(e) => setLinks(e.target.value)} />
      <div class="row" style="gap:6px"><${Button} size="sm" kind="ghost" onClick=${save}>Save links</${Button}><${Button} size="sm" kind="primary" disabled=${busy || !!up} onClick=${() => save().then(() => run({ from: 'footage' }, 'Reading their footage and remaking the ads'))}>Make the ads from this footage</${Button}></div>
      <div class="faint" style="font-size:var(--fs-xs)">It uses whole sentences exactly as they said them, never stitched words. To change an ad, write a note below ("open on the line about rent", "use the district map earlier") and the AI re-plans it.</div>
    </div></details>`;
}

