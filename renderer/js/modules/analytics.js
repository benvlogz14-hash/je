// Analytics: performance of published shorts, by day, platform and client.
import { html, useApi, Empty, Loading, BarChart, Button, act, navigate } from '../lib/ui.js';
import { api } from '../lib/api.js';
import { num, ago, PLATFORM_LABEL } from '../lib/format.js';

export function Analytics() {
  const { data, loading } = useApi('/api/analytics', ['posts']);
  if (loading) return html`<div class="page"><${Loading} /></div>`;
  const days = Object.entries(data.byDay).sort(([a], [b]) => a.localeCompare(b)).slice(-21);
  const totalViews = Object.values(data.byClient).reduce((t, c) => t + c.views, 0);
  const totalLikes = Object.values(data.byClient).reduce((t, c) => t + c.likes, 0);
  return html`<div class="page">
    <div class="page-head"><div class="grow"><h1>Analytics</h1><div class="sub">${data.lastSync ? `Stats last pulled ${ago(data.lastSync)} ago` : 'Stats sync every 6 hours from Ayrshare and YouTube'}</div></div>
      <${Button} kind="soft" icon="refresh" onClick=${() => act(() => api.post('/api/analytics/sync'), { ok: 'Pulling the latest stats' })}>Sync now</${Button}></div>
    ${!data.total ? html`<div class="panel"><${Empty} icon="analytics" title="Nothing published yet">Once shorts go out, views, likes and comments appear here per client and platform. Connect Ayrshare or a client's YouTube channel to pull stats.</${Empty}></div>` : html`
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
