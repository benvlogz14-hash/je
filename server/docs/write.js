/**
 * The document writer: turns "make JD a social video playbook" into a finished, sourced document.
 *  1. Material: what it was given, the Data tab passages about the subject, the notebook, the lead or client on file,
 *     and (when asked) live web research. Saved once.
 *  2. Outline: the kind's usual sections (the founders' own playbooks, plans and briefs), adjusted by the AI to the ask.
 *  3. Sections one at a time, each from the material most about it, as blocks (cards, tables, phone wireframes,
 *     filming tips, steps...). Saved after each one, so a stopped or failed run carries on from the next section.
 *  4. Drawn to PDF and Word (index.render), with a text copy in the Data tab.
 * Facts come only from the material; anything Euclidean adds beyond it is tagged PROPOSED. No em dashes. Public and
 * professional information only.
 */
const ctx = require('../core/ctx');
const ai = require('../integrations/ai');
const D = require('./index');

const BLOCKS = `Blocks (JSON objects, pick what fits; every field is plain text, **bold** allowed):
- {"type":"text","text":"paragraphs, blank line between"}
- {"type":"bullets","title":"optional","items":["..."],"numbered":false}
- {"type":"cards","title":"optional band label","cols":2,"items":[{"label":"PRIORITY 1","title":"short title","text":"1-3 sentences","tag":"PROPOSED if Euclidean added it"}]}
- {"type":"stats","items":[{"value":"$116M","label":"health budget managed"}]}  (2-4 numbers that are in the material)
- {"type":"table","title":"optional","columns":["A","B"],"rows":[["a1","b1"]]}
- {"type":"callout","title":"short","text":"...","tone":"info|warn|good"}
- {"type":"steps","title":"optional","items":[{"label":"YOU","title":"You film","text":"..."}]}  (a flow or a weekly routine, 3-5 steps)
- {"type":"phone","label":"FORMAT TAG","title":"1. Format name","layout":"talking|walk|stat|grid|pov|reply","labels":{"top":"on-screen hook text","middle":"a card or number on screen","side":"name tag"},"text":"how it works","beats":[{"time":"0-3s","text":"hook"}],"facts":{"Phone":"...","Who films":"...","Length":"30 to 45s"}}  (a 9:16 video format drawn as a phone wireframe)
- {"type":"tips","title":"optional","items":[{"icon":"eye|window|mic|propped|takes|silence|share|weekly|light|quiet|frame|edit|approve|idea","title":"short","text":"1-2 sentences"}]}  (a filming guide drawn with diagrams)
- {"type":"beats","items":[{"time":"0-3s","text":"..."}]}
- {"type":"quote","text":"...","by":"who, where"}
- {"type":"checklist","title":"optional","items":["..."]}
- {"type":"email","subject":"...","body":"..."}
- {"type":"sources","items":[{"text":"Outlet, title (date)","url":"https://..."}]}`;

/** The usual sections per kind of document (from the founders' own documents). */
const KINDS = {
  playbook: { look: 'designed', label: 'Social video playbook', sections: [
    { title: 'Video examples, hooks, and draft profiles', kicker: 'As promised', intent: 'A warm opening that recaps the meeting, then their priorities as cards (from the material), what is inside, and how to read PROPOSED tags.', use: 'text, cards, callout' },
    { title: 'What is working on video right now', kicker: 'Reference campaigns', intent: 'Two or three reference campaigns or creators that won online: what they did on video, as cards with the source under each. Then what we take for this person.', use: 'text, cards, sources' },
    { title: 'Formats you can film yourself', kicker: 'Video format wireframes', intent: 'Four to six self-filmed 9:16 formats, each as a phone wireframe with beat-by-beat pacing and who films it.', use: 'phone (one per format)' },
    { title: 'Openings for the first 1 to 3 seconds', kicker: 'Visual hooks', intent: 'Ten to twelve opening hooks, each with the line, how to film it and why it works, tied to their priorities.', use: 'cards (3 columns) or table' },
    { title: 'Your one-page filming kit', kicker: 'How to film it yourself', intent: 'Eight short filming tips with drawings (eye level, window light, quiet room and mic, propped phone, three takes, a second of silence, sharing files, a weekly session), then a before-you-record checklist. Must fit one page.', use: 'tips (8 items), checklist' },
    { title: 'Draft profiles', kicker: 'Mock social profiles', intent: 'Handle, bio (80 characters or less), link in bio, pinned posts, grid idea for TikTok, Instagram and X, all tagged PROPOSED.', use: 'cards or table' },
    { title: 'You film, we do everything else', kicker: 'How we work and next steps', intent: 'The weekly flow (we send, you film, you share, we edit, you approve), next steps to the free sample video, and what to do this week.', use: 'steps, checklist, callout' },
    { title: 'Where the claims come from', kicker: 'Sources', intent: 'Every source used, with links.', use: 'sources' },
  ] },
  plan: { look: 'designed', label: 'Platform and campaign plan', sections: [
    { title: 'Who they are', kicker: 'Who is', intent: 'A one-paragraph story of the person, 3-4 stat tiles from the material, then cards for their background (career, leadership, founder, credentials).', use: 'text, stats, cards' },
    { title: 'The base platform', kicker: 'The pillars', intent: 'Their platform pillars as cards, each in plain words that promise something, from their own documents; anything we sharpened is PROPOSED.', use: 'cards, callout' },
    { title: 'The contrast', kicker: 'Why this is the choice', intent: 'How they differ from the opponent or incumbent, issue by issue, every item sourced and tagged reported fact or claim.', use: 'table, callout' },
    { title: 'The campaign plan', kicker: 'Sequencing', intent: 'Phases and dates (pre-launch, launch, primary, general), what happens in each, as a table or steps.', use: 'steps, table' },
    { title: 'Video strategy and hooks', kicker: 'Video', intent: 'Formats, hooks and a posting rhythm built around the pillars.', use: 'cards, phone, table' },
    { title: 'Growth and measurement', kicker: 'Growth', intent: 'Audience goals, what we track each week and month, and the first 90 days.', use: 'stats, table, bullets' },
    { title: 'Sources', kicker: 'Sources', intent: 'Every source used.', use: 'sources' },
  ] },
  brief: { look: 'plain', label: 'Meeting brief', sections: [
    { title: 'Who they are', intent: 'A one-paragraph read of the person from their own materials, and the framing for the call.', use: 'text' },
    { title: 'Platform summary and video-ready themes', intent: 'Their platform condensed as a table (pillar, their plank), then the 3-5 strongest video themes.', use: 'table, bullets' },
    { title: 'The race', intent: 'The seat, the incumbent or opponents, key dates and fundraising scale, every line sourced.', use: 'bullets, table' },
    { title: 'Contrast', intent: 'Contrast items as a table: item, reported fact or claim, attack point, likely counterpoint. Only items in the material, each with its source.', use: 'table, callout' },
    { title: 'What to pitch and questions to ask', intent: 'What we offer them on this call and the questions to ask.', use: 'bullets, callout' },
    { title: 'Sources', intent: 'Every source used.', use: 'sources' },
  ] },
  proposal: { look: 'designed', label: 'Proposal', sections: [
    { title: 'What we heard', intent: 'Their goals in their own words, from the material.', use: 'text, cards' },
    { title: 'What we will make', intent: 'The videos and posting plan we propose.', use: 'cards, phone, table' },
    { title: 'How it works', intent: 'The weekly flow and what they do vs what we do.', use: 'steps, tips' },
    { title: 'Price and next steps', intent: 'The offer, the free sample, and the next step.', use: 'stats, callout, checklist' },
  ] },
  report: { look: 'plain', label: 'Report', sections: [] },
  custom: { look: 'designed', label: 'Document', sections: [] },
};
const kindOf = (k) => KINDS[String(k || '').toLowerCase()] ? String(k).toLowerCase() : /playbook|filming|social video/i.test(k || '') ? 'playbook' : /plan|platform/i.test(k || '') ? 'plan' : /brief|meeting|prep/i.test(k || '') ? 'brief' : /proposal|pitch|offer/i.test(k || '') ? 'proposal' : /report|summary|research/i.test(k || '') ? 'report' : 'custom';

const HOUSE = `House rules: write for the founders' clients and leads in plain, warm, confident English. No em dashes or en dashes. Facts, names, numbers, dates and quotes only from the MATERIAL; never invent them. If the material does not cover something, write it as a suggestion and tag it PROPOSED, or leave it out. Public, professional information only (no home addresses, family details or health details). Never mention Isaiah Martin. Euclidean Media: a short-form video agency (founders Ben Gingold and Ryan Rosario), A ZSPAN LLC company, zspannetwork.com.`;

// ------------------------------------------------------------------ material

async function gather(req, h) {
  const parts = [];
  if (req.material) parts.push(`GIVEN MATERIAL:\n${String(req.material).slice(0, 40000)}`);
  const data = require('../data');
  for (const id of req.datasetIds || []) { const ds = data.full(id); if (ds?.text) parts.push(`FROM THE DATA TAB: ${ds.name}\n${ds.text.slice(0, 30000)}`); }
  const about = [req.about, req.title].filter(Boolean).join(' ');
  if (about) {
    try { const list = data.search(about, { limit: 14 }).filter((x) => !/\(document\)$/.test(x.dataset || '')); if (list.length) { parts.push(`DATA TAB PASSAGES:\n${list.map((x) => `[${x.dataset || x.name || ''}] ${x.text || x.snippet || ''}`).join('\n\n').slice(0, 20000)}`); } } catch { /* none */ }
    try { const notes = require('../hal/memory').recall(about, { limit: 15 }); if (notes.length) parts.push(`NOTEBOOK (what Euclidean has learned):\n${notes.map((n) => `- ${String(n.at || n.createdAt || '').slice(0, 10)} ${n.text}${n.source ? ` (${n.source})` : ''}`).join('\n')}`); } catch { /* none */ }
  }
  const lead = req.prospectId ? ctx.store.get('prospects', req.prospectId) : null;
  if (lead) {
    const k = lead.kit?.card || {}; const r = lead.pkg?.research || lead.research || {};
    parts.push(`THE LEAD ON FILE: ${lead.name}${lead.office ? `, ${lead.office}` : ''}${lead.state ? ` (${lead.state})` : ''}. Stage: ${lead.stage || 'new'}.${lead.email ? ` Email: ${lead.email}.` : ''}${lead.phone ? ` Phone: ${lead.phone}.` : ''}\n${JSON.stringify({ card: k, research: r.summary || r.brief || r, grok: lead.grok ? { hook: lead.grok.hook, sources: lead.grok.sources, status: lead.grok.status } : undefined }).slice(0, 12000)}`);
  }
  const client = req.clientId ? ctx.store.get('clients', req.clientId) : null;
  if (client) parts.push(`THE CLIENT ON FILE: ${client.name}. ${JSON.stringify({ notes: client.notes, platforms: client.platforms, style: client.production?.videoStyle, retainer: client.retainer }).slice(0, 4000)}`);
  if (req.research) {
    h?.progress?.(0.06, 'Researching on the web');
    try {
      const ws = require('../integrations/websearch');
      const qs = Array.isArray(req.research) ? req.research : [typeof req.research === 'string' ? req.research : about];
      for (const q of qs.slice(0, 4)) { const r = await ws.research(q, { pages: 3, full: !!req.fullSearch }); parts.push(`WEB RESEARCH: ${q}\n${ws.formatResearch(r).slice(0, 12000)}`); }
    } catch (e) { parts.push(`(Web research failed: ${e.message})`); }
  }
  return parts.join('\n\n----\n\n');
}

/** The parts of the material most about one section (the local AI sees a short prompt). */
function materialFor(material, sec, cap) {
  if (material.length <= cap) return material;
  const ws = require('../integrations/websearch');
  const q = `${sec.title} ${sec.intent || ''}`;
  const picked = ws.passages(material, q, { max: Math.ceil(cap / 900), size: 900 }).map((p) => p.text);
  const head = material.slice(0, Math.min(2500, cap / 4));
  return `${head}\n...\n${picked.join('\n...\n')}`.slice(0, cap);
}

// ------------------------------------------------------------------ the job

/** Start writing a document (job docs.write). */
function start(req, by = 'user') {
  const kind = kindOf(req.kind || req.title);
  const d = D.create({ title: req.title || `${KINDS[kind].label}${req.about ? ` for ${req.about}` : ''}`, kind, look: req.look || KINDS[kind].look, about: req.about || '', prospectId: req.prospectId || null, clientId: req.clientId || null, by, status: 'writing', request: { ...req, kind } });
  const job = require('../jobs/queue').enqueue('docs.write', { id: d.id }, { actor: by, title: `Write: ${d.title}`.slice(0, 90), dedupeKey: `docs:${d.id}` });
  return D.update(d.id, { jobId: job.id });
}

/** Revise a finished document from a note ("make the filming guide one page with diagrams"). */
function revise(id, note, by = 'user') {
  const d = D.get(id); if (!d) throw new Error('That document is gone.');
  if (!String(note || '').trim()) throw new Error('Say what to change.');
  D.update(d.id, { status: 'writing', progress: 0, note: 'Reading your notes', revision: { note: String(note).slice(0, 3000), by, at: new Date().toISOString(), done: [] } });
  const job = require('../jobs/queue').enqueue('docs.revise', { id: d.id }, { actor: by, title: `Revise: ${d.title}`.slice(0, 90), dedupeKey: `docs:${d.id}` });
  return D.update(d.id, { jobId: job.id });
}

async function askJson(system, prompt, { maxTokens = 1800, jobId } = {}) {
  let lastErr;
  for (let i = 0; i < 2; i++) {
    try { const r = await ai.ask({ role: 'writing', json: true, system, prompt: i ? `${prompt}\n\nReturn ONLY valid JSON this time.` : prompt, maxTokens, jobId }); if (r.json) return r.json; } catch (e) { lastErr = e; if (e.notConnected) break; }
  }
  throw lastErr || new Error('The AI did not return the section.');
}

async function runWriteInner(job, h) {
  const d = D.get(job.payload.id); if (!d) throw Object.assign(new Error('That document was removed.'), { permanent: true });
  const req = d.request || {}; const kind = kindOf(req.kind); const K = KINDS[kind];
  let spec = D.specOf(d.id) || { title: d.title, look: d.look, sections: [], _draft: true };
  // 1. material (kept on disk with the spec, so a resumed run doesn't fetch it again)
  if (!spec._material) {
    D.update(d.id, { note: 'Gathering what we know' }); h.progress(0.03, 'Gathering what we know');
    spec._material = await gather(req, h); D.saveSpec(d.id, spec);
  }
  const local = ai.firstFor('writing') === 'ollama';
  const cap = local ? 9000 : 30000;
  // 2. outline
  if (!spec._outline) {
    D.update(d.id, { note: 'Planning the sections' }); h.progress(0.1, 'Planning the sections');
    const today = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
    let o = null;
    try {
      o = await askJson(`You plan documents for Euclidean Media. ${HOUSE}`, `Plan a ${K.label.toLowerCase()} titled "${d.title}"${d.about ? ` about ${d.about}` : ''}.
WHAT THE FOUNDERS ASKED: ${req.instructions || req.about || d.title}
${K.sections.length ? `USUAL SECTIONS (keep them unless the ask says otherwise; you may add, drop or rename):\n${K.sections.map((s, i) => `${i + 1}. ${s.title}: ${s.intent}`).join('\n')}` : 'Choose 4 to 8 sections that answer the ask.'}
MATERIAL (excerpt):\n${spec._material.slice(0, local ? 5000 : 14000)}

Return JSON: {"title":"document title","titleLines":["first line","second line in colour"],"subtitle":"one line","kicker":"EUCLIDEAN MEDIA / PREPARED FOR ...","chips":["3 to 6 short labels of what is inside"],"purpose":"e.g. Follow-up to our meeting","sections":[{"title":"...","kicker":"short label","intent":"what goes in it","use":"block types"}]}`, { maxTokens: 1400, jobId: job.id });
    } catch (e) { if (!K.sections.length) throw e; }
    const secs = Array.isArray(o?.sections) && o.sections.length ? o.sections : K.sections;
    spec = { ...spec, title: String(o?.title || d.title).slice(0, 160), titleLines: Array.isArray(o?.titleLines) ? o.titleLines.slice(0, 2) : undefined, subtitle: o?.subtitle || '', kicker: o?.kicker || (d.about ? `Euclidean Media / Prepared for ${d.about}` : 'Euclidean Media'), chips: Array.isArray(o?.chips) ? o.chips.slice(0, 6) : [], purpose: o?.purpose || req.purpose || '', date: req.date || today, preparedBy: req.preparedBy || 'Ben Gingold and Ryan Rosario, Co-founders', look: req.look || K.look,
      _outline: secs.slice(0, 14).map((s) => ({ title: String(s.title || '').slice(0, 200), kicker: String(s.kicker || '').slice(0, 80), intent: String(s.intent || '').slice(0, 600), use: String(s.use || '').slice(0, 200) })), sections: [] };
    D.saveSpec(d.id, spec); D.update(d.id, { title: spec.title });
  }
  // 3. sections, one at a time (saved after each)
  const out = spec._outline;
  for (let i = 0; i < out.length; i++) {
    if (spec.sections[i] && spec.sections[i].blocks?.length) continue;
    const sec = out[i];
    D.update(d.id, { note: `Writing ${i + 1} of ${out.length}: ${sec.title}`, progress: 0.12 + 0.75 * (i / out.length) }); h.progress(0.12 + 0.75 * (i / out.length), `Writing ${i + 1} of ${out.length}: ${sec.title}`);
    let j = null; let err = null;
    try {
      j = await askJson(`You write one section of a ${K.label.toLowerCase()} for Euclidean Media, as JSON blocks that get drawn into a designed PDF and Word file. ${HOUSE}\n\n${BLOCKS}`, `DOCUMENT: ${spec.title}${d.about ? ` (for ${d.about})` : ''}
WHAT THE FOUNDERS ASKED: ${req.instructions || req.about || spec.title}
ALL SECTIONS: ${out.map((s, k) => `${k + 1}. ${s.title}`).join(' | ')}
WRITE SECTION ${i + 1}: "${sec.title}"
WHAT GOES IN IT: ${sec.intent}${sec.use ? `\nBEST BLOCKS: ${sec.use}` : ''}
${kind === 'playbook' && /film/i.test(sec.title) ? 'This section must fit on ONE page: one tips block of 8 short items and one checklist.\n' : ''}
MATERIAL:\n${materialFor(spec._material, sec, cap)}

Return JSON: {"intro":"optional 1-3 sentences","blocks":[ ... ]}`, { maxTokens: local ? 1500 : 3000, jobId: job.id });
    } catch (e) { err = e; }
    const blocks = (Array.isArray(j?.blocks) ? j.blocks : []).map(D.cleanBlock).filter(Boolean);
    if (!blocks.length) {
      if (err?.notConnected) throw Object.assign(new Error('No AI is connected to write the document. Connect one in Settings → AI (the free Llama works), or give the bot the finished text.'), { permanent: true });
      blocks.push({ type: 'callout', tone: 'warn', title: 'Not written yet', text: `This section could not be written${err ? ` (${err.message.slice(0, 160)})` : ''}. Ask to revise it.` });
    }
    spec.sections[i] = { title: sec.title, kicker: sec.kicker, intro: j?.intro ? String(j.intro).slice(0, 2000) : '', blocks };
    D.saveSpec(d.id, spec);
  }
  // 4. draw it
  const finalSpec = D.cleanSpec(spec); finalSpec._material = spec._material; finalSpec._outline = spec._outline;
  D.saveSpec(d.id, finalSpec);
  h.progress(0.9, 'Drawing the PDF and Word file');
  const done = await D.render(d.id, h);
  return { id: d.id, title: done.title, pages: done.pages, files: done.files };
}

async function runReviseInner(job, h) {
  const d = D.get(job.payload.id); if (!d) throw Object.assign(new Error('That document was removed.'), { permanent: true });
  const rev = d.revision || {}; const note = rev.note || '';
  let spec = D.specOf(d.id); if (!spec) throw new Error('That document has nothing in it to revise.');
  const kind = kindOf(d.kind); const K = KINDS[kind];
  const local = ai.firstFor('writing') === 'ollama';
  if (!rev.plan) {
    D.saveSpec(d.id, spec, { version: true, note: `Before: ${note}` });
    h.progress(0.05, 'Reading your notes');
    const summary = (spec.sections || []).map((s, i) => `${i + 1}. ${s.title} [${(s.blocks || []).map((b) => b.type).join(', ')}]`).join('\n');
    let plan;
    try {
      plan = await askJson(`You revise Euclidean Media documents. ${HOUSE}`, `DOCUMENT: ${spec.title}\nSECTIONS NOW:\n${summary}\n\nTHE FOUNDERS' NOTE: ${note}\n\nWhich sections change? Return JSON: {"title":"new title or empty","subtitle":"new subtitle or empty","changes":[{"section":number (1-based) or 0 for a new one,"action":"rewrite|delete|add","after":number (for add),"title":"title","how":"what to change in it"}]}`, { maxTokens: 900, jobId: job.id });
    } catch (e) { plan = { changes: (spec.sections || []).map((s, i) => ({ section: i + 1, action: 'rewrite', how: note })) }; }
    rev.plan = plan; D.update(d.id, { revision: rev });
  }
  const plan = rev.plan || {};
  if (plan.title) spec.title = String(plan.title).slice(0, 160);
  if (plan.subtitle) spec.subtitle = String(plan.subtitle).slice(0, 300);
  const changes = (Array.isArray(plan.changes) ? plan.changes : []).slice(0, 14);
  const material = spec._material || '';
  const done = new Set(rev.done || []);
  // deletes and adds first (by title, so the numbers don't drift), then rewrites
  const byTitle = (t) => spec.sections.findIndex((s) => s.title === t);
  const targets = changes.map((c) => ({ ...c, ref: c.section > 0 ? spec.sections[c.section - 1]?.title : null }));
  for (const c of targets) if (c.action === 'delete' && c.ref && !done.has(`del:${c.ref}`)) { const k = byTitle(c.ref); if (k >= 0) spec.sections.splice(k, 1); done.add(`del:${c.ref}`); }
  for (const c of targets) if (c.action === 'add' && !done.has(`add:${c.title}`)) { const after = c.after > 0 ? Math.min(spec.sections.length, c.after) : spec.sections.length; spec.sections.splice(after, 0, { title: String(c.title || 'New section'), kicker: '', blocks: [], _how: c.how || note }); c.ref = c.title; c.action = 'rewrite'; done.add(`add:${c.title}`); }
  const todo = targets.filter((c) => c.action === 'rewrite' && c.ref);
  for (let n = 0; n < todo.length; n++) {
    const c = todo[n]; if (done.has(`rw:${c.ref}`)) continue;
    const k = byTitle(c.ref); if (k < 0) continue; const cur = spec.sections[k];
    h.progress(0.1 + 0.75 * (n / Math.max(1, todo.length)), `Revising: ${cur.title}`); D.update(d.id, { note: `Revising: ${cur.title}` });
    try {
      const j = await askJson(`You revise one section of a ${K.label.toLowerCase()} for Euclidean Media, as JSON blocks. ${HOUSE}\n\n${BLOCKS}`, `DOCUMENT: ${spec.title}\nSECTION NOW (JSON): ${JSON.stringify({ title: cur.title, intro: cur.intro, blocks: cur.blocks }).slice(0, local ? 6000 : 16000)}\n\nCHANGE: ${c.how || cur._how || note}\nTHE FOUNDERS' WHOLE NOTE: ${note}\n${/one page/i.test(note + (c.how || '')) ? 'It must fit on ONE page: keep it short, use tips (with drawings) and a checklist.\n' : ''}MATERIAL:\n${materialFor(material, { title: cur.title, intent: c.how || note }, local ? 6000 : 20000)}\n\nReturn JSON: {"title":"section title","intro":"optional","blocks":[...]} (the whole section, changed).`, { maxTokens: local ? 1500 : 3000, jobId: job.id });
      const blocks = (j.blocks || []).map(D.cleanBlock).filter(Boolean);
      if (blocks.length) spec.sections[k] = { title: String(j.title || cur.title).slice(0, 200), kicker: cur.kicker, intro: j.intro ? String(j.intro).slice(0, 2000) : '', blocks };
    } catch (e) { if (e.notConnected) throw Object.assign(new Error('No AI is connected to revise it. Connect one in Settings → AI.'), { permanent: true }); }
    done.add(`rw:${c.ref}`); rev.done = [...done]; D.update(d.id, { revision: rev }); D.saveSpec(d.id, spec);
  }
  const clean = D.cleanSpec(spec); clean._material = material; clean._outline = spec._outline; D.saveSpec(d.id, clean);
  D.update(d.id, { revision: null });
  h.progress(0.9, 'Drawing the PDF and Word file');
  const r = await D.render(d.id, h);
  return { id: d.id, title: r.title, pages: r.pages };
}

/** A failed run leaves the document marked failed with the reason (a retry or "Carry on" starts from the next section). */
const guarded = (fn) => async (job, h) => {
  D.update(job.payload.id, { status: 'writing', error: null });
  try { return await fn(job, h); } catch (e) { if (D.get(job.payload.id)) D.update(job.payload.id, { status: 'failed', error: e.message, note: e.message }); throw e; }
};
const runWrite = guarded(runWriteInner);
const runRevise = guarded(runReviseInner);
/** Carry on a stopped or failed document from where it got to. */
function resume(id, by = 'user') {
  const d = D.get(id); if (!d) throw new Error('That document is gone.');
  const type = d.revision ? 'docs.revise' : D.specOf(d.id)?._outline || d.request ? 'docs.write' : 'docs.render';
  const job = require('../jobs/queue').enqueue(type, { id: d.id }, { actor: by, title: `Carry on: ${d.title}`.slice(0, 90), dedupeKey: `docs:${d.id}` });
  return D.update(d.id, { status: d.status === 'ready' ? 'rendering' : 'writing', jobId: job.id, error: null });
}

module.exports = { resume, start, revise, runWrite, runRevise, KINDS, kindOf, gather, BLOCKS };
