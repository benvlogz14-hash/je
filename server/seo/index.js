'use strict';
/**
 * SEO lab: the title and description machine. Built from what you feed it:
 *  - Research files (the SEO notes you used to keep in Claude and ChatGPT: playbooks, rules, keyword lists, what
 *    worked). Kept as text files in <data>/seo/docs (the database only keeps their names and sizes), split into
 *    passages, and the passages that match a video are handed to the AI with every request.
 *  - Stats (CSV exports from YouTube Studio, TikTok, a spreadsheet: any table with a title column and numbers like
 *    views, CTR, average view duration). Each row is kept, and the patterns of the best performers are measured in
 *    code (length, numbers, questions, capitals, brackets, first words...), not guessed.
 *  - Generate: for a topic or one of your clips, the AI writes title options, a description and tags from the
 *    research and the measured patterns, with your best titles as examples; each title is then scored against the
 *    patterns, so the list comes back best first with the reasons.
 */
const fs = require('fs');
const path = require('path');
const ctx = require('../core/ctx');
const paths = require('../core/paths');
const ai = require('../integrations/ai');

const dir = () => { const d = path.join(paths.root, 'seo', 'docs'); fs.mkdirSync(d, { recursive: true }); return d; };
const docFile = (id) => path.join(dir(), `${id}.txt`);
const now = () => new Date().toISOString();

// ------------------------------------------------------------------ stats (any table with titles and numbers)
function parseCsv(text) {
  const rows = []; let row = []; let cell = ''; let q = false;
  const sep = (text.split('\n')[0].match(/\t/g) || []).length > (text.split('\n')[0].match(/,/g) || []).length ? '\t' : ',';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch; continue; }
    if (ch === '"') q = true; else if (ch === sep) { row.push(cell); cell = ''; } else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; } else if (ch !== '\r') cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim()));
}
const num = (v) => { const s = String(v ?? '').replace(/[,%$\s]/g, ''); const m = /^(-?[\d.]+)([kKmM]?)$/.exec(s); if (!m) return null; let n = Number(m[1]); if (/k/i.test(m[2])) n *= 1e3; if (/m/i.test(m[2])) n *= 1e6; return Number.isFinite(n) ? n : null; };
const COLS = {
  title: /^(video )?title|^name$|^content$|^caption$/i, views: /^views?$|^video views|^plays?$|^impressions views/i, ctr: /click.?through|ctr/i,
  avd: /average (view|percentage)|avg.*(view|watch)|retention|avd/i, likes: /^likes?$/i, comments: /^comments?$/i, shares: /^shares?$/i,
  subs: /subscribers? (gained|net)?|^subs/i, impressions: /^impressions$/i, published: /publish|upload date|^date$/i, url: /url|link|video id/i,
};
/** A table → stat rows, or null when it isn't one (no title column, or no number columns). */
function statsFrom(text, source) {
  const rows = parseCsv(text); if (rows.length < 3) return null;
  const head = rows[0].map((h) => h.trim()); const idx = {};
  for (const [k, re] of Object.entries(COLS)) { const i = head.findIndex((h) => re.test(h)); if (i >= 0) idx[k] = i; }
  if (idx.title == null || !['views', 'ctr', 'avd', 'likes', 'impressions'].some((k) => idx[k] != null)) return null;
  const out = [];
  for (const r of rows.slice(1)) {
    const title = String(r[idx.title] || '').trim(); if (!title || /^total/i.test(title)) continue;
    const o = { title, source };
    for (const k of ['views', 'ctr', 'avd', 'likes', 'comments', 'shares', 'subs', 'impressions']) if (idx[k] != null) { const v = num(r[idx[k]]); if (v != null) o[k] = v; }
    if (idx.published != null) o.published = String(r[idx.published] || '').trim();
    if (idx.url != null) o.url = String(r[idx.url] || '').trim();
    out.push(o);
  }
  return out.length >= 3 ? { rows: out, columns: Object.keys(idx) } : null;
}

// ------------------------------------------------------------------ title features and what wins
const HOOK_START = /^(i|we|this|these|how|why|what|the|inside|exploring|abandoned|never|nobody|watch|my|they|he|she)\b/i;
function features(t) {
  const s = String(t || ''); const words = s.split(/\s+/).filter(Boolean);
  return {
    chars: s.length, words: words.length,
    number: /\d/.test(s), question: /\?/.test(s), exclaim: /!/.test(s),
    caps: words.some((w) => w.length > 2 && w === w.toUpperCase() && /[A-Z]/.test(w)),
    brackets: /[()[\]]/.test(s), colon: /[:|-]\s/.test(s), emoji: /\p{Extended_Pictographic}/u.test(s),
    firstPerson: /\b(i|we|my|our|me)\b/i.test(s), ellipsis: /\.\.\.|…/.test(s),
    first: (words[0] || '').toLowerCase().replace(/[^a-z0-9']/g, ''),
  };
}
const FLAG_NAMES = { number: 'a number', question: 'a question', exclaim: 'an exclamation mark', caps: 'a word in CAPITALS', brackets: 'brackets', colon: 'a colon or dash', emoji: 'an emoji', firstPerson: 'I/we/my', ellipsis: '"..."' };
/** The metric to judge by: views when there are any, else CTR, else likes. */
const metricOf = (rows) => (rows.some((r) => r.views != null) ? 'views' : rows.some((r) => r.ctr != null) ? 'ctr' : rows.some((r) => r.avd != null) ? 'avd' : 'likes');
function patterns(rows = ctx.store.all('seoStats')) {
  const m = metricOf(rows); const scored = rows.filter((r) => r[m] != null);
  if (scored.length < 6) return { metric: m, rows: scored.length, enough: false, rules: [], top: scored.sort((a, b) => b[m] - a[m]).slice(0, 10) };
  const sorted = [...scored].sort((a, b) => b[m] - a[m]); const q = Math.max(2, Math.floor(sorted.length / 4));
  const top = sorted.slice(0, q), rest = sorted.slice(q);
  const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };
  const avg = (xs) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
  const rules = [];
  for (const k of Object.keys(FLAG_NAMES)) {
    const share = (set) => set.filter((r) => features(r.title)[k]).length / set.length;
    const withIt = scored.filter((r) => features(r.title)[k]), without = scored.filter((r) => !features(r.title)[k]);
    if (withIt.length < 3 || without.length < 3) continue;
    const lift = median(withIt.map((r) => r[m])) / Math.max(1e-9, median(without.map((r) => r[m])));
    if (lift >= 1.25 || lift <= 0.8) rules.push({ key: k, kind: 'flag', good: lift >= 1.25, lift: Math.round(lift * 100) / 100, topShare: Math.round(share(top) * 100), restShare: Math.round(share(rest) * 100), text: `Titles with ${FLAG_NAMES[k]} get ${lift >= 1 ? `${Math.round((lift - 1) * 100)}% more` : `${Math.round((1 - lift) * 100)}% less`} ${m} (median, ${withIt.length} vs ${without.length} videos)` });
  }
  const tc = top.map((r) => features(r.title).chars), tw = top.map((r) => features(r.title).words);
  const len = { min: Math.min(...tc), max: Math.max(...tc), median: median(tc), words: median(tw) };
  rules.push({ key: 'length', kind: 'length', good: true, ...len, text: `Your best quarter of titles run ${len.min}-${len.max} characters (middle ${len.median}, about ${len.words} words); the rest average ${Math.round(avg(rest.map((r) => features(r.title).chars)))}` });
  const starts = {}; for (const r of top) { const f = features(r.title).first; if (f) starts[f] = (starts[f] || 0) + 1; }
  const commonStarts = Object.entries(starts).filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([w]) => w);
  if (commonStarts.length) rules.push({ key: 'starts', kind: 'starts', good: true, words: commonStarts, text: `Best titles often start with: ${commonStarts.map((w) => `"${w}"`).join(', ')}` });
  // words that show up a lot more in the best titles than the rest
  const toks = (t) => [...new Set(String(t).toLowerCase().match(/[a-z][a-z']{2,}/g) || [])];
  const cnt = (set) => { const c = {}; for (const r of set) for (const w of toks(r.title)) c[w] = (c[w] || 0) + 1; return c; };
  const ct = cnt(top), cr = cnt(rest); const STOP = new Set('the and for you your with this that was are from have what they their them its our out who how why not all can will just get got into about'.split(' '));
  const winners = Object.entries(ct).filter(([w, n]) => n >= 2 && !STOP.has(w)).map(([w, n]) => [w, (n / top.length) / (((cr[w] || 0) + 0.5) / Math.max(1, rest.length))]).filter(([, r]) => r >= 2).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([w]) => w);
  if (winners.length) rules.push({ key: 'words', kind: 'words', good: true, words: winners, text: `Words that show up far more in your best titles: ${winners.join(', ')}` });
  return { metric: m, rows: scored.length, enough: true, rules, length: len, top: sorted.slice(0, 12), bottom: sorted.slice(-5).reverse() };
}

/** How well a title matches the measured winners (0-100), with the reasons. Without stats: plain good-practice checks. */
function scoreTitle(title, pat, platform = 'youtube') {
  const f = features(title); const why = []; let s = 60;
  const maxLen = platform === 'youtube' ? 70 : platform === 'shorts' ? 60 : 100;
  if (f.chars > maxLen) { s -= 15; why.push(`long for ${platform} (${f.chars} characters; it may be cut off)`); }
  if (f.chars < 15) { s -= 10; why.push('very short'); }
  if (pat?.enough) {
    const L = pat.length; if (L) { if (f.chars >= L.min && f.chars <= L.max) { s += 12; why.push('length like your best titles'); } else { s -= 6; why.push(`your best titles run ${L.min}-${L.max} characters`); } }
    for (const r of pat.rules.filter((x) => x.kind === 'flag')) { if (f[r.key]) { s += r.good ? 8 : -8; why.push(`${r.good ? '+' : '-'} ${FLAG_NAMES[r.key]} (${r.lift}x)`); } }
    const st = pat.rules.find((x) => x.kind === 'starts'); if (st && st.words.includes(f.first)) { s += 6; why.push(`starts like your winners ("${f.first}")`); }
    const wd = pat.rules.find((x) => x.kind === 'words'); const hits = wd ? wd.words.filter((w) => new RegExp(`\\b${w}\\b`, 'i').test(title)) : []; if (hits.length) { s += Math.min(12, hits.length * 5); why.push(`uses winning words: ${hits.join(', ')}`); }
  } else {
    if (HOOK_START.test(title)) { s += 5; why.push('opens with a hook word'); }
    if (f.number) { s += 4; why.push('has a number'); }
    if (f.chars >= 30 && f.chars <= 65) { s += 8; why.push('a good length'); }
  }
  return { score: Math.max(0, Math.min(100, Math.round(s))), why };
}

// ------------------------------------------------------------------ research passages
function passages() {
  const out = [];
  for (const d of ctx.store.all('seoDocs', (x) => x.kind === 'research')) {
    let text = ''; try { text = fs.readFileSync(docFile(d.id), 'utf8'); } catch { continue; }
    const paras = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
    let cur = '';
    for (const p of paras) { if ((cur + '\n\n' + p).length > 1400 && cur) { out.push({ doc: d.name, text: cur }); cur = p; } else cur = cur ? `${cur}\n\n${p}` : p; }
    if (cur) out.push({ doc: d.name, text: cur });
  }
  return out;
}
/** The passages most about this video (plus the start of each file, where rules usually are), up to ~9,000 characters. */
function relevant(query, max = 9000) {
  const all = passages(); if (!all.length) return [];
  const q = [...new Set(String(query || '').toLowerCase().match(/[a-z][a-z']{3,}/g) || [])];
  const ruleWords = /\b(title|titles|description|hook|keyword|tag|hashtag|thumbnail|ctr|click|rule|never|always|avoid|best)\b/gi;
  const scored = all.map((p, i) => { const low = p.text.toLowerCase(); let sc = q.reduce((n, w) => n + (low.includes(w) ? 2 : 0), 0) + Math.min(6, (p.text.match(ruleWords) || []).length * 0.5); if (i === 0 || all[i - 1].doc !== p.doc) sc += 3; return { ...p, sc }; });
  const pick = []; let n = 0;
  for (const p of scored.sort((a, b) => b.sc - a.sc)) { if (n + p.text.length > max) continue; pick.push(p); n += p.text.length; }
  return pick;
}

// ------------------------------------------------------------------ files in
/** Add a file's text: a stats table becomes stat rows, anything else is research. */
function addDoc({ name, text, actor = 'user' }) {
  name = String(name || 'Notes').slice(0, 120); text = String(text || '').slice(0, 5_000_000);
  if (!text.trim()) throw new Error(`${name} is empty.`);
  const st = /\.(csv|tsv)$/i.test(name) || /,|\t/.test(text.split('\n')[0] || '') ? statsFrom(text, name) : null;
  const doc = ctx.store.insert('seoDocs', { name, kind: st ? 'stats' : 'research', chars: text.length, rows: st ? st.rows.length : null, columns: st ? st.columns : null, addedBy: actor });
  fs.writeFileSync(docFile(doc.id), text);
  if (st) for (const r of st.rows) ctx.store.insert('seoStats', { ...r, docId: doc.id });
  return doc;
}
function removeDoc(id) {
  ctx.store.remove('seoDocs', id); try { fs.unlinkSync(docFile(id)); } catch { /* gone */ }
  for (const r of ctx.store.all('seoStats', (x) => x.docId === id)) ctx.store.remove('seoStats', r.id);
}
const docText = (id) => { try { return fs.readFileSync(docFile(id), 'utf8'); } catch { return ''; } };

// ------------------------------------------------------------------ the machine
const PLATFORM = { youtube: 'a long-form YouTube video', shorts: 'a YouTube Short', tiktok: 'a TikTok', instagram: 'an Instagram Reel' };
/** About a clip: its title, hook and what is said in it (the first ~1,500 characters). */
function clipBrief(clipId) {
  const c = ctx.store.get('clips', clipId); if (!c) return null;
  const a = ctx.store.get('assets', c.assetId);
  let said = '';
  try { const t = a && require('../jobs/handlers').loadTranscript(a); const pieces = c.keep?.length ? c.keep : [[c.start, c.end]]; said = (t?.words || []).filter((w) => pieces.some(([x, y]) => w.s >= x && w.e <= y)).map((w) => w.w).join(' ').slice(0, 1500); } catch { /* no words */ }
  return { clip: c, footage: a?.name || '', client: ctx.store.get('clients', c.clientId)?.name || '', said };
}

async function generate({ topic = '', clipId = null, platform = 'youtube', count = 8, notes = '', actor = 'user' } = {}) {
  const brief = clipId ? clipBrief(clipId) : null;
  const about = [topic, brief && `Clip "${brief.clip.title}" (on-screen title: ${brief.clip.hook || 'none'}) from the video "${brief.footage}" for ${brief.client}.`, brief?.said && `What is said in it: "${brief.said}"`].filter(Boolean).join('\n');
  if (!about.trim()) throw new Error('Tell the machine what the video is about, or pick a clip.');
  const pat = patterns(); const research = relevant(`${topic} ${brief?.said || ''} ${brief?.clip?.title || ''}`);
  const examples = (pat.top || []).slice(0, 10).map((r) => `- "${r.title}" (${pat.metric}: ${Math.round(r[pat.metric]).toLocaleString('en-US')})`).join('\n');
  if (!ai.anyConnected()) throw new Error('The title machine needs an AI. Turn on the free local one (Ollama) or connect one in Settings → Connections.');
  const system = `You write titles and descriptions for ${PLATFORM[platform] || 'a video'} for a short-form video agency. Follow the RESEARCH NOTES (the agency's own SEO playbook) and the MEASURED PATTERNS from their real stats; when they disagree, the measured patterns win. Titles must be true to the video (no clickbait the video doesn't pay off), no em dashes. Return JSON: {"titles":[{"title":"...","why":"which note or pattern it follows"}],"description":"the full description (first line is the hook that shows in search; keywords naturally; ${platform === 'youtube' ? 'a few short paragraphs, then 3 hashtags' : 'short, 1-3 lines, hashtags at the end'})","tags":["search tags, most specific first"],"hashtags":["#tag"]}. Give ${Math.max(3, Math.min(20, count))} titles, all different in angle (curiosity, result, question, number, story).`;
  const prompt = `ABOUT THE VIDEO:\n${about}${notes ? `\n\nEDITOR'S NOTES FOR THIS ONE: ${notes}` : ''}\n\nMEASURED PATTERNS (${pat.rows} videos, judged by ${pat.metric}):\n${pat.enough ? pat.rules.map((r) => `- ${r.text}`).join('\n') : '- Not enough stats yet; use the research notes and good practice.'}${examples ? `\n\nTHEIR BEST TITLES:\n${examples}` : ''}\n\nRESEARCH NOTES:\n${research.length ? research.map((p) => `[${p.doc}]\n${p.text}`).join('\n\n---\n\n') : '(none added yet)'}`;
  const r = await ai.ask({ role: 'writing', json: true, maxTokens: 2200, system, prompt, clientId: brief?.clip?.clientId || null });
  const j = r.json || {};
  const dash = (s) => String(s || '').replace(/\s*[—–]\s*/g, ', ').trim();
  const titles = (j.titles || []).map((x) => (typeof x === 'string' ? { title: x } : x)).filter((x) => x?.title).map((x) => ({ title: dash(x.title), reason: String(x.why || x.reason || ''), ...scoreTitle(dash(x.title), pat, platform) }));
  titles.sort((a, b) => b.score - a.score);
  const run = ctx.store.insert('seoRuns', { topic: topic.slice(0, 500), clipId, platform, titles, description: dash(j.description), tags: (j.tags || []).map(String).slice(0, 30), hashtags: (j.hashtags || []).map((h) => `#${String(h).replace(/^#/, '')}`).slice(0, 10), by: `${r.provider}:${r.model}`, usedDocs: [...new Set(research.map((p) => p.doc))], metric: pat.metric, statRows: pat.rows, actor });
  const all = ctx.store.all('seoRuns'); for (const x of all.slice(0, Math.max(0, all.length - 100))) ctx.store.remove('seoRuns', x.id);
  return run;
}

/** Put a chosen title and description on a clip (its title, caption and hashtags). */
function applyToClip({ clipId, title, description, hashtags = [] }) {
  const c = ctx.store.get('clips', clipId); if (!c) throw new Error('That clip is gone.');
  const patch = {}; if (title) patch.title = String(title).slice(0, 120); if (description != null) patch.caption = String(description).slice(0, 5000); if (hashtags.length) patch.hashtags = hashtags.map((h) => String(h).replace(/^#/, '')).slice(0, 12);
  return ctx.store.update('clips', clipId, patch);
}

function overview() {
  const docs = ctx.store.all('seoDocs').map((d) => ({ ...d })).reverse();
  return { docs, stats: ctx.store.all('seoStats').length, patterns: patterns(), runs: ctx.store.all('seoRuns').slice(-15).reverse(), ai: ai.anyConnected() };
}

module.exports = { addDoc, removeDoc, docText, statsFrom, patterns, scoreTitle, features, relevant, generate, applyToClip, overview };
