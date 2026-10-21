// Production: footage intake and the clip board, per client.
import { html, useRoute, useState, useEffect, useRef, useStore, useApi, navigate, Button, Empty, Loading, StatusBadge, Progress, act, toast, promptDialog, Avatar, Drawer } from '../lib/ui.js';
import { api } from '../lib/api.js';
import { Icon } from '../lib/icons.js';
import { play } from '../lib/sound.js';
import { ago, dur } from '../lib/format.js';
import { ClipDrawer } from './clip.js';
import { QuotaBar } from './cards.js';
import { ReverseReel } from './reverse.js';

/** Quick "new client" so Production works on a fresh install; the full profile lives in Clients. */
async function quickClient() {
  const name = await promptDialog({ title: 'New client', label: 'Client or creator name (you can fill in the rest of their profile in Clients later)', placeholder: 'Stringer Media', confirm: 'Create client' });
  if (!name || !name.trim()) return null;
  return act(() => api.post('/api/clients', { name: name.trim(), type: 'creator' }), { ok: `${name.trim()} created` });
}

const LANES = [
  { key: 'production', label: 'In production', statuses: ['queued', 'rendering', 'revising'], color: 'var(--slate)' },
  { key: 'review', label: 'Founder review', statuses: ['review'], color: 'var(--gold)' },
  { key: 'client', label: 'Client review', statuses: ['client_review'], color: 'var(--lav)' },
  { key: 'scheduled', label: 'Approved & scheduled', statuses: ['approved', 'scheduled'], color: 'var(--moss)' },
  { key: 'published', label: 'Published', statuses: ['published'], color: 'var(--teal)' },
];

export function Production() {
  const route = useRoute();
  const { data: clients } = useApi('/api/clients', ['clients']);
  const [clientId, setClientId] = useState(() => { try { return localStorage.getItem('eu.prodClient') || ''; } catch { return ''; } });
  useEffect(() => { try { localStorage.setItem('eu.prodClient', clientId); } catch { /* ignore */ } }, [clientId]);
  const q = clientId ? `?clientId=${clientId}` : '';
  const { data: clips, loading } = useApi(`/api/clips${q}`, ['clips', 'job', 'approval', 'posts']);
  const { data: assets } = useApi(`/api/assets${q}`, ['assets', 'job']);
  const { data: jobs } = useApi(`/api/jobs?status=running,queued${clientId ? `&clientId=${clientId}` : ''}`, ['job']);
  const openClip = route.query.clip;
  const client = clients?.find((c) => c.id === clientId);

  return html`<div class="page">
    <div class="page-head"><div class="grow"><h1>Production</h1><div class="sub">Footage in, finished shorts out. Everything here runs automatically; step in only where you're needed.</div></div>
      <select class="select" id="prod-client" style="width:220px" value=${clientId} onChange=${async (e) => { const v = e.target.value; if (v === '__new') { e.target.value = clientId; const c = await quickClient().catch(() => null); if (c) setClientId(c.id); return; } setClientId(v); }} aria-label="Client">
        <option value="">${(clients || []).length ? 'All clients' : 'No clients yet'}</option>${(clients || []).map((c) => html`<option value=${c.id}>${c.name}</option>`)}<option value="__new">+ New client…</option></select>
    </div>
    ${client?.quota ? html`<${QuotaStrip} client=${client} />` : null}
    <${Intake} clients=${clients || []} clientId=${clientId} setClientId=${setClientId} assets=${assets || []} jobs=${jobs || []} />
    <${ReverseReel} clients=${clients || []} clientId=${clientId} />
    <div class="row" style="margin:22px 0 10px"><h3 class="grow">Clips</h3><span class="faint" style="font-size:var(--fs-sm)">${(clips || []).length} total</span></div>
    ${loading ? html`<${Loading} />` : !(clips || []).length ? html`<div class="panel"><${Empty} icon="film" title="No clips yet">Drop footage above. Euclidean transcribes it, finds the strongest moments and renders vertical shorts with captions.</${Empty}></div>` : html`
      <div class="board">${LANES.map((l) => {
        const items = (clips || []).filter((c) => l.statuses.includes(c.status)).slice(0, l.key === 'published' ? 30 : 200);
        return html`<section class="lane" aria-label=${l.label}><div class="lane-head"><span class="led" style=${{ background: l.color, boxShadow: 'none' }} /><b class="grow">${l.label}</b><span class="count">${items.length}</span></div>
          <div class="lane-body">${items.map((c) => html`<${ClipCard} key=${c.id} c=${c} showClient=${!clientId} />`)}${!items.length ? html`<div class="faint" style="font-size:var(--fs-sm);padding:8px 6px">Nothing here</div>` : null}</div></section>`;
      })}</div>`}
    ${openClip ? html`<${ClipDrawer} id=${openClip} onClose=${() => navigate('/production')} />` : null}
  </div>`;
}

function QuotaStrip({ client }) {
  const q = client.quota;
  return html`<div class="panel pad row wrap" style="gap:22px;margin-bottom:14px">
    <div class="row"><${Avatar} name=${client.name} /><div><b>${client.name}</b><div class="faint" style="font-size:var(--fs-sm)">${client.schedule.shortsPerDay} shorts/day · ${client.schedule.platforms.length} platforms · ${client.schedule.autopilot ? 'Autopilot on' : 'Autopilot off'}</div></div></div>
    <div class="col" style="gap:6px"><span class="eyebrow">Next ${client.schedule.bufferDays || 2} days</span><${QuotaBar} q=${q} /></div>
    ${[['Posted today', q.postedToday], ['Scheduled', q.scheduled], ['In review', q.inReview], ['In production', q.inProduction], ['Open slots', q.open], ['Unused footage', q.unusedFootage]].map(([l, v]) => html`<div><div class="eyebrow">${l}</div><div class="tnum" style="font:600 18px var(--font-display)">${v}</div></div>`)}
    <div class="spacer" /><${Button} kind="soft" icon="bolt" onClick=${() => act(() => api.post(`/api/clients/${client.id}/autopilot-now`), { ok: (r) => (r.action ? `Autopilot: ${r.action}` : 'Quota is covered') })}>Run autopilot now</${Button}>
  </div>`;
}

function Intake({ clients, clientId, setClientId, assets, jobs }) {
  const [over, setOver] = useState(false);
  const [shotsOf, setShotsOf] = useState(null);
  const [uploads, setUploads] = useState([]);
  const input = useRef(null);
  const target = clientId || (clients.length === 1 ? clients[0].id : '');
  /** Make sure there's a client to file footage under: pick one, or create the first one on the spot. */
  const ensureTarget = async () => {
    if (target) return target;
    if (clients.length > 1) { toast('Choose which client this footage is for in the menu at the top right.', { kind: 'warn' }); document.getElementById('prod-client')?.focus(); return null; }
    const c = await quickClient().catch(() => null);
    if (c) { setClientId(c.id); return c.id; }
    return null;
  };
  const upload = async (files) => {
    if (!files.length) return;
    const to = await ensureTarget(); if (!to) return;
    for (const f of files) {
      const id = Math.random(); setUploads((u) => [...u, { id, name: f.name, p: 0 }]);
      try { await api.upload(`/api/clients/${to}/upload`, [f], { autoProcess: 'true' }, (p) => setUploads((u) => u.map((x) => (x.id === id ? { ...x, p } : x)))); play('success'); }
      catch (e) { play('error'); toast(e.message, { kind: 'error', title: `${f.name} failed` }); }
      finally { setUploads((u) => u.filter((x) => x.id !== id)); }
    }
  };
  const addLink = async () => {
    const to = await ensureTarget(); if (!to) return;
    const url = await promptDialog({ title: 'Import from a link', label: 'YouTube, Twitch, Google Drive or a direct video URL (needs yt-dlp for platform links)', placeholder: 'https://…', confirm: 'Import' });
    if (url) act(() => api.post('/api/assets', { url, clientId: to, autoProcess: true }), { ok: 'Download queued' });
  };
  const addPath = async () => {
    const to = await ensureTarget(); if (!to) return;
    if (window.euclidean?.pickFiles) { const r = await api.post('/api/system/pick', { filters: [{ name: 'Video', extensions: ['mp4', 'mov', 'mkv', 'm4v', 'webm', 'avi', 'mxf', 'mts'] }] }); for (const p of r.paths || []) await act(() => api.post('/api/assets', { clientId: to, path: p, autoProcess: true }), { ok: 'Importing in place (no copy)' }); return; }
    const p = await promptDialog({ title: 'Import a file on this computer', label: 'Full path. The file is used in place, not copied.', placeholder: 'D:\\Footage\\stream-2026-10-11.mp4', confirm: 'Import' });
    if (p) act(() => api.post('/api/assets', { clientId: to, path: p, autoProcess: true }), { ok: 'Importing' });
  };
  const active = assets.filter((a) => ['importing', 'transcribing'].includes(a.status) || jobs.some((j) => j.payload?.assetId === a.id));
  const recent = assets.slice(0, 6);
  return html`<div class="grid c2">
    <div class=${'dropzone' + (over ? ' over' : '')} onDragOver=${(e) => { e.preventDefault(); setOver(true); }} onDragLeave=${() => setOver(false)} onDrop=${(e) => { e.preventDefault(); setOver(false); upload([...e.dataTransfer.files]); }}>
      <div class="avatar lg" style="background:var(--teal-soft);color:var(--teal-ink)"><${Icon} name="upload" size=${20} /></div>
      <div class="grow"><b>Drop footage here</b><div class="muted" style="font-size:var(--fs-sm)">${target ? `For ${clients.find((c) => c.id === target)?.name}. Transcription and clip discovery start automatically.` : clients.length ? 'Choose the client in the menu at the top right, then drop footage.' : 'Footage is filed under a client. Create your first one (just a name) and drop away.'}</div>
        ${!clients.length ? html`<div style="margin-top:8px"><${Button} size="sm" kind="soft" icon="plus" onClick=${async () => { const c = await quickClient().catch(() => null); if (c) setClientId(c.id); }}>Create your first client</${Button}></div>` : null}
        ${uploads.map((u) => html`<div style="margin-top:8px"><div class="row" style="font-size:var(--fs-sm)"><span class="grow ellipsis">${u.name}</span><span class="tnum faint">${Math.round(u.p * 100)}%</span></div><${Progress} value=${u.p} /></div>`)}</div>
      <div class="col" style="gap:6px"><${Button} size="sm" kind="primary" icon="upload" onClick=${() => input.current.click()}>Upload</${Button}><${Button} size="sm" kind="ghost" icon="folder" onClick=${addPath}>From disk</${Button}><${Button} size="sm" kind="ghost" icon="link" onClick=${addLink}>From link</${Button}></div>
      <input ref=${input} type="file" accept="video/*,audio/*" multiple hidden onChange=${(e) => { upload([...e.target.files]); e.target.value = ''; }} />
    </div>
    <div class="panel"><div class="panel-head"><h4 class="grow">Footage</h4><span class="faint" style="font-size:var(--fs-sm)">${active.length ? `${active.length} processing` : `${assets.length} files`}</span></div>
      <div class="list" style="max-height:190px;overflow:auto">${recent.length ? recent.map((a) => {
        const j = jobs.find((x) => x.payload?.assetId === a.id && x.status === 'running');
        return html`<div class="list-row"><div class="th" style=${{ width: '52px', height: '30px', borderRadius: '6px', background: a.thumb ? `var(--surface-3) url(${api.url(`/api/assets/${a.id}/thumb`)}) center/cover` : 'var(--surface-3)', flex: 'none' }} />
          <div class="grow"><div class="ellipsis" style="font-weight:500">${a.name}</div><div class="faint" style="font-size:var(--fs-xs)">${j ? j.note || j.title : a.info ? `${dur(a.info.duration)} · ${a.info.width}×${a.info.height}${a.transcript ? ` · ${a.transcript.words} words` : ''}${a.vision ? ` · ${a.vision.shots} shots` : ''}` : a.status} · ${ago(a.createdAt)}</div>${j ? html`<div style="margin-top:4px"><${Progress} value=${j.progress} indeterminate=${!j.progress} /></div>` : null}</div>
          ${a.status === 'ready' && !j ? html`<${Button} size="sm" kind="ghost" icon="eye" title="What Euclidean sees in this video, shot by shot" onClick=${() => (a.vision ? setShotsOf(a) : act(() => api.post(`/api/assets/${a.id}/look`, {}), { ok: 'Looking through the video' }))}>${a.vision ? 'Shots' : 'Look through'}</${Button}>` : null}
          ${a.status === 'ready' && !j ? html`<${Button} size="sm" kind="ghost" icon="sparkle" onClick=${() => act(() => api.post(`/api/assets/${a.id}/process`, {}), { ok: 'Finding clips' })}>${a.transcript ? 'More clips' : 'Process'}</${Button}>` : html`<${StatusBadge} status=${a.status} />`}</div>`;
      }) : html`<div class="list-row faint">No footage yet</div>`}</div></div>
    ${shotsOf ? html`<${ShotsDrawer} asset=${shotsOf} onClose=${() => setShotsOf(null)} />` : null}
  </div>`;
}

const KIND_TONE = { speaker: 'sky', interview: 'sky', crowd: 'lav', broll: 'moss', graphic: 'gold', text: 'gold', other: '' };
/** What Euclidean saw in a video: one still per shot with its description, kind and quality. */
function ShotsDrawer({ asset, onClose }) {
  const { data } = useApi(`/api/assets/${asset.id}/shots`, []);
  const shots = data?.shots || [];
  return html`<${Drawer} wide title=${`Shots in ${asset.name}`} sub=${data ? `${shots.length} shots · ${data.engine && data.engine !== 'measured' ? 'described by AI' : 'faces, sharpness and brightness only (connect an AI that can see for descriptions)'}` : ''} onClose=${onClose}>
    ${!data ? html`<${Loading} />` : html`<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px">${shots.map((x) => html`<div class="panel" style=${{ overflow: 'hidden', opacity: x.usable ? 1 : 0.5 }}>
      ${x.hasFrame ? html`<img src=${api.url(`/api/assets/${asset.id}/shot/${x.n}`)} style="width:100%;aspect-ratio:16/9;object-fit:cover;display:block" loading="lazy" />` : null}
      <div class="pad col" style="gap:4px;padding:8px 10px"><div class="row" style="gap:6px"><span class=${'badge ' + (KIND_TONE[x.kind] || '')}>${x.kind}</span><span class="faint tnum" style="font-size:var(--fs-xs)">${dur(x.s)}–${dur(x.e)}</span><span class="grow" /><span class="faint" style="font-size:var(--fs-xs)">${'★'.repeat(x.quality || 0)}</span></div>
      ${x.what ? html`<div style="font-size:var(--fs-sm)">${x.what}</div>` : null}${x.text ? html`<div class="faint" style="font-size:var(--fs-xs)">On screen: "${x.text}"</div>` : null}${!x.usable ? html`<div class="faint" style="font-size:var(--fs-xs)">Not usable</div>` : null}</div></div>`)}</div>`}
  </${Drawer}>`;
}

function ClipCard({ c, showClient }) {
  const thumb = c.current ? api.url(`/api/clips/${c.id}/thumb`) : null;
  return html`<div class="clip-card" onClick=${() => { play('open'); navigate(`/production?clip=${c.id}`); }}>
    <div class="th" style=${thumb ? { backgroundImage: `url(${thumb})` } : null}>${!thumb ? (c.status === 'rendering' ? html`<span class="spinner" />` : html`<${Icon} name="film" size=${16} />`) : null}</div>
    <div style="min-width:0"><div class="t">${c.title}</div>
      <div class="m"><span class="tnum">#${c.ref}</span><span>${Math.round(c.end - c.start)}s</span>${showClient ? html`<span class="ellipsis">${c.client}</span>` : null}</div>
      <div class="m">${c.current?.qc && !c.current.qc.passed ? html`<span class="badge coral">QC</span>` : null}${c.status === 'revising' ? html`<span class="badge teal">Revising</span>` : null}${c.current?.n > 1 ? html`<span class="badge outline">v${c.current.n}</span>` : null}${c.method === 'ai' ? html`<span class="badge lav">AI</span>` : null}${c.post?.scheduledAt && c.status === 'scheduled' ? html`<span class="faint">${new Date(c.post.scheduledAt).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}</span>` : null}</div>
    </div></div>`;
}
