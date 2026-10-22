// Copy a video's style for the political ads: paste any video link or choose a file; Euclidean works out
// how it was made (pacing, captions, effects, colours, structure) and the next ads copy it.
import { html, useState, useApi, Button, Progress, act, toast, confirmDialog } from '../lib/ui.js';
import { api } from '../lib/api.js';
import { ago } from '../lib/format.js';

export function CopyStyle() {
  const [src, setSrc] = useState(''); const [up, setUp] = useState(false);
  const { data: list, reload } = useApi('/api/reverse', ['settings']);
  const { data: jobs } = useApi('/api/jobs?status=running,queued', ['job']);
  const busy = (jobs || []).filter((j) => j.type === 'video.reverse');
  const go = () => act(() => api.post('/api/reverse', { src: src.trim() }), { ok: 'Studying the video. You get a notification when it is done.' }).then(() => setSrc(''));
  const pick = async (e) => {
    const f = e.target.files?.[0]; e.target.value = ''; if (!f) return;
    setUp(true);
    try {
      const res = await fetch(api.url('/api/reverse/upload'), { method: 'POST', headers: { 'content-type': f.type || 'video/mp4', 'x-file-name': encodeURIComponent(f.name) }, body: f });
      const j = await res.json().catch(() => ({})); if (!res.ok) throw new Error(j.error || `Upload failed (${res.status})`);
      toast('Studying the video. You get a notification when it is done.', { kind: 'ok' });
    } catch (err) { toast(err.message, { kind: 'error' }); }
    setUp(false);
  };
  return html`<details class="panel pad" style="background:var(--surface-2)">
    <summary><b>Copy a video's style</b> <span class="faint" style="font-size:var(--fs-xs)">Give it any video you like. The ads copy its pacing, structure and on-screen style (never its facts).</span></summary>
    <div class="col" style="gap:8px;margin-top:10px">
      <div class="row wrap" style="gap:8px">
        <input id="cs-src" class="input grow" style="min-width:220px" placeholder="Paste any video link (YouTube, TikTok, Instagram, Facebook, X…)" value=${src} onInput=${(e) => setSrc(e.target.value)} onKeyDown=${(e) => e.key === 'Enter' && src.trim() && go()} />
        <${Button} size="sm" kind="primary" disabled=${!src.trim()} onClick=${go}>Study it</${Button}>
        <label class="btn ghost sm" style="cursor:pointer">${up ? 'Uploading…' : 'Choose a file'}<input type="file" accept="video/*" style="display:none" disabled=${up} onChange=${pick} /></label>
      </div>
      ${busy.map((j) => html`<div><div class="row" style="font-size:var(--fs-sm)"><span class="grow">${j.note || j.title}</span><span class="faint tnum">${Math.round((j.progress || 0) * 100)}%</span></div><${Progress} value=${j.progress} indeterminate=${!j.progress} /></div>`)}
      ${(list || []).map((x) => html`<${Recipe} key=${x.id} x=${x} reload=${reload} />`)}
    </div>
  </details>`;
}

function Recipe({ x, reload }) {
  const [open, setOpen] = useState(false);
  const r = x.recipe || {}; const c = r.captions || {};
  const use = () => act(() => api.post(`/api/reverse/${x.id}/apply`, { political: true }), { ok: 'The next political ads will copy this style' });
  const del = async () => { if (await confirmDialog({ title: 'Delete this?', confirm: 'Delete', kind: 'coral' })) act(() => api.del(`/api/reverse/${x.id}`), { ok: 'Deleted' }).then(reload); };
  return html`<div class="panel pad col" style="gap:6px">
    <div class="row wrap" style="gap:8px"><b class="grow" style="min-width:0;overflow-wrap:anywhere">${r.summary || x.src}</b><span class="faint" style="font-size:var(--fs-xs)">${ago(x.at)}</span></div>
    <div class="faint" style="font-size:var(--fs-xs)">${[`${x.duration}s`, x.vertical ? 'vertical' : 'horizontal', x.cuts != null && `${x.cuts} cuts`, x.avgShot != null && `${x.avgShot}s a shot`, x.speech?.wordsPerMinute && `${x.speech.wordsPerMinute} words a minute`].filter(Boolean).join(' · ')}</div>
    ${open ? html`<div class="col" style="gap:6px;font-size:var(--fs-sm)">
      ${x.sheet ? html`<img src=${api.url(`/api/reverse/${x.id}/sheet`)} style="max-width:100%;border-radius:10px" loading="lazy" />` : null}
      ${[['Hook', r.hook], ['Captions', c.present ? [c.position, c.uppercase ? 'UPPERCASE' : 'sentence case', c.wordsPerLine && `${c.wordsPerLine} words a line`, c.box && 'boxed', c.animation === 'pop' && 'pop-in'].filter(Boolean).join(', ') : ''], ['Effects', [...(r.effects || []), ...(r.transitions || [])].join(', ')], ['Text overlays', r.textOverlays], ['Colour', r.colorGrade], ['Music', r.music], ['Pacing', r.pacing]].filter(([, v]) => v).map(([k, v]) => html`<div><b>${k}:</b> ${v}</div>`)}
      ${(r.recreate || []).length ? html`<div><b>How it's made</b><ol style="padding-left:18px">${r.recreate.map((s) => html`<li>${s}</li>`)}</ol></div>` : null}
    </div>` : null}
    <div class="row wrap" style="gap:6px"><${Button} size="sm" kind="primary" onClick=${use}>Use for the political ads</${Button}><${Button} size="sm" kind="ghost" onClick=${() => setOpen(!open)}>${open ? 'Less' : 'Details'}</${Button}><span class="grow" /><${Button} size="sm" kind="ghost" icon="trash" onClick=${del}>Delete</${Button}></div>
  </div>`;
}
