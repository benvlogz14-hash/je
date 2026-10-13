// Analytics: performance of published shorts, by day, platform and client, plus tracked creators
// (search any creator and follow their public numbers).
import { html, useApi, useState, useStore, Empty, Loading, BarChart, Button, Tabs, Avatar, Drawer, Modal, Field, Sparkline, act, toast, navigate, openMenu, confirmDialog, promptDialog } from '../lib/ui.js';
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

    <div class="panel">${!list ? html`<${Loading} rows=${3} />` : !creators.length ? html`<${Empty} icon="user" title="No creators tracked yet">Search above for any creator (prospects, competitors, inspiration) and click Track. Euclidean follows their followers and views over time.</${Empty}>` : html`
      <div class="table-wrap"><table class="table"><thead><tr><th>Creator</th><th class="num">Followers</th><th>Trend</th><th class="num">Avg views</th><th class="num">Median views</th><th class="num">Uploads / 30d</th><th>Updated</th><th></th></tr></thead><tbody>
        ${creators.map((c) => { const g = growth(c); const hist = (c.history || []).map((x) => x.followers).filter((v) => v != null); return html`<tr class="click" onClick=${() => setOpen(c.id)}>
          <td><div class="row" style="gap:10px"><${Avatar} name=${c.name} size="sm" /><div style="min-width:0"><div class="row" style="gap:6px"><b class="ellipsis" style="max-width:220px">${c.name}</b><span class=${'badge ' + (PLAT_TONE[c.platform] || '')}>${platLabel(c.platform)}</span></div><div class="faint" style="font-size:var(--fs-xs)">${c.handle || ''}</div></div></div></td>
          <td class="num"><b>${short(c.followers)}</b>${g ? html`<div style=${{ fontSize: 'var(--fs-xs)', color: g.delta >= 0 ? 'var(--moss-ink)' : 'var(--coral-ink)' }}>${g.delta >= 0 ? '+' : ''}${short(g.delta)} (${g.pct.toFixed(1)}%)</div>` : null}</td>
          <td>${hist.length > 1 ? html`<${Sparkline} values=${hist} width=${90} height=${26} color=${g && g.delta < 0 ? 'var(--coral)' : 'var(--moss)'} />` : html`<span class="faint" style="font-size:var(--fs-xs)">—</span>`}</td>
          <td class="num">${short(c.metrics?.avgViews)}</td><td class="num">${short(c.metrics?.medianViews)}</td><td class="num">${c.metrics?.uploads30d ?? '—'}</td>
          <td>${c.syncError ? html`<span class="badge gold" title=${c.syncError}>Needs attention</span>` : c.syncedAt ? html`<span class="faint">${ago(c.syncedAt)} ago</span>` : ['youtube', 'tiktok'].includes(c.platform) && c.url ? html`<span class="faint">Updating…</span>` : html`<span class="faint" title="This platform needs a login for automatic stats; update the number from the ⋯ menu">By hand · ${ago(c.updatedAt)} ago</span>`}</td>
          <td onClick=${(e) => e.stopPropagation()}><${Button} kind="ghost" size="sm" icon="more" title="More" onClick=${(e) => creatorMenu(e, c, reload)} /></td></tr>`; })}
      </tbody></table></div>`}</div>
    ${open ? html`<${CreatorDrawer} c=${creators.find((x) => x.id === open)} onClose=${() => setOpen(null)} reload=${reload} />` : null}
    ${adding ? html`<${AddCreator} onClose=${() => setAdding(false)} onDone=${() => { setAdding(false); reload(); }} />` : null}
  </div>`;
}

function creatorMenu(e, c, reload) {
  openMenu(e, [
    { label: 'Update now', icon: 'refresh', onClick: () => act(() => api.post(`/api/creators/${c.id}/sync`), { ok: `Updating ${c.name}` }) },
    c.url ? { label: 'Open profile', icon: 'external', onClick: () => openUrl(c.url) } : null,
    { label: 'Set follower count…', icon: 'edit', onClick: async () => { const v = await promptDialog({ title: `Followers for ${c.name}`, label: 'Type the number from their profile', value: c.followers != null ? String(c.followers) : '' }); if (v != null) act(() => api.patch(`/api/creators/${c.id}`, { followers: v.replace(/[^\d]/g, '') }), { ok: 'Saved' }).then(reload); } },
    c.prospectId ? { label: 'Open in Growth', icon: 'growth', onClick: () => navigate('/growth') } : { label: 'Add to prospects', icon: 'growth', onClick: () => act(() => api.post(`/api/creators/${c.id}/prospect`), { ok: `${c.name} added to Growth → prospects` }).then(reload) },
    'sep',
    { label: 'Stop tracking', icon: 'trash', danger: true, onClick: async () => { if (await confirmDialog({ title: `Stop tracking ${c.name}?`, text: 'Their history in Euclidean is removed. You can track them again any time.', confirm: 'Stop tracking' })) act(() => api.del(`/api/creators/${c.id}`), { ok: 'Removed' }).then(reload); } },
  ]);
}

function CreatorDrawer({ c, onClose, reload }) {
  const [notes, setNotes] = useState(c?.notes || '');
  if (!c) return null;
  const hist = (c.history || []).filter((x) => x.followers != null);
  const top = (c.videos || []).slice().sort((a, b) => (b.views || 0) - (a.views || 0));
  return html`<${Drawer} wide title=${c.name} sub=${`${platLabel(c.platform)}${c.handle ? ` · ${c.handle}` : ''}${c.syncedAt ? ` · updated ${ago(c.syncedAt)} ago` : ''}`} onClose=${onClose}
    actions=${html`${c.url ? html`<${Button} size="sm" kind="ghost" icon="external" onClick=${() => openUrl(c.url)}>Profile</${Button}>` : null}<${Button} size="sm" kind="soft" icon="refresh" onClick=${() => act(() => api.post(`/api/creators/${c.id}/sync`), { ok: 'Updating' })}>Update</${Button}>`}>
    <div class="col" style="gap:14px">
      ${c.syncError ? html`<div class="notice gold"><${Icon} name="info" size=${16} />${c.syncError}</div>` : null}
      ${c.about ? html`<p class="muted" style="margin:0">${c.about}</p>` : null}
      <div class="grid c4">${[['Followers', short(c.followers)], ['Avg views', short(c.metrics?.avgViews)], ['Median views', short(c.metrics?.medianViews)], ['Uploads / 30d', c.metrics?.uploads30d ?? '—']].map(([l, v]) => html`<div class="panel pad"><div class="faint" style="font-size:var(--fs-xs)">${l}</div><div style="font-size:var(--fs-xl);font-weight:650">${v}</div></div>`)}</div>
      ${hist.length > 1 ? html`<div class="panel"><div class="panel-head"><h4>Followers over time</h4></div><div class="panel-body"><${BarChart} height=${150} data=${hist.slice(-30).map((h) => ({ label: new Date(h.at).toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' }), value: h.followers }))} format=${short} color="var(--moss)" /></div></div>` : null}
      <div class="panel"><div class="panel-head"><h4 class="grow">Recent uploads</h4><span class="faint" style="font-size:var(--fs-sm)">${top.length ? `${top.length} videos, most viewed first` : ''}</span></div>
        ${top.length ? html`<div class="table-wrap"><table class="table"><thead><tr><th>Title</th><th class="num">Views</th><th>Posted</th></tr></thead><tbody>${top.map((v) => html`<tr class="click" onClick=${() => openUrl(v.url)}><td class="ellipsis" style="max-width:420px">${v.title}</td><td class="num">${num(v.views)}</td><td class="faint">${v.published || (v.ageDays != null ? `${Math.round(v.ageDays)}d ago` : '')}</td></tr>`)}</tbody></table></div>`
          : html`<div class="panel-body faint">${c.platform === 'instagram' || c.platform === 'x' ? 'This platform needs a login to read stats automatically. Use "Set follower count" from the ⋯ menu to log numbers by hand.' : 'Uploads appear after the first update.'}</div>`}</div>
      <${Field} label="Notes" id="cr-notes"><textarea id="cr-notes" class="textarea" rows="3" value=${notes} onInput=${(e) => setNotes(e.target.value)} onBlur=${() => notes !== (c.notes || '') && api.patch(`/api/creators/${c.id}`, { notes }).then(reload)} placeholder="What stands out: formats, hooks, posting times…" /></${Field}>
    </div></${Drawer}>`;
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
