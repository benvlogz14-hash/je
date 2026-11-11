/**
 * The Word (.docx) version of a Euclidean document, written in code (Office Open XML in a zip; no Word, no packages).
 * Same spec as render.js. Cards, stat tiles, steps, beats and callouts become shaded tables (they stay editable);
 * phone wireframes and filming drawings become pictures when the PC's Edge/Chrome drew them (`images`: a Map of
 * block key → PNG Buffer with its pixel size), else a short described box.
 */
const { zip } = require('../setup/claude-connect');

const x = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
const W = 12240; const MARGIN = 1080; const TEXT_W = W - MARGIN * 2; // twips
const FILL = { lav: 'EFEAFF', pink: 'FFE9F0', mint: 'E5F7EE', peach: 'FFF0E3', sky: 'E8F1FF', lemon: 'FFF7D9' };
const TONES = ['lav', 'pink', 'mint', 'peach', 'sky', 'lemon'];

function Doc() { this.rels = []; this.media = []; }
Doc.prototype.link = function link(url) { const id = `rIdL${this.rels.length + 1}`; this.rels.push({ id, url }); return id; };

/** Runs from inline text: **bold**, *italic*, [text](url), bare urls, PROPOSED. */
function runs(doc, s, base = {}) {
  const out = []; const t = String(s ?? '');
  const re = /\*\*([^*]+)\*\*|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|(https?:\/\/[^\s)]+[^\s).,;:])|\bPROPOSED\b|(?:^|(?<=[\s(]))\*([^*\s][^*]*)\*/g;
  let last = 0; let m;
  const run = (text, o = {}) => { if (!text) return; const p = { ...base, ...o }; const parts = String(text).split('\n'); parts.forEach((pt, i) => { if (i) out.push('<w:r><w:br/></w:r>'); if (pt) out.push(`<w:r>${rpr(p)}<w:t xml:space="preserve">${x(pt)}</w:t></w:r>`); }); };
  while ((m = re.exec(t))) {
    run(t.slice(last, m.index));
    if (m[1]) run(m[1], { b: true });
    else if (m[2] || m[4]) { const url = m[3] || m[4]; const id = doc.link(url); out.push(`<w:hyperlink r:id="${id}">${`<w:r>${rpr({ ...base, color: '3B4CD6', u: true })}<w:t xml:space="preserve">${x(m[2] || url.replace(/^https?:\/\/(www\.)?/, ''))}</w:t></w:r>`}</w:hyperlink>`); }
    else if (m[0] === 'PROPOSED') run(' PROPOSED ', { b: true, color: 'C2185B', size: 14, shade: 'FFE3EE' });
    else if (m[5]) run(m[5], { i: true });
    last = m.index + m[0].length;
  }
  run(t.slice(last));
  return out.join('');
}
function rpr(p = {}) {
  const r = [];
  if (p.font) r.push(`<w:rFonts w:ascii="${p.font}" w:hAnsi="${p.font}" w:cs="${p.font}"/>`);
  if (p.b) r.push('<w:b/>'); if (p.i) r.push('<w:i/>'); if (p.caps) r.push('<w:caps/>');
  if (p.color) r.push(`<w:color w:val="${p.color}"/>`);
  if (p.spacing) r.push(`<w:spacing w:val="${p.spacing}"/>`);
  if (p.size) r.push(`<w:sz w:val="${p.size}"/><w:szCs w:val="${p.size}"/>`);
  if (p.u) r.push('<w:u w:val="single"/>');
  if (p.shade) r.push(`<w:shd w:val="clear" w:color="auto" w:fill="${p.shade}"/>`);
  return r.length ? `<w:rPr>${r.join('')}</w:rPr>` : '';
}
function para(doc, text, { style, b, size, color, after = 100, before = 0, align, keep, font, caps, spacing, num, i } = {}) {
  const ppr = [];
  if (style) ppr.push(`<w:pStyle w:val="${style}"/>`);
  if (keep) ppr.push('<w:keepNext/>');
  if (num) ppr.push(`<w:numPr><w:ilvl w:val="0"/><w:numId w:val="${num}"/></w:numPr>`);
  ppr.push(`<w:spacing w:before="${before}" w:after="${after}"/>`);
  if (align) ppr.push(`<w:jc w:val="${align}"/>`);
  return `<w:p><w:pPr>${ppr.join('')}</w:pPr>${runs(doc, text, { b, size, color, font, caps, spacing, i })}</w:p>`;
}
const paras = (doc, s, o) => String(s ?? '').split(/\n{2,}/).map((p) => p.trim()).filter(Boolean).map((p) => para(doc, p, o)).join('') || para(doc, '', o);
const pageBreak = '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';

/** A table: cells are XML strings; widths in twips. */
function table(rows, { widths, fills = [], borders = 'none', header = false, leftBar = null, cellMargin = 120 } = {}) {
  const cols = widths.length;
  const b = borders === 'grid' ? '<w:tblBorders><w:top w:val="single" w:sz="4" w:color="E4DEF5"/><w:bottom w:val="single" w:sz="4" w:color="E4DEF5"/><w:insideH w:val="single" w:sz="4" w:color="E4DEF5"/></w:tblBorders>' : '<w:tblBorders><w:top w:val="nil"/><w:left w:val="nil"/><w:bottom w:val="nil"/><w:right w:val="nil"/><w:insideH w:val="nil"/><w:insideV w:val="nil"/></w:tblBorders>';
  const grid = `<w:tblGrid>${widths.map((w) => `<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid>`;
  const trs = rows.map((r, ri) => `<w:tr>${header && ri === 0 ? '<w:trPr><w:tblHeader/><w:cantSplit/></w:trPr>' : '<w:trPr><w:cantSplit/></w:trPr>'}${r.slice(0, cols).map((c, ci) => {
    const fill = (fills[ri] && fills[ri][ci]) || (header && ri === 0 ? 'F3EFFE' : null);
    const lb = leftBar ? `<w:tcBorders><w:left w:val="single" w:sz="24" w:color="${leftBar}"/></w:tcBorders>` : '';
    return `<w:tc><w:tcPr><w:tcW w:w="${widths[ci]}" w:type="dxa"/>${lb}${fill ? `<w:shd w:val="clear" w:color="auto" w:fill="${fill}"/>` : ''}<w:tcMar><w:top w:w="${cellMargin}" w:type="dxa"/><w:left w:w="${cellMargin}" w:type="dxa"/><w:bottom w:w="${cellMargin}" w:type="dxa"/><w:right w:w="${cellMargin}" w:type="dxa"/></w:tcMar></w:tcPr>${c || '<w:p/>'}</w:tc>`;
  }).join('')}</w:tr>`).join('');
  return `<w:tbl><w:tblPr><w:tblW w:w="${widths.reduce((a, c) => a + c, 0)}" w:type="dxa"/>${b}<w:tblLayout w:type="fixed"/><w:tblCellSpacing w:w="${borders === 'grid' ? 0 : 60}" w:type="dxa"/></w:tblPr>${grid}${trs}</w:tbl>${para({ link: () => '' }, '', { after: 80 })}`;
}
const split = (n, total = TEXT_W) => Array.from({ length: n }, () => Math.floor(total / n));

let picId = 0;
function picture(doc, png, { wPx, hPx, maxW = 2400 }) {
  const rid = `rIdM${doc.media.length + 1}`; const name = `image${doc.media.length + 1}.png`;
  doc.media.push({ rid, name, data: png });
  const emuPerTwip = 635; const wT = Math.min(maxW, wPx * 15 / 2); const hT = wT * (hPx / wPx); // 2x pictures at 96 dpi
  const cx = Math.round(wT * emuPerTwip); const cy = Math.round(hT * emuPerTwip); const id = ++picId;
  return `<w:p><w:pPr><w:spacing w:after="0"/></w:pPr><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${id}" name="Picture ${id}"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="${id}" name="${name}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
}

const H = 'Poppins'; // falls back to the document's heading font when not installed
function label(doc, s, color = '5D5878') { return para(doc, String(s || '').toUpperCase(), { b: true, size: 15, color, spacing: 20, after: 40 }); }

function block(doc, b, k, images, look) {
  const tone = (i) => FILL[TONES[(i + k) % TONES.length]];
  const items = Array.isArray(b.items) ? b.items : [];
  switch (b.type) {
    case 'text': return paras(doc, b.text);
    case 'bullets': return (b.title ? para(doc, b.title, { b: true, size: 21, keep: true, after: 60 }) : '') + items.map((it) => para(doc, typeof it === 'string' ? it : it.text || it.title || '', { num: b.numbered ? 2 : 1, after: 40 })).join('') + para(doc, '', { after: 40 });
    case 'checklist': return (b.title ? para(doc, b.title, { b: true, size: 21, keep: true, after: 60 }) : '') + para(doc, items.map((it) => `✓ ${typeof it === 'string' ? it : it.text || ''}`).join('     '), { size: 18 });
    case 'table': {
      const cols = b.columns || []; if (!cols.length) return '';
      const rows = (b.rows || []).map((r) => (Array.isArray(r) ? r : cols.map((c) => r?.[c] ?? '')));
      return (b.title ? para(doc, b.title, { b: true, size: 21, keep: true, after: 60 }) : '') + table([cols.map((c) => para(doc, c, { b: true, size: 17, after: 0 })), ...rows.map((r) => cols.map((c, i) => para(doc, r[i] ?? '', { size: b.compact ? 16 : 18, after: 0 })))], { widths: split(cols.length), borders: 'grid', header: true, cellMargin: 70 });
    }
    case 'cards': case 'steps': case 'stats': {
      if (!items.length) return '';
      const cols = b.type === 'stats' || b.type === 'steps' ? Math.min(items.length, 5) : Math.max(1, Math.min(3, b.cols || 2));
      const cells = items.map((c, i) => {
        if (b.type === 'stats') return para(doc, c.value, { b: true, size: 36, align: 'center', after: 20, font: H }) + para(doc, String(c.label || '').toUpperCase(), { size: 14, color: '5D5878', align: 'center', b: true, after: 0 });
        return (c.label || (b.type === 'steps' ? `Step ${i + 1}` : '') ? label(doc, c.label || `Step ${i + 1}`) : '') + (c.title ? para(doc, `${c.title}${c.tag ? ` ${c.tag}` : ''}`, { b: true, size: 22, after: 50, font: H }) : '') + (c.text ? paras(doc, c.text, { size: 18, after: 40 }) : '') + (Array.isArray(c.items) ? c.items.map((it) => para(doc, it, { num: 1, size: 18, after: 20 })).join('') : '');
      });
      const rows = []; const fills = [];
      for (let i = 0; i < cells.length; i += cols) { const r = cells.slice(i, i + cols); const f = r.map((_, j) => (items[i + j]?.tone && FILL[items[i + j].tone]) || tone(i + j)); while (r.length < cols) { r.push(''); f.push(null); } rows.push(r); fills.push(f); }
      return (b.title ? label(doc, b.title, '3D2F8F') : '') + table(rows, { widths: split(cols), fills });
    }
    case 'callout': return table([[(b.title ? para(doc, b.title, { b: true, size: 20, after: 40, font: H }) : '') + paras(doc, b.text, { size: 19, after: 40 })]], { widths: [TEXT_W], fills: [[b.tone === 'warn' ? FILL.peach : b.tone === 'good' ? FILL.mint : b.tone === 'pink' ? FILL.pink : FILL.sky]], leftBar: b.tone === 'warn' ? 'F08A3C' : b.tone === 'good' ? '2FA36B' : '7A4DFF' });
    case 'beats': return (b.title ? para(doc, b.title, { b: true, size: 21, keep: true, after: 60 }) : '') + table([items.map((s) => para(doc, s.time || '', { b: true, size: 17, after: 20, font: H }) + para(doc, s.text || '', { size: 16, after: 0 }))], { widths: split(Math.max(1, items.length)), fills: [items.map((_, i) => tone(i))], cellMargin: 80 });
    case 'phone': {
      const img = images?.get(b._key);
      const left = img ? picture(doc, img.png, { wPx: img.w, hPx: img.h, maxW: 2160 }) : para(doc, `[Phone layout: ${[b.labels?.top, b.labels?.middle, b.labels?.side, b.labels?.bottom].filter(Boolean).join(' / ') || b.layout || 'talking'}]`, { size: 16, color: '5D5878' });
      const right = (b.label ? label(doc, b.label) : '') + (b.title ? para(doc, b.title, { b: true, size: 26, after: 60, font: H }) : '') + paras(doc, b.text || '', { size: 19 })
        + (Array.isArray(b.beats) && b.beats.length ? b.beats.map((s) => para(doc, `**${s.time || ''}** ${s.text || ''}`, { size: 17, after: 20 })).join('') : '')
        + (b.facts ? Object.entries(b.facts).map(([kk, v]) => para(doc, `**${String(kk).toUpperCase()}** ${v}`, { size: 17, after: 20 })).join('') : '');
      return table([[left, right]], { widths: [2400, TEXT_W - 2400], fills: [[tone(0), tone(0)]] });
    }
    case 'tips': {
      const cells = items.map((s, i) => { const img = images?.get(`${b._key}:${i}`); return table([[img ? picture(doc, img.png, { wPx: img.w, hPx: img.h, maxW: 1500 }) : '', para(doc, `${i + 1}. ${s.title || ''}`, { b: true, size: 20, after: 40, font: H }) + paras(doc, s.text || '', { size: 17, after: 30 })]], { widths: [1600, TEXT_W / 2 - 1800], cellMargin: 40 }); });
      const rows = []; const fills = [];
      for (let i = 0; i < cells.length; i += 2) { rows.push([cells[i], cells[i + 1] || '']); fills.push([tone(i), cells[i + 1] ? tone(i + 1) : null]); }
      return (b.title ? label(doc, b.title, '3D2F8F') : '') + table(rows, { widths: split(2), fills, cellMargin: 60 });
    }
    case 'quote': return table([[paras(doc, b.text, { size: 22, i: true, after: 40 }) + (b.by ? para(doc, b.by, { size: 17, color: '5D5878', after: 0 }) : '')]], { widths: [TEXT_W], fills: [[FILL.lav]] });
    case 'email': return mail(doc, b);
    case 'person': return person(doc, b, b.n);
    case 'people': return items.map((p, i) => person(doc, p, p.n ?? i + 1)).join('');
    case 'sources': return items.map((s) => para(doc, typeof s === 'string' ? s : `${s.text || s.title || ''}${s.url ? ` ${s.url}` : ''}`, { num: 2, size: 17, after: 30 })).join('');
    case 'pagebreak': return pageBreak;
    default: return b.text ? paras(doc, b.text) : '';
  }
}
function mail(doc, e) {
  return table([[(e.subject ? para(doc, `Subject: ${e.subject}`, { b: true, size: 18, after: 80 }) : '') + paras(doc, e.body || '', { size: 18, after: 80, font: 'Consolas' })]], { widths: [TEXT_W], fills: [['F6F8FC']], leftBar: '9FB3DC' });
}
function person(doc, p, n) {
  const head = `${n != null ? `${n}. ` : ''}${p.name || ''}${p.seat ? ` (${p.seat})` : ''}${p.status ? ` ${String(p.status).toUpperCase()}` : ''}${p.tier ? ` [Tier ${p.tier}]` : ''}`;
  let out = para(doc, head, { style: 'Heading2', keep: true, after: 80, before: 200 });
  for (const [k, v] of [['Result', p.result], ['Why', p.why], ['Phones', p.phones], ['Email', p.email], ['Verified hook', p.hook], ['Fact source', p.source], ['Notes', p.notes], ['Next step', p.next]]) if (String(v ?? '').trim()) out += para(doc, `**${k}:** ${v}`, { num: 1, size: 19, after: 30 });
  if (p.emailDraft) { out += para(doc, 'Email', { b: true, size: 21, keep: true, before: 100, after: 50 }); out += mail(doc, typeof p.emailDraft === 'string' ? { body: p.emailDraft } : p.emailDraft); }
  if (p.script) out += para(doc, 'Call script', { b: true, size: 21, keep: true, after: 50 }) + paras(doc, p.script, { size: 19 });
  if (p.voicemail) out += para(doc, 'Voicemail', { b: true, size: 21, keep: true, after: 50 }) + paras(doc, p.voicemail, { size: 19 });
  if (p.videoPrompt) out += para(doc, 'Video prompt (real footage only; no generated face or voice)', { b: true, size: 21, keep: true, after: 50 }) + paras(doc, p.videoPrompt, { size: 19 });
  return out;
}

function body(doc, spec, images) {
  const s = spec || {}; const look = s.look === 'plain' ? 'plain' : 'designed';
  let out = '';
  if (look === 'designed') {
    out += para(doc, '', { after: 1400 });
    if (s.kicker) out += para(doc, String(s.kicker).toUpperCase(), { b: true, size: 17, color: '5D5878', spacing: 30, after: 240 });
    const lines = Array.isArray(s.titleLines) && s.titleLines.length ? s.titleLines : [s.title || 'Document'];
    out += para(doc, lines[0], { style: 'Title', after: 0 }) + (lines[1] ? para(doc, lines[1], { style: 'Title', color: '7A4DFF', after: 160 }) : '');
    if (s.subtitle) out += para(doc, s.subtitle, { b: true, size: 30, color: '3D2F8F', font: H, after: 240 });
    if ((s.chips || []).length) out += para(doc, s.chips.join('   ·   '), { size: 17, color: '5D5878', after: 1600 });
    out += table([[para(doc, s.preparedByLabel || 'PREPARED BY EUCLIDEAN MEDIA', { b: true, size: 19, color: 'FFFFFF', after: 40 }) + para(doc, s.company || 'A ZSPAN LLC company | zspannetwork.com', { size: 17, color: 'FFFFFF', after: 20 }) + para(doc, s.preparedBy || 'Ben Gingold and Ryan Rosario, Co-founders', { size: 17, color: 'FFFFFF', after: 0 }),
      (s.purpose ? para(doc, s.purpose, { size: 17, color: 'FFFFFF', align: 'right', after: 20 }) : '') + para(doc, s.date || '', { b: true, size: 18, color: 'FFFFFF', align: 'right', after: 20 }) + para(doc, s.note || 'Confidential draft', { size: 17, color: 'FFFFFF', align: 'right', after: 0 })]], { widths: split(2), fills: [['2A1D5C', '2A1D5C']] });
    out += pageBreak;
  } else {
    out += para(doc, s.title || 'Document', { style: 'Title', color: '1F3F8F' });
    if (s.subtitle) out += paras(doc, s.subtitle, { size: 19, color: '5D5878' });
    if (s.date || s.note) out += para(doc, [s.date, s.note].filter(Boolean).join(' · '), { size: 18, color: '5D5878', after: 200 });
  }
  let n = 0;
  (s.sections || []).forEach((sec, i) => {
    if (!sec) return;
    if (look === 'designed' && i > 0 && sec.newPage !== false) out += pageBreak;
    const num = sec.number != null ? sec.number : look === 'designed' && sec.numbered !== false ? String(n++).padStart(2, '0') : '';
    if (sec.kicker) out += para(doc, String(sec.kicker).toUpperCase(), { b: true, size: 15, color: '5D5878', spacing: 30, after: 20, keep: true });
    if (sec.title) out += para(doc, `${num !== '' ? `${num}   ` : ''}${sec.title}`, { style: 'Heading1', keep: true });
    if (sec.intro) out += paras(doc, sec.intro);
    (sec.blocks || []).forEach((b, k) => { if (b && typeof b === 'object') out += block(doc, b, i + k, images, look); });
  });
  return out;
}

const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';

function styles(look) {
  const head = look === 'plain' ? 'Segoe UI' : 'Poppins';
  const color = look === 'plain' ? '1F3F8F' : '1D1638';
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles ${NS}>
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Segoe UI" w:hAnsi="Segoe UI" w:cs="Segoe UI" w:eastAsia="Segoe UI"/><w:color w:val="1D1638"/><w:sz w:val="20"/><w:szCs w:val="20"/><w:lang w:val="en-US"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="100" w:line="264" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="120" w:line="240" w:lineRule="auto"/></w:pPr><w:rPr><w:rFonts w:ascii="${head}" w:hAnsi="${head}" w:cs="${head}"/><w:b/><w:color w:val="${color}"/><w:sz w:val="${look === 'plain' ? 44 : 76}"/><w:szCs w:val="${look === 'plain' ? 44 : 76}"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="${look === 'plain' ? 240 : 0}" w:after="160"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:rFonts w:ascii="${head}" w:hAnsi="${head}" w:cs="${head}"/><w:b/><w:color w:val="${color}"/><w:sz w:val="${look === 'plain' ? 30 : 38}"/><w:szCs w:val="${look === 'plain' ? 30 : 38}"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:shd w:val="clear" w:color="auto" w:fill="${look === 'plain' ? 'EEF3FB' : 'F3EFFE'}"/><w:spacing w:before="200" w:after="80"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:rFonts w:ascii="${head}" w:hAnsi="${head}" w:cs="${head}"/><w:b/><w:color w:val="${color}"/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr></w:style>
<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:rPr><w:color w:val="3B4CD6"/><w:u w:val="single"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Footer"><w:name w:val="footer"/><w:basedOn w:val="Normal"/><w:rPr><w:color w:val="8A85A3"/><w:sz w:val="16"/></w:rPr></w:style>
</w:styles>`;
}
const NUMBERING = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering ${NS}>
<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="singleLevel"/><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="360" w:hanging="260"/></w:pPr></w:lvl></w:abstractNum>
<w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="singleLevel"/><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="360" w:hanging="300"/></w:pPr></w:lvl></w:abstractNum>
<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num></w:numbering>`;

/** The .docx file as a Buffer. */
function toDocx(spec, { images = new Map() } = {}) {
  const doc = new Doc(); picId = 0;
  const look = spec?.look === 'plain' ? 'plain' : 'designed';
  const main = body(doc, spec, images);
  const foot = x(spec?.footer || `${spec?.brand || 'Euclidean Media'} | ${spec?.title || 'Document'}`);
  const sect = `<w:sectPr><w:footerReference w:type="default" r:id="rIdF1"/>${look === 'designed' ? '<w:titlePg/>' : ''}<w:pgSz w:w="${W}" w:h="15840"/><w:pgMar w:top="1000" w:right="${MARGIN}" w:bottom="1000" w:left="${MARGIN}" w:header="500" w:footer="500" w:gutter="0"/></w:sectPr>`;
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${NS}><w:body>${main}${sect}</w:body></w:document>`;
  const footer = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:ftr ${NS}><w:p><w:pPr><w:pStyle w:val="Footer"/><w:tabs><w:tab w:val="right" w:pos="${TEXT_W}"/></w:tabs></w:pPr><w:r><w:t xml:space="preserve">${foot}</w:t></w:r><w:r><w:tab/></w:r><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>1</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p></w:ftr>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rIdS" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
<Relationship Id="rIdN" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>
<Relationship Id="rIdF1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>
${doc.rels.map((r) => `<Relationship Id="${r.id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${x(r.url)}" TargetMode="External"/>`).join('\n')}
${doc.media.map((m) => `<Relationship Id="${m.rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${m.name}"/>`).join('\n')}
</Relationships>`;
  const types = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/><Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`;
  const root = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`;
  const core = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${x(spec?.title || 'Document')}</dc:title><dc:creator>Euclidean Media</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}</dcterms:created></cp:coreProperties>`;
  return zip([
    { name: '[Content_Types].xml', data: types }, { name: '_rels/.rels', data: root }, { name: 'docProps/core.xml', data: core },
    { name: 'word/document.xml', data: document }, { name: 'word/styles.xml', data: styles(look) }, { name: 'word/numbering.xml', data: NUMBERING },
    { name: 'word/footer1.xml', data: footer }, { name: 'word/_rels/document.xml.rels', data: rels },
    ...doc.media.map((m) => ({ name: `word/media/${m.name}`, data: m.data })),
  ]);
}

module.exports = { toDocx };
