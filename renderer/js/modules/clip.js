// Clip detail: player, versions, QC, copy, timing and every action a clip supports.
import { html, useState, useEffect, useApi, Button, HoldButton, Seg, Toggle, Field, StatusBadge, act, navigate, Drawer, toast } from '../lib/ui.js';
import { api } from '../lib/api.js';
import { Icon } from '../lib/icons.js';
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
      ${clip.versions?.length > 1 ? html`<div class="row wrap"><span class="faint" style="font-size:var(--fs-sm)">Version</span>${clip.versions.map((x) => html`<button class=${'chip' + (x.n === v ? ' on' : '')} onClick=${() => setV(x.n)}>v${x.n}${x.n === clip.currentVersion ? ' · current' : ''}</button>`)}</div>` : null}
      ${version ? html`<div class="row wrap" style="gap:6px">
        <${Button} size="sm" kind="ghost" icon="download" onClick=${() => openFile(clip, v, 'mp4')}>MP4</${Button}>
        ${version.srt ? html`<${Button} size="sm" kind="ghost" icon="download" onClick=${() => openFile(clip, v, 'srt')}>SRT</${Button}>` : null}
        ${version.velo ? html`<${Button} size="sm" kind="ghost" icon="download" onClick=${() => openFile(clip, v, 'velo')}>.velo</${Button}>` : null}
        ${version.xml ? html`<${Button} size="sm" kind="ghost" icon="download" onClick=${() => openFile(clip, v, 'xml')}>Premiere XML</${Button}>` : null}</div>` : null}
    </div>
    <div class="col" style="gap:16px;min-width:0">
      <div class="row wrap"><${StatusBadge} status=${clip.status} />${clip.score != null ? html`<span class="badge outline">Score ${clip.score}</span>` : null}
        <span class=${'badge ' + (clip.method === 'ai' ? 'lav' : '')}>${clip.method === 'ai' ? `Found by ${providerLabel(clip.agent)}` : 'Heuristic pick (no AI connected)'}</span>
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
