'use strict';
/**
 * Reads an iCal calendar (a .ics link: Google's "Secret address in iCal format", Outlook, Apple) into events for the
 * Calendar page, between two dates. Written for Euclidean, no library: folded lines, escaped text, all-day and timed
 * events, UTC / floating / TZID times (turned into this PC's local time), repeating events (DAILY / WEEKLY with BYDAY /
 * MONTHLY by day of the month or "2nd Tuesday" / YEARLY, INTERVAL, COUNT, UNTIL), EXDATE and moved or cancelled
 * single occurrences (RECURRENCE-ID).
 */
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

// Windows zone names some calendars use, to IANA.
const WIN = { 'Eastern Standard Time': 'America/New_York', 'Central Standard Time': 'America/Chicago', 'Mountain Standard Time': 'America/Denver', 'Pacific Standard Time': 'America/Los_Angeles', 'GMT Standard Time': 'Europe/London', 'UTC': 'UTC' };
const offsetCache = new Map();
function tzOffset(tz, t) { // ms to add to UTC to get the wall time in tz
  let f = offsetCache.get(tz);
  if (!f) { f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }); offsetCache.set(tz, f); }
  const g = Object.fromEntries(f.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  return Date.UTC(+g.year, +g.month - 1, +g.day, +g.hour % 24, +g.minute, +g.second) - t;
}
/** A wall time in a zone → the moment (Date). Unknown zones are read as this PC's own time. */
function zoned(y, mo, d, h, mi, s, tz) {
  const zone = WIN[tz] || tz;
  try {
    if (!zone) throw new Error('local');
    const guess = Date.UTC(y, mo - 1, d, h, mi, s); let t = guess - tzOffset(zone, guess); t = guess - tzOffset(zone, t); return new Date(t);
  } catch { return new Date(y, mo - 1, d, h, mi, s); }
}
/** DTSTART-style value → { at: Date, allDay }. */
function when(value, params = {}) {
  const v = String(value || '').trim();
  let m = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (m || params.VALUE === 'DATE') { m = m || /^(\d{4})(\d{2})(\d{2})/.exec(v); return { at: new Date(+m[1], +m[2] - 1, +m[3]), allDay: true }; }
  m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/.exec(v); if (!m) return null;
  const [y, mo, d, h, mi, s] = [+m[1], +m[2], +m[3], +m[4], +m[5], +(m[6] || 0)];
  if (m[7]) return { at: new Date(Date.UTC(y, mo - 1, d, h, mi, s)), allDay: false };
  return { at: params.TZID ? zoned(y, mo, d, h, mi, s, params.TZID.replace(/^"|"$/g, '')) : new Date(y, mo - 1, d, h, mi, s), allDay: false };
}
const unescape = (s) => String(s || '').replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');

/** The VEVENTs: { props: { NAME: [{ value, params }] } }. */
function blocks(text) {
  const lines = String(text).replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '').split('\n');
  const out = []; let cur = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { cur = {}; continue; }
    if (line === 'END:VEVENT') { if (cur) out.push(cur); cur = null; continue; }
    if (!cur) continue;
    const c = line.indexOf(':'); if (c < 0) continue;
    const [name, ...ps] = line.slice(0, c).split(';'); const params = {};
    for (const p of ps) { const [k, v] = p.split('='); params[String(k).toUpperCase()] = v; }
    (cur[name.toUpperCase()] = cur[name.toUpperCase()] || []).push({ value: line.slice(c + 1), params });
  }
  return out;
}
const one = (b, k) => (b[k] && b[k][0]) || null;

const DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
/** The start moments of a repeating event between from and to (Dates), the first included. */
function occurrences(start, rule, from, to, exdates, allDay) {
  const r = Object.fromEntries(String(rule).split(';').map((x) => x.split('=')).map(([k, v]) => [k.toUpperCase(), v]));
  const freq = r.FREQ; const iv = Math.max(1, Number(r.INTERVAL) || 1); const count = r.COUNT ? Number(r.COUNT) : Infinity;
  const until = r.UNTIL ? (when(r.UNTIL) || {}).at : null;
  const byday = r.BYDAY ? r.BYDAY.split(',') : null; const bymd = r.BYMONTHDAY ? r.BYMONTHDAY.split(',').map(Number) : null;
  const out = []; let n = 0; const keep = (d) => { if (until && d > until) return false; n++; if (n > count) return false; if (d >= from && d <= to && !exdates.has(+d)) out.push(d); return true; };
  const at = (y, mo, d) => new Date(y, mo, d, start.getHours(), start.getMinutes(), start.getSeconds());
  const stop = (d) => d > to || n >= count || (until && d > until);
  if (freq === 'DAILY') { for (let i = 0; i < 4000; i++) { const d = at(start.getFullYear(), start.getMonth(), start.getDate() + i * iv); if (stop(d) || !keep(d)) break; } }
  else if (freq === 'WEEKLY') {
    const days = (byday || [DAYS[start.getDay()]]).map((x) => DAYS.indexOf(x.slice(-2))).filter((x) => x >= 0).sort();
    const week0 = at(start.getFullYear(), start.getMonth(), start.getDate() - start.getDay());
    outer: for (let w = 0; w < 1500; w++) for (const wd of days) {
      const d = at(week0.getFullYear(), week0.getMonth(), week0.getDate() + w * 7 * iv + wd); if (d < start) continue;
      if (stop(d) || !keep(d)) break outer;
    }
  } else if (freq === 'MONTHLY' || freq === 'YEARLY') {
    const step = freq === 'YEARLY' ? 12 * iv : iv;
    outer: for (let k = 0; k < 600; k++) {
      const base = new Date(start.getFullYear(), start.getMonth() + k * step, 1); const y = base.getFullYear(), mo = base.getMonth();
      let cands = [];
      if (byday && freq === 'MONTHLY') for (const b of byday) { // 2TU, -1FR
        const m = /^([+-]?\d)?(\w\w)$/.exec(b); if (!m) continue; const wd = DAYS.indexOf(m[2]); const nth = Number(m[1] || 0);
        const all = []; for (let dd = 1; dd <= 31; dd++) { const d = new Date(y, mo, dd); if (d.getMonth() !== mo) break; if (d.getDay() === wd) all.push(dd); }
        if (nth > 0) cands.push(all[nth - 1]); else if (nth < 0) cands.push(all[all.length + nth]); else cands.push(...all);
      } else for (const dd of (bymd || [start.getDate()])) cands.push(dd < 0 ? new Date(y, mo + 1, 0).getDate() + dd + 1 : dd);
      cands = cands.filter((x) => x && new Date(y, mo, x).getMonth() === mo).sort((a, b) => a - b);
      for (const dd of cands) { const d = at(y, mo, dd); if (d < start) continue; if (stop(d) || !keep(d)) break outer; }
      if (new Date(y, mo, 1) > to) break;
    }
  } else keep(start);
  void allDay;
  return out;
}

/** Events between from and to ('YYYY-MM-DD'): [{ uid, title, date, time, endDate, end, allDay, notes, location }]. */
function parse(text, from, to) {
  const F = new Date(`${from}T00:00`), T = new Date(`${to}T23:59:59`);
  const evs = blocks(text); const moved = new Map(); // uid -> Map(original start ms -> block)
  for (const b of evs) { const rid = one(b, 'RECURRENCE-ID'); const uid = one(b, 'UID')?.value; if (rid && uid) { const w = when(rid.value, rid.params); if (w) { if (!moved.has(uid)) moved.set(uid, new Map()); moved.get(uid).set(+w.at, b); } } }
  const out = [];
  const emit = (b, at, durMs, allDay, uid) => {
    if ((one(b, 'STATUS')?.value || '').toUpperCase() === 'CANCELLED') return;
    const endAt = new Date(+at + durMs);
    const e = { uid, title: unescape(one(b, 'SUMMARY')?.value) || '(No title)', notes: unescape(one(b, 'DESCRIPTION')?.value).slice(0, 4000), location: unescape(one(b, 'LOCATION')?.value).slice(0, 300), allDay };
    if (allDay) { e.date = ymd(at); e.time = ''; e.end = ''; const last = new Date(+endAt - 864e5); e.endDate = last < at ? e.date : ymd(last); }
    else { e.date = ymd(at); e.time = hm(at); e.endDate = ymd(endAt); e.end = hm(endAt); if (e.endDate > e.date && e.end === '00:00') { e.endDate = ymd(new Date(+endAt - 60000)); e.end = '23:59'; } }
    if (e.endDate < from || e.date > to) return; out.push(e);
  };
  for (const b of evs) {
    if (one(b, 'RECURRENCE-ID')) continue;
    const ds = one(b, 'DTSTART'); if (!ds) continue; const s = when(ds.value, ds.params); if (!s) continue;
    const de = one(b, 'DTEND'); const e = de ? when(de.value, de.params) : null;
    let durMs = e ? +e.at - +s.at : s.allDay ? 864e5 : 0;
    const du = one(b, 'DURATION'); if (!e && du) { const m = /P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?/.exec(du.value) || []; durMs = (((+m[1] || 0) * 7 + (+m[2] || 0)) * 86400 + (+m[3] || 0) * 3600 + (+m[4] || 0) * 60 + (+m[5] || 0)) * 1000; }
    const uid = one(b, 'UID')?.value || `${ds.value}-${one(b, 'SUMMARY')?.value}`;
    const rule = one(b, 'RRULE');
    if (!rule) { emit(b, s.at, durMs, s.allDay, uid); continue; }
    const ex = new Set(); for (const x of b.EXDATE || []) for (const v of x.value.split(',')) { const w = when(v, x.params); if (w) ex.add(+w.at); }
    const mv = moved.get(uid) || new Map();
    for (const at of occurrences(s.at, rule.value, new Date(+F - durMs), T, ex, s.allDay)) {
      const over = mv.get(+at);
      if (over) { const os = when(one(over, 'DTSTART').value, one(over, 'DTSTART').params); const oe = one(over, 'DTEND') ? when(one(over, 'DTEND').value, one(over, 'DTEND').params) : null; if (os) emit(over, os.at, oe ? +oe.at - +os.at : durMs, os.allDay, `${uid}:${+at}`); }
      else emit(b, at, durMs, s.allDay, `${uid}:${+at}`);
    }
  }
  return out;
}

module.exports = { parse, when, occurrences };
