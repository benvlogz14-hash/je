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
const render = require('../video/motion');
const { now, safeJson } = require('../core/util');
const { withFooter, isGov, excluded, noDashes } = require('../outreach/common');
const learning = require('../outreach/learning');

const STEPS = [
  ['research', 'Research public records'],
  ['brief', 'Write the brief'],
  ['opponent', 'Research the opponent'],
  ['creative', 'Ad scripts, email and call script'],
  ['video_v', 'Short vertical ad'],
  ['video_h', 'Short horizontal ad'],
  ['video_hl', 'Long horizontal ad'],
  ['sheet', 'One-page sheet'],
  ['email', 'Email ready'],
];
const VIDEOS = { v: { step: 'video_v', vertical: true, board: 'short', label: 'short vertical' }, h: { step: 'video_h', vertical: false, board: 'short', label: 'short horizontal' }, hl: { step: 'video_hl', vertical: false, board: 'long', label: 'long horizontal' } };
const DEFAULT_PLAN = '12 posts a week for $949';

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
  const opp = pkg.opp ? `\nOPPONENT: ${pkg.opp.name}${pkg.opp.profile?.office ? `, ${pkg.opp.profile.office}` : ''}${pkg.opp.profile?.party ? ` (${pkg.opp.profile.party})` : ''}. Facts about the opponent are marked (opponent:...).` : '';
  const text = (pkg.text || []).map((t) => `--- from [${t.src}] ---\n${t.text}`).join('\n\n').slice(0, 24000);
  const pr = pkg.profile || {};
  const head = [`Name: ${pr.name}`, pr.office && `Office: ${pr.office}`, pr.party && `Party: ${pr.party}`, pr.sites?.length && `Websites: ${pr.sites.join(', ')}`, pr.socials?.length && `Social accounts: ${pr.socials.join(', ')}`, pr.contact && `Public contact email: ${pr.contact}`].filter(Boolean).join('\n');
  return `${head}${opp}\n\nSOURCES\n${src}\n\nFACTS\n${facts}\n\nSOURCE TEXT\n${text}`;
}
const norm = (s) => String(s || '').toLowerCase().replace(/[“”"'’‘]/g, '').replace(/[^a-z0-9$%]+/g, ' ').trim();

// ------------------------------------------------------------------ steps

async function stepResearch(p, h) {
  const r = await sources.lookup({ name: p.name, hint: p.location || p.why || '', campaignSite: /^https?:/.test(p.handle || '') ? p.handle : null, dir: dirFor(p), onStep: (s) => h.progress(0.05, `Researching: ${s}`) });
  if (!r.sources.length) throw Object.assign(new Error(`No public records found for "${p.name}". Check the spelling, or add their office and state to the prospect.`), { permanent: true });
  save(p.id, () => ({ profile: r.profile, sources: r.sources, facts: r.facts, text: r.text, researchErrors: r.errors }));
  const patch = {};
  if (!p.publicContact && r.profile.contact) { patch.publicContact = r.profile.contact; patch.contactVerified = true; }
  else if (p.publicContact && (r.profile.emails || []).some((e) => e.email === String(p.publicContact).toLowerCase())) patch.contactVerified = true;
  if (!p.location && r.profile.office) patch.location = r.profile.office;
  if (Object.keys(patch).length) ctx.store.update('prospects', p.id, patch);
  return `${r.sources.length} sources${r.errors.length ? ` (${r.errors.length} unavailable)` : ''}`;
}

async function stepBrief(p) {
  const pkg = p.pkg;
  if (!ai.anyConnected()) { save(p.id, () => ({ brief: fallbackBrief(pkg) })); return 'Basic brief (connect an AI provider for a full one)'; }
  const r = await ai.ask({ role: 'research', json: true, maxTokens: 3000, system: `You are a political research analyst for ${ctx.setting('agency.name', 'Euclidean Media')}, a short-form video agency. Write a briefing on a public official or candidate using ONLY the material provided. After every factual claim put its source number in brackets like [3]. If the material doesn't support something, leave it out. Public, professional information only: never include home addresses, family members, health or other personal details. Be neutral and factual.`, prompt: `${material(pkg)}\n\nReturn JSON: {"headline":"one line: who they are","summary":"2-3 sentences with citations","sections":[{"title":"Office & district","points":["... [n]"]},{"title":"Record & priorities","points":[]},{"title":"Fundraising","points":[]},{"title":"In the news","points":[]},{"title":"Online presence","points":[]}],"themes":["3-5 issues they clearly care about, short phrases"],"contentGaps":["2-4 observations about their video/social presence an agency could help with; say 'unverified' when unsure"],"angle":"one sentence: the most natural reason they'd want our videos","keyPoints":["3-5 campaign key points voters should hear, each with [n]"],"election":"the next election they're on the ballot for, with its date, only if stated in the material, else empty","opponent":{"name":"their main opponent in that race, ONLY if the material names one, else empty","src":[0]}}` });
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

const POP_DOC = `Scene types (fields; keep text SHORT, it's on-screen):
- {"type":"hook","headline":"≤8 words, wrap 1-2 key words in *asterisks* for colour","sub":"≤10 words","badge":"optional ≤2 words"}
- {"type":"portrait","headline":"their name","sub":"their office ≤8 words"}
- {"type":"stat","kicker":"≤4 words","value":"≤10 characters","label":"≤10 words","cite":[n]}
- {"type":"issues","headline":"≤6 words with *highlight*","items":["2-4 items, ≤5 words each"]}
- {"type":"quote","quote":"≤25 words, VERBATIM from the source text","source":"who/where","cite":[n]}
- {"type":"cta","headline":"≤6 words","button":"their website","sub":"≤8 words"}
- {"type":"end","headline":"their name or slogan","sub":"≤6 words"}`;

const CAMPAIGN_DOC = `This is a modern political ad (TV/online campaign spot): bold, emotional, punchy lines, ALL-CAPS headlines on screen, the way real campaign ads look before an election.
Scene types (fields; keep on-screen text SHORT):
- {"type":"photo","who":"candidate","headline":"≤7 words, *highlight* 1-2 words","sub":"≤6 words"}  (full-screen photo of the candidate)
- {"type":"headline","outlet":"news outlet from the sources","date":"its date","title":"the real headline, *highlight* key words","sub":"≤6 words takeaway","cite":[n]}  (a news clipping; only real headlines from the sources)
- {"type":"stat","value":"≤8 characters","label":"≤8 words","cite":[n]}
- {"type":"issues","headline":"≤5 words","items":["2-4 key points, ≤5 words each"]}
- {"type":"quote","quote":"≤22 words, VERBATIM from the sources","source":"who/where","cite":[n]}
- {"type":"counter","to":12345,"prefix":"$ or empty","suffix":"+ or %, or empty","label":"≤8 words","cite":[n]}  (a number that counts up; must be in the material)
- {"type":"chart","headline":"≤5 words","bars":[{"label":"2022","value":1200000,"display":"$1.2M"}],"cite":[n]}  (2-8 bars, every value from the material, e.g. fundraising by cycle)
- {"type":"vote","headline":"VOTE <NAME> or a ≤5 word slogan","date":"election date only if in the material","button":"their website"}
Every factual scene needs "cite" with the source numbers it relies on. Optional "sec" per scene (2.5-6).`;

const CONTRAST_DOC = `Contrast scenes (allowed because an opponent is researched):
- {"type":"contrast","headline":"≤5 words","left":{"label":"candidate name","items":["2-3 sourced points"]},"right":{"label":"opponent name","items":["2-3 sourced points about the opponent's public record"]},"cite":[n,...]}
- {"type":"photo","who":"opponent","headline":"≤7 words about the opponent's public record","sub":"≤6 words, e.g. the bill or vote","cite":[n]}
Contrast claims must be specific public-record facts (votes, bills, filings, statements, news reports) that appear in the opponent sources, cited. No insults, no claims about character or private life, nothing unsourced.`;

async function stepOpponent(p, h) {
  const pkg = p.pkg; const name = pkg.brief?.opponent?.name && String(pkg.brief.opponent.name).trim();
  if (!S('contrastAds', false)) { save(p.id, () => ({ opp: null })); return { skip: true, note: 'Contrast ads are off (Package settings)' }; }
  if (!name) { save(p.id, () => ({ opp: null })); return { skip: true, note: 'No opponent named in the research' }; }
  const dir = path.join(dirFor(p), 'opponent'); fs.mkdirSync(dir, { recursive: true });
  const r = await sources.lookup({ name, hint: pkg.profile?.office || '', dir, onStep: (x) => h.progress(0.1, `Opponent: ${x}`) });
  if (r.sources.length < 2) { save(p.id, () => ({ opp: null })); return { skip: true, note: `Too little public record found for ${name}` }; }
  // Renumber the opponent's sources after the candidate's so every citation stays unique.
  const base = Math.max(0, ...(pkg.sources || []).filter((x) => !x.opponent).map((x) => x.n));
  const srcs = r.sources.map((x) => ({ ...x, n: x.n + base, opponent: true }));
  const facts = r.facts.map((f) => ({ ...f, topic: `opponent:${f.topic}`, src: f.src + base }));
  const text = r.text.map((t) => ({ ...t, src: t.src + base }));
  save(p.id, (pk) => ({
    sources: [...(pk.sources || []).filter((x) => !x.opponent), ...srcs], facts: [...(pk.facts || []).filter((f) => !String(f.topic).startsWith('opponent:')), ...facts],
    text: [...(pk.text || []).filter((t) => t.src <= base), ...text], opp: { name, profile: { office: r.profile.office, party: r.profile.party, photo: r.profile.photo, photoCredit: r.profile.photoCredit } },
  }));
  return { note: `${name}: ${r.sources.length} sources` };
}

async function stepCreative(p) {
  const pkg = p.pkg;
  const shortSec = Math.max(10, Math.min(90, Number(S('shortSeconds', 20)) || 20));
  const longSec = Math.max(30, Math.min(240, Number(S('videoSeconds', 60)) || 60));
  const style = S('videoStyle', 'campaign');
  const offer = S('offer', '') || `Three free ads (a short vertical, a short horizontal and a longer horizontal cut) they can use free of charge whether or not they talk to us. Our political plan: ${S('plan', DEFAULT_PLAN)}. Ask for 20 minutes.`;
  const booking = S('bookingUrl', '');
  const sender = S('senderName', '') || ctx.setting('agency.founders', [])[0]?.name || '';
  const contrast = !!(S('contrastAds', false) && pkg.opp);
  if (!ai.anyConnected()) { save(p.id, () => ({ creative: fallbackCreative(p, pkg, { booking, sender, style }) })); return 'Template scripts (connect an AI provider for tailored ads)'; }
  const templates = String(S('templates', '') || '').trim();
  const r = await ai.ask({ role: 'writing', json: true, maxTokens: 6000, system: `You create outreach for ${ctx.setting('agency.name', 'Euclidean Media')}, a video agency for political campaigns. You write sample campaign ads for the candidate, aimed at THEIR voters, that make the case for them on their key points (lower costs, schools, safety, jobs... whatever the material supports). Rules: use only facts in the material; numbers, headlines and quotes must appear in the material (quotes word for word) or be left out; cite source numbers on factual scenes; never claim endorsements or results you can't show; no personal details; ${contrast ? 'contrast with the opponent is allowed ONLY on specific, cited public-record facts' : 'do not mention or attack any opponent'}. The email is personal, specific and short (under 170 words): it says what we made for them, that the attached ads are theirs to use free of charge whether or not they talk to us, mentions the plan in one line, asks for 20 minutes, and ends with an opt-out line. Never use em dashes.${learning.writerBlock('political')}`, prompt: `${material(pkg)}\n\nBRIEF\n${JSON.stringify(pkg.brief || {}).slice(0, 6000)}\n\n${templates ? `HOUSE EMAIL TEMPLATES (match this voice and structure):\n${templates.slice(0, 6000)}\n\n` : ''}OFFER: ${offer}\n${booking ? `Booking link: ${booking}\n` : ''}${sender ? `Sign as: ${sender}, ${ctx.setting('agency.name', 'Euclidean Media')}\n` : ''}
${notesBlock(pkg)}Write two ads from the same campaign: "short" (about ${shortSec} seconds, ${Math.max(4, Math.round(shortSec / 3.5))} scenes, used for both the vertical and the horizontal short) and "long" (about ${longSec} seconds, ${Math.max(6, Math.round(longSec / 4))} scenes). Each should open with a strong hook and end with a ${style === 'campaign' ? 'vote' : 'cta then end'} scene.
${style === 'campaign' ? CAMPAIGN_DOC : POP_DOC}
${contrast ? CONTRAST_DOC : ''}

Return JSON: {"tone":"${contrast ? 'positive or contrast' : 'positive'}","short":[...scenes],"long":[...scenes],"email":{"subject":"≤8 words, specific to them","body":"plain text"},"callScript":"a 60-second script for a person calling their campaign office: intro, why them, the free ads, the 20-minute ask, handling 'send me an email'","voiceNote":"a 20-second friendly voice note from the sender","narration":"an upbeat voiceover for the long ad from a narrator (never the candidate's voice)"}` });
  const c = r.json || {};
  const short = vetStoryboard(c.short || c.storyboard, pkg, p, { style, contrast });
  const long = vetStoryboard(c.long || c.short || c.storyboard, pkg, p, { style, contrast });
  const out = { ...c, style, short, long, storyboard: short, hasContrast: [...short, ...long].some((x) => x.type === 'contrast' || x.who === 'opponent'), agent: `${r.provider}:${r.model}` };
  out.tone = out.hasContrast ? 'contrast' : 'positive';
  out.email = { ...(c.email || {}), body: withFooter(c.email?.body || '') };
  save(p.id, () => ({ creative: out }));
  return `${short.length} + ${long.length} scenes${out.hasContrast ? ' (contrast)' : ''}, email and call script`;
}

/** Keep the ads honest: drop quotes, numbers and claims that aren't in the research, and citations that don't exist. */
function vetStoryboard(list, pkg, p, { style = 'pop', contrast = false } = {}) {
  const all = [...(pkg.facts || []).map((f) => f.text), ...(pkg.text || []).map((t) => t.text)].join(' ');
  const corpus = norm(all); const numbers = all.toLowerCase().replace(/(\d),(?=\d{3})/g, '$1');
  const srcN = new Set((pkg.sources || []).map((x) => x.n)); const oppN = new Set((pkg.sources || []).filter((x) => x.opponent).map((x) => x.n));
  const TYPES = style === 'campaign' ? ['photo', 'headline', 'stat', 'issues', 'quote', 'contrast', 'vote', 'counter', 'chart'] : ['hook', 'portrait', 'stat', 'issues', 'quote', 'cta', 'end', 'counter', 'chart'];
  const numbersOk = (txt) => (String(txt || '').replace(/(\d),(?=\d{3})/g, '$1').match(/\d+(?:\.\d+)?/g) || []).every((d) => d.length < 2 && !/\$/.test(txt) ? true : new RegExp(`(^|[^\\d.])${d.replace('.', '\\.')}(?![\\d])`).test(numbers));
  const exactNumber = (v) => new RegExp(`(^|[^\\d.])${String(v).replace('.', '\\.')}(?![\\d])`).test(numbers);
  const ok = [];
  for (const s of Array.isArray(list) ? list : []) {
    if (!s || typeof s !== 'object') continue;
    const type = TYPES.includes(s.type) ? s.type : TYPES[0];
    const cite = [].concat(s.cite || []).map(Number).filter((n) => srcN.has(n));
    const x = { ...s, type, cite: cite.length ? cite : undefined };
    if (type === 'quote' && !(s.quote && corpus.includes(norm(s.quote).slice(0, 80)))) continue;
    if (type === 'stat' && !numbersOk(s.value)) continue;
    if (type === 'counter' && !(Number(s.to) >= 10 && exactNumber(Number(s.to)))) continue;
    if (type === 'chart' && !((s.bars || []).length >= 2 && (s.bars || []).every((b) => Number(b.value) >= 1 && exactNumber(Number(b.value))))) continue;
    if (type === 'headline' && !(s.title && corpus.includes(norm(String(s.title).replace(/\*/g, '')).slice(0, 50)))) continue;
    if (type === 'contrast' || s.who === 'opponent') {
      if (!contrast || !cite.some((n) => oppN.has(n))) continue;
      const items = [...(s.left?.items || []), ...(s.right?.items || []), s.headline, s.sub].filter(Boolean);
      if (!items.every(numbersOk)) continue;
    }
    if (['headline', 'stat', 'quote', 'counter', 'chart'].includes(type) && !cite.length && style === 'campaign') continue;
    ok.push(x);
  }
  if (style === 'campaign') {
    if (!ok.some((s) => s.type === 'photo' && s.who !== 'opponent')) ok.unshift({ type: 'photo', who: 'candidate', headline: p.name, sub: shortOffice(pkg.profile?.office || '') });
    if (ok[ok.length - 1]?.type !== 'vote') ok.push({ type: 'vote', headline: `Vote ${p.name}`, button: siteOf(pkg) });
  } else {
    if (!ok.some((s) => s.type === 'portrait')) ok.splice(Math.min(1, ok.length), 0, { type: 'portrait', headline: p.name, sub: pkg.profile?.office || '' });
    if (ok[ok.length - 1]?.type !== 'end') ok.push({ type: 'end', headline: p.name, sub: pkg.profile?.office ? shortOffice(pkg.profile.office) : '' });
  }
  return ok.slice(0, 60);
}
const siteOf = (pkg) => (pkg.profile?.sites?.[0] || '').replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '');
const shortOffice = (o) => String(o).replace(/United States/i, 'U.S.').slice(0, 40);

function fallbackCreative(p, pkg, { booking, sender, style = 'campaign' }) {
  const pr = pkg.profile || {}; const first = p.name.split(/\s+/)[0];
  const moneySrc = (pkg.facts || []).find((f) => f.topic === 'money')?.src;
  const money = pr.money?.raised ? `$${(pr.money.raised / 1e6).toFixed(1)}M` : null;
  const sb = style === 'campaign' ? [
    { type: 'photo', who: 'candidate', headline: `${p.name} *for you*`, sub: shortOffice(pr.office || '') },
    money && moneySrc ? { type: 'stat', value: money, label: `raised from supporters in ${pr.money.cycle}`, cite: [moneySrc] } : null,
    { type: 'vote', headline: `Vote ${p.name}`, button: siteOf(pkg) },
  ] : [
    { type: 'hook', headline: `Meet *${p.name}*`, sub: shortOffice(pr.office || '') },
    { type: 'portrait', headline: p.name, sub: shortOffice(pr.office || '') },
    money ? { type: 'stat', kicker: `${pr.money.cycle} cycle`, value: money, label: 'raised from supporters' } : null,
    { type: 'cta', headline: `Stand with *${first}*`, button: siteOf(pkg) || 'Learn more', sub: '' },
    { type: 'end', headline: p.name, sub: shortOffice(pr.office || '') },
  ];
  const board = sb.filter(Boolean);
  const agency = ctx.setting('agency.name', 'Euclidean Media');
  return {
    style, tone: 'positive', hasContrast: false, short: board, long: board, storyboard: board,
    email: { subject: `Three free ads for ${p.name}`, body: withFooter(`Hi ${first} team,\n\nWe made three short campaign ads for ${p.name}: a vertical one for Reels/TikTok/Shorts, a horizontal one for YouTube and the web, and a longer cut. They're attached, and they're yours to use free of charge, whether or not you decide to talk with us.\n\nWe're ${agency}. Our political plan is ${S('plan', DEFAULT_PLAN)}. Could you give us 20 minutes?${booking ? `\n\nPick a time: ${booking}` : ''}\n\nThanks,\n${sender || agency}`) },
    callScript: `Hi, this is ${sender || 'a producer'} with ${agency}. We make campaign videos, and we put together three free sample ads for ${p.name}. They're free to use either way. Who's the best person to send them to? And could we get 20 minutes with whoever handles digital?`,
    voiceNote: `Hey, it's ${sender || 'the team'} from ${agency}. We made three quick ads for ${p.name}, attached and free to use. If you've got 20 minutes this week, we'd love to show you more.`,
    narration: '', agent: 'template',
  };
}

/** "Source: Texas Tribune; FEC" from citation numbers. */
function citeText(pkg) {
  return (ns) => {
    const names = [...new Set([].concat(ns || []).map((n) => (pkg.sources || []).find((x) => x.n === Number(n))).filter(Boolean).map((x) => String(x.title).split(/:\s/)[0].replace(/^Website$|^Campaign site$/, new URL(x.url).hostname.replace(/^www\./, ''))))];
    return names.length ? `Source: ${names.join('; ')}` : '';
  };
}

async function stepVideo(p, h, kind) {
  const K = VIDEOS[kind]; const c = p.pkg.creative; const board = c?.[K.board] || c?.storyboard;
  if (!board?.length) throw new Error('Run the ad scripts step first.');
  const dir = dirFor(p); const out = path.join(dir, `${slugName(p.name)} - ${K.label} ad.mp4`);
  const music = pickMusic(c.tone);
  let narration = null;
  if (kind === 'hl' && S('narration', false) && c.narration && ai.connected('openai')) {
    narration = path.join(dir, 'narration.mp3');
    if (!fs.existsSync(narration)) { try { await tts(c.narration, narration); } catch (e) { narration = null; audit.log('system', 'political.tts_failed', { prospectId: p.id, error: e.message }, 'warn'); } }
  }
  const style = c.style || S('videoStyle', 'campaign');
  const info = { brand: S('brandColors', true) ? p.pkg.profile?.brand : null, name: p.name, photo: p.pkg.profile?.photo, oppPhoto: p.pkg.opp?.profile?.photo, party: p.pkg.profile?.party, style, tone: c.tone, citeText: citeText(p.pkg), theme: S('theme', 'auto') === 'auto' ? null : S('theme') };
  const work = path.join(dir, `work_${kind}`);
  const res = await render.renderVideo({ scenes: board, info, vertical: K.vertical, out, work, music, narration, onProgress: (f, t) => h.progress(f * 0.92, t) });
  fs.rmSync(work, { recursive: true, force: true });
  // Small copy for email attachments (720p), the full-quality file stays in the folder.
  h.progress(0.94, 'Making the email-sized copy');
  const mail = path.join(dir, `${slugName(p.name)} - ${K.label} ad (email).mp4`);
  await ff.ffmpegWithProgress(['-i', out, '-vf', K.vertical ? 'scale=720:-2' : 'scale=-2:720', '-c:v', 'libx264', '-preset', 'medium', '-crf', '27', '-maxrate', '2500k', '-bufsize', '5000k', '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', mail], { totalSec: res.duration });
  const poster = path.join(dir, `poster_${kind}.jpg`);
  await ff.thumbnail(out, poster, Math.min(3, res.duration / 4), K.vertical ? 540 : 960).catch(() => {});
  const posterKey = { v: 'posterV', h: 'posterH', hl: 'posterHL' }[kind];
  save(p.id, (pkg) => ({ files: { ...(pkg.files || {}), [kind]: out, [`${kind}Mail`]: mail, [posterKey]: poster } }));
  return `${Math.round(res.duration)}s · email copy ${(fs.statSync(mail).size / 1e6).toFixed(1)} MB`;
}

/** A track from the music folder; a "positive" or "contrast" subfolder is used for that kind of ad when present. */
function pickMusic(tone) {
  const root = S('musicDir', '');
  const sub = tone && path.join(root, tone);
  const dir = sub && fs.existsSync(sub) ? sub : root;
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
<h1>Three free ads for<br><b>${e(p.name)}</b></h1>
<div class="lead">${e(cap(pr.office || ''))}${pr.office ? '. ' : ''}We made three campaign ads from your public record: a short vertical, a short horizontal and a longer cut. They're attached to our email and <b style="color:${T.a}">yours to use free of charge</b>, whether or not you decide to talk with us.</div>
<div class="vids">
  ${img(pkg.files?.posterV) ? `<div class="v"><img src="${img(pkg.files.posterV)}" style="width:2.1in;height:3.73in"><div>Vertical · Reels, TikTok, Shorts</div></div>` : ''}
  ${img(pkg.files?.posterH) ? `<div class="v" style="flex:1"><img src="${img(pkg.files.posterH)}" style="width:100%;height:2.3in"><div>Horizontal · YouTube, web, email</div></div>` : ''}
</div>
<div class="box"><h3>The political plan</h3><p style="font:800 22px Pop;color:${T.a};margin:2px 0 8px">${e(S('plan', DEFAULT_PLAN))}</p><ul><li>Campaign ads and short videos about your record and your key issues</li><li>Ready for every platform, vertical and horizontal</li><li>Fast turnaround, and you approve everything before it posts</li></ul></div>
<div class="ask">Could you give us 20 minutes?</div>
<div class="foot"><span>${e(sender)}${sender ? ' · ' : ''}${e(agency)}${booking ? ` · ${e(booking)}` : ''}</span><span>Concept ads. Not paid for or authorized by any candidate or committee.${pr.photoCredit ? ` Photo: ${e(pr.photoCredit)}.` : ''}</span></div>
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
  const ex = excluded({ name: p.name, email: to, handle: p.handle });
  if (ex) { save(p.id, () => ({ status: 'excluded' })); return { skip: true, note: `On the exclusions list (${ex})` }; }
  if (isGov(to) && !S('allowGov', false)) { save(p.id, () => ({ status: 'needs_contact' })); return { skip: true, note: `${to} is a government office address. Add a campaign or press email instead.` }; }
  let contact = p.contactId ? ctx.store.get('contacts', p.contactId) : ctx.store.find('contacts', (x) => (x.emails || []).includes(to));
  if (!contact) contact = ctx.store.insert('contacts', { name: p.name, phones: [], emails: [to], role: 'prospect', clientId: null, optedOut: {}, source: 'political' });
  else if (!(contact.emails || []).includes(to)) contact = ctx.store.update('contacts', contact.id, { emails: [...contact.emails, to] });
  if (contact.optedOut?.email) return { skip: true, note: `${p.name} opted out of email.` };
  ctx.store.update('prospects', p.id, { contactId: contact.id });
  // Replace an earlier unsent draft instead of stacking duplicates.
  if (pkg.messageId) { const old = ctx.store.get('messages', pkg.messageId); if (old?.status === 'pending_approval') messaging.rejectMessage(old.id, actor); }
  const att = attachmentsFor(pkg);
  if (p.voiceNote && fs.existsSync(p.voiceNote)) att.push({ name: path.basename(p.voiceNote), path: p.voiceNote, size: fs.statSync(p.voiceNote).size });
  const m = messaging.createOutbound({ contactId: contact.id, channel: 'email', subject: noDashes(c.email.subject), body: withFooter(c.email.body), aiGenerated: true, agent: c.agent, category: 'prospecting', actor, attachments: att });
  save(p.id, () => ({ messageId: m.id, conversationId: m.conversationId }));
  if ((p.stage || 'new') === 'new') ctx.store.update('prospects', p.id, { stage: 'drafted' });
  return { note: `${att.length} attachments (${(att.reduce((s2, a) => s2 + a.size, 0) / 1e6).toFixed(1)} MB)` };
}

/** Email-sized ads plus the sheet, kept under the attachment limit (the long ad is dropped first). */
function attachmentsFor(pkg) {
  const f = pkg.files || {}; const limit = Number(S('maxAttachMB', 20)) * 1e6;
  const pick = (a, b) => (a && fs.existsSync(a) ? a : b && fs.existsSync(b) ? b : null);
  let list = [pick(f.vMail, f.v), pick(f.hMail, f.h), f.sheet, pick(f.hlMail, f.hl)].filter((x) => x && fs.existsSync(x));
  const size = (l) => l.reduce((s2, x) => s2 + fs.statSync(x).size, 0);
  while (list.length > 1 && size(list) > limit) list = list.slice(0, -1);
  return list.map((x) => ({ name: path.basename(x).replace(' (email)', ''), path: x, size: fs.statSync(x).size }));
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
      else if (step === 'opponent') { const r = await stepOpponent(p, sub); note = r.note; if (r.skip) { setStep(p.id, step, { status: 'skipped', note }); continue; } }
      else if (step === 'creative') note = await stepCreative(p);
      else if (step === 'video_v') note = await stepVideo(p, sub, 'v');
      else if (step === 'video_h') note = await stepVideo(p, sub, 'h');
      else if (step === 'video_hl') { if (S('longVideo', true)) note = await stepVideo(p, sub, 'hl'); else { setStep(p.id, step, { status: 'skipped', note: 'Long ad is off' }); continue; } }
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
  if (!['needs_contact', 'excluded'].includes(p.pkg.status)) save(p.id, () => ({ status: 'ready', finishedAt: now() }));
  const autoSent = (!only || only === 'email') ? require('../outreach/autopilot').maybeAutoSend(prospectId) : false;
  if (autoSent) save(prospectId, () => ({ autoSent: true }));
  audit.log(actor, 'political.package_ready', { prospectId, name: p.name });
  p = ctx.store.get('prospects', prospectId);
  if (!only && !p.pkg.autoSent) events.publish('notify', { title: `Package ready: ${p.name}`, body: p.pkg.status === 'needs_contact' ? 'Needs a campaign email before the draft can be made.' : 'Email with the ads is waiting for review.' });
  return { status: ctx.store.get('prospects', prospectId).pkg.status };
}


// ------------------------------------------------------------------ notes, revisions and versions

/** Founder notes for this lead, plus the current version to revise. */
function notesBlock(pkg) {
  const notes = (pkg.notes || []).filter((n) => n.target !== 'email');
  if (!notes.length) return '';
  const prev = pkg.creative ? `\nCURRENT VERSION (revise it; keep what the notes don't mention):\nShort ad: ${JSON.stringify(pkg.creative.short || []).slice(0, 2500)}\nLong ad: ${JSON.stringify(pkg.creative.long || []).slice(0, 3500)}\nEmail subject: ${pkg.creative.email?.subject || ''}\nEmail body:\n${String(pkg.creative.email?.body || '').slice(0, 1500)}\n` : '';
  return `FOUNDER NOTES FOR THIS LEAD (apply every note; if two conflict, the later one wins):\n${notes.map((n, i) => `${i + 1}. ${n.text}`).join('\n')}\n${prev}\n`;
}

/** Keep a copy of the current creative and files before changing them. */
function snapshot(p, label) {
  const pkg = p.pkg || {}; if (!pkg.creative) return null;
  const n = (pkg.versions || []).length + 1; const vdir = path.join(dirFor(p), `v${n}`); fs.mkdirSync(vdir, { recursive: true });
  const files = {};
  for (const [k, f] of Object.entries(pkg.files || {})) { if (f && fs.existsSync(f)) { const to = path.join(vdir, path.basename(f)); fs.copyFileSync(f, to); files[k] = to; } }
  const v = { n, at: now(), label: label || `Version ${n}`, creative: pkg.creative, files };
  save(p.id, (pk) => ({ versions: [...(pk.versions || []), v] }));
  return v;
}

/** Rewrite only the email, following the notes. */
async function reviseEmail(p) {
  const pkg = p.pkg; const c = pkg.creative; if (!c?.email) throw new Error('Make the package first.');
  const notes = (pkg.notes || []).map((n, i) => `${i + 1}. ${n.text}`).join('\n');
  if (!ai.anyConnected()) throw new Error('Connect an AI provider to revise with notes.');
  const r = await ai.ask({ role: 'writing', json: true, maxTokens: 1500, system: `You revise outreach emails for ${ctx.setting('agency.name', 'Euclidean Media')}. Apply the founder notes to the current email. Keep facts accurate to the brief, keep the free-ads offer, the 20-minute ask and the opt-out line. Never use em dashes.${learning.writerBlock('political')}`, prompt: `BRIEF\n${JSON.stringify(pkg.brief || {}).slice(0, 4000)}\n\nCURRENT EMAIL\nSubject: ${c.email.subject}\n${c.email.body}\n\nFOUNDER NOTES (latest wins)\n${notes}\n\nReturn {"subject":"...","body":"..."}` });
  save(p.id, (pk) => ({ creative: { ...pk.creative, email: { subject: r.json.subject, body: withFooter(r.json.body) } } }));
}

/**
 * Apply a founder note: target 'email' rewrites the email only, 'ads' remakes the ads (and the email
 * to match), 'all' does both. The previous version is kept so it can be restored.
 */
async function revise(prospectId, { note, target = 'all', actor = 'user' }, h) {
  let p = ctx.store.get('prospects', prospectId); if (!p?.pkg?.creative) throw Object.assign(new Error('Make the package first, then give notes.'), { permanent: true });
  snapshot(p, `Before: ${String(note || '').slice(0, 60)}`);
  save(p.id, (pk) => ({ notes: [...(pk.notes || []), { text: String(note || '').slice(0, 1000), target, at: now(), by: actor }], status: 'running', error: null }));
  p = ctx.store.get('prospects', prospectId);
  const steps = target === 'email' ? ['email_rewrite', 'email'] : ['creative', 'video_v', 'video_h', ...(S('longVideo', true) ? ['video_hl'] : []), 'sheet', 'email'];
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]; p = ctx.store.get('prospects', prospectId);
    const sub = { progress: (f, t) => h.progress((i + Math.max(0, Math.min(1, f))) / steps.length, t || step) };
    sub.progress(0, step === 'email_rewrite' ? 'Rewriting the email' : (STEPS.find((x) => x[0] === step) || [0, step])[1]);
    try {
      if (step === 'email_rewrite') await reviseEmail(p);
      else if (step === 'creative') await stepCreative(p);
      else if (step.startsWith('video_')) await stepVideo(p, sub, { video_v: 'v', video_h: 'h', video_hl: 'hl' }[step]);
      else if (step === 'sheet') await stepSheet(p);
      else if (step === 'email') stepEmail(p, actor);
    } catch (e) { save(p.id, () => ({ status: 'failed', error: `Revision: ${e.message}` })); throw e; }
  }
  save(prospectId, () => ({ status: 'ready', finishedAt: now() }));
  events.publish('notify', { title: `Revised: ${p.name}`, body: `"${String(note).slice(0, 80)}" applied. Waiting for your review.`, route: '/growth' });
  return { status: 'ready' };
}

/** Bring back an earlier version (its ads, sheet and email). */
function restore(prospectId, n, actor = 'user') {
  const p = ctx.store.get('prospects', prospectId); const v = (p?.pkg?.versions || []).find((x) => x.n === Number(n));
  if (!v) throw new Error('Version not found');
  snapshot(p, 'Before restoring');
  const files = {};
  for (const [k, f] of Object.entries(v.files || {})) { if (fs.existsSync(f)) { const to = path.join(dirFor(p), path.basename(f)); fs.copyFileSync(f, to); files[k] = to; } }
  save(p.id, (pk) => ({ creative: v.creative, files: { ...(pk.files || {}), ...files } }));
  stepEmail(ctx.store.get('prospects', prospectId), actor);
  return { restored: v.n };
}

module.exports = { revise, restore, STEPS, VIDEOS, run, dirFor, fallbackCreative, vetStoryboard, material, attachmentsFor, DEFAULT_PLAN };
