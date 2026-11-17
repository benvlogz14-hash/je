/**
 * Ad machine autopilot: videos that make themselves for the politicians it is switched on for.
 *
 *  - "When new footage arrives": the moment their ticked uploads change (a drop on the Ad machine, or a video put in
 *    their folder of the Drive footage inbox) and the files have settled, a batch is made from it.
 *  - "Every week": on a day and time, a fresh batch from the footage they already have.
 *
 * Each run uses the standing order saved for that politician (the order box, the look and the switches as they were when
 * autopilot was set), never repeats the lines of a video already made (`avoidOld`), and ends with a note saying how many
 * were made and what was skipped. Nothing is sent, posted or changed anywhere else: the videos wait in the Videos tab.
 */
const fs = require('fs');
const ctx = require('../core/ctx');
const audit = require('../core/audit');
const events = require('../core/events');

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DEF = { on: false, when: 'new', day: 1, at: '09:00', count: 6, opts: null };
const SETTLE_MS = 90000; // a file still being copied is left alone

const clean = (a = {}) => ({
  on: !!a.on, when: ['new', 'weekly', 'both'].includes(a.when) ? a.when : 'new',
  day: Math.max(0, Math.min(6, Number(a.day) || 0)), at: /^\d{1,2}:\d{2}$/.test(String(a.at || '')) ? String(a.at).padStart(5, '0') : '09:00',
  count: Math.max(1, Math.min(20, Number(a.count) || 6)),
  opts: a.opts && typeof a.opts === 'object' ? a.opts : null,
});
/** The footage a run would use, as one string: it changes when a video is added, removed or ticked. */
const footKey = (p) => (p.footageUploads || []).filter((u) => !u.off && u.hasAudio !== false).map((u) => u.id).sort().join('|');
const settled = (p) => (p.footageUploads || []).filter((u) => !u.off).every((u) => { try { return Date.now() - fs.statSync(u.file).mtimeMs > SETTLE_MS; } catch { return false; } });
const busy = (id) => ctx.store.all('jobs', (j) => ['queued', 'running'].includes(j.status) && j.payload?.prospectId === id && /^political\./.test(j.type)).length > 0;

function describe(a) {
  if (!a?.on) return 'Off';
  const wk = `every ${DAYS[a.day]} at ${a.at}`;
  return `${a.count} video${a.count === 1 ? '' : 's'} ${a.when === 'new' ? 'when new footage arrives' : a.when === 'weekly' ? wk : `when new footage arrives, and ${wk}`}`;
}
function view(p) { const a = { ...DEF, ...(p.auto || {}) }; return { id: p.id, name: p.name, ...a, describe: describe(a), lastRun: p.auto?.lastRun || null, lastNote: p.auto?.lastNote || '', footage: (p.footageUploads || []).filter((u) => !u.off).length, videos: (p.videos || []).length }; }
function get(id) { const p = ctx.store.get('prospects', id); return p ? view(p) : null; }
function list() { return ctx.store.all('prospects', (p) => p.type === 'political' && p.auto?.on).map(view); }

/** Save a politician's autopilot. Turning it on with videos already made starts from the footage as it is now (no surprise batch). */
function set(id, patch, actor = 'user') {
  const p = ctx.store.get('prospects', id); if (!p) throw new Error('That politician is not on the list.');
  const cur = { ...DEF, ...(p.auto || {}) }; const next = { ...cur, ...clean({ ...cur, ...patch }) };
  if (next.on && !cur.on) { next.lastKey = (p.videos || []).length ? footKey(p) : ''; next.lastNote = ''; }
  next.lastRun = cur.lastRun || null; next.weekDone = cur.weekDone || '';
  ctx.store.update('prospects', id, () => ({ auto: next })); events.publish('prospects', { id });
  audit.log(actor, 'political.autopilot', { prospectId: id, name: p.name, on: next.on, when: next.when, count: next.count });
  return view(ctx.store.get('prospects', id));
}

function start(p, why) {
  const queue = require('../jobs/queue'); const a = p.auto; const o = a.opts || {};
  const job = queue.enqueue('political.batch', { prospectId: p.id, name: p.name, text: String(o.text || ''), count: o.text ? 0 : a.count, styles: o.styles === undefined ? 'mix' : o.styles, edit: o.edit || null, lookPrompt: o.lookPrompt || '', colors: o.colors || null, wide: !!o.wide, purpose: o.purpose || null, end: o.end || null, textStyle: o.textStyle || null, prompt: o.prompt || '', avoidOld: true, auto: why },
    { actor: 'autopilot', priority: 3, dedupeKey: `polpkg:${p.id}`, title: `Autopilot videos for ${p.name}` });
  audit.log('autopilot', 'political.autopilot_run', { prospectId: p.id, name: p.name, why, jobId: job.id });
  return job;
}

/** Called by the scheduler every minute while the app is open. */
function tick() {
  if (ctx.setting('political.autopilot', true) === false) return;
  const tz = ctx.setting('agency.timezone', 'America/New_York');
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date()).map((x) => [x.type, x.value]));
  const today = `${parts.year}-${parts.month}-${parts.day}`; const hm = `${parts.hour}:${parts.minute}`; const dow = DAYS.indexOf(parts.weekday);
  for (const p of ctx.store.all('prospects', (x) => x.type === 'political' && x.auto?.on)) {
    try {
      if (p.hold || busy(p.id)) continue;
      const a = p.auto; const key = footKey(p);
      if (a.when !== 'weekly' && key && key !== (a.lastKey || '')) {
        if (!settled(p)) continue; // still copying: next minute
        ctx.store.update('prospects', p.id, (cur) => ({ auto: { ...cur.auto, lastKey: key, lastRun: new Date().toISOString(), lastNote: 'Started: new footage came in.' } }));
        start(ctx.store.get('prospects', p.id), 'new footage'); continue;
      }
      if (a.when !== 'new' && dow === a.day && hm >= a.at && a.weekDone !== today) {
        ctx.store.update('prospects', p.id, (cur) => ({ auto: { ...cur.auto, weekDone: today, ...(key ? { lastKey: key, lastRun: new Date().toISOString(), lastNote: 'Started: the weekly batch.' } : { lastNote: 'The weekly batch had no footage to use. Add their videos.' }) } }));
        if (key) start(ctx.store.get('prospects', p.id), 'weekly');
      }
    } catch (e) { audit.log('system', 'political.autopilot_error', { prospectId: p.id, error: e.message }, 'warn'); }
  }
}

/** After any batch: a notification, and for autopilot runs a line in HAL's chat and on the politician. */
function finished(p, { made, skipped, seconds, auto, error }) {
  const first = String(p.name).split(' ')[0];
  const line = made ? `${made} video${made === 1 ? '' : 's'} for ${p.name} ${made === 1 ? 'is' : 'are'} ready${skipped?.length ? ` (${skipped.length} skipped)` : ''}.` : `No videos could be made for ${p.name}. ${error || skipped?.[0]?.why || ''}`.trim();
  events.publish('notify', { title: made ? `${first}'s videos are ready` : `No videos for ${first}`, body: line, route: '/politics' });
  if (!auto) return;
  ctx.store.update('prospects', p.id, (cur) => ({ auto: { ...(cur.auto || {}), lastRun: new Date().toISOString(), lastNote: `${line}${seconds ? ` Took ${Math.max(1, Math.round(seconds / 60))} min.` : ''}` } }));
  try { const m = ctx.store.insert('halMessages', { who: 'hal', by: 'autopilot', text: `Ad machine autopilot (${auto}): ${line}${(skipped || []).length ? `\n${skipped.slice(0, 5).map((s) => `- ${s.ask}: ${s.why}`).join('\n')}` : ''}\nThey are in Politics, Videos tab. Nothing was sent or posted.` }); events.publish('hal', { id: m.id }); } catch { /* the note is best-effort */ }
}

module.exports = { get, set, list, tick, finished, describe, footKey, DAYS };
