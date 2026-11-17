'use strict';
/**
 * Notifications: every chime the app makes is kept here with what it was, so a sound never goes unexplained, and each
 * kind can be set to make a sound and / or show a pop-up (Notifications page → What makes a sound).
 *
 * Hooked into events.publish: 'notify' and 'alert' events are recorded and carry { kind, sound, popup, noticeId } to the
 * window, which plays the sound and shows the pop-up only when allowed. Settings: notify.muted, notify.kinds[kind].
 */
const ctx = require('../core/ctx');

const KINDS = [
  { id: 'messages', name: 'Messages from clients and contacts', hint: 'An email or text arrives in Messages.', sound: true },
  { id: 'replies', name: 'Replies from leads', hint: 'A politician or creator you emailed wrote back.', sound: true },
  { id: 'calls', name: 'Calls and callbacks', hint: 'Someone called the Twilio number.', sound: true },
  { id: 'videos', name: 'Finished videos and exports', hint: 'Ads, batches, Studio exports, compressions are done.', sound: true },
  { id: 'footage', name: 'New footage', hint: 'A client uploaded, or the Drive inbox brought videos in.', sound: true },
  { id: 'leads', name: 'New leads and drafts', hint: 'Scouts found people, outreach emails or follow-ups are ready to review.', sound: true },
  { id: 'hal', name: "HAL's news watch", hint: 'About every hour while the app is open, HAL reads the news and posts what is new.', sound: false },
  { id: 'agents', name: 'Agent conversations', hint: 'An agent is waiting on you or needs approval.', sound: true },
  { id: 'problems', name: 'Problems', hint: 'A background job failed or something needs fixing.', sound: true },
  { id: 'reminders', name: 'Reminders', hint: 'A client needs footage, a contract is up for renewal.', sound: true },
];
const BY = Object.fromEntries(KINDS.map((k) => [k.id, k]));

/** Which kind a notification is (callers may pass `kind`; else read from its words). */
function classify(type, p = {}) {
  if (p.kind && BY[p.kind]) return p.kind;
  const t = `${p.title || ''} ${p.body || ''}`;
  if (type === 'alert') return /needs footage|renews|renewal/i.test(t) ? 'reminders' : 'problems';
  if (/^HAL\b/.test(p.title || '')) return 'hal';
  if (/callback/i.test(t)) return 'calls';
  if (/ replied$/.test(p.title || '')) return 'replies';
  if (p.conversationId) return 'messages';
  if (/has a message waiting|needs your approval/i.test(t)) return 'agents';
  if (/uploaded footage|Drive inbox/i.test(t)) return 'footage';
  if (/lead|Email ready|follow-up/i.test(t)) return 'leads';
  return 'videos';
}

function prefs() {
  const saved = ctx.setting('notify.kinds', {}) || {};
  return { muted: ctx.setting('notify.muted', false) === true, kinds: Object.fromEntries(KINDS.map((k) => [k.id, { sound: saved[k.id]?.sound ?? k.sound, popup: saved[k.id]?.popup ?? true }])) };
}

/** Called by events.publish for 'notify' / 'alert': store it and add what the window may do. */
function decorate(type, p) {
  if (!p || typeof p !== 'object' || !ctx.store) return p;
  try {
    const kind = classify(type, p); const pr = prefs(); const k = pr.kinds[kind];
    const n = ctx.store.insert('notifications', { kind, level: p.level || null, title: String(p.title || '').slice(0, 200), body: String(p.text || p.body || '').slice(0, 400), route: p.route || (p.conversationId ? `/messages/${p.conversationId}` : null), read: false, at: new Date().toISOString() });
    const all = ctx.store.all('notifications'); if (all.length > 400) for (const x of all.slice(0, all.length - 400)) ctx.store.remove('notifications', x.id);
    setImmediate(() => require('../core/events').publish('notification', { id: n.id }, { coalesceKey: 'notification' }));
    return { ...p, kind, noticeId: n.id, sound: !pr.muted && k.sound, popup: k.popup };
  } catch { return p; }
}

function list({ limit = 200 } = {}) {
  const all = ctx.store.all('notifications').slice().sort((a, b) => (b.at || '').localeCompare(a.at || ''));
  return { items: all.slice(0, limit), unread: all.filter((x) => !x.read).length, kinds: KINDS, prefs: prefs() };
}
function markRead(ids) { for (const x of ctx.store.all('notifications', (n) => !n.read && (!ids || ids.includes(n.id)))) ctx.store.update('notifications', x.id, { read: true }); return { ok: true }; }
function clear() { for (const x of ctx.store.all('notifications')) ctx.store.remove('notifications', x.id); return { ok: true }; }
function setPref({ kind, sound, popup, muted }) {
  if (typeof muted === 'boolean') ctx.store.setSettings({ notify: { muted } });
  if (kind && BY[kind]) ctx.store.setSettings({ notify: { kinds: { [kind]: { ...(typeof sound === 'boolean' ? { sound } : {}), ...(typeof popup === 'boolean' ? { popup } : {}) } } } });
  return prefs();
}

module.exports = { KINDS, classify, prefs, decorate, list, markRead, clear, setPref };
