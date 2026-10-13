// Analytics: performance of published shorts, by day, platform and client, plus tracked creators
// (search any creator and follow their public numbers).
import { html, useApi, useState, useStore, Empty, Loading, BarChart, Button, Tabs, Seg, Avatar, Drawer, Modal, Field, Sparkline, act, toast, navigate, openMenu, confirmDialog, promptDialog } from '../lib/ui.js';
import { api } from '../lib/api.js';
import { Icon } from '../lib/icons.js';
import { num, ago, PLATFORM_LABEL } from '../lib/format.js';

export function Analytics() {
  const route = useStore((s) => s.route);
  const { data, loading } = useApi('/api/analytics', ['posts']);
  const [tab, setTab] = useState(route.query.tab || null);
  if (loading) return html`<div class="page"><${Loading} /></div>`;
  const current = tab || (data?.total ? 'shorts' : 'creators');
  return html`<div class="page">
    <div class="page-head"><div class="grow"><h1>Analytics</h1><div class="sub">${current === 'creators' ? 'Search any creator and follow their public numbers. Updated every 6 hours.' : data?.lastSync ? `Stats last pulled ${ago(data.lastSync)} ago` : 'Stats sync every 6 hours from Ayrshare and YouTube'}</div></div>
      ${current === 'creators' ? html`<${Button} kind="soft" icon="refresh" onClick=${() => act(() => api.post('/api/creators/sync-all'), { ok: 'Updating every tracked creator' })}>Update all</${Button}>` : html`<${Button} kind="soft" icon="refresh" onClick=${() => act(() => api.post('/api/analytics/sync'), { ok: 'Pulling the latest stats' })}>Sync now</${Button}>`}</div>
    <${Tabs} value=${current} onChange=${(t) => { setTab(t); navigate(`/analytics?tab=${t}`); }} tabs=${[{ value: 'shorts', label: 'Your shorts' }, { value: 'creators', label: 'Creators' }]} />
    ${current === 'creators' ? html`<${Creators} />` : html`<${Shorts} data=${data} />`}
  </div>`;
}

function Shorts({ data }) {
  if (!data) return html`<div class="panel"><${Empty} icon="analytics" title="Couldn't load stats" /></div>`;
  const days = Object.entries(data.byDay).sort(([a], [b]) => a.localeCompare(b)).slice(-21);
  const totalViews = Object.values(data.byClient).reduce((t, c) => t + c.views, 0);
  const totalLikes = Object.values(data.byClient).reduce((t, c) => t + c.likes, 0);
  return html`<div>
    ${!data.total ? html`<div class="panel"><${Empty} icon="analytics" title="Nothing published yet">Once shorts go out, views, likes and comments appear here per client and platform. Connect Ayrshare or a client's YouTube channel to pull stats.<div style="margin-top:12px"><${Button} kind="soft" icon="search" onClick=${() => navigate('/analytics?tab=creators')}>Track other creators meanwhile</${Button}></div></${Empty}></div>` : html`
      <div class="grid c4" style="margin-bottom:14px">${[['Published', num(data.total), `${data.tracked} with stats`], ['Views', num(totalViews), 'across all platforms'], ['Likes', num(totalLikes), totalViews ? `${((totalLikes / totalViews) * 100).toFixed(1)}% like rate` : ''], ['Avg views / short', num(Math.round(totalViews / Math.max(1, data.tracked))), 'tracked shorts only']].map(([l, v, d]) => html`<div class="panel kpi"><div class="eyebrow">${l}</div><div class="v">${v}</div><div class="d">${d}</div></div>`)}</div>
      <div class="grid c2">
        <div class="panel"><div class="panel-head"><h4>Views per day</h4></div><div class="panel-body"><${BarChart} data=${days.map(([d, v]) => ({ label: new Date(d + 'T12:00').toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' }), value: v.views }))} format=${(v) => (v >= 1000 ? `${Math.round(v / 100) / 10}k` : v)} /></div></div>
        <div class="panel"><div class="panel-head"><h4>By platform</h4></div><div class="list">${Object.entries(data.byPlatform).sort((a, b) => b[1].views - a[1].views).map(([k, v]) => html`<div class="list-row"><b style="width:110px">${PLATFORM_LABEL[k] || k}</b><div class="grow"><div class="progress"><i style=${{ width: `${(v.views / Math.max(1, ...Object.values(data.byPlatform).map((x) => x.views))) * 100}%` }} /></div></div><span class="tnum" style="width:80px;text-align:right">${num(v.views)}</span></div>`)}${!Object.keys(data.byPlatform).length ? html`<div class="list-row faint">No platform stats yet</div>` : null}</div></div>
      </div>
      <div class="panel" style="margin-top:14px"><div class="panel-head"><h4>Top shorts</h4></div><div class="table-wrap"><table class="table"><thead><tr><th>Title</th><th>Client</th><th class="num">Views</th><th class="num">Likes</th><th class="num">Comments</th><th>Published</th></tr></thead><tbody>
        ${data.top.map((p) => html`<tr class="click" onClick=${() => navigate(`/production?clip=${p.clipId}`)}><td class="ellipsis" style="max-width:340px">${p.title}</td><td class="muted">${p.client}</td><td class="num">${num(p.views)}</td><td class="num">${num(p.likes)}</td><td class="num">${num(p.comments)}</td><td class="faint">${ago(p.publishedAt)}</td></tr>`)}</tbody></table></div></div>
      <div class="panel" style="margin-top:14px"><div class="panel-head"><h4>By client</h4></div><div class="list">${Object.entries(data.byClient).map(([k, v]) => html`<div class="list-row"><b class="grow">${k}</b><span class="faint">${v.posts} posts</span><span class="tnum" style="width:110px;text-align:right">${num(v.views)} views</span></div>`)}</div></div>`}
  </div>`;
}

// ------------------------------------------------------------ creators
const PLAT_TONE = { youtube: 'coral', tiktok: 'slate', instagram: 'rose', x: 'sky', facebook: 'sky', twitch: 'lav', client: 'moss', other: '' };
const platLabel = (p) => (p === 'client' ? 'Client' : PLATFORM_LABEL[p] || (p === 'x' ? 'X' : p ? p[0].toUpperCase() + p.slice(1) : 'Other'));
const short = (v) => (v == null ? '—' : v >= 1e9 ? `${(v / 1e9).toFixed(1)}B` : v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e4 ? `${Math.round(v / 1e3)}K` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}K` : String(v));
const openUrl = (url) => { if (!url) return; if (window.euclidean) api.post('/api/system/open', { url }).catch(() => window.open(url, '_blank')); else window.open(url, '_blank'); };
function growth(c) {
  const h = (c.history || []).filter((x) => x.followers != null);
  if (h.length < 2) return null;
  const first = h[0], last = h[h.length - 1]; const days = Math.max(1, (new Date(last.at) - new Date(first.at)) / 864e5);
  return { delta: last.followers - first.followers, pct: first.followers ? ((last.followers - first.followers) / first.followers) * 100 : 0, days: Math.round(days) };
}

function Creators() {
  const boot = useStore((s) => s.boot);
  const { data: list, reload } = useApi('/api/creators', ['creators']);
  const [q, setQ] = useState('');
  const [res, setRes] = useState(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(null);
  const [adding, setAdding] = useState(false);
  const aiOn = Object.values(boot?.connections?.ai || {}).some(Boolean);
  const search = async (useAi) => {
    if (q.trim().length < 2) return toast('Type a name, @handle or profile link', { kind: 'warn' });
    setBusy(useAi ? 'ai' : 'web');
    try { const r = await api.get(`/api/creators/search?q=${encodeURIComponent(q.trim())}${useAi ? '&ai=1' : ''}`); setRes(r); }
    catch (e) { toast(e.message, { kind: 'error', title: 'Search failed' }); } finally { setBusy(false); }
  };
  const track = async (x) => {
    if (x.platform === 'client') return navigate(`/clients/${x.clientId}`);
    const c = await act(() => api.post('/api/creators', x), { ok: `Tracking ${x.name}` });
    setRes((r) => r && { ...r, results: r.results.map((y) => (y === x ? { ...y, trackedId: c.id } : y)) }); reload();
  };
  const creators = list || [];
  const totalFollowers = creators.reduce((t, c) => t + (c.followers || 0), 0);
  const fastest = creators.map((c) => ({ c, g: growth(c) })).filter((x) => x.g && x.g.delta > 0).sort((a, b) => b.g.pct - a.g.pct)[0];
  return html`<div class="col" style="gap:14px">
    <div class="panel pad col" style="gap:10px">
      <div class="row wrap" style="gap:8px">
        <div class="row grow" style="min-width:240px;position:relative"><span style="position:absolute;left:10px;color:var(--ink-3)"><${Icon} name="search" size=${16} /></span>
          <input class="input" style="padding-left:34px;width:100%" placeholder="Search creators: a name, @handle, or a YouTube / TikTok / Instagram link" value=${q} onInput=${(e) => setQ(e.target.value)} onKeyDown=${(e) => { if (e.key === 'Enter') search(false); }} aria-label="Search creators" /></div>
        <${Button} kind="primary" icon="search" busy=${busy === 'web'} onClick=${() => search(false)}>Search</${Button}>
        <${Button} kind="lav" icon="sparkle" busy=${busy === 'ai'} disabled=${!aiOn} title=${aiOn ? 'Ask your AI agent to find creators on TikTok, Instagram and YouTube' : 'Connect Grok, Claude or GPT in Settings → Connections'} onClick=${() => search(true)}>Find with AI</${Button}>
        <${Button} kind="ghost" icon="plus" onClick=${() => setAdding(true)}>Add by hand</${Button}>
      </div>
      ${res ? html`<div class="col" style="gap:0">
        ${res.errors?.length ? html`<div class="notice gold" style="margin-bottom:8px"><${Icon} name="info" size=${16} />${res.errors.join(' · ')}${/yt-dlp|reach/.test(res.errors.join(' ')) ? ' Tip: installing yt-dlp (winget install yt-dlp.yt-dlp) makes search and stats more reliable.' : ''}</div>` : null}
        ${!res.results.length ? html`<div class="faint" style="padding:8px 2px">No creators found. Try their exact @handle or paste their profile link.</div>` : html`<div class="list" style="border:1px solid var(--line);border-radius:var(--r-md)">${res.results.map((x) => html`<div class="list-row">
          <${Avatar} name=${x.name} size="sm" />
          <div class="grow" style="min-width:0"><div class="row" style="gap:6px"><b class="ellipsis">${x.name}</b><span class=${'badge ' + (PLAT_TONE[x.platform] || '')}>${platLabel(x.platform)}</span>${x.source ? html`<span class="badge moss">${x.source}</span>` : null}${x.verified === false && !x.direct ? html`<span class="badge lav" title="Suggested by AI. Its numbers are confirmed once it's tracked and synced.">AI suggestion</span>` : null}</div>
            <div class="faint ellipsis" style="font-size:var(--fs-sm)">${[x.handle, x.about].filter(Boolean).join(' · ') || x.url || ''}</div></div>
          <span class="tnum" style="width:120px;text-align:right">${x.followers != null ? `${short(x.followers)} followers` : ''}</span>
          ${x.trackedId ? html`<span class="badge moss"><${Icon} name="check" size=${12} />Tracking</span>` : html`<${Button} size="sm" kind="soft" icon=${x.platform === 'client' ? 'clients' : 'plus'} onClick=${() => track(x)}>${x.platform === 'client' ? 'Open client' : 'Track'}</${Button}>`}
        </div>`)}</div>`}
        <div class="row" style="margin-top:6px"><span class="grow" /><${Button} size="sm" kind="ghost" onClick=${() => setRes(null)}>Close results</${Button}></div></div>` : null}
    </div>

    ${creators.length ? html`<div class="grid c3">
      <div class="panel pad"><div class="faint" style="font-size:var(--fs-sm)">Tracked creators</div><div style="font-size:var(--fs-2xl);font-weight:650">${creators.length}</div></div>
      <div class="panel pad"><div class="faint" style="font-size:var(--fs-sm)">Combined followers</div><div style="font-size:var(--fs-2xl);font-weight:650">${short(totalFollowers)}</div></div>
      <div class="panel pad"><div class="faint" style="font-size:var(--fs-sm)">Fastest growing</div><div style="font-size:var(--fs-lg);font-weight:600">${fastest ? html`${fastest.c.name} <span class="badge moss">+${fastest.g.pct.toFixed(1)}% in ${fastest.g.days}d</span>` : html`<span class="faint">Shows after a couple of updates</span>`}</div></div>
    </div>` : null}

    <div class="panel">${!list ? html`<${Loading} rows=${3} />` : !creators.length ? html`<${Empty} icon="user" title="No creators tracked yet">Search above for any creator (prospects, competitors, inspiration) and click Track. Euclidean collects their whole upload history and follows their numbers month by month.</${Empty}>` : html`<${CreatorTable} creators=${creators} onOpen=${setOpen} reload=${reload} />`}</div>
    ${open ? html`<${CreatorDrawer} c=${creators.find((x) => x.id === open)} onClose=${() => setOpen(null)} reload=${reload} />` : null}
    ${adding ? html`<${AddCreator} onClose=${() => setAdding(false)} onDone=${() => { setAdding(false); reload(); }} />` : null}
  </div>`;
}

function creatorMenu(e, c, reload) {
  openMenu(e, [
    { label: 'Update now', icon: 'refresh', onClick: () => act(() => api.post(`/api/creators/${c.id}/sync`), { ok: `Updating ${c.name}` }) },
    ['youtube', 'tiktok'].includes(c.platform) && c.url ? { label: 'Collect full history', icon: 'download', onClick: () => act(() => api.post(`/api/creators/${c.id}/sync`, { full: true }), { ok: `Collecting ${c.name}'s full upload history` }) } : null,
    c.url ? { label: 'Open profile', icon: 'external', onClick: () => openUrl(c.url) } : null,
    { label: 'Set follower count…', icon: 'edit', onClick: async () => { const v = await promptDialog({ title: `Followers for ${c.name}`, label: 'Type the number from their profile', value: c.followers != null ? String(c.followers) : '' }); if (v != null) act(() => api.patch(`/api/creators/${c.id}`, { followers: v.replace(/[^\d]/g, '') }), { ok: 'Saved' }).then(reload); } },
    c.prospectId ? { label: 'Open in Growth', icon: 'growth', onClick: () => navigate('/growth') } : { label: 'Add to prospects', icon: 'growth', onClick: () => act(() => api.post(`/api/creators/${c.id}/prospect`), { ok: `${c.name} added to Growth → prospects` }).then(reload) },
    'sep',
    { label: 'Stop tracking', icon: 'trash', danger: true, onClick: async () => { if (await confirmDialog({ title: `Stop tracking ${c.name}?`, text: 'Their history in Euclidean is removed. You can track them again any time.', confirm: 'Stop tracking' })) act(() => api.del(`/api/creators/${c.id}`), { ok: 'Removed' }).then(reload); } },
  ]);
}

// ---- month helpers
const monthLabel = (m, long) => { const [y, mo] = m.split('-').map(Number); return new Date(y, mo - 1, 15).toLocaleDateString(undefined, { month: long ? 'long' : 'short', year: 'numeric' }); };
const mins = (sec) => (sec == null ? '—' : sec >= 3600 ? `${Math.floor(sec / 3600)}h ${Math.round((sec % 3600) / 60)}m` : `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`);
const signed = (v) => (v == null ? '—' : `${v > 0 ? '+' : ''}${short(v)}`);
const KIND = { video: 'Long-form', short: 'Short', live: 'Live' };
/** Sortable header cell. */
function Th({ k, sort, setSort, children, num: n }) {
  const on = sort.key === k;
  return html`<th class=${n ? 'num' : ''} style="cursor:pointer;white-space:nowrap" onClick=${() => setSort({ key: k, dir: on && sort.dir === 'desc' ? 'asc' : 'desc' })} aria-sort=${on ? (sort.dir === 'desc' ? 'descending' : 'ascending') : 'none'}>${children}${on ? (sort.dir === 'desc' ? ' ↓' : ' ↑') : ''}</th>`;
}
function sortRows(rows, { key, dir }, get = (r, k) => r[k]) {
  const m = dir === 'asc' ? 1 : -1;
  return rows.slice().sort((a, b) => { const x = get(a, key), y = get(b, key); if (x == null && y == null) return 0; if (x == null) return 1; if (y == null) return -1; return (typeof x === 'string' ? x.localeCompare(y) : x - y) * m; });
}

/** The tracked-creators table: all-time numbers, or any single month, sortable by every column. */
function CreatorTable({ creators, onOpen, reload }) {
  const allMonths = [...new Set(creators.flatMap((c) => (c.months || []).map((m) => m.month)))].sort().reverse();
  const [month, setMonth] = useState('all');
  const [sort, setSort] = useState({ key: 'followers', dir: 'desc' });
  const rowOf = (c) => {
    const m = month === 'all' ? null : (c.months || []).find((x) => x.month === month) || {};
    const g = growth(c);
    return month === 'all'
      ? { c, name: c.name, followers: c.followers, growth: g?.pct ?? null, avgViews: c.metrics?.avgViews, medianViews: c.metrics?.medianViews, uploads30d: c.metrics?.uploads30d, uploads: c.metrics?.uploadsTracked ?? null, totalViews: c.metrics?.totalViews }
      : { c, name: c.name, followers: m.followers ?? null, followersDelta: m.followersDelta ?? null, uploads: m.uploads ?? 0, shorts: m.shorts ?? 0, views: m.views ?? null, avgViews: m.avgViews ?? null, medianViews: m.medianViews ?? null, engagementPct: m.engagementPct ?? null };
  };
  const rows = sortRows(creators.map(rowOf), sort);
  const H = (k, label, n = true) => html`<${Th} k=${k} sort=${sort} setSort=${setSort} num=${n}>${label}</${Th}>`;
  return html`
    <div class="row wrap" style="gap:8px;padding:12px 16px;border-bottom:1px solid var(--line)">
      <span class="faint" style="font-size:var(--fs-sm)">Show</span>
      <select class="select sm" style="width:auto" value=${month} onChange=${(e) => { setMonth(e.target.value); setSort({ key: e.target.value === 'all' ? 'followers' : 'views', dir: 'desc' }); }} aria-label="Month">
        <option value="all">All time</option>${allMonths.map((m) => html`<option value=${m}>${monthLabel(m, true)}</option>`)}</select>
      <span class="faint" style="font-size:var(--fs-sm)">· click a column to sort</span>
    </div>
    <div class="table-wrap"><table class="table"><thead><tr>${H('name', 'Creator', false)}
      ${month === 'all' ? html`${H('followers', 'Followers')}${H('growth', 'Growth')}<th>Trend</th>${H('avgViews', 'Avg views (last 30)')}${H('medianViews', 'Median')}${H('uploads30d', 'Uploads / 30d')}${H('uploads', 'Uploads tracked')}`
        : html`${H('uploads', 'Uploads')}${H('shorts', 'Shorts')}${H('views', 'Views')}${H('avgViews', 'Avg views')}${H('medianViews', 'Median')}${H('engagementPct', 'Engagement')}${H('followersDelta', 'Followers +/-')}`}
      <th>Updated</th><th></th></tr></thead><tbody>
      ${rows.map((r) => { const c = r.c; const g = growth(c); const hist = (c.history || []).map((x) => x.followers).filter((v) => v != null); return html`<tr class="click" onClick=${() => onOpen(c.id)}>
        <td><div class="row" style="gap:10px"><${Avatar} name=${c.name} size="sm" /><div style="min-width:0"><div class="row" style="gap:6px"><b class="ellipsis" style="max-width:220px">${c.name}</b><span class=${'badge ' + (PLAT_TONE[c.platform] || '')}>${platLabel(c.platform)}</span></div><div class="faint" style="font-size:var(--fs-xs)">${c.handle || ''}</div></div></div></td>
        ${month === 'all' ? html`
          <td class="num"><b>${short(c.followers)}</b></td>
          <td class="num">${g ? html`<span style=${{ color: g.delta >= 0 ? 'var(--moss-ink)' : 'var(--coral-ink)' }}>${g.delta >= 0 ? '+' : ''}${g.pct.toFixed(1)}%</span>` : '—'}</td>
          <td>${hist.length > 1 ? html`<${Sparkline} values=${hist} width=${90} height=${26} color=${g && g.delta < 0 ? 'var(--coral)' : 'var(--moss)'} />` : html`<span class="faint" style="font-size:var(--fs-xs)">—</span>`}</td>
          <td class="num">${short(r.avgViews)}</td><td class="num">${short(r.medianViews)}</td><td class="num">${r.uploads30d ?? '—'}</td><td class="num">${r.uploads ?? '—'}</td>`
        : html`<td class="num">${r.uploads}</td><td class="num">${r.shorts}</td><td class="num">${short(r.views)}</td><td class="num">${short(r.avgViews)}</td><td class="num">${short(r.medianViews)}</td><td class="num">${r.engagementPct != null ? `${r.engagementPct}%` : '—'}</td>
          <td class="num" style=${{ color: r.followersDelta > 0 ? 'var(--moss-ink)' : r.followersDelta < 0 ? 'var(--coral-ink)' : '' }}>${signed(r.followersDelta)}</td>`}
        <td>${c.syncError ? html`<span class="badge gold" title=${c.syncError}>Needs attention</span>` : c.syncedAt ? html`<span class="faint">${ago(c.syncedAt)} ago</span>` : ['youtube', 'tiktok'].includes(c.platform) && c.url ? html`<span class="faint">Collecting…</span>` : html`<span class="faint" title="This platform needs a login for automatic stats; update the number from the ⋯ menu">By hand</span>`}</td>
        <td onClick=${(e) => e.stopPropagation()}><${Button} kind="ghost" size="sm" icon="more" title="More" onClick=${(e) => creatorMenu(e, c, reload)} /></td></tr>`; })}
    </tbody></table></div>
    ${month !== 'all' ? html`<div class="faint" style="font-size:var(--fs-xs);padding:8px 16px">Views are each upload's views so far, grouped by the month it was posted. Followers +/- needs Euclidean to have checked the creator during that month.</div>` : null}`;
}

function CreatorDrawer({ c: brief, onClose, reload }) {
  const { data: c, reload: reloadOne } = useApi(brief ? `/api/creators/${brief.id}` : null, ['creators'], [brief?.id]);
  const [notes, setNotes] = useState(brief?.notes || '');
  const [view, setView] = useState('months');
  const [sort, setSort] = useState({ key: 'month', dir: 'desc' });
  const [vsort, setVsort] = useState({ key: 'date', dir: 'desc' });
  const [kind, setKind] = useState('all');
  const [vmonth, setVmonth] = useState('all');
  if (!brief) return null;
  const sub = `${platLabel(brief.platform)}${brief.handle ? ` · ${brief.handle}` : ''}${brief.syncedAt ? ` · updated ${ago(brief.syncedAt)} ago` : ''}`;
  const full = () => act(() => api.post(`/api/creators/${brief.id}/sync`, { full: true }), { ok: 'Collecting their full upload history. This can take a few minutes.' });
  const csv = (of) => api.url(`/api/creators/${brief.id}/export.csv?of=${of}`);
  const months = c?.months || [];
  const videos = (c?.videos || []).filter((v) => (kind === 'all' || v.kind === kind) && (vmonth === 'all' || (v.date || '').startsWith(vmonth)));
  const m = c?.metrics || {};
  const hist = (c?.history || []).filter((x) => x.followers != null);
  const H = (k, label, n = true) => html`<${Th} k=${k} sort=${sort} setSort=${setSort} num=${n}>${label}</${Th}>`;
  const V = (k, label, n = true) => html`<${Th} k=${k} sort=${vsort} setSort=${setVsort} num=${n}>${label}</${Th}>`;
  return html`<${Drawer} wide title=${brief.name} sub=${sub} onClose=${onClose}
    actions=${html`${brief.url ? html`<${Button} size="sm" kind="ghost" icon="external" onClick=${() => openUrl(brief.url)}>Profile</${Button}>` : null}<${Button} size="sm" kind="soft" icon="refresh" onClick=${() => act(() => api.post(`/api/creators/${brief.id}/sync`), { ok: 'Updating' })}>Update</${Button}>`}>
    ${!c ? html`<${Loading} rows=${4} />` : html`<div class="col" style="gap:14px">
      ${c.syncError ? html`<div class="notice gold"><${Icon} name="info" size=${16} />${c.syncError}</div>` : null}
      ${c.partial ? html`<div class="notice"><${Icon} name="info" size=${16} />Only the latest uploads could be read from YouTube's page. Install yt-dlp (winget install yt-dlp.yt-dlp, or re-run Start Euclidean.bat) for the full history with dates, likes and comments.</div>` : null}
      <div class="grid c4">${[['Followers', short(c.followers)], ['Uploads tracked', `${num(m.uploadsTracked ?? 0)}${c.totalVideos && c.totalVideos > (m.uploadsTracked || 0) ? ` of ${num(c.totalVideos)}` : ''}`], ['Views (all tracked)', short(m.totalViews)], ['Avg views (last 30)', short(m.avgViews)],
        ['Long-form / Shorts / Live', `${m.longForm ?? 0} / ${m.shorts ?? 0} / ${m.lives ?? 0}`], ['Uploads / 30d', m.uploads30d ?? '—'], ['First upload tracked', m.firstUpload || '—'], ['Latest upload', m.lastUpload || '—']].map(([l, v]) => html`<div class="panel pad"><div class="faint" style="font-size:var(--fs-xs)">${l}</div><div style="font-size:var(--fs-lg);font-weight:650" class="tnum">${v}</div></div>`)}</div>
      ${c.about || c.keywords?.length ? html`<div class="panel pad col" style="gap:6px">${c.about ? html`<div class="muted" style="white-space:pre-wrap;font-size:var(--fs-sm);max-height:90px;overflow:auto">${c.about}</div>` : null}${c.keywords?.length ? html`<div class="row wrap" style="gap:4px">${c.keywords.map((k) => html`<span class="badge">${k}</span>`)}</div>` : null}</div>` : null}
      <div class="row wrap" style="gap:8px">
        <${Tabs} value=${view} onChange=${setView} tabs=${[{ value: 'months', label: 'By month' }, { value: 'uploads', label: `All uploads (${num(c.videos?.length || 0)})` }, { value: 'followers', label: 'Followers' }]} />
        <div class="grow" />
        ${['youtube', 'tiktok'].includes(c.platform) && c.url ? html`<${Button} size="sm" kind="lav" icon="download" onClick=${full} title="Go back through every upload on the channel">${c.fullHistoryAt ? 'Refresh full history' : 'Collect full history'}</${Button}>` : null}
        <a class="btn sm ghost" href=${csv(view === 'uploads' ? 'uploads' : 'months')} download>Download CSV</a>
      </div>
      ${view === 'months' ? (months.length ? html`<div class="panel"><div class="table-wrap"><table class="table"><thead><tr>${H('month', 'Month', false)}${H('uploads', 'Uploads')}${H('videos', 'Long')}${H('shorts', 'Shorts')}${H('lives', 'Live')}${H('views', 'Views')}${H('avgViews', 'Avg')}${H('medianViews', 'Median')}${H('likes', 'Likes')}${H('comments', 'Comments')}${H('engagementPct', 'Eng.')}${H('avgDurationSec', 'Avg length')}${H('followers', 'Followers')}${H('followersDelta', '+/-')}<th>Top upload</th></tr></thead><tbody>
          ${sortRows(months, sort).map((r) => html`<tr><td style="white-space:nowrap"><b>${monthLabel(r.month)}</b>${r.datesApprox ? html`<span class="faint" title=${`${r.datesApprox} upload date(s) estimated from "x weeks ago"`}> ~</span>` : null}</td>
            <td class="num">${r.uploads}</td><td class="num">${r.videos}</td><td class="num">${r.shorts}</td><td class="num">${r.lives}</td><td class="num">${short(r.views)}</td><td class="num">${short(r.avgViews)}</td><td class="num">${short(r.medianViews)}</td>
            <td class="num">${short(r.likes)}</td><td class="num">${short(r.comments)}</td><td class="num">${r.engagementPct != null ? `${r.engagementPct}%` : '—'}</td><td class="num">${mins(r.avgDurationSec)}</td>
            <td class="num">${short(r.followers)}</td><td class="num" style=${{ color: r.followersDelta > 0 ? 'var(--moss-ink)' : r.followersDelta < 0 ? 'var(--coral-ink)' : '' }}>${signed(r.followersDelta)}</td>
            <td class="ellipsis" style="max-width:260px">${r.top ? html`<a href="#" onClick=${(e) => { e.preventDefault(); openUrl(r.top.url); }}>${r.top.title || r.top.id}</a> <span class="faint">${short(r.top.views)}</span>` : '—'}</td></tr>`)}
        </tbody></table></div><div class="faint" style="font-size:var(--fs-xs);padding:8px 16px">Grouped by the month each upload was posted. Views, likes and comments are totals so far for those uploads. ~ means some dates are estimated.</div></div>`
        : html`<div class="panel pad faint">${['youtube', 'tiktok'].includes(c.platform) ? 'Months appear once their uploads have been collected. Click Update or Collect full history.' : 'This platform needs a login for automatic stats. Follower numbers you enter by hand still appear in the Followers tab.'}</div>`) : null}
      ${view === 'uploads' ? html`<div class="panel">
        <div class="row wrap" style="gap:8px;padding:10px 16px;border-bottom:1px solid var(--line)">
          <${Seg} value=${kind} onChange=${setKind} options=${[{ value: 'all', label: 'All' }, { value: 'video', label: 'Long-form' }, { value: 'short', label: 'Shorts' }, { value: 'live', label: 'Live' }]} />
          <select class="select sm" style="width:auto" value=${vmonth} onChange=${(e) => setVmonth(e.target.value)} aria-label="Month"><option value="all">Every month</option>${months.map((r) => html`<option value=${r.month}>${monthLabel(r.month, true)}</option>`)}</select>
          <span class="faint" style="font-size:var(--fs-sm)">${num(videos.length)} uploads</span></div>
        <div class="table-wrap" style="max-height:60vh;overflow:auto"><table class="table"><thead><tr>${V('date', 'Posted', false)}${V('title', 'Title', false)}<th>Type</th>${V('views', 'Views')}${V('likes', 'Likes')}${V('comments', 'Comments')}${V('shares', 'Shares')}${V('durationSec', 'Length')}</tr></thead><tbody>
          ${sortRows(videos, vsort).slice(0, 500).map((v) => html`<tr class="click" onClick=${() => openUrl(v.url)}><td style="white-space:nowrap" class="tnum">${v.date || '—'}${v.dateApprox && v.date ? html`<span class="faint" title="Estimated"> ~</span>` : null}</td><td class="ellipsis" style="max-width:340px">${v.title || v.id}</td><td><span class="badge">${KIND[v.kind] || v.kind}</span></td><td class="num">${num(v.views)}</td><td class="num">${num(v.likes)}</td><td class="num">${num(v.comments)}</td><td class="num">${num(v.shares)}</td><td class="num">${mins(v.durationSec)}</td></tr>`)}
        </tbody></table></div>${videos.length > 500 ? html`<div class="faint" style="font-size:var(--fs-xs);padding:8px 16px">Showing 500 of ${num(videos.length)}. Download CSV for all of them.</div>` : null}</div>` : null}
      ${view === 'followers' ? html`<div class="panel">${hist.length > 1 ? html`<div class="panel-body"><${BarChart} height=${170} data=${hist.slice(-60).map((h) => ({ label: new Date(h.at).toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' }), value: h.followers }))} format=${short} color="var(--moss)" /></div>` : html`<div class="panel-body faint">The follower trend builds up as Euclidean checks this creator (every 6 hours while the app runs).</div>`}</div>` : null}
      <${Field} label="Notes" id="cr-notes"><textarea id="cr-notes" class="textarea" rows="3" value=${notes} onInput=${(e) => setNotes(e.target.value)} onBlur=${() => notes !== (brief.notes || '') && api.patch(`/api/creators/${brief.id}`, { notes }).then(() => { reload(); reloadOne(); })} placeholder="What stands out: formats, hooks, posting times…" /></${Field}>
    </div>`}</${Drawer}>`;
}

function AddCreator({ onClose, onDone }) {
  const [f, setF] = useState({ platform: 'youtube', name: '', url: '', followers: '' });
  const save = () => act(() => api.post('/api/creators', { platform: f.platform, name: f.name, url: f.url || undefined, handle: /^@/.test(f.url) ? f.url : undefined, followers: f.followers ? Number(String(f.followers).replace(/[^\d]/g, '')) : undefined }), { ok: `Tracking ${f.name || f.url}` }).then(onDone);
  return html`<${Modal} title="Add a creator" icon="user" onClose=${onClose} footer=${html`<${Button} kind="ghost" onClick=${onClose}>Cancel</${Button}><${Button} kind="primary" disabled=${!f.name && !f.url} onClick=${save}>Track creator</${Button}>`}>
    <div class="col" style="gap:12px">
      <${Field} label="Platform" id="ac-p"><select id="ac-p" class="select" value=${f.platform} onChange=${(e) => setF({ ...f, platform: e.target.value })}>${['youtube', 'tiktok', 'instagram', 'x', 'facebook', 'twitch', 'other'].map((p) => html`<option value=${p}>${platLabel(p)}</option>`)}</select></${Field}>
      <${Field} label="Name" id="ac-n"><input id="ac-n" class="input" value=${f.name} onInput=${(e) => setF({ ...f, name: e.target.value })} placeholder="Stringer Media" /></${Field}>
      <${Field} label="Profile link or @handle" hint="YouTube and TikTok links update automatically. Other platforms: type the follower count below and update it from the ⋯ menu." id="ac-u"><input id="ac-u" class="input" value=${f.url} onInput=${(e) => setF({ ...f, url: e.target.value })} placeholder="https://www.youtube.com/@handle" /></${Field}>
      <${Field} label="Followers (optional)" id="ac-f"><input id="ac-f" class="input tnum" value=${f.followers} onInput=${(e) => setF({ ...f, followers: e.target.value })} placeholder="125000" /></${Field}>
    </div></${Modal}>`;
}
