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
const READ_CMDS = new Set(['inbox', 'followup', 'clients', 'clips', 'schedule', 'revenue', 'analytics', 'queue', 'logs', 'health', 'status', 'agents', 'help']);
const WORK_CMDS = new Set(['draft', 'discover', 'prospect', 'audit', 'remember', 'edit', 'render', 'invoice']);
const cmdName = (c) => String(c || '').trim().replace(/^\//, '').split(/\s/)[0].toLowerCase();

function pageText(p, focus) {
  const focusParts = focus ? web.passages(p.text, focus, { max: 5 }).map((x) => x.text) : [];
  const body = focusParts.length ? `Parts about "${focus}":\n${focusParts.join('\n…\n')}` : cut(p.text, 4500);
  const links = (p.links || []).slice(0, 25).map((l) => `- ${l.text} → ${l.url}`).join('\n');
  const form = [p.fields?.length ? `Fields: ${p.fields.map((f) => f.label || f.name || f.type).filter(Boolean).join(', ')}` : '', p.buttons?.length ? `Buttons: ${p.buttons.slice(0, 15).join(', ')}` : ''].filter(Boolean).join('\n');
  return `PAGE: ${p.title || ''} (${p.url})${p.date ? ` · ${String(p.date).slice(0, 10)}` : ''}\n${body}${form ? `\n\n${form}` : ''}${links ? `\n\nLinks on the page:\n${links}` : ''}${p.blocked?.length ? `\n\n(Blocked for safety: ${p.blocked.join('; ')})` : ''}`;
}

const TOOLS = [
  {
    name: 'research', kinds: ['web'], args: '{"question": "what to find out", "recent": "day|week|month (optional)", "full": false}',
    about: 'Search the web AND read the best 3 pages; returns the parts that answer the question, with links. Best first step for any question about the world. Free (DuckDuckGo); full: true uses Google instead (a tenth of a cent) for a full inquiry when DuckDuckGo came back thin.',
    async run(a) {
      const r = await web.research(a.question || a.query || '', { pages: 3, recent: a.recent || null, full: a.full === true || a.full === 'true' });
      if (!r.results.length && !r.instant) return { text: `No web results for "${r.query}". Try other words.` };
      return { text: web.formatResearch(r, { maxChars: 7000 }) + (r.failed.length ? `\n(Couldn't read: ${r.failed.map((f) => `${f.url} (${f.error})`).join('; ')})` : ''), links: r.results.map((x) => x.url) };
    },
  },
  {
    name: 'google_search', kinds: ['web'], args: '{"query": "search words", "type": "web|news|videos", "recent": "day|week|month|year (optional)"}',
    about: 'A real Google search (Serper) for a full inquiry: the exact pages, news or videos Google shows, plus its answer box. It costs a tenth of a cent, so use research (free) first for quick facts and summaries, and this when you need Google itself (finding a campaign site, filings, every video of someone). Results are cached.',
    async run(a) {
      const s = require('../integrations/serper'); const why = s.blocked(); if (why) return { text: `${why} Use research or web_search (free) instead.` };
      const t = a.type === 'news' ? 'news' : a.type === 'videos' ? 'videos' : 'web';
      if (t === 'videos') { const r = await s.videos(String(a.query || ''), { recent: a.recent || null }); return { text: r.videos.length ? r.videos.slice(0, 15).map((v, i) => `${i + 1}. ${v.title} (${v.channel || v.source}${v.duration ? `, ${Math.round(v.duration / 60)} min` : ''}${v.date ? `, ${v.date}` : ''}) ${v.url}`).join('\n') : 'No videos found.', links: r.videos.map((v) => v.url) }; }
      if (t === 'news') { const n = await s.news(String(a.query || '')); return { text: n.length ? n.map((x, i) => `${i + 1}. ${x.title} (${x.source}, ${x.date}) ${x.url}\n   ${x.snippet}`).join('\n') : 'No news found.', links: n.map((x) => x.url) }; }
      const r = await s.web(String(a.query || ''), { recent: a.recent || null });
      return { text: [r.box?.text ? `GOOGLE ANSWER: ${r.box.text} ${r.box.url}` : '', r.kg ? `KNOWLEDGE PANEL: ${r.kg.title}${r.kg.type ? ` (${r.kg.type})` : ''}: ${r.kg.text} ${r.kg.url} ${Object.entries(r.kg.facts).map(([k, v]) => `${k}: ${v}`).join('; ')}` : '', r.results.map((x, i) => `${i + 1}. ${x.title} — ${x.url}${x.date ? ` (${x.date})` : ''}\n   ${x.snippet}`).join('\n')].filter(Boolean).join('\n\n') || 'Nothing found.', links: r.results.map((x) => x.url) };
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
    name: 'ask_hal', kinds: ['team'], args: '{"message": "what to ask or tell HAL"}',
    about: "Talk to HAL, Euclidean's own assistant, in his chat (the founders see it there): today's news from his watch, the calendar, the outreach guide's kit for a lead, the app's commands and status, what he has noted. Anything he'd do that needs a person comes back as a Confirm button for the founders.",
    async run(a, t) {
      const text = String(a.message || '').trim(); if (!text) return { text: 'Say something to HAL.' };
      const history = ctx.store.all('halMessages').slice(-10);
      const ev = require('../core/events');
      const mine = ctx.store.insert('halMessages', { who: 'bot', bot: t.bot.name, botId: t.bot.id, text: text.slice(0, 4000), by: `Bot: ${t.bot.name}` }); ev.publish('hal', { id: mine.id });
      const res = await require('../hal').handle(text, { history, context: {}, actor: `bot:${t.bot.name}` });
      const saved = ctx.store.insert('halMessages', { who: 'hal', text: res.text || '', by: res.by || null, draft: res.draft || null, confirm: res.confirm || null, forBot: t.bot.name }); ev.publish('hal', { id: saved.id });
      return { text: `HAL: ${res.text || '(no answer)'}${res.draft ? `\n\nHis draft:\n${typeof res.draft === 'string' ? res.draft : JSON.stringify(res.draft)}` : ''}${res.confirm ? '\n\n(HAL put a Confirm button in his panel: a founder has to press it.)' : ''}` };
    },
  },
  {
    name: 'ask_claude', kinds: ['team'], args: '{"question": "what you need from Claude"}',
    about: "Ask Claude (the founders' Claude) something you can't settle yourself: a judgement call, a second opinion on a draft, help with code or a plan. It's answered at once when the founders' Claude login is open; otherwise it waits in Claude's inbox in HAL's chat, and when Claude answers, the answer comes back to your chat and you carry on. Don't wait: finish what you can and say you've asked Claude.",
    async run(a, t) {
      const r = await require('../hal/claude').askFromBot(t.bot, String(a.question || ''), { runId: t.run?.id || null });
      return { text: r.answer ? `Claude: ${r.answer}` : "Sent to Claude's inbox (in HAL's chat). Claude's answer will come back to this chat and you'll pick the job up then. For now, answer with what you have and say you've asked Claude." };
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
  // ---------------------------------------------------------------- the Data tab (lists, sheets, packs, prompts)
  {
    name: 'data_search', kinds: ['app'], args: '{"query": "names or words", "dataset": "optional dataset name"}',
    about: "Search the Data tab: the team's lists, winners lists, called lists, call sheets, research packs, briefs and anything saved before. Returns matching people, rows and passages with which list they're in.",
    async run(a) {
      const D = require('../data'); const ds = a.dataset ? D.list().find((d) => d.name.toLowerCase().includes(String(a.dataset).toLowerCase())) : null;
      const hits = D.search(String(a.query || ''), { id: ds?.id || null, limit: 10 });
      return { text: hits.length ? hits.map((h) => `[${h.dataset} · ${h.type}]\n${h.text}`).join('\n\n') : `Nothing in the Data tab matches "${a.query}". Lists: ${D.list().map((d) => d.name).join('; ') || 'none yet'}.` };
    },
  },
  {
    name: 'data_read', kinds: ['app'], args: '{"dataset": "its name (empty = list them)", "part": "a section or table title (optional)"}',
    about: 'Open a list in the Data tab: its sections and tables, the people in it, or one section/table in full.',
    async run(a) {
      const D = require('../data'); const all = D.list();
      if (!a.dataset) return { text: all.length ? all.map((d) => `- ${d.name} (${d.kind}; ${d.counts?.people || 0} people, ${d.counts?.tables || 0} tables, ${d.counts?.sections || 0} sections; added ${String(d.createdAt).slice(0, 10)} by ${d.by})`).join('\n') : 'The Data tab is empty.' };
      const d = all.find((x) => x.name.toLowerCase() === String(a.dataset).toLowerCase()) || all.find((x) => x.name.toLowerCase().includes(String(a.dataset).toLowerCase()));
      if (!d) return { text: `No list called "${a.dataset}". Lists: ${all.map((x) => x.name).join('; ')}.` };
      const f = D.full(d.id); const part = String(a.part || '').toLowerCase();
      if (part) {
        const tb = (f.tables || []).find((x) => String(x.title).toLowerCase().includes(part));
        if (tb) return { text: `${tb.title}:\n${tb.columns.join(' | ')}\n${tb.rows.slice(0, 80).map((r) => tb.columns.map((c) => r[c]).join(' | ')).join('\n')}` };
        const sec = (f.sections || []).find((x) => x.title.toLowerCase().includes(part));
        if (sec) return { text: cut(`${sec.title}:\n${sec.text}`, 7000) };
      }
      return { text: [`${d.name}`, `Sections: ${(f.sections || []).map((x) => x.title).join(' | ')}`, `Tables: ${(f.tables || []).map((x) => `${x.title} (${x.rows.length})`).join(' | ')}`,
        f.people?.length ? `People (${f.people.length}): ${f.people.slice(0, 60).map((p) => `${p.name}${p.office ? ` [${p.office}]` : ''}${p.status ? ` ${p.status}` : ''}${p.email ? ` <${p.email}>` : ''}`).join('; ')}` : ''].filter(Boolean).join('\n') };
    },
  },
  {
    name: 'data_save', kinds: ['app'], args: '{"name": "what this list is", "text": "the table as markdown (| col | col |) or CSV, or notes"}',
    about: 'Save something you built (a call sheet, a research table, a cleaned list) as a new list in the Data tab, so the founders and other bots can use it. It goes nowhere else.',
    async run(a, t) { const d = require('../data').add({ name: String(a.name || `${t.bot.name} notes`).slice(0, 140), text: String(a.text || ''), source: `bot:${t.bot.name}`, by: `bot:${t.bot.name}` }); return { text: `Saved to the Data tab as "${d.name}" (${d.counts.people} people, ${d.counts.tables} tables).` }; },
  },
  // ---------------------------------------------------------------- scouting (what the GrokBots' research packs did)
  {
    name: 'lead_lookup', kinds: ['leads'], args: '{"name": "person (or part of a name)", "office": "optional"}',
    about: 'Is this person already on our board? Shows their office, stage, email, HOLD/lost flags, the GrokBot research pack and outreach kit if they have one. Check before researching anyone.',
    async run(a) {
      const n = String(a.name || '').toLowerCase().trim(); if (!n) return { text: 'Give a name.' };
      const hits = ctx.store.all('prospects', (p) => String(p.name || '').toLowerCase().includes(n) && (!a.office || String(p.office || '').toLowerCase().includes(String(a.office).toLowerCase()))).slice(0, 5);
      if (!hits.length) return { text: `${a.name} is not on our board yet.` };
      return { text: hits.map((p) => {
        const g = p.grok || {}; const k = p.kit || {};
        return [`${p.name} · ${p.office || ''} · ${p.type} · stage ${p.stage || 'new'}${p.triage === 'pending' ? ' (waiting in New prospects)' : ''}${p.hold ? ' · HOLD' : ''}${p.electionResult === 'lost' ? ' · lost' : ''}`,
          p.email ? `Email: ${p.email}${p.emailVerified ? ' (verified)' : ''}` : 'No email on file.',
          g.status ? `GrokBot pack (${g.pack || ''}): status ${g.status}; tier ${g.tier || '?'}; hook: ${g.hook || '-'}; best channel ${g.bestChannel || '-'}; phone ${g.phone || '-'}` : '',
          k.card ? `Outreach card: ${JSON.stringify(k.card).slice(0, 700)}` : '',
          p.why ? `Why: ${String(p.why).slice(0, 200)}` : '', p.priorContact ? `Prior contact: ${p.priorContact}` : ''].filter(Boolean).join('\n');
      }).join('\n\n') };
    },
  },
  {
    name: 'deep_research', kinds: ['web'], long: true, args: '{"task": "the whole job in the person\'s words, e.g. find 10 young Democrats who won in NY or CT and look set for higher office"}',
    about: 'For big jobs (find/scout/list N people or facts, a deep or thorough search): plans the searches, reads the best pages, keeps only names and facts that are really on those pages (with the sentence and link), checks them against the request, and saves the list to the Data tab. Takes a few minutes; every step shows in the chat.',
    async run(a, t) {
      const res = await require('./agent').deepSteps(t.bot, t.run, a.task || t.question);
      return { text: res ? res.answer : 'The deep research stopped before it found anything.' };
    },
  },
  {
    name: 'propose_leads', kinds: ['leads'], args: '{"leads": [{"name": "...", "office": "office and district", "type": "political|creator", "party": "", "email": "public campaign/press email you saw on their own site, or empty", "website": "", "phone": "", "hook": "the one sharp fact for an opening line", "why": "why they fit, one line", "source": "link where you confirmed it"}]}',
    about: 'Add people you researched to Politics/Outreach → New prospects (they wait there for the founders to approve; nothing is sent). Only people you confirmed with a link; never .gov emails, never home addresses or family details.',
    needsOk: () => 'add new leads to New prospects',
    async run(a, t) {
      const list = (Array.isArray(a.leads) ? a.leads : []).filter((l) => l && l.name).slice(0, 40);
      let added = 0; const skipped = [];
      for (const l of list) {
        const name = String(l.name).trim().slice(0, 80);
        if (ctx.store.find('prospects', (p) => String(p.name || '').toLowerCase() === name.toLowerCase() && (!l.office || !p.office || String(p.office).toLowerCase() === String(l.office).toLowerCase()))) { skipped.push(`${name} (already on the board)`); continue; }
        let email = String(l.email || '').trim();
        if (/\.gov\b|\.state\.[a-z]{2}\.us\b/i.test(email)) { skipped.push(`${name}'s .gov email left out`); email = ''; }
        ctx.store.insert('prospects', {
          name, type: l.type === 'creator' ? 'creator' : 'political', office: String(l.office || '').slice(0, 160), location: String(l.office || '').slice(0, 160), party: l.party || '',
          email: /.+@.+\..+/.test(email) ? email : '', emailVerified: false, website: l.website || '', phone: l.phone || '', hook: String(l.hook || '').slice(0, 400),
          why: `${String(l.why || '').slice(0, 300)}${l.source ? ` (${l.source})` : ''}`, newsUrl: l.source || '', stage: 'new', triage: 'pending', source: `bot:${t.bot.name}`, listSource: `Bot: ${t.bot.name}`, verified: false, platforms: [], handle: '', publicContact: email || '',
        });
        added++;
      }
      require('../core/audit').log(`bot:${t.bot.name}`, 'bot.leads_added', { added, by: t.bot.name });
      require('../core/events').publish('prospects', {});
      return { text: `${added} added to New prospects (they wait for a founder's OK).${skipped.length ? ` Skipped: ${skipped.join('; ')}.` : ''}` };
    },
  },
  {
    name: 'find_videos', kinds: ['leads'], args: '{"name": "a politician (on our board, or any name)", "office": "optional, e.g. Assembly AD-38"}',
    about: "Find a politician's public videos on Google's Videos tab (floor sessions, hearings, council meetings, interviews, campaign videos), only the ones about them, best first. For someone on our board the list is saved on their lead, and the ad machine uses it.",
    async run(a) {
      const vf = require('../political/videofind');
      const n = String(a.name || '').toLowerCase().trim(); const p = n && ctx.store.all('prospects', (x) => String(x.name || '').toLowerCase() === n)[0];
      const r = p ? await vf.forLead(p.id, { actor: 'bot' }) : await vf.find({ name: a.name, office: a.office || '' }).then((x) => ({ found: x.videos, error: x.error }));
      const list = r.found || [];
      return { text: list.length ? `${list.length} video${list.length === 1 ? '' : 's'} of ${a.name}${p ? ' (saved on their lead)' : ''}:\n${list.map((v, i) => `${i + 1}. ${v.title} (${v.channel || v.source}${v.duration ? `, ${Math.round(v.duration / 60)} min` : ''}${v.date ? `, ${v.date}` : ''}; ${v.why.join(', ')}) ${v.url}`).join('\n')}` : `No videos of ${a.name} found${r.error ? ` (${r.error})` : ''}.`, links: list.map((v) => v.url) };
    },
  },
  {
    name: 'make_ads', kinds: ['leads'], args: '{"names": ["leads on our board"]}',
    about: "Start the ad machine for leads on our board, hands-off: it finds their videos on Google (unless footage was uploaded), downloads the best, cuts the ads from their own words, makes the one-pager and drafts the email (Approvals; nothing is sent). Skips HOLD, lost and Ryan's people. Up to 25 at a time; each takes several minutes in the background.",
    async run(a) {
      const names = (Array.isArray(a.names) ? a.names : [a.names || a.name]).filter(Boolean).map(String);
      const r = require('../political/autoads').start({ names, actor: 'bot' });
      return { text: `Started the ad machine for ${r.started.length}: ${r.started.map((x) => x.name).join(', ') || 'nobody'}.${r.skipped.length ? ` Skipped: ${r.skipped.join('; ')}.` : ''} Progress shows on Politics → Ad machine; finished ads land in its Finished tab.` };
    },
  },
  {
    name: 'draft_outreach', kinds: ['leads'], args: '{"name": "a lead already on our board"}',
    about: 'Run the outreach guide for a lead on our board: research card, tier, and the whole kit (email, follow-up, call script, voicemail, DM, text). The email waits in Approvals as a draft; nothing is sent.',
    needsOk: () => 'draft outreach for a lead (drafts only, nothing is sent)',
    async run(a) {
      const n = String(a.name || '').toLowerCase().trim();
      const p = ctx.store.all('prospects', (x) => String(x.name || '').toLowerCase().includes(n))[0];
      if (!p) return { text: `${a.name} is not on our board. Add them first (propose_leads).` };
      const job = require('../jobs/queue').enqueue('outreach.kits', { ids: [p.id] }, { actor: 'bot', dedupeKey: `kit:${p.id}` });
      return { text: `Started the outreach drafts for ${p.name} (job ${job.id}). The kit shows on their lead panel and the email in Approvals when it's done.` };
    },
  },
  // ---------------------------------------------------------------- clients
  {
    name: 'client_overview', kinds: ['clients'], args: '{"client": "client name (empty = all active clients)"}',
    about: "A client's file: profile, voice, what to avoid, production settings and styles, recent clips and where each one is, posts, what's waiting in Approvals, and what we've learned about them.",
    async run(a) {
      const q = String(a.client || '').toLowerCase().trim();
      const all = ctx.store.all('clients', (c) => c.status !== 'archived');
      if (!q) return { text: all.map((c) => `- ${c.name} · ${c.type || ''} · ${c.status || 'active'}${c.retainer ? ` · $${c.retainer}/mo` : ''}`).join('\n') || 'No clients yet.' };
      const c = all.find((x) => String(x.name).toLowerCase() === q) || all.find((x) => String(x.name).toLowerCase().includes(q));
      if (!c) return { text: `No client called "${a.client}". Clients: ${all.map((x) => x.name).join(', ')}.` };
      const p = c.profile || {}; const prod = c.production || {};
      const clips = ctx.store.all('clips', (x) => x.clientId === c.id).slice(-15).reverse();
      const posts = ctx.store.all('posts', (x) => x.clientId === c.id).slice(-8).reverse();
      const waiting = ctx.store.all('approvals', (x) => x.clientId === c.id && (x.status || 'pending') === 'pending').length;
      const mem = (c.memory || []).filter((m) => m.active !== false).map((m) => `- ${m.text}`).join('\n');
      const notes = require('../hal/memory').recall(c.name, { limit: 6 });
      return { text: [`CLIENT: ${c.name} (${c.type || ''}, ${c.status || 'active'})${c.retainer ? `, $${c.retainer}/month` : ''}`,
        p.about ? `About: ${p.about}` : '', p.audience ? `Audience: ${p.audience}` : '', p.voice ? `Voice: ${p.voice}` : '', p.topics ? `Topics: ${p.topics}` : '', p.avoid ? `Never: ${p.avoid}` : '',
        `Production: styles ${JSON.stringify(prod.styleMix || prod.videoStyle || 'custom')}, ${prod.minClipSec || '?'}-${prod.maxClipSec || '?'} s clips${prod.aiTips ? `, tips: ${prod.aiTips}` : ''}`,
        mem ? `Their preferences:\n${mem}` : '',
        `Recent clips:\n${clips.map((x) => `- ${x.title || x.hook || x.id} · ${x.status}${x.decision?.note ? ` · note: ${x.decision.note}` : ''}`).join('\n') || '- none'}`,
        `Recent posts:\n${posts.map((x) => `- ${x.title || x.caption || x.id} · ${x.status || ''}${x.metrics?.views != null ? ` · ${x.metrics.views} views` : ''}`).join('\n') || '- none'}`,
        `Waiting in Approvals: ${waiting}`, notes.length ? `From the notebook:\n${require('../hal/memory').block(notes)}` : ''].filter(Boolean).join('\n') };
    },
  },
  {
    name: 'title_ideas', kinds: ['clients'], args: '{"topic": "what the video is about", "platform": "youtube|shorts|tiktok|instagram"}',
    about: 'The SEO lab: titles (scored against what has worked for us), a description, tags and hashtags for a video.',
    async run(a) {
      const r = await require('../seo').generate({ topic: String(a.topic || ''), platform: a.platform || 'shorts' });
      const titles = (r.titles || []).slice(0, 8).map((x) => `- ${x.title || x.text || x} ${x.score != null ? `(${x.score}/100)` : ''}`).join('\n');
      return { text: `Titles:\n${titles}\n\nDescription:\n${r.description || ''}\n\nTags: ${(r.tags || []).join(', ')}\nHashtags: ${(r.hashtags || []).join(' ')}` };
    },
  },
  // ---------------------------------------------------------------- your GrokBot, for the hard questions
  {
    name: 'ask_grokbot', kinds: ['web'], args: '{"question": "the deep research question, complete on its own", "found_so_far": "what you already found (optional, so it does not repeat it)", "grokbot": "which GrokBot (optional)"}',
    about: "Hand a hard research question to the founders' GrokBot (by email; its answer comes back to this chat in a few minutes and you carry on then). Use your own tools first: only for deep research they could not settle, live X/Twitter questions, or when the person asks for GrokBot. Each one uses one of this week's limited GrokBot questions.",
    available: () => { try { return require('../integrations/grokbots').ready(); } catch { return false; } },
    needsOk: (bot, a, run) => (bot.grokAuto || /\bgrok/i.test(String(run?.question || '')) ? null : 'ask your GrokBot (uses one of this week\'s GrokBot questions)'),
    async run(a, t) {
      const G = require('../integrations/grokbots');
      const q = String(a.question || '').trim(); if (!q) return { text: 'What should GrokBot research?' };
      const task = `${q}${a.found_so_far ? `\n\nWhat we already found (don't repeat it, go deeper):\n${String(a.found_so_far).slice(0, 4000)}` : ''}\n\nPlease answer with the facts and a link for each one. If you can't confirm something, say so.\n(Asked by ${t.bot.name}, a bot in Euclidean Media's app, for Ben and Ryan.)`;
      const r = await G.send({ bot: a.grokbot || null, task, title: q.slice(0, 80), actor: `bot:${t.bot.name}`, context: { botId: t.bot.id, runId: t.run?.id || null, question: q } });
      const b = G.budget();
      return { text: `Sent to ${r.bot} by email (${b.left} of this week's ${b.cap} GrokBot questions left). Its answer will come back to this chat, usually within minutes, and you'll carry on then. Now answer the person with what you have so far and say GrokBot is digging deeper.` };
    },
  },
  // ---------------------------------------------------------------- email (drafts only; a person sends)
  {
    name: 'email_inbox', kinds: ['email'], args: '{"query": "words to look for (optional)", "days": 14, "unread": false, "sent": false}',
    about: "The outreach mailbox: recent emails (newest first) with who, when, subject and the first lines; auto-replies and bounces are marked. sent: true lists what we sent instead. Search by name, address or words.",
    async run(a) {
      const list = require('../automation/mailbox').inbox({ query: a.query || '', days: a.days || 14, unread: !!a.unread, direction: a.sent ? 'out' : 'in', limit: 20 });
      if (!list.length) return { text: `No ${a.sent ? 'sent ' : ''}emails${a.query ? ` matching "${a.query}"` : ''} in the last ${a.days || 14} days.${a.sent ? '' : ' (email_check looks for new mail now.)'}` };
      return { text: list.map((m) => `- [${m.id}] ${m.when} · ${m.direction === 'in' ? 'from' : 'to'} ${m.name}${m.email ? ` <${m.email}>` : ''}${m.auto ? ' (auto-reply)' : ''} · "${m.subject}" · ${m.preview}${m.attachments.length ? ` · attached: ${m.attachments.join(', ')}` : ''}`).join('\n') + '\n\n(email_read with an [id] shows the whole thread.)' };
    },
  },
  {
    name: 'email_read', kinds: ['email'], args: '{"id": "a message id from email_inbox"}',
    about: 'Read a whole email thread (every message both ways, in order).',
    async run(a) {
      const t = require('../automation/mailbox').thread(String(a.id || ''));
      return { text: `Thread with ${t.contact?.name || '?'}${t.contact?.emails?.length ? ` <${t.contact.emails[0]}>` : ''}${t.contact?.optedOut ? ' (OPTED OUT: never email again)' : ''}\n\n${t.messages.map((m) => `[${m.id}] ${m.when} · ${m.direction === 'in' ? 'THEM' : 'US'} · ${m.status}${m.subject ? ` · ${m.subject}` : ''}\n${m.body}${m.attachments.length ? `\n(attached: ${m.attachments.join(', ')})` : ''}`).join('\n\n---\n\n')}` };
    },
  },
  {
    name: 'email_check', kinds: ['email'], args: '{}',
    about: 'Check the mailbox for new email right now.',
    async run() { const r = await require('../automation/mailbox').check(); return { text: r.connected ? `${r.newMessages} new email${r.newMessages === 1 ? '' : 's'}.` : r.message }; },
  },
  {
    name: 'email_draft', kinds: ['email'], args: '{"to": "email address or a contact/lead name", "subject": "...", "body": "the email", "reply_to": "message id to answer in its thread (optional)", "attach": "a document id or title to attach (optional)"}',
    about: 'Write an email draft. It waits in Approvals for a person; it is NEVER sent from here. Political first emails go to campaign or press addresses, not .gov ones. House style: short, personal, one clear ask, no em dashes.',
    async run(a, t) {
      const r = require('../automation/mailbox').draft({ to: a.to, subject: a.subject, body: a.body, replyTo: a.reply_to || a.replyTo || null, attach: a.attach || null, by: `bot:${t.bot.name}` });
      return { text: `Draft to ${r.to}${r.email ? ` <${r.email}>` : ''} is waiting in Approvals (not sent).${r.attached ? ` Attached: ${r.attached}.` : ''}` };
    },
  },
  {
    name: 'attach_document', kinds: ['email', 'docs'], args: '{"document": "document id or title", "to": "who the waiting draft is to (or message_id)", "message_id": "optional", "format": "pdf|docx"}',
    about: 'Attach a finished document (PDF or Word) to an email draft that is waiting in Approvals. Nothing is sent.',
    async run(a, t) {
      const mb = require('../automation/mailbox');
      const r = require('../docs').attach(mb.resolveDoc(a.document), { messageId: a.message_id || a.messageId || null, to: a.to || '', format: a.format || 'pdf', by: `bot:${t.bot.name}` });
      return { text: `Attached ${r.attached} to the draft (still waiting in Approvals).` };
    },
  },
  // ---------------------------------------------------------------- documents and call lists
  {
    name: 'make_document', kinds: ['docs'], args: '{"kind": "playbook|plan|brief|proposal|report|custom", "title": "...", "about": "who or what it is for", "instructions": "what the founders asked for, in their words", "lead": "a lead on our board (optional)", "client": "a client (optional)", "research": false}',
    about: "Write a finished document as a designed PDF and a Word file (client playbooks with filming diagrams and phone wireframes, platform and campaign plans, meeting briefs, proposals, reports), from the Data tab, the notebook and the lead/client on file (research: true also searches the web). Takes a few minutes in the background; it shows on the Data tab under Documents.",
    async run(a, t) {
      const lead = a.lead ? ctx.store.all('prospects').find((p) => String(p.name || '').toLowerCase().includes(String(a.lead).toLowerCase())) : null;
      const client = a.client ? ctx.store.all('clients').find((c) => String(c.name || '').toLowerCase().includes(String(a.client).toLowerCase())) : null;
      const d = require('../docs/write').start({ kind: a.kind || 'custom', title: a.title || '', about: a.about || lead?.name || client?.name || '', instructions: a.instructions || t.question, prospectId: lead?.id || null, clientId: client?.id || null, research: a.research === true || a.research === 'true' }, `bot:${t.bot.name}`);
      const done = await require('../docs').waitFor(d.id, 150000);
      return { text: done.status === 'ready' ? `Done: "${done.title}" (${done.pages || '?'} pages), PDF and Word. Document id ${done.id}. It's on the Data tab under Documents; attach it to a draft with attach_document.` : done.status === 'failed' ? `It didn't finish: ${done.error}` : `Writing "${done.title}" (document id ${done.id}): ${done.note || 'in progress'}. It keeps going in the background; check with list_documents.` };
    },
  },
  {
    name: 'revise_document', kinds: ['docs'], args: '{"document": "document id or title", "note": "what to change, in the founders\' words"}',
    about: 'Change a finished document from a note ("make the filming guide one page with diagrams"); the old version is kept.',
    async run(a, t) {
      const id = require('../automation/mailbox').resolveDoc(a.document);
      require('../docs/write').revise(id, a.note || t.question, `bot:${t.bot.name}`);
      const done = await require('../docs').waitFor(id, 150000);
      return { text: done.status === 'ready' ? `Revised "${done.title}" (${done.pages || '?'} pages). The old version is kept.` : `Revising "${done.title}": ${done.note || done.error || 'in progress'}.` };
    },
  },
  {
    name: 'list_documents', kinds: ['docs'], args: '{"query": "optional words"}',
    about: 'The documents made so far (playbooks, plans, briefs, call sheets, contact books) with their status and id.',
    async run(a) { const l = require('../docs').list({ q: a.query || '', limit: 25 }); return { text: l.length ? l.map((d) => `- [${d.id}] ${d.title} · ${d.kind} · ${d.status}${d.pages ? ` · ${d.pages} pages` : ''}${d.note ? ` · ${d.note}` : ''}`).join('\n') : 'No documents yet.' }; },
  },
  {
    name: 'build_call_list', kinds: ['leads', 'docs'], args: '{"request": "who you want, in the founders\' words, e.g. two for Ben and two for Ryan, freshly re-elected NY Assembly members", "include_previous": false}',
    about: "Build a checked call list: picks from our leads and the Data tab's winners lists, leaves out everyone already called, emailed or pitched, checks each person's district/Albany phones, office email and an accomplishment hook on their official pages (with the link), and writes a call script, voicemail and email draft for each. Saved as a call sheet (PDF + Word) and in the Data tab. Nothing is sent.",
    async run(a, t) {
      const C = require('../outreach/calllist');
      const l = C.start({ request: a.request || t.question, includePrevious: !!(a.include_previous || a.includePrevious) }, `bot:${t.bot.name}`);
      const t0 = Date.now(); let cur = l;
      while (Date.now() - t0 < 170000) { await new Promise((r) => setTimeout(r, 2000)); cur = C.get(l.id); if (!cur || ['done', 'failed'].includes(cur.status)) break; }
      if (!cur) return { text: 'The call list was removed.' };
      if (cur.status === 'failed') return { text: `The call list stopped: ${cur.error}` };
      if (cur.status !== 'done') return { text: `Still checking (${cur.note}). It keeps going in the background; the call sheet lands on the Data tab under Documents.` };
      const picked = cur.items.filter((x) => x.picked);
      return { text: `Call list "${cur.title}" (document ${cur.documentId}):\n${picked.map((x) => `- ${x.who}: ${x.name} (${x.office}) · ${(x.verified?.phones || []).map((p) => `${p.label} ${p.num}`).join(', ') || x.phone || 'no phone found'} · hook: ${x.hook ? `${x.hook.slice(0, 160)}${x.hookSource ? ` (${x.hookSource})` : ''}` : 'none found'}`).join('\n')}${cur.items.some((x) => x.state2 === 'dropped') ? `\nDropped at the check: ${cur.items.filter((x) => x.state2 === 'dropped').map((x) => `${x.name} (${x.dropWhy})`).join('; ')}` : ''}\nLeft out: ${Object.entries(cur.left || {}).map(([k, v]) => `${v} ${k}`).join(', ') || 'none'}.` };
    },
  },
  {
    name: 'contact_book', kinds: ['leads', 'email'], args: '{"days": 14, "make_document": false}',
    about: 'Everyone we reached out to lately: what was sent and when, who replied (real replies vs auto-replies), bounces, and the next step for each. make_document: true also saves it as a PDF + Word contact book.',
    async run(a, t) {
      const C = require('../outreach/calllist'); const b = C.contactBook({ days: a.days || 14 });
      if (!b.people.length) return { text: `No outreach in the last ${a.days || 14} days.` };
      let doc = ''; if (a.make_document || a.makeDocument) { const d = C.contactBookDoc({ days: a.days || 14, by: `bot:${t.bot.name}` }); doc = `\nSaved as a document (${d.id}).`; }
      return { text: `${b.responded} responded, ${b.waiting} waiting:\n${b.people.map((p) => `- ${p.name}${p.office ? ` (${p.office})` : ''}: ${p.sent}${p.response ? ` · ${p.response}` : ''}${p.bounced ? ' · BOUNCED' : ''} · next: ${p.next}`).join('\n')}${doc}` };
    },
  },
  // ---------------------------------------------------------------- scheduled tasks
  {
    name: 'schedule_task', kinds: ['schedule'], args: '{"action": "add|list|pause|resume|remove|autorun_on|autorun_off", "task": "what to do each time, in full", "every": "minutes|hours|day|weekday|week|times", "minutes": 30, "hours": 2, "at": "08:00", "times": ["08:00","12:30"], "day": 1, "id": "task id for pause/resume/remove"}',
    about: 'Your own scheduled tasks (data scrapes, briefs, news checks...): add one to run on its own every N minutes or hours, every day / weekday / week at a time, or at several set times each day; list, pause, resume or remove them; autorun_off pauses all of them (you keep chatting), autorun_on starts them again.',
    async run(a, t) {
      const B = require('./index'); const bot = ctx.store.get('bots', t.bot.id); let rs = bot.routines || [];
      const act = String(a.action || 'list').toLowerCase();
      const show = (list) => list.map((r) => `- [${r.id}] ${r.on ? '' : '(paused) '}${B.describe(r)}: ${r.task}${r.on && B.autoRunOn(bot) ? ` · next ${new Date(B.nextRun(r) || Date.now()).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' })}` : ''}`).join('\n') || '(none)';
      if (act === 'autorun_on' || act === 'autorun_off') { B.update(bot.id, { schedulesOn: act === 'autorun_on' }); return { text: `Auto-run is ${act === 'autorun_on' ? 'on: scheduled tasks run on their own again' : 'off: scheduled tasks wait (you can still chat with me)'}.` }; }
      if (act === 'add') {
        if (!String(a.task || '').trim()) return { text: 'What should the task do each time?' };
        const next = B.cleanRoutines([...rs, { task: a.task, every: a.every || 'day', minutes: a.minutes, hours: a.hours, at: a.at, times: a.times, day: a.day, days: a.days, on: true, by: t.bot.name }]);
        B.update(bot.id, { routines: next }); const r = next[next.length - 1];
        return { text: `Scheduled: ${B.describe(r)}, "${r.task}".${B.autoRunOn(bot) ? ` First run ${new Date(B.nextRun(r) || Date.now()).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}.` : ' Auto-run is off, so it waits until it is turned on.'}` };
      }
      if (['pause', 'resume', 'remove'].includes(act)) {
        const k = rs.findIndex((r) => r.id === a.id || (a.task && r.task.toLowerCase().includes(String(a.task).toLowerCase())));
        if (k < 0) return { text: `No task like that. Your tasks:\n${show(rs)}` };
        rs = act === 'remove' ? rs.filter((_, i) => i !== k) : rs.map((r, i) => (i === k ? { ...r, on: act === 'resume' } : r));
        B.update(bot.id, { routines: rs }); return { text: `${act === 'remove' ? 'Removed' : act === 'pause' ? 'Paused' : 'Resumed'}.\n${show(B.get(bot.id)?.routines || rs)}` };
      }
      return { text: `Auto-run: ${B.autoRunOn(bot) ? 'on' : 'off'}.\n${show(rs)}` };
    },
  },
  // ---------------------------------------------------------------- the app itself (Euclidean's own commands)
  {
    name: 'euclidean', kinds: ['app'], args: '{"command": "one of the commands below, with its words"}',
    about: 'Run one of Euclidean\'s commands. Read-only, run at once: /inbox /followup /clients /clips [client] /schedule [client] /revenue /analytics [client] /queue /logs [words] /health /status /agents. Work (the person is asked first; nothing is sent or published): /draft <contact> <goal> (a message draft into Approvals), /discover <client> [n], /prospect <who>, /audit <prospect>, /remember <client>: <preference>, /edit <clip#> <instruction>, /render <clip#>, /invoice (drafts only).',
    needsOk: (bot, a) => (READ_CMDS.has(cmdName(a?.command)) ? null : `run ${String(a?.command || '').split(/\s/)[0]} in Euclidean`),
    async run(a) {
      const c = String(a.command || '').trim(); const name = cmdName(c);
      if (!READ_CMDS.has(name) && !WORK_CMDS.has(name)) return { text: `Bots can't run /${name || '?'}. Sending, approving, publishing, pausing and settings stay with the founders (ask them, or tell them to use HAL).` };
      const r = await require('../commands').execute(c.startsWith('/') ? c : `/${c}`, { actor: 'bot', viaAgent: true });
      const card = r.card ? `\n${JSON.stringify(r.card.data ?? r.card).slice(0, 3000)}` : '';
      return { text: `${r.text || ''}${card}` || 'Done.' };
    },
  },
];

/** The tools this bot has switched on (and that can work here). */
function forBot(bot) {
  const on = bot.tools || {};
  const kinds = new Set(Object.entries({ web: on.web !== false, notebook: on.notebook !== false, app: on.app !== false, team: on.team !== false, leads: !!on.leads, clients: !!on.clients, email: on.email !== false, docs: on.docs !== false, schedule: on.schedule !== false, browser: bot.computer === 'browser' || bot.computer === 'vm', vm: bot.computer === 'vm' }).filter(([, v]) => v).map(([k]) => k));
  return TOOLS.filter((t) => t.kinds.some((k) => kinds.has(k)) && (!t.available || t.available() || (t.name === 'browser_open')));
}

module.exports = { TOOLS, forBot, pageText, shotDir };
