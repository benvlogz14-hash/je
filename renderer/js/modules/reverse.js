// Reverse-engineer any reel: paste a link, get a recipe (pacing, captions, effects, colours, structure), apply it.
import { html, useState, useApi, Button, Progress, act, confirmDialog } from '../lib/ui.js';
import { api } from '../lib/api.js';
import { Icon } from '../lib/icons.js';
import { ago } from '../lib/format.js';

export function ReverseReel({ clients = [], clientId = '' }) {
  const [src, setSrc] = useState('');
  const { data: list, reload } = useApi('/api/reverse', ['settings']);
  const { data: jobs } = useApi('/api/jobs?status=running,queued', ['job']);
  const busy = (jobs || []).filter((j) => j.type === 'video.reverse');
  const go = () => act(() => api.post('/api/reverse', { src: src.trim() }), { ok: 'Studying it. You get a notification when the recipe is ready.' }).then(() => setSrc(''));
  return html`<div class="panel pad col" style="gap:10px;margin-top:14px">
    <div class="row" style="gap:10px"><div class="avatar" style="background:var(--lav-soft);color:var(--lav-ink)"><${Icon} name="sparkle" size=${17} /></div>
      <div class="grow"><h4>Reverse-engineer a reel</h4><div class="faint" style="font-size:var(--fs-xs)">Paste any reel, short, TikTok or ad. Euclidean works out how it was made (pacing, captions, effects, colours, structure) and can copy the style into a client's edits or the political ads.</div></div></div>
    <div class="row wrap" style="gap:8px"><input id="rv-src" class="input grow" style="min-width:240px" placeholder="https://www.instagram.com/reel/…  or a YouTube, TikTok, Facebook or X link" value=${src} onInput=${(e) => setSrc(e.target.value)} onKeyDown=${(e) => e.key === 'Enter' && src.trim() && go()} /><${Button} kind="primary" icon="sparkle" disabled=${!src.trim()} onClick=${go}>Reverse-engineer</${Button}></div>
    ${busy.map((j) => html`<div><div class="row" style="font-size:var(--fs-sm)"><span class="grow">${j.note || j.title}</span><span class="faint tnum">${Math.round((j.progress || 0) * 100)}%</span></div><${Progress} value=${j.progress} indeterminate=${!j.progress} /></div>`)}
    ${(list || []).map((x) => html`<${Recipe} key=${x.id} x=${x} clients=${clients} clientId=${clientId} reload=${reload} />`)}
  </div>`;
}

function Recipe({ x, clients, clientId, reload }) {
  const [open, setOpen] = useState(false); const [pick, setTo] = useState(''); const to = pick || clientId || clients[0]?.id || '';
  const r = x.recipe || {}; const c = r.captions || {};
  const apply = (body, ok) => act(() => api.post(`/api/reverse/${x.id}/apply`, body), { ok });
  const del = async () => { if (await confirmDialog({ title: 'Delete this recipe?', confirm: 'Delete', kind: 'coral' })) act(() => api.del(`/api/reverse/${x.id}`), { ok: 'Deleted' }).then(reload); };
  const stat = (k, v) => (v == null || v === '' ? null : html`<div class="panel" style="padding:6px 10px"><div class="faint" style="font-size:var(--fs-xs)">${k}</div><b>${v}</b></div>`);
  return html`<div class="panel pad col" style="gap:8px;background:var(--surface-2)">
    <div class="row wrap" style="gap:8px"><b class="grow" style="min-width:0;overflow-wrap:anywhere">${r.summary || x.src}</b><span class="faint" style="font-size:var(--fs-xs)">${ago(x.at)}</span><${Button} size="sm" kind="ghost" onClick=${() => setOpen(!open)}>${open ? 'Less' : 'Full recipe'}</${Button}></div>
    <div class="row wrap" style="gap:6px">${stat('Length', `${x.duration}s`)}${stat('Shape', x.vertical ? 'Vertical' : 'Horizontal')}${stat('Cuts', x.cuts)}${stat('Per shot', x.avgShot != null ? `${x.avgShot}s` : null)}${stat('Words/min', x.speech?.wordsPerMinute)}${stat('Loudness', x.loudness ? `${x.loudness.lufs} LUFS` : null)}
      ${x.palette?.length ? html`<div class="panel row" style="padding:6px 10px;gap:4px"><span class="faint" style="font-size:var(--fs-xs)">Colours</span>${x.palette.map((h) => html`<span title=${h} style=${{ width: '18px', height: '18px', borderRadius: '50%', background: h, border: '1px solid var(--line)' }} />`)}</div>` : null}</div>
    ${r.hook ? html`<div style="font-size:var(--fs-sm)"><b>Hook:</b> ${r.hook}</div>` : null}
    ${c.present ? html`<div style="font-size:var(--fs-sm)"><b>Captions:</b> ${[c.position, c.uppercase ? 'UPPERCASE' : 'sentence case', c.wordsPerLine && `${c.wordsPerLine} words a line`, c.box && 'boxed', c.animation === 'pop' && 'pop-in', c.font].filter(Boolean).join(', ')} ${c.highlight ? html`<span style=${{ display: 'inline-block', width: '12px', height: '12px', borderRadius: '3px', background: c.highlight, verticalAlign: 'middle' }} />` : null}</div>` : null}
    ${(r.effects || []).length ? html`<div class="row wrap" style="gap:4px">${[...(r.effects || []), ...(r.transitions || [])].slice(0, 10).map((e) => html`<span class="badge lav">${e}</span>`)}</div>` : null}
    ${open ? html`<div class="col" style="gap:8px;font-size:var(--fs-sm)">
      ${x.sheet ? html`<img src=${api.url(`/api/reverse/${x.id}/sheet`)} style="max-width:100%;border-radius:10px" loading="lazy" />` : null}
      ${(r.structure || []).length ? html`<div><b>Structure</b><ol style="padding-left:18px">${r.structure.map((s) => html`<li><span class="faint tnum">${Number(s.at || 0).toFixed(1)}s</span> <b>${s.beat}</b> ${s.what}</li>`)}</ol></div>` : null}
      ${[['Text overlays', r.textOverlays], ['Colour', r.colorGrade], ['B-roll', r.broll], ['Music', r.music], ['Pacing', r.pacing]].filter(([, v]) => v).map(([k, v]) => html`<div><b>${k}:</b> ${v}</div>`)}
      ${(r.recreate || []).length ? html`<div><b>How to recreate it</b><ol style="padding-left:18px">${r.recreate.map((s) => html`<li>${s}</li>`)}</ol></div>` : null}
      ${x.speech?.opening ? html`<div class="faint">Opening line: "${x.speech.opening}"</div>` : null}
      <div class="faint" style="font-size:var(--fs-xs)">${x.src} · ${x.agent === 'measured' ? 'measured only (connect an AI that can see for the full breakdown)' : x.agent}</div>
    </div>` : null}
    <div class="row wrap" style="gap:6px">
      ${clients.length ? html`<select class="select" style="width:200px" value=${to} onChange=${(e) => setTo(e.target.value)} aria-label="Client">${clients.map((cl) => html`<option value=${cl.id}>${cl.name}</option>`)}</select><${Button} size="sm" kind="primary" onClick=${() => apply({ clientId: to }, 'Style saved for this client: captions and editing notes')}>Use this style for the client</${Button}>` : null}
      ${x.avgShot ? html`<${Button} size="sm" kind="ghost" onClick=${() => apply({ political: true }, 'Political ads will use this pacing')}>Use its pacing for political ads</${Button}>` : null}
      <span class="grow" /><${Button} size="sm" kind="ghost" icon="trash" onClick=${del}>Delete</${Button}>
    </div>
  </div>`;
}
