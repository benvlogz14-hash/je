/**
 * The compression engine's controls (server/video/convert.js): format, quality, size limit and picture size, used by
 * Studio's Export window and the "Compress a video" tool (SEO lab page). Any video or sound file in, any of 17 formats
 * out, or the same file squeezed under a size (20 MB for uploads by default).
 */
import { html, useState, useEffect, useApi, useEvent, Button, Seg, Field, Progress, act, toast } from '../lib/ui.js';
import { api } from '../lib/api.js';
import { Icon } from '../lib/icons.js';

const SIZES = [{ value: 0, label: 'No limit' }, { value: 20, label: 'Under 20 MB' }, { value: 50, label: 'Under 50 MB' }, { value: 100, label: 'Under 100 MB' }, { value: -1, label: 'Other…' }];
const HEIGHTS = [{ value: 0, label: 'Original size' }, { value: 1080, label: '1080p' }, { value: 720, label: '720p' }, { value: 480, label: '480p' }];

/** Format + quality + size + picture size. value = { format, quality, targetMB, height }. */
export function FormatFields({ value: v, onChange, formats, compact }) {
  const list = formats || [];
  const f = list.find((x) => x.id === v.format);
  const custom = !SIZES.some((s) => s.value === v.targetMB && s.value !== -1);
  const set = (patch) => onChange({ ...v, ...patch });
  return html`<div class="col" style="gap:12px">
    <${Field} label="Format" hint=${f?.about || ''} id="cv-format">
      <select id="cv-format" class="input" value=${v.format} onChange=${(e) => set({ format: e.target.value })}>
        <optgroup label="Video">${list.filter((x) => x.kind !== 'audio').map((x) => html`<option value=${x.id}>${x.label}</option>`)}</optgroup>
        <optgroup label="Sound only">${list.filter((x) => x.kind === 'audio').map((x) => html`<option value=${x.id}>${x.label}</option>`)}</optgroup>
      </select>
    </${Field}>
    <${Field} label="Quality" id="cv-q"><${Seg} value=${v.quality} onChange=${(q) => set({ quality: q })} options=${[{ value: 'high', label: 'Best' }, { value: 'balanced', label: 'Balanced' }, { value: 'small', label: 'Smallest' }]} /></${Field}>
    <${Field} label="File size" hint=${v.targetMB ? `The picture size and bitrate are worked out so the file lands under ${v.targetMB} MB. Very long videos may need cutting first.` : 'Keeps the quality you picked, whatever size that gives.'} id="cv-size">
      <div class="row" style="gap:8px;flex-wrap:wrap">
        <select id="cv-size" class="input" style="width:auto" value=${custom ? -1 : v.targetMB} onChange=${(e) => { const n = Number(e.target.value); set({ targetMB: n === -1 ? (v.targetMB || 25) : n }); }}>${SIZES.map((s) => html`<option value=${s.value}>${s.label}</option>`)}</select>
        ${custom ? html`<input class="input" type="number" min="1" max="4000" style="width:110px" value=${v.targetMB} onInput=${(e) => set({ targetMB: Math.max(1, Number(e.target.value) || 1) })} /><span class="faint">MB</span>` : null}
      </div>
    </${Field}>
    ${f?.kind === 'audio' || compact ? null : html`<${Field} label="Picture size" id="cv-h"><select id="cv-h" class="input" style="width:auto" value=${v.height} onChange=${(e) => set({ height: Number(e.target.value) })}>${HEIGHTS.map((s) => html`<option value=${s.value}>${s.label}</option>`)}</select></${Field}>`}
  </div>`;
}

export function useFormats() { const { data } = useApi('/api/convert/formats', []); return data || []; }

/** Pick or drop any video and get it back converted / under a size. Shows progress and the finished file. */
export function CompressTool({ title = 'Compress a video', sub = 'Any video under 20 MB for uploads, or into another format: MP4, MOV, WebM, MTS, MKV, AVI, GIF, MP3 and more.' }) {
  const formats = useFormats();
  const [opt, setOpt] = useState({ format: 'mp4', quality: 'balanced', targetMB: 20, height: 0 });
  const [jobId, setJobId] = useState(null); const [job, setJob] = useState(null); const [up, setUp] = useState(null); const [over, setOver] = useState(false);
  const desktop = !!window.euclidean;
  const refresh = () => jobId && api.get(`/api/jobs/${jobId}`).then(setJob).catch(() => {});
  useEffect(() => { refresh(); }, [jobId]);
  useEvent('job', (e) => { if (jobId && (!e?.id || e.id === jobId)) refresh(); }, [jobId]);
  const start = (r) => { if (r?.id) { setJobId(r.id); setJob(r); } };
  const pick = async () => {
    if (desktop) {
      const r = await act(() => api.post('/api/system/pick', { title: 'Choose a video to compress', filters: [{ name: 'Video and sound', extensions: ['mp4', 'mov', 'm4v', 'mkv', 'webm', 'avi', 'mts', 'm2ts', 'wmv', 'flv', '3gp', 'mpg', 'mpeg', 'mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg'] }] }));
      const p = r?.paths?.[0]; if (p) start(await act(() => api.post('/api/convert', { path: p, ...opt, reveal: true })));
    } else document.getElementById('cv-file')?.click();
  };
  const send = async (file) => {
    if (!file) return;
    const p = window.euclidean?.pathForFile?.(file);
    if (p) return start(await act(() => api.post('/api/convert', { path: p, ...opt, reveal: true })));
    setUp(0);
    try { start(await api.upload('/api/convert/upload', [file], opt, (f) => setUp(f))); } catch (e) { toast(e.message, { kind: 'error' }); }
    setUp(null);
  };
  const done = job?.status === 'done' && job.result; const failed = job?.status === 'failed';
  return html`<div class="panel pad col" style="gap:12px">
    <div class="row" style="gap:10px;align-items:flex-start"><span class="chip-ico" style="flex:none"><${Icon} name="download" size=${18} /></span><div class="grow"><b>${title}</b><div class="faint" style="font-size:var(--fs-sm)">${sub}</div></div></div>
    <${FormatFields} value=${opt} onChange=${setOpt} formats=${formats} compact />
    <div class=${'dropzone' + (over ? ' over' : '')} style="border:2px dashed var(--line);border-radius:12px;padding:18px;text-align:center;cursor:pointer" onClick=${pick}
      onDragOver=${(e) => { e.preventDefault(); setOver(true); }} onDragLeave=${() => setOver(false)} onDrop=${(e) => { e.preventDefault(); setOver(false); send(e.dataTransfer.files?.[0]); }}>
      <div><b>Drop a video here</b> or click to choose one</div>
      <div class="faint" style="font-size:var(--fs-sm)">${opt.targetMB ? `It comes back under ${opt.targetMB} MB` : `It comes back as ${opt.format.toUpperCase()}`}</div>
      <input id="cv-file" type="file" accept="video/*,audio/*" style="display:none" onChange=${(e) => send(e.target.files?.[0])} />
    </div>
    ${up != null ? html`<div class="col" style="gap:4px"><span class="faint" style="font-size:var(--fs-sm)">Sending it to the PC… ${Math.round(up * 100)}%</span><${Progress} value=${up} /></div>` : null}
    ${job && !done && !failed ? html`<div class="col" style="gap:4px"><span class="faint" style="font-size:var(--fs-sm)">${job.note || 'Waiting to start'}</span><${Progress} value=${job.progress || 0} indeterminate=${!job.progress} /></div>` : null}
    ${failed ? html`<div class="hal-note" style="margin:0">${job.error || 'It stopped.'}</div>` : null}
    ${done ? html`<div class="row" style="gap:8px;flex-wrap:wrap;align-items:center"><span class="badge moss">${done.mb} MB${done.inMb ? ` (was ${done.inMb} MB)` : ''}</span><span class="faint selectable" style="font-size:var(--fs-xs);overflow-wrap:anywhere">${done.path}</span>
      <a class="btn soft sm" href=${api.url(`/api/convert/${jobId}/file`)} download>Download</a>
      ${desktop ? html`<${Button} size="sm" kind="ghost" onClick=${() => act(() => api.post('/api/system/open', { path: done.path, reveal: true }))}>Show in folder</${Button}>` : null}</div>` : null}
  </div>`;
}
