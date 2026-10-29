'use strict';
/**
 * HAL's outreach email (Part 3 of the master prompt; draft_email in HAL_CORE_CODE.py): a fixed scaffold with ONE
 * generated paragraph, grounded in the prospect's on-record facts and one real headline. Offer values are settings
 * (hal.offerPrice / offerNormal / electionDay). Euclidean's house rules are applied on top: no em dashes, the opt-out
 * line and postal address (CAN-SPAM), never a .gov address, and the draft always waits in Approvals.
 */
const ctx = require('../core/ctx');
const messaging = require('../automation/messaging');
const common = require('../outreach/common');
const { think, PERSONA } = require('./brain');
const web = require('./web');

const SIG = 'Ben Gingold\nCo-founder, Euclidean Media (ZSPAN)\n917-699-4151\nzspannetwork.com/euclidean';
const INTRO = "I'm Ben Gingold, co-founder of Euclidean Media (ZSPAN). Euclidean Media has delivered hundreds of millions of views across the creators and politicians we work with. We've been working with clients in Connecticut and are bringing that to New York (I'm from NY). We handle social across every platform: Facebook, Instagram, YouTube, Twitter/X, Substack, and targeted advertising if you want it.";

const offer = () => ({ price: String(ctx.setting('hal.offerPrice', '899')), normal: String(ctx.setting('hal.offerNormal', '1,500')), day: String(ctx.setting('hal.electionDay', 'November 3, 2026')) });
const emailOf = (p) => { const m = /[\w.+-]+@[\w-]+(\.[\w-]+)+/.exec(String(p.email || p.publicContact || '')); return m ? m[0].toLowerCase() : ''; };
const stateOf = (p) => String(p.state || '').toUpperCase() || (/\bNY\b|new york/i.test(`${p.office || ''} ${p.location || ''}`) ? 'NY' : /\bCT\b|connecticut/i.test(`${p.office || ''} ${p.location || ''}`) ? 'CT' : '');

/** The record HAL may use: only what's on file (the "why" and the board fields), nothing invented. */
function onRecord(p) {
  const keep = ['name', 'office', 'race', 'party', 'state', 'social', 'adNote', 'why', 'target', 'score', 'suggestedPackage', 'location'];
  return Object.fromEntries(keep.filter((k) => p[k]).map((k) => [k, p[k]]));
}

/** Build the email for a prospect. extra = Ryan's notes ("they're running ads" switches to the Digital opener). */
async function compose(p, extra = '') {
  const o = offer(); const name = p.name || ''; const first = name.split(' ')[0] || 'there'; const office = p.office || p.location || '';
  const ny = stateOf(p) === 'NY'; const evLine = ny ? ' Early voting starts October 24, so the window to build name recognition is short.' : '';
  const digital = /digital opener|running ads|their ads|saw their ads|they're running|is running ads|confirmed ads/i.test(extra);
  const opener = digital ? `I've been seeing your ads online this fall and wanted to reach out. We'd be the daily organic side that complements the paid media you already have running.\n\n${INTRO}` : INTRO;
  let hook = ''; try { hook = (await web.newsAbout(name, 2))[0]?.t || ''; } catch { /* offline */ }
  let why = ''; let by = 'template';
  try {
    const r = await think({ maxTokens: 260, system: `${PERSONA}\n\nTASK: write ONLY the middle paragraph of a Euclidean Media outreach email to a Democratic campaign. This is one paragraph (2 to 4 sentences) on why THIS race is close and why a steady daily social feed matters right now. HARD RULES: use ONLY the on-record facts and the real headline provided below. Do NOT invent or estimate any margin, vote count, poll number, race rating, cash figure, or endorsement. If a number is not provided, do not state one. Name the district/office and the opponent only if given. End with the idea that a daily feed builds the candidate's name with voters before Election Day.${ny ? ' Mention that early voting starts October 24, so the window is short.' : ''} No subject line, no greeting, no signature, no offer, no em dashes. Return ONLY the paragraph.`,
      messages: [{ role: 'user', content: `Candidate: ${name}${office ? `, ${office}` : ''}.\nOn-record facts (the ONLY facts you may use): ${JSON.stringify(onRecord(p))}.${hook ? `\nReal recent headline you may reference if it fits: ${hook}` : ''}${extra ? `\nRyan's notes: ${extra}` : ''}` }] });
    why = r.text.replace(/^["']|["']$/g, '').trim(); by = r.by;
  } catch { /* no brain: grounded template below */ }
  if (!why || why.length < 40) {
    why = p.why ? `${String(p.why).replace(/[.\s]+$/, '')}. A steady daily feed builds your name with voters through Election Day, ${o.day}.${evLine}` : `Your ${office || 'race'} is on our short list of competitive seats this cycle. A steady daily feed builds your name with voters before Election Day, ${o.day}.${evLine}`;
  }
  const subject = `${first}, 12 posts a week through Election Day`;
  const body = [`Hi ${first},`, opener, why,
    `For the final stretch we're offering 12 social posts a week through Election Day, ${o.day}, for $${o.price} total (normally $${o.normal} a month) as a fast visibility push. That covers content ideas, research on your race and issues, writing and posting, video editing, thumbnails and titles, and a review after the first week so you can adjust the mix.`,
    `We can start with a one week free trial of the 12 posts a week service at no cost. You only get billed the $${o.price} if you sign on for the full run through Election Day. Low risk way to try it before you commit.`,
    'Open to a 20 minute call this week?', SIG].join('\n\n');
  return { subject: common.noDashes(subject), body: common.noDashes(body), by };
}

/**
 * Draft the email and put it in Approvals for the prospect's campaign address. Without a usable address (none on
 * file, or a .gov) the draft is returned to show in chat instead, with the reason.
 */
async function draftFor(p, extra = '', actor = 'user') {
  const mail = await compose(p, extra);
  const to = emailOf(p);
  if (!to) return { ...mail, queued: false, why: `No campaign email on file for ${p.name}. Add it on their Politics card, then say "email ${p.name}" again.` };
  if (common.isGov(to)) return { ...mail, queued: false, why: `${to} is a government address, and we never pitch those. Find their campaign or press email.` };
  let contact = p.contactId ? ctx.store.get('contacts', p.contactId) : null;
  if (!contact) {
    contact = ctx.store.insert('contacts', { name: p.name, phones: [], emails: [to], role: 'prospect', clientId: null, optedOut: {}, source: 'hal' });
    ctx.store.update('prospects', p.id, { contactId: contact.id });
  }
  // aiGenerated + a non-routine category: always waits for a person in Approvals, never sends on its own.
  const m = messaging.createOutbound({ contactId: contact.id, channel: 'email', subject: mail.subject, body: common.withFooter(mail.body), aiGenerated: true, agent: `HAL (${mail.by})`, category: 'prospecting', actor });
  if (p.stage === 'new' || !p.stage) ctx.store.update('prospects', p.id, { stage: 'drafted' });
  return { ...mail, queued: true, messageId: m.id, to };
}

/** Follow-up (3-day nudge or 7-day second touch), client-facing and clean. */
async function followup(p, which = 'day3') {
  const stage = which === 'day7' ? 'a 7-day second follow-up with a touch more urgency' : 'a gentle 3-day nudge';
  const r = await think({ maxTokens: 340, system: `${PERSONA}\n\nThis is CLIENT-FACING: polished and professional. Write ${stage} follow-up email to a Democratic campaign we already emailed about Euclidean's content services. Short, warm, no pressure, one clear ask for a quick call. Subject line first. Sign Ben Gingold, Euclidean Media, 917-699-4151, zspannetwork.com/euclidean. Return only the email.`,
    messages: [{ role: 'user', content: `Prospect: ${p.name}${p.office ? `, ${p.office}` : ''}.` }] });
  return { text: common.noDashes(r.text), by: r.by };
}

module.exports = { compose, draftFor, followup, emailOf };
