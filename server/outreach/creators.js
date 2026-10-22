'use strict';
/**
 * Creator outreach lane: scout creators (political/news commentary and
 * creators who want to build into YouTube), research their public channel,
 * and write a tailored email offering the Shorts package or full YouTube
 * management. Creators never receive sample videos; email only.
 */
const ctx = require('../core/ctx');
const audit = require('../core/audit');
const events = require('../core/events');
const ai = require('../integrations/ai');
const creatorsSvc = require('../integrations/creators');
const messaging = require('../automation/messaging');
const { website, nameMatch } = require('../political/sources');
const { withFooter, noDashes, isGov, excluded } = require('./common');
const { now } = require('../core/util');
const learning = require('./learning');

const O = (k, d) => ctx.setting(`creatorOffers.${k}`, d);
const EMAIL_RX = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

const SCOUT_SYSTEM = `You find potential clients for Euclidean Media, a short-form and YouTube agency. Targets: creators who cover politics, news and current events (in the vein of Guy Valenti, Uniting Now, Aaron Rupar), and creators with an audience on TikTok, Instagram, X or podcasts who don't have a real YouTube presence yet and could build into YouTube.
Rules: research only real, active creators. Never make up contact details: only give an email if it is publicly listed by the creator (channel about page, website, link-in-bio); otherwise leave it empty. No government emails. Use no em dashes.
Return JSON: {"creators":[{"name":"","platform":"youtube|tiktok|instagram|x|podcast","handle":"@handle","url":"main profile URL","youtube":"their YouTube channel URL or empty","followers":number|null,"why":"one line: why they fit","publicContact":"publicly listed business email or empty","confidence":"high|medium|low"}]}`;

function offerFor(p) {
  const hasYT = /youtube\.com/.test(p.handle || '') || (p.platforms || []).includes('youtube') || p.research?.youtube;
  const lead = !hasYT ? 'youtube' : O('lead', 'shorts');
  return { key: lead, ...(ctx.setting(`creatorOffers.${lead}`, {}) || {}) };
}

async function research(p) {
  const out = { emails: [], youtube: null, stats: null, about: '', links: [] };
  const target = creatorsSvc.classify(p.handle || '') || creatorsSvc.classify(p.research?.youtube || '') || null;
  if (target?.platform === 'youtube' || /youtube\.com/.test(p.research?.youtube || '')) {
    try {
      const s = await creatorsSvc.fetchStats({ platform: 'youtube', url: target?.platform === 'youtube' ? target.url : p.research.youtube });
      out.youtube = target?.url || p.research?.youtube; out.stats = { followers: s.followers, totalVideos: s.totalVideos, recent: (s.videos || []).slice(0, 12).map((v) => ({ title: v.title, views: v.views, kind: v.kind, date: v.date })) };
      out.about = s.about || '';
    } catch (e) { out.error = e.message; }
  }
  for (const m of String(out.about).matchAll(EMAIL_RX)) out.emails.push({ email: m[0].toLowerCase(), where: 'YouTube about' });
  const site = /^https?:\/\//.test(p.website || '') ? p.website : null;
  if (site) { try { const w = await website(site, { source: () => 0, raw: () => {} }, 'Website'); out.emails.push(...w.emails.map((e) => ({ email: e.email, where: e.page }))); out.links = w.socials; } catch { /* unreachable */ } }
  return out;
}

async function writeEmail(p, r, offer, notes = []) {
  const sender = O('senderName', '') || ctx.setting('political.senderName', '') || ctx.setting('agency.founders', [])[0]?.name || '';
  const booking = O('bookingUrl', '') || ctx.setting('political.bookingUrl', '');
  const agency = ctx.setting('agency.name', 'Euclidean Media');
  const first = String(p.name).split(/\s+/)[0];
  const template = () => ({ subject: offer.key === 'youtube' ? `Building ${p.name} a YouTube channel` : `${p.name} x daily Shorts`, body: `Hi ${first},\n\n${p.why ? `${p.why}. ` : ''}We're ${agency}, and we run Shorts and YouTube for creators.\n\n${offer.name}: ${offer.price}. ${offer.details}\n\nCould you give us 20 minutes?${booking ? `\n\nPick a time: ${booking}` : ''}\n\nThanks,\n${sender || agency}`, agent: 'template' });
  if (!ai.anyConnected()) return template();
  const recent = (r.stats?.recent || []).slice(0, 8).map((v) => `- ${v.title} (${v.views ?? '?'} views, ${v.kind || 'video'}${v.date ? `, ${v.date}` : ''})`).join('\n');
  let res;
  try { res = await ai.ask({ role: 'writing', json: true, maxTokens: 1200, system: `You write first-touch emails for ${agency}, a Shorts and YouTube agency. Personal and specific to this creator's actual content, under 150 words, one clear ask (20 minutes), no hype, no invented numbers or results, no fake familiarity. Mention the offer in one or two plain lines. Never use em dashes. End with a simple opt-out line.${learning.writerBlock('creators')}${String(O('templates', '')).trim() ? `\nMatch the voice and structure of these house emails:\n${String(O('templates', '')).slice(0, 5000)}` : ''}`, prompt: `Creator: ${p.name} (${p.handle || ''}). Why they fit: ${p.why || 'n/a'}.\n${r.stats ? `YouTube: ${r.stats.followers ?? '?'} subscribers, ${r.stats.totalVideos ?? '?'} videos.\nRecent uploads:\n${recent}` : 'No YouTube channel found: pitch building one.'}\nOffer: ${offer.name}, ${offer.price}. ${offer.details}\n${booking ? `Booking link: ${booking}\n` : ''}Sign as: ${sender || agency}, ${agency}\n${notes.length ? `FOUNDER NOTES FOR THIS CREATOR (apply all; latest wins):\n${notes.map((n, i) => `${i + 1}. ${n.text}`).join('\n')}\n${p.outreach?.email ? `CURRENT DRAFT:\nSubject: ${p.outreach.email.subject}\n${p.outreach.email.body}\n` : ''}` : ''}Return {"subject":"≤8 words","body":"plain text"}` }); }
  catch (e) { audit.log('system', 'creators.writer_fallback', { prospectId: p.id, error: e.message }, 'warn'); return { ...template(), note: `AI writer unavailable (${e.message.slice(0, 80)}); used your template` }; }
  if (!res.json?.subject || !res.json?.body) return template();
  return { subject: res.json.subject, body: res.json.body, agent: `${res.provider}:${res.model}` };
}

/** Job: research one creator and leave a ready email draft (auto-sent only if autopilot allows). */
async function run(prospectId, h) {
  let p = ctx.store.get('prospects', prospectId); if (!p) throw Object.assign(new Error('Prospect not found'), { permanent: true });
  const set = (patch) => { ctx.store.update('prospects', p.id, (cur) => ({ outreach: { ...(cur.outreach || {}), ...patch } })); events.publish('prospects', { id: p.id }); };
  set({ status: 'running', error: null, startedAt: now() });
  try {
    h.progress(0.15, 'Researching their channel');
    const r = await research(p);
    const found = r.emails.filter((e) => !isGov(e.email));
    const patch = {};
    if (!p.publicContact && found[0]) { patch.publicContact = found[0].email; patch.contactVerified = true; }
    else if (p.publicContact && found.some((e) => e.email === String(p.publicContact).toLowerCase())) patch.contactVerified = true;
    if (r.stats?.followers && !p.followers) patch.followers = r.stats.followers;
    if (Object.keys(patch).length) p = ctx.store.update('prospects', p.id, patch);
    set({ research: r });
    const to = String(p.publicContact || '').trim().toLowerCase();
    if (!require('./common').isEmail(to)) { set({ status: 'needs_contact', note: 'No public business email found. Add one (or import it), then redo.' }); return { status: 'needs_contact' }; }
    if (isGov(to)) { set({ status: 'needs_contact', note: 'Government address; not contacted.' }); return { status: 'needs_contact' }; }
    const ex = excluded({ name: p.name, email: to, handle: p.handle }); if (ex) { set({ status: 'excluded', note: `On the exclusions list (${ex})` }); return { status: 'excluded' }; }
    h.progress(0.6, 'Writing the email');
    const offer = offerFor({ ...p, research: r });
    const em = await writeEmail(p, r, offer, p.outreach?.notes || []);
    let contact = p.contactId ? ctx.store.get('contacts', p.contactId) : ctx.store.find('contacts', (x) => (x.emails || []).includes(to));
    if (!contact) contact = ctx.store.insert('contacts', { name: p.name, phones: [], emails: [to], role: 'prospect', clientId: null, optedOut: {}, source: 'creator outreach' });
    if (contact.optedOut?.email) { set({ status: 'excluded', note: 'Opted out' }); return { status: 'opted_out' }; }
    ctx.store.update('prospects', p.id, { contactId: contact.id });
    const old = p.outreach?.messageId && ctx.store.get('messages', p.outreach.messageId);
    if (old?.status === 'pending_approval') messaging.rejectMessage(old.id, 'system');
    const fs = require('fs'); const path = require('path');
    const att = p.voiceNote && fs.existsSync(p.voiceNote) ? [{ name: path.basename(p.voiceNote), path: p.voiceNote, size: fs.statSync(p.voiceNote).size }] : [];
    const m = messaging.createOutbound({ contactId: contact.id, channel: 'email', subject: noDashes(em.subject), body: withFooter(em.body), aiGenerated: true, agent: em.agent, category: 'prospecting', actor: 'system', attachments: att });
    set({ email: { subject: em.subject, body: em.body }, status: 'ready', offer: offer.key, messageId: m.id, conversationId: m.conversationId, finishedAt: now(), agent: em.agent });
    if ((p.stage || 'new') === 'new') ctx.store.update('prospects', p.id, { stage: 'drafted' });
    if (!p.voiceNote) await require('./voicenote').auto(p);
    if (!require('./autopilot').maybeAutoSend(p.id)) events.publish('notify', { title: `Email ready: ${p.name}`, body: 'Waiting for your review in Growth → Creators.', route: '/growth' });
    return { status: 'ready' };
  } catch (e) { set({ status: 'failed', error: e.message }); throw e; }
}

/** Job: find new creators for a query, skip known ones, and start outreach for each. */
async function scout({ query, count = 15, autoPackage = true }, h, job) {
  const found = [];
  h.progress(0.1, 'Searching YouTube');
  try { for (const c of (await creatorsSvc.searchYouTube(query)).slice(0, count)) found.push({ name: c.name, platform: 'youtube', handle: c.url, followers: c.followers, why: c.about || '', publicContact: '', confidence: 'medium', source: 'youtube' }); } catch (e) { h.log?.(`YouTube search: ${e.message}`); }
  if (ai.anyConnected()) {
    h.progress(0.4, 'Research agent searching');
    try {
      const r = await ai.ask({ role: 'research', json: true, search: true, maxTokens: 3500, system: SCOUT_SYSTEM + learning.scoutBlock('creators'), prompt: `Find up to ${count} creators: ${query}` });
      for (const c of r.json.creators || []) found.push({ name: c.name, platform: c.platform, handle: c.youtube || c.url || c.handle, followers: typeof c.followers === 'number' ? c.followers : null, why: c.why || '', publicContact: c.publicContact || '', confidence: c.confidence || 'medium', source: 'research', agent: `${r.provider}:${r.model}` });
    } catch (e) { h.log?.(`Research agent: ${e.message}`); }
  }
  if (!found.length) throw Object.assign(new Error('No creators found. Try a broader description, or connect an AI provider.'), { permanent: true });
  const created = [];
  for (const c of found) {
    if (created.length >= count) break;
    if (!c.name || ctx.store.find('prospects', (y) => nameMatch(y.name, c.name) && nameMatch(c.name, y.name))) continue;
    if (excluded({ name: c.name, email: c.publicContact, handle: c.handle })) continue;
    // A contact suggested by the agent is only a hint; research must confirm it before autopilot uses it.
    const pr = ctx.store.insert('prospects', { triage: autoPackage ? 'approved' : 'pending', name: c.name, type: 'creator', handle: c.handle || '', platforms: [c.platform].filter(Boolean), why: c.why, angle: '', publicContact: isGov(c.publicContact) ? '' : c.publicContact, followers: c.followers, confidence: c.confidence, stage: 'new', verified: c.source === 'youtube', contactVerified: false, source: c.source, agent: c.agent, query });
    created.push(pr);
    if (autoPackage) require('../jobs/queue').enqueue('creator.outreach', { prospectId: pr.id, name: pr.name }, { actor: job?.createdBy || 'autopilot', priority: 5, dedupeKey: `crout:${pr.id}` });
  }
  events.publish('prospects', {});
  if (created.length) events.publish('notify', { title: `${created.length} new creator lead${created.length === 1 ? '' : 's'}`, body: created.slice(0, 5).map((x) => x.name).join(', '), route: '/growth' });
  audit.log(job?.createdBy || 'system', 'creators.scouted', { query, count: created.length });
  return { added: created.length };
}

/** Apply a founder note to a creator email: keeps the old version, rewrites, replaces the draft. */
async function revise(prospectId, { note, actor = 'user' }, h) {
  const p = ctx.store.get('prospects', prospectId); if (!p) throw Object.assign(new Error('Prospect not found'), { permanent: true });
  const versions = [...(p.outreach?.versions || [])]; if (p.outreach?.email) versions.push({ n: versions.length + 1, at: now(), label: `Before: ${String(note).slice(0, 60)}`, email: p.outreach.email });
  ctx.store.update('prospects', p.id, (cur) => ({ outreach: { ...(cur.outreach || {}), versions, notes: [...(cur.outreach?.notes || []), { text: String(note || '').slice(0, 1000), at: now(), by: actor }] } }));
  return run(prospectId, h);
}

module.exports = { revise, run, scout, research, offerFor, SCOUT_SYSTEM };
