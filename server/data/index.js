'use strict';
/**
 * The Data tab (sidebar "Data", /data): every list, research pack, call sheet, master prompt or web page the team
 * hands Euclidean, read into tables it can use (Ryan, Nov 9: "parse new data and add it to Euclidean data tab").
 *
 * In: files (.csv .tsv .md .txt .json .html), pasted text, a web link (read through the safe web reader), or a bot
 * (data_save). Out: one dataset per thing, with
 *  - `sections`: the document split at its "===== BEGIN X =====" blocks or top headings (each kept as text),
 *  - `tables`: every markdown table and CSV/TSV/JSON table as rows of { column: value },
 *  - `people`: person blocks read from research packs and winners lists ("## 3. Grace Lee (SD-27) WON [Tier A]" with
 *    **Email:** / **Phones:** / **Result:** lines and a ```text email draft```), and rows of any table that has a
 *    Name column, as leads ready to add.
 * Then, by a person's click: Add to leads (prospects; the same name + office is updated, not doubled; a person's own
 * click adds them straight to the board, a bot's proposal waits in New prospects), Add to the notebook, Export CSV.
 * Big text is kept in <data>/data/<id>.json; the database holds the summary. Nothing here contacts anyone.
 */
const fs = require('fs');
const path = require('path');
const ctx = require('../core/ctx');
const paths = require('../core/paths');
const events = require('../core/events');
const audit = require('../core/audit');
const { now } = require('../core/util');

const COL = 'datasets';
const dir = () => { const d = path.join(paths.root, 'data'); fs.mkdirSync(d, { recursive: true }); return d; };
const fileOf = (id) => path.join(dir(), `${String(id).replace(/[^A-Za-z0-9_-]/g, '')}.json`);
const clean = (s) => String(s ?? '').replace(/\*\*/g, '').replace(/`/g, '').replace(/\s+/g, ' ').trim();
const noDash = (s) => String(s ?? '').replace(/\s*[–—]\s*/g, ', ');

// ------------------------------------------------------------------ parsing
function parseDelimited(text, sep) {
  const rows = []; let row = []; let cur = ''; let q = false;
  const t = String(text).replace(/^﻿/, '');
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) { if (c === '"' && t[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; continue; }
    if (c === '"') q = true; else if (c === sep) { row.push(cur); cur = ''; } else if (c === '\n' || c === '\r') { if (c === '\r' && t[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; } else cur += c;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  const good = rows.filter((r) => r.some((x) => String(x).trim()));
  if (good.length < 2) return null;
  const head = good[0].map((h, i) => clean(h) || `col${i + 1}`);
  return { columns: head, rows: good.slice(1).map((r) => Object.fromEntries(head.map((h, i) => [h, clean(r[i])]))) };
}

/** Every markdown table: [{ title, columns, rows }]. */
function mdTables(text) {
  const out = []; const lines = String(text).split(/\r?\n/);
  let lastHeading = '';
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^#{1,6}\s/.test(l)) lastHeading = clean(l.replace(/^#+\s*/, ''));
    if (/^\s*\|.*\|\s*$/.test(l) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] || '')) {
      const cells = (s) => s.trim().replace(/^\||\|$/g, '').split('|').map(clean);
      const columns = cells(l).map((h, k) => h || `col${k + 1}`); const rows = [];
      let j = i + 2;
      for (; j < lines.length && /^\s*\|.*\|\s*$/.test(lines[j]); j++) { const c = cells(lines[j]); rows.push(Object.fromEntries(columns.map((h, k) => [h, c[k] ?? '']))); }
      if (rows.length) out.push({ title: lastHeading, columns, rows });
      i = j - 1;
    }
  }
  return out;
}

/** "===== BEGIN X =====" blocks, else the top-level (#) headings: [{ title, text }]. */
function sectionsOf(text) {
  const t = String(text);
  const blocks = [...t.matchAll(/=====\s*BEGIN\s+(.+?)\s*=====\s*\n([\s\S]*?)\n=====\s*END\b[^\n]*=====/g)].map((m) => ({ title: clean(m[1]), text: m[2].trim() }));
  if (blocks.length) {
    const intro = t.slice(0, t.indexOf('===== BEGIN')).trim();
    return [...(intro ? [{ title: (/^#\s+(.+)$/m.exec(intro) || [])[1]?.trim() || 'Introduction', text: intro }] : []), ...blocks];
  }
  const parts = t.split(/^(?=#\s)/m).map((p) => p.trim()).filter(Boolean);
  return parts.map((p) => ({ title: clean((/^#\s+(.+)$/m.exec(p) || [])[1] || p.split('\n')[0]).slice(0, 120), text: p }));
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const field = (block, label) => { const m = new RegExp(`\\*\\*${label}[^*]*:\\*\\*\\s*([^\\n]+)`, 'i').exec(block) || new RegExp(`^\\s*[-*]?\\s*${label}\\s*:\\s*([^\\n]+)`, 'im').exec(block); return m ? clean(m[1]) : ''; };

/**
 * People in research packs and winners lists: "## 12. Name (Seat) WON [Tier A]" style blocks (the GrokBot / Corbin /
 * Juno formats), with their email, phones, result, why, hook source and drafted email/voicemail/scripts.
 */
function peopleBlocks(text, source = '') {
  const out = []; const t = String(text);
  const heads = [];
  for (const m of t.matchAll(/^#{2,3}\s+(?:\d+\.\s+)?(.+)$/gm)) {
    const line = m[1];
    // The seat is the first bracket that looks like an office (a district number or an office word); brackets can nest.
    let at = -1; let depth = 0; let open = -1; let inner = ''; let close = -1;
    for (let k = 0; k < line.length; k++) {
      if (line[k] === '(') { if (depth === 0) open = k; depth++; } else if (line[k] === ')' && depth > 0) { depth--; if (depth === 0) { const c = line.slice(open + 1, k); if (/\d|District|County|House|Senate|Assembly|Council|Mayor|Supervisor|Legislat|Town|City|seat/i.test(c)) { at = open; inner = c; close = k; break; } } }
    }
    if (at < 0) continue;
    const rawName = line.slice(0, at).trim();
    const nick = (/\(([^)]+)\)/.exec(rawName) || [])[1] || '';
    const name = clean(rawName.replace(/\([^)]*\)/g, ' ')).replace(/\s+(WON|LOST)$/i, '');
    const words = name.split(' ');
    if (words.length < 2 || words.length > 5 || name === name.toUpperCase() || !words.every((w) => /^([A-Z][\w.'’-]*|de|la|del|van|von|da|di|III|II|IV|Jr\.?|Sr\.?)$/.test(w))) continue;
    heads.push({ index: m.index, name, nick, office: clean(inner), tail: line.slice(close + 1) });
  }
  heads.forEach((m, i) => {
    const start = m.index; const end = i + 1 < heads.length ? heads[i + 1].index : Math.min(t.length, start + 8000);
    const block = t.slice(start, end);
    const name = m.name;
    const tail = clean(m.tail);
    const emails = [...new Set((field(block, 'Email') || '').match(EMAIL) || [])];
    const draft = (label) => { const mm = new RegExp(`(?:\\*\\*|###\\s*)${label}[^\\n]*\\n+\\s*\`\`\`(?:text)?\\n([\\s\\S]*?)\`\`\``, 'i').exec(block); if (mm) return mm[1].trim(); const pl = new RegExp(`###\\s*${label}[^\\n]*\\n([\\s\\S]*?)(?=\\n###|\\n## |\\n---|$)`, 'i').exec(block); return pl ? pl[1].trim() : ''; };
    const emailDraft = draft('(?:First-touch )?Email') || draft('Email');
    out.push({
      name, nickname: m.nick, office: m.office, status: /\bWON\b/i.test(tail) ? 'won' : /\bLOST\b/i.test(tail) ? 'lost' : '', tier: (/\[Tier\s+([A-C])\]/i.exec(tail) || [])[1] || '', videoPick: /VIDEO PICK/i.test(tail),
      email: emails[0] || '', emails, emailNote: field(block, 'Email'), phones: field(block, 'Phones') || field(block, 'Phone'), result: field(block, 'Result'), why: field(block, 'Why'),
      hookSource: field(block, 'Hook source'), subject: (/^Subject:\s*(.+)$/m.exec(emailDraft) || [])[1] || '', emailDraft: emailDraft.replace(/^Subject:.*\n+/, ''),
      voicemail: draft('Voicemail'), pickup: draft('Pickup script'), followup: draft('Follow-up email'), brief: (/###\s*Video brief\s*\n([\s\S]*?)(?=\n###|\n## |$)/i.exec(block) || [])[1]?.trim() || '', source,
    });
  });
  // The same person can appear in several lists in one file: keep the fullest record.
  const best = new Map();
  for (const p of out) { const k = p.name.toLowerCase(); const cur = best.get(k); const score = (x) => Object.values(x).filter((v) => v && v !== true).length; if (!cur || score(p) > score(cur)) best.set(k, { ...(cur || {}), ...Object.fromEntries(Object.entries(p).filter(([, v]) => v)), videoPick: !!(p.videoPick || cur?.videoPick) }); }
  return [...best.values()];
}

/** Rows of a table that are people (a Name column): lead records. */
function peopleFromTable(tbl, source = '') {
  const col = (re) => tbl.columns.find((c) => re.test(c));
  const n = col(/^(name|full name|candidate|official|prospect|creator|channel)$/i) || col(/name/i); if (!n) return [];
  const office = col(/office|seat|district|race|position|channel/i); const email = col(/e-?mail|contact/i); const phone = col(/phone|number called|district$|campaign$/i);
  const status = col(/result|status|race_status/i); const hook = col(/hook|pitch|angle|why/i); const tier = col(/tier|package/i);
  return tbl.rows.map((r) => ({ name: clean(r[n]), office: office ? clean(r[office]) : '', email: (String(email ? r[email] : '').match(EMAIL) || [])[0] || '', phones: phone ? clean(r[phone]) : '', status: status ? clean(r[status]) : '', hook: hook ? clean(r[hook]) : '', tier: tier ? clean(r[tier]) : '', source, row: r }))
    .filter((p) => p.name && /[A-Za-z]/.test(p.name) && !/^\d+$/.test(p.name) && p.name.length < 80);
}

/** Read any text into { kind, sections, tables, people }. */
function parse(text, name = '') {
  const t = String(text || '');
  const ext = path.extname(name).toLowerCase();
  if (ext === '.json' || /^\s*[[{]/.test(t)) {
    try {
      const j = JSON.parse(t); const arr = Array.isArray(j) ? j : Array.isArray(j.people) ? j.people : Array.isArray(j.rows) ? j.rows : Array.isArray(j.data) ? j.data : null;
      if (arr && arr.length && typeof arr[0] === 'object') {
        const columns = [...new Set(arr.slice(0, 50).flatMap((x) => Object.keys(x)))].filter((k) => typeof arr[0][k] !== 'object' || arr[0][k] === null);
        const tbl = { title: name, columns, rows: arr.map((x) => Object.fromEntries(columns.map((c) => [c, clean(x[c])]))) };
        return { kind: 'table', sections: [], tables: [tbl], people: peopleFromTable(tbl, name) };
      }
    } catch { /* not JSON after all */ }
  }
  if (ext === '.csv' || ext === '.tsv' || (!/^#/m.test(t) && /^[^\n]*(,|\t)[^\n]*\n[^\n]*(,|\t)/.test(t) && !/\|/.test(t.split('\n')[0]))) {
    const tbl = parseDelimited(t, ext === '.tsv' || (t.split('\n')[0].split('\t').length > t.split('\n')[0].split(',').length) ? '\t' : ',');
    if (tbl) return { kind: 'table', sections: [], tables: [{ title: name, ...tbl }], people: peopleFromTable(tbl, name) };
  }
  let body = t;
  if (ext === '.html' || /<html|<body/i.test(t.slice(0, 3000))) { const e = require('../integrations/websearch').extract(t); body = `# ${e.title}\n\n${e.text}`; }
  const tables = mdTables(body); const sections = sectionsOf(body);
  const fromBlocks = peopleBlocks(body, name);
  const fromTables = tables.flatMap((tb) => peopleFromTable(tb, `${name}${tb.title ? ` · ${tb.title}` : ''}`));
  const byName = new Map(fromBlocks.map((p) => [p.name.toLowerCase(), p]));
  for (const p of fromTables) { const k = p.name.toLowerCase(); const cur = byName.get(k); byName.set(k, cur ? { ...p, ...Object.fromEntries(Object.entries(cur).filter(([, v]) => v)), lists: [...new Set([...(cur.lists || []), p.source])] } : { ...p, lists: [p.source] }); }
  const kind = /MASTER PROMPT/i.test(t.slice(0, 300)) ? 'prompt' : byName.size ? 'people' : tables.length ? 'tables' : 'text';
  return { kind, sections, tables, people: [...byName.values()] };
}

// ------------------------------------------------------------------ store
function summary(d) { const { text, ...rest } = d; return rest; }
function list() { return ctx.store.all(COL).map(summary).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))); }
function full(id) {
  const d = ctx.store.get(COL, id); if (!d) return null;
  let body = {}; try { body = JSON.parse(fs.readFileSync(fileOf(id), 'utf8')); } catch { /* summary only */ }
  return { ...d, ...body };
}

/** Add a dataset from text. Returns its summary. */
function add({ name, text, source = 'upload', by = 'user', note = '' }) {
  const t = String(text || ''); if (!t.trim()) throw new Error('That has no text in it.');
  if (t.length > 8 * 1024 * 1024) throw new Error('That file is too big (over 8 MB of text).');
  const p = parse(t, name || '');
  const d = ctx.store.insert(COL, {
    name: String(name || p.sections[0]?.title || 'Data').slice(0, 140), kind: p.kind, source: String(source).slice(0, 300), by, note: String(note).slice(0, 500),
    counts: { sections: p.sections.length, tables: p.tables.length, rows: p.tables.reduce((n, x) => n + x.rows.length, 0), people: p.people.length, chars: t.length },
    sectionTitles: p.sections.map((s) => s.title).slice(0, 60), tableTitles: p.tables.map((x) => `${x.title || 'Table'} (${x.rows.length})`).slice(0, 40), createdAt: now(), imported: null,
  });
  fs.writeFileSync(fileOf(d.id), JSON.stringify({ text: t, sections: p.sections, tables: p.tables, people: p.people }));
  audit.log(by, 'data.added', { id: d.id, name: d.name, people: p.people.length, tables: p.tables.length });
  events.publish('data', { id: d.id });
  return d;
}

/** A web page into the Data tab (read through the safe web reader). */
async function addUrl(url, by = 'user') {
  const pg = await require('../integrations/websearch').read(String(url));
  return add({ name: pg.title || url, text: `# ${pg.title || url}\n\nSource: ${pg.url}${pg.date ? `\nDate: ${pg.date}` : ''}\n\n${pg.text}\n\n## Links\n${(pg.links || []).map((l) => `- ${l.text}: ${l.url}`).join('\n')}`, source: pg.url, by });
}

function remove(id, by = 'user') { const d = ctx.store.get(COL, id); if (!d) return { ok: true }; ctx.store.remove(COL, id); try { fs.unlinkSync(fileOf(id)); } catch { /* gone */ } audit.log(by, 'data.deleted', { name: d.name }); events.publish('data', { id }); return { ok: true }; }
function rename(id, name) { const d = ctx.store.update(COL, id, { name: String(name || '').slice(0, 140) || 'Data' }); events.publish('data', { id }); return d; }

/** Search across datasets (bots and Claude): sections and rows whose text has the words. */
function search(q, { id = null, limit = 12 } = {}) {
  const words = String(q || '').toLowerCase().split(/\s+/).filter((w) => w.length > 1);
  const out = [];
  for (const d of (id ? [ctx.store.get(COL, id)].filter(Boolean) : ctx.store.all(COL))) {
    const f = full(d.id); if (!f) continue;
    const hit = (s) => { const low = s.toLowerCase(); return words.length ? words.filter((w) => low.includes(w)).length / words.length : 1; };
    for (const p of f.people || []) { const s = JSON.stringify(p); const h = hit(s); if (h >= 0.6) out.push({ dataset: d.name, id: d.id, type: 'person', score: h + 0.2, text: s.slice(0, 1500) }); }
    for (const tb of f.tables || []) for (const r of tb.rows) { const s = Object.entries(r).map(([k, v]) => `${k}: ${v}`).join(' | '); const h = hit(s); if (h >= 0.6) out.push({ dataset: d.name, id: d.id, type: `row of ${tb.title || 'table'}`, score: h, text: s.slice(0, 800) }); }
    for (const sec of f.sections || []) {
      const h = hit(`${sec.title} ${sec.text}`);
      if (h >= 0.6) { const low = sec.text.toLowerCase(); const at = words.length ? Math.max(0, low.indexOf(words.find((w) => low.includes(w)) || '') - 300) : 0; out.push({ dataset: d.name, id: d.id, type: `section ${sec.title}`, score: h - 0.1, text: sec.text.slice(at, at + 1500) }); }
    }
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}

// ------------------------------------------------------------------ into Euclidean
const officeKey = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
/**
 * Add a dataset's people to the leads board (prospects). Matched by name (and office when both have one): matches are
 * filled in (empty fields only, plus the list's research on `prospect.data`), new ones added. `pending` puts new ones
 * in New prospects instead (what bots use). `only` = names to take (default all). Returns { added, updated, skipped }.
 */
function toLeads(id, { only = null, pending = false, type = null, by = 'user' } = {}) {
  const f = full(id); if (!f) throw new Error('That data is gone.');
  const want = only ? new Set(only.map((n) => String(n).toLowerCase())) : null;
  let added = 0; let updated = 0; const skipped = [];
  for (const p of f.people || []) {
    if (want && !want.has(p.name.toLowerCase())) continue;
    if (/\blost\b/i.test(p.status || '')) { skipped.push(`${p.name} (lost)`); continue; }
    const email = /\.gov\b|\.state\.[a-z]{2}\.us\b/i.test(p.email || '') ? '' : p.email || '';
    const officialEmail = email ? '' : (p.email || '');
    const cur = ctx.store.find('prospects', (x) => String(x.name || '').toLowerCase() === p.name.toLowerCase() && (!x.office || !p.office || officeKey(x.office).includes(officeKey(p.office).slice(0, 6)) || officeKey(p.office).includes(officeKey(x.office).slice(0, 6))));
    const research = { list: f.name, status: p.status || p.result || '', tier: p.tier, phones: p.phones, why: p.why, hookSource: p.hookSource, subject: p.subject, email: p.emailDraft, voicemail: p.voicemail, pickup: p.pickup, followup: p.followup, videoPick: p.videoPick, brief: p.brief, officialEmail, row: p.row, at: now() };
    if (cur) {
      const patch = { data: { ...(cur.data || {}), [id]: research } };
      if (!cur.email && email) patch.email = email;
      if (!cur.office && p.office) patch.office = p.office;
      if (!cur.phone && p.phones) patch.phone = p.phones.slice(0, 200);
      if (/won/i.test(p.status || '') && !cur.electionResult) patch.electionResult = 'won';
      ctx.store.update('prospects', cur.id, patch); updated++;
    } else {
      const political = type ? type === 'political' : !/youtube|channel|creator/i.test(`${p.office} ${f.name}`);
      ctx.store.insert('prospects', {
        name: p.name, type: political ? 'political' : 'creator', office: p.office || '', location: p.office || '', email, phone: (p.phones || '').slice(0, 200), hook: p.hook || '',
        why: noDash(p.why || p.result || `From ${f.name}`).slice(0, 400), stage: 'new', ...(pending ? { triage: 'pending' } : {}), source: `data:${f.name}`.slice(0, 120), listSource: f.name.slice(0, 120),
        electionResult: /won/i.test(p.status || '') ? 'won' : undefined, verified: false, platforms: [], handle: '', publicContact: email, data: { [id]: research },
      });
      added++;
    }
  }
  ctx.store.update(COL, id, { imported: { added, updated, at: now(), by } });
  audit.log(by, 'data.to_leads', { id, name: f.name, added, updated });
  events.publish('prospects', {}); events.publish('data', { id });
  return { added, updated, skipped };
}

/** Each person (or each section) as a notebook note, so HAL, the bots and the outreach writer know it. */
function toNotebook(id, by = 'user') {
  const f = full(id); if (!f) throw new Error('That data is gone.');
  const mem = require('../hal/memory'); let n = 0;
  for (const p of f.people || []) {
    const text = [`${p.name}${p.office ? `, ${p.office}` : ''}${p.status ? ` (${p.status})` : ''}`, p.result, p.why, p.hook, p.email ? `email ${p.email}` : '', p.phones ? `phones ${p.phones}` : ''].filter(Boolean).join('. ');
    if (mem.add({ text: noDash(text).slice(0, 600), about: [p.name], kind: 'fact', source: `Data: ${f.name}`, key: `data:${id}:${p.name.toLowerCase()}`, link: (String(p.hookSource || '').match(/https?:\/\/\S+/) || [])[0] || null })) n++;
  }
  if (!n) for (const s of (f.sections || []).slice(0, 40)) if (mem.add({ text: noDash(`${s.title}: ${s.text.replace(/\s+/g, ' ').slice(0, 500)}`), kind: 'note', source: `Data: ${f.name}`, key: `data:${id}:${s.title.toLowerCase()}` })) n++;
  audit.log(by, 'data.to_notebook', { id, notes: n });
  return { notes: n };
}

function toCsv(id) {
  const f = full(id); if (!f) throw new Error('That data is gone.');
  const esc = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  if (f.people?.length) {
    const cols = ['name', 'office', 'status', 'tier', 'email', 'phones', 'why', 'hook', 'subject', 'emailDraft', 'voicemail', 'source'];
    return [cols.join(','), ...f.people.map((p) => cols.map((c) => esc(p[c])).join(','))].join('\n');
  }
  const tb = f.tables?.[0]; if (!tb) return 'text\n' + esc(f.text);
  return [tb.columns.map(esc).join(','), ...tb.rows.map((r) => tb.columns.map((c) => esc(r[c])).join(','))].join('\n');
}

/**
 * First start: the data embedded in the team's master prompts (Corbin's called list, call script and Top 5/Top 15
 * sheets, Juno's master winners list and scouting brief, Data Bot's materials) goes into the Data tab (_dataV1).
 */
function seed() {
  if (!ctx.store || ctx.store.settings._dataV1) return;
  const base = path.join(__dirname, '..', 'bots', 'seed');
  for (const [f, label] of [['corbin.md', 'Corbin (team lead): call sheets, called list, video picks'], ['juno.md', 'Juno (client bot): master winners list, scouting brief'], ['databot.md', 'Data Bot: sales materials, pricing, video picks']]) {
    try { const t = fs.readFileSync(path.join(base, f), 'utf8'); add({ name: label, text: t, source: `master prompt (${f})`, by: 'system', note: 'From the GrokBots\' master prompts, Nov 5 2026.' }); } catch { /* not shipped */ }
  }
  ctx.store.setSettings({ _dataV1: true });
}

module.exports = { parse, mdTables, peopleBlocks, sectionsOf, list, full, add, addUrl, remove, rename, search, toLeads, toNotebook, toCsv, seed, COL };
