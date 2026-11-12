// YouTube post editor (Nov 12, Ryan: "approve a clip, click the time and schedule when, choose the description, the title
// and the thumbnail from in the program ... we don't want anything sending out to Stringer yet").
// Used from Publishing (click a post) and the clip panel (Schedule on YouTube). Saves with POST /api/clips/:id/youtube.
import { html, useState, useEffect, useRef, useApi, Button, Modal, Field, StatusBadge, act, toast } from '../lib/ui.js';
import { api } from '../lib/api.js';
import { Icon } from '../lib/icons.js';

const local = (d) => { const x = new Date(d); x.setMinutes(x.getMinutes() - x.getTimezoneOffset()); return x.toISOString().slice(0, 16); };
const tomorrowAt = (h) => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(h, 0, 0, 0); return d; };

/** The hold banner: publishing is on hold (nothing uploads) or live. Owner switches it. */
export function HoldBanner({ compact }) {
  const { data, reload } = useApi('/api/publishing/hold', ['posts', 'settings']);
  if (!data) return null;
  const flip = (on) => act(() => api.post('/api/publishing/hold', { on }), { ok: on ? 'On hold: nothing will upload' : 'Hold off' }).then((r) => { reload(); if (r && !on) toast(`${r.back} held post${r.back === 1 ? '' : 's'} back on the schedule${r.waiting ? `, ${r.waiting} past their time wait for Publish now` : ''}.`); });
  const test = data.environment !== 'production';
  if (data.hold) {
    return html`<div class="notice gold" style="align-items:center"><${Icon} name="pause" size=${16} /><div class="grow"><b>Publishing is on hold.</b> Nothing uploads to YouTube or anywhere else. Scheduled posts wait as "On hold" at their time${data.held ? ` (${data.held} waiting now)` : ''}.${compact ? '' : ' Set up titles, times and thumbnails now; switch the hold off when you\'re ready.'}</div>
      <${Button} size="sm" kind="ghost" onClick=${async () => { if (confirm(`Switch the hold off?\n\nPosts will upload at their scheduled times${test ? ' (Test mode is still on in Settings, so they only pack files on this PC)' : ' to the channels you picked'}.`)) flip(false); }}>Switch hold off</${Button}></div>`;
  }
  return html`<div class=${'notice ' + (test ? 'teal' : 'coral')} style="align-items:center"><${Icon} name=${test ? 'info' : 'alert'} size=${16} /><div class="grow"><b>Publishing is live.</b> ${test ? 'Test mode is on (Settings), so posts are packed on this PC, not uploaded.' : 'Scheduled posts upload at their times.'}</div>
    <${Button} size="sm" kind="gold" icon="pause" onClick=${() => flip(true)}>Put on hold</${Button}></div>`;
}

/** The editor. clip: the clip (from /api/clips/:id or a post's clipId); post: its post, if any. */
export function YouTubePost({ clipId, onClose }) {
  const { data: clip, reload } = useApi(`/api/clips/${clipId}`, ['posts', 'clips']);
  const { data: chans } = useApi('/api/youtube/channels', []);
  const { data: hold } = useApi('/api/publishing/hold', ['posts', 'settings']);
  const [f, setF] = useState(null);
  const [frameAt, setFrameAt] = useState(1);
  const [shown, setShown] = useState(1);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef(null);
  useEffect(() => {
    if (!clip || f) return;
    const p = clip.post; const yt = p?.yt || {};
    setF({ at: local(p?.scheduledAt || tomorrowAt(12)), channel: yt.channelClientId || clip.clientId, title: yt.title ?? clip.title ?? '', description: yt.description ?? [clip.caption, (clip.hashtags || []).map((h) => `#${String(h).replace(/^#/, '')}`).join(' ')].filter(Boolean).join('\n\n'), tags: (yt.tags || clip.hashtags || []).join(', '), privacy: yt.privacy || 'public' });
    if (yt.thumbAt != null) { setFrameAt(yt.thumbAt); setShown(yt.thumbAt); }
  }, [clip]);
  // The frame preview follows the slider, a beat after it stops.
  useEffect(() => { const t = setTimeout(() => setShown(frameAt), 220); return () => clearTimeout(t); }, [frameAt]);
  if (!clip || !f) return html`<${Modal} title="YouTube post" icon="calendar" onClose=${onClose}><div class="muted">Loading…</div></${Modal}>`;
  const post = clip.post; const dur = clip.current?.duration || 30;
  const live = post?.status === 'published' || post?.status === 'publishing';
  const save = async (extra = {}) => {
    setBusy(true);
    try { await act(() => api.post(`/api/clips/${clip.id}/youtube`, { at: new Date(f.at).toISOString(), channelClientId: f.channel, title: f.title, description: f.description, tags: f.tags, privacy: f.privacy, ...extra }), { ok: hold?.hold ? 'Saved. On hold: it waits at its time' : 'Scheduled on YouTube' }); reload(); return true; } catch { return false; } finally { setBusy(false); }
  };
  const upload = async (file) => {
    if (!file) return;
    if (!post) { if (!(await save())) return; }
    setBusy(true);
    try { await act(() => api.upload(`/api/clips/${clip.id}/youtube/thumb`, [file]), { ok: 'Thumbnail set' }); reload(); } finally { setBusy(false); }
  };
  const chan = (chans || []).find((c) => c.clientId === f.channel);
  const thumbSrc = post?.yt?.thumb ? api.url(`/api/posts/${post.id}/thumb?t=${encodeURIComponent(post.updatedAt || '')}`) : null;
  const titleLeft = 100 - f.title.length;
  return html`<${Modal} title=${`YouTube: ${clip.title}`} icon="calendar" wide onClose=${onClose} footer=${html`
    ${post && ['scheduled', 'held'].includes(post.status) ? html`<${Button} kind="ghost" icon="x" onClick=${() => act(() => api.post(`/api/posts/${post.id}/unschedule`), { ok: 'Pulled from the schedule' }).then(onClose)}>Unschedule</${Button}>` : null}
    ${post?.status === 'held' && !hold?.hold ? html`<${Button} kind="coral" icon="send" onClick=${() => { if (confirm(`Publish "${f.title}" to ${chan?.client || 'the channel'} now?`)) act(() => api.post(`/api/posts/${post.id}/publish-now`), { ok: 'Publishing now' }).then(onClose); }}>Publish now</${Button}>` : null}
    <div class="spacer" />
    <${Button} kind="primary" icon="calendar" disabled=${busy || live || !f.title.trim()} onClick=${() => save().then((ok) => ok && onClose())}>${hold?.hold ? 'Save (on hold)' : post ? 'Save' : 'Schedule'}</${Button}>`}>
    <div class="col" style="gap:12px">
      ${hold?.hold ? html`<div class="notice gold"><${Icon} name="pause" size=${16} /><div>Publishing is on hold: this will <b>not</b> upload. It waits as "On hold" at its time until the hold is switched off on the Publishing page.</div></div>` : null}
      ${post ? html`<div class="row wrap"><${StatusBadge} status=${post.status} />${post.note ? html`<span class="faint" style="font-size:var(--fs-xs)">${post.note}</span>` : null}${post.results?.youtube?.url ? html`<a href=${post.results.youtube.url} target="_blank" rel="noopener">View on YouTube <${Icon} name="external" size=${12} /></a>` : null}</div>` : null}
      ${post?.lastError ? html`<div class="notice coral"><${Icon} name="alert" size=${16} />${post.lastError}</div>` : null}
      ${post?.results?.youtube?.thumbError ? html`<div class="notice gold"><${Icon} name="info" size=${16} />The video is up, but YouTube didn't take the thumbnail: ${post.results.youtube.thumbError}</div>` : null}
      <div class="form-grid">
        <${Field} label="Channel" id="yt-chan">${(chans || []).length ? html`<select id="yt-chan" class="select" value=${f.channel} onChange=${(e) => setF({ ...f, channel: e.target.value })}>${chans.map((c) => html`<option value=${c.clientId}>${c.client} · ${c.channel}</option>`)}</select>` : html`<div class="muted" style="font-size:var(--fs-sm)">No YouTube channel is connected yet. Open the client (Clients → the client → Connect YouTube) and sign in to their channel. You can still set everything up now.</div>`}</${Field}>
        <${Field} label="Goes up at" id="yt-at"><input id="yt-at" class="input" type="datetime-local" value=${f.at} disabled=${live} onInput=${(e) => setF({ ...f, at: e.target.value })} /></${Field}>
      </div>
      <${Field} label=${`Title (${titleLeft} left)`} id="yt-title"><input id="yt-title" class="input" maxlength="100" value=${f.title} onInput=${(e) => setF({ ...f, title: e.target.value })} /></${Field}>
      <${Field} label="Description" id="yt-desc"><textarea id="yt-desc" class="textarea" rows="5" maxlength="5000" value=${f.description} onInput=${(e) => setF({ ...f, description: e.target.value })} /></${Field}>
      <div class="form-grid">
        <${Field} label="Tags (commas between)" id="yt-tags"><input id="yt-tags" class="input" value=${f.tags} onInput=${(e) => setF({ ...f, tags: e.target.value })} placeholder="abandoned, exploring" /></${Field}>
        <${Field} label="Who can see it" id="yt-priv"><select id="yt-priv" class="select" value=${f.privacy} onChange=${(e) => setF({ ...f, privacy: e.target.value })}><option value="public">Public at that time</option><option value="unlisted">Unlisted (link only)</option><option value="private">Private</option></select></${Field}>
      </div>
      <div class="panel pad col" style="gap:10px">
        <div class="row"><b class="grow">Thumbnail</b><span class="faint" style="font-size:var(--fs-xs)">YouTube may show a frame of the video on Shorts; custom thumbnails need a verified channel.</span></div>
        <div class="row wrap" style="gap:14px;align-items:flex-start">
          <div class="col" style="gap:6px;align-items:center"><span class="label">This frame</span><img src=${api.url(`/api/clips/${clip.id}/frame?at=${shown}`)} alt="Frame" style="width:150px;max-height:260px;object-fit:contain;border-radius:8px;background:#000" /></div>
          ${thumbSrc ? html`<div class="col" style="gap:6px;align-items:center"><span class="label">Picked</span><img src=${thumbSrc} alt="Thumbnail" style="width:150px;max-height:260px;object-fit:contain;border-radius:8px;background:#000;outline:2px solid var(--moss)" /></div>` : null}
          <div class="col grow" style="gap:8px;min-width:200px">
            <span class="label">Move to the frame you want (${frameAt.toFixed(1)} s)</span>
            <input class="range" type="range" min="0" max=${Math.max(0.1, dur - 0.1)} step="0.1" value=${frameAt} onInput=${(e) => setFrameAt(Number(e.target.value))} aria-label="Thumbnail frame" />
            <div class="row wrap"><${Button} size="sm" kind="soft" icon="film" disabled=${busy || live} onClick=${() => save({ thumbAt: frameAt })}>Use this frame</${Button}>
              <${Button} size="sm" kind="ghost" icon="upload" disabled=${busy || live} onClick=${() => fileRef.current?.click()}>Upload an image</${Button}>
              ${thumbSrc ? html`<${Button} size="sm" kind="ghost" icon="x" disabled=${busy || live} onClick=${() => save({ thumb: null })}>No thumbnail</${Button}>` : null}
              <input ref=${fileRef} type="file" accept="image/jpeg,image/png" style="display:none" onChange=${(e) => upload(e.target.files[0])} /></div>
          </div>
        </div>
      </div>
    </div></${Modal}>`;
}
