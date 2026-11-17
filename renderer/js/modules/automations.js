// Automations: everything Euclidean does by itself, in one place (sidebar → Automations).
// Switches here turn on or off work that stays inside the app. Anything that sends, posts or writes to an outside
// account is shown with its state and opens its own page, where its safety checks are.
import { html, useState, useApi, navigate, Button, Toggle, act, toast } from '../lib/ui.js';
import { api } from '../lib/api.js';
import { Icon } from '../lib/icons.js';

const when = (t) => {
  if (!t) return 'Not yet';
  const s = (Date.now() - Date.parse(t)) / 1000;
  if (s < 90) return 'Just now'; if (s < 3600) return `${Math.round(s / 60)} min ago`; if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' });
};

export function Automations() {
  const { data, reload } = useApi('/api/automations', ['settings', 'prospects', 'job']);
  const [busy, setBusy] = useState('');
  if (!data) return html`<div class="screen-pad faint">Loading…</div>`;
  const groups = [...new Set(data.list.map((x) => x.group))];
  const on = data.list.filter((x) => x.on && !x.always && !x.safety).length;
  const flip = (x, v) => act(() => api.post(`/api/automations/${x.id}`, { on: v }), { ok: `${x.name} ${v ? 'on' : 'off'}` }).then(reload);
  const run = (x) => { setBusy(x.id); act(() => api.post(x.run.post, {}), { ok: `${x.name}: started` }).then(() => { setBusy(''); reload(); }); };
  const pause = (v) => act(() => api.post('/api/automations/pause', { paused: v }), { ok: v ? 'Every automation is paused. Jobs already running carry on.' : 'Automations back on.' }).then(reload);
  return html`<div class="auto-page">
    <div class="auto-head">
      <div class="grow" style="min-width:260px"><h2>Automations</h2><p>Everything Euclidean does by itself, while it's open. ${on} running. Anything that would send, post or change an outside account is switched on its own page, where its safety checks are.</p></div>
      <div class=${`auto-master${data.paused ? ' held' : ''}`}><div class="col" style="gap:2px"><b>${data.paused ? 'All paused' : 'Running'}</b><span class="faint" style="font-size:var(--fs-xs)">${data.paused ? 'Nothing starts by itself. Backups and the digest still run.' : 'Pause stops every automation at once.'}</span></div>
        <${Button} kind=${data.paused ? 'primary' : 'ghost'} icon=${data.paused ? 'play' : 'pause'} onClick=${() => pause(!data.paused)}>${data.paused ? 'Resume all' : 'Pause all'}</${Button}></div>
    </div>
    ${groups.map((g) => html`<section class="auto-group"><h3>${g}</h3><div class="auto-list">
      ${data.list.filter((x) => x.group === g).map((x) => html`<div key=${x.id} class=${`auto-row${x.on ? ' on' : ''}${data.paused && !x.always && !x.safety ? ' dim' : ''}`}>
        <span class=${`auto-dot${x.safety ? ' safe' : ''}`} />
        <div class="col grow" style="gap:3px;min-width:0">
          <div class="row wrap" style="gap:8px;align-items:baseline"><b>${x.name}</b>${x.outward ? html`<span class="auto-tag">${x.safety ? 'safety switch' : 'sends or posts'}</span>` : null}</div>
          <span class="auto-what">${x.what}</span>
          <span class="auto-meta">${x.detail}${x.hasLast ? ` · Last: ${when(x.last)}` : ''}</span>
        </div>
        <div class="auto-acts">
          ${x.run ? html`<${Button} size="sm" kind="ghost" icon="refresh" disabled=${busy === x.id || data.paused} onClick=${() => run(x)}>${x.run.label}</${Button}>` : null}
          <${Button} size="sm" kind="ghost" onClick=${() => navigate(x.route)}>Open</${Button}>
          ${x.toggle ? html`<${Toggle} on=${x.on} label=${x.name} onChange=${(v) => flip(x, v)} />` : html`<span class="auto-state">${x.always ? 'Always' : x.on ? 'On' : 'Off'}</span>`}
        </div>
      </div>`)}
    </div></section>`)}
  </div>`;
}
