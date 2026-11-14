'use strict';
/**
 * Baseline videos for the political ad machine, and reading a typed order.
 *
 * A template is a story shape with blanks, filled only with lines the politician actually says:
 *   "I'm ___, and ___. So I ___. ___. [closing line]  ·  <Name> for <place>"
 * Each blank is a BEAT (hook, who, problem, action, result, proof, place, story, contrast, promise, rally). The story
 * picker (footage.pickStory) finds the best line for each beat, in order, about the topic when one is given.
 *
 * An order is one line of plain typing per video: "housing", "quick video about childcare", "intro", "what she delivered,
 * cinematic, horizontal", or a whole prompt. parseAsk turns it into { template, topic, seconds, style, density, wide }.
 */

/** What each beat sounds like (scores a sentence; higher = better fit). x = { text, s, e }. */
const BEATS = {
  hook: null, // scored by footage.hookScore
  rally: null, // scored by footage.outroScore
  who: (t) => (/\bI(?:'m| am) (?:a |an |the |your |[A-Z])|\bI represent|\bI(?:'ve| have) (?:served|been|spent|lived)|\bmy (?:name|district|family|mother|father|parents)|\bI grew up|\bas (?:a|an|your) [a-z]+/i.test(t) ? 5 : 0) + (/\b(I|my)\b/.test(t) ? 1 : 0),
  problem: (t) => (/\b(can'?t afford|too (?:high|many|much|expensive)|rising|crisis|struggl|losing|lost|cut(?:s|ting)?|attack|threat|broken|unfair|fail(?:ed|ing)?|worse|no longer|priced out|shortage|closing|under ?funded|waiting|denied)\b/i.test(t) ? 4 : 0) + (/\b(families|people|workers|seniors|kids|tenants|neighbors|New Yorkers)\b/i.test(t) ? 1 : 0),
  action: (t) => (/\b(I|we) (?:passed|wrote|introduced|sponsored|carried|fought|led|voted|secured|built|created|launched|brought|delivered|worked|stood|organized|pushed|negotiated)\b/i.test(t) ? 5 : 0) + (/\b(that'?s why|so (?:I|we))\b/i.test(t) ? 2 : 0) + (/\b(bill|law|legislation|budget|act)\b/i.test(t) ? 1 : 0),
  result: (t) => (/\b(now|today|because of|as a result|that means|thanks to|for the first time|already|since then)\b/i.test(t) ? 3 : 0) + (/\d/.test(t) ? 2 : 0) + (/\b(saved|lower(?:ed)?|more|new|free|funded|opened|expanded|protected|restored|won|delivered|secured)\b/i.test(t) ? 2 : 0),
  proof: (t) => (/\b(passed|wrote|bill|law|fought|delivered|secured|won|led|built|carried|introduced|funding|signed)\b/i.test(t) ? 4 : 0) + (/\d/.test(t) ? 2 : 0),
  place: (t) => (/\b(district|community|neighbo|our streets|our town|our city|county|borough|here in|home|block|village|upstate|downstate)\b/i.test(t) ? 4 : 0) + (/\b(in|for|across) [A-Z][a-z]+/.test(t) ? 1 : 0),
  story: (t) => (/\b(walked|grew up|remember|when I|years ago|my (?:mother|father|grand|mom|dad)|history|story|said|told me|met a|one day|the first time)\b/i.test(t) ? 4 : 0) + (/\b(right|privilege|dream|believe)\b/i.test(t) ? 1 : 0),
  contrast: (t) => (/\b(they|while|instead|but|not|never)\b/i.test(t) ? 1 : 0) + (/\b(billionaire|wealthiest|corporat|special interests|lobbyist|landlord|trump|washington|albany insiders|politicians)\b/i.test(t) ? 4 : 0),
  promise: (t) => (/\b(I will|I'll|we will|we'll|I'm going to|we're going to|I won'?t|we won'?t|my plan|we can|we must|we need to)\b/i.test(t) ? 5 : 0) + (/\b(every|always|never)\b/i.test(t) ? 1 : 0),
};

/**
 * The baselines. beats = the blanks in order (the first is always the opening hook, the last the closing line);
 * a beat in [brackets] in `formula` is one line of theirs. sec = how much talk to aim for.
 */
const TEMPLATES = [
  { id: 'script', name: 'Follow my script', formula: 'your lines, in your order', about: 'Type "script:" then your rough script. It finds where they say each line in the footage and cuts them together in that order, with plain cuts and captions.', beats: ['hook', 'rally'], sec: 30, starter: 'script: ' },
  { id: 'topic', name: 'About a topic', formula: '[the stake] · [what they did about it] · [what it means for people] · [closing line]', about: 'One issue, start to finish. Type the topic and it finds what they said about it.', beats: ['hook', 'problem', 'action', 'result', 'rally'], sec: 26, needsTopic: true },
  { id: 'quick', name: 'Quick video', formula: '[hook] · [one proof] · [closing line]', about: 'Three lines, about 12 seconds. For daily posts.', beats: ['hook', 'proof', 'rally'], sec: 12 },
  { id: 'intro', name: 'Meet them', formula: "[I'm ___] · [what I fight for] · [what I've done] · [where] · [closing line]", about: 'Who they are and why they serve. The first video for a new client.', beats: ['who', 'promise', 'proof', 'place', 'rally'], sec: 26, openWith: 'who' },
  { id: 'delivered', name: 'What they delivered', formula: '[the claim] · [win] · [win] · [win] · [closing line]', about: 'Results, one after another. Best with numbers and bills.', beats: ['hook', 'action', 'result', 'proof', 'rally'], sec: 26 },
  { id: 'problem', name: 'Problem, then the fix', formula: '[the problem] · [so I ___] · [the result] · [closing line]', about: 'What is wrong, what they did, what changed.', beats: ['problem', 'action', 'result', 'rally'], sec: 22, openWith: 'problem' },
  { id: 'local', name: 'For this place', formula: '[here in ___] · [what is at stake here] · [what they did here] · [closing line]', about: 'Built around their district, with the map.', beats: ['place', 'problem', 'action', 'rally'], sec: 24, openWith: 'place' },
  { id: 'fight', name: 'The fight', formula: '[what they are up against] · [why it matters] · [I will not ___] · [closing line]', about: 'Stakes and resolve. Higher energy.', beats: ['contrast', 'problem', 'promise', 'rally'], sec: 22, openWith: 'contrast' },
  { id: 'story', name: 'A moment', formula: '[a story or memory] · [what it taught them] · [what they do now] · [closing line]', about: 'Personal and slower. Good in the On location or Cinematic styles.', beats: ['story', 'who', 'promise', 'rally'], sec: 28, openWith: 'story' },
  { id: 'explainer', name: 'One thing explained', formula: '[the issue in one line] · [how it works, or the number] · [who it helps] · [what happens next] · [closing line]', about: 'A policy made simple. Works well To camera or as an Explainer.', beats: ['hook', 'proof', 'result', 'promise', 'rally'], sec: 28 },
  { id: 'numbers', name: 'By the numbers', formula: '[a number] · [a number] · [what it adds up to] · [closing line]', about: 'Lines with figures in them, each with its own graphic.', beats: ['result', 'proof', 'action', 'rally'], sec: 20, openWith: 'result' },
  { id: 'promise', name: 'What comes next', formula: '[where things stand] · [I will ___] · [I will ___] · [closing line]', about: 'Plans and commitments, looking forward.', beats: ['problem', 'promise', 'promise', 'rally'], sec: 22, openWith: 'problem' },
  { id: 'values', name: 'What they believe', formula: '[a belief] · [where it comes from] · [what they do about it] · [closing line]', about: 'Convictions in their own words. Calm and direct.', beats: ['hook', 'story', 'action', 'rally'], sec: 24 },
  { id: 'people', name: 'Who they fight for', formula: '[the people] · [what they are facing] · [what was done for them] · [closing line]', about: 'Built around constituents: families, workers, seniors, tenants.', beats: ['place', 'problem', 'result', 'rally'], sec: 24, openWith: 'place' },
  { id: 'callout', name: 'Calling it out', formula: '[what the other side is doing] · [the cost to people] · [what they stand for instead] · [closing line]', about: 'Contrast in their own words only. Always check this one yourself before it goes anywhere.', beats: ['contrast', 'problem', 'promise', 'rally'], sec: 22, openWith: 'contrast', review: true },
  { id: 'update', name: 'Quick update', formula: '[what just happened] · [what it means] · [closing line]', about: 'News from them this week, short.', beats: ['action', 'result', 'rally'], sec: 15, openWith: 'action' },
  // Everyday social content for people already in office (not race ads).
  { id: 'district', name: 'In the district', formula: '[where they are or who they met] · [what is happening there] · [what they are doing about it] · [closing line]', about: 'A visit, an event, a neighbourhood. Good with B-roll.', beats: ['place', 'story', 'action', 'rally'], sec: 22, openWith: 'place' },
  { id: 'vote', name: 'Why I voted', formula: '[the bill or vote] · [what it does] · [why they voted that way] · [closing line]', about: 'One vote or bill explained in their own words.', beats: ['action', 'result', 'promise', 'rally'], sec: 24, openWith: 'action' },
  { id: 'help', name: 'How we can help', formula: '[a problem people bring to the office] · [what the office does] · [how to reach them] · [closing line]', about: 'Constituent services: what their office can do for people.', beats: ['problem', 'action', 'place', 'rally'], sec: 22, openWith: 'problem' },
  { id: 'myth', name: 'Setting it straight', formula: '[what people get wrong] · [the fact or number] · [what it means] · [closing line]', about: 'A claim corrected with their own facts.', beats: ['contrast', 'proof', 'result', 'rally'], sec: 22, openWith: 'contrast' },
  { id: 'clip', name: 'One strong moment', formula: '[the moment, uncut] · [closing line]', about: 'Their single best stretch, kept together, for a daily post.', beats: ['hook', 'proof', 'rally'], sec: 18 },
  { id: 'best', name: 'Best of the footage', formula: '[hook] · [who] · [proof] · [place] · [story] · [closing line]', about: 'The strongest story the footage can tell, picked automatically.', beats: ['hook', 'who', 'proof', 'place', 'story', 'rally'], sec: 26 },
];
const byId = (id) => TEMPLATES.find((t) => t.id === id) || null;

// Words in a typed order that name a baseline, a length, a shape or how much graphics.
const TEMPLATE_WORDS = {
  quick: /\b(quick|short|fast|snappy|daily|15.?sec(ond)?s?|10.?sec(ond)?s?|teaser|bite)\b/i,
  intro: /\b(intro(duction)?|meet (him|her|them)|who (he|she|they) (is|are)|about (him|her|them)|bio|introduc(e|ing))\b/i,
  delivered: /\b(deliver(ed|s)?|results?|wins?|accomplish(ed|ments?)?|record|what (he|she|they)('?ve| has| have)? (done|won|passed)|track record)\b/i,
  problem: /\b(problem|fix(ed|es)?|solution|solv(e|ed|ing))\b/i,
  local: /\b(local|district|hometown|community|neighbou?rhood|for (this|the) (place|town|city|county))\b/i,
  fight: /\b(fight(ing)?|attack|contrast|stand(ing)? up|taking on|against)\b/i,
  story: /\b(story|moment|personal|memory|background|emotional|why (he|she|they) (ran|serve))\b/i,
  explainer: /\b(explain(er|ed|s|ing)?|how it works|break(ing)? down|what is|what's the)\b/i,
  numbers: /\b(numbers?|stats?|figures?|data|by the numbers)\b/i,
  promise: /\b(next|plans?|promis(e|es)|will do|agenda|priorities|going forward)\b/i,
  values: /\b(values?|believ(e|es)|principles?|stands? for|why (he|she|they) care)\b/i,
  people: /\b(who (he|she|they) fights? for|constituents?|the people|working families|for families)\b/i,
  callout: /\b(call(ing|s)? out|opponent|the other side|hold(ing)? .* accountable)\b/i,
  update: /\b(update|this week|news|just (passed|happened|announced)|announcement)\b/i,
  district: /\b(in the district|visit(ed|ing)?|tour(ed|ing)?|event|town hall|neighbou?rhood walk)\b/i,
  vote: /\b(why (i|he|she|they) voted|vote explained|my vote|(his|her|their) vote)\b/i,
  help: /\b(constituent services?|how (we|the office) can help|office hours|casework)\b/i,
  myth: /\b(myth|fact check|setting it straight|misinformation|get(s)? wrong)\b/i,
  clip: /\b(one moment|strong moment|single clip|best moment|uncut)\b/i,
  best: /\b(best of|best lines?|highlights?|anything|whatever|surprise me|strongest)\b/i,
};
const FILLER = /\b(what|she|he|they|has|have|had|done|did|does|do|make|made|give|want|need|some|this|an?|the|video|videos|ad|ads|clip|reel|short|one|make|me|us|please|about|on|for|of|with|in|style|look|vertical|horizontal|wide|landscape|portrait|and|that|is|it|a quick|quick|second|seconds|sec|long|their|his|her)\b/gi;

/**
 * One typed line → what to make. looks = server/political/looks (passed in to avoid a circular load).
 * "housing"                                  → the topic template about housing
 * "quick video about childcare"              → quick, topic childcare
 * "intro, cinematic, horizontal"             → intro, Cinematic look, 16:9 too
 * "what she delivered on transit, captions only" → delivered, topic transit, graphics level minimal
 * A long line (12+ words) is kept whole as the brief for the story picker.
 */
function parseAsk(line, looks) {
  const raw = String(line || '').replace(/^\s*(?:\d+[.)]|[-*•])\s*/, '').trim().slice(0, 600);
  if (!raw) return null;
  // "script: line one. line two." = follow these lines in this order (plain To camera cuts unless a style is named after a |).
  const sm = raw.match(/^script\s*[:\-]\s*(.+)$/i);
  if (sm) { const [body, opt = ''] = sm[1].split(/\s*\|\s*/); const o = opt ? parseAsk(opt, looks) : null; return { ask: raw, template: 'script', topic: '', brief: body.trim(), seconds: null, style: o?.style || 'direct', density: o?.density || null, wide: !!o?.wide }; }
  // "hook: most people in Albany" = open with the line of theirs closest to these words ("hook: #12" = that line), and
  // build the rest around it. Options after a bar: "hook: rent is too high | quick, on location".
  const hm = raw.match(/^hook\s*[:\-]\s*(.+)$/i);
  if (hm) { const [body, opt = ''] = hm[1].split(/\s*\|\s*/); const o = opt ? parseAsk(opt, looks) : null; const num = body.match(/^#\s*(\d+)\b/); return { ...(o || { template: 'best', topic: '', brief: '', seconds: null, style: null, density: null, wide: false }), ask: raw, hook: num ? '' : body.trim(), hookId: num ? Number(num[1]) : null }; }
  let template = null;
  for (const [id, re] of Object.entries(TEMPLATE_WORDS)) if (re.test(raw)) { template = id; break; }
  const m = raw.match(/\b(\d{1,3})\s*-?\s*(?:s|sec|secs|second|seconds)\b/i);
  const seconds = m ? Math.max(8, Math.min(90, Number(m[1]))) : null;
  const wide = /\b(horizontal|wide|landscape|16[:x]9|youtube)\b/i.test(raw);
  const density = /\b(captions? only|no graphics|just captions|minimal)\b/i.test(raw) ? 'minimal' : /\b(less|fewer|light) graphics\b/i.test(raw) ? 'light' : /\b(all|full|lots of|heavy|max(imum)?) graphics\b/i.test(raw) ? 'full' : null;
  // The kind of edit, when the line says so: "straight cut" / "no captions" = only the cuts; "captions only"; "no music".
  const edit = {};
  if (/\b(straight cut|raw cut|just the cuts?|no captions|no text|no subtitles)\b/i.test(raw)) edit.kind = 'raw';
  else if (/\b(captions? only|just captions|subtitles only)\b/i.test(raw)) edit.kind = 'captions';
  else if (/\b(clean edit|no graphics|no headlines?)\b/i.test(raw)) edit.kind = 'clean';
  if (/\b(no music|without music)\b/i.test(raw)) edit.music = false;
  if (/\b(no (sound effects|sounds|sfx))\b/i.test(raw)) edit.sounds = 'off';
  if (/\b(no end ?card|no outro card)\b/i.test(raw)) edit.endCard = false;
  // A style named in the line (by a preset's own name first, then by the words that suggest one).
  let style = null;
  if (looks) {
    const named = Object.entries(looks.PRESETS).find(([, p]) => new RegExp(`\\b${String(p.name).replace(/[^a-z ]/gi, '').trim()}\\b`, 'i').test(raw));
    const WORD = [['pastel', 'pastel'], ['to.?camera|direct to camera', 'direct'], ['on location', 'field'], ['street|vlog', 'street'], ['tiktok', 'tiktok'], ['cinematic|film look', 'cinematic'], ['breaking news|news style|news look', 'news'], ['bold blocks?|bold', 'bold'], ['dark', 'dark'], ['patriotic|red,? white and blue', 'patriotic'], ['grassroots', 'grassroots'], ['zine', 'zine'], ['poster', 'poster'], ['y2k', 'y2k'], ['documentary', 'doc'], ['clean', 'clean'], ['bright|poppy', 'bright']].find(([re]) => new RegExp(`\\b(${re})\\b`, 'i').test(raw));
    style = named ? named[0] : WORD ? WORD[1] : (/\b(style|look|cinematic|tiktok|news|pastel|bold|street|vlog|to.?camera|on location|dark|patriotic|grassroots|zine|poster|y2k|documentary|clean)\b/i.test(raw) ? looks.guess(raw) : null);
  }
  // The topic: what's left after the instruction words (a long line is a brief and is kept whole).
  const words = raw.split(/\s+/).length;
  let topic = raw;
  if (words < 12) {
    topic = raw.replace(/\b\d{1,3}\s*-?\s*(?:s|sec|secs|second|seconds)\b/gi, ' ').replace(/\b(captions? only|no graphics|just captions|less graphics|fewer graphics|all graphics|16[:x]9|straight cut|raw cut|just the cuts?|no captions|no text|no subtitles|subtitles only|clean edit|no headlines?|no music|without music|no sound effects|no sounds|no sfx|no end ?card|no outro card)\b/gi, ' ');
    for (const re of Object.values(TEMPLATE_WORDS)) topic = topic.replace(new RegExp(re.source, 'gi'), ' ');
    if (style && looks) topic = topic.replace(new RegExp(`\\b${String(looks.PRESETS[style].name).replace(/[^a-z ]/gi, '').trim()}\\b`, 'gi'), ' ').replace(/\b(cinematic|tiktok|news|pastel|bold|street|vlog|to.?camera|on location|dark|patriotic|grassroots|zine|poster|y2k|documentary|clean|minimal)\b/gi, ' ');
    topic = topic.replace(FILLER, ' ').replace(/[,.;:!?]+/g, ' ').replace(/\s+/g, ' ').trim();
  }
  if (!template) template = topic ? 'topic' : 'best';
  if (template === 'topic' && !topic) template = 'best';
  return { ask: raw, template, topic, brief: words >= 12 ? raw : '', seconds, style, density, wide, ...(Object.keys(edit).length ? { edit } : {}) };
}

/** A typed box (one video per line) → orders. */
function parseOrders(text, looks) {
  const out = [];
  for (const l of String(text || '').split(/\r?\n|;\s*/)) {
    // "3 hooks about housing" = the same video three times, each opening with a different one of their best hooks.
    const m = l.match(/^\s*(\d)\s+(?:different\s+)?(?:hooks?|openings?|hook tests?)\b\s*(?:for|about|on|,|:)?\s*(.*)$/i);
    if (m && Number(m[1]) >= 2) { const o = parseAsk(m[2] || 'best of', looks) || parseAsk('best of', looks); for (let i = 0; i < Math.min(6, Number(m[1])); i++) out.push({ ...o, ask: `Hook ${i + 1} of ${Math.min(6, Number(m[1]))}${o.topic ? `: ${o.topic}` : ''}`, hookRank: i }); continue; }
    const o = parseAsk(l, looks); if (o) out.push(o);
  }
  return out.slice(0, 40);
}

/** The baselines as the UI and the connector list them. */
const list = () => TEMPLATES.map(({ id, name, formula, about, sec, needsTopic, review, starter }) => ({ id, name, formula, about, seconds: sec, needsTopic: !!needsTopic, review: !!review, starter: starter || '' }));

module.exports = { TEMPLATES, BEATS, byId, list, parseAsk, parseOrders };
