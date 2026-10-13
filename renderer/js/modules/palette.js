// Command palette (Ctrl+K): jump anywhere, find clients/clips/conversations, or run any command.
import { html, useState, useEffect, useRef, useStore, navigate, act, toast, gcls } from '../lib/ui.js';
import { api } from '../lib/api.js';
import { Icon } from '../lib/icons.js';
import { play } from '../lib/sound.js';

const PLACES = [['Messages', '/messages', 'messages'], ['Production', '/production', 'production'], ['Approvals', '/approvals', 'approvals'], ['Studio', '/studio', 'studio'], ['Clients', '/clients', 'clients'], ['Publishing calendar', '/calendar', 'calendar'], ['Growth', '/growth', 'growth'], ['Analytics', '/analytics', 'analytics'], ['Finance', '/finance', 'finance'], ['Agents', '/system?tab=agents', 'robot'], ['Job queue', '/system?tab=queue', 'layers'], ['Health', '/system?tab=health', 'target'], ['Resources & power mode', '/system?tab=resources', 'cpu'], ['Activity log', '/system?tab=logs', 'info'], ['Settings', '/settings', 'settings'], ['Connections', '/settings?tab=connections', 'key']];

export function Palette({ onClose }) {
  const commands = useStore((s) => s.boot?.commands || []);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const [data, setData] = useState({ clients: [], clips: [], convs: [] });
  const input = useRef(null);
  useEffect(() => { input.current?.focus(); Promise.all([api.get('/api/clients'), api.get('/api/clips?limit=60'), api.get('/api/conversations')]).then(([clients, clips, convs]) => setData({ clients, clips, convs })).catch(() => {}); }, []);
  const s = q.trim().toLowerCase();
  const items = [];
  if (s.startsWith('/')) {
    const name = s.slice(1).split(' ')[0];
    for (const c of commands.filter((c) => c.name.startsWith(name))) items.push({ group: 'Run command', cg: c.group, icon: 'slash', label: c.usage, desc: c.description, run: () => { if (s.includes(' ')) { runCmd(q); return undefined; } setQ(`/${c.name} `); return 'keep'; } });
    if (s.includes(' ')) items.unshift({ group: 'Run command', icon: 'send', label: `Run ${q}`, desc: 'Result appears in the Euclidean thread', run: () => runCmd(q) });
  } else {
    const m = (t) => !s || String(t).toLowerCase().includes(s);
    for (const [l, p, ic] of PLACES.filter(([l]) => m(l)).slice(0, s ? 6 : 16)) items.push({ group: 'Go to', icon: ic, label: l, run: () => navigate(p) });
    if (s) {
      for (const c of data.clients.filter((c) => m(c.name)).slice(0, 5)) items.push({ group: 'Clients', icon: 'clients', label: c.name, desc: c.type, run: () => navigate(`/clients/${c.id}`) });
      for (const c of data.clips.filter((c) => m(c.title) || m(`#${c.ref}`)).slice(0, 6)) items.push({ group: 'Clips', icon: 'film', label: `#${c.ref} ${c.title}`, desc: c.client, run: () => navigate(`/production?clip=${c.id}`) });
      for (const c of data.convs.filter((c) => c.kind === 'contact' && m(c.title)).slice(0, 5)) items.push({ group: 'Conversations', icon: 'messages', label: c.title, desc: c.preview, run: () => navigate(`/messages/${c.id}`) });
      for (const c of commands.filter((c) => m(c.name) || m(c.description)).slice(0, 5)) items.push({ group: 'Commands', cg: c.group, icon: 'slash', label: c.usage, desc: c.description, run: () => { setQ(`/${c.name} `); return 'keep'; } });
      items.push({ group: 'Ask Euclidean', icon: 'sparkle', label: `Ask: "${q}"`, desc: 'Routed to the operations agent', run: () => runCmd(q) });
    }
  }
  useEffect(() => setSel(0), [q]);
  async function runCmd(text) {
    onClose(); navigate('/messages/cv_command');
    try { const r = await api.post('/api/command', { text }); play(r.error ? 'error' : 'receive'); if (r.navigate) setTimeout(() => navigate(r.navigate), 300); }
    catch (e) { play('error'); toast(e.message, { kind: 'error' }); }
  }
  const choose = (it) => { play('tap'); if (it.run() !== 'keep') onClose(); };
  const key = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); onClose(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setSel((x) => Math.min(items.length - 1, x + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((x) => Math.max(0, x - 1)); }
    else if (e.key === 'Enter' && items[sel]) { e.preventDefault(); choose(items[sel]); }
  };
  let lastGroup = null;
  return html`<div class="scrim" onClick=${onClose} /><div class="modal palette" role="dialog" aria-label="Command palette">
    <div class="p-input"><${Icon} name="search" size=${18} style="color:var(--ink-3)" /><input ref=${input} id="palette-input" placeholder="Search, go to, or type / to run a command" value=${q} onInput=${(e) => setQ(e.target.value)} onKeyDown=${key} /><kbd>Esc</kbd></div>
    <div class="p-list">${items.map((it, i) => { const g = it.group !== lastGroup ? html`<div class="p-group eyebrow">${it.group}</div>` : null; lastGroup = it.group;
      return html`${g}<div class=${'p-item' + (i === sel ? ' on' : '') + (it.cg ? ' grouped ' + gcls(it.cg) : '')} onMouseEnter=${() => setSel(i)} onClick=${() => choose(it)}><${Icon} name=${it.icon} size=${16} style=${{ color: it.cg ? 'var(--g)' : 'var(--ink-3)', flex: 'none' }} />${it.label.startsWith('/') ? html`<span class="cmd-chip">${it.label}</span>` : html`<span style="white-space:nowrap">${it.label}</span>`}${it.desc ? html`<span class="d ellipsis">${it.desc}</span>` : null}</div>`; })}
      ${!items.length ? html`<div class="p-item faint">No matches</div>` : null}</div></div>`;
}
