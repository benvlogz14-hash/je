// The Data tab: drop in any list, sheet, research pack, master prompt or link; Euclidean reads it into tables and
// people, and one click adds them to the leads board or the notebook. Bots read from it and save their work to it.
import { html, useState, useEffect, useRef, useApi, navigate, Button, Seg, Empty, act, toast, confirmDialog } from '../lib/ui.js';
import { api } from '../lib/api.js';
import { Icon } from '../lib/icons.js';

const KIND = { people: 'People', tables: 'Tables', table: 'Table', prompt: 'Master prompt', text: 'Text' };
const MAX = 3.5 * 1024 * 1024;

async function readFiles(list) {
  const out = [];
  for (const f of list) {
    if (f.size > MAX) { toast(`${f.name} is over 3.5 MB. Split it or save it as plain text.`, { kind: 'warn' }); continue; }
    if (/\.(pdf|docx?|xlsx?|pptx?|zip|png|jpe?g|mp4|mov)$/i.test(f.name)) { toast(`${f.name}: save it as CSV, text or Markdown first (or paste its text).`, { kind: 'warn' }); continue; }
    out.push({ name: f.name, text: await f.text() });
  }
  return out;
}

export function DataTab() {
  const { data, reload } = useApi('/api/data', ['data']);
  const list = data?.datasets || [];
  const [sel, setSel] = useState(null);
  const [adding, setAdding] = useState(false);
  const [paste, setPaste] = useState(''); const [pasteName, setPasteName] = useState(''); const [url, setUrl] = useState('');
  const [drag, setDrag] = useState(false); const fileIn = useRef(null);
  const [q, setQ] = useState(''); const [hits, setHits] = useState(null);
  const cur = list.find((d) => d.id === sel) || list[0];
  const send = async (body, ok) => { setAdding(true); try { const r = await api.post('/api/data', body); toast(ok, { kind: 'success' }); reload(); const first = r.added?.[0] || r; if (first?.id) setSel(first.id); return true; } catch (e) { toast(e.message, { kind: 'error' }); return false; } finally { setAdding(false); } };
  const addFiles = async (fl) => { const files = await readFiles([...fl]); if (files.length) await send({ files }, `Read ${files.length} file${files.length === 1 ? '' : 's'}`); };
  const doSearch = async () => { if (!q.trim()) { setHits(null); return; } try { setHits(await api.get(`/api/data/search?q=${encodeURIComponent(q)}`)); } catch (e) { toast(e.message, { kind: 'error' }); } };
  return html`<div class="page">
    <div class="page-head"><div class="grow"><h1>Data</h1><div class="sub">Every list, sheet, research pack and page you give Euclidean, read into people and tables. Add them to your leads or the notebook in one click. The bots read from here and save their work here.</div></div></div>
    <div class=${'panel pad data-drop' + (drag ? ' on' : '')} onDragOver=${(e) => { e.preventDefault(); setDrag(true); }} onDragLeave=${() => setDrag(false)} onDrop=${(e) => { e.preventDefault(); setDrag(false); addFiles(e.dataTransfer.files); }}>
      <div class="row wrap" style="gap:10px;align-items:center">
        <${Icon} name="upload" size=${20} /><div class="grow"><b>Drop files here</b> <span class="faint" style="font-size:var(--fs-sm)">CSV, TSV, Markdown, text, JSON or a saved web page (master prompts, winners lists, call sheets, research packs).</span></div>
        <input type="file" multiple ref=${fileIn} style="display:none" accept=".csv,.tsv,.md,.txt,.json,.html,.htm" onChange=${(e) => { addFiles(e.target.files); e.target.value = ''; }} />
        <${Button} kind="primary" icon="upload" busy=${adding} onClick=${() => fileIn.current.click()}>Add files</${Button}>
      </div>
      <div class="row wrap" style="gap:8px;margin-top:10px">
        <input class="input grow" style="min-width:220px" placeholder="Or paste a link to read a web page into Data" value=${url} onInput=${(e) => setUrl(e.target.value)} onKeyDown=${(e) => { if (e.key === 'Enter' && url.trim()) send({ url: url.trim() }, 'Page read into Data').then((ok) => ok && setUrl('')); }} />
        <${Button} kind="soft" icon="link" disabled=${!url.trim()} busy=${adding} onClick=${() => send({ url: url.trim() }, 'Page read into Data').then((ok) => ok && setUrl(''))}>Read the page</${Button}>
      </div>
      <details style="margin-top:8px"><summary class="faint" style="font-size:var(--fs-sm)">Or paste text (a list, a table, notes)</summary>
        <div class="col" style="gap:6px;margin-top:6px"><input class="input" placeholder="Name it (e.g. Nov 9 NJ winners)" value=${pasteName} onInput=${(e) => setPasteName(e.target.value)} />
          <textarea class="input" style="height:120px;font-family:inherit" placeholder="Paste here" value=${paste} onInput=${(e) => setPaste(e.target.value)} />
          <div><${Button} size="sm" kind="primary" disabled=${!paste.trim()} busy=${adding} onClick=${() => send({ text: paste, name: pasteName || 'Pasted text' }, 'Read into Data').then((ok) => { if (ok) { setPaste(''); setPasteName(''); } })}>Read it</${Button}></div></div></details>
    </div>
    <div class="row" style="gap:8px;margin:12px 0"><input class="input grow" placeholder="Search everything in Data (a name, an office, a word)" value=${q} onInput=${(e) => setQ(e.target.value)} onKeyDown=${(e) => { if (e.key === 'Enter') doSearch(); }} /><${Button} icon="search" onClick=${doSearch}>Search</${Button}>${hits ? html`<${Button} kind="ghost" onClick=${() => { setHits(null); setQ(''); }}>Clear</${Button}>` : null}</div>
    ${hits ? html`<div class="panel pad col" style="gap:8px;margin-bottom:12px">${hits.length ? hits.map((h) => html`<div class="data-hit"><div class="faint" style="font-size:var(--fs-xs)"><a href="#" onClick=${(e) => { e.preventDefault(); setSel(h.id); setHits(null); }}>${h.dataset}</a> · ${h.type}</div><div class="selectable" style="font-size:var(--fs-sm);white-space:pre-wrap">${h.text.slice(0, 600)}</div></div>`) : html`<div class="faint">Nothing matches.</div>`}</div>` : null}
    ${!list.length && data ? html`<${Empty} icon="layers" title="Nothing here yet">Drop a list or a master prompt above.</${Empty}>` : null}
    ${list.length ? html`<div class="data-grid">
      <div class="panel data-list" data-animate>${list.map((d) => html`<button type="button" class=${'bot-row' + (cur?.id === d.id ? ' on' : '')} onClick=${() => setSel(d.id)}>
        <${Icon} name=${d.kind === 'prompt' ? 'robot' : d.kind === 'people' ? 'user' : 'layers'} size=${18} />
        <div class="grow" style="min-width:0;text-align:left"><b class="ellipsis" style="display:block">${d.name}</b><div class="faint ellipsis" style="font-size:var(--fs-xs)">${KIND[d.kind] || d.kind} · ${d.counts?.people ? `${d.counts.people} people · ` : ''}${d.counts?.tables || 0} tables · ${String(d.createdAt).slice(0, 10)}${String(d.by).startsWith('bot:') ? ` · ${String(d.by).slice(4)}` : ''}</div></div>
        ${d.imported ? html`<span class="badge moss" title="Added to leads">✓</span>` : null}</button>`)}</div>
      ${cur ? html`<${Dataset} key=${cur.id} id=${cur.id} onGone=${() => { setSel(null); reload(); }} />` : null}
    </div>` : null}
  </div>`;
}

function Dataset({ id, onGone }) {
  const { data: d, reload } = useApi(`/api/data/${id}`, ['data']);
  const [tab, setTab] = useState('people');
  const [pick, setPick] = useState(null); const [open, setOpen] = useState(null);
  useEffect(() => { if (d) setTab(d.people?.length ? 'people' : d.tables?.length ? 'tables' : 'text'); }, [d?.id]);
  if (!d) return html`<div class="panel pad"><span class="spinner" /></div>`;
  const people = d.people || [];
  // Short lists start all ticked; long ones (whole winners lists, creator lists) start empty so nobody floods the board.
  const chosen = pick || new Set(people.length <= 30 ? people.filter((p) => !/lost/i.test(p.status || '')).map((p) => p.name) : []);
  const toggle = (n) => { const s = new Set(chosen); if (s.has(n)) s.delete(n); else s.add(n); setPick(s); };
  const toLeads = () => act(() => api.post(`/api/data/${id}/leads`, { only: [...chosen] }), {}).then((r) => { if (r) { toast(`${r.added} added to leads, ${r.updated} already there were filled in${r.skipped?.length ? `, ${r.skipped.length} skipped` : ''}.`, { kind: 'success' }); reload(); } });
  const tabs = [...(people.length ? [{ value: 'people', label: `People (${people.length})` }] : []), ...(d.tables?.length ? [{ value: 'tables', label: `Tables (${d.tables.length})` }] : []), ...(d.sections?.length ? [{ value: 'sections', label: `Sections (${d.sections.length})` }] : []), { value: 'text', label: 'Text' }];
  return html`<div class="panel pad col data-view" style="gap:10px;min-width:0">
    <div class="row wrap" style="gap:8px;align-items:center">
      <div class="grow" style="min-width:0"><b style="font-size:var(--fs-lg)">${d.name}</b><div class="faint" style="font-size:var(--fs-xs)">${d.source} · ${String(d.createdAt).slice(0, 16).replace('T', ' ')} · by ${d.by}${d.note ? ` · ${d.note}` : ''}${d.imported ? ` · added to leads ${String(d.imported.at).slice(0, 10)} (${d.imported.added} new, ${d.imported.updated} updated)` : ''}</div></div>
      ${people.length ? html`<${Button} kind="primary" icon="plus" disabled=${!chosen.size} title=${chosen.size ? '' : 'Tick the people to add'} onClick=${toLeads}>${chosen.size ? `Add ${chosen.size} to leads` : 'Tick people to add to leads'}</${Button}>` : null}
      ${people.length ? html`<${Button} kind="soft" icon="film" disabled=${!chosen.size} title="Adds them to leads, finds their videos on Google and makes the ads, one-pager and email drafts" onClick=${async () => { if (chosen.size > 8 && !(await confirmDialog({ title: `Make ads for ${chosen.size} people?`, text: 'Each one finds their videos, downloads them and renders the ads in the background (several minutes each).', confirm: 'Make them' }))) return; act(() => api.post(`/api/data/${id}/ads`, { only: [...chosen] }), {}).then((r) => { if (r) { toast(`Making ads for ${r.started.length}${r.skipped.length ? `; skipped ${r.skipped.join(', ')}` : ''}. Follow them on Politics.`, { kind: 'success', ms: 7000 }); reload(); } }); }}>Make ads for ${chosen.size || 'ticked'}</${Button}>` : null}
      <${Button} kind="soft" icon="book" onClick=${() => act(() => api.post(`/api/data/${id}/notebook`, {}), {}).then((r) => r && toast(`${r.notes} notes added to the notebook`, { kind: 'success' }))}>Add to notebook</${Button}>
      ${d.kind === 'prompt' ? html`<${Button} kind="soft" icon="robot" onClick=${() => navigate(`/bots?fromData=${id}`)}>Make a bot from it</${Button}>` : null}
      <a class="btn ghost sm" href=${api.url(`/api/data/${id}/csv`)} download><${Icon} name="download" size=${15} />CSV</a>
      <${Button} size="sm" kind="ghost" icon="trash" title="Remove from Data" onClick=${async () => { if (await confirmDialog({ title: `Remove ${d.name}?`, text: 'Only the list in the Data tab is removed. Leads and notes made from it stay.', confirm: 'Remove' })) act(() => api.del(`/api/data/${id}`)).then(onGone); }} />
    </div>
    <${Seg} value=${tab} onChange=${setTab} options=${tabs} />
    ${tab === 'people' ? html`<div class="data-table-wrap"><table class="data-table"><thead><tr><th><input type="checkbox" checked=${chosen.size === people.length} onChange=${(e) => setPick(new Set(e.target.checked ? people.map((p) => p.name) : []))} /></th><th>Name</th><th>Office</th><th>Status</th><th>Email</th><th>Phones</th><th>Why / hook</th><th></th></tr></thead>
      <tbody>${people.map((p) => html`<tr class=${open === p.name ? 'on' : ''}>
        <td><input type="checkbox" checked=${chosen.has(p.name)} onChange=${() => toggle(p.name)} /></td>
        <td><b>${p.name}</b>${p.tier ? html` <span class="badge">Tier ${p.tier}</span>` : null}${p.videoPick ? html` <span class="badge gold">Video pick</span>` : null}</td>
        <td>${p.office}</td><td>${p.status}</td><td class="selectable">${p.email}</td><td class="selectable" style="max-width:220px">${p.phones}</td>
        <td style="max-width:320px">${p.why || p.hook || p.result}</td>
        <td>${p.emailDraft || p.voicemail || p.pickup || p.brief ? html`<${Button} size="sm" kind="ghost" onClick=${() => setOpen(open === p.name ? null : p.name)}>${open === p.name ? 'Hide' : 'Drafts'}</${Button}>` : null}</td></tr>
        ${open === p.name ? html`<tr><td colspan="8"><div class="col" style="gap:8px">${[['Email', p.subject ? `Subject: ${p.subject}\n\n${p.emailDraft}` : p.emailDraft], ['Voicemail', p.voicemail], ['Pickup script', p.pickup], ['Follow-up with the video', p.followup], ['Video brief', p.brief]].filter(([, v]) => v).map(([k, v]) => html`<div><div class="row" style="gap:6px"><b>${k}</b><${Button} size="sm" kind="ghost" icon="paperclip" onClick=${() => navigator.clipboard.writeText(v).then(() => toast('Copied'))}>Copy</${Button}></div><pre class="bot-result selectable">${v}</pre></div>`)}</div></td></tr>` : null}`)}</tbody></table></div>` : null}
    ${tab === 'tables' ? (d.tables || []).map((tb) => html`<details class="data-tbl" open=${(d.tables || []).length < 3}><summary><b>${tb.title || 'Table'}</b> <span class="faint">${tb.rows.length} rows</span></summary><div class="data-table-wrap"><table class="data-table"><thead><tr>${tb.columns.map((c) => html`<th>${c}</th>`)}</tr></thead><tbody>${tb.rows.slice(0, 300).map((r) => html`<tr>${tb.columns.map((c) => html`<td class="selectable">${r[c]}</td>`)}</tr>`)}</tbody></table></div></details>`) : null}
    ${tab === 'sections' ? (d.sections || []).map((s) => html`<details class="data-tbl"><summary><b>${s.title}</b> <span class="faint">${Math.round(s.text.length / 100) / 10}k characters</span></summary><pre class="bot-result selectable" style="max-height:420px">${s.text}</pre></details>`) : null}
    ${tab === 'text' ? html`<pre class="bot-result selectable" style="max-height:60vh">${d.preview}${d.textLength > 20000 ? '\n\n…(first 20,000 characters)' : ''}</pre>` : null}
  </div>`;
}
