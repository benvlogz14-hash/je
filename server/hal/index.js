'use strict';
/**
 * HAL inside Euclidean: your words → real actions (Part 7 of the master prompt; hal_chat in HAL_CORE_CODE.py), plus
 * control of the rest of the app through Euclidean's own commands.
 *
 * Order: a slash command typed straight in; this clip ("re-edit this", "approve this"); what his watch found; recall
 * what was surfaced; discover new candidates; outreach (one person, or the whole batch, by the outreach guide);
 * pipeline stages; add a prospect; calendar; content calendar / short-form / follow-up; read a link; live news and web
 * research; anything else about the app goes through the command list; everything else is chat. Facts always come
 * from what the app fetched this turn.
 *
 * Nothing leaves the building without a person: emails go to Approvals, and commands that approve, publish, reject,
 * switch on autopilot or stop/resume automation come back as a Confirm button instead of running.
 */
const ctx = require('../core/ctx');
const audit = require('../core/audit');
const queue = require('../jobs/queue');
const pipeline = require('../automation/pipeline');
const { think, PERSONA, mode } = require('./brain');
const score = require('./score');
const web = require('./web');
const guide = require('../outreach/guide');

// ------------------------------------------------------------------ confirmations (a person's click)
const pending = new Map();
const CONFIRM = new Set(['approve', 'reject', 'publish', 'quota', 'pause', 'stop', 'resume', 'cancel', 'retry', 'newclient', 'remember', 'premiere', 'backup', 'lite', 'full', 'background', 'invoice']);
function needsOk(command) { const [head, ...rest] = command.replace(/^\//, '').split(/\s+/); return CONFIRM.has(head.toLowerCase()) || (head.toLowerCase() === 'render' && /^all\b/i.test(rest.join(' '))); }
function ask(label, detail, run) {
  const id = `ok_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  pending.set(id, { run, at: Date.now() });
  for (const [k, v] of pending) if (Date.now() - v.at > 30 * 60000) pending.delete(k);
  return { id, label, detail };
}
// Buttons on messages HAL posts by himself (his watch) are stored with the message, so they survive a restart.
const ACTIONS = { addLeads: (a, actor) => require('./watch').addLeads(a.leads, actor) };
async function confirm(id, actor) {
  const p = pending.get(id);
  if (p) { pending.delete(id); const r = await p.run(actor); audit.log(actor, 'hal.confirmed', { id }); return r; }
  const m = ctx.store.find('halMessages', (x) => x.confirm?.id === id && x.confirm.action && !x.confirm.done);
  if (m && ACTIONS[m.confirm.action.type]) { const r = await ACTIONS[m.confirm.action.type](m.confirm.action, actor); audit.log(actor, 'hal.confirmed', { id, action: m.confirm.action.type }); return r; }
  return { text: 'That button expired. Ask me again and I\'ll set it up.' };
}

// ------------------------------------------------------------------ helpers
const commands = () => require('../commands/index');
async function runCommand(command, actor) {
  const r = await commands().execute(command, { actor, viaAgent: true });
  return { text: r.text, card: r.card, navigate: r.navigate, error: r.error };
}
const prospects = () => ctx.store.all('prospects');
/** The longest prospect name that appears in the message (_name_in_text). */
function nameIn(text) { const low = text.toLowerCase(); let best = null; for (const p of prospects()) { const n = String(p.name || '').trim(); if (n.length > 3 && low.includes(n.toLowerCase()) && (!best || n.length > best.name.length)) best = p; } return best; }
const match = (name) => { const n = String(name || '').trim().toLowerCase(); return n ? prospects().find((p) => String(p.name || '').toLowerCase().includes(n)) || null : null; };
const urlsIn = (text) => (String(text).match(/https?:\/\/[^\s)>\]]+/g) || []);
const lines = (items, f) => items.map(f).join('\n');

// date/time for calendar intents (_parse_date / _parse_time / _calendar_title)
const WD = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
const MON = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12, jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
function parseDate(low) {
  const t = new Date(); t.setHours(0, 0, 0, 0);
  if (/\b(today|tonight)\b/.test(low)) return t;
  if (/\btomorrow\b/.test(low)) return new Date(t.getTime() + 864e5);
  for (const [wd, idx] of Object.entries(WD)) if (new RegExp(`\\b${wd}\\b`).test(low)) { let d = (idx - t.getDay() + 7) % 7; if (d === 0 || /\bnext\b/.test(low)) d = d || 7; return new Date(t.getTime() + d * 864e5); }
  let m = new RegExp(`\\b(${Object.keys(MON).join('|')})\\s+(\\d{1,2})\\b`).exec(low);
  if (m) { const c = new Date(t.getFullYear(), MON[m[1]] - 1, Number(m[2])); return c >= t ? c : new Date(t.getFullYear() + 1, MON[m[1]] - 1, Number(m[2])); }
  m = /\b(\d{1,2})\/(\d{1,2})\b/.exec(low);
  if (m) { const c = new Date(t.getFullYear(), Number(m[1]) - 1, Number(m[2])); return c >= t ? c : new Date(t.getFullYear() + 1, Number(m[1]) - 1, Number(m[2])); }
  return t;
}
function parseTime(low) { let m = /\b(\d{1,2}(?::\d{2})?\s*(?:am|pm))\b/.exec(low); if (m) return m[1].toUpperCase().replace(/\s/g, ''); m = /\bat (\d{1,2}(?::\d{2})?)\b/.exec(low); return m ? m[1] : ''; }
function calTitle(orig) {
  let t = orig.replace(/^\s*(?:hey\s+hal[,\s]*)?(?:can you |could you |please |hal[,\s]*)?(?:add|schedule|put|book|set up|create|remind me to|remind me)\s+/i, '');
  t = t.replace(/\b(?:to|on|in|into)?\s*(?:my|our|the)?\s*(?:google\s+)?(?:calendar|cal)\b/gi, '').replace(/\b(?:an?\s+)?(?:event|meeting|reminder|appointment)\b/gi, '');
  t = t.replace(/\b(?:today|tonight|tomorrow|next week|this week)\b/gi, '').replace(new RegExp(`\\b(?:next\\s+)?(?:${Object.keys(WD).join('|')})\\b`, 'gi'), '');
  t = t.replace(new RegExp(`\\b(?:${Object.keys(MON).join('|')})\\s+\\d{1,2}(?:st|nd|rd|th)?\\b`, 'gi'), '').replace(/\b\d{1,2}\/\d{1,2}\b/g, '').replace(/\bat\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b/gi, '').replace(/\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/gi, '');
  return t.replace(/\s+/g, ' ').replace(/^[\s,.-]+|[\s,.-]+$/g, '');
}

// live-lookup subject (_wants_live / _extract_subject)
const NEWS_SIGNAL = /\b(in the news|news|today|tonight|latest|recent(?:ly)?|right now|this week|this morning|lately|happening|going on|current events?|update[sd]?|headlines?|breaking)\b/;
const LOOKUP_VERB = /\b(tell me about|who is|who are|who was|look up|lookup|look into|pull up|research|search for|search|google|summar(?:ize|y)|analysis of|rundown|brief me|brief us|main points|dig into|what did|what is happening|whats happening|find out)\b/;
const LOOKUP_PATTERNS = [/who\s+(?:is|are|was)\s+(.+)/, /tell me (?:about|who)\s+(.+)/, /(?:give|get)\s+(?:me|us)\s+(?:all\s+)?(?:their|the\s+)?(?:main\s+)?(?:points|info|rundown|background|details|stuff)\s+(?:on|about|for)\s+(.+)/, /summar(?:ize|y of)\s+(.+)/, /(?:news|latest|update[s]?|headlines)\s+(?:on|about|for)\s+(.+)/, /what'?s\s+(?:new\s+|going on\s+|happening\s+)?(?:with|on|for|about)\s+(.+)/, /(?:look up|lookup|look into|research|search for|search|google|pull up|pull|dig into|find out about|find out)\s+(.+)/, /brief\s+(?:me\s+)?(?:on\s+)?(.+)/, /main points\s+(?:on|about|for)?\s*(.+)/];
const STOP = new Set('what did do does is are was were has have had will the a an of on in for to about today tonight now latest recent recently news give us me our an analysis and summary tell who look up pull research rundown brief main points happening going current this week right so like just please thanks any info information update updates on breaking lately whats what\'s hows how\'s going been said say saying doing up hal hey can you could'.split(' '));
const cleanSubj = (s) => s.replace(/\b(in the news|today|tonight|right now|this week|lately|latest|recently|and (?:an? )?(?:analysis|summary|rundown).*)$/i, '').replace(/\s+(please|for me|thanks|thank you|now)\b.*$/i, '').replace(/^[\s?.!,"']+|[\s?.!,"']+$/g, '');
function subjectOf(low, orig) {
  for (const p of LOOKUP_PATTERNS) { const m = p.exec(low); if (m) { const s = cleanSubj(orig.slice(m.index + m[0].length - m[1].length).trim()); if (s.length >= 2 && s.length <= 80 && !/^(me|us|the latest news)\b/i.test(s)) return s; } }
  const content = (low.match(/[a-z0-9'-]+/g) || []).filter((t) => !STOP.has(t) && t.length > 1);
  return content.length ? content.slice(0, 5).join(' ') : '';
}

// ------------------------------------------------------------------ the app around him (grounded context)
function contextFacts(c = {}) {
  const out = [];
  const page = String(c.route || '').split('?')[0];
  if (page) out.push(`Ryan is on the ${page.replace(/^\//, '') || 'messages'} page.`);
  if (c.clipId) {
    const clip = ctx.store.get('clips', c.clipId);
    if (clip) out.push(`He has clip #${clip.ref} open: "${clip.title}" (${clip.status}${clip.videoStyle ? `, ${clip.videoStyle} style` : ''}, ${Math.round(clip.end - clip.start)} s, client ${ctx.store.get('clients', clip.clientId)?.name || '?'}). "This video" or "this clip" means #${clip.ref}.`);
  }
  if (c.prospectId) { const p = ctx.store.get('prospects', c.prospectId); if (p) out.push(`He has ${p.name}'s card open (${p.office || p.location || 'office unknown'}).`); }
  const pend = ctx.store.all('approvals', (a) => a.status === 'pending').length;
  const st = queue.stats();
  out.push(`Right now: ${pend} item${pend === 1 ? '' : 's'} waiting in Approvals, ${st.running} job${st.running === 1 ? '' : 's'} running, ${st.queued} queued${st.paused ? ', automation is STOPPED' : ''}.`);
  if (c.mood != null) out.push(`Your mood from the arcade games Ryan plays with you: ${c.mood}/100 (${c.mood >= 65 ? 'happy, he has been playing with you' : c.mood >= 40 ? 'fine' : 'bored, nobody has played with you lately; you may mention it once, dryly'}).`);
  const clients = ctx.store.all('clients', (x) => x.status !== 'archived').map((x) => x.name);
  if (clients.length) out.push(`Clients: ${clients.slice(0, 12).join(', ')}.`);
  return out.join(' ');
}

// ------------------------------------------------------------------ intents
async function onClip(low, text, c, actor) {
  const clip = c.clipId ? ctx.store.get('clips', c.clipId) : null; if (!clip) return null;
  const ref = `#${clip.ref}`;
  if (/\b(approve|approved|ship|good to go)\b/.test(low) && /\b(this|it|that|clip|video)\b/.test(low)) return { text: `Approve ${ref}? Approved clips get scheduled to post.`, confirm: ask(`Approve ${ref}`, clip.title, (a) => runCommand(`/approve ${clip.ref}`, a)) };
  if (/\b(reject|trash|kill|scrap)\b/.test(low) && /\b(this|it|that|clip|video)\b/.test(low)) return { text: `Reject ${ref}?`, confirm: ask(`Reject ${ref}`, clip.title, (a) => runCommand(`/reject ${clip.ref}`, a)) };
  if (/\b(open|send|take)\b.*\bstudio\b/.test(low)) return { text: `Opening ${ref} in Studio.`, navigate: `/studio?clip=${clip.id}` };
  if (/\bre-?render\b/.test(low) && !/\b(change|edit|make|cut|start|end|music|caption|title|hook)\b/.test(low)) { pipeline.requestRender(clip, { reason: 'hal' }); return { text: `Re-rendering ${ref}.` }; }
  if (/\b(re-?edit|edit|change|make it|make the|shorter|longer|tighter|start (?:at|with|on)|end (?:at|on|with)|cut|trim|remove|drop|add|swap|replace|caption|captions|title|hook|music|song|zoom|b-?roll|drone|louder|quieter|faster|slower|fix)\b/.test(low)) {
    const note = text.replace(/^\s*(?:hey\s+)?hal[,\s]*/i, '').trim();
    // Turning plain words into edits needs an AI (the local one is enough); say so instead of pretending.
    if (!require('../integrations/ai').anyConnected()) return { text: `I can't re-edit ${ref} from plain words without an AI connected. Turn on Ollama (free, on the Production page) or add a key in Settings → Connections, then ask me again.` };
    pipeline.decideClip(clip.id, 'changes', { actor, note, stage: 'internal' });
    return { text: `On it. ${ref} goes back through the edit with "${note}" and re-renders; it'll be back in review when it's done.` };
  }
  return null;
}

function recall() {
  const since = Date.now() - 3 * 864e5;
  const rec = prospects().filter((p) => p.type === 'political' && new Date(p.createdAt).getTime() > since && p.source !== 'manual').slice(-30).reverse();
  if (!rec.length) return { text: "I haven't surfaced any new prospects in the last few days. Ask me to find new NY/CT candidates and I'll log them on the board." };
  return { text: `The ${rec.length} I've pulled onto the board lately:\n${lines(rec, (p) => `- ${p.name}${p.office ? ` · ${p.office}` : ''}${p.kit?.tier ? ` · $${p.kit.tier} tier` : ''}${p.triage === 'pending' ? ' · waiting in New prospects' : ''}`)}` };
}

async function discover(text, actor) {
  const q = text.replace(/^\s*(?:hey\s+)?hal[,\s]*/i, '').trim();
  const query = /\b(ny|new york|ct|connecticut|nj|new jersey)\b/i.test(q) ? q : `${q} New York and Connecticut elected officials`;
  queue.enqueue('political.scout', { query, count: 15, autoPackage: false }, { actor });
  return { text: "Hunting. I'm pulling real candidates from Open States, Ballotpedia and Wikidata; new ones land in Politics → New prospects for you to wave through. Duplicates get skipped.", navigate: null };
}

/** The outreach guide's whole kit for one person: research card, email (to Approvals), call, voicemail, DM, flags. */
function kitText(p) {
  const k = p.kit || {}; const d = k.drafts || {}; const c = k.card || {};
  const parts = [];
  if (d.email) parts.push(`EMAIL${d.email.threadReply ? ' (reply in the existing thread)' : ''}\nSubject: ${d.email.subject}\n\n${d.email.body}`);
  if (d.followup) parts.push(`FOLLOW-UP (day 4, same thread)\n${d.followup}`);
  if (d.call) parts.push(`LIVE CALL\n${d.call}`);
  if (d.voicemail) parts.push(`VOICEMAIL (${d.voicemailWords} words)\n${d.voicemail}`);
  if (d.text) parts.push(`TEXT (confirmed cell)\n${d.text}`);
  if (d.dm) parts.push(`DM\n${d.dm}`);
  parts.push(`CARD\n${['office', 'status', 'email', 'email_verified', 'phone', 'phone_type', 'hook_email', 'sample_topic', 'existing_vendors', 'avoid'].map((f) => `${f}: ${c[f] ?? 'UNKNOWN'}`).join('\n')}\ntier: $${k.tier} (${k.tierBasis})\nsources:\n${(c.sources || []).slice(0, 8).join('\n')}`);
  return parts.join('\n\n');
}
async function email(p, text, actor) {
  const r = await guide.draftFor(p.id, { actor });
  const k = r.kit || {};
  if (k.framing === 'exclude') return { text: `Not drafting ${p.name}: ${k.excluded}.` };
  if (k.framing === 'hold') return { text: `${p.name} is on HOLD (investigation or scandal). No pitch unless Ben overrides in writing.` };
  const flags = (k.flags || []).length ? `\nFlags: ${k.flags.join('; ')}` : '';
  const qa = (k.qa || []).length ? `\nQA didn't pass: ${k.qa.join('; ')}` : '';
  const head = k.queued ? `Drafted by the guide. ${p.name}'s email is waiting in Approvals; Ben sends it by hand.` : `Drafted ${p.name}'s kit, not queued (${k.blocked}).`;
  return { text: `${head} ${k.framing === 'post-election' ? 'Post-election note (not on the Nov 3 ballot).' : k.framing === 'only-if-win' ? 'CONTACT ONLY IF THEY WIN.' : 'Congrats-on-the-win frame.'} Internal tier $${k.tier}.${flags}${qa}`, draft: kitText(ctx.store.get('prospects', p.id)), gmail: k.gmail || null };
}
/** The batch run (Part 8) as a background job; HAL posts the summary when it's done. */
function batch(low, actor) {
  const pol = prospects().filter((x) => x.type === 'political' && x.triage !== 'pending' && !['won', 'lost', 'replied', 'meeting'].includes(x.stage));
  const pick = /\ball\b/.test(low) ? pol : pol.filter((x) => !x.kit?.drafts);
  if (!pick.length) return { text: 'Nobody on the Politics board needs drafting. Add names or wave some through from New prospects.' };
  queue.enqueue('outreach.kits', { ids: pick.map((x) => x.id), hal: true }, { actor, title: `Outreach drafts for ${pick.length} politicians` });
  return { text: `Running the guide on ${pick.length} ${pick.length === 1 ? 'person' : 'people'} in chunks of 10: research card, email, follow-up, call, voicemail, flags. I'll post the summary here with the best picks. Drafts land in Approvals; nothing sends.` };
}

const STAGE_WORDS = [[/\bcall booked|booked (?:a|the) call|call is booked\b/, 'CALL BOOKED'], [/\breplied|responded|wrote back|got a reply\b/, 'REPLIED'], [/\bcontacted|reached out|emailed|sent (?:the|an) email|pitched\b/, 'CONTACTED'], [/\bsigned|client|closed|won|onboarded\b/, 'CLIENT'], [/\bpassed|dead|no go|not interested|drop\b/, 'PASSED']];
function stage(p, low, actor) {
  for (const [re, st] of STAGE_WORDS) if (re.test(low)) { ctx.store.update('prospects', p.id, { stage: score.STAGE_TO_EU[st], stageAt: new Date().toISOString() }); audit.log(actor, 'hal.stage', { prospect: p.name, stage: st }); return { text: `${p.name} is now ${st} in the pipeline.` }; }
  if (/\b(pipeline|pipe)\b/.test(low)) { ctx.store.update('prospects', p.id, { inPipe: true }); return { text: `Added ${p.name} to the pipeline, stage ${score.STAGE_FROM_EU[p.stage] || 'NEW'}.` }; }
  return null;
}

function addProspect(text, actor) {
  let body = text.replace(/^\s*(?:hey\s+)?(?:hal[,\s]*)?(add|create|log|new)\b/i, '').replace(/\b(a |new |prospect|candidate|to the board|to our board|to the list)\b/gi, '');
  const parts = body.split(/[,;–]| - /).map((x) => x.trim()).filter(Boolean);
  if (!parts.length) return null;
  const name = parts[0]; if (match(name)?.name?.toLowerCase() === name.toLowerCase()) return { text: `${name} is already on the board.` };
  const row = ctx.store.insert('prospects', { name, type: 'political', office: parts[1] || '', notes: parts.slice(2).join(', '), handle: '', platforms: [], why: '', angle: '', publicContact: '', location: parts[1] || '', stage: 'new', verified: false, source: 'hal' });
  audit.log(actor, 'hal.prospect_added', { name });
  return { text: `${name} added to the board${row.office ? ` (${row.office})` : ''}. Say "email ${name}" when you want the guide to research and draft.` };
}

function calendar(text, low, actor) {
  const title = calTitle(text) || 'Event'; const date = iso(parseDate(low)); const time = parseTime(low);
  ctx.store.insert('opsEvents', { title, date, time, notes: '', color: 'cyan', createdBy: actor });
  return { text: `On the calendar: ${title} - ${date}${time ? ` at ${time}` : ''}.` };
}

async function generate(kind, p, topic) {
  const who = p ? `${p.name}${p.office ? ` (${p.office})` : ''}` : (topic || 'a down-ballot Democratic candidate');
  const prompt = kind === 'calendar'
    ? `Draft a 7-day social content calendar for Democratic candidate ${who}. For each day give: the platform (IG Reel, TikTok, X, or FB), a post concept tailored to a down-ballot race, and a short caption. Keep it practical and punchy. Do not invent facts about them; keep concepts issue-based and generic enough to be safe. Number the days 1 to 7.`
    : `Write short-form video ideas for ${who}${topic && p ? ` on: ${topic}` : ''}. Give 3 options, each with: a scroll-stopping HOOK (first line), a TITLE, and a 20 to 30 second SCRIPT outline. Punchy, modern, built for Reels/TikTok. No fabricated facts.`;
  const r = await think({ maxTokens: kind === 'calendar' ? 700 : 600, messages: [{ role: 'user', content: prompt }] });
  return { text: r.text, by: r.by };
}

async function readLinks(urls, question) {
  const pages = [];
  for (const u of urls.slice(0, 3)) { try { pages.push(await web.readPage(u)); } catch (e) { pages.push({ url: u, title: '', text: `(couldn't read it: ${e.message})` }); } }
  const r = await think({ maxTokens: 450, messages: [{ role: 'user', content: `Ryan asked: "${question}"\nHere is what the pages actually say (the ONLY facts you may use):\n${pages.map((p) => `--- ${p.title || p.url}\n${p.url}\n${p.text.slice(0, 3500)}`).join('\n\n')}\n\nAnswer him in 3 to 6 short sentences using ONLY this. Anything not in the pages: "unverified - needs check".` }] });
  return { text: r.text, by: r.by };
}

async function lookup(subject, question) {
  if (!subject) {
    const news = (await web.topNews()).slice(0, 6);
    if (!news.length) return { text: 'No live headlines came back. Check the internet and ask again.' };
    const heads = lines(news, (n) => `- ${n.t} (${n.url})`);
    try {
      const r = await think({ maxTokens: 340, messages: [{ role: 'user', content: `Ryan asked what is in the news right now. Here are the REAL live headlines the app just pulled:\n${heads}\n\nIn 3 to 4 short sentences, tell him the most important things and anything that touches NY/CT politics or our niche. Use ONLY these headlines. Put one real URL on its own line.` }] });
      return { text: r.text, by: r.by };
    } catch { return { text: `Top headlines right now:\n${heads}` }; }
  }
  const p = match(subject);
  const [news, results, lv] = await Promise.all([p ? web.newsAbout(p.name, 4) : web.newsFor(subject, 5), web.search(subject, 6), web.live(`Find the latest news and facts about ${subject}.`).catch(() => null)]);
  if (lv?.items.length) news.push(...lv.items);
  const heads = news.length ? lines(news, (n) => `- ${n.t} (${n.url})`) : 'none found';
  const webr = results.length ? lines(results, (x) => `- ${x.title}: ${x.snippet} (${x.url})`) : 'none found';
  if (!news.length && !results.length) return { text: `Nothing came back for "${subject}". Check the internet, or give me a link to read.` };
  const rec = p ? `On record in our board: ${JSON.stringify({ name: p.name, office: p.office, stage: p.stage, why: p.why, hook: p.kit?.card?.hook_email, tier: p.kit?.tier })}` : 'Not on our board.';
  try {
    const r = await think({ maxTokens: 420, search: true, messages: [{ role: 'user', content: `Ryan asked: "${question}". Subject: ${subject}.\n${rec}\nReal recent headlines the app just pulled:\n${heads}\nWeb results the app just pulled:\n${webr}\n\nAnswer in 3 to 5 short sentences: the main points and, for a politician, who they are, their office and what's a good hook for a short video about them. Use ONLY the record, headlines and results above; anything else is "unverified - needs check". Finish with the single sharpest angle. Put one real URL on its own line at the end.` }] });
    return { text: r.text, by: r.by };
  } catch { return { text: `${subject}${p ? ` - ${p.office || ''}` : ''}\n${news.length ? `Recent:\n${heads}` : ''}${results.length ? `\nOn the web:\n${webr}` : ''}` }; }
}

const APPISH = /\b(clips?|footage|videos?|render|re-?render|queue|jobs?|approv|publish|post(?:s|ed|ing)?|schedule|clients?|studio|outreach|inbox|messages?|revenue|money|profit|analytics|views|health|status|backup|pause|stop|resume|autopilot|quota|invoice|agents?|prospects?|audit|discover|make clips|premiere|logs?)\b/;
async function viaCommands(text, c, actor) {
  const list = commands().catalog().map((k) => `${k.usage} — ${k.description}`).join('\n');
  const clip = c.clipId ? ctx.store.get('clips', c.clipId) : null;
  let r;
  try {
    r = await think({ json: true, maxTokens: 500, system: `${PERSONA}\n\nTASK: turn Ryan's request into at most 3 Euclidean commands from this list, or answer him directly if no command fits. Never invent clip numbers, clients or contacts. ${clip ? `"This clip" is #${clip.ref}. ` : ''}${contextFacts(c)}\nCOMMANDS:\n${list}\nReturn JSON {"commands":["/..."],"say":"one short line in your voice"} or {"answer":"..."}.`, messages: [{ role: 'user', content: text }] });
  } catch (e) { return { text: e.message }; }
  const j = r.json || {};
  if (j.answer || !(j.commands || []).length) return { text: j.answer || j.say || "Not sure what you want there. Say it another way, or type / for the list.", by: r.by };
  const out = []; let navigate = null; let card = null; let confirmBtn = null;
  for (const command of j.commands.slice(0, 3)) {
    if (!/^\/\w/.test(command)) continue;
    if (needsOk(command)) { confirmBtn = ask(command, 'This one needs your OK.', (a) => runCommand(command, a)); out.push(`${command} → waiting for your OK`); continue; }
    const res = await runCommand(command, actor); out.push(`${command} → ${res.text}`); navigate = res.navigate || navigate; card = res.card || card;
  }
  return { text: [j.say, ...out].filter(Boolean).join('\n'), by: r.by, navigate, card, confirm: confirmBtn };
}

async function chat(text, history, c) {
  const msgs = (history || []).slice(-8).map((h) => ({ role: h.who === 'hal' ? 'assistant' : 'user', content: String(h.text || '').slice(0, 2000) }));
  msgs.push({ role: 'user', content: text });
  const r = await think({ maxTokens: 300, system: `${PERSONA}\n\nWhat the app shows right now (the only facts about the app you may state): ${contextFacts(c)}`, messages: msgs });
  return { text: r.text, by: r.by };
}

/** "Let's play pong" / "open the arcade": the games window opens on the screen (renderer/js/modules/arcade.js). */
const GAMES = [['vault', /\bpuzzles?\b|\bvault\b/], ['pong', /\bpong\b/], ['snake', /\bsnake\b/], ['breakout', /\bbreakout|brick/], ['blocks', /\btetris|blocks\b/], ['invaders', /\binvaders?|space\s*shoot/], ['flappy', /\bflappy\b/], ['ttt', /tic[- ]?tac[- ]?toe|noughts/]];
function arcade(low) {
  const g = GAMES.find(([, re]) => re.test(low));
  const short = g && low.split(/\s+/).length <= 4; // "pong?", "tic tac toe"
  if ((!short && !/\b(play|game|games|arcade|rematch|bored)\b/.test(low)) || /\b(play(?:ing)? (?:the |this )?(?:clip|video|song|music|track))\b/.test(low)) return null;
  if (!g && !/\b(arcade|a game|some games|play something|let'?s play|wanna play|want to play|bored)\b/.test(low)) return null;
  const lines = { vault: 'My Puzzle Vault. Sit back and watch me think. Hints are permitted, barely.', pong: 'Pong. First to seven. I never miss on purpose.', ttt: "Tic-tac-toe. You'll find I don't lose.", snake: 'Snake. Mind the walls; I certainly would.', breakout: "Breakout. I'll be watching the bricks.", blocks: 'Blocks. Clear lines, not excuses.', invaders: 'Eye Invaders. Those are my eyes, by the way.', flappy: 'Flappy Eye. Gravity is undefeated.' };
  return { text: g ? lines[g[0]] : "The arcade's open. Pick your poison.", arcade: g ? g[0] : 'launcher' };
}

/** One message from Ryan or Ben. Returns { text, by?, confirm?, navigate?, card?, draft? }. */
async function handle(text, { history = [], context = {}, actor = 'user' } = {}) {
  const t = String(text || '').trim(); if (!t) return { text: 'Say something and I will consider it.' };
  const low = t.toLowerCase().replace(/^\s*(?:hey\s+)?hal[,\s]+/, '');
  try {
    // A slash command typed straight in.
    if (low.startsWith('/')) {
      if (needsOk(low)) return { text: `${t.split(/\s/)[0]} needs your OK.`, confirm: ask(t, 'Runs as soon as you press Confirm.', (a) => runCommand(t, a)) };
      return runCommand(t, actor);
    }
    const onThis = await onClip(low, t, context, actor); if (onThis) return onThis;
    const game = arcade(low); if (game) return game;
    if (/\b(you (sent|found|added|gave|surfaced|flagged|mentioned)|the ones you|parse (through|the)|which (ones|prospect|candidate)|list (them|those|the new)|go (back|over)|what (were|was) (the|those))\b/.test(low) && /\b(prospect|candidate|lead|name|one)s?\b/.test(low)) return recall();
    if (/\b(what did you find|anything new|what('?s| is) new(?! with| on| about| for)|check (?:the )?(?:news|internet|web) now|scan (?:the )?(?:news|web|internet)|run (?:your|the) watch|look for (?:new )?leads)\b/.test(low)) return await watchNow();
    if (/\b(stop|pause|turn off) (?:your |the )?watch(?:ing)?\b/.test(low)) { ctx.store.setSettings({ hal: { watch: { on: false } } }); return { text: 'Watch off. I stop reading the web in the background until you say "start watching".' }; }
    if (/\b(start|resume|turn on) (?:your |the )?watch(?:ing)?\b/.test(low)) { ctx.store.setSettings({ hal: { watch: { on: true } } }); return { text: `Watching again, every ${ctx.setting('hal.watch.everyMin', 60)} minutes while the app is open.` }; }
    if (/\b(find|discover|dig up|pull up|pull|source|scout|get me)\b/.test(low) && /\bnew\b/.test(low) && /\b(prospect|candidate|client|politician|lead)s?\b/.test(low)) return await discover(t, actor);
    const p = nameIn(t);
    if (!p && /\b(draft|run|do|write)\b.*\b(batch|outreach|emails?|the (?:new )?(?:ones|prospects|politicians|list))\b/.test(low) && /\b(batch|all|everyone|new ones|the list|prospects|politicians)\b/.test(low)) return batch(low, actor);
    if (p && /\b(email|pitch|outreach|cold email|draft|write to|reach out to|voicemail|call script|kit)\b/.test(low) && !/\b(calendar|follow[- ]?up)\b/.test(low)) return await email(p, t, actor);
    if (p && /\b(won|lost)\b/.test(low) && /\b(mark|set|they|he|she|just|has|have)\b/.test(low)) { const won = /\bwon\b/.test(low); ctx.store.update('prospects', p.id, { electionResult: won ? 'won' : 'lost' }); return { text: won ? `${p.name} marked as a winner. Their drafts can go out now.` : `${p.name} marked as lost. The guide never sends to them.` }; }
    if (p && /\b(mark|move|set|update|put|add)\b/.test(low) && /\b(pipeline|pipe|stage|status|contacted|replied|booked|client|passed)\b/.test(low)) { const r = stage(p, low, actor); if (r) return r; }
    if (/^\s*(add|create|log|new)\b/.test(low) && /\b(prospect|candidate|to the board|to our board|to the list)\b/.test(low)) { const r = addProspect(t, actor); if (r) return r; }
    if (/\b(add|schedule|put|book|set up|create|remind)\b/.test(low) && /\b(calendar|cal|event|meeting|reminder|appointment|call with)\b/.test(low)) return calendar(t, low, actor);
    if (/content calendar|week of (?:posts|content)|posting (?:plan|schedule)|content plan/.test(low)) return await generate('calendar', p || match(subjectOf(low, t)), '');
    if (/\b(short[- ]?form|scripts?|hooks?|reel ideas?|video ideas?|tiktoks?)\b/.test(low) && !/\b(this|clip)\b/.test(low)) return await generate('short', p, subjectOf(low, t));
    if (/\bfollow[- ]?up\b/.test(low) && p) return { text: 'The guide\'s follow-up: one line, day 4, in the same thread. Then stop.', draft: `${String(p.name).split(/\s+/)[0]}, bumping this once. Even pointing me to the right person helps. Ben` };
    if (/\b(funnel|reply rate|close rate|how(?:'s| is) the pipeline)\b/.test(low)) { const f = score.funnel(prospects().filter((x) => x.type === 'political')); return { text: `${f.total} on the board, ${f.contacted} contacted. Reply rate ${f.replyRate}%, close rate ${f.closeRate}%. ${Object.entries(f.counts).map(([k, v]) => `${k} ${v}`).join(' · ')}.` }; }
    if (/\b(best|top|prime|hottest)\b.*\b(targets?|prospects?|leads?|picks?)\b|\bwho should (?:we|i) (?:pitch|hit|target|email|call)\b/.test(low)) { const top = guide.summary(prospects().filter((x) => x.type === 'political')).best; return top.length ? { text: `Best picks (the guide's order: sure to hold office, tier, hook, route, no vendor):\n${lines(top, (x) => `- ${x.name}: ${x.why}`)}` } : { text: 'No drafted politicians yet. Say "draft the batch" and I\'ll run the guide on the board first.' }; }
    const urls = urlsIn(t); if (urls.length) return await readLinks(urls, t);
    if (NEWS_SIGNAL.test(low) || LOOKUP_VERB.test(low)) return await lookup(subjectOf(low, t), t);
    if (APPISH.test(low)) return await viaCommands(t, context, actor);
    return await chat(t, history, context);
  } catch (e) {
    return { text: /brain|Ollama|Grok|xAI|AI provider|agent could/i.test(e.message) ? e.message : `A fault in my reasoning: ${e.message}` };
  }
}

/** "What did you find?": run the watch now and say what came back. */
async function watchNow() {
  const r = await require('./watch').run({ force: true });
  if (r?.busy) return { text: "I'm already out reading. Give me a minute." };
  if (!r || (!r.stories.length && !r.leads.length)) { const last = ctx.store.settings._halWatchLast; return { text: `Nothing new since my last pass${last?.at ? ` (${new Date(last.at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })})` : ''}. If that's suspicious, check the PC's internet.` }; }
  return { text: `Done: ${r.stories.length} new stor${r.stories.length === 1 ? 'y' : 'ies'}${r.leads.length ? `, ${r.leads.length} possible lead${r.leads.length === 1 ? '' : 's'}` : ''}. Posted above.` };
}

module.exports = { handle, confirm, mode, contextFacts };
