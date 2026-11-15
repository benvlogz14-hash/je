'use strict';
/**
 * The Calendar page's events (Nov 15, Ryan: "revamp the calendar ... easily add and remove things to it, use it like
 * Google Calendar, sync with Gmail").
 *
 * - Our own events live in `opsEvents` (where HAL already put "a call with Judy Thursday at 2"): { title, date
 *   'YYYY-MM-DD', time 'HH:MM' ('' = all day), endDate, end 'HH:MM', notes, location, color, source, g }.
 *   Older HAL events ("2PM", no end) are read as they are and given an hour.
 * - Google Calendar, both ways (`calendar.google`, the login under `global.google.calendar.token`): every few minutes
 *   and when the page opens, the chosen calendars' events from 2 months back to 6 months ahead are read in
 *   (`source: 'google'`, `g` = { cal, id, etag, link }); anything made, moved or deleted here is written to Google
 *   (new events go to the calendar picked as "save to"). Nobody is ever invited or emailed from here (no attendees are
 *   added, sendUpdates none). Invites accepted in Gmail are in Google Calendar, so they show up too.
 * - Read-only calendar links (`calendar.feeds`): any private iCal address (Google's "Secret address in iCal format",
 *   Outlook, Apple), read through the safe fetcher every 15 minutes, repeating events expanded; kept in memory only.
 * Times are the PC's local time (the engine runs on the same PC as the app).
 */
const ctx = require('../core/ctx');
const audit = require('../core/audit');
const events = require('../core/events');
const google = require('../integrations/google');

const KEY = 'global.google.calendar.token';
const SCOPES = ['https://www.googleapis.com/auth/calendar.events', 'https://www.googleapis.com/auth/calendar.readonly', 'openid', 'email'];
const API = process.env.EUCLIDEAN_GCAL_API || 'https://www.googleapis.com/calendar/v3'; // a stand-in for tests
const COLORS = ['teal', 'sky', 'lav', 'rose', 'gold', 'moss', 'coral', 'slate', 'cyan'];

// ------------------------------------------------------------ dates (local)
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const okDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !isNaN(new Date(`${s}T00:00`));
const addDays = (s, n) => { const d = new Date(`${s}T12:00`); d.setDate(d.getDate() + n); return ymd(d); };
/** "14:30", "2PM", "2:30 pm", "14" → "HH:MM" ('' when it isn't a time). */
function normTime(t) {
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i.exec(String(t || '').trim()); if (!m) return '';
  let h = Number(m[1]) % 24; const mi = Math.min(59, Number(m[2] || 0)); const ap = (m[3] || '').toLowerCase();
  if (ap === 'pm' && h < 12) h += 12; if (ap === 'am' && h === 12) h = 0;
  if (!ap && h > 0 && h < 7 && !m[2]) h += 12; // "at 3" means the afternoon
  return `${pad(h)}:${pad(mi)}`;
}
const minutes = (t) => { const [h, m] = String(t).split(':').map(Number); return h * 60 + m; };
const fromMinutes = (n) => `${pad(Math.floor(n / 60) % 24)}:${pad(n % 60)}`;

/** An event as the page draws it: always date/time/endDate/end, an all-day flag and whether it can be changed here. */
function shape(e) {
  const time = normTime(e.time); const allDay = !time;
  let endDate = okDate(e.endDate) ? e.endDate : e.date; let end = normTime(e.end);
  if (!allDay) {
    if (!end) end = fromMinutes(Math.min(24 * 60 - 1, minutes(time) + 60));
    if (endDate === e.date && minutes(end) <= minutes(time)) end = fromMinutes(Math.min(24 * 60 - 1, minutes(time) + 30));
  } else end = '';
  if (endDate < e.date) endDate = e.date;
  const g = e.g || null;
  return { id: e.id, title: e.title || '(No title)', date: e.date, time, endDate, end, allDay, notes: e.notes || '', location: e.location || '', color: COLORS.includes(e.color) ? e.color : 'teal',
    source: e.source || 'euclidean', calendar: g ? (calName(g.cal) || 'Google') : 'Euclidean', link: g?.link || null, editable: e.readOnly !== true, createdBy: e.createdBy || null,
    syncing: !!(g && g.dirty), syncError: g?.error || null };
}

// ------------------------------------------------------------ settings
const settings = () => ctx.setting('calendar', {}) || {};
const gset = () => settings().google || {};
function saveG(patch) { ctx.store.setSettings({ calendar: { google: { ...gset(), ...patch } } }); }
const calName = (id) => (gset().calendars || []).find((c) => c.id === id)?.name || null;
const googleOn = () => google.connected(KEY) && gset().on !== false;

// ------------------------------------------------------------ our events
function list(from, to) {
  const out = [];
  for (const e of ctx.store.all('opsEvents')) {
    if (!okDate(e.date) || e.deletedAt) continue;
    if (e.source === 'google' && !googleShows(e.g?.cal)) continue;
    const s = shape(e); if (s.endDate < from || s.date > to) continue; out.push(s);
  }
  for (const f of feedEvents) if (!(f.endDate < from || f.date > to)) out.push(f);
  return out.sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`));
}
const googleShows = (cal) => googleOn() && (!(gset().show || []).length || (gset().show || []).includes(cal));

function clean(b, base = {}) {
  const e = {};
  if (b.title !== undefined) e.title = String(b.title || '').replace(/[<>]/g, '').trim().slice(0, 200) || 'New event';
  if (b.date !== undefined) { if (!okDate(b.date)) throw Object.assign(new Error('Pick a date.'), { status: 400 }); e.date = b.date; }
  if (b.allDay === true) { e.time = ''; e.end = ''; }
  else {
    if (b.time !== undefined) e.time = normTime(b.time);
    if (b.end !== undefined) e.end = normTime(b.end);
  }
  if (b.endDate !== undefined) e.endDate = okDate(b.endDate) ? b.endDate : (e.date || base.date);
  for (const k of ['notes', 'location']) if (b[k] !== undefined) e[k] = String(b[k] || '').slice(0, k === 'notes' ? 4000 : 300);
  if (b.color !== undefined && COLORS.includes(b.color)) e.color = b.color;
  const date = e.date || base.date; const endDate = e.endDate || base.endDate || date;
  if (endDate < date) e.endDate = date;
  return e;
}

/** Make an event (a person on the Calendar page, HAL, or Claude with the person's OK). Written to Google when it's on. */
async function create(b, actor = 'user') {
  const e = clean({ title: b.title || 'New event', ...b });
  if (!e.date) throw Object.assign(new Error('Pick a date.'), { status: 400 });
  const row = ctx.store.insert('opsEvents', { notes: '', location: '', color: 'teal', time: '', end: '', endDate: e.date, ...e, source: 'euclidean', createdBy: actor });
  audit.log(actor, 'calendar.added', { title: row.title, date: row.date, time: row.time });
  if (googleOn() && gset().write !== false && b.toGoogle !== false) await pushOne(row.id).catch(() => {});
  events.publish('calendar', { id: row.id });
  return shape(ctx.store.get('opsEvents', row.id));
}

async function update(id, b, actor = 'user') {
  const cur = ctx.store.get('opsEvents', id); if (!cur || cur.deletedAt) throw Object.assign(new Error('That event is gone.'), { status: 404 });
  if (cur.readOnly) throw Object.assign(new Error('This event belongs to a calendar Euclidean can only read.'), { status: 400 });
  const patch = clean(b, cur);
  ctx.store.update('opsEvents', id, { ...patch, ...(cur.g ? { g: { ...cur.g, dirty: true } } : {}) });
  audit.log(actor, 'calendar.changed', { title: patch.title || cur.title, date: patch.date || cur.date });
  if (googleOn() && (cur.g || (gset().write !== false && cur.source !== 'google'))) await pushOne(id).catch(() => {});
  events.publish('calendar', { id });
  return shape(ctx.store.get('opsEvents', id));
}

/** Delete (from Google too). Returns the event as it was, so the page can put it back (Undo). */
async function remove(id, actor = 'user') {
  const cur = ctx.store.get('opsEvents', id); if (!cur) return { ok: true };
  if (cur.readOnly) throw Object.assign(new Error('This event belongs to a calendar Euclidean can only read.'), { status: 400 });
  if (cur.g?.id && googleOn()) {
    try { await google.api(KEY, `${API}/calendars/${encodeURIComponent(cur.g.cal)}/events/${encodeURIComponent(cur.g.id)}?sendUpdates=none`, { method: 'DELETE' }); }
    catch (e) { if (!e.gone) { ctx.store.update('opsEvents', id, { deletedAt: new Date().toISOString(), g: { ...cur.g, error: e.message } }); events.publish('calendar', { id }); throw e; } }
  }
  ctx.store.remove('opsEvents', id);
  audit.log(actor, 'calendar.removed', { title: cur.title, date: cur.date });
  events.publish('calendar', { id });
  return { ok: true, event: { title: cur.title, date: cur.date, time: cur.time, end: cur.end, endDate: cur.endDate, notes: cur.notes, location: cur.location, color: cur.color } };
}

// ------------------------------------------------------------ typed events ("lunch with Ben friday 1pm for 30 min")
function quick(text, actor = 'user') {
  const hal = require('../hal/index'); const low = String(text || '').toLowerCase();
  const p = hal.calendarParse(text);
  let durMin = 60; const m = /\bfor\s+(\d+(?:\.\d+)?)\s*(m|min|mins|minutes|h|hr|hrs|hour|hours)\b/.exec(low) || /\b(half an hour|an hour)\b/.exec(low);
  if (m) durMin = m[1] === 'half an hour' ? 30 : m[1] === 'an hour' ? 60 : Math.round(Number(m[1]) * (/^h/.test(m[2]) ? 60 : 1));
  const time = normTime(p.time);
  const title = String(p.title || '').replace(/\bfor\s+\d+(?:\.\d+)?\s*(m|min|mins|minutes|h|hr|hrs|hour|hours)\b/i, '').replace(/\bfor (half an hour|an hour)\b/i, '').replace(/\s+/g, ' ').trim().replace(/^(?:a|an|the)\s+(?=\S)/i, '') || 'New event';
  return create({ title: title[0].toUpperCase() + title.slice(1), date: p.date, time, end: time ? fromMinutes(Math.min(24 * 60 - 1, minutes(time) + Math.max(5, durMin))) : '' }, actor);
}

// ------------------------------------------------------------ Google Calendar
const toGoogle = (e) => {
  const s = shape(e);
  const when = s.allDay ? { start: { date: s.date }, end: { date: addDays(s.endDate, 1) } }
    : { start: { dateTime: new Date(`${s.date}T${s.time}:00`).toISOString() }, end: { dateTime: new Date(`${s.endDate}T${s.end}:00`).toISOString() } };
  return { summary: s.title, description: s.notes || undefined, location: s.location || undefined, ...when };
};
function fromGoogle(ev, cal) {
  let date, time = '', endDate, end = '';
  if (ev.start?.date) { date = ev.start.date; endDate = ev.end?.date ? addDays(ev.end.date, -1) : date; }
  else { const a = new Date(ev.start?.dateTime); const b = new Date(ev.end?.dateTime || a); date = ymd(a); time = hm(a); endDate = ymd(b); end = hm(b); if (endDate > date && end === '00:00') { endDate = addDays(endDate, -1); end = '23:59'; } }
  return { title: ev.summary || '(No title)', date, time, endDate: endDate < date ? date : endDate, end, notes: ev.description || '', location: ev.location || '' };
}

/** Write one of our events to Google (make, or change, it there). Marks it synced or keeps the reason. */
async function pushOne(id) {
  const e = ctx.store.get('opsEvents', id); if (!e || e.deletedAt) return;
  const cal = e.g?.cal || gset().write || 'primary';
  try {
    const body = toGoogle(e);
    const ev = e.g?.id
      ? await google.api(KEY, `${API}/calendars/${encodeURIComponent(cal)}/events/${encodeURIComponent(e.g.id)}?sendUpdates=none`, { method: 'PATCH', body })
      : await google.api(KEY, `${API}/calendars/${encodeURIComponent(cal)}/events?sendUpdates=none`, { method: 'POST', body });
    ctx.store.update('opsEvents', id, { g: { cal, id: ev.id, etag: ev.etag, link: ev.htmlLink || null, updated: ev.updated, dirty: false, error: null } });
  } catch (err) {
    ctx.store.update('opsEvents', id, { g: { ...(e.g || { cal }), dirty: true, error: err.message } });
    throw err;
  }
}

let syncing = null; let lastSync = 0;
/** Read the chosen Google calendars in, and send anything changed here that hasn't reached Google yet. */
function sync({ force = false } = {}) {
  if (!googleOn()) return Promise.resolve({ skipped: 'not connected' });
  if (syncing) return syncing;
  if (!force && Date.now() - lastSync < 60000) return Promise.resolve({ skipped: 'recent' });
  syncing = doSync().finally(() => { syncing = null; lastSync = Date.now(); });
  return syncing;
}
async function doSync() {
  const t0 = Date.now(); let read = 0, sent = 0;
  try {
    // The calendars on the account (names, colours, which can be written to).
    const cl = await google.api(KEY, `${API}/users/me/calendarList?maxResults=250`);
    const cals = (cl.items || []).map((c) => ({ id: c.id, name: c.summaryOverride || c.summary, primary: !!c.primary, canWrite: ['owner', 'writer'].includes(c.accessRole), color: c.backgroundColor || null }));
    const primary = cals.find((c) => c.primary);
    saveG({ calendars: cals, account: primary?.id || gset().account || null, write: gset().write || primary?.id || 'primary' });
    // Changes made here that didn't reach Google yet go first.
    for (const e of ctx.store.all('opsEvents', (x) => x.g?.dirty && !x.deletedAt)) { try { await pushOne(e.id); sent++; } catch { /* kept for next time */ } }
    for (const e of ctx.store.all('opsEvents', (x) => x.deletedAt && x.g?.id)) { try { await google.api(KEY, `${API}/calendars/${encodeURIComponent(e.g.cal)}/events/${encodeURIComponent(e.g.id)}?sendUpdates=none`, { method: 'DELETE' }); ctx.store.remove('opsEvents', e.id); } catch (err) { if (err.gone) ctx.store.remove('opsEvents', e.id); } }
    // Events made here that never had Google (made before it was connected) go up now.
    if (gset().write !== false && !gset()._uploadedOld) { for (const e of ctx.store.all('opsEvents', (x) => !x.g && x.source !== 'google' && !x.deletedAt && okDate(x.date) && x.date >= ymd(new Date(Date.now() - 30 * 864e5)))) { try { await pushOne(e.id); sent++; } catch { /* next time */ } } saveG({ _uploadedOld: true }); }
    const show = (gset().show || []).length ? gset().show : cals.map((c) => c.id);
    const min = new Date(Date.now() - 62 * 864e5).toISOString(), max = new Date(Date.now() + 183 * 864e5).toISOString();
    for (const cal of cals.filter((c) => show.includes(c.id))) {
      const seen = new Set(); let pageToken = '';
      do {
        const q = new URLSearchParams({ singleEvents: 'true', orderBy: 'startTime', timeMin: min, timeMax: max, maxResults: '2500', ...(pageToken ? { pageToken } : {}) });
        const j = await google.api(KEY, `${API}/calendars/${encodeURIComponent(cal.id)}/events?${q}`);
        for (const ev of j.items || []) {
          if (ev.status === 'cancelled' || !ev.start) continue; seen.add(ev.id); read++;
          const mine = ctx.store.find('opsEvents', (x) => x.g?.id === ev.id && x.g?.cal === cal.id);
          if (mine?.g?.dirty) continue; // changed here and not sent yet: ours wins
          const fields = { ...fromGoogle(ev, cal), readOnly: !cal.canWrite, g: { cal: cal.id, id: ev.id, etag: ev.etag, link: ev.htmlLink || null, updated: ev.updated, dirty: false, error: null } };
          if (mine) { if (mine.g.etag !== ev.etag || mine.readOnly !== fields.readOnly) ctx.store.update('opsEvents', mine.id, fields); }
          else ctx.store.insert('opsEvents', { ...fields, source: 'google', color: 'sky', createdBy: 'google' });
        }
        pageToken = j.nextPageToken || '';
      } while (pageToken);
      // Deleted in Google (inside the window read): gone here too.
      ctx.store.removeWhere('opsEvents', (x) => x.g?.cal === cal.id && x.g?.id && !x.g.dirty && !x.deletedAt && !seen.has(x.g.id) && x.date >= min.slice(0, 10) && x.date <= max.slice(0, 10));
    }
    // Calendars no longer shown: their copies go (they come back when shown again).
    ctx.store.removeWhere('opsEvents', (x) => x.source === 'google' && !x.g?.dirty && x.g?.cal && !show.includes(x.g.cal));
    saveG({ lastSync: new Date().toISOString(), error: null, read, sent });
    events.publish('calendar', {});
    return { ok: true, read, sent, ms: Date.now() - t0 };
  } catch (e) {
    saveG({ error: e.message, lastSync: new Date().toISOString() });
    if (e.notConnected) saveG({ on: false });
    events.publish('calendar', {});
    return { ok: false, error: e.message };
  }
}

async function connect() {
  return google.beginAuth({ key: KEY, scopes: SCOPES, label: 'Google Calendar', onDone: (err) => {
    if (err) { saveG({ error: err.message }); events.publish('calendar', {}); return; }
    saveG({ on: true, error: null, _uploadedOld: false }); audit.log('user', 'calendar.google_connected', {});
    sync({ force: true }).catch(() => {});
  } });
}
function disconnect() {
  google.forget(KEY); saveG({ on: false, calendars: [], account: null, lastSync: null, error: null });
  // Copies of Google's events go; our own events stay (they lose their Google link).
  ctx.store.removeWhere('opsEvents', (x) => x.source === 'google');
  for (const e of ctx.store.all('opsEvents', (x) => x.g)) ctx.store.update('opsEvents', e.id, { g: null });
  audit.log('user', 'calendar.google_disconnected', {}); events.publish('calendar', {});
  return { ok: true };
}
function status() {
  const g = gset();
  return { configured: google.configured(), connected: google.connected(KEY), on: googleOn(), account: g.account || null, calendars: g.calendars || [], show: g.show || [], write: g.write || null,
    lastSync: g.lastSync || null, error: g.error || null, feeds: (settings().feeds || []).map((f, i) => ({ i, name: f.name, url: f.url.replace(/(private-)[^/]+/, '$1…'), error: feedErr[f.url] || null, count: feedEvents.filter((e) => e.feed === i).length })) };
}
function setGoogle(b = {}) {
  const patch = {};
  if (Array.isArray(b.show)) patch.show = b.show.map(String);
  if (typeof b.write === 'string') patch.write = b.write;
  if (b.write === false) patch.write = false;
  saveG(patch); return sync({ force: true }).then(() => status());
}

// ------------------------------------------------------------ calendar links (iCal), read only
let feedEvents = []; const feedErr = {}; let feedAt = 0;
async function addFeed(url, name) {
  url = String(url || '').trim().replace(/^webcal:/i, 'https:');
  if (!/^https:\/\//i.test(url)) throw Object.assign(new Error('Paste the calendar\'s iCal address (it starts with https:// and usually ends in .ics).'), { status: 400 });
  const feeds = [...(settings().feeds || [])]; if (feeds.some((f) => f.url === url)) return status();
  feeds.push({ url, name: String(name || '').trim().slice(0, 60) || 'Calendar link' }); ctx.store.setSettings({ calendar: { feeds } });
  await readFeeds(true); return status();
}
async function removeFeed(i) { const feeds = [...(settings().feeds || [])]; feeds.splice(Number(i), 1); ctx.store.setSettings({ calendar: { feeds } }); await readFeeds(true); return status(); }
async function readFeeds(force = false) {
  if (!force && Date.now() - feedAt < 15 * 60000) return;
  feedAt = Date.now(); const out = []; const feeds = settings().feeds || [];
  const from = ymd(new Date(Date.now() - 62 * 864e5)), to = ymd(new Date(Date.now() + 366 * 864e5));
  await Promise.all(feeds.map(async (f, i) => {
    try {
      const r = await require('../integrations/safefetch').get(f.url, { timeout: 30000 });
      if (r.status >= 400 || !/BEGIN:VCALENDAR/.test(r.text)) throw new Error(r.status >= 400 ? `The link answered ${r.status}.` : 'That link isn\'t a calendar (no iCal data).');
      for (const ev of require('./ical').parse(r.text, from, to)) out.push({ ...ev, id: `feed${i}:${ev.uid}:${ev.date}`, feed: i, source: 'feed', calendar: f.name, color: 'slate', editable: false, link: null, createdBy: null, syncing: false, syncError: null });
      feedErr[f.url] = null;
    } catch (e) { feedErr[f.url] = e.message; }
  }));
  feedEvents = out; events.publish('calendar', {});
}

/** From the scheduler (every minute): Google every 5 minutes, calendar links every 15. */
function tick() {
  if (googleOn() && Date.now() - lastSync > 5 * 60000) sync().catch(() => {});
  if ((settings().feeds || []).length) readFeeds().catch(() => {});
}

module.exports = { list, create, update, remove, quick, sync, connect, disconnect, status, setGoogle, addFeed, removeFeed, readFeeds, tick, normTime, shape, fromGoogle, toGoogle };
