// Production: footage intake and the clip board, per client.
import { html, useRoute, useState, useEffect, useRef, useStore, useApi, navigate, Button, Empty, Loading, StatusBadge, Progress, act, toast, promptDialog, confirmDialog, Avatar, Drawer, Toggle } from '../lib/ui.js';
import { api } from '../lib/api.js';
import { Icon } from '../lib/icons.js';
import { play } from '../lib/sound.js';
import { ago, dur } from '../lib/format.js';
import { ClipDrawer } from './clip.js';
import { QuotaBar } from './cards.js';
import { HealthBanner } from './health.js';

/** Quick "new client" so Production works on a fresh install; the full profile lives in Clients. */
async function quickClient() {
  const name = await promptDialog({ title: 'New client', label: 'Client or creator name (you can fill in the rest of their profile in Clients later)', placeholder: 'Stringer Media', confirm: 'Create client' });
  if (!name || !name.trim()) return null;
  return act(() => api.post('/api/clients', { name: name.trim(), type: 'creator' }), { ok: `${name.trim()} created` });
}

const LANES = [
  { key: 'production', label: 'In production', statuses: ['queued', 'rendering', 'revising', 'failed'], color: 'var(--slate)' },
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
  const [shotsOf, setShotsOf] = useState(null);
  const [detail, setDetail] = useState(null);
  const client = clients?.find((c) => c.id === clientId);

  return html`<div class="page">
    <div class="page-head"><div class="grow"><h1>Production</h1><div class="sub">Footage in, finished shorts out. Everything here runs automatically; step in only where you're needed.</div></div>
      <select class="select" id="prod-client" style="width:220px" value=${clientId} onChange=${async (e) => { const v = e.target.value; if (v === '__new') { e.target.value = clientId; const c = await quickClient().catch(() => null); if (c) setClientId(c.id); return; } setClientId(v); }} aria-label="Client">
        <option value="">${(clients || []).length ? 'All clients' : 'No clients yet'}</option>${(clients || []).map((c) => html`<option value=${c.id}>${c.name}</option>`)}<option value="__new">+ New client…</option></select>
    </div>
    <${HealthBanner} clientId=${clientId} />
    ${client?.quota ? html`<${QuotaStrip} client=${client} />` : null}
    <${Intake} clients=${clients || []} clientId=${clientId} setClientId=${setClientId} assets=${assets || []} jobs=${jobs || []} setDetail=${setDetail} setShotsOf=${setShotsOf} />
    ${shotsOf ? html`<${ShotsDrawer} asset=${shotsOf} onClose=${() => setShotsOf(null)} />` : null}
    ${detail ? html`<${FootageDrawer} id=${detail} onClose=${() => setDetail(null)} onShots=${(a) => { setDetail(null); setShotsOf(a); }} />` : null}
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
  const q = client.quota; const sch = client.schedule || {}; // older or imported clients may lack a schedule
  client = { ...client, schedule: { shortsPerDay: sch.shortsPerDay ?? 0, platforms: sch.platforms || [], autopilot: !!sch.autopilot, bufferDays: sch.bufferDays } };
  return html`<div class="panel pad row wrap" style="gap:22px;margin-bottom:14px">
    <div class="row"><${Avatar} name=${client.name} /><div><b>${client.name}</b><div class="faint" style="font-size:var(--fs-sm)">${client.schedule.shortsPerDay} shorts/day · ${client.schedule.platforms.length} platforms · ${client.schedule.autopilot ? 'Autopilot on' : 'Autopilot off'}</div></div></div>
    <div class="col" style="gap:6px"><span class="eyebrow">Next ${client.schedule.bufferDays || 2} days</span><${QuotaBar} q=${q} /></div>
    ${[['Posted today', q.postedToday], ['Scheduled', q.scheduled], ['In review', q.inReview], ['In production', q.inProduction], ['Open slots', q.open], ['Unused footage', q.unusedFootage]].map(([l, v]) => html`<div><div class="eyebrow">${l}</div><div class="tnum" style="font:600 18px var(--font-display)">${v}</div></div>`)}
    <div class="spacer" /><${Button} kind="soft" icon="bolt" onClick=${() => act(() => api.post(`/api/clients/${client.id}/autopilot-now`), { ok: (r) => r.message || 'Autopilot started' })}>Run autopilot now</${Button}>
  </div>`;
}

function Intake({ clients, clientId, setClientId, assets, jobs, setDetail, setShotsOf }) {
  const [over, setOver] = useState(false);

  const [uploads, setUploads] = useState([]);
  const input = useRef(null);
  // A remembered client that's since been deleted or archived is ignored (it used to crash the whole app on start).
  const target = (clientId && clients.some((c) => c.id === clientId) ? clientId : '') || (clients.length === 1 ? clients[0].id : '');
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
        ${target ? html`<${StyleSwitch} client=${clients.find((c) => c.id === target)} /><${ClipLength} client=${clients.find((c) => c.id === target)} /><${MusicSwitch} client=${clients.find((c) => c.id === target)} /><${AiTips} client=${clients.find((c) => c.id === target)} /><${BrollSwitch} client=${clients.find((c) => c.id === target)} />` : null}
        ${uploads.map((u) => html`<div style="margin-top:8px"><div class="row" style="font-size:var(--fs-sm)"><span class="grow ellipsis">${u.name}</span><span class="tnum faint">${Math.round(u.p * 100)}%</span></div><${Progress} value=${u.p} /></div>`)}</div>
      <div class="col" style="gap:6px">${(() => { const tc = clients.find((c) => c.id === target); const waitOn = tc?.production?.waitForStart !== false && !tc?.schedule?.autopilot;
          // Shows as soon as footage is uploaded (not only once it's ready): pressing it early makes clips the moment the video is ready.
          const waiting = assets.filter((a) => (!target || a.clientId === target) && (a.status === 'waiting' || (waitOn && !a.started && jobs.some((j) => j.payload?.assetId === a.id && ['queued', 'running'].includes(j.status)))));
          const ready = waiting.filter((a) => a.status === 'waiting').length;
          return waiting.length ? html`<button type="button" class="btn primary" style="box-shadow:inset 0 3px 8px rgba(0,0,0,0.35);transform:translateY(2px);font-weight:700;height:auto;padding:8px 14px;white-space:normal" title="Set the clip length, count and tips, then press to make the clips." onClick=${(e) => { e.stopPropagation(); act(async () => { for (const a of waiting) await api.post(`/api/assets/${a.id}/process`, {}); }, { ok: ready === waiting.length ? `Making clips from ${waiting.length} video${waiting.length > 1 ? 's' : ''}` : 'Clips will be made as soon as the footage is ready', sound: 'success' }); }}><span class="col" style="gap:0;align-items:center;line-height:1.2"><span>▶ Make clips</span><span style="font-size:var(--fs-xs);font-weight:500;opacity:.85">${waiting.length} video${waiting.length > 1 ? 's' : ''}${ready < waiting.length ? ' · getting ready' : ' ready'}</span></span></button>` : null; })()}${target ? html`<${WideSwitch} client=${clients.find((c) => c.id === target)} />` : null}<${Button} size="sm" kind="primary" icon="upload" onClick=${() => input.current.click()}>Upload</${Button}><${Button} size="sm" kind="ghost" icon="folder" onClick=${addPath}>From disk</${Button}><${Button} size="sm" kind="ghost" icon="link" onClick=${addLink}>From link</${Button}></div>
      <input ref=${input} type="file" accept="video/*,audio/*" multiple hidden onChange=${(e) => { upload([...e.target.files]); e.target.value = ''; }} />
    </div>
    <div class="panel"><div class="panel-head"><h4 class="grow">Footage</h4><span class="faint" style="font-size:var(--fs-sm)">${active.length ? `${active.length} processing` : `${assets.length} files`}</span></div>
      <div class="list" style="max-height:190px;overflow:auto">${recent.length ? recent.map((a) => {
        const j = jobs.find((x) => x.payload?.assetId === a.id && x.status === 'running') || jobs.find((x) => x.payload?.assetId === a.id);
        return html`<div class="list-row" style="cursor:pointer" title="Open: steps, clips, retry, cancel" onClick=${(e) => { if (!e.target.closest('button')) setDetail(a.id); }}><div class="th" style=${{ width: '52px', height: '30px', borderRadius: '6px', background: a.thumb ? `var(--surface-3) url(${api.url(`/api/assets/${a.id}/thumb`)}) center/cover` : 'var(--surface-3)', flex: 'none' }} />
          <div class="grow"><div class="ellipsis" style="font-weight:500">${a.name}</div><div class="faint" style="font-size:var(--fs-xs)">${j ? j.note || STEP_NAME[j.type] || j.title : a.info ? `${dur(a.info.duration)} · ${a.info.width}×${a.info.height}${a.transcript ? ` · ${a.transcript.words} words` : ''}${a.vision ? ` · ${a.vision.shots} shots` : ''}` : a.status} · ${ago(a.createdAt)}</div>${j ? html`<div class="row" style="margin-top:4px;gap:8px"><div class="grow"><${Progress} value=${j.progress} indeterminate=${!j.progress} /></div><b class="tnum" style="font-size:var(--fs-xs);min-width:84px;text-align:right">${STEP_OF[j.type] ? `Step ${STEP_OF[j.type]}/5 · ` : ''}${Math.round((j.progress || 0) * 100)}%</b></div>` : null}${a.error && !j ? html`<div style="color:var(--coral-ink);font-size:var(--fs-xs);margin-top:2px">Stopped: ${a.error}</div>` : null}</div>
          ${a.status === 'ready' && !j ? html`<${Button} size="sm" kind="ghost" icon="eye" title="What Euclidean sees in this video, shot by shot" onClick=${() => (a.vision ? setShotsOf(a) : act(() => api.post(`/api/assets/${a.id}/look`, {}), { ok: 'Looking through the video' }))}>${a.vision ? 'Shots' : 'Look through'}</${Button}>` : null}
          ${!j && (a.status === 'importing' || a.error) && a.status !== 'ready' ? html`<${Button} size="sm" kind="primary" icon="refresh" onClick=${() => act(() => api.post(`/api/assets/${a.id}/process`, {}), { ok: 'Trying again' })}>Retry</${Button}>` : null}
          ${a.status === 'waiting' && !j ? html`<${Button} size="sm" kind="primary" icon="play" title="Pick the clips now, with the clip length, count and AI tips set above" onClick=${() => act(() => api.post(`/api/assets/${a.id}/process`, {}), { ok: 'Making clips with your settings and tips' })}>Make clips</${Button}>` : a.status === 'ready' && !j ? html`<${Button} size="sm" kind="ghost" icon="sparkle" onClick=${() => act(() => api.post(`/api/assets/${a.id}/process`, {}), { ok: 'Finding clips' })}>${a.transcript ? 'More clips' : 'Process'}</${Button}>` : html`<${StatusBadge} status=${a.status} />`}</div>`;
      }) : html`<div class="list-row faint">No footage yet</div>`}</div></div>
  </div>`;
}

/** How long the clips should be, per client: two sliders with the numbers shown. */
function ClipLength({ client }) {
  const p = client?.production || {};
  const [r, setR] = useState({ min: p.minClipSec || 20, max: p.maxClipSec || 59 });
  useEffect(() => setR({ min: p.minClipSec || 20, max: p.maxClipSec || 59 }), [client?.id]);
  const save = (next) => act(() => api.patch(`/api/clients/${client.id}`, { production: { minClipSec: next.min, maxClipSec: next.max } }), { ok: `Clips will be ${next.min} to ${next.max} seconds`, sound: 'tap' });
  const set = (k) => (e) => { const v = Number(e.target.value); setR(k === 'min' ? { min: v, max: Math.max(r.max, v + 5) } : { max: v, min: Math.min(r.min, v - 5) }); };
  return html`<div class="col" style="gap:4px;margin-top:10px;max-width:420px" onClick=${(e) => e.stopPropagation()}>
    <span class="label">Clip length: <b class="tnum">${r.min}s to ${r.max}s</b></span>
    <div class="row" style="gap:8px;font-size:var(--fs-xs)"><span class="faint" style="width:56px">Shortest</span><input class="range grow" type="range" min="5" max="175" step="1" value=${r.min} onInput=${set('min')} onChange=${() => save(r)} aria-label="Shortest clip in seconds" /><b class="tnum" style="width:34px">${r.min}s</b></div>
    <div class="row" style="gap:8px;font-size:var(--fs-xs)"><span class="faint" style="width:56px">Longest</span><input class="range grow" type="range" min="10" max="180" step="1" value=${r.max} onInput=${set('max')} onChange=${() => save(r)} aria-label="Longest clip in seconds" /><b class="tnum" style="width:34px">${r.max}s</b></div>
  </div>`;
}

/** Tips for the AI that picks the clips, and whether new footage waits for "Make clips" (so these can still change). */
function AiTips({ client }) {
  const p = client?.production || {}; const wait = p.waitForStart !== false;
  const [tips, setTips] = useState(p.aiTips || '');
  useEffect(() => setTips(p.aiTips || ''), [client?.id]);
  const save = (patch, ok) => act(() => api.patch(`/api/clients/${client.id}`, { production: patch }), { ok, sound: 'tap' });
  return html`<div class="col" style="gap:6px;margin-top:10px;max-width:520px" onClick=${(e) => e.stopPropagation()}>
    <span class="label">Tips for the AI</span>
    <textarea class="textarea" rows="2" value=${tips} placeholder="e.g. Focus on the drone shots and the reveal at the end. Skip the intro and the sponsor read. Funny moments first." onInput=${(e) => setTips(e.target.value)} onBlur=${() => { if (tips !== (p.aiTips || '')) save({ aiTips: tips.slice(0, 1000) }, tips.trim() ? 'Tips saved; used when clips are picked' : 'Tips cleared'); }} aria-label="Tips for the AI" />
    <div class="row" style="gap:8px;align-items:center"><${Toggle} on=${wait} onChange=${(x) => save({ waitForStart: x }, x ? 'New footage waits for "Make clips"' : 'New footage makes clips right away')} label="Wait for Make clips" /><span style="font-size:var(--fs-sm)">Wait for me to press <b>Make clips</b></span><span class="faint" style="font-size:var(--fs-xs)">${wait ? 'footage gets transcribed, then waits so you can change these first' : 'clips start as soon as footage is in'}</span></div>
  </div>`;
}

/** Every new clip also rendered full frame (16:9), so Vertical / Full frame / Both can be compared on the clip. */
function WideSwitch({ client }) {
  const on = !!client?.production?.wide;
  return html`<div class="row" style=${{ gap: '8px', alignItems: 'center', padding: '6px 10px', borderRadius: '10px', border: '1px solid var(--line)', background: on ? 'var(--surface-2)' : 'transparent' }} title="Off: vertical clips (9:16). On: every clip comes out in both sizes, vertical and widescreen (16:9)." onClick=${(e) => e.stopPropagation()}><${Toggle} on=${on} onChange=${(x) => act(() => api.patch(`/api/clients/${client.id}`, { production: { wide: x } }), { ok: x ? 'Dual video on: every new clip comes in vertical and widescreen' : 'Dual video off: vertical only', sound: 'tap' })} label="Dual video" /><div class="col" style="gap:0"><b style="font-size:var(--fs-sm)">Dual video</b><span class="faint" style="font-size:var(--fs-xs)">${on ? 'vertical + widescreen' : 'vertical only'}</span></div></div>`;
}

/**
 * What each video makes, per client: how many clips of each style (Walkthrough, Documentary, Highlights, Story text,
 * or Custom = the client's own look). One control; the total is the number of clips per video. Saved as
 * production.styleMix (and clipsPerFootage = the total, so everything else agrees).
 */
function StyleSwitch({ client }) {
  const { data: list } = useApi('/api/video-styles', []);
  if (!client) return null;
  const p = client.production || {}; const cs = client.style || {};
  const opts = [...(list || []), { id: 'custom', label: 'Custom', blurb: "This client's own caption look" }];
  // Older setups chose one style for every clip: shown here as that style times the clip count.
  const saved = Object.fromEntries(Object.entries(p.styleMix || {}).map(([k, v]) => [k, Number(v) || 0]));
  const mix = Object.values(saved).some((v) => v > 0) ? saved : { [p.videoStyle || 'custom']: p.clipsPerFootage || 6 };
  const total = Object.values(mix).reduce((a, b) => a + b, 0);
  const setN = (id, n) => {
    const next = { ...Object.fromEntries(opts.map((o) => [o.id, mix[o.id] || 0])), [id]: Math.max(0, Math.min(10, n)) };
    const sum = Object.values(next).reduce((a, b) => a + b, 0);
    act(() => api.patch(`/api/clients/${client.id}`, { production: { styleMix: next, ...(sum ? { clipsPerFootage: sum } : {}) } }), { sound: 'tap' });
  };
  const save = (patch, ok) => act(() => api.patch(`/api/clients/${client.id}`, { production: patch }), { ok, sound: 'tap' });
  // Each style's colour and a tiny sample of its look, so they can be told apart at a glance.
  const LOOK = {
    documentary: { color: '#E8C400', sample: html`<span style="font:800 13px Montserrat;color:#fff;text-shadow:0 0 2px #000,0 1px 2px #000">ABANDONED <span style="color:#F8D800">FACTORY</span></span>` },
    walkthrough: { color: '#E9A23B', sample: html`<span style="font:800 13px Montserrat;color:#fff;text-shadow:0 1px 3px #000">it's just <span style="color:#F5B850">crazy</span> how</span>` },
    highlights: { color: '#3FA796', sample: html`<span class="row" style="gap:3px;align-items:center">${[26, 18, 22].map((w) => html`<i style=${`display:block;width:${w}px;height:8px;border-radius:3px;background:#7fd8c8`} />`)}<span style="font:800 13px Montserrat;color:#fff;margin-left:4px;text-shadow:0 1px 3px #000">…the door?</span></span>` },
    story: { color: '#8B6FD6', sample: html`<span style="font:600 13px 'TikTok Sans', Inter, sans-serif;color:#fff;text-shadow:0 1px 4px rgba(0,0,0,.8)">You find something…</span>` },
    custom: { color: '#8A9099', sample: html`<span style=${`font:800 14px '${cs.font || 'Montserrat'}', Montserrat;color:${cs.primary || '#fff'};text-shadow:0 0 2px ${cs.outline || '#000'}`}>${(cs.uppercase !== false ? 'YOUR ' : 'your ')}<span style=${`color:${cs.highlight || '#F2C14E'}`}>${cs.uppercase !== false ? 'LOOK' : 'look'}</span></span>` },
  };
  const colorOf = (id) => LOOK[id]?.color || '#8A9099';
  return html`<div class="mix" onClick=${(e) => e.stopPropagation()}>
    <div class="row" style="gap:10px;align-items:center;flex-wrap:wrap">
      <b style="font-size:var(--fs-md, 15px)">What each video makes</b>
      <span class=${'mix-total' + (total ? '' : ' none')}>${total ? `${total} clip${total > 1 ? 's' : ''} per video` : 'Pick at least one'}</span>
    </div>
    ${total ? html`<div class="mix-bar" title=${opts.filter((o) => mix[o.id] > 0).map((o) => `${mix[o.id]} ${o.label}`).join(', ')}>${opts.filter((o) => mix[o.id] > 0).map((o) => html`<i style=${`flex:${mix[o.id]};background:${colorOf(o.id)}`} />`)}</div>` : null}
    <div class="mix-grid">
      ${opts.map((o) => { const n = mix[o.id] || 0; return html`<div class=${'mix-card' + (n ? ' on' : '')} style=${`--mc:${colorOf(o.id)}`}>
        <div class="mix-sample">${LOOK[o.id]?.sample || null}</div>
        <div class="row" style="gap:6px;align-items:center"><b class="mix-name grow">${o.label}</b>
          <div class="mix-step">
            <button type="button" aria-label=${`Fewer ${o.label}`} disabled=${!n} onClick=${() => setN(o.id, n - 1)}>−</button>
            <b class="tnum">${n}</b>
            <button type="button" aria-label=${`More ${o.label}`} onClick=${() => setN(o.id, n + 1)}>+</button>
          </div>
        </div>
        <span class="faint mix-blurb" title=${o.blurb}>${o.blurb}</span>
        ${o.id === 'story' && n ? html`<div class="row wrap" style="gap:6px;font-size:var(--fs-xs);align-items:center">
          <select class="select" style="height:28px;font-size:var(--fs-xs);width:auto" value=${String(p.storySeconds || 45)} onChange=${(e) => save({ storySeconds: Number(e.target.value) }, `Story edits: about ${e.target.value} seconds`)} aria-label="Story length">${[20, 30, 45, 60].map((x) => html`<option value=${x}>${x} seconds</option>`)}</select>
          <select class="select" style="height:28px;font-size:var(--fs-xs);width:auto" value=${p.storyMood || 'suspense'} onChange=${(e) => save({ storyMood: e.target.value }, `Story music: ${e.target.selectedOptions[0].text}`)} aria-label="Story music">${[['suspense', 'Suspense'], ['intense', 'Intense'], ['darkbeat', 'Dark beat'], ['creepy', 'Creepy']].map(([v, l]) => html`<option value=${v}>${l} music</option>`)}</select>
        </div>` : null}
      </div>`; })}
    </div>
  </div>`;
}

/** Extra B-roll edit per video: a dramatic, music-only cut-through of the best shots. Off unless switched on. */
function BrollSwitch({ client }) {
  const p = client?.production || {}; const on = !!p.brollEdit;
  const save = (patch, ok) => act(() => api.patch(`/api/clients/${client.id}`, { production: patch }), { ok, sound: 'tap' });
  return html`<div class="col" style="gap:6px;margin-top:10px;max-width:520px" onClick=${(e) => e.stopPropagation()}>
    <div class="row" style="gap:8px;align-items:center"><${Toggle} on=${on} onChange=${(x) => save({ brollEdit: x }, x ? 'Each video also gets a B-roll edit' : 'B-roll edit off')} label="B-roll edit" /><span class="label">B-roll edit</span><span class="faint" style="font-size:var(--fs-xs)">${on ? 'an extra clip per video: the best shots cut on the beat of dark music, no talking' : 'off'}</span>
      <span class="grow" /><${Button} size="sm" kind="soft" icon="film" title="Make a B-roll edit now from this client's footage (the one with the fewest so far)" onClick=${() => act(() => api.post(`/api/clients/${client.id}/broll`), { ok: 'Making a B-roll edit. It shows up under Clips.' })}>Make a B-roll edit now</${Button}></div>
    ${on ? html`<div class="row wrap" style="gap:8px;font-size:var(--fs-xs);align-items:center"><span class="faint" style="width:56px">Mood</span>
      <select class="select" style="height:30px;font-size:var(--fs-xs);width:auto" value=${p.brollMood || 'darkbeat'} onChange=${(e) => save({ brollMood: e.target.value }, `B-roll music: ${e.target.selectedOptions[0].text}`)} aria-label="B-roll music mood">${[['darkbeat', 'Dark beat (horror trap)'], ['suspense', 'Suspense'], ['creepy', 'Eerie / creepy'], ['intense', 'Intense / hype'], ['triumphant', 'Epic / triumphant'], ['sad', 'Emotional'], ['chill', 'Chill']].map(([v, l]) => html`<option value=${v}>${l}</option>`)}</select>
      <span class="faint">Length</span><select class="select" style="height:30px;font-size:var(--fs-xs);width:auto" value=${String(p.brollSeconds || 20)} onChange=${(e) => save({ brollSeconds: Number(e.target.value) }, `B-roll edit: about ${e.target.value}s`)} aria-label="B-roll edit length">${[10, 15, 20, 30, 45].map((n) => html`<option value=${n}>${n}s</option>`)}</select>
      <${Toggle} on=${!!p.brollDaily} onChange=${(x) => save({ brollDaily: x }, x ? 'A new B-roll edit every day' : 'Daily B-roll edit off')} label="One per day" /><span>One per day</span></div>` : null}
  </div>`;
}

const MOOD_LABEL = { auto: 'Auto (fits each moment)', creepy: 'Creepy / scary', suspense: 'Suspense', intense: 'Intense', triumphant: 'Triumphant', positive: 'Uplifting', sad: 'Sad', chill: 'Chill', funny: 'Funny' };
/** Music on/off for a client's clips, how loud, and the default mood. */
function MusicSwitch({ client }) {
  const p = client?.production || {}; const on = p.music !== false;
  const [vol, setVol] = useState(Math.round((p.musicVolume ?? 0.3) * 100));
  useEffect(() => setVol(Math.round((p.musicVolume ?? 0.3) * 100)), [client?.id]);
  const save = (patch, ok) => act(() => api.patch(`/api/clients/${client.id}`, { production: patch }), { ok, sound: 'tap' });
  return html`<div class="col" style="gap:6px;margin-top:10px;max-width:420px" onClick=${(e) => e.stopPropagation()}>
    <div class="row" style="gap:8px;align-items:center"><${Toggle} on=${on} onChange=${(x) => save({ music: x }, x ? 'Music on for new clips' : 'Music off for new clips')} label="Music" /><span class="label">Background music</span><span class="faint" style="font-size:var(--fs-xs)">${on ? 'royalty-free, picked to fit each moment' : 'off'}</span></div>
    ${on ? html`<div class="row wrap" style="gap:8px;font-size:var(--fs-xs);align-items:center"><span class="faint" style="width:56px">Volume</span><input class="range grow" type="range" min="5" max="80" step="1" value=${vol} onInput=${(e) => setVol(Number(e.target.value))} onChange=${() => save({ musicVolume: vol / 100 }, `Music volume ${vol}%`)} aria-label="Music volume" /><b class="tnum" style="width:34px">${vol}%</b>
      <select class="select" style="height:30px;font-size:var(--fs-xs);width:auto" value=${p.musicMood || 'auto'} onChange=${(e) => save({ musicMood: e.target.value }, `Music: ${MOOD_LABEL[e.target.value]}`)} aria-label="Music mood">${Object.entries(MOOD_LABEL).map(([k, l]) => html`<option value=${k}>${l}</option>`)}</select></div>` : null}
  </div>`;
}

/** One footage file: what has happened to it, its clips, and Retry / Cancel / Delete. */
function FootageDrawer({ id, onClose, onShots }) {
  const { data, reload } = useApi(`/api/assets/${id}/detail`, ['job', 'assets', 'clips']);
  if (!data) return html`<${Drawer} title="Footage" onClose=${onClose}><${Loading} /></${Drawer}>`;
  const a = data.asset; const active = data.jobs.filter((j) => ['queued', 'running'].includes(j.status));
  const retry = () => act(() => api.post(`/api/assets/${a.id}/process`, {}), { ok: 'Trying again' }).then(reload);
  const cancel = (remove) => act(() => api.post(`/api/assets/${a.id}/cancel`, { remove }), { ok: remove ? 'Deleted' : 'Canceled' }).then(() => (remove ? onClose() : reload()));
  return html`<${Drawer} wide title=${a.name} sub=${a.info ? `${dur(a.info.duration)} · ${a.info.width}×${a.info.height}` : a.status} onClose=${onClose}>
    <div class="col" style="gap:14px">
      <div class="row wrap" style="gap:6px">${data.steps.map((s, i) => html`<span class=${'badge ' + (s.ok ? 'moss' : active.length && !data.steps.slice(0, i).some((x) => !x.ok) ? 'sky' : '')}>${s.ok ? '✓' : `${i + 1}.`} ${s.label}</span>`)}</div>
      ${a.error ? html`<div class="notice coral">Stopped: ${a.error}</div>` : null}
      ${active.map((j) => html`<div><div class="row" style="font-size:var(--fs-sm)"><span class="grow">${j.title}: ${j.note || j.status}</span><span class="faint tnum">${Math.round((j.progress || 0) * 100)}%</span></div><${Progress} value=${j.progress} indeterminate=${!j.progress} /></div>`)}
      <div class="row wrap" style="gap:6px">
        <${Button} kind="primary" icon=${a.status === 'waiting' ? 'play' : 'refresh'} onClick=${retry}>${a.status === 'waiting' ? 'Make clips' : a.status === 'ready' ? 'Find more clips' : 'Retry'}</${Button}>
        ${active.length ? html`<${Button} kind="ghost" icon="stop" onClick=${() => cancel(false)}>Cancel</${Button}>` : null}
        ${a.status === 'ready' ? html`<${Button} kind="ghost" icon="eye" onClick=${() => onShots(a)}>Shots</${Button}>` : null}
        ${a.info?.hasVideo !== false && ['ready', 'waiting'].includes(a.status) ? html`<${Button} kind="ghost" icon="film" title="An extra clip: the best shots cut to dramatic music, no talking" onClick=${() => act(() => api.post(`/api/assets/${a.id}/broll`), { ok: 'Making a B-roll edit' })}>B-roll edit</${Button}>` : null}
        <span class="grow" /><${Button} kind="ghost" icon="trash" onClick=${() => cancel(true)}>Delete</${Button}>
      </div>
      <${Transcript} a=${a} />
      <div><h4>Clips from this video</h4>${data.clips.length ? html`<div class="list">${data.clips.map((c) => html`<div class="list-row" style="cursor:pointer" onClick=${() => { onClose(); navigate(`/production?clip=${c.id}`); }}><b class="grow">${c.title}</b><span class="faint tnum">${dur(c.end - c.start)}</span><${StatusBadge} status=${c.status} /></div>`)}</div>` : html`<div class="faint">No clips yet. They appear here and on the board below as they're made.</div>`}</div>
      ${data.jobs.length ? html`<details><summary class="faint">History</summary><div class="col" style="gap:4px;font-size:var(--fs-xs);margin-top:6px">${data.jobs.slice().reverse().map((j) => html`<div><b>${j.title}</b> · ${j.status}${j.error ? `: ${j.error}` : ''}</div>`)}</div></details>` : null}
    </div></${Drawer}>`;
}

/** Which of the five footage steps a job is. */
const STEP_NAME = { 'ingest.url': 'Downloading', 'ingest.file': 'Importing', transcribe: 'Turning speech into text', analyze: 'Looking through it', 'video.look': 'Looking through it', discover: 'Finding clips', 'render.short': 'Making the short' };
const STEP_OF = { 'ingest.url': 1, 'ingest.file': 1, transcribe: 2, analyze: 3, 'video.look': 3, discover: 4, 'render.short': 5 };

/** The full transcript of a video: read it, copy it, download it as text or subtitles. */
function Transcript({ a }) {
  const { data: t, reload } = useApi(`/api/assets/${a.id}/transcript`, ['assets', 'job']);
  const segs = t?.segments || [];
  const stamp = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  const text = segs.map((s) => `[${stamp(s.s)}] ${s.t}`).join('\n');
  const copy = () => navigator.clipboard?.writeText(segs.map((s) => s.t).join(' ')).then(() => toast('Transcript copied', { kind: 'ok' })).catch(() => toast('Select the text and copy it instead.', { kind: 'warn' }));
  return html`<details class="panel pad" open=${!!segs.length}>
    <summary><b>Transcript</b> <span class="faint" style="font-size:var(--fs-xs)">${segs.length ? `${(t.words || []).length} words` : 'not made yet'}</span></summary>
    <div class="col" style="gap:8px;margin-top:8px">
      ${segs.length ? html`<div class="selectable" style="max-height:260px;overflow:auto;white-space:pre-wrap;font-size:var(--fs-sm);line-height:1.6;background:var(--surface-2);border-radius:10px;padding:10px 12px">${text}</div>
        <div class="row wrap" style="gap:6px"><${Button} size="sm" kind="primary" onClick=${copy}>Copy text</${Button}><a class="btn ghost sm" href=${api.url(`/api/assets/${a.id}/transcript-file/txt`) + '&download=1'}>Download .txt</a><a class="btn ghost sm" href=${api.url(`/api/assets/${a.id}/transcript-file/srt`) + '&download=1'}>Download subtitles (.srt)</a></div>`
      : html`<div class="row wrap" style="gap:8px"><span class="faint grow" style="font-size:var(--fs-sm)">Turns everything said in the video into text with timestamps. Uses the free speech-to-text tool (installed automatically the first time).</span><${Button} size="sm" kind="primary" onClick=${() => act(() => api.post(`/api/assets/${a.id}/transcribe`, {}), { ok: 'Making the transcript' }).then(reload)}>Make transcript</${Button}></div>`}
    </div></details>`;
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
  const remove = async (e) => {
    e.stopPropagation();
    if (!(await confirmDialog({ title: 'Delete this clip?', text: `"${c.title}" (#${c.ref}) and its rendered videos will be deleted. This can't be undone. The original footage stays.`, confirm: 'Delete clip' }))) return;
    act(() => api.del(`/api/clips/${c.id}`), { ok: 'Clip deleted' });
  };
  return html`<div class="clip-card" onClick=${() => { play('open'); navigate(`/production?clip=${c.id}`); }}>
    <button class="clip-x" title="Delete clip" aria-label="Delete clip" onClick=${remove}><${Icon} name="x" size=${14} /></button>
    <div class="th" style=${thumb ? { backgroundImage: `url(${thumb})` } : null}>${!thumb ? (c.status === 'rendering' ? html`<span class="spinner" />` : html`<${Icon} name="film" size=${16} />`) : null}</div>
    <div style="min-width:0"><div class="t">${c.title}</div>
      <div class="m"><span class="tnum">#${c.ref}</span><span>${Math.round(c.end - c.start)}s</span>${showClient ? html`<span class="ellipsis">${c.client}</span>` : null}</div>
      <div class="m">${c.status === 'rendering' ? html`<span class="badge sky tnum">${c.renderProgress ? `${c.renderProgress}%` : 'Waiting'}</span>` : null}${c.status === 'failed' ? html`<span class="badge coral" title=${c.error || ''}>Failed: open for why</span>` : null}${c.current?.qc && !c.current.qc.passed ? html`<span class="badge coral">QC</span>` : null}${c.status === 'revising' ? html`<span class="badge teal">Revising</span>` : null}${c.current?.n > 1 ? html`<span class="badge outline">v${c.current.n}</span>` : null}${c.method === 'ai' ? html`<span class="badge lav">AI</span>` : null}${c.post?.scheduledAt && c.status === 'scheduled' ? html`<span class="faint">${new Date(c.post.scheduledAt).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}</span>` : null}</div>
    </div></div>`;
}
