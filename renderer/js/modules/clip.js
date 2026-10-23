// Clip detail: player, versions, QC, copy, timing and every action a clip supports.
import { html, useState, useEffect, useRef, useApi, Button, HoldButton, Seg, Toggle, Field, StatusBadge, act, navigate, Drawer, toast } from '../lib/ui.js';
import { api } from '../lib/api.js';
import { Icon } from '../lib/icons.js';
import { FONT_GROUPS, weightOf } from '../lib/fonts.js';
import { dateTime, dur, providerLabel, actorName } from '../lib/format.js';

export function ClipPlayer({ clip, version }) {
  const v = version || clip.currentVersion;
  if (!v) return html`<div class="phone" style="display:grid;place-items:center;color:#8a929b"><div class="col" style="align-items:center"><span class="spinner" /><span style="font-size:12px">${clip.status === 'rendering' ? `Rendering… ${clip.renderProgress ? `${clip.renderProgress}%` : 'waiting its turn'}` : clip.status === 'failed' ? `Couldn't render: ${clip.error || 'see the job list'}` : 'Not rendered yet'}</span></div></div>`;
  return html`<div class="phone"><video key=${clip.id + ':' + v} src=${api.url(`/api/clips/${clip.id}/video?v=${v}`)} poster=${api.url(`/api/clips/${clip.id}/thumb?v=${v}`)} controls playsinline preload="metadata" /></div>`;
}

export function ClipDrawer({ id, onClose }) {
  const { data: clip, reload } = useApi(`/api/clips/${id}`, ['clips', 'job']);
  return html`<${Drawer} wide title=${clip ? html`<span class="faint">#${clip.ref}</span> ${clip.title}` : 'Clip'} sub=${clip ? `${clip.client} · from ${clip.asset}` : ''} onClose=${onClose}>
    ${clip ? html`<${ClipDetail} clip=${clip} reload=${reload} />` : html`<div class="spinner" />`}</${Drawer}>`;
}

export function ClipDetail({ clip, reload, compact }) {
  const [v, setV] = useState(clip.currentVersion);
  useEffect(() => setV(clip.currentVersion), [clip.currentVersion]);
  const [f, setF] = useState(pick(clip));
  useEffect(() => setF(pick(clip)), [clip.id, clip.updatedAt]);
  const [feedback, setFeedback] = useState('');
  const dirty = JSON.stringify(f) !== JSON.stringify(pick(clip));
  const version = clip.versions?.[v - 1];
  const decide = (decision, note) => act(() => api.post(`/api/clips/${clip.id}/decide`, { decision, note }), { ok: decision === 'approve' ? 'Approved' : decision === 'reject' ? 'Rejected' : 'Sent back for changes', sound: decision === 'approve' ? 'success' : 'tap' }).then(reload);
  const save = (rerender) => act(async () => { await api.patch(`/api/clips/${clip.id}`, { ...f, hashtags: f.hashtags.split(/[\s,]+/).filter(Boolean).map((x) => x.replace(/^#/, '')), start: Number(f.start), end: Number(f.end), focusX: Number(f.focusX) }); if (rerender) await api.post(`/api/clips/${clip.id}/render`); }, { ok: rerender ? 'Saved; re-rendering' : 'Saved' }).then(reload);
  const reviewable = ['review', 'client_review'].includes(clip.status);
  return html`<div style=${{ display: 'grid', gridTemplateColumns: compact ? '1fr' : 'minmax(260px, 340px) minmax(0, 1fr)', gap: '22px' }}>
    <div class="col" style="gap:12px">
      <div style="height:min(600px, 64vh)"><${ClipPlayer} clip=${clip} version=${v} /></div>
      ${clip.versions?.length > 1 ? html`<div class="row wrap"><span class="faint" style="font-size:var(--fs-sm)">Version</span>${clip.versions.map((x) => html`<button class=${'chip' + (x.n === v ? ' on' : '')} onClick=${() => setV(x.n)} title=${x.renderedAt || ''}>v${x.n}${x.look?.font ? ` · ${x.look.font}` : ''}${x.n === clip.currentVersion ? ' · current' : ''}</button>`)}${v !== clip.currentVersion ? html`<${Button} size="sm" kind="soft" onClick=${() => act(() => api.post(`/api/clips/${clip.id}/version`, { n: v }), { ok: `v${v} is now the current version` }).then(reload)}>Use v${v}</${Button}>` : null}</div>` : null}
      ${version ? html`<div class="row wrap" style="gap:6px">
        <${Button} size="sm" kind="ghost" icon="download" onClick=${() => openFile(clip, v, 'mp4')}>MP4</${Button}>
        ${version.srt ? html`<${Button} size="sm" kind="ghost" icon="download" onClick=${() => openFile(clip, v, 'srt')}>SRT</${Button}>` : null}
        ${version.velo ? html`<${Button} size="sm" kind="ghost" icon="download" onClick=${() => openFile(clip, v, 'velo')}>.velo</${Button}>` : null}
        ${version.xml ? html`<${Button} size="sm" kind="ghost" icon="download" onClick=${() => openFile(clip, v, 'xml')}>Premiere XML</${Button}>` : null}</div>` : null}
    </div>
    <div class="col" style="gap:16px;min-width:0">
      <div class="row wrap"><${StatusBadge} status=${clip.status} />${clip.score != null ? html`<span class="badge outline">Score ${clip.score}</span>` : null}
        <span class=${'badge ' + (clip.method === 'ai' ? 'lav' : '')}>${clip.method === 'ai' ? `Found by ${providerLabel(clip.agent)}` : clip.method === 'scored' ? 'Picked by the footage scores (no AI connected)' : 'Basic pick (no transcript or AI yet)'}</span>
        ${version ? html`<span class="badge outline tnum">${dur(version.duration)} · ${version.encoder}</span>` : null}${version && !version.captioned ? html`<span class="badge gold">No captions (no transcript)</span>` : null}${clip.faceTrack ? html`<span class="badge sky">Face tracked · ${Math.round(clip.faceTrack.coverage * 100)}% of frames</span>` : null}</div>
      ${clip.reason ? html`<p class="muted" style="font-size:var(--fs-sm)">${clip.reason}</p>` : null}
      ${version?.qc ? html`<div class="panel" style="padding:10px 12px"><div class="row" style="margin-bottom:${version.qc.issues.length ? '6px' : 0}"><span class=${'led ' + (version.qc.passed ? 'ok' : 'err')} /><b>${version.qc.passed ? 'Technical QC passed' : 'Technical QC failed'}</b></div>
        ${version.qc.issues.map((i) => html`<div class="qc-item"><${Icon} name=${i.level === 'error' ? 'alert' : 'info'} size=${14} style=${{ color: i.level === 'error' ? 'var(--coral)' : 'var(--gold)' }} />${i.text}</div>`)}</div>` : null}
      ${reviewable ? html`<div class="panel pad col" style="gap:10px;background:var(--surface-2)">
        <div class="row wrap"><${Button} kind="moss" icon="check" onClick=${() => decide('approve')}>${clip.status === 'client_review' ? 'Approve for client' : 'Approve'}</${Button}><${Button} kind="ghost" icon="x" onClick=${() => decide('reject')}>Reject</${Button}><div class="spacer" /><span class="kbd-hints"><span><kbd>A</kbd> approve</span><span><kbd>R</kbd> changes</span></span></div>
        <div class="row"><input class="input" id="clip-feedback" placeholder='Request changes in plain words, e.g. "start at the joke, smaller captions"' value=${feedback} onInput=${(e) => setFeedback(e.target.value)} onKeyDown=${(e) => { if (e.key === 'Enter' && feedback.trim()) { decide('changes', feedback); setFeedback(''); } }} />
          <${Button} kind="gold" icon="wand" disabled=${!feedback.trim()} onClick=${() => { decide('changes', feedback); setFeedback(''); }}>Revise</${Button}></div>
        <div class="faint" style="font-size:var(--fs-xs)">The analysis agent turns feedback into an edit, re-renders, and saves lasting preferences to the client's memory.</div></div>` : null}
      ${clip.status === 'approved' ? html`<div class="row"><${Button} kind="soft" icon="calendar" onClick=${() => act(() => api.post('/api/command', { text: `/publish ${clip.ref}` }), { ok: 'Scheduled' }).then(reload)}>Schedule in next slot</${Button}></div>` : null}
      ${clip.post ? html`<div class="notice teal"><${Icon} name="calendar" size=${16} /><div>${clip.post.status === 'published' ? `Published ${dateTime(clip.post.publishedAt)} via ${clip.post.mode}` : `Scheduled for ${dateTime(clip.post.scheduledAt)}`} on ${clip.post.platforms.join(', ')}${clip.post.note ? html`<div class="faint">${clip.post.note}</div>` : null}</div></div>` : null}

      ${(clip.trials || []).length ? html`<div class="panel pad col" style="gap:8px"><div class="row"><b class="grow">Trial openings</b><span class="faint" style="font-size:var(--fs-xs)">Different first 2 seconds to test as Instagram trial reels</span></div>
        ${clip.trials.map((t, i) => html`<div class="row" style="gap:10px"><div class="grow"><b>${t.name}</b> <span class="muted">"${t.hook}"</span><div class="faint" style="font-size:var(--fs-xs)">${t.test}</div></div><${Button} size="sm" kind="lav" icon="film" onClick=${() => act(() => api.post(`/api/clips/${clip.id}/trial`, { i }), { ok: 'Rendering this opening as a new version' }).then(reload)}>Try this opening</${Button}></div>`)}</div>` : null}
      <div class="form-grid" style="grid-template-columns:1fr">
        <${Field} label="Title" id="cl-title"><input id="cl-title" class="input" value=${f.title} onInput=${(e) => setF({ ...f, title: e.target.value })} /></${Field}>
        <${Field} label="Hook (on screen for the first 3 seconds)" id="cl-hook"><input id="cl-hook" class="input" value=${f.hook} onInput=${(e) => setF({ ...f, hook: e.target.value })} /></${Field}>
        <${Field} label="Caption" id="cl-cap"><textarea id="cl-cap" class="textarea" rows="3" value=${f.caption} onInput=${(e) => setF({ ...f, caption: e.target.value })} /></${Field}>
        <${Field} label="Hashtags" id="cl-tags"><input id="cl-tags" class="input" value=${f.hashtags} onInput=${(e) => setF({ ...f, hashtags: e.target.value })} placeholder="localnews politics" /></${Field}>
      </div>
      <div class="form-grid">
        <${Field} label="Start (s)" id="cl-start"><input id="cl-start" class="input tnum" type="number" step="0.1" value=${f.start} onInput=${(e) => setF({ ...f, start: e.target.value })} /></${Field}>
        <${Field} label="End (s)" id="cl-end"><input id="cl-end" class="input tnum" type="number" step="0.1" value=${f.end} onInput=${(e) => setF({ ...f, end: e.target.value })} /></${Field}>
      </div>
      <div class="row wrap" style="gap:14px">
        <div class="col" style="gap:5px"><span class="label">Reframe</span><${Seg} value=${f.reframe} onChange=${(x) => setF({ ...f, reframe: x })} options=${[{ value: 'face', label: 'Track face' }, { value: 'smart-blur', label: 'Blur fill' }, { value: 'crop', label: 'Crop' }, { value: 'fit', label: 'Fit' }]} /></div>
        <div class="col grow" style="gap:5px;min-width:160px"><span class="label">${f.reframe === 'face' ? 'Focus when no face is found' : 'Horizontal focus'}</span><input class="range" type="range" min="0" max="1" step="0.01" value=${f.focusX} onInput=${(e) => setF({ ...f, focusX: e.target.value })} aria-label="Horizontal focus" /></div>
        <div class="col" style="gap:5px"><span class="label">Jump cuts</span><div class="row"><${Toggle} on=${f.silenceCut} onChange=${(x) => setF({ ...f, silenceCut: x })} label="Remove pauses" /><span class="muted" style="font-size:var(--fs-sm)">Remove pauses</span></div></div>
      </div>
      <${CaptionStyle} clip=${clip} reload=${reload} />
      <${CaptionWords} clip=${clip} reload=${reload} />
      <${ClipMusic} clip=${clip} reload=${reload} />
      <div class="row wrap">
        <${Button} kind="primary" icon="refresh" disabled=${!dirty} onClick=${() => save(true)}>Save and re-render</${Button}>
        <${Button} kind="ghost" disabled=${!dirty} onClick=${() => save(false)}>Save copy only</${Button}>
        <div class="spacer" />
        <${Button} kind="slate" icon="studio" onClick=${() => act(() => api.post(`/api/clips/${clip.id}/studio`), { sound: 'open' }).then((p) => navigate(`/studio/${p.id}`))}>Open in Studio</${Button}>
        <${Button} kind="lav" icon="robot" onClick=${() => act(() => api.post(`/api/clips/${clip.id}/premiere`), { ok: 'Work order sent to Astra for Premiere' })}>Edit in Premiere</${Button}>
        ${version?.velo ? html`<${Button} kind="ghost" icon="external" onClick=${() => act(() => api.post(`/api/clips/${clip.id}/open-velo?v=${v}`), { ok: 'Opening in Velo', sound: 'open' })}>Velo</${Button}>` : null}
      </div>
      ${clip.feedback?.length || version?.changes ? html`<div class="col" style="gap:8px"><span class="eyebrow">Revision history</span>
        ${(clip.feedback || []).slice().reverse().map((fb) => html`<div class="panel" style="padding:9px 12px;font-size:var(--fs-sm)"><div class="row"><b>${actorName(fb.from)}</b><span class="badge outline">${fb.stage === 'client' ? 'Client' : 'Internal'}</span><span class="faint grow" style="text-align:right">${dateTime(fb.at)}</span></div><div style="margin-top:4px;white-space:pre-wrap" class="selectable">${fb.text}</div></div>`)}
        ${clip.versions.filter((x) => x.changes?.applied).slice().reverse().map((x) => html`<div class="faint" style="font-size:var(--fs-xs)">v${x.n} applied: ${Object.keys(x.changes.applied).join(', ') || 'style only'}${x.changes.remembered?.length ? ` · remembered: ${x.changes.remembered.join('; ')}` : ''}</div>`)}
      </div>` : null}
    </div></div>`;
}

function pick(c) { return { title: c.title || '', hook: c.hook || '', caption: c.caption || '', hashtags: (c.hashtags || []).join(' '), start: c.start, end: c.end, reframe: c.reframe || 'smart-blur', focusX: c.focusX ?? 0.5, silenceCut: c.silenceCut !== false }; }

function openFile(clip, v, kind) {
  const url = api.url(`/api/clips/${clip.id}/download/${kind}?v=${v}`);
  if (api.demo) return toast('Downloads are available in the desktop app.', { kind: 'info' });
  const a = document.createElement('a'); a.href = url; a.download = ''; document.body.appendChild(a); a.click(); a.remove();
}

/** Fix what the captions say: each line is editable; the timing is kept (or spread evenly when the word count changes). */
function CaptionWords({ clip, reload }) {
  const [open, setOpen] = useState(false); const [lines, setLines] = useState(null); const [orig, setOrig] = useState('');
  const load = () => api.get(`/api/clips/${clip.id}/lines`).then((r) => { setLines(r.lines); setOrig(JSON.stringify(r.lines)); }).catch(() => setLines([]));
  useEffect(() => { if (open) load(); }, [open, clip.id, clip.updatedAt]);
  const dirty = lines && JSON.stringify(lines) !== orig;
  const save = () => act(async () => { await api.put(`/api/clips/${clip.id}/lines`, { lines }); await api.post(`/api/clips/${clip.id}/render`); }, { ok: 'Captions fixed; re-rendering' }).then(() => { load(); reload(); });
  return html`<details class="panel pad" onToggle=${(e) => setOpen(e.target.open)}>
    <summary><b>Edit caption words</b> <span class="faint" style="font-size:var(--fs-xs)">fix any word the captions got wrong</span></summary>
    ${open ? html`<div class="col" style="gap:8px;margin-top:10px">
      ${lines == null ? html`<span class="faint">Loading…</span>` : !lines.length ? html`<span class="faint" style="font-size:var(--fs-sm)">No captions yet: this video needs a transcript first (press "Make transcript" on the video in the Footage list).</span>`
        : lines.map((l, i) => html`<div class="row" style="gap:8px;align-items:flex-start"><span class="tnum faint" style="width:52px;padding-top:7px;font-size:var(--fs-xs)">${(l.s - clip.start).toFixed(1)}s</span><textarea class="textarea grow" rows="1" style="min-height:34px" value=${l.text} onInput=${(e) => setLines(lines.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))} /></div>`)}
      ${lines?.length ? html`<div class="row" style="gap:8px"><${Button} kind="primary" icon="refresh" disabled=${!dirty} onClick=${save}>Save words and re-render</${Button}><span class="faint" style="font-size:var(--fs-xs)">Fixes the transcript for this video, so other clips from it get the fix too.</span></div>` : null}
    </div>` : null}
  </details>`;
}

const MOODS = [['auto', 'Auto'], ['off', 'No music'], ['creepy', 'Creepy'], ['suspense', 'Suspense'], ['intense', 'Intense'], ['triumphant', 'Triumphant'], ['positive', 'Uplifting'], ['sad', 'Sad'], ['chill', 'Chill'], ['funny', 'Funny']];
const MOOD_NAME = Object.fromEntries(MOODS);
/** Sound for this clip: voice and music levels, the music mood or a specific track from the catalog, and what the last render used. */
function ClipMusic({ clip, reload }) {
  const last = clip.versions?.[clip.versions.length - 1]; const sheet = last?.music;
  const { data: cat, reload: reloadCat } = useApi('/api/music/catalog', ['job']);
  const { data: client } = useApi(`/api/clients/${clip.clientId}`, ['clients']);
  const clientVol = client?.production?.musicVolume ?? 0.3;
  const init = () => ({ music: clip.music || 'auto', track: clip.musicTrack || 'auto', voice: Math.round((clip.voiceVol ?? 1) * 100), vol: Math.round((clip.musicVol ?? clientVol) * 100), cuts: clip.visualCuts !== false });
  const [m, setM] = useState(init);
  useEffect(() => setM(init()), [clip.id, clip.updatedAt, client?.id]);
  const [playing, setPlaying] = useState(null); const audio = useRef(null);
  const preview = (id) => { if (!audio.current) audio.current = new Audio(); if (playing === id) { audio.current.pause(); setPlaying(null); return; } audio.current.src = api.url(`/api/music/play?id=${encodeURIComponent(id)}`); audio.current.volume = 0.6; audio.current.play().catch(() => {}); setPlaying(id); };
  useEffect(() => () => audio.current?.pause(), []);
  const apply = () => act(async () => { audio.current?.pause(); setPlaying(null); await api.patch(`/api/clips/${clip.id}`, { music: m.music, musicTrack: m.track, voiceVol: m.voice / 100, musicVol: m.vol / 100, visualCuts: m.cuts }); await api.post(`/api/clips/${clip.id}/render`); }, { ok: 'Re-rendering with the new sound' }).then(reload);
  const more = () => act(() => api.post('/api/music/fill', {}), { ok: 'Downloading free music for every mood (a few minutes)' }).then(reloadCat);
  const off = m.music === 'off';
  const dirty = JSON.stringify(m) !== JSON.stringify(init());
  return html`<details class="panel pad" open=${dirty}>
    <summary><b>Sound and music</b> <span class="faint" style="font-size:var(--fs-xs)">${off ? 'no music' : m.track !== 'auto' ? 'chosen track' : sheet?.cues?.length ? sheet.cues.map((c) => MOOD_NAME[c.mood] || c.mood).filter((x, i, a) => a.indexOf(x) === i).join(', ') : 'picked to fit each moment'} · voice ${m.voice}% · music ${off ? 'off' : `${m.vol}%`}</span></summary>
    <div class="col" style="gap:12px;margin-top:10px">
      <div class="form-grid">
        <${Field} label=${`Voice volume: ${m.voice}%`} id="cm-voice"><input id="cm-voice" class="range" type="range" min="0" max="200" step="5" value=${m.voice} onInput=${(e) => setM({ ...m, voice: Number(e.target.value) })} /></${Field}>
        <${Field} label=${off ? 'Music volume: off' : `Music volume: ${m.vol}%`} id="cm-vol"><input id="cm-vol" class="range" type="range" min="0" max="100" step="1" value=${m.vol} disabled=${off} onInput=${(e) => setM({ ...m, vol: Number(e.target.value) })} /></${Field}>
      </div>
      <div class="col" style="gap:4px"><span class="label">Mood</span><div class="row wrap" style="gap:6px">${MOODS.map(([k, l]) => html`<button class="chip" style=${m.music === k && (k === 'off' || m.track === 'auto') ? { background: 'var(--accent-soft)', borderColor: 'var(--accent)' } : null} onClick=${() => setM({ ...m, music: k, track: 'auto' })}>${l}</button>`)}</div></div>
      ${!off ? html`<div class="col" style="gap:4px"><span class="label">Track</span>
        <div class="row" style="gap:6px"><select class="select grow" value=${m.track} onChange=${(e) => setM({ ...m, track: e.target.value, music: e.target.value === 'auto' ? m.music : 'auto' })} aria-label="Music track">
          <option value="auto">Automatic: Euclidean picks a track for each moment</option>
          ${(cat?.moods || []).map((g) => html`<optgroup label=${g.label}>${g.tracks.map((t) => html`<option value=${t.id}>${t.title} · ${t.license}</option>`)}</optgroup>`)}
        </select>${m.track !== 'auto' ? html`<${Button} size="sm" kind="ghost" icon=${playing === m.track ? 'pause' : 'play'} onClick=${() => preview(m.track)}>${playing === m.track ? 'Stop' : 'Listen'}</${Button}>` : null}</div>
        <div class="row wrap" style="gap:8px"><span class="faint grow" style="font-size:var(--fs-xs);min-width:220px">${(cat?.moods || []).reduce((n, g) => n + g.tracks.length, 0)} tracks, all royalty-free. To add your own, set a music folder in Politics → Package settings and put tracks in subfolders named by mood (creepy, suspense, triumphant...).</span><${Button} size="sm" kind="ghost" icon="download" onClick=${more}>Get more free music</${Button}></div></div>` : null}
      <label class="row" style="gap:8px"><${Toggle} on=${m.cuts} onChange=${(x) => setM({ ...m, cuts: x })} label="Visual cuts" /><span style="font-size:var(--fs-sm)">Visual cuts: cut to the best shots (drone first) while the voice keeps going${last?.cuts ? ` · last render used ${last.cuts}` : ''}</span></label>
      ${sheet?.cues?.length && m.track === 'auto' && !off ? html`<div class="col" style="gap:4px">${sheet.cues.map((c) => html`<div class="row" style="gap:8px;font-size:var(--fs-sm)"><span class="tnum faint" style="width:86px">${c.start.toFixed(1)}s to ${c.end.toFixed(1)}s</span><span class="badge ${c.mood === 'none' ? 'outline' : 'lav'}">${c.mood === 'none' ? 'Silence' : MOOD_NAME[c.mood] || c.mood}</span><span class="faint ellipsis" style="font-size:var(--fs-xs)">${c.why || c.source || ''}</span></div>`)}
        <div class="faint" style="font-size:var(--fs-xs)">Last render: music chosen by ${sheet.how}.</div></div>` : null}
      <div class="row"><${Button} kind="primary" icon="refresh" disabled=${!dirty} onClick=${apply}>Apply and re-render</${Button}></div>
    </div></details>`;
}

const STYLE_DEFAULTS = { font: 'Montserrat', size: 84, uppercase: true, wordsPerLine: 3, primary: '#FFFFFF', highlight: '#F2C14E', outline: '#111111', outlineWidth: 7, shadow: 0, position: 'lower', animation: 'pop', highlightMode: 'word', box: false, hook: true, hookSeconds: 3.2, hookBg: '#FFFFFF', hookColor: '#111111', hookFont: '', hookSize: 0, hookPosition: 'upper', hookBox: true, hookOutline: '#111111', hookOutlineWidth: 8, hookTilt: 0, hookAnim: 'fade', rotate: 0 };
// One-click looks; every value can still be changed below.
const LOOKS = [
  { id: 'cartoon', label: 'Cartoon', v: { font: 'Luckiest Guy', size: 96, uppercase: true, primary: '#FFFFFF', highlight: '#FFD23F', outline: '#000000', outlineWidth: 9, shadow: 5, wordsPerLine: 2, box: false, hookFont: 'Luckiest Guy', hookSize: 84, hookBox: false, hookColor: '#FFFFFF', hookOutline: '#000000', hookOutlineWidth: 9, hookTilt: -4, hookAnim: 'pop' } },
  { id: 'comic', label: 'Comic', v: { font: 'Bangers', size: 104, uppercase: true, primary: '#FFFFFF', highlight: '#FF4D6D', outline: '#000000', outlineWidth: 8, shadow: 4, wordsPerLine: 3, box: false, hookFont: 'Bangers', hookSize: 88, hookBox: true, hookBg: '#FFD23F', hookColor: '#000000', hookTilt: -3, hookAnim: 'pop' } },
  { id: 'bubbly', label: 'Bubbly', v: { font: 'Titan One', size: 88, uppercase: false, primary: '#FFFFFF', highlight: '#5CE1E6', outline: '#1B1B3A', outlineWidth: 10, shadow: 4, wordsPerLine: 2, box: false, hookFont: 'Titan One', hookSize: 76, hookBox: true, hookBg: '#FF8FB1', hookColor: '#FFFFFF', hookTilt: 0, hookAnim: 'pop' } },
  { id: 'beast', label: 'Big & loud', v: { font: 'Bowlby One', size: 92, uppercase: true, primary: '#FFFFFF', highlight: '#7CFC00', outline: '#000000', outlineWidth: 10, shadow: 6, wordsPerLine: 2, box: false, hookFont: 'Bowlby One', hookSize: 80, hookBox: false, hookColor: '#FFD23F', hookOutline: '#000000', hookOutlineWidth: 10, hookTilt: -5, hookAnim: 'pop' } },
  { id: 'clean', label: 'Clean', v: { font: 'Montserrat', size: 84, uppercase: true, primary: '#FFFFFF', highlight: '#F2C14E', outline: '#111111', outlineWidth: 7, shadow: 0, wordsPerLine: 3, box: false, hookFont: '', hookSize: 0, hookBox: true, hookBg: '#FFFFFF', hookColor: '#111111', hookTilt: 0, hookAnim: 'fade' } },
];
const POS = [{ value: 'upper', label: 'Top' }, { value: 'center', label: 'Middle' }, { value: 'lower', label: 'Bottom' }];
const posCss = (p, top, bottom) => (p === 'upper' ? { top } : p === 'center' ? { top: '50%', transform: 'translateY(-50%)' } : { bottom });

/** Caption look for this clip. Captions and the opening banner each have their own font, size, position and colours. */
function CaptionStyle({ clip, reload }) {
  const { data: client } = useApi(`/api/clients/${clip.clientId}`, ['clients']);
  const base = { ...STYLE_DEFAULTS, ...(client?.style || {}) };
  const [s, setS] = useState({ ...base, ...(clip.style || {}) });
  useEffect(() => setS({ ...base, ...(clip.style || {}) }), [client?.id, clip.id, clip.updatedAt]);
  const set = (k) => (e) => setS({ ...s, [k]: e?.target ? (e.target.type === 'range' || e.target.type === 'number' ? Number(e.target.value) : e.target.value) : e });
  const [hookText, setHookText] = useState(clip.hook || '');
  useEffect(() => setHookText(clip.hook || ''), [clip.id, clip.updatedAt]);
  const saveHook = async () => { if (hookText !== (clip.hook || '')) await api.patch(`/api/clips/${clip.id}`, { hook: hookText }); };
  const thisClip = () => act(async () => { await saveHook(); await api.patch(`/api/clips/${clip.id}`, { style: s }); await api.post(`/api/clips/${clip.id}/render`); }, { ok: 'Saved; re-rendering with the new captions' }).then(reload);
  const allClips = () => act(async () => { await saveHook(); await api.patch(`/api/clients/${clip.clientId}`, { style: s }); await api.patch(`/api/clips/${clip.id}`, { style: null }); await api.post(`/api/clips/${clip.id}/render`); }, { ok: `Saved for every ${client?.name || 'client'} clip; re-rendering this one` }).then(reload);
  const reset = () => act(async () => { await api.patch(`/api/clips/${clip.id}`, { style: null }); }, { ok: 'Back to the client style' }).then(reload);
  const words = ['THIS', 'IS', 'HOW'].slice(0, Math.max(1, Math.min(3, s.wordsPerLine)));
  const txt = (w) => (s.uppercase ? w : w.toLowerCase());
  const hookFont = s.hookFont || s.font; const hookSize = s.hookSize || Math.round(s.size * 0.72);
  const stroke = (w, c) => (w ? `${Math.max(0.5, w / 6)}px ${c}` : '0');
  const shadow = (n) => (n ? `${n / 3}px ${n / 3}px 0 rgba(0,0,0,.55)` : 'none');
  const colours = (list) => html`<div class="row wrap" style="gap:12px">${list.map(([k, l]) => html`<label class="col" style="gap:3px;font-size:var(--fs-xs)"><span class="faint">${l}</span><input type="color" value=${s[k]} onInput=${set(k)} style="width:44px;height:30px;border:none;background:none;padding:0" /></label>`)}</div>`;
  const fontPick = (k, id, same) => html`<select id=${id} class="select" value=${s[k]} onChange=${set(k)} style=${{ fontFamily: `'${s[k] || s.font}', sans-serif`, fontSize: '15px' }}>${same ? html`<option value="">Same as captions</option>` : null}${FONT_GROUPS.map(([g, list]) => html`<optgroup label=${g}>${list.map((f) => html`<option value=${f} style=${{ fontFamily: `'${f}', sans-serif`, fontSize: '16px' }}>${f}</option>`)}</optgroup>`)}</select>`;
  const flag = (on, onChange, l) => html`<label class="row" style="gap:6px"><${Toggle} on=${on} onChange=${onChange} label=${l} /><span style="font-size:var(--fs-sm)">${l}</span></label>`;
  const look = LOOKS.find((x) => Object.entries(x.v).every(([k, v]) => s[k] === v))?.id;
  return html`<details class="panel pad" open=${!clip.versions?.[clip.versions.length - 1]?.captioned}>
    <summary><b>Captions and text</b> <span class="faint" style="font-size:var(--fs-xs)">${clip.style ? 'custom for this clip' : `using ${client?.name || 'the client'}'s style`}</span></summary>
    <div class="row wrap" style="gap:16px;margin-top:10px;align-items:flex-start">
      <div style=${{ width: '150px', height: '266px', borderRadius: '14px', background: 'linear-gradient(160deg,#5b6b7c,#2b3440)', position: 'relative', overflow: 'hidden', flex: 'none' }}>
        ${s.hook && s.hookSeconds > 0 ? html`<div style=${{ position: 'absolute', left: '8px', right: '8px', textAlign: 'center', ...posCss(s.hookPosition, '22px', '60px') }}><span style=${{ display: 'inline-block', transform: `rotate(${s.hookTilt || 0}deg)`, fontFamily: `'${hookFont}', sans-serif`, fontWeight: weightOf(hookFont), fontSize: `${Math.round(hookSize / 7)}px`, lineHeight: 1.1, whiteSpace: 'pre-line', color: s.hookColor, ...(s.hookBox ? { background: s.hookBg, padding: '3px 6px', borderRadius: '4px' } : { WebkitTextStroke: stroke(s.hookOutlineWidth, s.hookOutline), paintOrder: 'stroke fill', textShadow: shadow(s.shadow) }) }}>${txt(hookText || 'OPENING TEXT')}</span></div>` : null}
        <div style=${{ position: 'absolute', left: '6px', right: '6px', textAlign: 'center', fontFamily: `'${s.font}', sans-serif`, fontWeight: weightOf(s.font), fontSize: `${Math.round(s.size / 6.5)}px`, lineHeight: 1.1, ...posCss(s.position, '60px', '50px'), ...(s.rotate ? { transform: `${posCss(s.position).transform || ''} rotate(${s.rotate}deg)` } : {}) }}>
          ${words.map((w, i) => html`<span style=${{ color: i === 1 && s.highlightMode === 'word' ? s.highlight : s.primary, WebkitTextStroke: !s.box ? stroke(s.outlineWidth, s.outline) : '0', paintOrder: 'stroke fill', textShadow: s.box ? 'none' : shadow(s.shadow), background: s.box ? s.outline : 'none', padding: s.box ? '1px 3px' : 0, marginRight: '3px', display: 'inline-block' }}>${txt(w)}</span>`)}</div>
      </div>
      <div class="col grow" style="gap:12px;min-width:260px">
        <div class="col" style="gap:4px"><span class="label">Quick looks</span><div class="row wrap" style="gap:6px">${LOOKS.map((x) => html`<button class="chip" style=${{ fontFamily: `'${x.v.font}', sans-serif`, fontSize: '15px', ...(look === x.id ? { background: 'var(--accent-soft, #dcefeb)', borderColor: 'var(--accent, #5f9a91)' } : {}) }} onClick=${() => setS({ ...s, ...x.v })}>${x.label}</button>`)}</div></div>

        <div class="col" style="gap:8px;border-top:1px solid var(--line, #eee);padding-top:10px">
          <b style="font-size:var(--fs-sm)">Captions (spoken words)</b>
          <div class="form-grid">
            <${Field} label="Font" id="cs-font">${fontPick('font', 'cs-font')}</${Field}>
            <${Field} label=${`Size: ${s.size}`} id="cs-size"><input id="cs-size" class="range" type="range" min="30" max="220" step="2" value=${s.size} onInput=${set('size')} /></${Field}>
            <${Field} label=${`Rotate: ${s.rotate || 0}°`} id="cs-rot"><input id="cs-rot" class="range" type="range" min="-30" max="30" step="1" value=${s.rotate || 0} onInput=${set('rotate')} /></${Field}>
            <${Field} label=${`Words per line: ${s.wordsPerLine}`} id="cs-wpl"><input id="cs-wpl" class="range" type="range" min="1" max="6" step="1" value=${s.wordsPerLine} onInput=${set('wordsPerLine')} /></${Field}>
            <${Field} label=${s.box ? `Box padding: ${s.outlineWidth}` : `Outline thickness: ${s.outlineWidth}`} id="cs-ow"><input id="cs-ow" class="range" type="range" min="0" max="20" step="1" value=${s.outlineWidth} onInput=${set('outlineWidth')} /></${Field}>
            <${Field} label=${`Drop shadow: ${s.shadow || 0}`} id="cs-sh"><input id="cs-sh" class="range" type="range" min="0" max="10" step="1" value=${s.shadow || 0} onInput=${set('shadow')} /></${Field}>
          </div>
          <div class="row wrap" style="gap:12px">
            <div class="col" style="gap:4px"><span class="label">Position</span><${Seg} value=${s.position} onChange=${set('position')} options=${POS} /></div>
            ${flag(!!s.box, set('box'), 'Background box')}${flag(!!s.uppercase, set('uppercase'), 'CAPITALS')}${flag(s.animation === 'pop', (x) => setS({ ...s, animation: x ? 'pop' : 'none' }), 'Pop-in')}${flag(s.highlightMode === 'word', (x) => setS({ ...s, highlightMode: x ? 'word' : 'none' }), 'Highlight spoken word')}
          </div>
          ${colours([['primary', 'Text'], ['highlight', 'Highlight'], ['outline', s.box ? 'Box colour' : 'Outline']])}
        </div>

        <div class="col" style="gap:8px;border-top:1px solid var(--line, #eee);padding-top:10px">
          <div class="row" style="gap:8px;align-items:center"><b style="font-size:var(--fs-sm)">Opening banner</b><${Toggle} on=${!!s.hook} onChange=${set('hook')} label="Opening banner" /><span class="faint" style="font-size:var(--fs-xs)">the headline at the start</span></div>
          ${s.hook ? html`<${Field} label="What it says (Enter for a new line)" id="cs-htext"><textarea id="cs-htext" class="textarea" rows="2" maxlength="120" value=${hookText} placeholder="Type the opening text" onInput=${(e) => setHookText(e.target.value)} /></${Field}>` : null}
          ${s.hook ? html`
          <div class="form-grid">
            <${Field} label=${`On screen: ${s.hookSeconds}s`} id="cs-hs"><input id="cs-hs" class="range" type="range" min="0.5" max="10" step="0.5" value=${s.hookSeconds} onInput=${set('hookSeconds')} /></${Field}>
            <${Field} label="Font" id="cs-hfont">${fontPick('hookFont', 'cs-hfont', true)}</${Field}>
            <${Field} label=${`Size: ${hookSize}`} id="cs-hsize"><input id="cs-hsize" class="range" type="range" min="30" max="220" step="2" value=${hookSize} onInput=${set('hookSize')} /></${Field}>
            <${Field} label=${`Rotate: ${s.hookTilt || 0}°`} id="cs-ht"><input id="cs-ht" class="range" type="range" min="-30" max="30" step="1" value=${s.hookTilt || 0} onInput=${set('hookTilt')} /></${Field}>
            ${!s.hookBox ? html`<${Field} label=${`Outline thickness: ${s.hookOutlineWidth}`} id="cs-how"><input id="cs-how" class="range" type="range" min="0" max="20" step="1" value=${s.hookOutlineWidth} onInput=${set('hookOutlineWidth')} /></${Field}>` : null}
          </div>
          <div class="row wrap" style="gap:12px">
            <div class="col" style="gap:4px"><span class="label">Position</span><${Seg} value=${s.hookPosition || 'upper'} onChange=${set('hookPosition')} options=${POS} /></div>
            ${flag(!!s.hookBox, set('hookBox'), 'Background box')}${flag(s.hookAnim === 'pop', (x) => setS({ ...s, hookAnim: x ? 'pop' : 'fade' }), 'Bounce in')}
          </div>
          ${s.hookBox ? colours([['hookColor', 'Text'], ['hookBg', 'Box colour']]) : colours([['hookColor', 'Text'], ['hookOutline', 'Outline']])}
          ${s.hookPosition === s.position ? html`<div class="faint" style="font-size:var(--fs-xs)">Tip: the banner and captions are in the same spot; move one so they don't overlap.</div>` : null}` : null}
        </div>

        <div class="row wrap" style="gap:6px"><${Button} kind="primary" icon="refresh" onClick=${thisClip}>Apply to this clip</${Button}><${Button} kind="soft" onClick=${allClips}>Use for all ${client?.name || 'client'} clips</${Button}>${clip.style ? html`<${Button} kind="ghost" onClick=${reset}>Reset</${Button}>` : null}</div>
        ${!clip.versions?.[clip.versions.length - 1]?.captioned ? html`<div class="faint" style="font-size:var(--fs-xs)">No captions yet because this video hasn't been turned into text. Euclidean installs the free speech-to-text tool by itself and adds captions to this clip when it's done; or press "Make transcript" on the video in the Footage list.</div>` : null}
      </div>
    </div></details>`;
}
