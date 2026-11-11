/**
 * Documents: the finished PDFs and Word files Euclidean makes (client playbooks, platform plans, meeting briefs,
 * call sheets, winners lists, contact books, proposals). Each one is a spec (render.js) kept with its versions in
 * <data>/docs/<id>/, drawn to PDF through the PC's Edge/Chrome and to Word in code, and copied into the Data tab as
 * text so the bots and search can read it. Made by the founders, by the bots (make_document), by Claude through the
 * connector, by the AI writer (write.js) or by the call-list builder (outreach/calllist.js).
 */
const fs = require('fs');
const path = require('path');
const ctx = require('../core/ctx');
const paths = require('../core/paths');
const audit = require('../core/audit');
const events = require('../core/events');
const { now, run } = require('../core/util');
const R = require('./render');

const COL = 'documents';
const dirOf = (id) => { const d = path.join(paths.root, 'docs', String(id).replace(/[^\w-]/g, '')); fs.mkdirSync(d, { recursive: true }); return d; };
const slug = (s) => String(s || 'Document').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 90) || 'Document';
const dash = (s) => String(s ?? '').replace(/\s*—\s*/g, ', ').replace(/\s–\s/g, ' to ').replace(/–/g, '-');

/** Clean any spec (from a person, a bot, Claude or an AI): known blocks only, text as text, no em dashes, sane sizes. */
const TYPES = new Set(['text', 'bullets', 'checklist', 'table', 'cards', 'stats', 'callout', 'steps', 'beats', 'phone', 'tips', 'quote', 'email', 'person', 'people', 'sources', 'pagebreak']);
function str(v, max = 6000) { if (v == null) return ''; if (typeof v === 'object') v = v.text || v.title || JSON.stringify(v); return dash(String(v)).slice(0, max); }
function cleanBlock(b) {
  if (typeof b === 'string') return { type: 'text', text: str(b) };
  if (!b || typeof b !== 'object') return null;
  let type = String(b.type || '').toLowerCase().replace(/s?$/, (m) => m);
  const alias = { paragraph: 'text', p: 'text', list: 'bullets', bullet: 'bullets', numbered: 'bullets', grid: 'cards', card: 'cards', stat: 'stats', note: 'callout', tip: 'tips', wireframe: 'phone', flow: 'steps', timeline: 'steps', beat: 'beats', check: 'checklist', source: 'sources', links: 'sources', draft: 'email', break: 'pagebreak' };
  type = alias[type] || type;
  if (!TYPES.has(type)) return b.text ? { type: 'text', text: str(b.text) } : null;
  const out = { type };
  const items = (arr, f) => (Array.isArray(arr) ? arr.slice(0, 60).map(f).filter(Boolean) : []);
  switch (type) {
    case 'text': out.text = str(b.text || b.body); if (!out.text) return null; break;
    case 'bullets': case 'checklist': out.title = str(b.title, 200); out.items = items(b.items, (x) => str(x, 1200)); out.numbered = !!b.numbered || b.type === 'numbered'; if (!out.items.length) return null; break;
    case 'table': out.title = str(b.title, 200); out.columns = items(b.columns, (x) => str(x, 120)).slice(0, 8); out.rows = items(b.rows, (r) => (Array.isArray(r) ? r.slice(0, 8).map((c) => str(c, 1500)) : out.columns.map((c) => str(r?.[c], 1500)))); out.compact = !!b.compact; if (!out.columns.length) return null; break;
    case 'cards': case 'steps': case 'tips': out.title = str(b.title, 200); out.cols = b.cols ? Math.max(1, Math.min(3, +b.cols || 2)) : undefined; out.items = items(b.items, (c) => (typeof c === 'string' ? { title: str(c, 300) } : { label: str(c.label, 80), title: str(c.title, 300), text: str(c.text, 1500), tag: str(c.tag, 30), tone: str(c.tone, 10), icon: str(c.icon, 20), items: Array.isArray(c.items) ? c.items.slice(0, 12).map((x) => str(x, 400)) : undefined })); if (!out.items.length) return null; break;
    case 'stats': out.items = items(b.items, (c) => ({ value: str(c.value, 40), label: str(c.label, 80) })).slice(0, 5); if (!out.items.length) return null; break;
    case 'callout': out.title = str(b.title, 200); out.text = str(b.text); out.tone = ['info', 'warn', 'good', 'pink'].includes(b.tone) ? b.tone : 'info'; break;
    case 'beats': out.title = str(b.title, 200); out.items = items(b.items, (c) => ({ time: str(c.time, 30), text: str(c.text, 200) })).slice(0, 7); break;
    case 'phone': out.title = str(b.title, 200); out.label = str(b.label, 80); out.text = str(b.text, 1500); out.layout = ['talking', 'walk', 'stat', 'screen', 'grid', 'duet', 'pov', 'reply'].includes(b.layout) ? b.layout : 'talking';
      out.labels = { top: str(b.labels?.top, 60), middle: str(b.labels?.middle, 40), side: str(b.labels?.side, 40), bottom: str(b.labels?.bottom, 40), badge: str(b.labels?.badge, 50) };
      if (Array.isArray(b.beats)) out.beats = b.beats.slice(0, 6).map((c) => ({ time: str(c.time, 20), text: str(c.text, 120) }));
      if (b.facts && typeof b.facts === 'object') out.facts = Object.fromEntries(Object.entries(b.facts).slice(0, 6).map(([k, v]) => [str(k, 30), str(v, 120)])); break;
    case 'quote': out.text = str(b.text, 1200); out.by = str(b.by, 200); break;
    case 'email': out.subject = str(b.subject, 200); out.body = str(b.body || b.text, 5000); break;
    case 'person': Object.assign(out, cleanPerson(b)); break;
    case 'people': out.items = items(b.items, cleanPerson); break;
    case 'sources': out.items = items(b.items, (s) => (typeof s === 'string' ? str(s, 400) : { text: str(s.text || s.title, 300), url: /^https?:\/\//.test(String(s.url || '')) ? String(s.url).slice(0, 500) : '' })); break;
    default: break;
  }
  return out;
}
function cleanPerson(p) {
  if (!p || typeof p !== 'object') return null;
  const o = {}; for (const k of ['n', 'name', 'seat', 'status', 'tier', 'result', 'why', 'phones', 'email', 'hook', 'source', 'notes', 'next', 'script', 'voicemail', 'videoPrompt']) if (p[k] != null && p[k] !== '') o[k] = str(p[k], 4000);
  if (p.emailDraft) o.emailDraft = typeof p.emailDraft === 'string' ? str(p.emailDraft, 5000) : { subject: str(p.emailDraft.subject, 200), body: str(p.emailDraft.body, 5000) };
  return o.name ? o : null;
}
function cleanSpec(s) {
  const spec = s && typeof s === 'object' ? s : {};
  const out = { title: str(spec.title, 160) || 'Document', look: spec.look === 'plain' ? 'plain' : 'designed' };
  for (const k of ['subtitle', 'kicker', 'preparedFor', 'preparedBy', 'preparedByLabel', 'company', 'purpose', 'date', 'note', 'footer', 'brand']) if (spec[k]) out[k] = str(spec[k], 400);
  if (Array.isArray(spec.titleLines)) out.titleLines = spec.titleLines.slice(0, 2).map((x) => str(x, 80));
  out.chips = Array.isArray(spec.chips) ? spec.chips.slice(0, 8).map((c) => str(c, 60)).filter(Boolean) : [];
  out.sections = (Array.isArray(spec.sections) ? spec.sections : []).slice(0, 40).map((sec) => (sec && typeof sec === 'object' ? {
    title: str(sec.title, 200), kicker: str(sec.kicker, 120), intro: str(sec.intro, 3000), newPage: sec.newPage === false ? false : undefined, numbered: sec.numbered === false ? false : undefined,
    blocks: (Array.isArray(sec.blocks) ? sec.blocks : []).slice(0, 40).map(cleanBlock).filter(Boolean),
  } : null)).filter(Boolean);
  return out;
}

// ------------------------------------------------------------------ store

function list({ q = '', limit = 200 } = {}) {
  const t = String(q).toLowerCase();
  return ctx.store.all(COL).filter((d) => !t || `${d.title} ${d.kind} ${d.about || ''}`.toLowerCase().includes(t)).sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt))).slice(0, limit);
}
function get(id) { return ctx.store.get(COL, id) || ctx.store.find(COL, (d) => d.title.toLowerCase() === String(id).toLowerCase()) || null; }
function specOf(id) { try { return JSON.parse(fs.readFileSync(path.join(dirOf(id), 'spec.json'), 'utf8')); } catch { return null; } }
function saveSpec(id, spec, { version = false, note = '' } = {}) {
  const d = dirOf(id); const file = path.join(d, 'spec.json');
  if (version && fs.existsSync(file)) {
    const doc = ctx.store.get(COL, id); const v = (doc?.versions || []).length + 1;
    fs.copyFileSync(file, path.join(d, `spec-v${v}.json`));
    ctx.store.update(COL, id, { versions: [...(doc?.versions || []), { v, at: now(), note: String(note).slice(0, 300) }].slice(-12) });
  }
  fs.writeFileSync(file, JSON.stringify(spec, null, 1));
}
function full(id) { const d = get(id); if (!d) return null; const spec = specOf(d.id); if (spec) { delete spec._material; delete spec._outline; } return { ...d, spec }; }
function update(id, patch) { const d = ctx.store.update(COL, id, { ...patch, updatedAt: now() }); events.publish('docs', { id }); return d; }

/** A new document record (rendering happens in a job). */
function create({ title, kind = 'custom', look, about = '', prospectId = null, clientId = null, by = 'user', status = 'writing', request = null }) {
  const d = ctx.store.insert(COL, { title: str(title, 160) || 'Document', kind, look: look === 'plain' ? 'plain' : 'designed', about: str(about, 300), prospectId, clientId, by, status, progress: 0, note: '', files: {}, versions: [], request, createdAt: now(), updatedAt: now() });
  events.publish('docs', { id: d.id });
  return d;
}

/** Make a document from a finished spec: saved, then drawn to PDF + Word in a job. */
function make({ spec, kind = 'custom', about = '', prospectId = null, clientId = null, by = 'user', wait = false }) {
  const s = cleanSpec(spec);
  if (!s.sections.length) throw new Error('The document has no sections. Give it at least one section with some blocks.');
  const d = create({ title: s.title, kind, look: s.look, about, prospectId, clientId, by, status: 'rendering' });
  saveSpec(d.id, s);
  const job = require('../jobs/queue').enqueue('docs.render', { id: d.id }, { actor: by, title: `Make the document: ${s.title}`.slice(0, 90) });
  update(d.id, { jobId: job.id });
  audit.log(by, 'docs.created', { id: d.id, title: s.title, kind });
  return wait ? waitFor(d.id) : ctx.store.get(COL, d.id);
}
async function waitFor(id, ms = 120000) {
  const t0 = Date.now();
  for (;;) { const d = get(id); if (!d || ['ready', 'failed'].includes(d.status) || Date.now() - t0 > ms) return d; await new Promise((r) => setTimeout(r, 700)); }
}

// ------------------------------------------------------------------ drawing

/** Phone wireframes and filming drawings as pictures for the Word file: one browser screenshot, cut up with FFmpeg. */
async function drawImages(spec, work) {
  const items = [];
  (spec.sections || []).forEach((sec, i) => (sec.blocks || []).forEach((b, k) => {
    if (b.type === 'phone') { b._key = `${i}.${k}`; items.push({ key: b._key, svg: R.phoneSvg(b), w: 300, h: 570 }); }
    if (b.type === 'tips') { b._key = `${i}.${k}`; (b.items || []).forEach((t, j) => items.push({ key: `${b._key}:${j}`, svg: R.iconFor(t.icon, t.title), w: 280, h: 200 })); }
  }));
  const out = new Map(); if (!items.length) return out;
  const motion = require('../video/motion'); const ff = require('../video/ffmpeg');
  if (!motion.findBrowser()) return out;
  let y = 0; for (const it of items) { it.y = y; y += it.h + 4; }
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>${R.toHtml({ sections: [] }).match(/<style>([\s\S]*)<\/style>/)[1]} body{margin:0;background:#fff;width:300px} .slot{position:absolute;left:0;background:#fff;display:flex;align-items:center;justify-content:center} .slot svg{width:100%;height:100%;background:#fff}</style></head><body>${items.map((it) => `<div class="slot" style="top:${it.y}px;width:${it.w}px;height:${it.h}px">${it.svg.replace('class="phone"', '').replace('class="tip-ico"', '')}</div>`).join('')}</body></html>`;
  fs.mkdirSync(work, { recursive: true });
  const hf = path.join(work, 'drawings.html'); fs.writeFileSync(hf, html);
  const sheet = path.join(work, 'drawings.png');
  try { await motion.screenshot(hf, sheet, 300, y + 4, work); } catch { return out; }
  for (let i = 0; i < items.length; i++) {
    const it = items[i]; const f = path.join(work, `d${i}.png`);
    try { await run(ff.bin('ffmpeg'), ['-y', '-v', 'error', '-i', sheet, '-vf', `crop=${it.w}:${it.h}:0:${it.y}`, f], { timeoutMs: 30000 }); out.set(it.key, { png: fs.readFileSync(f), w: it.w, h: it.h }); } catch { /* text box instead */ }
  }
  return out;
}

/** Draw the spec to HTML, PDF and Word; copy the text into the Data tab. */
async function render(id, h = null) {
  const d = get(id); if (!d) throw new Error('That document is gone.');
  const spec = specOf(d.id); if (!spec) throw new Error('That document has nothing in it yet.');
  try { return await renderInner(d, spec, h); } catch (e) { update(d.id, { status: 'failed', error: e.message, note: e.message }); throw e; }
}
async function renderInner(d, spec, h) {
  const dir = dirOf(d.id); const work = path.join(paths.tmp('docs'), `${d.id}-${Date.now()}`); fs.mkdirSync(work, { recursive: true }); // a fresh browser profile each time
  const name = slug(spec.title);
  update(d.id, { status: 'rendering', note: 'Drawing the pages' });
  const htmlFile = path.join(dir, `${name}.html`); fs.writeFileSync(htmlFile, R.toHtml(spec));
  h?.progress?.(0.25, 'Drawing the PDF');
  const files = { html: htmlFile };
  const errors = [];
  try { const pdf = path.join(dir, `${name}.pdf`); await require('../video/motion').printPdf(htmlFile, pdf, work); files.pdf = pdf; } catch (e) { errors.push(`PDF: ${e.message}`); }
  h?.progress?.(0.6, 'Writing the Word file');
  try {
    const images = await drawImages(spec, work);
    const docx = path.join(dir, `${name}.docx`); fs.writeFileSync(docx, require('./docx').toDocx(spec, { images })); files.docx = docx;
  } catch (e) { errors.push(`Word: ${e.message}`); }
  try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* left */ }
  // A text copy in the Data tab (replacing the last one), so bots and search can read the document.
  let datasetId = d.datasetId || null;
  try {
    const data = require('../data');
    if (datasetId) data.remove(datasetId, 'system');
    datasetId = data.add({ name: `${spec.title} (document)`, text: R.toText(spec), source: `Document ${d.id}`, by: d.by || 'system', note: `Made ${d.kind}` }).id;
  } catch { /* the files are what matter */ }
  const pages = files.pdf ? pdfPages(files.pdf) : null;
  update(d.id, { status: files.pdf || files.docx ? 'ready' : 'failed', progress: 1, note: errors.join(' · '), error: files.pdf || files.docx ? null : errors.join(' · '), files: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, path.basename(v)])), pages, sections: spec.sections.length, datasetId, renderedAt: now(), title: spec.title });
  audit.log(d.by || 'system', 'docs.rendered', { id: d.id, title: spec.title, pages, files: Object.keys(files) });
  return get(d.id);
}
function pdfPages(file) { try { const s = fs.readFileSync(file).toString('latin1'); return (s.match(/\/Type\s*\/Page[^s]/g) || []).length || null; } catch { return null; } }

function fileOf(id, fmt) {
  const d = get(id); if (!d) return null;
  const f = d.files?.[fmt === 'word' ? 'docx' : fmt]; if (!f) return null;
  const p = path.join(dirOf(d.id), f); return fs.existsSync(p) ? p : null;
}

function remove(id, by = 'user') {
  const d = get(id); if (!d) return { ok: true };
  ctx.store.remove(COL, d.id);
  try { fs.rmSync(dirOf(d.id), { recursive: true, force: true }); } catch { /* kept */ }
  if (d.datasetId) try { require('../data').remove(d.datasetId, by); } catch { /* gone */ }
  audit.log(by, 'docs.deleted', { title: d.title }); events.publish('docs', { id: d.id });
  return { ok: true };
}

/** Change parts of a spec by hand (title, a section's blocks): saved as a new version and drawn again. */
function edit(id, patch, by = 'user') {
  const d = get(id); if (!d) throw new Error('That document is gone.');
  const cur = specOf(d.id) || { sections: [] };
  const next = cleanSpec(patch.spec ? patch.spec : { ...cur, ...patch });
  saveSpec(d.id, next, { version: true, note: patch.note || 'Edited' });
  const job = require('../jobs/queue').enqueue('docs.render', { id: d.id }, { actor: by, title: `Make the document: ${next.title}`.slice(0, 90) });
  return update(d.id, { status: 'rendering', jobId: job.id, title: next.title });
}

/**
 * Attach a document to an email draft that is waiting for approval (never sends: the draft still waits for a person).
 * Finds the draft by message id, or the newest pending draft to a lead/contact by their name or email.
 */
function attach(id, { messageId = null, to = '', format = 'pdf', by = 'user' } = {}) {
  const d = get(id); if (!d) throw new Error('That document is gone.');
  if (d.status !== 'ready') throw new Error('That document is still being made. Try again when it is ready.');
  const file = fileOf(d.id, format === 'docx' || format === 'word' ? 'docx' : 'pdf') || fileOf(d.id, 'pdf') || fileOf(d.id, 'docx');
  if (!file) throw new Error('That document has no file to attach.');
  let msg = messageId ? ctx.store.get('messages', messageId) : null;
  if (!msg && to) {
    const t = String(to).toLowerCase().trim();
    const contacts = ctx.store.all('contacts').filter((c) => (c.name && c.name.toLowerCase().includes(t)) || (c.email && c.email.toLowerCase() === t));
    const convs = new Set(ctx.store.all('conversations').filter((c) => contacts.some((k) => k.id === c.contactId)).map((c) => c.id));
    msg = ctx.store.all('messages').filter((m) => convs.has(m.conversationId) && m.direction !== 'in' && ['pending_approval', 'draft'].includes(m.status)).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0] || null;
  }
  if (!msg) throw new Error(to ? `No email draft waiting for approval to ${to}. Write the draft first, then attach.` : 'Which draft? Give the message id or who it is to.');
  if (!['pending_approval', 'draft', 'queued'].includes(msg.status) || msg.direction === 'in') throw new Error('That message was already sent (or is not ours to change). Attach to a draft that is still waiting.');
  const name = path.basename(file);
  const atts = (msg.attachments || []).filter((a) => a.docId !== d.id);
  atts.push({ name, path: file, docId: d.id, size: fs.statSync(file).size });
  ctx.store.update('messages', msg.id, { attachments: atts });
  events.publish('messages', { id: msg.id }); events.publish('approvals', {});
  audit.log(by, 'docs.attached', { id: d.id, title: d.title, messageId: msg.id });
  return { ok: true, messageId: msg.id, attached: name, status: msg.status };
}

module.exports = { COL, list, get, full, specOf, saveSpec, create, make, waitFor, render, edit, remove, attach, fileOf, update, cleanSpec, cleanBlock, dirOf };
