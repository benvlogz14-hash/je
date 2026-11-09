'use strict';
/**
 * What a bot can do. Each tool: { name, args (shown to the model), about, kinds (which bot switch turns it on),
 * needsOk(bot, args) -> reason | null, run(args, t) -> { text, shot?, data? } }.
 *
 * Reading the web, the notebook and the app's own records never needs a person. Anything that could act on the world
 * (typing or clicking on a website, running commands in the bot's computer) comes back as an Allow / Deny card
 * unless the founders switched that bot to run those on its own. Nothing here sends a message, posts or changes the
 * app's records: those stay with a person (the house rules).
 */
const path = require('path');
const ctx = require('../core/ctx');
const paths = require('../core/paths');
const web = require('../integrations/websearch');

const cut = (s, n = 3500) => { s = String(s ?? ''); return s.length > n ? `${s.slice(0, n)}\n…(${s.length - n} more characters; ask for a part if you need it)` : s; };
const shotDir = () => path.join(paths.root, 'bots', 'shots');
const hasBrowser = () => !!ctx.botBrowser;

function pageText(p, focus) {
  const focusParts = focus ? web.passages(p.text, focus, { max: 5 }).map((x) => x.text) : [];
  const body = focusParts.length ? `Parts about "${focus}":\n${focusParts.join('\n…\n')}` : cut(p.text, 4500);
  const links = (p.links || []).slice(0, 25).map((l) => `- ${l.text} → ${l.url}`).join('\n');
  const form = [p.fields?.length ? `Fields: ${p.fields.map((f) => f.label || f.name || f.type).filter(Boolean).join(', ')}` : '', p.buttons?.length ? `Buttons: ${p.buttons.slice(0, 15).join(', ')}` : ''].filter(Boolean).join('\n');
  return `PAGE: ${p.title || ''} (${p.url})${p.date ? ` · ${String(p.date).slice(0, 10)}` : ''}\n${body}${form ? `\n\n${form}` : ''}${links ? `\n\nLinks on the page:\n${links}` : ''}${p.blocked?.length ? `\n\n(Blocked for safety: ${p.blocked.join('; ')})` : ''}`;
}

const TOOLS = [
  {
    name: 'research', kinds: ['web'], args: '{"question": "what to find out", "recent": "day|week|month (optional)"}',
    about: 'Search the web AND read the best 3 pages; returns the parts that answer the question, with links. Best first step for any question about the world.',
    async run(a) {
      const r = await web.research(a.question || a.query || '', { pages: 3, recent: a.recent || null });
      if (!r.results.length) return { text: `No web results for "${r.query}". Try other words.` };
      return { text: web.formatResearch(r, { maxChars: 7000 }) + (r.failed.length ? `\n(Couldn't read: ${r.failed.map((f) => `${f.url} (${f.error})`).join('; ')})` : ''), links: r.results.map((x) => x.url) };
    },
  },
  {
    name: 'web_search', kinds: ['web'], args: '{"query": "search words", "recent": "day|week|month (optional)"}',
    about: 'DuckDuckGo search: titles, links and one-line snippets (read_page to read one).',
    async run(a) {
      const r = await web.search(a.query || '', 8, { recent: a.recent || null });
      return { text: r.length ? r.map((x, i) => `${i + 1}. ${x.title} — ${x.url}\n   ${x.snippet}`).join('\n') : `Nothing came back for "${a.query}".`, links: r.map((x) => x.url) };
    },
  },
  {
    name: 'read_page', kinds: ['web'], args: '{"url": "https://...", "focus": "what you are looking for on it (optional)"}',
    about: 'Read a web page: its text (or just the parts about "focus") and its links.',
    async run(a, t) {
      const p = await web.read(String(a.url || ''));
      return { text: pageText(p, a.focus || t.question) };
    },
  },
  {
    name: 'news', kinds: ['web'], args: '{"query": "topic or name"}',
    about: 'Recent news headlines with links (Google News).',
    async run(a) {
      const items = await require('../hal/web').newsFor(String(a.query || ''), 8);
      return { text: items.length ? items.map((n) => `- ${n.t}${n.b ? `: ${n.b}` : ''} (${n.url})`).join('\n') : 'No news found.', links: items.map((n) => n.url) };
    },
  },
  {
    name: 'browser_open', kinds: ['browser'], args: '{"url": "https://..."}',
    about: 'Open a page in your own browser window (runs JavaScript, so it works on modern sites); you get its text, links, fields and buttons, and the person sees a screenshot.',
    async run(a, t) {
      const url = String(a.url || '');
      if (hasBrowser()) { const p = await ctx.botBrowser.open(t.bot.id, url, { shotDir: shotDir() }); return { text: pageText(p, t.question), shot: p.shot }; }
      if (t.bot.computer === 'vm') { const p = await require('./computer').browse(t.bot.id, url); return { text: pageText(p, t.question), shot: p.shot }; }
      const p = await web.read(url); return { text: `${pageText(p, t.question)}\n(Read without a browser: this isn't the desktop app.)` };
    },
  },
  {
    name: 'browser_read', kinds: ['browser'], args: '{"focus": "what to look for (optional)"}',
    about: 'The page in your browser as it is now.',
    available: hasBrowser,
    async run(a, t) { const p = await ctx.botBrowser.read(t.bot.id, { shotDir: shotDir() }); return { text: pageText(p, a.focus), shot: p.shot }; },
  },
  {
    name: 'browser_scroll', kinds: ['browser'], args: '{"direction": "down|up"}',
    about: 'Scroll your browser page.', available: hasBrowser,
    async run(a, t) { const p = await ctx.botBrowser.scroll(t.bot.id, a.direction === 'up' ? 'up' : 'down', { shotDir: shotDir() }); return { text: pageText(p), shot: p.shot }; },
  },
  {
    name: 'browser_click', kinds: ['browser'], args: '{"target": "the visible text of the link/button, or a CSS selector"}',
    about: 'Click something on the page in your browser.', available: hasBrowser,
    needsOk: (bot) => (bot.autoBrowse ? null : 'click on a website'),
    async run(a, t) { const p = await ctx.botBrowser.click(t.bot.id, String(a.target || ''), { shotDir: shotDir() }); return { text: `Clicked "${p.clicked}".\n${pageText(p)}`, shot: p.shot }; },
  },
  {
    name: 'browser_type', kinds: ['browser'], args: '{"field": "label, placeholder or name of the field (optional)", "text": "what to type", "enter": true|false}',
    about: 'Type into a field on the page in your browser (enter: true presses Enter after).', available: hasBrowser,
    needsOk: (bot) => (bot.autoBrowse ? null : 'type on a website'),
    async run(a, t) { const p = await ctx.botBrowser.type(t.bot.id, { field: a.field || '', text: String(a.text ?? ''), enter: !!a.enter }, { shotDir: shotDir() }); return { text: `Typed into ${p.typedInto}.\n${pageText(p)}`, shot: p.shot }; },
  },
  {
    name: 'computer_run', kinds: ['vm'], args: '{"command": "a bash command", "timeout": seconds (optional, max 900)}',
    about: 'Run a command in your own Linux computer (Debian, with python3, node, curl, git, chromium; files in /work). Install things with pip/npm; no sudo.',
    needsOk: (bot) => (bot.autoRun ? null : 'run a command in its computer'),
    async run(a, t) { const r = await require('./computer').exec(t.bot.id, String(a.command || ''), { timeout: (Number(a.timeout) || 120) * 1000 }); return { text: `exit code ${r.code}\n${cut(r.output, 5000) || '(no output)'}` }; },
  },
  {
    name: 'computer_write_file', kinds: ['vm'], args: '{"path": "/work/name.ext", "content": "the whole file"}',
    about: 'Save a file in your computer (inside /work).',
    needsOk: (bot) => (bot.autoRun ? null : 'save a file in its computer'),
    async run(a, t) { const r = require('./computer').writeFile(t.bot.id, a.path, a.content); return { text: `Saved ${r.path} (${r.bytes} bytes).` }; },
  },
  {
    name: 'computer_read_file', kinds: ['vm'], args: '{"path": "/work/name.ext"}',
    about: 'Read a file (or list a folder) in your computer.',
    async run(a, t) { const r = require('./computer').readFile(t.bot.id, a.path || ''); return { text: r.dir ? (r.files.map((f) => f.path).join('\n') || '(empty)') : `${r.path} (${r.bytes} bytes)${r.cut ? ', first part' : ''}:\n${cut(r.text, 6000)}` }; },
  },
  {
    name: 'computer_screenshot', kinds: ['vm'], args: '{"url": "https://..."}',
    about: 'Open a page in your computer\'s Chromium and take a picture of it (the person sees it); you get its text.',
    async run(a, t) { const p = await require('./computer').browse(t.bot.id, String(a.url || '')); return { text: pageText(p, t.question), shot: p.shot }; },
  },
  {
    name: 'notebook_recall', kinds: ['notebook'], args: '{"query": "who or what"}',
    about: 'What Euclidean has learned and written down (dated notes on leads, clients, lessons, news).',
    async run(a) { const n = require('../hal/memory').recall(String(a.query || ''), { limit: 10 }); return { text: n.length ? require('../hal/memory').block(n) : 'Nothing in the notebook about that.' }; },
  },
  {
    name: 'notebook_learn', kinds: ['notebook'], args: '{"text": "one short fact or lesson, with where it came from", "about": ["names"], "link": "source URL (optional)"}',
    about: 'Write a short note in the shared notebook so Euclidean, HAL and the other bots know it later. Only things you checked.',
    async run(a, t) { const n = require('../hal/memory').add({ text: String(a.text || '').slice(0, 600), about: Array.isArray(a.about) ? a.about.slice(0, 5) : a.about ? [String(a.about)] : [], kind: 'lookup', source: `Bot: ${t.bot.name}`, link: a.link || null, ttlDays: 60 }); return { text: n ? 'Noted.' : 'Not noted (empty or a repeat).' }; },
  },
  {
    name: 'app_records', kinds: ['app'], args: '{"kind": "leads|clients|clips|jobs", "query": "name or word (optional)"}',
    about: 'Look up Euclidean\'s own records (read only): leads (politicians/creators), clients, clips, background jobs.',
    async run(a) {
      const q = String(a.query || '').toLowerCase(); const has = (o) => !q || JSON.stringify(o).toLowerCase().includes(q);
      const kind = String(a.kind || 'leads');
      let rows = [];
      if (/lead|prospect/.test(kind)) rows = ctx.store.all('prospects').filter(has).slice(0, 25).map((p) => `- ${p.name}${p.office ? ` · ${p.office}` : ''} · ${p.type || ''} · stage ${p.stage || 'new'}${p.email ? ` · ${p.email}` : ''}${p.hold ? ' · HOLD' : ''}${p.electionResult === 'lost' ? ' · lost' : ''}`);
      else if (/client/.test(kind)) rows = ctx.store.all('clients').filter(has).slice(0, 25).map((c) => `- ${c.name} · ${c.status || 'active'}${c.retainer ? ` · $${c.retainer}/mo` : ''}`);
      else if (/clip/.test(kind)) rows = ctx.store.all('clips').filter(has).slice(-25).reverse().map((c) => `- ${c.title || c.hook || c.id} · ${c.status}`);
      else if (/job/.test(kind)) rows = ctx.store.all('jobs').filter((j) => ['running', 'queued', 'failed'].includes(j.status)).filter(has).slice(-25).reverse().map((j) => `- ${j.title || j.type} · ${j.status}${j.error ? ` · ${String(j.error).slice(0, 120)}` : ''}`);
      return { text: rows.length ? rows.join('\n') : `No ${kind} found${q ? ` for "${q}"` : ''}.` };
    },
  },
  {
    name: 'ask_bot', kinds: ['team'], args: '{"bot": "the other bot\'s name", "task": "what you want from them"}',
    about: 'Hand a piece of the work to another bot on the team and get its answer back.',
    async run(a, t) {
      if (t.depth >= 1) return { text: 'Bots that were handed work can\'t hand it on again. Do it yourself.' };
      const other = require('./index').findBot(a.bot);
      if (!other || other.id === t.bot.id) return { text: `No other bot called "${a.bot}". The team: ${require('./index').list().filter((b) => b.id !== t.bot.id).map((b) => b.name).join(', ')}.` };
      const ans = await require('./agent').runInline(other, String(a.task || ''), { depth: t.depth + 1, parent: t });
      return { text: `${other.name} answered:\n${cut(ans, 4000)}` };
    },
  },
];

/** The tools this bot has switched on (and that can work here). */
function forBot(bot) {
  const on = bot.tools || {};
  const kinds = new Set(Object.entries({ web: on.web !== false, notebook: on.notebook !== false, app: on.app !== false, team: on.team !== false, browser: bot.computer === 'browser' || bot.computer === 'vm', vm: bot.computer === 'vm' }).filter(([, v]) => v).map(([k]) => k));
  return TOOLS.filter((t) => t.kinds.some((k) => kinds.has(k)) && (!t.available || t.available() || (t.name === 'browser_open')));
}

module.exports = { TOOLS, forBot, pageText, shotDir };
