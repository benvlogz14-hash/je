/**
 * Weekly client reports: once a week, for each active client, a short email saying what was posted last week, how it
 * did (the posts' own numbers: views, likes), the best one, and what's coming next week. It is a draft: it waits in
 * Approvals and is only sent when a person presses Approve (category 'report' always needs approval).
 *
 * Off until switched on (System → Automations → Weekly client reports). `reports.weekly` = { on, day (0-6), at 'HH:MM' }.
 */
const ctx = require('../core/ctx');
const audit = require('../core/audit');

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const cfg = () => ({ on: false, day: 1, at: '09:00', ...(ctx.setting('reports.weekly', {}) || {}) });
const n = (x) => Number(x) || 0;
const fmt = (x) => (x >= 1e6 ? `${(x / 1e6).toFixed(1)}M` : x >= 1e4 ? `${Math.round(x / 1e3)}K` : x >= 1e3 ? `${(x / 1e3).toFixed(1)}K` : String(Math.round(x)));
const titleOf = (p) => { const c = p.clipId ? ctx.store.get('clips', p.clipId) : null; return String(p.yt?.title || c?.title || c?.hook || p.caption || 'a short').split('\n')[0].replace(/[—–]/g, '-').slice(0, 70); };
const statsOf = (p) => Object.values(p.stats || {}).reduce((a, s) => ({ views: a.views + n(s?.views), likes: a.likes + n(s?.likes), comments: a.comments + n(s?.comments) }), { views: 0, likes: 0, comments: 0 });

/** The numbers for one client's week (ending now). */
function week(client, now = Date.now()) {
  const from = new Date(now - 7 * 864e5).toISOString(); const to = new Date(now).toISOString(); const ahead = new Date(now + 7 * 864e5).toISOString();
  const posts = ctx.store.all('posts', (p) => p.clientId === client.id && p.status === 'published' && (p.publishedAt || p.updatedAt || '') >= from && (p.publishedAt || p.updatedAt || '') <= to)
    .map((p) => ({ p, title: titleOf(p), ...statsOf(p) })).sort((a, b) => b.views - a.views);
  const next = ctx.store.all('posts', (p) => p.clientId === client.id && ['scheduled', 'held', 'queued'].includes(p.status) && (p.scheduledAt || p.at || '') > to && (p.scheduledAt || p.at || '') <= ahead).length;
  const review = ctx.store.all('clips', (c) => c.clientId === client.id && c.status === 'review').length;
  const approved = ctx.store.all('clips', (c) => c.clientId === client.id && c.status === 'approved' && (c.decidedAt || c.updatedAt || '') >= from).length;
  return { posts, views: posts.reduce((a, x) => a + x.views, 0), likes: posts.reduce((a, x) => a + x.likes, 0), next, review, approved };
}

/** The email (plain words, no dashes, one clear line on what's next). */
function write(client, contact, w) {
  const first = String(contact?.name || client.name).split(' ')[0];
  const lines = [`Hi ${first},`, '', `Here's your week with Euclidean.`, ''];
  if (w.posts.length) {
    lines.push(`We posted ${w.posts.length} short${w.posts.length === 1 ? '' : 's'}${w.views ? `, with ${fmt(w.views)} views and ${fmt(w.likes)} likes so far` : ''}.`);
    if (w.posts[0].views) lines.push(`The best one was "${w.posts[0].title}" at ${fmt(w.posts[0].views)} views.`);
    if (w.posts.length > 1) { lines.push('', 'What went out:'); for (const x of w.posts.slice(0, 8)) lines.push(`- ${x.title}${x.views ? ` (${fmt(x.views)} views)` : ''}`); }
  } else lines.push(`Nothing went out this week${w.review ? `, but ${w.review} new short${w.review === 1 ? ' is' : 's are'} in review` : ''}.`);
  lines.push('');
  if (w.next) lines.push(`Next week: ${w.next} short${w.next === 1 ? ' is' : 's are'} scheduled.`);
  else if (w.review || w.approved) lines.push(`Next week: ${w.review + w.approved} short${w.review + w.approved === 1 ? ' is' : 's are'} ready or in review and will be scheduled.`);
  else lines.push('Next week: we could use new footage. Send over any long videos, streams or raw clips when you can.');
  lines.push('', 'Any notes on what you want more or less of, just reply here.', '', 'Thanks,', ctx.setting('messaging.signature', 'Euclidean Media'));
  return { subject: `Your week: ${w.posts.length} short${w.posts.length === 1 ? '' : 's'} posted${w.views ? `, ${fmt(w.views)} views` : ''}`, body: lines.join('\n') };
}

function contactOf(client) { return ctx.store.get('contacts', client.primaryContactId || (client.contactIds || [])[0]) || ctx.store.find('contacts', (c) => c.clientId === client.id && (c.emails || []).length); }

/** Draft one client's report into Approvals. Returns { drafted, why }. */
function draft(clientId, actor = 'scheduler') {
  const client = ctx.store.get('clients', clientId); if (!client) return { drafted: false, why: 'Client not found.' };
  const contact = contactOf(client);
  if (!contact || !(contact.emails || []).length) return { drafted: false, why: `${client.name} has no contact with an email address. Add one on their client page.` };
  const w = week(client); const { subject, body } = write(client, contact, w);
  const msg = require('./messaging').createOutbound({ contactId: contact.id, channel: 'email', subject, body, aiGenerated: true, category: 'report', actor, approvalNote: 'Weekly report: check the numbers, then Approve to send.' });
  audit.log(actor, 'report.drafted', { clientId, posts: w.posts.length, views: w.views });
  return { drafted: true, messageId: msg?.id || null, subject };
}
function preview(clientId) { const c = ctx.store.get('clients', clientId); if (!c) return null; const w = week(c); return { ...write(c, contactOf(c), w), week: { posts: w.posts.length, views: w.views, likes: w.likes, next: w.next, review: w.review } }; }
function runAll(actor = 'user') { return ctx.store.all('clients', (c) => c.status === 'active').map((c) => ({ client: c.name, ...draft(c.id, actor) })); }

/** Scheduler, every minute: on the set day, after the set time, once per client per week. */
function tick() {
  const c = cfg(); if (!c.on) return;
  const tz = ctx.setting('agency.timezone', 'America/New_York');
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date()).map((x) => [x.type, x.value]));
  if (DAYS.indexOf(parts.weekday) !== Number(c.day) || `${parts.hour}:${parts.minute}` < String(c.at)) return;
  const today = `${parts.year}-${parts.month}-${parts.day}`;
  for (const client of ctx.store.all('clients', (x) => x.status === 'active' && x._reportDay !== today)) {
    ctx.store.update('clients', client.id, () => ({ _reportDay: today }));
    try { const r = draft(client.id); if (!r.drafted) audit.log('system', 'report.skipped', { clientId: client.id, why: r.why }, 'warn'); } catch (e) { audit.log('system', 'report.error', { clientId: client.id, error: e.message }, 'warn'); }
  }
  ctx.store.settings._reportLast = new Date().toISOString(); ctx.store.touch();
}

module.exports = { week, write, draft, preview, runAll, tick, cfg, DAYS };
