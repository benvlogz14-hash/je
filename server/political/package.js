'use strict';
/**
 * Political outreach package for one prospect:
 *   research → brief (cited) → creative (storyboard, email, call script) →
 *   vertical video → horizontal video → one-page sheet → email draft in Approvals.
 *
 * Every step's result is saved on the prospect (prospect.pkg), so any step can
 * be re-run on its own. Nothing is ever sent from here: the email lands in
 * Approvals and waits for a founder.
 */
const fs = require('fs');
const path = require('path');
const ctx = require('../core/ctx');
const paths = require('../core/paths');
const audit = require('../core/audit');
const events = require('../core/events');
const secrets = require('../core/secrets');
const ai = require('../integrations/ai');
const ff = require('../video/ffmpeg');
const messaging = require('../automation/messaging');
const sources = require('./sources');
const render = require('./render');
const { now, safeJson } = require('../core/util');

const STEPS = [
  ['research', 'Research public records'],
  ['brief', 'Write the brief'],
  ['creative', 'Storyboard, email and call script'],
  ['video_v', 'Vertical video'],
  ['video_h', 'Horizontal video'],
  ['sheet', 'One-page sheet'],
  ['email', 'Email draft for approval'],
];

const S = (k, d) => ctx.setting(`political.${k}`, d);
function dirFor(p) { const d = path.join(paths.root, 'political', p.id); fs.mkdirSync(d, { recursive: true }); return d; }
function save(id, patch) {
  const p = ctx.store.update('prospects', id, (cur) => ({ pkg: { ...(cur.pkg || {}), ...patch(cur.pkg || {}) } }));
  events.publish('prospects', { id }); return p;
}
function setStep(id, step, st) { return save(id, (pkg) => ({ steps: { ...(pkg.steps || {}), [step]: { ...(pkg.steps?.[step] || {}), ...st, at: now() } }, step: st.status === 'running' ? step : pkg.step })); }

// ------------------------------------------------------------------ material for the writers

function material(pkg) {
  const src = (pkg.sources || []).map((s) => `[${s.n}] ${s.title} — ${s.url}`).join('\n');
  const facts = (pkg.facts || []).map((f) => `- (${f.topic}) ${f.text} [${f.src}]`).join('\n');
  const text = (pkg.text || []).map((t) => `--- from [${t.src}] ---\n${t.text}`).join('\n\n').slice(0, 24000);
  const pr = pkg.profile || {};
  const head = [`Name: ${pr.name}`, pr.office && `Office: ${pr.office}`, pr.party && `Party: ${pr.party}`, pr.sites?.length && `Websites: ${pr.sites.join(', ')}`, pr.socials?.length && `Social accounts: ${pr.socials.join(', ')}`, pr.contact && `Public contact email: ${pr.contact}`].filter(Boolean).join('\n');
  return `${head}\n\nSOURCES\n${src}\n\nFACTS\n${facts}\n\nSOURCE TEXT\n${text}`;
}
const norm = (s) => String(s || '').toLowerCase().replace(/[“”"'’‘]/g, '').replace(/[^a-z0-9$%]+/g, ' ').trim();

// ------------------------------------------------------------------ steps

async function stepResearch(p, h) {
  const r = await sources.lookup({ name: p.name, hint: p.location || p.why || '', campaignSite: /^https?:/.test(p.handle || '') ? p.handle : null, dir: dirFor(p), onStep: (s) => h.progress(0.05, `Researching: ${s}`) });
  if (!r.sources.length) throw Object.assign(new Error(`No public records found for "${p.name}". Check the spelling, or add their office and state to the prospect.`), { permanent: true });
  save(p.id, () => ({ profile: r.profile, sources: r.sources, facts: r.facts, text: r.text, researchErrors: r.errors }));
  const patch = {};
  if (!p.publicContact && r.profile.contact) patch.publicContact = r.profile.contact;
  if (!p.location && r.profile.office) patch.location = r.profile.office;
  if (Object.keys(patch).length) ctx.store.update('prospects', p.id, patch);
  return `${r.sources.length} sources${r.errors.length ? ` (${r.errors.length} unavailable)` : ''}`;
}

async function stepBrief(p) {
  const pkg = p.pkg;
  if (!ai.anyConnected()) { save(p.id, () => ({ brief: fallbackBrief(pkg) })); return 'Basic brief (connect an AI provider for a full one)'; }
  const r = await ai.ask({ role: 'research', json: true, maxTokens: 3000, system: `You are a political research analyst for ${ctx.setting('agency.name', 'Euclidean Media')}, a short-form video agency. Write a briefing on a public official or candidate using ONLY the material provided. After every factual claim put its source number in brackets like [3]. If the material doesn't support something, leave it out. Public, professional information only: never include home addresses, family members, health or other personal details. Be neutral and factual.`, prompt: `${material(pkg)}\n\nReturn JSON: {"headline":"one line: who they are","summary":"2-3 sentences with citations","sections":[{"title":"Office & district","points":["... [n]"]},{"title":"Record & priorities","points":[]},{"title":"Fundraising","points":[]},{"title":"In the news","points":[]},{"title":"Online presence","points":[]}],"themes":["3-5 issues they clearly care about, short phrases"],"contentGaps":["2-4 observations about their video/social presence an agency could help with; say 'unverified' when unsure"],"angle":"one sentence: the most natural reason they'd want our videos"}` });
  const b = r.json || {};
  b.agent = `${r.provider}:${r.model}`;
  save(p.id, () => ({ brief: b }));
  return 'Brief written';
}

function fallbackBrief(pkg) {
  const by = (t) => (pkg.facts || []).filter((f) => f.topic === t).map((f) => `${f.text} [${f.src}]`);
  return {
    headline: [pkg.profile?.name, pkg.profile?.office].filter(Boolean).join(' — '),
    summary: by('overview')[0] || '',
    sections: [['Office & district', [...by('office'), ...by('party'), ...by('tenure')]], ['Fundraising', by('money')], ['In the news', by('news').slice(0, 6)], ['Online presence', by('web')]].filter(([, pts]) => pts.length).map(([title, points]) => ({ title, points })),
    themes: [], contentGaps: [], angle: '', agent: 'basic',
  };
}

const SCENE_DOC = `Scene types (fields; keep text SHORT, it's on-screen):
- {"type":"hook","headline":"≤8 words, wrap 1-2 key words in *asterisks* for colour","sub":"≤10 words","badge":"optional ≤2 words"}
- {"type":"portrait","headline":"their name","sub":"their office ≤8 words","badge":"optional"}
- {"type":"stat","kicker":"≤4 words","value":"≤10 characters, e.g. $2.4M or 14 BILLS","label":"≤10 words"}
- {"type":"issues","headline":"≤6 words with *highlight*","items":["2-4 items, ≤5 words each"]}
- {"type":"quote","quote":"≤25 words, VERBATIM from the source text","source":"who/where, ≤8 words"}
- {"type":"cta","headline":"≤6 words","button":"their website or a short call to action","sub":"≤8 words"}
- {"type":"end","headline":"their name or slogan","sub":"≤6 words"}
Optional "sec" per scene (seconds, 3-8).`;

async function stepCreative(p) {
  const pkg = p.pkg; const seconds = Math.max(15, Math.min(240, Number(S('videoSeconds', 40)) || 40));
  const nScenes = Math.max(5, Math.min(45, Math.round(seconds / 5)));
  const offer = S('offer', '');
  const booking = S('bookingUrl', '');
  const sender = S('senderName', '') || ctx.setting('agency.founders', [])[0]?.name || '';
  if (!ai.anyConnected()) { save(p.id, () => ({ creative: fallbackCreative(p, pkg, { nScenes, booking, sender }) })); return 'Template creative (connect an AI provider for tailored work)'; }
  const templates = String(S('templates', '') || '').trim();
  const r = await ai.ask({ role: 'writing', json: true, maxTokens: 4000, system: `You create outreach for ${ctx.setting('agency.name', 'Euclidean Media')}, a short-form video agency for political campaigns. You make a sample ad concept for the official/candidate, written as if for THEIR audience (constituents/voters), positive and upbeat, in a bubbly, poppy style. Rules: use only facts in the material; numbers and quotes must appear in the material (quotes word for word) or be left out; no attacks on opponents; never claim endorsements or results you can't show; no personal details. The email is personal, specific and short (under 170 words), offers the two attached videos free to use whether or not they talk to us, asks for 20 minutes, and ends with a simple opt-out line.`, prompt: `${material(pkg)}\n\nBRIEF\n${JSON.stringify(pkg.brief || {}).slice(0, 6000)}\n\n${templates ? `HOUSE EMAIL TEMPLATES (match this voice and structure):\n${templates.slice(0, 6000)}\n\n` : ''}OFFER: ${offer || 'Two free tailored videos (vertical and horizontal) they can use free of charge whether or not they talk to us. Ask for 20 minutes.'}\n${booking ? `Booking link: ${booking}\n` : ''}${sender ? `Sign as: ${sender}, ${ctx.setting('agency.name', 'Euclidean Media')}\n` : ''}
Make a storyboard of about ${nScenes} scenes (~${seconds} seconds) that starts with a hook, includes a portrait scene, and ends with a cta then an end scene.
${SCENE_DOC}

Return JSON: {"storyboard":[...scenes],"email":{"subject":"≤8 words, specific to them","body":"plain text"},"callScript":"a 60-second script for a person calling their campaign office: intro, why them, the free videos, the 20-minute ask, handling 'send me an email'","voiceNote":"a 20-second friendly voice note from the sender saying what's in the email","narration":"an optional upbeat voiceover for the ad, one line per scene, from a narrator (not the official)"}` });
  const c = r.json || {};
  c.storyboard = vetStoryboard(c.storyboard, pkg, p);
  c.agent = `${r.provider}:${r.model}`;
  save(p.id, () => ({ creative: c }));
  return `${c.storyboard.length} scenes, email and call script`;
}

/** Keep the storyboard honest: drop quotes and numbers that aren't in the research. */
function vetStoryboard(list, pkg, p) {
  const all = [...(pkg.facts || []).map((f) => f.text), ...(pkg.text || []).map((t) => t.text)].join(' ');
  const corpus = norm(all); const numbers = all.toLowerCase().replace(/(\d),(?=\d{3})/g, '$1');
  const ok = [];
  for (const s of Array.isArray(list) ? list : []) {
    if (!s || typeof s !== 'object') continue;
    const type = ['hook', 'portrait', 'stat', 'issues', 'quote', 'cta', 'end'].includes(s.type) ? s.type : 'hook';
    if (type === 'quote' && !(s.quote && corpus.includes(norm(s.quote).slice(0, 80)))) continue;
    if (type === 'stat') { const digits = String(s.value || '').replace(/(\d),(?=\d{3})/g, '$1').match(/\d+(?:\.\d+)?/g) || []; if (digits.some((d) => !new RegExp(`(^|[^\\d.])${d.replace('.', '\\.')}(?![\\d])`).test(numbers))) continue; }
    ok.push({ ...s, type });
  }
  if (!ok.some((s) => s.type === 'portrait')) ok.splice(Math.min(1, ok.length), 0, { type: 'portrait', headline: p.name, sub: pkg.profile?.office || '' });
  if (!ok.length || ok[ok.length - 1].type !== 'end') ok.push({ type: 'end', headline: p.name, sub: pkg.profile?.office ? shortOffice(pkg.profile.office) : '' });
  return ok.slice(0, 50);
}
const shortOffice = (o) => String(o).replace(/United States/i, 'U.S.').slice(0, 40);

function fallbackCreative(p, pkg, { booking, sender }) {
  const pr = pkg.profile || {}; const first = p.name.split(/\s+/)[0];
  const money = pr.money?.raised ? `$${(pr.money.raised / 1e6).toFixed(1)}M` : null;
  const sb = [
    { type: 'hook', headline: `Meet *${p.name}*`, sub: shortOffice(pr.office || ''), badge: pr.party ? pr.party.split(' ')[0] : '' },
    { type: 'portrait', headline: p.name, sub: shortOffice(pr.office || '') },
    money ? { type: 'stat', kicker: `${pr.money.cycle} cycle`, value: money, label: 'raised from supporters' } : null,
    { type: 'cta', headline: `Stand with *${first}*`, button: (pr.sites?.[0] || '').replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '') || 'Learn more', sub: '' },
    { type: 'end', headline: p.name, sub: shortOffice(pr.office || '') },
  ].filter(Boolean);
  const agency = ctx.setting('agency.name', 'Euclidean Media');
  return {
    storyboard: sb,
    email: { subject: `Two free videos for ${p.name}`, body: `Hi ${first} team,\n\nWe made two short videos for ${p.name}: one vertical for Reels/TikTok/Shorts and one horizontal for YouTube and the web. They're attached, and they're yours to use free of charge, whether or not you decide to talk with us.\n\nWe're ${agency}, a short-form video team for campaigns. Could you give us 20 minutes to show what a month of this could look like?${booking ? `\n\nPick a time: ${booking}` : ''}\n\nThanks,\n${sender || agency}\n\nIf you'd rather not hear from us, just reply "stop" and we won't email again.` },
    callScript: `Hi, this is ${sender || 'a producer'} with ${agency}. We make short videos for campaigns, and we put together two free sample videos for ${p.name} — one vertical, one horizontal. They're free to use either way. Who's the best person to send them to? And could we get 20 minutes with whoever handles digital?`,
    voiceNote: `Hey, it's ${sender || 'the team'} from ${agency}. We made two quick videos for ${p.name} — they're attached and free to use. If you've got 20 minutes this week, we'd love to show you more.`,
    narration: '', agent: 'template',
  };
}

async function stepVideo(p, h, vertical) {
  const c = p.pkg.creative; if (!c?.storyboard?.length) throw new Error('Run the storyboard step first.');
  const dir = dirFor(p); const out = path.join(dir, `${slugName(p.name)} - ${vertical ? 'vertical' : 'horizontal'}.mp4`);
  const music = pickMusic();
  let narration = null;
  if (S('narration', false) && c.narration && ai.connected('openai')) {
    narration = path.join(dir, 'narration.mp3');
    if (!fs.existsSync(narration)) { try { await tts(c.narration, narration); } catch (e) { narration = null; audit.log('system', 'political.tts_failed', { prospectId: p.id, error: e.message }, 'warn'); } }
  }
  const res = await render.renderVideo({ scenes: c.storyboard, info: { name: p.name, photo: p.pkg.profile?.photo, party: p.pkg.profile?.party, theme: S('theme', 'auto') === 'auto' ? null : S('theme') }, vertical, out, work: path.join(dir, vertical ? 'work_v' : 'work_h'), music, narration, onProgress: (f, t) => h.progress(f, t) });
  const poster = path.join(dir, vertical ? 'poster_v.jpg' : 'poster_h.jpg');
  await ff.thumbnail(out, poster, Math.min(5, res.duration / 3), vertical ? 540 : 960).catch(() => {});
  fs.rmSync(path.join(dir, vertical ? 'work_v' : 'work_h'), { recursive: true, force: true });
  save(p.id, (pkg) => ({ files: { ...(pkg.files || {}), [vertical ? 'v' : 'h']: out, [vertical ? 'posterV' : 'posterH']: poster } }));
  return `${Math.round(res.duration)}s · ${(fs.statSync(out).size / 1e6).toFixed(1)} MB`;
}

function pickMusic() {
  const dir = S('musicDir', '');
  try { const list = fs.readdirSync(dir).filter((f) => /\.(mp3|m4a|wav|aac|ogg)$/i.test(f)); if (list.length) return path.join(dir, list[(Math.random() * list.length) | 0]); } catch { /* none */ }
  return null;
}

async function tts(text, out) {
  const key = secrets.get(ai.PROVIDERS.openai.keyName);
  const res = await fetch('https://api.openai.com/v1/audio/speech', { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: S('ttsModel', 'gpt-4o-mini-tts'), voice: S('voice', 'alloy'), input: String(text).slice(0, 4000), instructions: 'Upbeat, warm, energetic narrator for a short campaign video.' }), signal: AbortSignal.timeout(120000) });
  if (!res.ok) throw new Error(`OpenAI voice ${res.status}`);
  fs.writeFileSync(out, Buffer.from(await res.arrayBuffer()));
}

async function stepSheet(p) {
  const dir = dirFor(p); const pkg = p.pkg; const pr = pkg.profile || {};
  const T = render.themeFor(pr.party, S('theme', 'auto') === 'auto' ? null : S('theme'));
  const agency = ctx.setting('agency.name', 'Euclidean Media'); const booking = S('bookingUrl', '');
  const sender = S('senderName', '') || ctx.setting('agency.founders', [])[0]?.name || '';
  const img = (f) => (f && fs.existsSync(f) ? render.fileUrl(f) : '');
  const e = render.esc;
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>${render.css(T)}
@page{size:Letter;margin:0} body{width:8.5in;height:11in;background:linear-gradient(160deg,${T.bg1},${T.bg2});padding:.55in .6in;font-weight:600;position:relative}
h1{font:800 34px/1.05 Pop;color:${T.ink};letter-spacing:-.02em} h1 b{color:${T.a}}
.lead{font:600 15px/1.45 Pop;color:${T.ink};margin-top:10px;max-width:6.4in}
.vids{display:flex;gap:.3in;margin-top:.35in;align-items:flex-end}
.v{background:#fff;border-radius:22px;padding:12px;box-shadow:0 8px 0 ${T.soft},0 18px 40px rgba(20,30,80,.14)}
.v img{display:block;border-radius:14px;object-fit:cover} .v div{font:800 13px Pop;color:${T.ink};margin-top:8px;text-align:center}
.box{background:#fff;border-radius:22px;padding:18px 22px;margin-top:.3in;box-shadow:0 8px 0 ${T.soft}}
.box h3{font:800 18px Pop;color:${T.a};margin-bottom:6px} .box p,.box li{font:600 13.5px/1.5 Pop;color:${T.ink}} .box ul{padding-left:18px}
.ask{margin-top:.3in;border-radius:999px;background:linear-gradient(120deg,${T.a},${T.b});color:#fff;font:800 22px Pop;text-align:center;padding:16px}
.foot{position:absolute;left:.6in;right:.6in;bottom:.45in;font:600 11px/1.4 Pop;color:${T.ink};opacity:.75;display:flex;justify-content:space-between}
.dot{position:absolute;border-radius:50%}
</style></head><body>
<div class="dot" style="right:.5in;top:.45in;width:90px;height:90px;background:${T.c}"></div><div class="dot" style="right:1.35in;top:.3in;width:34px;height:34px;background:${T.b}"></div>
<h1>Two free videos for<br><b>${e(p.name)}</b></h1>
<div class="lead">${e(cap(pr.office || ''))}${pr.office ? '. ' : ''}We made a vertical and a horizontal video from your public record. They're attached to our email and <b style="color:${T.a}">yours to use free of charge</b>, whether or not you decide to talk with us.</div>
<div class="vids">
  ${img(pkg.files?.posterV) ? `<div class="v"><img src="${img(pkg.files.posterV)}" style="width:2.1in;height:3.73in"><div>Vertical · Reels, TikTok, Shorts</div></div>` : ''}
  ${img(pkg.files?.posterH) ? `<div class="v" style="flex:1"><img src="${img(pkg.files.posterH)}" style="width:100%;height:2.3in"><div>Horizontal · YouTube, web, email</div></div>` : ''}
</div>
<div class="box"><h3>What we do</h3><ul><li>Bubbly, scroll-stopping short videos about your work, made from your public record and your footage</li><li>Ready for every platform, vertical and horizontal</li><li>Fast turnaround, and you approve everything before it posts</li></ul></div>
<div class="ask">Could you give us 20 minutes?</div>
<div class="foot"><span>${e(sender)}${sender ? ' · ' : ''}${e(agency)}${booking ? ` · ${e(booking)}` : ''}</span><span>Concept videos. Not authorized by or affiliated with ${e(p.name)}.${pr.photoCredit ? ` Photo: ${e(pr.photoCredit)}.` : ''}</span></div>
</body></html>`;
  const hf = path.join(dir, 'sheet.html'); fs.writeFileSync(hf, html);
  const out = path.join(dir, `${slugName(p.name)} - Euclidean Media.pdf`);
  await render.printPdf(hf, out, path.join(dir, 'work_pdf'));
  fs.rmSync(path.join(dir, 'work_pdf'), { recursive: true, force: true });
  save(p.id, (pk) => ({ files: { ...(pk.files || {}), sheet: out } }));
  return 'Sheet ready';
}

function stepEmail(p, actor) {
  const pkg = p.pkg; const c = pkg.creative; if (!c?.email) throw new Error('Run the storyboard step first.');
  const to = (p.publicContact && /@/.test(p.publicContact) ? p.publicContact : pkg.profile?.contact || '').trim().toLowerCase();
  if (!to) { save(p.id, () => ({ status: 'needs_contact' })); return { skip: true, note: 'No public campaign email found. Add one on the prospect, then re-run this step.' }; }
  if (/\.gov$/.test(to) && !S('allowGov', false)) { save(p.id, () => ({ status: 'needs_contact' })); return { skip: true, note: `${to} is a government office address. Add a campaign or press email instead.` }; }
  let contact = p.contactId ? ctx.store.get('contacts', p.contactId) : ctx.store.find('contacts', (x) => (x.emails || []).includes(to));
  if (!contact) contact = ctx.store.insert('contacts', { name: p.name, phones: [], emails: [to], role: 'prospect', clientId: null, optedOut: {}, source: 'political' });
  else if (!(contact.emails || []).includes(to)) contact = ctx.store.update('contacts', contact.id, { emails: [...contact.emails, to] });
  if (contact.optedOut?.email) return { skip: true, note: `${p.name} opted out of email.` };
  ctx.store.update('prospects', p.id, { contactId: contact.id });
  // Replace an earlier unsent draft instead of stacking duplicates.
  if (pkg.messageId) { const old = ctx.store.get('messages', pkg.messageId); if (old?.status === 'pending_approval') messaging.rejectMessage(old.id, actor); }
  const att = [pkg.files?.v, pkg.files?.h, pkg.files?.sheet].filter((f) => f && fs.existsSync(f)).map((f) => ({ name: path.basename(f), path: f, size: fs.statSync(f).size }));
  const m = messaging.createOutbound({ contactId: contact.id, channel: 'email', subject: c.email.subject, body: c.email.body, aiGenerated: true, agent: c.agent, category: 'prospecting', actor, attachments: att });
  save(p.id, () => ({ messageId: m.id, conversationId: m.conversationId }));
  if ((p.stage || 'new') === 'new') ctx.store.update('prospects', p.id, { stage: 'drafted' });
  return { note: `Waiting for approval · ${att.length} attachments (${(att.reduce((s, a) => s + a.size, 0) / 1e6).toFixed(1)} MB)` };
}

const cap = (t) => String(t).charAt(0).toUpperCase() + String(t).slice(1);
const slugName = (n) => String(n).replace(/[^\w\- .]+/g, '').trim().slice(0, 60) || 'Prospect';

// ------------------------------------------------------------------ runner

/** Run the package from `from` (a step key) to the end. Used by the political.package job. */
async function run(prospectId, { from = 'research', only = null, actor = 'system' } = {}, h) {
  let p = ctx.store.get('prospects', prospectId); if (!p) throw Object.assign(new Error('Prospect not found'), { permanent: true });
  const keys = STEPS.map((s) => s[0]); const start = Math.max(0, keys.indexOf(from));
  const todo = only ? [only] : keys.slice(start);
  save(p.id, () => ({ status: 'running', startedAt: now(), error: null }));
  const total = todo.length;
  for (let i = 0; i < todo.length; i++) {
    const step = todo[i]; p = ctx.store.get('prospects', prospectId);
    const label = STEPS.find((s) => s[0] === step)[1];
    setStep(p.id, step, { status: 'running', error: null });
    const sub = { progress: (f, t) => h.progress((i + Math.max(0, Math.min(1, f))) / total, t || label) };
    sub.progress(0, label);
    try {
      let note;
      if (step === 'research') note = await stepResearch(p, sub);
      else if (step === 'brief') note = await stepBrief(p);
      else if (step === 'creative') note = await stepCreative(p);
      else if (step === 'video_v') note = await stepVideo(p, sub, true);
      else if (step === 'video_h') note = await stepVideo(p, sub, false);
      else if (step === 'sheet') note = await stepSheet(p);
      else if (step === 'email') { const r = stepEmail(p, actor); note = r.note; if (r.skip) { setStep(p.id, step, { status: 'skipped', note }); continue; } }
      setStep(p.id, step, { status: 'done', note });
    } catch (e) {
      setStep(p.id, step, { status: 'failed', error: e.message });
      save(p.id, () => ({ status: 'failed', error: `${label}: ${e.message}` }));
      throw e;
    }
  }
  p = ctx.store.get('prospects', prospectId);
  if (p.pkg.status !== 'needs_contact') save(p.id, () => ({ status: 'ready', finishedAt: now() }));
  audit.log(actor, 'political.package_ready', { prospectId, name: p.name });
  if (!only) events.publish('notify', { title: `Package ready: ${p.name}`, body: p.pkg.status === 'needs_contact' ? 'Needs a campaign email before the draft can be made.' : 'Email with both videos is waiting in Approvals.' });
  return { status: ctx.store.get('prospects', prospectId).pkg.status };
}

module.exports = { STEPS, run, dirFor, fallbackCreative, vetStoryboard, material };
