'use strict';
/**
 * Deep research: the bots' engine for big jobs ("scout 10 ambitious young Democrats who won in NY or CT", "find every
 * ... with sources", "do a deep search"). A small local model can't steer a 30-step search on its own (it searched
 * once with the whole message and then answered from memory), so the steps are run in code and the AI only does
 * small, checkable parts:
 *
 *  1. Plan: what is wanted (people / facts), how many, the rules they must meet, and 6-10 short search queries.
 *  2. Search each query (DuckDuckGo, free; Google too when asked and a key is set), in the bot's own browser when
 *     the person asked for it (so it can be watched live), and keep the best links.
 *  3. Read the best pages one by one (browser or the text reader).
 *  4. From each page, pull out candidates WITH the sentence that shows it. A name or fact is kept only when it is
 *     really on that page (checked in code), so nothing comes from the model's memory.
 *  5. Merge the same person across pages, check each against the rules using only what the pages say
 *     (state named in the request must appear in their evidence; the AI judges the rest), drop the misses.
 *  6. Not enough? One more round of searches aimed at what's missing.
 *  7. The answer: a numbered list with the evidence and links, saved to the Data tab.
 * Every step shows in the bot's chat as it happens. Stops when the person presses Stop.
 */
const ctx = require('../core/ctx');
const paths = require('../core/paths');
const path = require('path');
const web = require('../integrations/websearch');
const ai = require('../integrations/ai');

const STATES = { AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming' };
// Lower-case abbreviations that are also English words only count when written in capitals (IN, OR, ME, HI...).
const WORDY = new Set(['IN', 'OR', 'OK', 'HI', 'DE', 'LA', 'PA', 'MA', 'CO', 'AR', 'AL', 'ID', 'ME', 'OH', 'WA', 'MO', 'MS', 'MT', 'NE', 'SC', 'IA', 'AK', 'UT', 'GA', 'VA', 'WI', 'MI']);
function statesIn(text) {
  // Shouted sentences ("USE THE BROWSER IN YOUR COMPUTER") are read in lower case, so "IN" isn't Indiana.
  const t = String(text || '').replace(/\b[A-Z]{2,}(\s+[A-Z]{2,}){2,}\b/g, (m) => m.toLowerCase());
  return Object.entries(STATES).filter(([ab, nm]) => new RegExp(`\\b${nm}\\b`, 'i').test(t) || new RegExp(`\\b${ab}\\b`).test(t) || (!WORDY.has(ab) && new RegExp(`\\b${ab.toLowerCase()}\\b`).test(t))).map(([ab, nm]) => ({ ab, nm }));
}
const SKIP_URL = /youtube\.com\/watch|tiktok\.com|instagram\.com|facebook\.com|x\.com\/|twitter\.com|linkedin\.com|reddit\.com|pinterest\.|\.(mp4|mp3|zip|pptx?|xlsx?)(\?|$)/i;
const NUM = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30 };

/** Is this a big job (a list to scout, a deep or overnight search) rather than a quick question? */
function isDeepTask(text) {
  const t = String(text || '').toLowerCase();
  if (/\b(deep|thorough|full|comprehensive|exhaustive) (search|research|dive|inquiry|look)|\bovernight\b|\buntil \d{1,2}(:\d\d)? ?(am|pm)\b|\btake your time\b|\bdig (deep|into)\b/.test(t)) return true;
  return /\b(scout|find|list|compile|gather|identify|research|look for|round up|pull)\b[^.?!]{0,80}\b(\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten|twelve|fifteen|twenty|thirty|several|a list of|some)\b[^.?!]{0,60}\b(people|politicians|democrats|republicans|candidates|officials|members|legislators|creators|channels|leads|prospects|companies|organizations|businesses|names|winners|reps?|senators|mayors|councilmembers?|activists|journalists|reporters|influencers)\b/.test(t);
}
const wantsBrowser = (t) => /\b(your|the|its|in a|with the|use (the|a|your)) (own )?browser\b|\bbrowser\b.*\b(computer|duckduck)|\bin your computer\b|\bwatch you\b/i.test(String(t || ''));
const wantsGoogle = (t) => /\bgoogle\b|\bserper\b/i.test(String(t || ''));

/** Strip the instructions out of a request so what's left can be searched. */
function cleanTask(text) {
  return String(text || '').replace(/\s+/g, ' ')
    .replace(/\b(use|using) (your|the|a) (own )?(browser|computer|internet|duck ?duck(go)?( browser)?|google)( (and|&) (the )?(internet|browser|duck ?duck(go)?( browser)?|google))*( (in|on) your computer)?( if needed)?\b/gi, ' ')
    .replace(/\b(use|using) (google|duck ?duck(go)?)\b[^.,;]*/gi, ' ').replace(/\b(the )?duck ?duck(go)? browser( in your computer)?\b/gi, ' ').replace(/\bin your (own )?(computer|browser)\b/gi, ' ')
    .replace(/\b(do|run|make) a (deep|thorough|full|quick) (search|research|dive)\b/gi, ' ')
    .replace(/\byou have until [^,.;]+/gi, ' ').replace(/\b(overnight|asap|please|thanks?|thank you)\b/gi, ' ')
    .replace(/\bif needed\b/gi, ' ').replace(/[,;]\s*(,|;)+/g, ',').replace(/\s{2,}/g, ' ').trim();
}

function plainQueries(task) {
  const t = cleanTask(task).toLowerCase();
  const states = statesIn(cleanTask(task)).map((x) => x.nm);
  const subject = (/\b(democrats?|republicans?|politicians?|candidates?|officials?|legislators?|creators?|youtubers?|mayors?|state senators?|assembly ?members?|council ?members?)\b/.exec(t) || [])[1] || '';
  const year = (/\b(20\d\d)\b/.exec(t) || [])[1] || String(new Date().getFullYear());
  const base = t.replace(/\b(scout|find|list|compile|gather|identify|research|look for|me|some|\d+|one|two|three|four|five|six|seven|eight|nine|ten|twelve|fifteen|twenty)\b/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
  const out = [];
  for (const st of states.length ? states : ['']) {
    if (subject) {
      out.push(`young ${subject} ${st} ${year} winners`.trim(), `${st} ${subject} rising stars ${year}`.trim(), `${st} youngest elected ${subject} ${year}`.trim(), `${st} ${subject} won election ${year} first term`.trim());
    }
  }
  out.push(base);
  return [...new Set(out.map((q) => q.replace(/\s+/g, ' ').trim()).filter((q) => q.length > 5))].slice(0, 10);
}

async function plan(task, onStep) {
  const t = cleanTask(task);
  const n = Number((/\b(\d{1,3})\b/.exec(t) || [])[1]) || NUM[(Object.keys(NUM).find((w) => new RegExp(`\\b${w}\\b`, 'i').test(t)) || '')] || 10;
  const states = statesIn(t);
  let p = null;
  try {
    const r = await ai.ask({ role: 'research', json: true, maxTokens: 700, system: 'You plan web research. Reply with JSON only.', prompt: `REQUEST: ${t}\nToday: ${new Date().toDateString()}\n\nReturn JSON: {"goal": "one line", "kind": "people" or "facts", "count": number wanted, "rules": ["each thing every result must meet, from the request only"], "queries": ["8 short web searches (3-8 words each, no quotes) that would find pages listing or profiling them: news lists, election results, 'rising stars', official pages"]}` });
    p = r.json;
  } catch { p = null; }
  const queries = [...new Set([...(Array.isArray(p?.queries) ? p.queries.map((q) => String(q).replace(/["']/g, '').trim()).filter((q) => q.length > 4 && q.split(' ').length <= 12) : []), ...plainQueries(task)])].slice(0, 10);
  const out = { goal: String(p?.goal || t).slice(0, 300), kind: /fact|info|number|data/i.test(p?.kind || '') && !/people|politician|candidate|official|member|creator/i.test(t) ? 'facts' : 'people', count: Math.max(1, Math.min(50, Number(p?.count) || n)), rules: (Array.isArray(p?.rules) ? p.rules : []).map((x) => String(x).slice(0, 200)).slice(0, 8), queries, states };
  onStep?.({ tool: 'plan', say: 'Planned the search', result: `Looking for ${out.count} ${out.kind}: ${out.goal}\nRules: ${out.rules.join('; ') || 'as asked'}${states.length ? `\nOnly in: ${states.map((s) => s.nm).join(', ')}` : ''}\nSearches:\n${queries.map((q) => `- ${q}`).join('\n')}` });
  return out;
}

const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const overlap = (a, b) => { const A = norm(a).split(' ').filter((w) => w.length > 3); const B = ` ${norm(b)} `; if (!A.length) return 0; return A.filter((w) => B.includes(` ${w} `)).length / A.length; };

/** Search with DuckDuckGo (or Google), in the bot's browser when asked. → [{ title, url, snippet }] */
async function searchOne(bot, q, { browser, google, onStep, shotDir }) {
  if (browser && ctx.botBrowser) {
    try {
      const p = await ctx.botBrowser.open(bot.id, `https://duckduckgo.com/?q=${encodeURIComponent(q)}&ia=web`, { shotDir });
      const links = (p.links || []).filter((l) => /^https?:/.test(l.url) && !/duckduckgo\.com|duck\.ai|spreadprivacy|apps\.apple|play\.google/i.test(l.url) && l.text.length > 12).slice(0, 10).map((l) => ({ title: l.text, url: l.url, snippet: '' }));
      onStep?.({ tool: 'browser_open', say: `Searched "${q}" in its browser`, args: { url: `duckduckgo.com: ${q}` }, result: links.map((l) => `- ${l.title} ${l.url}`).join('\n') || 'Nothing found.', shot: p.shot || null });
      if (links.length) return links;
    } catch (e) { onStep?.({ tool: 'browser_open', say: `Browser search failed (${e.message.slice(0, 80)}); using the web search`, failed: true }); }
  }
  let rs = [];
  if (google) { try { const s = require('../integrations/serper'); if (!s.blocked()) rs = (await s.web(q, { num: 10 })).results || []; } catch { rs = []; } }
  if (!rs.length) { try { rs = await web.search(q, 10); } catch (e) { onStep?.({ tool: 'web_search', say: `Search failed: ${q}`, result: e.message, failed: true }); return []; } }
  onStep?.({ tool: 'web_search', say: `Searched${google && rs.length ? ' Google' : ''}: ${q}`, args: { query: q }, result: rs.slice(0, 8).map((r) => `- ${r.title} ${r.url}`).join('\n') || 'Nothing found.', links: rs.slice(0, 6).map((r) => r.url) });
  return rs;
}

async function readOne(bot, url, { browser, shotDir }) {
  if (browser && ctx.botBrowser) { const p = await ctx.botBrowser.open(bot.id, url, { shotDir }); return { title: p.title, url: p.url || url, text: p.text || '', shot: p.shot || null }; }
  const p = await web.read(url, { maxChars: 40000 }); return { title: p.title, url: p.url || url, text: p.text || '' };
}

/** Candidates on one page, each with the sentence that shows it; kept only when they're really on the page. */
async function extract(page, pl) {
  const focus = `${pl.goal} ${pl.rules.join(' ')}`;
  const parts = web.passages(page.text, focus, { max: 6, size: 900 }).map((x) => x.text);
  const text = (parts.length ? parts.join('\n...\n') : page.text.slice(0, 5000)).slice(0, 6000);
  if (text.length < 80) return [];
  let items = [];
  try {
    const r = await ai.ask({ role: 'research', json: true, maxTokens: 900, system: 'You pull facts out of a web page. Use ONLY the page text. Never add anything you know from elsewhere. Reply with JSON only.', prompt: `WANTED: ${pl.goal}\nRULES: ${pl.rules.join('; ') || 'as asked'}\nPAGE: ${page.title} (${page.url})\nPAGE TEXT:\n${text}\n\nReturn JSON: {"items": [${pl.kind === 'people' ? '{"name": "full name exactly as on the page", "role": "their office/job as the page says", "place": "state/city as the page says", "why": "why they fit, under 20 words, from the page", "evidence": "one sentence copied word for word from the page text about them"}' : '{"fact": "the fact, under 30 words", "evidence": "one sentence copied word for word from the page text"}'}]} (empty list if the page has none)` });
    items = Array.isArray(r.json?.items) ? r.json.items : [];
  } catch { items = []; }
  const body = norm(page.text);
  return items.slice(0, 25).filter((it) => {
    if (pl.kind === 'people') { const n = norm(it.name); if (!n || n.split(' ').length < 2 || n.length > 60 || !body.includes(n)) return false; }
    else if (!it.fact) return false;
    return overlap(it.evidence || it.fact || it.name, page.text) >= 0.7; // the evidence really is on the page
  }).map((it) => ({ ...it, url: page.url, source: page.title }));
}

/** Check each person against the rules using only their evidence. */
async function check(list, pl) {
  // A state named in the request must show up in what the pages say about them.
  let out = list;
  if (pl.states.length && pl.kind === 'people') {
    const re = new RegExp(`\\b(${pl.states.map((s) => `${s.ab}|${s.nm}`).join('|')})\\b|\\b(AD|SD|HD|LD)-?\\d`, 'i');
    out = out.map((c) => ({ ...c, stateOk: re.test(`${c.place} ${c.role} ${c.evidence.join(' ')} ${c.sources.map((s) => s.title).join(' ')}`) }));
    out = out.filter((c) => c.stateOk);
  }
  if (!pl.rules.length || !out.length) return out;
  try {
    const r = await ai.ask({ role: 'research', json: true, maxTokens: 900, system: 'You check candidates against rules using ONLY the evidence given for each. Unknown is not a no. Reply with JSON only.', prompt: `RULES: ${pl.rules.join('; ')}\n\n${out.slice(0, 30).map((c, i) => `${i + 1}. ${c.name} | ${c.role || '?'} | ${c.place || '?'} | evidence: ${c.evidence.slice(0, 2).join(' / ').slice(0, 400)}`).join('\n')}\n\nReturn JSON: {"no": [numbers of candidates the evidence clearly shows break a rule], "why": {"number": "short reason"}}` });
    const no = new Set((r.json?.no || []).map(Number));
    return out.filter((c, i) => !no.has(i + 1));
  } catch { return out; }
}

/**
 * Run a deep research job for a bot. onStep(step) records each step in its chat; isCancelled() stops it.
 * Returns { answer, found, sources, datasetId }.
 */
async function run(bot, task, { onStep, isCancelled = () => false, browser = null, google = null, budgetMs = 20 * 60000 } = {}) {
  const t0 = Date.now();
  const shotDir = path.join(paths.root, 'bots', 'shots');
  const useBrowser = browser ?? (wantsBrowser(task) && !!ctx.botBrowser && bot.computer !== 'none');
  let useGoogle = google ?? wantsGoogle(task);
  if (useGoogle) { try { if (require('../integrations/serper').blocked()) useGoogle = false; } catch { useGoogle = false; } }
  const pl = await plan(task, onStep);
  const seen = new Map(); // url -> result
  const readUrls = new Set();
  const people = new Map();
  const facts = [];
  const timeLeft = () => budgetMs - (Date.now() - t0);
  const addFound = (items) => {
    for (const it of items) {
      if (pl.kind === 'people') {
        const k = norm(it.name); const cur = people.get(k) || { name: it.name, role: '', place: '', why: '', evidence: [], sources: [] };
        cur.role = cur.role || String(it.role || ''); cur.place = cur.place || String(it.place || ''); cur.why = cur.why || String(it.why || '');
        if (it.evidence && !cur.evidence.includes(it.evidence)) cur.evidence.push(String(it.evidence).slice(0, 400));
        if (!cur.sources.some((s) => s.url === it.url)) cur.sources.push({ url: it.url, title: it.source });
        people.set(k, cur);
      } else if (!facts.some((f) => overlap(f.fact, it.fact) > 0.8)) facts.push(it);
    }
  };
  const round = async (queries) => {
    for (const q of queries) {
      if (isCancelled() || timeLeft() < 60000) return;
      const rs = await searchOne(bot, q, { browser: useBrowser, google: useGoogle, onStep, shotDir });
      rs.forEach((r, i) => { if (!r.url || SKIP_URL.test(r.url)) return; const cur = seen.get(r.url) || { ...r, score: 0 }; cur.score += 10 - i + overlap(`${pl.goal} ${pl.rules.join(' ')}`, `${r.title} ${r.snippet}`) * 5; seen.set(r.url, cur); });
    }
    const toRead = [...seen.values()].filter((r) => !readUrls.has(r.url)).sort((a, b) => b.score - a.score).slice(0, 8);
    for (const r of toRead) {
      if (isCancelled() || timeLeft() < 45000) return;
      readUrls.add(r.url);
      let page;
      try { page = await readOne(bot, r.url, { browser: useBrowser, shotDir }); } catch (e) { onStep?.({ tool: 'read_page', say: `Couldn't open ${r.title || r.url}`, args: { url: r.url }, result: e.message, failed: true }); continue; }
      const items = await extract(page, pl);
      addFound(items);
      onStep?.({ tool: useBrowser ? 'browser_read' : 'read_page', say: `Read: ${page.title || r.url}`, args: { url: page.url }, result: items.length ? `Found ${items.length}: ${items.map((x) => x.name || x.fact).join('; ')}` : 'Nothing that fits on this page.', shot: page.shot || null, links: [page.url] });
    }
  };
  await round(pl.queries.slice(0, 6));
  let picked = pl.kind === 'people' ? await check([...people.values()], pl) : facts;
  // Not enough yet: one more round aimed at what's missing.
  if (picked.length < pl.count && !isCancelled() && timeLeft() > 120000) {
    let more = pl.queries.slice(6);
    try {
      const r = await ai.ask({ role: 'research', json: true, maxTokens: 300, system: 'Reply with JSON only.', prompt: `We are looking for: ${pl.goal}\nFound so far: ${picked.map((c) => c.name || c.fact).join(', ') || 'nothing yet'}\nWrite 4 new short web searches (3-8 words) likely to find MORE that we haven't found. JSON: {"queries": [...]}` });
      more = [...(r.json?.queries || []).map(String), ...more];
    } catch { /* the planned ones */ }
    onStep?.({ tool: 'plan', say: `Found ${picked.length} of ${pl.count} so far; searching for more`, result: more.slice(0, 5).join('\n') });
    await round([...new Set(more)].slice(0, 5));
    picked = pl.kind === 'people' ? await check([...people.values()], pl) : facts;
  }
  // Best supported first: more pages agreeing, then more evidence.
  if (pl.kind === 'people') picked.sort((a, b) => b.sources.length - a.sources.length || b.evidence.length - a.evidence.length);
  const top = picked.slice(0, pl.count);
  const answer = format(pl, top, readUrls.size, picked.length, isCancelled());
  let datasetId = null;
  if (top.length) {
    try {
      const md = `# ${pl.goal}\n\nFound by ${bot.name}, ${new Date().toLocaleString('en-US')}. ${readUrls.size} pages read. Only what the pages say; every item has its source.\n\n${pl.kind === 'people' ? `| Name | Role | Place | Why | Source |\n|---|---|---|---|---|\n${top.map((c) => `| ${c.name} | ${c.role.replace(/\|/g, '/')} | ${c.place.replace(/\|/g, '/')} | ${c.why.replace(/\|/g, '/')} | ${c.sources[0].url} |`).join('\n')}\n\n${top.map((c, i) => `## ${i + 1}. ${c.name}${c.role ? ` (${c.role})` : ''}\n- **Why:** ${c.why}\n- **Evidence:** "${c.evidence[0]}"\n- **Sources:** ${c.sources.map((s) => s.url).join(' ')}`).join('\n\n')}` : top.map((f) => `- ${f.fact} ("${f.evidence}") ${f.url}`).join('\n')}`;
      datasetId = require('../data').add({ name: `${bot.name}: ${pl.goal}`.slice(0, 120), text: md, source: `Bot: ${bot.name} (deep research)`, by: `bot:${bot.name}` }).id;
    } catch { datasetId = null; }
  }
  return { answer: `${answer}${datasetId ? '\n\nSaved to the Data tab with every source.' : ''}`, found: top, total: picked.length, pages: readUrls.size, datasetId };
}

function format(pl, top, pages, total, stopped) {
  if (!top.length) return `${stopped ? 'Stopped. ' : ''}I read ${pages} pages and couldn't confirm any ${pl.kind === 'people' ? 'people' : 'facts'} that fit "${pl.goal}" on them. I won't list names the pages don't show. Try other words, a narrower ask, or Google${pl.states.length ? '' : ' (say "use Google")'}.`;
  const head = `${stopped ? 'Stopped early. ' : ''}${top.length < pl.count ? `I could confirm ${top.length} of the ${pl.count} you asked for` : `Here are ${top.length}`} (${pages} pages read; only what those pages say, each with its source):`;
  if (pl.kind !== 'people') return `${head}\n\n${top.map((f, i) => `${i + 1}. ${f.fact}\n   Source: ${f.url}`).join('\n')}`;
  return `${head}\n\n${top.map((c, i) => `${i + 1}. ${c.name}${c.role ? `, ${c.role}` : ''}${c.place ? ` (${c.place})` : ''}\n   Why: ${c.why || 'see the source'}\n   From the page: "${c.evidence[0].slice(0, 220)}"\n   Source${c.sources.length > 1 ? 's' : ''}: ${c.sources.slice(0, 3).map((s) => s.url).join(' , ')}`).join('\n\n')}${total > top.length ? `\n\n(${total - top.length} more fit; ask for them.)` : ''}`;
}

module.exports = { statesIn, run, isDeepTask, wantsBrowser, wantsGoogle, cleanTask, plainQueries, plan, extract, check };
