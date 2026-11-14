// Political outreach: names or a scout query in, finished packages out
// (cited brief, vertical + horizontal video, one-page sheet, email draft waiting in Approvals).
import { html, useState, useEffect, useRef, useApi, navigate, Button, Seg, Drawer, Modal, Field, Tabs, Progress, Toggle, act, toast, confirmDialog, store } from '../lib/ui.js';
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
          ${pkg.pro?.[k]?.qa ? html`<span style=${`font-size:10px;color:${pkg.pro[k].qa.ok ? 'var(--moss-ink, #2f7d4f)' : 'var(--coral-ink, #b4532a)'}`} title=${pkg.pro[k].qa.ok ? 'Loudness, peaks, black frames, dead air and cut points were measured after rendering.' : pkg.pro[k].qa.notes.join(' ')}>${pkg.pro[k].qa.ok ? `Checked: ${pkg.pro[k].qa.loudness != null ? `${pkg.pro[k].qa.loudness.toFixed(1)} LUFS, ` : ''}clean cuts, no black frames` : `Check: ${pkg.pro[k].qa.notes[0]}`}</span>` : null}
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

/**
 * 4 · The story (Nov 9, Ryan: "more of a narrative ... automate or choose manual 3 topic options or type the full prompt"):
 * Auto (the machine finds the strongest story in their words), one of 3 stories found in their footage, or the founders'
 * own brief. Saved on the lead (POST /api/prospects/:id/story); Make the ads tells that story.
 */
function StoryPicker({ p, jobs, reload }) {
  const st = p.story || { mode: 'auto' };
  const [mode, setMode] = useState(st.mode || 'auto'); const [brief, setBrief] = useState(st.brief || '');
  const finding = (jobs || []).find((j) => j.type === 'political.topics' && j.payload?.prospectId === p.id);
  const opts = p.pkg?.topics?.options || [];
  const save = (body, ok) => act(() => api.post(`/api/prospects/${p.id}/story`, body), { ok, sound: 'tap' }).then(reload);
  const pickMode = (m) => { setMode(m); if (m === 'auto') save({ mode: 'auto' }, 'The machine will pick the strongest story'); };
  const find = () => act(() => api.post(`/api/prospects/${p.id}/topics`, {}), { ok: (p.footageUploads || []).length ? 'Finding 3 stories in their footage' : 'Reading their footage, then finding 3 stories' }).then(reload);
  const now = st.mode === 'topic' ? `story: ${st.topic?.title}` : st.mode === 'brief' ? 'your brief' : 'picked automatically';
  return html`<div class="col" style="gap:8px;margin-top:6px">
    <b style="font-size:var(--fs-sm)">4 · The story <span class="faint" style="font-weight:400">now: ${now}</span></b>
    <${Seg} value=${mode} onChange=${pickMode} options=${[{ value: 'auto', label: 'Auto' }, { value: 'topic', label: 'Pick 1 of 3' }, { value: 'brief', label: 'Write the brief' }]} />
    ${mode === 'auto' ? html`<span class="faint" style="font-size:var(--fs-xs)">The machine builds the story from their best lines: a hook, who they are, what they did, their district, the rallying line, then the end card. About 30 seconds.</span>` : null}
    ${mode === 'topic' ? html`<div class="col" style="gap:6px">
      ${finding ? html`<div class="col" style="gap:3px"><${Progress} value=${finding.progress || 0} indeterminate=${!finding.progress} /><span class="faint" style="font-size:var(--fs-xs)">${finding.note || 'Waiting to start'}</span></div>`
        : html`<div class="row" style="gap:8px;align-items:center"><${Button} size="sm" kind=${opts.length ? 'ghost' : 'primary'} icon="sparkle" onClick=${find}>${opts.length ? 'Find 3 new stories' : 'Find 3 stories in their footage'}</${Button}>${opts.length ? html`<span class="faint" style="font-size:var(--fs-xs)">Click one to use it.</span>` : null}</div>`}
      ${opts.map((t) => { const on = st.mode === 'topic' && st.topic?.id === t.id && st.topic?.title === t.title; return html`<button type="button" class=${'panel pad' + (on ? ' on' : '')} style=${`text-align:left;cursor:pointer;border:2px solid ${on ? 'var(--accent, var(--sky))' : 'var(--line)'};display:flex;flex-direction:column;gap:2px`} onClick=${() => save({ mode: 'topic', topicId: t.id }, `Story: ${t.title}`)}>
        <b>${on ? '✓ ' : ''}${t.title}</b><span class="faint" style="font-size:var(--fs-xs)">${t.pitch} · ${t.ids.length} lines carry it</span></button>`; })}
    </div>` : null}
    ${mode === 'brief' ? html`<div class="col" style="gap:6px">
      <textarea class="input" rows="3" id="am-brief" placeholder=${'e.g. "Open on the fight over the corporate tax bill, show she\'s a scientist who wins for working families, end on Ithaca and the 125th. Punchy, under 30 seconds."'} value=${brief} onInput=${(e) => setBrief(e.target.value)} />
      <div class="row" style="gap:8px"><${Button} size="sm" kind="primary" disabled=${brief.trim().length < 8} onClick=${() => save({ mode: 'brief', brief: brief.trim() }, 'Brief saved: Make the ads tells this story')}>${st.mode === 'brief' && st.brief === brief.trim() ? 'Saved' : 'Use this brief'}</${Button}><span class="faint" style="font-size:var(--fs-xs)">Their own words only: the brief picks and orders the lines, it never puts words in their mouth.</span></div>
    </div>` : null}
  </div>`;
}

/** The ad machine, up front on Politics: pick the candidate, drop their footage, pick or describe a style, make the ads. */
const MAKING = ['political.package', 'political.restyle', 'political.batch', 'political.read'];
export function AdMachine({ list, jobs, onOpen, reload }) {
  const { data: looks } = useApi('/api/political/looks');
  const [pid, setPid] = useState(() => list[0]?.id || '');
  const [newName, setNewName] = useState(''); const [newOffice, setNewOffice] = useState('');
  const [sel, setSel] = useState(null); const [prompt, setPrompt] = useState('');
  const [dens, setDens] = useState(''); // how much graphics: '' = the style's own, full | light | minimal
  // What to make: a batch of videos from typed orders (the everyday job) or the outreach sample package.
  const [mode, setMode] = useState(() => { try { return localStorage.getItem('eu.adMode') || 'videos'; } catch { return 'videos'; } });
  const pickMode = (m) => { setMode(m); try { localStorage.setItem('eu.adMode', m); } catch { /* private window */ } };
  const [up, setUp] = useState(null); const [over, setOver] = useState(false);
  // Make ads | Finished: every finished ad as a card; click one to open it (`viewing`).
  const [tab, setTab] = useState('make'); const [viewing, setViewing] = useState(null);
  useEffect(() => { if (list.length && !list.some((x) => x.id === pid)) setPid(list[list.length - 1].id); }, [list.length]);
  const p = list.find((x) => x.id === pid);
  const busy = p && (jobs || []).some((j) => MAKING.includes(j.type) && j.payload?.prospectId === p.id);
  const job = p && (jobs || []).find((j) => MAKING.includes(j.type) && j.payload?.prospectId === p.id);
  const add = () => act(() => api.post('/api/prospects', { name: newName.trim(), type: 'political', location: newOffice.trim() }), { ok: 'Candidate added' }).then((r) => { if (r?.id) { setPid(r.id); setNewName(''); setNewOffice(''); reload(); } });
  const drop = (files) => { if (!p) { toast('Pick or add the candidate first.', { kind: 'error' }); return; } uploadFootage(p.id, files, setUp).then(reload); };
  const make = () => {
    if (!p) return;
    const t0 = Date.now();
    const body = prompt.trim() ? { prompt: prompt.trim(), ...(dens ? { density: dens } : {}) } : sel ? { preset: sel, ...(dens ? { density: dens } : {}) } : dens ? { density: dens } : null;
    const req = body ? api.post(`/api/prospects/${p.id}/look`, body) : api.post(`/api/prospects/${p.id}/package`, p.pkg?.creative ? { from: 'footage' } : {});
    // A run already open for this candidate comes back instead of a new one: say so rather than pretending to start.
    return act(() => req, { ok: (j) => (j?.createdAt && new Date(j.createdAt).getTime() < t0 - 3000 ? `Already working on ${p.name}'s ads (${j.status === 'queued' ? 'waiting to start' : `${Math.round((j.progress || 0) * 100)}%`}). See below.` : `Making ${p.name}'s ads. Progress shows below.`) }).then(() => { setPrompt(''); reload(); });
  };
  const made = list.filter((x) => x.pkg?.files?.posterV).slice(-6).reverse();
  const nDone = list.filter((x) => ['v', 'h', 'hl', 's'].some((k) => x.pkg?.files?.[k])).length;
  const nVideos = list.reduce((a, x) => a + (x.videos || []).length, 0);
  // When the ads being made finish, the Finished tab opens with them playing.
  const wasBusy = useRef(new Map());
  useEffect(() => {
    const running = (jobs || []).filter((j) => MAKING.includes(j.type) && j.payload?.prospectId);
    const now = new Map(running.map((j) => [j.payload.prospectId, j.type]));
    // When a batch finishes its videos open; when a package finishes its ads open.
    for (const [id, type] of wasBusy.current) if (!now.has(id)) { const x = list.find((y) => y.id === id); if (!x) continue; if (type === 'political.batch') { setPid(id); setTab('videos'); } else if (type === 'political.read') { /* the readout on the Make tab updates by itself */ } else if (['v', 'h', 'hl', 's'].some((k) => x.pkg?.files?.[k])) { setTab('finished'); setViewing(id); } }
    wasBusy.current = now;
  }, [jobs, list]);
  const viewed = viewing && list.find((x) => x.id === viewing);
  const curLook = p?.pkg?.proLook?.name || looks?.current?.name || 'Bold blocks';
  const office = p ? (p.pkg?.profile?.office || p.office || p.location || '') : '';
  const nUp = p ? (p.footageUploads || []).length : 0; const nOn = p ? (p.footageUploads || []).filter((u) => !u.off).length : 0; const nFound = p ? (p.footageFound || []).filter((v) => !v.off).length : 0;
  const tabs = [{ value: 'make', label: 'Make' }, { value: 'videos', label: `Videos${nVideos ? ` (${nVideos})` : ''}` }, { value: 'styles', label: `Styles (${(looks?.presets || []).length || 18})` }, { value: 'finished', label: `Sample ads${nDone ? ` (${nDone})` : ''}` }];
  const step = (n, title, sub, done) => html`<div class="am-step"><span class=${`am-num${done ? ' done' : ''}`}>${n}</span><h4>${title}</h4>${sub ? html`<span class="am-sub">${sub}</span>` : null}</div>`;
  return html`<div class="am">
    <div class="am-head">
      <div class="grow" style="min-width:260px"><h3>Ad machine</h3><p>Pick a politician, add their footage, and say what you want. Their own words come back as finished videos: full motion graphics, a clean captioned edit, or just the cuts.</p></div>
      <${Tabs} value=${tab} onChange=${setTab} tabs=${tabs} />
    </div>
    ${viewed ? html`<${Modal} wide title=${`${viewed.name}'s ads`} onClose=${() => setViewing(null)} footer=${html`<${Button} kind="ghost" onClick=${() => { setViewing(null); onOpen(viewed.id); }}>Open ${viewed.name.split(' ')[0]}'s lead</${Button}><${Button} kind="ghost" onClick=${() => { setPid(viewed.id); setViewing(null); setTab('make'); }}>Make them again</${Button}><${Button} kind="primary" onClick=${() => setViewing(null)}>Done</${Button}>`}><${FinishedAds} p=${viewed} /></${Modal}>` : null}
    ${tab === 'styles' ? html`<section class="panel am-card"><${StylesGallery} presets=${looks?.presets || []} sel=${sel} onUse=${(id) => { setSel(id); setPrompt(''); window.dispatchEvent(new CustomEvent('eu:amStyle', { detail: id })); setTab('make'); toast(`${(looks?.presets || []).find((x) => x.id === id)?.name || 'Style'} picked.`, { kind: 'ok' }); }} /></section>`
    : tab === 'videos' ? html`<section class="panel am-card"><${VideosTab} list=${list} pid=${pid} setPid=${setPid} jobs=${jobs} reload=${reload} onMake=${() => setTab('make')} /></section>`
    : tab === 'finished' ? html`<section class="panel am-card"><${FinishedGallery} list=${list} jobs=${jobs} onOpen=${setViewing} /></section>` : html`<div class="am-grid">
      <div class="am-col">
        <section class="panel am-card">
          ${step(1, 'Who it\'s for', `${list.length} on your list`, !!p)}
          ${p ? html`<div class="am-who"><span class="am-ini">${p.name.split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase()}</span>
            <div class="col grow" style="gap:1px;min-width:0"><b class="ellipsis">${p.name}</b><span class="am-help ellipsis">${office || 'No office noted yet'}${(p.videos || []).length ? ` · ${(p.videos || []).length} videos made` : ''}</span></div>
            <${Button} kind="ghost" size="sm" onClick=${() => onOpen(p.id)}>Open</${Button}></div>` : null}
          <${CandidatePicker} list=${list} pid=${pid} setPid=${setPid} reload=${reload} />
        </section>
        <section class="panel am-card">
          ${step(2, 'Their footage', p ? (nUp ? `${nOn} of ${nUp} uploads in use` : nFound ? `${nFound} public videos picked` : 'none yet') : '', nOn > 0 || nFound > 0)}
          <label class=${`am-drop${over ? ' over' : ''}`} onDragOver=${(e) => { e.preventDefault(); setOver(true); }} onDragLeave=${() => setOver(false)} onDrop=${(e) => { e.preventDefault(); setOver(false); drop(e.dataTransfer.files); }}>
            <b>${up ? `Uploading ${up.n} of ${up.of}: ${Math.round(up.frac * 100)}%` : 'Drop their videos here, or click to choose'}</b>
            <span class="am-help">${p ? 'Speeches, interviews, hearings, rallies, phone clips, B-roll. Raw is fine.' : 'Pick who it\'s for first'}</span>
            <input type="file" accept="video/*" multiple style="display:none" disabled=${!!up || !p} onChange=${(e) => { drop(e.target.files); e.target.value = ''; }} />
          </label>
          ${up ? html`<${Progress} value=${up.frac} />` : null}
          ${p ? html`<${FootageBank} p=${p} reload=${reload} />` : null}
          ${p ? html`<${GoogleVideos} p=${p} reload=${reload} />` : null}
        </section>
        <section class="panel am-card">
          ${step(3, 'What\'s in it', 'topics and the hook finder', false)}
          <${Insight} key=${p?.id || 'none'} p=${p} jobs=${jobs} />
        </section>
      </div>
      <div class="am-col">
        <div class="row wrap" style="gap:10px;align-items:center"><span class="am-label grow">What to make</span><${Seg} value=${mode} onChange=${pickMode} options=${[{ value: 'videos', label: 'Videos' }, { value: 'package', label: 'Outreach sample' }]} /></div>
        ${mode === 'videos' ? html`<${BatchMaker} key=${p?.id || 'none'} p=${p} list=${list} busy=${busy} job=${job} up=${up} looks=${looks} curLook=${curLook} reload=${reload} />` : html`
        <section class="panel am-card">
          ${step(4, 'The outreach sample', `now: ${curLook}`, false)}
          <span class="am-help">A short vertical ad, a short horizontal ad, a long one, the one-page sheet and the email draft. Nothing is sent.</span>
          <div style="max-height:420px;overflow:auto;padding-right:4px"><${LookPicker} presets=${looks?.presets || []} sel=${sel} onSel=${(id) => { setSel(id); if (id) setPrompt(''); }} /></div>
          <div class="am-sec"><span class="am-label">How much graphics</span><${Seg} value=${dens} onChange=${setDens} options=${[{ value: '', label: 'The style\'s own' }, ...(looks?.density || []).map((d) => ({ value: d.id, label: d.name }))]} /><span class="am-help">${dens === 'minimal' ? 'Captions, their name and proven facts only: the footage and their words carry it.' : dens === 'light' ? 'Headline, captions, name and proven facts. No stickers, icons, maps or extras.' : dens === 'full' ? 'Everything: headlines, icons, map, badges and the style\'s own moving extras.' : 'Each style decides (On location is captions only, the others use everything).'}</span></div>
          <textarea class="am-orders" style="min-height:64px" rows="2" id="am-prompt" placeholder=${'Or describe a style: "street vlog, orange and blue", "dark and cinematic, black and gold"'} value=${prompt} onInput=${(e) => { setPrompt(e.target.value); if (e.target.value.trim()) setSel(null); }} />
          ${p ? html`<${StoryPicker} key=${p.id} p=${p} jobs=${jobs} reload=${reload} />` : null}
        </section>
        <div class="am-bar">
          ${job ? html`<div class="col grow" style="gap:4px;min-width:200px"><${Progress} value=${job.progress || 0} /><span class="am-help">${Math.round((job.progress || 0) * 100)}% · ${job.note || 'working'}</span></div>` : html`<span class="sum">${p ? html`<b>${p.name}</b><br />${nUp ? `${nOn} of ${nUp} videos ticked` : 'no footage yet (it will look for public videos)'} · ${prompt.trim() ? 'your described style' : sel ? (looks?.presets || []).find((x) => x.id === sel)?.name : curLook}` : 'Pick who it\'s for'}</span>`}
          <${Button} kind="primary" icon="sparkle" disabled=${!p || busy || !!up} title=${!p ? 'Pick or add the candidate first' : busy ? 'Already making this candidate\'s ads: see the progress below' : up ? 'Wait for the upload to finish' : ''} onClick=${make}>${busy ? 'Making the ads…' : up ? 'Uploading…' : 'Make the sample package'}</${Button}>
        </div>`}
        ${p ? html`<${RunStatus} key=${p.id} p=${p} onWatch=${() => setViewing(p.id)} />` : null}
        ${made.length ? html`<section class="panel am-card"><span class="am-label">Sample ads made recently</span><div class="row wrap" style="gap:8px">${made.map((x) => html`<button class="ghost" title=${`Show ${x.name}'s ads`} onClick=${() => setViewing(x.id)} style="padding:0;border:0;background:none;cursor:pointer;display:flex;flex-direction:column;gap:3px;align-items:center"><img src=${api.url(`/api/prospects/${x.id}/file/posterV?at=${encodeURIComponent(x.pkg?.steps?.video_v?.at || '')}`)} alt="" style="height:96px;border-radius:10px;border:1px solid var(--line)" onError=${(e) => { e.target.closest('button').style.display = 'none'; }} /><span class="faint ellipsis" style="font-size:10px;max-width:70px">${x.name.split(' ').slice(-1)[0]}</span></button>`)}</div></section>` : null}
      </div>
    </div>`}
  </div>`;
}

/**
 * What's in their footage, before anything is made: how much they say, what about, and the hook finder (their best
 * opening lines). Clicking a topic or a hook adds a line to the order box.
 */
function Insight({ p, jobs }) {
  const { data: d, reload } = useApi(p ? `/api/prospects/${p.id}/insight` : null, ['prospects', 'job']);
  const [all, setAll] = useState(false);
  if (!p) return html`<span class="am-help">Pick who it's for, and what their footage holds shows here: what they talk about, and their strongest opening lines.</span>`;
  const reading = (jobs || []).find((j) => j.type === 'political.read' && j.payload?.prospectId === p.id);
  const busy = (jobs || []).some((j) => MAKING.includes(j.type) && j.payload?.prospectId === p.id);
  const read = () => act(() => api.post(`/api/prospects/${p.id}/insight`, {}), { ok: 'Reading their footage. The first time takes a few minutes; after that every video uses it.' }).then(reload);
  const add = (line) => { window.dispatchEvent(new CustomEvent('eu:amAdd', { detail: line })); toast(`Added: ${line.slice(0, 60)}`, { kind: 'ok' }); };
  if (!d) return html`<span class="am-help">Looking…</span>`;
  if (!d.ready) return html`<div class="am-sec">
    ${reading ? html`<${Progress} value=${reading.progress || 0} /><span class="am-help">${Math.round((reading.progress || 0) * 100)}% · ${reading.note || (reading.status === 'queued' ? 'waiting its turn' : 'reading')}</span>` : html`<span class="am-help">${d.why}${d.note ? ` ${d.note}` : ''} Reading it finds the videos, writes down every word and marks what's usable, so you can see what can be made before making it.</span>
    <div><${Button} kind="ghost" icon="search" disabled=${busy} onClick=${read}>${d.hasFootage ? 'Read their footage' : 'Find and read their public videos'}</${Button}></div>`}
  </div>`;
  const hooks = all ? d.hooks : d.hooks.slice(0, 5);
  const left = [d.left.procedure && `${d.left.procedure} procedure`, d.left.otherSpeakers && `${d.left.otherSpeakers} by other speakers`, d.left.questions && `${d.left.questions} questions`, d.left.greetings && `${d.left.greetings} greetings`].filter(Boolean);
  return html`<div class="am-sec" style="gap:14px">
    <div class="am-tiles">
      <div class="am-tile"><b>${d.clips}</b><span>video${d.clips === 1 ? '' : 's'} · ${d.minutes} min</span></div>
      <div class="am-tile"><b>${d.statements}</b><span>clear statements</span></div>
      <div class="am-tile"><b>${d.hooks.length}</b><span>strong openings</span></div>
      <div class="am-tile"><b>~${d.room}</b><span>videos it can carry</span></div>
    </div>
    ${d.statements < 4 ? html`<span class="am-help" style="color:var(--coral-ink)">There are too few clear statements here to build a video from. Add footage where they speak to an audience or a camera, not only hearings.</span>` : null}
    ${d.stale ? html`<span class="am-help">The footage changed since this was read. <button class="am-link" disabled=${busy || !!reading} onClick=${read}>Read it again</button></span>` : null}
    ${d.topics.length ? html`<div class="am-sec"><span class="am-label">What they talk about</span>
      <div class="am-chips">${d.topics.map((t) => html`<button type="button" class=${`am-chip${t.enough ? '' : ' dim'}`} title=${t.enough ? `Add a video about ${t.name}` : `Only ${t.n} lines: probably too little for a whole video`} onClick=${() => add(t.name)}>${t.name} <i>${t.n}</i></button>`)}</div></div>` : null}
    ${d.hooks.length ? html`<div class="am-sec"><div class="row" style="align-items:baseline;gap:8px"><span class="am-label grow">Hook finder: their best opening lines</span>${d.hooks.length >= 2 ? html`<button class="am-link" title="The same video, each opening with a different one of these" onClick=${() => add(`${Math.min(3, d.hooks.length)} hooks`)}>Test the top ${Math.min(3, d.hooks.length)}</button>` : null}</div>
      <div class="am-hooks">${hooks.map((h, i) => html`<button type="button" key=${h.id} class="am-hook" title="Make a video that opens with this line" onClick=${() => add(`hook: ${h.text}`)}>
        <span class="am-rank">${i + 1}</span><span class="q">${h.text}<span class="m">${h.seconds} s · ${h.why}${h.topic ? ` · ${h.topic}` : ''}</span></span><span class="go">Open with this</span></button>`)}</div>
      ${d.hooks.length > 5 ? html`<button class="am-link" style="align-self:flex-start" onClick=${() => setAll(!all)}>${all ? 'Show fewer' : `Show all ${d.hooks.length}`}</button>` : null}</div>` : html`<span class="am-help">No line here works as an opening on its own yet (each leans on something said before it, or is a greeting).</span>`}
    ${d.closers.length ? html`<div class="am-sec"><span class="am-label">Lines that close well</span><span class="am-help">${d.closers.slice(0, 3).map((c) => `“${c.text}”`).join('  ')}</span></div>` : null}
    ${left.length ? html`<span class="am-help">Left out on purpose: ${left.join(', ')}.</span>` : null}
  </div>`;
}

/**
 * Find a politician fast: type any part of a name or office, click one. Not on the list? Add them from the same box
 * ("Name, office"), or send the words to the scout to find more people like that.
 */
function CandidatePicker({ list, pid, setPid, reload }) {
  const [q, setQ] = useState(''); const [open, setOpen] = useState(false);
  const cur = list.find((x) => x.id === pid);
  const officeOf = (x) => x.pkg?.profile?.office || x.office || x.location || '';
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const hits = (words.length ? list.filter((x) => { const t = `${x.name} ${officeOf(x)} ${x.stage || ''}`.toLowerCase(); return words.every((w) => t.includes(w)); }) : list.slice().reverse()).slice(0, 8);
  const exact = list.some((x) => x.name.toLowerCase() === q.trim().split(',')[0].trim().toLowerCase());
  const add = () => { const [name, ...rest] = q.split(','); return act(() => api.post('/api/prospects', { name: name.trim(), type: 'political', location: rest.join(',').trim() }), { ok: `${name.trim()} added` }).then((r) => { if (r?.id) { setPid(r.id); setQ(''); setOpen(false); reload(); } }); };
  const scout = () => act(() => api.post('/api/political/scout', { query: q.trim(), count: 10 }), { ok: 'Scouting. New people show up under New prospects further down this page.' }).then(() => { setQ(''); setOpen(false); });
  return html`<div class="col" style="gap:6px;position:relative">
    <input class="input" id="am-search" autocomplete="off" placeholder=${cur ? `${cur.name}${officeOf(cur) ? ` · ${officeOf(cur)}` : ''}  (type to search ${list.length} people)` : 'Search by name or office, or type a new name'} value=${q}
      onFocus=${() => setOpen(true)} onInput=${(e) => { setQ(e.target.value); setOpen(true); }} onKeyDown=${(e) => { if (e.key === 'Enter' && hits[0]) { setPid(hits[0].id); setQ(''); setOpen(false); } if (e.key === 'Escape') setOpen(false); }} />
    ${open ? html`<div class="col" style="gap:2px;padding:6px;border-radius:12px;border:1px solid var(--line);background:var(--surface);max-height:300px;overflow:auto">
      ${hits.map((x) => html`<button key=${x.id} type="button" onClick=${() => { setPid(x.id); setQ(''); setOpen(false); }} style=${`display:flex;gap:8px;align-items:baseline;text-align:left;padding:7px 9px;border:0;border-radius:8px;cursor:pointer;background:${x.id === pid ? 'var(--surface-2, #f1f1f1)' : 'transparent'}`}>
        <b style="font-size:var(--fs-sm)">${x.name}</b><span class="faint grow ellipsis" style="font-size:var(--fs-xs)">${officeOf(x)}</span>
        <span class="faint" style="font-size:10px">${(x.videos || []).length ? `${(x.videos || []).length} videos` : (x.footageUploads || []).length ? `${(x.footageUploads || []).length} uploads` : ''}</span></button>`)}
      ${!hits.length ? html`<span class="faint" style="font-size:var(--fs-xs);padding:6px 9px">Nobody on the list matches.</span>` : null}
      ${q.trim().length >= 3 ? html`<div class="row wrap" style="gap:6px;padding:6px 4px 2px;border-top:1px solid var(--line);margin-top:4px">
        ${!exact ? html`<${Button} size="sm" kind="ghost" icon="plus" onClick=${add}>Add “${q.trim().slice(0, 40)}”</${Button}>` : null}
        <${Button} size="sm" kind="ghost" icon="search" onClick=${scout} title="Sends these words to the scout, e.g. Queens assembly members, or Connecticut state senators">Scout for more: “${q.trim().slice(0, 30)}”</${Button}>
        <${Button} size="sm" kind="ghost" onClick=${() => setOpen(false)}>Close</${Button}></div>` : html`<span class="faint" style="font-size:10px;padding:4px 9px">To add someone new, type their name, a comma, then the office: Jane Rivera, State Senate SD-12, NY</span>`}
    </div>` : null}
  </div>`;
}

/** A short list of what to type, shown as the order box's placeholder. */
const ORDER_HINT = 'One video per line. For example:\nhousing\nquick video about childcare, captions only\nhook: Most people in Albany are politicians\n3 hooks about rent\nscript: First line. Second line. Closing line.\nwhat she delivered on transit, to camera, no music';

// What each kind of edit draws (for the small phone pictures and the switches' starting positions).
const EDIT_PARTS = { graphics: 'htnc', light: 'hnc', clean: 'tnc', captions: 'c', raw: '' };
const EDIT_ON = { graphics: { captions: true, name: true, progress: true, endCard: true, music: true }, light: { captions: true, name: true, progress: true, endCard: true, music: true }, clean: { captions: true, name: true, progress: true, endCard: true, music: true }, captions: { captions: true, name: false, progress: false, endCard: true, music: true }, raw: { captions: false, name: false, progress: false, endCard: false, music: false } };
const SWITCHES = [['captions', 'Captions'], ['name', 'Name tag'], ['endCard', 'End card'], ['music', 'Music'], ['progress', 'Progress bar']];
const GROUPS = [['Everyday', ['topic', 'quick', 'update', 'district', 'help', 'vote', 'clip', 'best']], ['Who they are', ['intro', 'values', 'people', 'story', 'local']], ['The record', ['delivered', 'numbers', 'problem', 'explainer', 'promise']], ['Pushing back', ['fight', 'myth', 'callout']]];
const saved = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k) || 'null'); return v == null ? d : v; } catch { return d; } };

/**
 * The everyday job: type what you want (one line per video) or tap baselines, see how each line will be read, choose
 * the kind of edit and the look, press Make. Empty box = "plan N for me" from what their footage is about.
 */
function BatchMaker({ p, list, busy, job, up, looks, curLook, reload }) {
  const { data: opts } = useApi('/api/political/templates');
  const o0 = saved('eu.amOpts', {});
  const [text, setText] = useState(''); const [count, setCount] = useState(o0.count || 8);
  const [style, setStyle] = useState(o0.style || 'mix'); const [pickStyle, setPickStyle] = useState(false);
  const [kind, setKind] = useState(o0.kind || 'graphics'); const [sw, setSw] = useState(o0.sw || {}); const [sounds, setSounds] = useState(o0.sounds || '');
  const [punch, setPunch] = useState(o0.punch || ''); const [hard, setHard] = useState(!!o0.hard);
  const [wide, setWide] = useState(!!o0.wide); const [note, setNote] = useState(''); const [fold, setFold] = useState(o0.fold || '');
  // Text: the font, how big, and an outline or a soft shadow round captions. Purpose: everyday social content or a race ad.
  const [font, setFont] = useState(o0.font || ''); const [tsize, setTsize] = useState(o0.tsize || 1); const [outline, setOutline] = useState(o0.outline || ''); const [purpose, setPurpose] = useState(o0.purpose || '');
  const [preview, setPreview] = useState([]); const [others, setOthers] = useState(false); const [names, setNames] = useState(''); const [group, setGroup] = useState(0);
  const box = useRef(null);
  useEffect(() => { try { localStorage.setItem('eu.amOpts', JSON.stringify({ count, style, kind, sw, sounds, punch, hard, wide, fold, font, tsize, outline, purpose })); } catch { /* private window */ } }, [count, style, kind, sw, sounds, punch, hard, wide, fold, font, tsize, outline, purpose]);
  // How each line will be read, a moment after typing stops.
  useEffect(() => {
    if (!text.trim()) { setPreview([]); return undefined; }
    const t = setTimeout(() => { api.post('/api/political/orders/preview', { text }).then((r) => setPreview(r.orders || [])).catch(() => {}); }, 280);
    return () => clearTimeout(t);
  }, [text]);
  const addLine = (line, focus) => { setText((cur) => `${cur.trim() ? `${cur.replace(/\s+$/, '')}\n` : ''}${line}`); if (focus) setTimeout(() => { const el = box.current; if (el) { el.focus(); el.selectionStart = el.selectionEnd = el.value.length; } }, 30); };
  // Topics and hooks clicked in "What's in it", and a style picked on the Styles tab, land here.
  useEffect(() => { const on = (e) => addLine(String(e.detail || '')); const st = (e) => { setStyle(String(e.detail)); setPickStyle(false); }; window.addEventListener('eu:amAdd', on); window.addEventListener('eu:amStyle', st); return () => { window.removeEventListener('eu:amAdd', on); window.removeEventListener('eu:amStyle', st); }; }, []);
  const n = preview.length || count;
  const bare = kind === 'raw'; const isOn = (k) => (sw[k] != null ? sw[k] : EDIT_ON[kind][k]);
  const edit = () => ({ kind, ...sw, ...(sounds ? { sounds } : {}), ...(punch ? { punchIns: punch === 'on' } : {}), ...(hard ? { hardCuts: true } : {}) });
  const body = () => ({ text, count: text.trim() ? 0 : count, styles: style === 'mix' ? 'mix' : style === 'own' ? null : [style], edit: edit(), wide, prompt: note.trim(), purpose: purpose || null, textStyle: font || tsize !== 1 || outline ? { font, size: tsize, ...(outline ? { outline: outline === 'on' } : {}) } : null });
  const go = () => act(() => api.post(`/api/prospects/${p.id}/videos`, body()), { ok: `Making ${n} video${n === 1 ? '' : 's'} for ${p.name}. They appear in the Videos tab as each one finishes.` }).then(() => reload());
  const goMany = () => { const who = names.split(/\r?\n/).map((x) => x.trim()).filter(Boolean); if (!who.length) return; act(() => api.post('/api/political/videos', { names: who, ...body() }), { ok: (r) => `Started for ${r.started.length}${r.skipped.length ? `; left out: ${r.skipped.join(', ')}` : ''}. One politician is made at a time.` }).then(() => { setOthers(false); setNames(''); reload(); }); };
  const styleName = style === 'mix' ? 'A mix of styles' : style === 'own' ? `Their own (${curLook})` : (looks?.presets || []).find((x) => x.id === style)?.name || style;
  const secs = (o) => o.seconds || (opts?.templates || []).find((t) => t.id === o.template)?.seconds || 26;
  const edits = opts?.edits || []; const editName = (id) => edits.find((e) => e.id === id)?.name || '';
  const tpl = (id) => (opts?.templates || []).find((t) => t.id === id);
  const lineNote = (o) => [o.hook ? `opens with “${o.hook.slice(0, 34)}${o.hook.length > 34 ? '…' : ''}”` : o.hookId != null ? `opens with line ${o.hookId}` : o.hookRank != null ? `their no. ${o.hookRank + 1} hook` : '', o.styleName || (bare ? '' : style === 'mix' ? 'style in turn' : styleName), `about ${secs(o)} s`, o.wide || wide ? '+ horizontal' : '', o.edit?.kind ? editName(o.edit.kind).toLowerCase() : '', o.edit?.music === false ? 'no music' : ''].filter(Boolean).join(' · ');
  const foldBtn = (id, label, now) => html`<button type="button" class="am-fold" aria-expanded=${fold === id} onClick=${() => setFold(fold === id ? '' : id)}>${fold === id ? '▾' : '▸'} ${label}<i>${now}</i></button>`;
  const first = p ? p.name.split(' ')[0] : 'they';
  return html`
    <section class="panel am-card">
      <div class="am-step"><span class=${`am-num${text.trim() ? ' done' : ''}`}>4</span><h4>The videos</h4><span class="am-sub">one line each · or leave empty and it plans them</span></div>
      <textarea class="am-orders" id="am-orders" ref=${box} rows="5" placeholder=${ORDER_HINT} value=${text} onInput=${(e) => setText(e.target.value)} />
      <div class="am-sec">
        <div class="row wrap" style="gap:8px;align-items:center"><span class="am-label">Baselines</span><${Seg} value=${String(group)} onChange=${(v) => setGroup(Number(v))} options=${GROUPS.map(([g], i) => ({ value: String(i), label: g }))} /></div>
        <div class="am-chips">
          ${group === 0 ? html`<button type="button" class="am-chip" title="Type a rough script: it finds where they say each line and cuts them together in that order" onClick=${() => addLine('script: ', true)}>+ Follow my script</button><button type="button" class="am-chip" title="Open the video with a line you choose (see the hook finder)" onClick=${() => addLine('hook: ', true)}>+ Open with a line</button><button type="button" class="am-chip" title="The same video three times, each with a different one of their best openings" onClick=${() => addLine('3 hooks about ', true)}>+ Hook test</button>` : null}
          ${GROUPS[group][1].map(tpl).filter(Boolean).map((t) => html`<button type="button" class="am-chip" title=${`${t.formula}\n\n${t.about}`} onClick=${() => addLine(t.starter || (t.needsTopic ? 'about ' : t.name.toLowerCase()), true)}>+ ${t.name}</button>`)}
        </div>
      </div>
      ${preview.length ? html`<div class="am-plan" data-animate>
        <b style="font-size:var(--fs-xs);margin-bottom:2px">I'll make ${preview.length} video${preview.length === 1 ? '' : 's'}:</b>
        ${preview.map((o, i) => html`<div key=${i} class="ln"><span class="n">${i + 1}</span><b>${o.templateName}</b>${o.topic ? html`<span>about ${o.topic}</span>` : o.brief && o.template !== 'script' ? html`<span class="faint">from your prompt</span>` : null}<span class="faint grow">${lineNote(o)}</span></div>`)}
      </div>` : html`<div class="am-count">
        <span style="font-size:var(--fs-xs)" class="grow">Nothing typed: it plans them from what ${first} talk${p ? 's' : ''} about most.</span>
        <button type="button" class="am-round" aria-label="Fewer" onClick=${() => setCount(Math.max(1, count - 1))}>−</button>
        <b style="min-width:72px;text-align:center;font-size:var(--fs-sm)">${count} video${count === 1 ? '' : 's'}</b>
        <button type="button" class="am-round" aria-label="More" onClick=${() => setCount(Math.min(40, count + 1))}>+</button>
      </div>`}
    </section>
    <section class="panel am-card">
      <div class="am-step"><span class="am-num done">5</span><h4>How they're edited</h4><span class="am-sub">${editName(kind)}${bare ? '' : ` · ${styleName}`}</span></div>
      <div class="am-opts">${edits.map((e) => html`<button type="button" key=${e.id} class=${`am-opt${kind === e.id ? ' on' : ''}`} aria-pressed=${kind === e.id} onClick=${() => { setKind(e.id); setSw({}); }}>
        <span class="am-ph">${[...(EDIT_PARTS[e.id] || '')].map((c) => html`<u class=${c} />`)}</span><b>${e.name}</b><span>${e.about}</span></button>`)}</div>
      <div class="am-switches">
        ${SWITCHES.map(([k, label]) => html`<label key=${k} class="am-switch"><${Toggle} on=${isOn(k)} label=${label} onChange=${(v) => setSw({ ...sw, [k]: v })} /><span>${label}</span></label>`)}
        <label class="am-switch"><${Toggle} on=${wide} label="Horizontal too" onChange=${setWide} /><span>Horizontal too</span></label>
      </div>
      ${bare ? html`<span class="am-help">A straight cut ignores the style: it is their footage, full screen, cut on natural pauses with even sound. Open it in the Studio from the Videos tab to finish it by hand.</span>` : html`
      <div class="am-sec"><span class="am-label">Style</span>
        <div class="row wrap" style="gap:8px;align-items:center"><${Seg} value=${['mix', 'own'].includes(style) ? style : 'one'} onChange=${(v) => { if (v === 'one') setPickStyle(true); else { setStyle(v); setPickStyle(false); } }} options=${[{ value: 'mix', label: 'Mix of styles' }, { value: 'own', label: 'Their own' }, { value: 'one', label: ['mix', 'own'].includes(style) ? 'Pick one…' : styleName }]} />
          ${!['mix', 'own'].includes(style) ? html`<button class="am-link" onClick=${() => setPickStyle(!pickStyle)}>${pickStyle ? 'Close' : 'Change'}</button>` : null}</div>
        <span class="am-help">${style === 'mix' ? 'Each video takes the next of Bold blocks, Street vlog, Pastel blocks, On location and To camera, so a month of posts does not look the same.' : style === 'own' ? `Every video in ${first}'s own look (${curLook}).` : `Every video in ${styleName}.`}</span>
        ${pickStyle ? html`<div style="max-height:330px;overflow:auto;padding-right:4px"><${LookPicker} presets=${looks?.presets || []} sel=${['mix', 'own'].includes(style) ? null : style} onSel=${(id) => { if (id) { setStyle(id); setPickStyle(false); } }} /></div>` : null}
      </div>`}
      ${foldBtn('cut', 'Cuts and sound', [punch === 'on' ? 'punch-ins on' : punch === 'off' ? 'no punch-ins' : '', hard ? 'hard cuts' : '', sounds ? `sounds ${sounds}` : ''].filter(Boolean).join(' · ') || 'the style\'s own')}
      ${fold === 'cut' ? html`<div class="am-sec">
        <div class="row wrap" style="gap:8px;align-items:center"><span class="am-help" style="width:110px">Punch-in cuts</span><${Seg} value=${punch} onChange=${setPunch} options=${[{ value: '', label: 'Style\'s own' }, { value: 'on', label: 'On' }, { value: 'off', label: 'Off' }]} /></div>
        <span class="am-help">One take cut like several cameras: a new framing on each sentence, centred on their face. Only on full-screen looks, and only when a face is found.</span>
        <div class="row wrap" style="gap:8px;align-items:center"><span class="am-help" style="width:110px">Sound effects</span><${Seg} value=${sounds} onChange=${setSounds} options=${[{ value: '', label: 'Usual' }, { value: 'full', label: 'Full' }, { value: 'light', label: 'Light' }, { value: 'off', label: 'Off' }]} /></div>
        <label class="am-switch"><${Toggle} on=${hard} label="Hard cuts only" onChange=${setHard} /><span>Hard cuts only (no wipes, slides or flashes)</span></label>
      </div>` : null}
      ${foldBtn('text', 'Text', [font, tsize !== 1 ? (tsize < 1 ? 'smaller' : 'bigger') : '', outline === 'on' ? 'outline' : outline === 'off' ? 'soft shadow' : ''].filter(Boolean).join(' · ') || 'the style\'s own')}
      ${fold === 'text' ? html`<div class="am-sec">
        <div class="row wrap" style="gap:8px;align-items:center">
          <select class="input" style="max-width:200px" value=${font} onChange=${(e) => setFont(e.target.value)}><option value="">The style's own font</option>${(opts?.fonts || []).map((f) => html`<option value=${f}>${f}</option>`)}</select>
          <${Seg} value=${String(tsize)} onChange=${(v) => setTsize(Number(v))} options=${[{ value: '0.85', label: 'Smaller' }, { value: '1', label: 'Normal' }, { value: '1.2', label: 'Bigger' }, { value: '1.4', label: 'Biggest' }]} />
          <${Seg} value=${outline} onChange=${setOutline} options=${[{ value: '', label: 'Style\'s own edge' }, { value: 'on', label: 'Outline' }, { value: 'off', label: 'Soft shadow' }]} />
        </div>
        ${font ? html`<span style=${`font-family:'${font}', sans-serif;font-size:26px;line-height:1.2`}>${p ? p.name : 'Sample'} · The quick brown fox</span>` : null}</div>` : null}
      ${foldBtn('for', 'What it\'s for', (purpose || opts?.purpose || 'social') === 'social' ? 'social content' : 'campaign ad')}
      ${fold === 'for' ? html`<div class="am-sec"><${Seg} value=${purpose || opts?.purpose || 'social'} onChange=${setPurpose} options=${[{ value: 'social', label: 'Social content' }, { value: 'campaign', label: 'Campaign ad' }]} /><span class="am-help">${(purpose || opts?.purpose || 'social') === 'social' ? 'For people in office, any week of the year: ends on Follow, with no race or vote language.' : 'For a race: ends on Vote, with "for the 35th" under the name.'}</span>
        <input class="input" id="am-note" placeholder="A note for every video, e.g. keep it upbeat, end on the district" value=${note} onInput=${(e) => setNote(e.target.value)} /></div>` : null}
    </section>
    <div class="am-bar">
      ${job ? html`<div class="col grow" style="gap:4px;min-width:200px"><${Progress} value=${job.progress || 0} /><span class="am-help">${Math.round((job.progress || 0) * 100)}% · ${job.note || (job.status === 'queued' ? 'waiting its turn' : 'working')}</span></div>`
      : html`<span class="sum">${p ? html`<b>${n} video${n === 1 ? '' : 's'} for ${p.name}</b><br />${editName(kind)}${bare ? '' : ` · ${styleName}`}${wide ? ' · vertical and horizontal' : ' · vertical'}` : html`<b>Pick who it's for</b>`}</span>`}
      <button type="button" class="am-link" disabled=${!list.length} onClick=${() => setOthers(true)}>Several politicians…</button>
      <${Button} kind="primary" icon="sparkle" disabled=${!p || busy || !!up} title=${!p ? 'Pick or add the candidate first' : busy ? 'Already working on this candidate' : up ? 'Wait for the upload to finish' : ''} onClick=${go}>${busy ? 'Making…' : up ? 'Uploading…' : `Make ${n} video${n === 1 ? '' : 's'}`}</${Button}>
    </div>
    ${others ? html`<${Modal} title="Same order for several politicians" onClose=${() => setOthers(false)} footer=${html`<${Button} kind="ghost" onClick=${() => setOthers(false)}>Cancel</${Button}><${Button} kind="primary" disabled=${!names.trim()} onClick=${goMany}>Start</${Button}>`}>
      <div class="col" style="gap:10px"><span style="font-size:var(--fs-sm)">One name per line. Add the office after a comma for anyone new. Each uses the footage uploaded for them, or their public videos when there is none.</span>
        <textarea class="am-orders" rows="7" id="am-names" placeholder=${'Anna Kelles, Assembly AD-125, NY\nLarinda Hooks, Assembly AD-35, NY'} value=${names} onInput=${(e) => setNames(e.target.value)} />
        <div class="am-chips">${list.slice(0, 30).map((x) => html`<button type="button" class="am-chip" onClick=${() => setNames((cur) => (cur.split(/\r?\n/).some((l) => l.trim().toLowerCase().startsWith(x.name.toLowerCase())) ? cur : `${cur.trim() ? `${cur.trim()}\n` : ''}${x.name}`))}>+ ${x.name}</button>`)}</div>
        <span class="am-help">${preview.length ? `${preview.length} video${preview.length === 1 ? '' : 's'} each, as typed.` : `${count} videos each, planned from their own footage.`} One politician is made at a time, in order.</span></div>
    </${Modal}>` : null}`;
}

/** Every batch video for a candidate: posters to click, the check, what was skipped and why. */
function VideosTab({ list, pid, setPid, jobs, reload, onMake }) {
  const withVideos = list.filter((x) => (x.videos || []).length);
  const p = list.find((x) => x.id === pid) || withVideos[withVideos.length - 1] || list[0];
  const { data, reload: again } = useApi(p ? `/api/prospects/${p.id}/videos` : null, ['prospects', 'jobs']);
  const [open, setOpen] = useState(null);
  const job = p && (jobs || []).find((j) => j.type === 'political.batch' && j.payload?.prospectId === p.id);
  const desktop = !!(window.euclidean || store.get().boot?.electron);
  const vids = data?.videos || []; const last = data?.last; const v = open && vids.find((x) => x.id === open);
  const url = (x, what, extra = '') => api.url(`/api/prospects/${p.id}/videos/${x.id}/${what}?at=${encodeURIComponent(x.at)}${extra}`);
  const del = async (x) => { if (!(await confirmDialog({ title: 'Delete this video?', body: `"${x.title}" is removed from the list and from the folder.`, confirm: 'Delete' }))) return; await act(() => api.del(`/api/prospects/${p.id}/videos/${x.id}`), { ok: 'Deleted' }); setOpen(null); again(); reload(); };
  if (!list.length) return html`<div class="faint pad">Add a politician on the Make tab first.</div>`;
  return html`<div class="col" style="gap:12px">
    <div class="row wrap" style="gap:10px;align-items:center">
      <select class="input" style="max-width:340px" value=${p?.id || ''} onChange=${(e) => setPid(e.target.value)}>${list.map((x) => html`<option value=${x.id}>${x.name}${(x.videos || []).length ? ` · ${(x.videos || []).length} videos` : ''}</option>`)}</select>
      <span class="grow faint" style="font-size:var(--fs-xs)">${vids.length ? `${vids.length} video${vids.length === 1 ? '' : 's'} · ${Math.round(vids.reduce((a, x) => a + (x.duration || 0), 0))} s in all` : ''}</span>
      ${desktop && vids.length ? html`<${Button} size="sm" kind="ghost" icon="folder" onClick=${() => api.get(`/api/prospects/${p.id}/videos/${vids[0].id}/file?reveal=1`).catch((e) => toast(e.message, { kind: 'error' }))}>Open the folder</${Button}>` : null}
      <${Button} size="sm" kind="primary" icon="sparkle" onClick=${onMake}>Make more</${Button}>
    </div>
    ${job ? html`<div class="col" style="gap:4px"><${Progress} value=${job.progress || 0} /><span class="faint" style="font-size:var(--fs-xs)">${Math.round((job.progress || 0) * 100)}% · ${job.note || (job.status === 'queued' ? 'waiting its turn' : 'working')}</span></div>` : null}
    ${last && last.skipped?.length ? html`<div class="notice" style="font-size:var(--fs-xs);padding:10px 12px;border-radius:12px;background:var(--gold-soft, var(--surface-2));color:var(--gold-ink, inherit)"><b>Last batch: ${last.made} of ${last.asked} made${last.seconds ? ` in ${Math.round(last.seconds / 60) || 1} min` : ''}.</b> Not made: ${last.skipped.map((x) => `"${x.ask}" (${x.why})`).join(' · ')}</div>` : last && !job ? html`<span class="faint" style="font-size:var(--fs-xs)">Last batch: ${last.made} made${last.seconds ? ` in ${Math.round(last.seconds / 60) || 1} min` : ''}.</span>` : null}
    ${!vids.length && !job ? html`<div class="faint pad" style="text-align:center">No videos for ${p.name} yet. Press Make more, type what you want, and they'll show up here.</div>` : null}
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px" data-animate>
      ${vids.map((x) => html`<button key=${x.id} type="button" onClick=${() => setOpen(x.id)} title=${x.lines.join(' / ')} style="display:flex;flex-direction:column;gap:5px;padding:6px;border-radius:14px;border:1px solid var(--line);background:var(--surface);cursor:pointer;text-align:left">
        <div style="position:relative;width:100%;aspect-ratio:9/16;border-radius:10px;overflow:hidden;background:#111"><img src=${url(x, 'poster')} loading="lazy" alt="" style="width:100%;height:100%;object-fit:cover" onError=${(e) => { e.target.style.display = 'none'; }} />
          <span style="position:absolute;right:6px;bottom:6px;background:rgba(0,0,0,.65);color:#fff;font-size:10px;padding:2px 6px;border-radius:6px">${Math.round(x.duration)} s</span>
          ${x.review ? html`<span style="position:absolute;left:6px;top:6px;background:var(--coral, #d9534f);color:#fff;font-size:10px;padding:2px 6px;border-radius:6px">Check first</span>` : null}</div>
        <b class="ellipsis" style="font-size:var(--fs-xs)">${x.title}</b>
        <span class="faint ellipsis" style="font-size:10px">${x.styleName}${x.hasWide ? ' · + wide' : ''}</span>
        <span style=${`font-size:10px;color:${x.qa?.ok ? 'var(--moss-ink, #2f7d4f)' : 'var(--coral-ink, #b4532a)'}`}>${x.qa ? (x.qa.ok ? 'Checked: sound and cuts fine' : `Check: ${x.qa.notes[0]}`) : ''}</span>
      </button>`)}
    </div>
    ${v ? html`<${Modal} wide title=${`${p.name}: ${v.title}`} onClose=${() => setOpen(null)} footer=${html`<${Button} kind="ghost" onClick=${() => del(v)}>Delete</${Button}>${v.canEdit ? html`<${Button} kind="slate" icon="studio" title="Opens their footage cut by cut, the captions and the music as separate layers you can change" onClick=${() => act(() => api.post(`/api/prospects/${p.id}/videos/${v.id}/studio`), { sound: 'open' }).then((r) => { if (r?.id) { setOpen(null); navigate(`/studio/${r.id}`); } })}>Edit in Studio</${Button}>` : null}<a class="btn" href=${url(v, 'file', '&download=1')}>Download</a>${v.hasWide ? html`<a class="btn" href=${url(v, 'wide', '&download=1')}>Download horizontal</a>` : null}<${Button} kind="primary" onClick=${() => setOpen(null)}>Done</${Button}>`}>
      <div class="row wrap" style="gap:16px;align-items:flex-start">
        <video key=${v.id} src=${url(v, 'file')} poster=${url(v, 'poster')} controls autoplay playsinline style="width:270px;max-width:100%;aspect-ratio:9/16;border-radius:14px;background:#000" />
        <div class="col grow" style="gap:10px;min-width:240px;font-size:var(--fs-sm)">
          <div class="row wrap" style="gap:6px">${[v.styleName, ({ raw: 'Straight cut', captions: 'Captions only', clean: 'Clean edit', light: 'Fewer graphics' })[v.edit] || (v.density === 'minimal' ? 'Clean edit' : v.density === 'light' ? 'Fewer graphics' : 'All graphics'), `${v.duration} s`].map((t) => html`<span class="badge">${t}</span>`)}</div>
          <div class="col" style="gap:4px"><b style="font-size:var(--fs-xs)">You asked for</b><span>${v.ask}</span></div>
          <div class="col" style="gap:4px"><b style="font-size:var(--fs-xs)">Their words, in order</b>${v.lines.map((l, i) => html`<span key=${i} class=${i === 0 || i === v.lines.length - 1 ? '' : 'faint'}>${i === 0 ? 'Hook: ' : i === v.lines.length - 1 ? 'Closing: ' : ''}${l}</span>`)}</div>
          ${v.graphics?.length ? html`<div class="col" style="gap:4px"><b style="font-size:var(--fs-xs)">Graphics in it</b><span class="faint">${v.graphics.map((g) => ({ stat: 'number badge', credential: 'credential card', quote: 'quote attribution', callout: 'callout', bill: 'bill card', map: 'district map', checklist: 'checklist', compare: 'before / after bars', timeline: 'timeline', clip: 'press clipping' }[g] || g)).join(', ')}</span></div>` : null}
          <span style=${`font-size:var(--fs-xs);color:${v.qa?.ok ? 'var(--moss-ink, #2f7d4f)' : 'var(--coral-ink, #b4532a)'}`}>${v.qa ? (v.qa.ok ? `Checked after rendering: ${v.qa.loudness != null ? `${v.qa.loudness.toFixed(1)} LUFS, ` : ''}clean cuts, no black frames or dead air.` : v.qa.notes.join(' ')) : ''}</span>
          ${v.review ? html`<span style="font-size:var(--fs-xs);color:var(--coral-ink, #b4532a)">This is a contrast video. Watch it yourself before it goes anywhere.</span>` : null}
          ${v.hasWide ? html`<video src=${url(v, 'wide')} controls playsinline preload="metadata" style="width:100%;max-width:420px;aspect-ratio:16/9;border-radius:12px;background:#000" />` : null}
        </div>
      </div>
    </${Modal}>` : null}
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
function LookPicker({ presets: all, sel, onSel }) {
  // The ten main styles first; the rest open under "More styles".
  const [more, setMore] = useState(false);
  const extra = (all || []).filter((x) => x.main === false); const openMore = more || extra.some((x) => x.id === sel);
  const presets = openMore ? all : (all || []).filter((x) => x.main !== false);
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
    </button>`)}${extra.length && !openMore ? html`<button type="button" class="look-card" onClick=${() => setMore(true)} style="display:flex;align-items:center;justify-content:center;min-height:120px;padding:6px;border-radius:12px;cursor:pointer;background:var(--surface-2, var(--surface));border:2px dashed var(--line);font-size:var(--fs-xs)"><b>More styles (${extra.length})</b></button>` : null}</div>`;
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
      <${GoogleVideos} p=${p} reload=${reload} />
      ${(ft?.clips || []).filter((c) => c.url).length ? html`<ul style="padding-left:18px;font-size:var(--fs-sm)">${ft.clips.filter((c) => c.url).map((c) => html`<li><a href=${c.url} target="_blank" rel="noreferrer">${c.title || c.url}</a> <span class="faint">${c.platform}${c.uploader ? ` · ${c.uploader}` : ''}</span></li>`)}</ul>` : null}
      ${(ft?.bites?.short || []).length ? html`<div class="col" style="gap:4px;font-size:var(--fs-sm)"><b>Lines in the short ads</b>${ft.bites.short.map((b) => html`<div>${b.label ? html`<span class="badge lav">${b.label}</span> ` : null}"${b.text}"</div>`)}</div>` : null}
      ${ft?.errors?.length ? html`<div class="faint" style="font-size:var(--fs-xs)">${ft.errors.slice(-3).join(' · ')}</div>` : null}
      <textarea class="input" rows="2" placeholder="Or paste links to their videos, one per line (Facebook, YouTube, X, Instagram). Public videos only." value=${links} onInput=${(e) => setLinks(e.target.value)} />
      <div class="row" style="gap:6px"><${Button} size="sm" kind="ghost" onClick=${save}>Save links</${Button}><${Button} size="sm" kind="primary" disabled=${busy || !!up} onClick=${() => save().then(() => run({ from: 'footage' }, 'Reading their footage and remaking the ads'))}>Make the ads from this footage</${Button}></div>
      <div class="faint" style="font-size:var(--fs-xs)">It uses whole sentences exactly as they said them, never stitched words. To change an ad, write a note below ("open on the line about rent", "use the district map earlier") and the AI re-plans it.</div>
    </div></details>`;
}


/**
 * Their public videos from Google's Videos tab (Serper): Find, then switch any off. The ad machine downloads the ones
 * left on when nothing was uploaded (and finds them itself if this was never pressed).
 */
function GoogleVideos({ p, reload }) {
  const [busy, setBusy] = useState(false);
  const found = p.footageFound || [];
  const uploads = (p.footageUploads || []).filter((u) => !u.off).length;
  const find = async () => { setBusy(true); try { const r = await api.post(`/api/prospects/${p.id}/videos/find`, {}); toast(r.error ? r.error : `${r.found.length} video${r.found.length === 1 ? '' : 's'} of ${p.name} found${r.cached ? ' (from memory, no new search)' : ''}`, { kind: r.error ? 'warn' : 'success' }); reload?.(); } catch (e) { toast(e.message, { kind: 'error' }); } setBusy(false); };
  const flip = (v) => api.patch(`/api/prospects/${p.id}/videos`, { url: v.url, off: !v.off }).then(() => reload?.()).catch((e) => toast(e.message, { kind: 'error' }));
  const mins = (d) => (d ? `${Math.floor(d / 60)}:${String(Math.round(d % 60)).padStart(2, '0')}` : '');
  return html`<div class="col" style="gap:6px;margin-top:8px">
    <div class="row wrap" style="gap:8px;align-items:center"><${Icon} name="search" size=${15} /><b style="font-size:var(--fs-sm)">Their videos on Google</b>
      <span class="faint grow" style="font-size:var(--fs-xs)">${found.length ? `${found.filter((v) => !v.off).length} of ${found.length} used${uploads ? ' (uploads come first)' : ''}${p.footageFoundAt ? ` · found ${ago(p.footageFoundAt)}` : ''}` : 'Floor sessions, hearings, meetings and interviews from Google\'s Videos tab. The ad machine downloads the best ones.'}</span>
      <${Button} size="sm" kind="soft" icon="search" busy=${busy} onClick=${find}>${found.length ? 'Find again' : 'Find their videos'}</${Button}></div>
    ${p.footageFoundNote ? html`<div class="faint" style="font-size:var(--fs-xs)">${p.footageFoundNote}</div>` : null}
    ${found.length ? html`<div class="gv-list">${found.map((v) => html`<label class=${'gv-item' + (v.off ? ' off' : '')} title=${v.why?.join(', ') || ''}>
      <input type="checkbox" checked=${!v.off} onChange=${() => flip(v)} />
      ${v.image ? html`<img src=${api.url(`/api/web/image?url=${encodeURIComponent(v.image)}`)} alt="" loading="lazy" onError=${(e) => { e.target.style.visibility = 'hidden'; }} />` : html`<div class="gv-noimg"><${Icon} name="film" size=${16} /></div>`}
      <div class="grow" style="min-width:0"><div class="ellipsis" style="font-size:var(--fs-sm)"><a href=${v.url} target="_blank" rel="noopener">${v.title}</a></div>
        <div class="faint ellipsis" style="font-size:var(--fs-xs)">${[v.channel || v.source, mins(v.duration), v.date, ...(v.why || [])].filter(Boolean).join(' · ')}</div></div></label>`)}</div>` : null}
  </div>`;
}
