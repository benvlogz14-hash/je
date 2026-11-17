// Notifications: everything that chimed, newest first, and which kinds make a sound or show a pop-up.
import { html, useState, useEffect, useApi, navigate, Button, Toggle, act } from '../lib/ui.js';
import { api } from '../lib/api.js';
import { play } from '../lib/sound.js';

const when = (t) => {
  const s = (Date.now() - Date.parse(t)) / 1000;
  if (s < 90) return 'Just now'; if (s < 3600) return `${Math.round(s / 60)} min ago`; if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
};

export function Notifications() {
  const { data, reload } = useApi('/api/notifications', ['notification', 'settings']);
  const [only, setOnly] = useState('');
  // Opening the page marks what's here as seen (the sidebar count goes away).
  useEffect(() => { if (data?.unread) api.post('/api/notifications/read', {}).catch(() => {}); }, [data?.unread]);
  if (!data) return html`<div class="screen-pad"><p class="faint">Loading…</p></div>`;
  const name = Object.fromEntries(data.kinds.map((k) => [k.id, k.name]));
  const items = data.items.filter((x) => !only || x.kind === only);
  const count = (id) => data.items.filter((x) => x.kind === id).length;
  const pref = (body, ok) => act(() => api.post('/api/notifications/prefs', body), { ok }).then(reload);
  return html`<div class="screen-pad notif">
    <div class="notif-head"><div class="grow" style="min-width:240px"><h2>Notifications</h2><p>Every chime Euclidean makes is listed here, so you can see what it was. Pick below which ones make a sound.</p></div>
      ${data.items.length ? html`<${Button} kind="ghost" icon="trash" onClick=${() => act(() => api.del('/api/notifications'), { ok: 'Cleared' }).then(reload)}>Clear all</${Button}>` : null}</div>
    <div class="notif-grid">
      <section class="notif-list">
        <div class="row wrap" style="gap:6px;margin-bottom:10px">
          <button class=${`chip${!only ? ' on' : ''}`} onClick=${() => setOnly('')}>Everything · ${data.items.length}</button>
          ${data.kinds.filter((k) => count(k.id)).map((k) => html`<button class=${`chip${only === k.id ? ' on' : ''}`} onClick=${() => setOnly(k.id)}>${k.name} · ${count(k.id)}</button>`)}
        </div>
        ${items.length ? items.map((x) => html`<div key=${x.id} class=${`notif-item k-${x.kind}${x.read ? '' : ' new'}`}>
          <div class="col grow" style="gap:2px;min-width:0"><div class="row wrap" style="gap:8px;align-items:baseline"><b>${x.title}</b><span class="notif-kind">${name[x.kind] || x.kind}</span></div>
            ${x.body ? html`<span class="notif-body">${x.body}</span>` : null}<span class="faint" style="font-size:var(--fs-xs)">${when(x.at)}</span></div>
          ${x.route ? html`<${Button} size="sm" kind="ghost" onClick=${() => navigate(x.route)}>Open</${Button}>` : null}
        </div>`) : html`<p class="faint">Nothing yet. When something chimes, it shows up here.</p>`}
      </section>
      <aside class="notif-prefs">
        <div class="row" style="justify-content:space-between;align-items:center;gap:10px"><b>What makes a sound</b>
          <label class="row" style="gap:6px;align-items:center"><span class="faint" style="font-size:var(--fs-xs)">Mute all</span><${Toggle} on=${data.prefs.muted} label="Mute all" onChange=${(v) => pref({ muted: v }, v ? 'All notification sounds off' : 'Sounds back on')} /></label></div>
        <div class="notif-kinds">
          <div class="notif-k hdr"><span /><span>Sound</span><span>Pop-up</span></div>
          ${data.kinds.map((k) => { const p = data.prefs.kinds[k.id]; return html`<div class=${`notif-k${data.prefs.muted ? ' dim' : ''}`}>
            <div class="col" style="gap:1px;min-width:0"><span>${k.name}</span><span class="faint" style="font-size:var(--fs-xs)">${k.hint}</span></div>
            <${Toggle} on=${p.sound} label=${`${k.name}: sound`} onChange=${(v) => { if (v) play('receive'); pref({ kind: k.id, sound: v }, `${k.name}: sound ${v ? 'on' : 'off'}`); }} />
            <${Toggle} on=${p.popup} label=${`${k.name}: pop-up`} onChange=${(v) => pref({ kind: k.id, popup: v }, `${k.name}: pop-up ${v ? 'on' : 'off'}`)} />
          </div>`; })}
        </div>
        <p class="faint" style="font-size:var(--fs-xs);margin-top:10px">Off still keeps it in this list. Button clicks and send sounds are separate (Settings → Appearance).</p>
      </aside>
    </div>
  </div>`;
}
