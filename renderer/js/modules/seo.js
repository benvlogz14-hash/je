// SEO lab: feed it your research files and your stats, and it writes titles, descriptions and tags that follow both.
import { html, useState, useApi, Button, Seg, act, toast, confirmDialog } from '../lib/ui.js';
import { api } from '../lib/api.js';

const PLATFORMS = [{ value: 'youtube', label: 'YouTube' }, { value: 'shorts', label: 'Shorts' }, { value: 'tiktok', label: 'TikTok' }, { value: 'instagram', label: 'Reels' }];
const copy = (t) => { navigator.clipboard?.writeText(t); toast('Copied', { kind: 'ok' }); };
const fmt = (n) => (n == null ? '' : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}K` : Math.round(n).toLocaleString('en-US'));
const tone = (s) => (s >= 80 ? 'moss' : s >= 60 ? 'gold' : 'coral');

async function readFiles(list) {
  const out = [];
  for (const f of list) {
    if (f.size > 3.5 * 1024 * 1024) { toast(`${f.name} is over 3.5 MB; split it into smaller files.`, { kind: 'error' }); continue; }
    if (!/\.(txt|md|csv|tsv|json|text|markdown)$/i.test(f.name) && f.type && !f.type.startsWith('text')) { toast(`${f.name}: send text files (.txt, .md, .csv).`, { kind: 'error' }); continue; }
    out.push({ name: f.name, text: await f.text() });
  }
  return out;
}

function Library({ data, reload }) {
  const [paste, setPaste] = useState(null);
  const [view, setView] = useState(null);
  const [drag, setDrag] = useState(false);
  const add = async (files) => { if (!files.length) return; await act(() => api.post('/api/seo/docs', { files }), { ok: `Added ${files.length} file${files.length > 1 ? 's' : ''}` }); reload(); };
  const pick = () => { const i = document.createElement('input'); i.type = 'file'; i.multiple = true; i.accept = '.txt,.md,.csv,.tsv,.json,text/*'; i.onchange = async () => add(await readFiles([...i.files])); i.click(); };
  const open = async (d) => { try { setView(await api.get(`/api/seo/docs/${d.id}`)); } catch (e) { toast(e.message, { kind: 'error' }); } };
  const remove = async (d) => { if (!(await confirmDialog({ title: `Remove ${d.name}?`, text: d.kind === 'stats' ? `Its ${d.rows} rows of stats go too.` : 'The machine stops using it.', confirm: 'Remove' }))) return; await act(() => api.del(`/api/seo/docs/${d.id}`), { ok: 'Removed' }); reload(); };
  return html`<div class="panel pad col" style="gap:10px">
    <div class="row wrap" style="gap:8px"><b class="grow">What it knows</b>
      <${Button} size="sm" icon="upload" kind="primary" onClick=${pick}>Add files</${Button}>
      <${Button} size="sm" icon="edit" kind="ghost" onClick=${() => setPaste({ name: '', text: '' })}>Paste text</${Button}></div>
    <div class=${'col'} style=${{ gap: '6px', border: `1.5px dashed ${drag ? 'var(--sky)' : 'var(--line)'}`, borderRadius: '12px', padding: '12px', background: drag ? 'var(--sky-soft)' : 'transparent' }}
      onDragOver=${(e) => { e.preventDefault(); setDrag(true); }} onDragLeave=${() => setDrag(false)}
      onDrop=${async (e) => { e.preventDefault(); setDrag(false); add(await readFiles([...e.dataTransfer.files])); }}>
      <div class="faint" style="font-size:var(--fs-sm)">Drop your SEO notes here (.txt, .md) and your stats exports (.csv from YouTube Studio, TikTok or a spreadsheet: any table with a title column and views, CTR or watch time). Tables are read as stats, everything else as research.</div>
      ${(data.docs || []).length ? (data.docs || []).map((d) => html`<div class="row" style="gap:8px;padding:6px 0;border-top:1px solid var(--line)">
        <span class=${'badge ' + (d.kind === 'stats' ? 'sky' : 'lav')}>${d.kind === 'stats' ? 'Stats' : 'Research'}</span>
        <a class="grow" style="cursor:pointer" onClick=${() => open(d)}>${d.name}</a>
        <span class="faint" style="font-size:var(--fs-xs)">${d.kind === 'stats' ? `${d.rows} videos` : (d.chars < 1000 ? `${d.chars} characters` : `${Math.round(d.chars / 1000)}K characters`)}</span>
        <${Button} size="sm" kind="ghost" icon="trash" title="Remove" onClick=${() => remove(d)} /></div>`) : html`<div class="faint">Nothing yet. Add the research you keep in Claude and ChatGPT, and your stats.</div>`}
    </div>
    ${paste ? html`<div class="col" style="gap:6px">
      <input class="input" placeholder="Name (e.g. Title rules)" value=${paste.name} onInput=${(e) => setPaste({ ...paste, name: e.target.value })} />
      <textarea class="input" rows="8" placeholder="Paste your notes or a table copied from a spreadsheet" value=${paste.text} onInput=${(e) => setPaste({ ...paste, text: e.target.value })} />
      <div class="row" style="gap:8px"><${Button} size="sm" kind="primary" disabled=${!paste.text.trim()} onClick=${async () => { await add([{ name: paste.name.trim() || 'Pasted notes', text: paste.text }]); setPaste(null); }}>Save</${Button}><${Button} size="sm" kind="ghost" onClick=${() => setPaste(null)}>Cancel</${Button}></div></div>` : null}
    ${view ? html`<div class="col" style="gap:6px"><div class="row"><b class="grow">${view.name}</b><${Button} size="sm" kind="ghost" onClick=${() => setView(null)}>Close</${Button}></div>
      <div class="selectable panel pad" style="white-space:pre-wrap;font-size:var(--fs-sm);max-height:320px;overflow:auto">${view.text.slice(0, 40000)}${view.text.length > 40000 ? '\n…' : ''}</div></div>` : null}
  </div>`;
}

function Patterns({ p, stats }) {
  if (!stats) return html`<div class="panel pad col" style="gap:6px"><b>What wins</b><div class="faint">Add a stats export and it measures what your best titles have in common (length, numbers, questions, capitals, first words, winning words).</div></div>`;
  return html`<div class="panel pad col" style="gap:8px"><div class="row"><b class="grow">What wins</b><span class="faint" style="font-size:var(--fs-xs)">${p.rows} videos, judged by ${p.metric}</span></div>
    ${p.enough ? html`<ul style="margin:0;padding-left:18px;font-size:var(--fs-sm);line-height:1.6">${p.rules.map((r) => html`<li style=${{ color: r.good === false ? 'var(--coral)' : '' }}>${r.text}</li>`)}</ul>` : html`<div class="faint">It needs at least 6 videos with ${p.metric} to measure patterns.</div>`}
    ${(p.top || []).length ? html`<div class="faint" style="font-size:var(--fs-xs);margin-top:4px">YOUR BEST TITLES</div>${p.top.slice(0, 8).map((r) => html`<div class="row" style="gap:8px;font-size:var(--fs-sm)"><span class="grow selectable">${r.title}</span><span class="badge">${fmt(r[p.metric])}${p.metric === 'ctr' ? '%' : ''}</span></div>`)}` : null}
  </div>`;
}

function Result({ run, clips }) {
  const [clipId, setClipId] = useState(run.clipId || '');
  const [chosen, setChosen] = useState(0);
  const t = run.titles[chosen];
  const apply = () => act(() => api.post('/api/seo/apply', { clipId, title: t?.title, description: run.description, hashtags: run.hashtags }), { ok: 'Title and description put on the clip' });
  return html`<div class="panel pad col" style="gap:10px">
    <div class="row wrap" style="gap:8px"><b class="grow">${run.topic || (clips.find((c) => c.id === run.clipId)?.title) || 'Titles'}</b>
      <span class="faint" style="font-size:var(--fs-xs)">${PLATFORMS.find((x) => x.value === run.platform)?.label} · used ${run.usedDocs?.length || 0} research file${run.usedDocs?.length === 1 ? '' : 's'}, ${run.statRows || 0} videos of stats · ${run.by}</span></div>
    <div class="col" style="gap:6px">${run.titles.map((x, i) => html`<div class="row" style=${{ gap: '8px', alignItems: 'flex-start', padding: '8px 10px', borderRadius: '10px', cursor: 'pointer', border: `1.5px solid ${i === chosen ? 'var(--ink)' : 'var(--line)'}` }} onClick=${() => setChosen(i)}>
      <span class=${'badge ' + tone(x.score)} title="How well it matches your best titles">${x.score}</span>
      <div class="grow col" style="gap:2px"><b class="selectable">${x.title}</b><span class="faint" style="font-size:var(--fs-xs)">${x.title.length} characters${x.reason ? ` · ${x.reason}` : ''}</span></div>
      <${Button} size="sm" kind="ghost" onClick=${(e) => { e.stopPropagation(); copy(x.title); }}>Copy</${Button}></div>`)}</div>
    ${t ? html`<div class="faint" style="font-size:var(--fs-xs)">Score notes: ${(t.why || []).join(' · ') || 'none'}</div>` : null}
    ${run.description ? html`<div class="col" style="gap:4px"><div class="row"><b class="grow" style="font-size:var(--fs-sm)">Description</b><${Button} size="sm" kind="ghost" onClick=${() => copy(run.description)}>Copy</${Button}></div><div class="selectable panel pad" style="white-space:pre-wrap;font-size:var(--fs-sm)">${run.description}</div></div>` : null}
    ${(run.tags || []).length ? html`<div class="row wrap" style="gap:6px"><b style="font-size:var(--fs-sm)">Tags</b>${run.tags.map((g) => html`<span class="badge">${g}</span>`)}<${Button} size="sm" kind="ghost" onClick=${() => copy(run.tags.join(', '))}>Copy</${Button}></div>` : null}
    ${(run.hashtags || []).length ? html`<div class="row wrap" style="gap:6px"><b style="font-size:var(--fs-sm)">Hashtags</b><span class="selectable">${run.hashtags.join(' ')}</span><${Button} size="sm" kind="ghost" onClick=${() => copy(run.hashtags.join(' '))}>Copy</${Button}></div>` : null}
    <div class="row wrap" style="gap:8px"><select class="input" style="max-width:320px" value=${clipId} onChange=${(e) => setClipId(e.target.value)}><option value="">Put it on a clip…</option>${clips.map((c) => html`<option value=${c.id}>${c.title || c.id}</option>`)}</select>
      <${Button} size="sm" kind="primary" disabled=${!clipId || !t} onClick=${apply}>Use the picked title on this clip</${Button}>
      <${Button} size="sm" kind="ghost" onClick=${() => copy(`${t?.title || ''}\n\n${run.description || ''}\n\n${(run.hashtags || []).join(' ')}`)}>Copy all</${Button}></div>
  </div>`;
}

export function Seo() {
  const { data, reload } = useApi('/api/seo', ['seo']);
  const { data: clipList } = useApi('/api/clips?limit=80', ['clips']);
  const clips = clipList || [];
  const [topic, setTopic] = useState('');
  const [clipId, setClipId] = useState('');
  const [platform, setPlatform] = useState('shorts');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [run, setRun] = useState(null);
  const [check, setCheck] = useState(''); const [checked, setChecked] = useState(null);
  if (!data) return html`<div class="page"><div class="faint"><span class="spinner" /> Loading…</div></div>`;
  const go = async () => {
    setBusy(true);
    try { setRun(await api.post('/api/seo/generate', { topic, clipId: clipId || null, platform, notes, count: 8 })); reload(); } catch (e) { toast(e.message, { kind: 'error' }); }
    setBusy(false);
  };
  const shown = run || data.runs?.[0];
  return html`<div class="page">
    <div class="page-head"><div class="grow"><h1>SEO lab</h1><div class="sub">Your research and your real stats in one place, and a machine that writes titles and descriptions from both.</div></div></div>
    ${!data.ai ? html`<div class="notice gold">The title machine needs an AI: turn on the free local one or connect one in Settings → Connections. Your files and stats still load and get measured.</div>` : null}
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:12px;align-items:start">
      <div class="col" style="gap:12px">
        <div class="panel pad col" style="gap:10px"><b>Write titles and a description</b>
          <${Seg} value=${platform} onChange=${setPlatform} options=${PLATFORMS} />
          <select class="input" value=${clipId} onChange=${(e) => setClipId(e.target.value)}><option value="">For a topic (type it below)</option>${clips.map((c) => html`<option value=${c.id}>Clip: ${c.title || c.id}${c.client ? ` (${c.client})` : ''}</option>`)}</select>
          <textarea class="input" rows="3" placeholder=${clipId ? 'Anything to add about this clip (optional)' : 'What is the video about? e.g. Exploring an abandoned hospital in Connecticut, found patient files'} value=${topic} onInput=${(e) => setTopic(e.target.value)} />
          <input class="input" placeholder="Notes for this one (optional): keyword to target, angle, words to avoid" value=${notes} onInput=${(e) => setNotes(e.target.value)} />
          <${Button} kind="primary" icon="sparkle" busy=${busy} disabled=${busy || (!topic.trim() && !clipId)} onClick=${go}>${busy ? 'Writing…' : 'Write them'}</${Button}>
        </div>
        <div class="panel pad col" style="gap:8px"><b>Check a title</b>
          <div class="row" style="gap:8px"><input class="input grow" placeholder="Type a title you're thinking of" value=${check} onInput=${(e) => { setCheck(e.target.value); setChecked(null); }} onKeyDown=${(e) => e.key === 'Enter' && check.trim() && api.post('/api/seo/score', { title: check, platform }).then(setChecked)} />
            <${Button} size="sm" disabled=${!check.trim()} onClick=${() => api.post('/api/seo/score', { title: check, platform }).then(setChecked)}>Score</${Button}></div>
          ${checked ? html`<div class="row" style="gap:8px;font-size:var(--fs-sm)"><span class=${'badge ' + tone(checked.score)}>${checked.score}</span><span class="faint">${check.length} characters · ${checked.why.join(' · ') || 'nothing stands out'}</span></div>` : null}
        </div>
        <${Patterns} p=${data.patterns} stats=${data.stats} />
      </div>
      <div class="col" style="gap:12px">
        ${shown ? html`<${Result} key=${shown.id} run=${shown} clips=${clips} />` : null}
        <${Library} data=${data} reload=${reload} />
        ${(data.runs || []).length > 1 ? html`<div class="panel pad col" style="gap:6px"><b>Earlier</b>${data.runs.slice(0, 10).map((x) => html`<div class="row" style="gap:8px;font-size:var(--fs-sm)"><a class="grow" style="cursor:pointer" onClick=${() => setRun(x)}>${x.titles?.[0]?.title || x.topic}</a><span class="faint" style="font-size:var(--fs-xs)">${new Date(x.createdAt).toLocaleDateString()}</span></div>`)}</div>` : null}
      </div>
    </div>
  </div>`;
}
