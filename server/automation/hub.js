/**
 * Automations: everything in Euclidean that runs by itself, in one list (System → Automations).
 *
 * Each entry says what it does, whether it's on, when it last did something, and where its settings live. Switches here
 * only turn on or off work that stays inside the app (making videos, reading news, refreshing numbers, scouting for
 * leads). Anything that sends, posts or writes to an outside account (auto-send, the publishing hold, Google Calendar)
 * is shown with its state and a link, and is changed on its own page, where its safety checks are.
 *
 * One master switch (`automation.paused`) stops every automation at once; jobs already running carry on.
 */
const ctx = require('../core/ctx');
const audit = require('../core/audit');
const events = require('../core/events');

const S = (k, d) => ctx.setting(k, d);
const ago = (t) => (t ? new Date(typeof t === 'number' ? t : t).toISOString() : null);
const set = (path, value) => { const o = {}; let cur = o; const parts = path.split('.'); parts.slice(0, -1).forEach((p) => { cur[p] = {}; cur = cur[p]; }); cur[parts[parts.length - 1]] = value; ctx.store.setSettings(o); };
const clients = () => ctx.store.all('clients', (c) => c.status === 'active');
const lastAudit = (re) => { const a = ctx.store.all('audit', (x) => re.test(x.action || '')); const x = a[a.length - 1]; return x ? x.at || x.createdAt || null : null; };

function list() {
  const cs = clients(); const n = cs.length;
  const pols = ctx.store.all('prospects', (p) => p.type === 'political' && p.auto?.on);
  const out = (lane) => S(`outreach.${lane}`, {}) || {};
  const pub = S('_publicStats', null) || ctx.store.settings._publicStats || null;
  const cal = S('calendar', {}) || {}; const g = cal.google || {};
  const routines = ctx.store.all('bots').reduce((a, b) => a + (b.routines || []).filter((r) => r.on !== false).length, 0);
  const inboxLast = ctx.store.settings._inboxLast || null; const watchLast = ctx.store.settings._halWatchLast || null;
  const LANES = [['political', 'Politics'], ['creators', 'Creators']];
  return [
    // ---- Making videos
    { id: 'ads', group: 'Making videos', name: 'Ad machine autopilot', route: '/politics', what: 'Makes politicians\' videos by itself when their new footage arrives or every week.', on: S('political.autopilot', true) !== false, toggle: true,
      detail: pols.length ? `On for ${pols.map((p) => p.name).slice(0, 4).join(', ')}${pols.length > 4 ? ` and ${pols.length - 4} more` : ''}` : 'Not set up for anyone yet. Ad machine → Do this automatically…', last: pols.map((p) => p.auto.lastRun).filter(Boolean).sort().pop() || null },
    { id: 'clients', group: 'Making videos', name: 'Client autopilot', route: '/production', what: 'Keeps each client supplied: pulls new and older videos from their channel and makes clips with their usual styles.', on: cs.some((c) => c.schedule?.autopilot),
      detail: `${cs.filter((c) => c.schedule?.autopilot).length} of ${n} clients · switched on per client on Production`, last: lastAudit(/^(autopilot|channel)\./) },
    { id: 'polish', group: 'Making videos', name: 'Polish clips before review', route: '/production', what: 'Checks each new clip once: cuts noisy pauses, puts the style\'s look back, adds missing captions.', on: cs.some((c) => c.production?.autoPolish !== false),
      detail: `${cs.filter((c) => c.production?.autoPolish !== false).length} of ${n} clients`, last: lastAudit(/polish/) },
    { id: 'broll', group: 'Making videos', name: 'B-roll edit of the day', route: '/production', what: 'A fresh music-cut B-roll edit each day from the footage with the fewest.', on: cs.some((c) => c.production?.brollDaily),
      detail: `${cs.filter((c) => c.production?.brollDaily).length} of ${n} clients`, last: lastAudit(/^broll\./) },
    { id: 'reports', group: 'Leads and outreach', name: 'Weekly client reports', route: '/approvals', what: 'Once a week, a short email per client: what was posted, how it did, what\'s next. A draft: it waits in Approvals for you.', on: !!(S('reports.weekly', {}) || {}).on, toggle: true,
      detail: `${['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'][Number((S('reports.weekly', {}) || {}).day ?? 1)]} at ${(S('reports.weekly', {}) || {}).at || '09:00'} · drafts only`, last: ctx.store.settings._reportLast || null, run: { label: 'Draft now', post: '/api/reports/run' } },
    { id: 'inbox', group: 'Making videos', name: 'Footage inbox (Drive)', route: '/settings', what: 'Takes videos dropped in your synced Drive folder into Production, or into a politician\'s footage.', on: !!String(S('inbox.folder', '') || '').trim(),
      detail: S('inbox.folder', '') ? `Watching ${S('inbox.folder', '')}` : 'No folder set. Settings → Connections → Footage inbox', last: inboxLast?.at || null, run: S('inbox.folder', '') ? { label: 'Check now', post: '/api/inbox/scan' } : null },
    // ---- Finding and talking to people
    ...LANES.map(([lane, label]) => ({ id: `scout-${lane}`, group: 'Leads and outreach', name: `${label}: daily scout`, route: '/growth', what: 'Looks for new people every day with your saved searches; they wait under New prospects for you.', on: !!out(lane).scout, toggle: true,
      detail: out(lane).scout ? `About ${out(lane).scoutPerDay || 15} a day, at ${out(lane).scoutHour ?? 7}:00` : 'Off', last: (ctx.store.settings._outreachScout || {})[lane] || null })),
    ...LANES.map(([lane, label]) => ({ id: `follow-${lane}`, group: 'Leads and outreach', name: `${label}: follow-ups`, route: '/growth', what: 'Writes a short follow-up for people who haven\'t replied. It waits in Approvals unless auto-send is on and every check passes.', on: !!out(lane).followUps, outward: true,
      detail: out(lane).followUps ? `Days ${out(lane).followUpDays || '4, 10'}` : 'Off · Outreach → Autopilot settings' })),
    ...LANES.map(([lane, label]) => ({ id: `send-${lane}`, group: 'Leads and outreach', name: `${label}: auto-send`, route: '/growth', what: lane === 'political' ? 'Political emails are always sent by a person; this only applies to drafts that pass every check.' : 'Sends drafts that pass every safety check, up to a daily cap.', on: !!out(lane).autoSend, outward: true,
      detail: out(lane).autoSend ? `Up to ${out(lane).sendPerDay || 50} a day` : 'Off · Outreach → Autopilot settings' })),
    { id: 'drafts', group: 'Leads and outreach', name: 'Drafts only', route: '/growth', what: 'Safety switch: every message the app writes on its own waits in Approvals with no send time.', on: S('outreach.draftsOnly', true) !== false, outward: true, safety: true,
      detail: S('outreach.draftsOnly', true) !== false ? 'On: nothing the app writes sends by itself' : 'Off · auto-send can send' },
    // ---- Watching and learning
    { id: 'watch', group: 'Watching and learning', name: 'HAL\'s news watch', route: '/messages', what: 'Reads the news on your topics, clients and politicians in conversation, and posts what\'s new in HAL\'s chat.', on: S('hal.watch.on', true) !== false, toggle: true,
      detail: `Every ${S('hal.watch.everyMin', 60)} min${watchLast ? ` · last found ${watchLast.stories || 0} stories, ${watchLast.leads || 0} possible leads` : ''}`, last: watchLast?.at || null, run: { label: 'Check now', post: '/api/hal/watch/run' } },
    { id: 'bots', group: 'Watching and learning', name: 'Bots\' scheduled tasks', route: '/bots', what: 'Runs the tasks you scheduled for Corbin, Juno, Scout and the others.', on: S('bots.autoRun', true) !== false, toggle: true,
      detail: `${routines} scheduled task${routines === 1 ? '' : 's'}`, last: ctx.store.all('bots').map((b) => (b.routines || []).map((r) => r.lastRun)).flat().filter(Boolean).sort().pop() || null },
    { id: 'analytics', group: 'Watching and learning', name: 'Analytics refresh', route: '/analytics', what: 'Data Bot reads the posted shorts\' public numbers (views, likes) for free, no API keys.', on: (S('analytics', {}) || {}).publicStats !== false, toggle: true,
      detail: `Every ${Math.round(((S('analytics', {}) || {}).publicEveryMin || 120) / 60 * 10) / 10} h${pub ? ` · last read ${pub.read || 0}, found ${pub.found || 0}` : ''}`, last: pub?.at || null, run: { label: 'Refresh now', post: '/api/analytics/public' } },
    { id: 'notebook', group: 'Watching and learning', name: 'Notebook', route: '/messages', what: 'HAL\'s notebook learns from what happens in the app: leads, clients, approvals, replies.', on: true, always: true, detail: `${ctx.store.all('halNotes').length} notes` },
    // ---- Keeping things in order
    { id: 'calendar', group: 'Keeping things in order', name: 'Google Calendar sync', route: '/calendar', what: 'Keeps the Calendar page and your Google Calendar in step, both ways. Nobody is ever invited.', on: !!g.on, outward: true,
      detail: g.on ? `Every 5 minutes${g.error ? ` · ${g.error}` : ''}` : 'Not connected · Calendar → Connections', last: g.lastSync || null, run: g.on ? { label: 'Sync now', post: '/api/calendar/sync' } : null },
    { id: 'hold', group: 'Keeping things in order', name: 'Publishing hold', route: '/calendar', what: 'Safety switch: while on, nothing uploads anywhere; scheduled posts wait.', on: S('publishing.hold', true) !== false, outward: true, safety: true,
      detail: S('publishing.hold', true) !== false ? 'On: nothing is posted' : 'Off: scheduled posts go out' },
    { id: 'digest', group: 'Keeping things in order', name: 'Morning digest', route: '/messages', what: 'A summary of the day in Messages each morning.', on: true, always: true, detail: `At ${S('schedule.dailyDigestHour', 8)}:00` },
    { id: 'backup', group: 'Keeping things in order', name: 'Nightly backup', route: '/system', what: 'A copy of the database every night at 3:00.', on: true, always: true, detail: 'At 3:00' },
  ].map((x) => ({ ...x, hasLast: 'last' in x, last: ago(x.last) }));
}

const SWITCH = {
  ads: (on) => set('political.autopilot', on), watch: (on) => set('hal.watch.on', on), bots: (on) => set('bots.autoRun', on),
  analytics: (on) => set('analytics.publicStats', on), reports: (on) => set('reports.weekly.on', on), 'scout-political': (on) => set('outreach.political.scout', on), 'scout-creators': (on) => set('outreach.creators.scout', on),
};
function toggle(id, on, actor = 'user') {
  if (!SWITCH[id]) throw new Error('That one is changed on its own page, where its safety checks are.');
  SWITCH[id](!!on); audit.log(actor, 'automation.toggled', { id, on: !!on }); events.publish('settings', {});
  return list().find((x) => x.id === id);
}
const paused = () => S('automation.paused', false) === true;
function pause(on, actor = 'user') { set('automation.paused', !!on); audit.log(actor, on ? 'automation.paused' : 'automation.resumed', {}); events.publish('settings', {}); return { paused: paused() }; }

module.exports = { list, toggle, pause, paused };
