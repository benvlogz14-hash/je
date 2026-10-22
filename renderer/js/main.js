// Euclidean desktop shell.
import { html, render, useState, useEffect, useRef, useStore, store, navigate, RouteContext, Toasts, ModalHost, Button, HoldButton, Seg, Avatar, act, toast, useEvent } from './lib/ui.js';
import { api } from './lib/api.js';
import { Icon, BrandMark } from './lib/icons.js';
import { play, setSound, soundOn } from './lib/sound.js';
import { Messages } from './modules/messages.js';
import { Production } from './modules/production.js';
import { Approvals } from './modules/approvals.js';
import { Studio } from './modules/studio.js';
import { Clients } from './modules/clients.js';
import { Calendar } from './modules/calendar.js';
import { Growth, Politics } from './modules/growth.js';
import { Analytics } from './modules/analytics.js';
import { Finance } from './modules/finance.js';
import { System } from './modules/system.js';
import { Settings } from './modules/settings.js';
import { Palette } from './modules/palette.js';
import { Lite } from './modules/lite.js';

const NAV = [
  { path: '/messages', tone: 'teal', icon: 'messages', label: 'Messages', key: '1' },
  { path: '/production', tone: 'lav', icon: 'production', label: 'Production', key: '2' },
  { path: '/approvals', tone: 'moss', icon: 'approvals', label: 'Approvals', key: '3', badge: 'approvals' },
  { path: '/studio', tone: 'sky', icon: 'studio', label: 'Studio', key: '4' },
  { path: '/clients', tone: 'gold', icon: 'clients', label: 'Clients', key: '5' },
  { path: '/calendar', tone: 'moss', icon: 'calendar', label: 'Publishing', key: '6' },
  { path: '/politics', tone: 'rose', icon: 'target', label: 'Politics', hint: 'Find candidates, make their ads, email them, autopilot' },
  { path: '/growth', tone: 'sky', icon: 'growth', label: 'Outreach', hint: 'Creator outreach, lead pipeline and table', key: '7' },
  'sep',
  { path: '/analytics', tone: 'slate', icon: 'analytics', label: 'Analytics', key: '8' },
  { path: '/finance', tone: 'rose', icon: 'finance', label: 'Finance', key: '9', owner: true },
  { path: '/system', tone: 'slate', icon: 'system', label: 'System', key: '0' },
];
const ROUTES = { '/messages': Messages, '/production': Production, '/approvals': Approvals, '/studio': Studio, '/clients': Clients, '/calendar': Calendar, '/growth': Growth, '/politics': Politics, '/analytics': Analytics, '/finance': Finance, '/system': System, '/settings': Settings, '/lite': Lite };

function useCounts() {
  const [counts, setCounts] = useState({ approvals: 0, unread: 0 });
  const load = async () => {
    try {
      const [ap, conv] = await Promise.all([api.get('/api/approvals'), api.get('/api/conversations')]);
      setCounts({ approvals: ap.length, unread: conv.reduce((t, c) => t + (c.kind === 'contact' ? c.unread || 0 : 0), 0) });
    } catch { /* offline */ }
  };
  useEffect(() => { load(); const offs = ['approval', 'message', 'conversation', 'clips'].map((t) => api.on(t, () => { clearTimeout(load.t); load.t = setTimeout(load, 300); })); return () => offs.forEach((o) => o()); }, []);
  return counts;
}

function Rail() {
  const route = useStore((s) => s.route);
  const boot = useStore((s) => s.boot);
  const counts = useCounts();
  const item = (n) => {
    if (n === 'sep') return html`<div class="rail-sep" />`;
    if (n.owner && boot?.user?.role !== 'owner') return null;
    const on = route.path.startsWith(n.path);
    const badge = n.badge ? counts[n.badge] : n.path === '/messages' ? counts.unread : 0;
    return html`<button class=${'rail-btn' + (on ? ' on' : '')} style=${{ '--tone': `var(--${n.tone})`, '--tone-soft': `var(--${n.tone}-soft)`, '--tone-ink': `var(--${n.tone}-ink)` }} title=${`${n.hint || n.label}${n.key ? `  (Ctrl+${n.key})` : ''}`} aria-label=${n.label} onClick=${() => { play('tap'); navigate(n.path); }}>
      <${Icon} name=${n.icon} size=${20} /><span class="rail-l">${n.label}</span>${badge ? html`<span class="dot">${badge > 99 ? '99+' : badge}</span>` : null}</button>`;
  };
  return html`<nav class="rail">${NAV.map(item)}<div class="spacer" />
    <button class=${'rail-btn' + (route.path.startsWith('/settings') ? ' on' : '')} title="Settings  (Ctrl+,)" aria-label="Settings" onClick=${() => { play('tap'); navigate('/settings'); }}><${Icon} name="settings" size=${20} /><span class="rail-l">Settings</span></button></nav>`;
}

function MobileNav() {
  const route = useStore((s) => s.route);
  return html`<nav class="mobile-nav">${NAV.filter((n) => n !== 'sep').map((n) => html`<button class=${'rail-btn' + (route.path.startsWith(n.path) ? ' on' : '')} aria-label=${n.label} onClick=${() => navigate(n.path)}><${Icon} name=${n.icon} size=${19} /></button>`)}</nav>`;
}

function TitleBar({ onPalette }) {
  const boot = useStore((s) => s.boot);
  const [paused, setPaused] = useState(!!boot?.paused);
  const [mode, setMode] = useState(boot?.settings?.resources?.mode || 'full');
  const [sound, setS] = useState(soundOn());
  useEvent('queue', (q) => setPaused(q.paused));
  useEvent('mode', (m) => setMode(m.mode));
  const env = boot?.settings?.environment;
  const plat = window.euclidean?.platform;
  return html`<header class=${'titlebar' + (plat === 'win32' ? ' electron-win' : plat === 'darwin' ? ' electron-mac' : '')}>
    <div class="brand"><span class="brand-mark"><${BrandMark} /></span><span class="wordmark">Euclidean</span></div>
    ${api.demo ? html`<span class="badge lav" title="Sample data. Nothing is sent or posted.">Interactive example</span>` : env !== 'production' ? html`<span class="badge gold" title="Outbound messages go to your sandbox recipient; nothing is posted publicly">Test environment</span>` : html`<span class="badge moss">Production</span>`}
    <div class="drag" />
    <button class="search-trigger" onClick=${onPalette} aria-label="Search and commands"><${Icon} name="search" size=${15} /><span class="grow">Search or run a command</span><span class="kb"><kbd>Ctrl</kbd> <kbd>K</kbd></span></button>
    <div class="drag" />
    <${Seg} value=${mode === 'background' ? 'full' : mode} options=${[{ value: 'full', label: 'Full', icon: 'bolt' }, { value: 'lite', label: 'Lite', icon: 'leaf' }]} onChange=${(m) => act(() => api.post('/api/mode', { mode: m }), { ok: m === 'lite' ? 'Lite mode: vital functions only' : 'Full mode', sound: 'toggle' }).then(() => setMode(m))} />
    ${paused
      ? html`<${Button} kind="moss" size="sm" icon="play" onClick=${() => act(() => api.post('/api/queue/resume'), { ok: 'Automation resumed' })}>Resume</${Button}>`
      : html`<${HoldButton} kind="coral" size="sm" icon="power" title="Hold to stop all sending, publishing and rendering" onConfirm=${() => act(() => api.post('/api/queue/pause'), { ok: 'Emergency stop is on', sound: 'confirm' })}>Stop</${HoldButton}>`}
    <${Button} kind="ghost" size="sm" icon=${sound ? 'speaker' : 'mute'} title=${sound ? 'Sounds on' : 'Sounds off'} sound=${null} onClick=${() => { setSound(!sound); setS(!sound); }} />
    <${Avatar} name=${boot?.user?.name || 'User'} size="sm" />
  </header>`;
}

function StatusBar() {
  const boot = useStore((s) => s.boot);
  const online = useStore((s) => s.online);
  const [res, setRes] = useState(boot?.resources || null);
  const [q, setQ] = useState(boot?.queue || {});
  const [health, setHealth] = useState(boot?.health || null);
  const [agent, setAgent] = useState(null);
  useEvent('resources', setRes);
  useEvent('health', (h) => setHealth(h.summary));
  useEvent('job', () => { clearTimeout(StatusBar.t); StatusBar.t = setTimeout(() => api.get('/api/queue/stats').then(setQ).catch(() => {}), 400); });
  useEvent('queue', (x) => setQ((p) => ({ ...p, ...x })));
  useEvent('agents', (a) => setAgent(a));
  const ramUsed = res ? Math.round(((res.ramTotalMb - res.ramFreeMb) / res.ramTotalMb) * 100) : 0;
  const busy = agent ? Object.values(agent.providers).reduce((t, p) => t + (p.busy || 0), 0) : 0;
  const hl = !health ? '' : health.error ? 'err' : health.warn ? 'warn' : 'ok';
  return html`<footer class="statusbar">
    <span class="item click" onClick=${() => navigate('/system?tab=health')} title="Automation health"><span class=${'led ' + (!online ? 'err' : hl)} />${!online ? 'Engine offline: reconnecting' : health ? `${health.error ? `${health.error} error${health.error > 1 ? 's' : ''}` : health.warn ? `${health.warn} warning${health.warn > 1 ? 's' : ''}` : 'All systems normal'}` : 'Checking'}</span>
    <span class="item click" onClick=${() => navigate('/system?tab=queue')} title="Job queue">${q.running ? html`<span class="led live" />` : html`<${Icon} name="layers" size=${13} />`}${q.paused ? 'Paused' : `${q.running || 0} running · ${q.queued || 0} queued`}${q.waitingAgent ? ` · ${q.waitingAgent} for Astra` : ''}</span>
    ${busy ? html`<span class="item"><span class="led live" />${busy} agent call${busy > 1 ? 's' : ''}</span>` : null}
    <div class="spacer" />
    ${res ? html`
      <span class="item hide-sm" title="CPU"><span class="faint">CPU</span><span class="meter"><i style=${{ width: res.cpu + '%', background: res.cpu > 85 ? 'var(--coral)' : 'var(--slate)' }} /></span><span class="tnum">${res.cpu}%</span></span>
      <span class="item hide-sm" title=${`${res.ramFreeMb} MB free of ${res.ramTotalMb} MB`}><span class="faint">RAM</span><span class="meter"><i style=${{ width: ramUsed + '%' }} /></span><span class="tnum">${(res.ramFreeMb / 1024).toFixed(1)} GB free</span></span>
      ${res.gpu ? html`<span class="item hide-sm" title=${res.gpu.name}><span class="faint">GPU</span><span class="tnum">${res.gpu.util}%</span></span>` : null}
      ${res.premiereOpen ? html`<span class="item"><span class="badge lav">Premiere open</span></span>` : null}
      <span class="item hide-sm faint tnum" title="Engine memory">Engine ${res.engineMb} MB${res.uiMb ? ` · UI ${res.uiMb} MB` : ''}</span>` : null}
    <span class="item faint">v${boot?.version || ''}</span>
  </footer>`;
}


// ------------------------------------------------------------ screen tabs (keep several screens open)
const TAB_KEY = 'eu.tabs';
const navOf = (base) => NAV.find((n) => n !== 'sep' && n.path === base) || (base === '/settings' ? { path: '/settings', tone: 'slate', icon: 'settings', label: 'Settings' } : null);
function loadTabs() { try { const t = JSON.parse(localStorage.getItem(TAB_KEY) || '[]'); return Array.isArray(t) ? t.filter((x) => x && ROUTES[x.base]) : []; } catch { return []; } }
function saveTabs(t) { try { localStorage.setItem(TAB_KEY, JSON.stringify(t)); } catch { /* ignore */ } }
const fullPath = (r) => r.path + (r.query && Object.keys(r.query).length ? `?${new URLSearchParams(r.query)}` : '');

function useTabs(route) {
  const base = '/' + route.path.split('/')[1];
  const [tabs, setTabs] = useState(loadTabs);
  useEffect(() => {
    if (!ROUTES[base]) return;
    setTabs((cur) => {
      const i = cur.findIndex((t) => t.base === base);
      const next = i >= 0 ? cur.map((t, j) => (j === i ? { ...t, path: fullPath(route) } : t)) : [...cur, { base, path: fullPath(route) }].slice(-10);
      saveTabs(next); return next;
    });
  }, [route.path, JSON.stringify(route.query || {})]);
  useEffect(() => { document.body.dataset.screen = base; }, [base]);
  const close = (b) => setTabs((cur) => {
    const i = cur.findIndex((t) => t.base === b); const next = cur.filter((t) => t.base !== b); saveTabs(next);
    if (b === base) { const go = next[Math.min(i, next.length - 1)]; navigate(go ? go.path : '/messages'); }
    return next;
  });
  const cycle = (dir) => { const i = tabs.findIndex((t) => t.base === base); const t = tabs[(i + dir + tabs.length) % tabs.length]; if (t && t.base !== base) { play('tap'); navigate(t.path); } };
  return { base, tabs: tabs.length ? tabs : [{ base, path: fullPath(route) }], close, cycle };
}

/** Gives a screen the live route while it's visible, and its own last route while hidden. */
function FrozenRoute({ on, path, children }) {
  const live = useStore((s) => s.route);
  const kept = useRef(live);
  if (on) kept.current = live;
  else if (!kept.current || '/' + kept.current.path.split('/')[1] !== '/' + path.split('?')[0].split('/')[1]) { const [p, q] = path.split('?'); kept.current = { path: p, query: Object.fromEntries(new URLSearchParams(q || '')) }; }
  return html`<${RouteContext.Provider} value=${kept.current}>${children}</${RouteContext.Provider}>`;
}

function TabBar({ tabs, base, close }) {
  if (tabs.length < 2) return null;
  return html`<div class="tabbar" role="tablist">${tabs.map((t) => {
    const n = navOf(t.base); if (!n) return null; const on = t.base === base;
    return html`<div class=${'stab' + (on ? ' on' : '')} role="tab" aria-selected=${on} style=${{ '--tone': `var(--${n.tone})`, '--tone-soft': `var(--${n.tone}-soft)`, '--tone-ink': `var(--${n.tone}-ink)` }}
      onClick=${() => { if (!on) { play('tap'); navigate(t.path); } }} onAuxClick=${(e) => { if (e.button === 1) close(t.base); }} title=${`${n.label}  (Ctrl+Tab to switch, Ctrl+W to close)`}>
      <span class="stab-ic"><${Icon} name=${n.icon} size=${14} /></span><span class="stab-l">${n.label}</span>
      <button class="stab-x" aria-label=${`Close ${n.label}`} onClick=${(e) => { e.stopPropagation(); play('tap'); close(t.base); }}>×</button></div>`;
  })}</div>`;
}

function App() {
  const route = useStore((s) => s.route);
  const boot = useStore((s) => s.boot);
  const [palette, setPalette] = useState(false);
  const tabsApi = useTabs(route);
  const tabsRef = useRef(tabsApi); tabsRef.current = tabsApi;
  useEffect(() => {
    const k = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Tab') { e.preventDefault(); tabsRef.current.cycle(e.shiftKey ? -1 : 1); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'w' && tabsRef.current.tabs.length > 1) { e.preventDefault(); tabsRef.current.close(tabsRef.current.base); return; }
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); play('open'); setPalette((v) => !v); }
      else if (mod && e.key === ',') { e.preventDefault(); navigate('/settings'); }
      else if (mod && /^[0-9]$/.test(e.key) && !e.shiftKey) { const n = NAV.find((x) => x !== 'sep' && x.key === e.key); if (n) { e.preventDefault(); play('tap'); navigate(n.path); } }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);
  // The shell never scrolls. If focusing a field ever nudges it sideways (which hid the nav rail on
  // Settings → Connections), snap it straight back so navigation always stays reachable.
  useEffect(() => {
    const fix = (e) => { const el = e.target === document ? document.scrollingElement : e.target; if (el && (el === document.scrollingElement || el.id === 'app' || el.classList?.contains('app') || el.classList?.contains('body') || el.classList?.contains('main')) && (el.scrollLeft || el.scrollTop)) { el.scrollLeft = 0; el.scrollTop = 0; } };
    document.addEventListener('scroll', fix, true);
    return () => document.removeEventListener('scroll', fix, true);
  }, []);
  useEvent('connection', (c) => store.set({ online: c.online }));
  useEvent('alert', (a) => { play(a.level === 'error' ? 'error' : 'receive'); toast(a.text, { kind: a.level === 'error' ? 'error' : a.level === 'warn' ? 'warn' : 'info', title: a.title, ms: 7000 }); });
  useEvent('notify', (n) => { play('receive'); if (window.euclidean?.notify && document.hidden) window.euclidean.notify(n.title, n.body); else if (n.route) toast(n.body || '', { title: n.title, kind: 'info', ms: 6000 }); });

  if (!boot) return null;
  if (route.path === '/lite') return html`<${Lite} /><${Toasts} /><${ModalHost} />`;
  const base = '/' + route.path.split('/')[1];
  const Page = ROUTES[base] || Messages;
  return html`<div class="app">
    <${TitleBar} onPalette=${() => { play('open'); setPalette(true); }} />
    <div class="body"><${Rail} /><main class="main tabbed">
      <${TabBar} tabs=${tabsApi.tabs} base=${base} close=${tabsApi.close} />
      <div class="screens">${tabsApi.tabs.filter((t) => ROUTES[t.base]).map((t) => { const P = ROUTES[t.base]; const on = t.base === base; return html`<div key=${t.base} class=${'screen' + (on ? ' on' : '')} aria-hidden=${!on}><${FrozenRoute} on=${on} path=${t.path}><${P} /></${FrozenRoute}></div>`; })}
        ${!tabsApi.tabs.some((t) => t.base === base) ? html`<div class="screen on"><${Page} key=${base} /></div>` : null}</div>
    </main></div>
    <${MobileNav} />
    <${StatusBar} />
    ${palette ? html`<${Palette} onClose=${() => setPalette(false)} />` : null}
    <${Toasts} /><${ModalHost} />
  </div>`;
}

function Gate({ error }) {
  return html`<div style="height:100%;display:grid;place-items:center;padding:24px"><div class="panel pad" style="max-width:440px"><div class="row" style="margin-bottom:10px"><${BrandMark} size=${28} /><h2>Euclidean</h2></div>
    <p class="muted">${error || 'This window needs an access token. Open Euclidean from the desktop app, or use the link the engine prints when it starts (it ends with ?token=…).'}</p></div></div>`;
}

export async function boot(demoBackend) {
  const root = document.getElementById('app');
  // Light (white with pastel accents) is the default; dark and follow-system are opt-in in Settings.
  let theme = 'light'; try { theme = localStorage.getItem('eu.theme') || 'light'; } catch { /* ignore */ }
  if (window.EUCLIDEAN_DEMO) theme = 'light';
  if (theme === 'system') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = theme;
  if (!api.init(demoBackend)) return render(html`<${Gate} />`, root);
  try {
    const b = await api.get('/api/bootstrap');
    store.set({ boot: b });
    api.on('connections', (c) => store.set((s) => ({ boot: { ...s.boot, connections: c } })));
    api.on('settings', () => api.get('/api/bootstrap').then((x) => store.set({ boot: x })).catch(() => {}));
    render(html`<${App} />`, root);
  } catch (e) { render(html`<${Gate} error=${e.status === 401 ? 'The access token is not valid. Reopen Euclidean from the desktop app.' : `Could not reach the Euclidean engine: ${e.message}`} />`, root); }
}

if (!window.EUCLIDEAN_DEMO) boot();
