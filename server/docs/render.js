/**
 * Euclidean documents: one plain description of a document (a "spec") drawn as a printable page (HTML → PDF through
 * the PC's Edge/Chrome) and as a Word file (docx.js). Two looks:
 *  - designed: the client look (pastel cover with mountains, numbered sections that each start a page, cards, stat
 *    tiles, phone wireframes, filming diagrams, beat bars, a "you film, we do the rest" flow), like the playbooks,
 *    platform plans and meeting briefs the founders send.
 *  - plain: the working-list look (winners lists, call sheets, contact books): a summary table, then one block per
 *    person with phones, email, hook and its source, the drafts.
 *
 * Spec: { title, subtitle, kicker, preparedFor, preparedBy, date, note, chips: [], look: 'designed'|'plain',
 *         sections: [{ title, kicker, newPage, blocks: [...] }] }
 * Blocks (all fields optional except type): text {text} · bullets {items, numbered} · table {columns, rows} ·
 * cards {items: [{label, title, text, tag}], cols} · stats {items: [{value, label}]} · callout {title, text, tone} ·
 * steps {items: [{label, title, text}]} · beats {title, items: [{time, text}]} · phone {title, layout, labels, text} ·
 * tips {items: [{icon, title, text}]} · quote {text, by} · email {subject, body} · person {...} · sources {items} ·
 * checklist {items} · pagebreak.
 * Everything is escaped; text takes **bold**, *italic*, [links](https://...) and bare links.
 */
const fs = require('fs');
const path = require('path');

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** **bold**, *italic*, [text](url), bare urls and PROPOSED tags. */
function inline(s) {
  let t = esc(s);
  t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (m, a, u) => `<a href="${u}">${a}</a>`);
  t = t.replace(/(^|[\s(])(https?:\/\/[^\s<)]+[^\s<).,;:])/g, (m, pre, u) => `${pre}<a href="${u}">${u.replace(/^https?:\/\/(www\.)?/, '')}</a>`);
  t = t.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, '$1<i>$2</i>');
  t = t.replace(/\bPROPOSED\b/g, '<span class="tag-proposed">PROPOSED</span>');
  return t;
}
const paras = (s) => String(s ?? '').split(/\n{2,}/).map((p) => p.trim()).filter(Boolean).map((p) => `<p>${inline(p).replace(/\n/g, '<br>')}</p>`).join('');

const TONES = ['lav', 'pink', 'mint', 'peach', 'sky', 'lemon'];

// ------------------------------------------------------------------ drawings (all drawn in code)

/** A phone wireframe: where the person, the hook text, the captions and the buttons sit in a 9:16 video. */
function phoneSvg({ layout = 'talking', labels = {} } = {}) {
  const L = { top: labels.top || 'Hook text', middle: labels.middle || '', bottom: labels.bottom || 'Captions on screen', side: labels.side || '', badge: labels.badge || '' };
  const person = (cx, cy, r = 26, tag = '') => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="#d9ccff" stroke="#7a4dff" stroke-width="2"/><path d="M${cx - r * 1.7} ${cy + r * 3.4} Q${cx} ${cy + r * 0.9} ${cx + r * 1.7} ${cy + r * 3.4} Z" fill="#d9ccff" stroke="#7a4dff" stroke-width="2"/>${tag ? `<rect x="${cx - 52}" y="${cy + r * 3.5}" width="104" height="18" rx="4" fill="#fff" stroke="#7a4dff" stroke-width="1.2"/><text x="${cx}" y="${cy + r * 3.5 + 12.5}" class="w-s" text-anchor="middle">${esc(tag)}</text>` : ''}`;
  const box = (x, y, w, h, fill, stroke, txt, cls = 'w-s') => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="7" fill="${fill}" stroke="${stroke}" stroke-width="1.4" stroke-dasharray="${fill === 'none' ? '4 3' : ''}"/>${txt ? `<foreignObject x="${x + 4}" y="${y + 2}" width="${w - 8}" height="${h - 4}"><div xmlns="http://www.w3.org/1999/xhtml" class="w-fo ${cls}">${esc(txt)}</div></foreignObject>` : ''}`;
  let inner = '';
  if (layout === 'stat' || layout === 'screen') inner = box(30, 70, 140, 96, '#ffe0e6', '#e8456b', L.middle || '$26B', 'w-big') + person(100, 222, 20, L.side || '');
  else if (layout === 'walk') inner = `<path d="M40 330 L85 230 M160 330 L115 230" stroke="#c9c2e6" stroke-width="2" stroke-dasharray="5 4"/>` + person(100, 180, 22, L.side || '') + (L.middle ? box(112, 120, 70, 40, '#e3f6ec', '#2fa36b', L.middle) : '');
  else if (layout === 'grid' || layout === 'duet') inner = box(26, 74, 70, 92, '#efeaff', '#7a4dff', 'Supporter clip 1') + box(104, 74, 70, 92, '#e3f6ec', '#2fa36b', 'Supporter clip 2') + box(26, 174, 148, 70, '#fff6d6', '#d9a400', L.middle || 'First name, town');
  else if (layout === 'pov') inner = box(28, 74, 144, 60, '#ffeedd', '#f08a3c', L.middle || 'Clip 1: morning coffee') + box(28, 140, 70, 60, '#e5f0ff', '#3c7bf0', 'Clip 2') + box(102, 140, 70, 60, '#e3f6ec', '#2fa36b', 'Clip 3') + box(28, 206, 144, 40, '#efeaff', '#7a4dff', 'Time stamp + place');
  else if (layout === 'reply') inner = box(28, 66, 120, 46, '#fff', '#7a4dff', L.middle || 'Comment bubble') + person(100, 170, 22, L.side || '');
  else inner = person(100, 158, 26, L.side || '') + (L.middle ? box(128, 98, 58, 44, '#e3f6ec', '#2fa36b', L.middle) : '');
  return `<svg class="phone" viewBox="0 0 200 380" xmlns="http://www.w3.org/2000/svg">
  <rect x="4" y="4" width="192" height="372" rx="26" fill="#fff" stroke="#1d1638" stroke-width="5"/>
  <rect x="78" y="12" width="44" height="7" rx="3.5" fill="#1d1638"/>
  ${L.top ? box(24, 30, 152, 30, '#fff6d6', '#d9a400', L.top) : ''}
  ${inner}
  ${box(24, 286, 152, 28, '#1d1638', '#1d1638', L.bottom, 'w-cap')}
  <rect x="24" y="${322}" width="152" height="22" rx="11" fill="#e3f6ec" stroke="#2fa36b" stroke-width="1.2"/>
  <foreignObject x="26" y="324" width="148" height="20"><div xmlns="http://www.w3.org/1999/xhtml" class="w-fo w-s" style="color:#1d6b45">${esc(L.badge || 'Setup: propped phone, eye level')}</div></foreignObject>
  <rect x="180" y="150" width="10" height="70" rx="5" fill="none" stroke="#c9c2e6" stroke-dasharray="3 3"/>
</svg>`;
}

const TONE_HEX = ['#d9ccff', '#ffc9d8', '#bfe9d2', '#ffd9b8', '#c6dcff', '#ffeaa0'];
/** Small filming-guide drawings, keyed by what the tip is about. */
const ICONS = {
  eye: `<rect x="70" y="18" width="34" height="58" rx="6" fill="#fff" stroke="#1d1638" stroke-width="2.5"/><line x1="87" y1="76" x2="87" y2="96" stroke="#1d1638" stroke-width="3"/><path d="M70 96 L104 96" stroke="#1d1638" stroke-width="3"/><path d="M8 46 Q26 32 44 46 Q26 60 8 46 Z" fill="#efeaff" stroke="#7a4dff" stroke-width="2"/><circle cx="26" cy="46" r="5" fill="#7a4dff"/><line x1="46" y1="46" x2="68" y2="46" stroke="#7a4dff" stroke-width="2" stroke-dasharray="4 3"/><text x="20" y="80" class="w-t">eye level</text>`,
  window: `<rect x="8" y="12" width="54" height="66" rx="3" fill="#e5f0ff" stroke="#3c7bf0" stroke-width="2.5"/><line x1="35" y1="12" x2="35" y2="78" stroke="#3c7bf0" stroke-width="2"/><line x1="8" y1="45" x2="62" y2="45" stroke="#3c7bf0" stroke-width="2"/><path d="M66 30 L88 38 M66 46 L90 46 M66 62 L88 54" stroke="#f5b800" stroke-width="2.5"/><circle cx="118" cy="38" r="12" fill="#d9ccff" stroke="#7a4dff" stroke-width="2"/><path d="M98 86 Q118 54 138 86 Z" fill="#d9ccff" stroke="#7a4dff" stroke-width="2"/>`,
  mic: `<circle cx="40" cy="30" r="13" fill="#d9ccff" stroke="#7a4dff" stroke-width="2"/><path d="M18 90 Q40 46 62 90 Z" fill="#d9ccff" stroke="#7a4dff" stroke-width="2"/><rect x="45" y="56" width="8" height="12" rx="3" fill="#1d1638"/><path d="M49 68 Q70 92 100 70 L112 74" stroke="#1d1638" stroke-width="2" fill="none"/><rect x="112" y="64" width="22" height="30" rx="4" fill="#fff" stroke="#1d1638" stroke-width="2"/>`,
  propped: `<rect x="20" y="70" width="96" height="10" fill="#f08a3c"/><rect x="26" y="58" width="84" height="12" fill="#3c7bf0"/><rect x="22" y="46" width="90" height="12" fill="#2fa36b"/><rect x="48" y="4" width="28" height="42" rx="5" fill="#fff" stroke="#1d1638" stroke-width="2.5"/><text x="18" y="96" class="w-t">phone on a stack of books</text>`,
  takes: `${[0, 1, 2].map((i) => `<g transform="translate(${8 + i * 46} 26)"><rect width="38" height="30" rx="3" fill="#fff" stroke="#1d1638" stroke-width="2"/><path d="M0 0 L38 0 L38 9 L0 9 Z" fill="#1d1638"/><path d="M6 0 L11 9 M16 0 L21 9 M26 0 L31 9" stroke="#fff" stroke-width="2"/><text x="11" y="25" class="w-t">#${i + 1}</text></g>`).join('')}<text x="10" y="80" class="w-t">three takes, keep the best</text>`,
  silence: `<path d="M6 46 L22 46 ${Array.from({ length: 16 }, (_, i) => `L${26 + i * 4} ${46 + (i % 2 ? -1 : 1) * (6 + ((i * 7) % 14))}`).join(' ')} L94 46 L134 46" fill="none" stroke="#7a4dff" stroke-width="2.2"/><rect x="2" y="30" width="22" height="32" rx="4" fill="#fff6d6" opacity=".8"/><rect x="96" y="30" width="38" height="32" rx="4" fill="#fff6d6" opacity=".8"/><text x="8" y="84" class="w-t">a second of quiet, start and end</text>`,
  share: `<rect x="6" y="20" width="28" height="48" rx="5" fill="#fff" stroke="#1d1638" stroke-width="2.5"/><path d="M40 44 L60 44" stroke="#7a4dff" stroke-width="2.5" marker-end="url(#ar)"/><path d="M66 50 Q66 30 84 32 Q92 18 106 28 Q122 26 122 42 Q130 50 120 56 L70 56 Q62 56 66 50 Z" fill="#e5f0ff" stroke="#3c7bf0" stroke-width="2"/><text x="10" y="86" class="w-t">phone to the shared folder</text>`,
  weekly: `<circle cx="40" cy="46" r="32" fill="#fff6d6" stroke="#d9a400" stroke-width="2.5"/><path d="M40 46 L40 22 A24 24 0 0 1 61 58 Z" fill="#f5b800"/><rect x="84" y="20" width="44" height="52" rx="4" fill="#fff" stroke="#1d1638" stroke-width="2"/>${[0, 1, 2].map((r) => [0, 1, 2].map((c) => `<rect x="${89 + c * 13}" y="${34 + r * 12}" width="9" height="8" fill="${r === 1 && c === 1 ? '#7a4dff' : '#efeaff'}"/>`).join('')).join('')}<text x="8" y="94" class="w-t">30 minutes, once a week</text>`,
  light: `<circle cx="70" cy="34" r="16" fill="#fff6d6" stroke="#d9a400" stroke-width="2.5"/><path d="M70 6 L70 12 M44 34 L50 34 M90 34 L96 34 M51 15 L55 19 M89 15 L85 19" stroke="#d9a400" stroke-width="2.5"/><path d="M58 52 L82 52 L76 76 L64 76 Z" fill="#fff" stroke="#1d1638" stroke-width="2"/>`,
  quiet: `<rect x="20" y="10" width="50" height="76" rx="3" fill="#ffeedd" stroke="#f08a3c" stroke-width="2.5"/><circle cx="60" cy="50" r="3.5" fill="#1d1638"/><path d="M92 30 L110 30 L122 18 L122 76 L110 64 L92 64 Z" fill="#fff" stroke="#1d1638" stroke-width="2"/><line x1="88" y1="20" x2="128" y2="74" stroke="#e8456b" stroke-width="3"/>`,
  frame: `<rect x="20" y="8" width="56" height="84" rx="6" fill="#fff" stroke="#1d1638" stroke-width="2.5"/><line x1="38.6" y1="8" x2="38.6" y2="92" stroke="#c9c2e6"/><line x1="57.3" y1="8" x2="57.3" y2="92" stroke="#c9c2e6"/><line x1="20" y1="36" x2="76" y2="36" stroke="#c9c2e6"/><line x1="20" y1="64" x2="76" y2="64" stroke="#c9c2e6"/><circle cx="48" cy="40" r="9" fill="#d9ccff" stroke="#7a4dff" stroke-width="2"/><text x="84" y="50" class="w-t">eyes on the</text><text x="84" y="62" class="w-t">top third</text>`,
  edit: `<rect x="6" y="16" width="128" height="58" rx="6" fill="#fff" stroke="#1d1638" stroke-width="2"/>${[0, 1, 2, 3].map((i) => `<rect x="${12 + i * 30}" y="44" width="26" height="12" rx="2" fill="${TONE_HEX[i]}"/>`).join('')}<rect x="12" y="24" width="60" height="12" rx="2" fill="#efeaff"/><line x1="70" y1="20" x2="70" y2="70" stroke="#e8456b" stroke-width="2"/><text x="10" y="90" class="w-t">we cut, caption and post</text>`,
  idea: `<circle cx="70" cy="38" r="22" fill="#fff6d6" stroke="#d9a400" stroke-width="2.5"/><rect x="60" y="62" width="20" height="14" rx="3" fill="#fff" stroke="#1d1638" stroke-width="2"/><path d="M64 38 L70 46 L76 38" stroke="#d9a400" stroke-width="2.5" fill="none"/>`,
  approve: `<rect x="34" y="12" width="72" height="72" rx="10" fill="#e3f6ec" stroke="#2fa36b" stroke-width="2.5"/><path d="M50 50 L64 64 L92 32" stroke="#2fa36b" stroke-width="6" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`,
};
function iconFor(name, title = '') {
  const k = String(name || '').toLowerCase(); const t = `${k} ${String(title).toLowerCase()}`;
  const key = ICONS[k] ? k : /eye|level|tripod|height/.test(t) ? 'eye' : /window|daylight|natural light/.test(t) ? 'window' : /mic|audio|sound|clip-on/.test(t) ? 'mic'
    : /prop|books|shelf|stand/.test(t) ? 'propped' : /take|again|three/.test(t) ? 'takes' : /quiet|silence|pause/.test(t) ? (/room|door|noise/.test(t) ? 'quiet' : 'silence')
      : /share|upload|drive|folder|send/.test(t) ? 'share' : /week|schedule|minutes|calendar|session/.test(t) ? 'weekly' : /lamp|light/.test(t) ? 'light'
        : /frame|third|framing|head/.test(t) ? 'frame' : /edit|caption|post|cut/.test(t) ? 'edit' : /approve|sign|ok|yes/.test(t) ? 'approve' : 'idea';
  return `<svg class="tip-ico" viewBox="0 0 140 100" xmlns="http://www.w3.org/2000/svg"><defs><marker id="ar" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto"><path d="M0 0 L8 4 L0 8 Z" fill="#7a4dff"/></marker></defs>${ICONS[key]}</svg>`;
}

/** The cover's landscape: soft sky, a sun, layered mountains. */
const MOUNTAINS = `<svg class="cover-art" viewBox="0 0 800 330" preserveAspectRatio="xMidYMax slice" xmlns="http://www.w3.org/2000/svg">
  <circle cx="610" cy="120" r="62" fill="#ffe7a8"/>
  <path d="M0 250 L120 120 L190 190 L300 70 L420 210 L520 130 L640 230 L720 160 L800 210 L800 330 L0 330 Z" fill="#d6ccff"/>
  <path d="M300 70 L330 104 L312 98 L300 112 L286 96 L270 104 Z M120 120 L142 146 L126 140 L116 150 L104 138 Z" fill="#fff" opacity=".9"/>
  <path d="M0 270 L90 200 L180 250 L280 170 L380 250 L470 190 L580 260 L690 200 L800 250 L800 330 L0 330 Z" fill="#bfb2f5"/>
  <path d="M0 300 Q200 255 400 290 T800 280 L800 330 L0 330 Z" fill="#cfeedd"/>
</svg>`;

// ------------------------------------------------------------------ blocks

function person(p, i) {
  const v = (x) => (x == null ? '' : String(x));
  const rows = [
    ['Result', p.result], ['Why', p.why], ['Phones', p.phones], ['Email', p.email], ['Verified hook', p.hook], ['Fact source', p.source], ['Notes', p.notes], ['Next step', p.next],
  ].filter(([, x]) => v(x).trim());
  const head = `${i != null ? `${i}. ` : ''}${v(p.name)}${p.seat ? ` (${v(p.seat)})` : ''}${p.status ? ` ${v(p.status).toUpperCase()}` : ''}${p.tier ? ` [Tier ${v(p.tier)}]` : ''}`;
  const draft = p.emailDraft && (p.emailDraft.body || typeof p.emailDraft === 'string') ? emailBox(typeof p.emailDraft === 'string' ? { body: p.emailDraft } : p.emailDraft) : '';
  return `<div class="person">
    <h3>${inline(head)}</h3>
    ${rows.length ? `<ul class="facts">${rows.map(([k, x]) => `<li><b>${esc(k)}:</b> ${inline(x)}</li>`).join('')}</ul>` : ''}
    ${draft ? `<div class="sub-h">Email</div>${draft}` : ''}
    ${p.script ? `<div class="sub-h">Call script</div><div class="script">${paras(p.script)}</div>` : ''}
    ${p.voicemail ? `<div class="sub-h">Voicemail${/sec/.test(p.voicemailLabel || '') ? ` (${esc(p.voicemailLabel)})` : ''}</div><div class="script">${paras(p.voicemail)}</div>` : ''}
    ${p.videoPrompt ? `<div class="sub-h">Video prompt (real footage only; no generated face or voice)</div><div class="script">${paras(p.videoPrompt)}</div>` : ''}
  </div>`;
}
function emailBox(e) {
  return `<div class="mail">${e.subject ? `<div class="mail-subj">Subject: ${esc(e.subject)}</div>` : ''}${paras(e.body || '')}</div>`;
}

function block(b, look, k) {
  if (!b || typeof b !== 'object') return '';
  const tone = (i) => TONES[(i + k) % TONES.length];
  switch (b.type) {
    case 'text': return `<div class="txt">${paras(b.text)}</div>`;
    case 'bullets': { const tag = b.numbered ? 'ol' : 'ul'; return `${b.title ? `<div class="sub-h">${inline(b.title)}</div>` : ''}<${tag} class="list">${(b.items || []).map((x) => `<li>${inline(typeof x === 'string' ? x : x.text || x.title || '')}</li>`).join('')}</${tag}>`; }
    case 'checklist': return `${b.title ? `<div class="sub-h">${inline(b.title)}</div>` : ''}<div class="checks">${(b.items || []).map((x) => `<span class="check">${inline(typeof x === 'string' ? x : x.text || '')}</span>`).join('')}</div>`;
    case 'table': {
      const cols = b.columns || []; const rows = (b.rows || []).map((r) => (Array.isArray(r) ? r : cols.map((c) => r?.[c] ?? '')));
      return `${b.title ? `<div class="sub-h">${inline(b.title)}</div>` : ''}<table class="tbl${b.compact ? ' compact' : ''}"><thead><tr>${cols.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
    }
    case 'cards': {
      const cols = Math.max(1, Math.min(3, b.cols || ((b.items || []).length % 3 === 0 && (b.items || []).length > 3 ? 3 : 2)));
      return `${b.title ? `<div class="band">${inline(b.title)}</div>` : ''}<div class="cards c${cols}">${(b.items || []).map((c, i) => `<div class="card ${c.tone && TONES.includes(c.tone) ? c.tone : tone(i)}">${c.label ? `<div class="card-label">${inline(c.label)}</div>` : ''}${c.title ? `<div class="card-title">${inline(c.title)}${c.tag ? ` <span class="tag-proposed">${esc(c.tag)}</span>` : ''}</div>` : ''}${c.text ? `<div class="card-text">${paras(c.text)}</div>` : ''}${Array.isArray(c.items) ? `<ul class="list">${c.items.map((x) => `<li>${inline(x)}</li>`).join('')}</ul>` : ''}</div>`).join('')}</div>`;
    }
    case 'stats': return `<div class="stats">${(b.items || []).map((s, i) => `<div class="stat ${tone(i)}"><div class="stat-v">${inline(s.value)}</div><div class="stat-l">${inline(s.label)}</div></div>`).join('')}</div>`;
    case 'callout': return `<div class="callout ${b.tone === 'warn' ? 'peach' : b.tone === 'good' ? 'mint' : b.tone === 'pink' ? 'pink' : 'sky'}">${b.title ? `<div class="callout-t">${inline(b.title)}</div>` : ''}${paras(b.text)}</div>`;
    case 'steps': return `${b.title ? `<div class="band">${inline(b.title)}</div>` : ''}<div class="steps">${(b.items || []).map((s, i) => `<div class="step ${tone(i)}"><div class="step-n">${inline(s.label || `Step ${i + 1}`)}</div><div class="step-t">${inline(s.title || '')}</div><div class="step-x">${paras(s.text || '')}</div></div>`).join('')}</div>`;
    case 'beats': return `${b.title ? `<div class="sub-h">${inline(b.title)}</div>` : ''}<div class="beats">${(b.items || []).map((s, i) => `<div class="beat ${tone(i)}" style="flex:${Math.max(1, Math.min(4, String(s.text || '').length / 30))}"><b>${inline(s.time || '')}</b><span>${inline(s.text || '')}</span></div>`).join('')}</div>`;
    case 'phone': return `<div class="wire ${tone(0)}"><div class="wire-art">${phoneSvg(b)}</div><div class="wire-body">${b.label ? `<div class="card-label">${inline(b.label)}</div>` : ''}${b.title ? `<h3>${inline(b.title)}</h3>` : ''}${paras(b.text || '')}${b.beats ? block({ type: 'beats', items: b.beats }, look, k + 1) : ''}${b.facts ? `<div class="wire-facts">${Object.entries(b.facts).map(([kk, v]) => `<div><b>${esc(kk)}</b> ${inline(v)}</div>`).join('')}</div>` : ''}</div></div>`;
    case 'tips': return `${b.title ? `<div class="band">${inline(b.title)}</div>` : ''}<div class="tips">${(b.items || []).map((s, i) => `<div class="tip ${tone(i)}">${iconFor(s.icon, s.title)}<div><div class="tip-t"><span class="tip-n">${i + 1}</span>${inline(s.title || '')}</div><div class="tip-x">${paras(s.text || '')}</div></div></div>`).join('')}</div>`;
    case 'quote': return `<blockquote class="quote">${paras(b.text)}${b.by ? `<cite>${inline(b.by)}</cite>` : ''}</blockquote>`;
    case 'email': return emailBox(b);
    case 'person': return person(b, b.n);
    case 'people': return (b.items || []).map((p, i) => person(p, p.n ?? i + 1)).join('');
    case 'sources': return `<ol class="sources">${(b.items || []).map((s) => `<li>${typeof s === 'string' ? inline(s) : `${inline(s.text || s.title || '')}${s.url ? ` <a href="${esc(s.url)}">${esc(String(s.url).replace(/^https?:\/\/(www\.)?/, ''))}</a>` : ''}`}</li>`).join('')}</ol>`;
    case 'pagebreak': return '<div class="pb"></div>';
    default: return b.text ? `<div class="txt">${paras(b.text)}</div>` : '';
  }
}

// ------------------------------------------------------------------ the page

function fontFace(fontDir) {
  const f = (file, fam, w) => (fs.existsSync(path.join(fontDir, file)) ? `@font-face{font-family:'${fam}';src:url('${('file:///' + path.join(fontDir, file).replace(/\\/g, '/').replace(/^\/+/, ''))}');font-weight:${w};}` : '');
  return f('Poppins-ExtraBold.ttf', 'Poppins', 800) + f('Poppins-Black.ttf', 'Poppins', 900) + f('Inter-SemiBold.ttf', 'InterUI', 600) + f('Inter-ExtraBold.ttf', 'InterUI', 800);
}

const CSS = `
:root{--ink:#1d1638;--muted:#5d5878;--line:#e4def5;--accent:#7a4dff;--lav:#efeaff;--lav2:#d9ccff;--pink:#ffe9f0;--pink2:#ffc9d8;--mint:#e5f7ee;--mint2:#bfe9d2;--peach:#fff0e3;--peach2:#ffd9b8;--sky:#e8f1ff;--sky2:#c6dcff;--lemon:#fff7d9;--lemon2:#ffeaa0;}
*{box-sizing:border-box}
html,body{margin:0;padding:0;color:var(--ink);font-family:'Segoe UI',Arial,'Helvetica Neue',sans-serif;font-size:10.5pt;line-height:1.45;-webkit-print-color-adjust:exact;print-color-adjust:exact}
a{color:#3b4cd6;text-decoration:none;word-break:break-word}
p{margin:0 0 7px}
h1,h2,h3{font-family:'Poppins','Segoe UI',Arial,sans-serif;font-weight:800;margin:0;letter-spacing:-.01em}
.tag-proposed{display:inline-block;font:700 7pt 'InterUI',Arial,sans-serif;letter-spacing:.06em;color:#c2185b;background:#ffe3ee;border:1px solid #f7b3cb;border-radius:20px;padding:0 6px;vertical-align:1px}
.cover{height:11in;position:relative;overflow:hidden;page-break-after:always;background:linear-gradient(160deg,#ffe3ef 0%,#f1e8ff 48%,#e4ecff 100%);padding:.9in .75in 0}
.cover-art{position:absolute;left:0;right:0;bottom:1.25in;width:100%;height:3.6in}
.kicker{font:700 8.5pt 'InterUI',Arial,sans-serif;letter-spacing:.16em;text-transform:uppercase;color:var(--muted)}
.cover h1{font-size:40pt;line-height:1.02;margin:.32in 0 .14in}
.cover h1 .l2{color:var(--accent)}
.cover .subtitle{font:800 15pt 'Poppins',Arial,sans-serif;color:#3d2f8f;max-width:6.2in;line-height:1.25}
.chips{display:flex;flex-wrap:wrap;gap:7px;margin-top:.2in}
.chip{font:600 8pt 'InterUI',Arial,sans-serif;background:#fff;border:1px solid var(--line);border-radius:20px;padding:4px 11px}
.cover-foot{position:absolute;left:0;right:0;bottom:0;height:1.25in;background:#2a1d5c;color:#fff;padding:.25in .75in;display:flex;justify-content:space-between;font-size:8.5pt;line-height:1.5}
.cover-foot b{font:800 10pt 'Poppins',Arial,sans-serif;letter-spacing:.04em}
.cover-foot .r{text-align:right;opacity:.92}
section.sec{page-break-before:always;padding-top:2px}
section.sec.flow{page-break-before:auto;margin-top:16px}
.sec-head{display:flex;align-items:flex-start;gap:10px;margin-bottom:10px}
.sec-n{flex:none;width:30px;height:30px;border-radius:50%;background:var(--lav2);color:#3d2f8f;font:800 11pt 'Poppins',Arial,sans-serif;display:flex;align-items:center;justify-content:center;margin-top:9px}
.sec-head h2{font-size:19pt;line-height:1.15}
.sub-h{font:800 10.5pt 'Poppins',Arial,sans-serif;margin:10px 0 5px}
.band{font:700 8.5pt 'InterUI',Arial,sans-serif;letter-spacing:.12em;text-transform:uppercase;color:#3d2f8f;margin:12px 0 6px}
.txt{margin:4px 0 8px}
.list{margin:2px 0 8px;padding-left:18px}.list li{margin:2px 0}
.cards{display:grid;gap:9px;margin:6px 0 10px}.cards.c1{grid-template-columns:1fr}.cards.c2{grid-template-columns:1fr 1fr}.cards.c3{grid-template-columns:1fr 1fr 1fr}
.card,.stat,.callout,.step,.tip,.wire,.beat{border-radius:12px;break-inside:avoid}
.card{padding:10px 12px;border:1px solid rgba(0,0,0,.04)}
.card-label{font:700 7.5pt 'InterUI',Arial,sans-serif;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);margin-bottom:3px}
.card-title{font:800 11pt 'Poppins',Arial,sans-serif;line-height:1.2;margin-bottom:4px}
.card-text{font-size:9.5pt}.card-text p{margin-bottom:4px}
.lav{background:var(--lav)}.pink{background:var(--pink)}.mint{background:var(--mint)}.peach{background:var(--peach)}.sky{background:var(--sky)}.lemon{background:var(--lemon)}
.stats{display:flex;gap:9px;margin:8px 0 10px}.stat{flex:1;padding:10px;text-align:center}
.stat-v{font:900 20pt 'Poppins',Arial,sans-serif;line-height:1.05}.stat-l{font:700 7.5pt 'InterUI',Arial,sans-serif;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin-top:3px}
.callout{padding:10px 13px;margin:8px 0 10px;border-left:4px solid var(--accent)}.callout.peach{border-color:#f08a3c}.callout.mint{border-color:#2fa36b}.callout.pink{border-color:#e8456b}
.callout-t{font:800 10pt 'Poppins',Arial,sans-serif;margin-bottom:3px}
.steps{display:flex;gap:8px;margin:6px 0 10px}.step{flex:1;padding:10px}
.step-n{font:700 7.5pt 'InterUI',Arial,sans-serif;letter-spacing:.1em;text-transform:uppercase;color:var(--muted)}.step-t{font:800 10.5pt 'Poppins',Arial,sans-serif;margin:2px 0 4px}.step-x{font-size:9pt}
.beats{display:flex;gap:4px;margin:6px 0 8px}.beat{padding:6px 7px;font-size:8.3pt;line-height:1.3;border-radius:8px;min-width:0}.beat b{display:block;font:800 8.5pt 'Poppins',Arial,sans-serif}
.wire{display:flex;gap:14px;padding:12px;margin:8px 0 12px}.wire-art{flex:none;width:1.55in}.phone{width:100%;height:auto;display:block}
.wire-body{flex:1;min-width:0}.wire-body h3{font-size:13pt;margin-bottom:5px}.wire-facts{display:grid;grid-template-columns:1fr 1fr;gap:3px 12px;font-size:8.6pt;margin-top:6px}.wire-facts b{font:700 7.5pt 'InterUI',Arial,sans-serif;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin-right:4px}
.w-fo{display:flex;align-items:center;justify-content:center;height:100%;text-align:center;font:700 8.5px 'InterUI',Arial,sans-serif;line-height:1.1;color:#1d1638}
.w-cap{color:#fff}.w-big{font:900 22px 'Poppins',Arial,sans-serif;color:#c2185b}
.w-s{font:600 8px 'InterUI',Arial,sans-serif;fill:#1d1638}.w-t{font:600 9px 'InterUI',Arial,sans-serif;fill:#5d5878}
.tips{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:6px 0 10px}.tip{display:flex;gap:9px;padding:9px;align-items:flex-start}
.tip-ico{flex:none;width:1.15in;height:auto;background:#fff;border-radius:9px}
.tip-t{font:800 10pt 'Poppins',Arial,sans-serif;line-height:1.2;margin-bottom:3px}.tip-n{display:inline-flex;width:17px;height:17px;border-radius:50%;background:var(--accent);color:#fff;font:800 8.5pt 'Poppins',Arial,sans-serif;align-items:center;justify-content:center;margin-right:5px;vertical-align:1px}
.tip-x{font-size:8.8pt;line-height:1.35}.tip-x p{margin:0 0 3px}
.checks{display:flex;flex-wrap:wrap;gap:6px;margin:6px 0 10px}.check{background:#fff;border:1px solid var(--line);border-radius:20px;padding:3px 10px 3px 8px;font-size:8.6pt}.check::before{content:'\\2713';color:#2fa36b;font-weight:800;margin-right:5px}
.quote{margin:8px 0 10px;padding:10px 14px;background:var(--lav);border-radius:12px;font:600 11pt 'Segoe UI',Arial,sans-serif}.quote cite{display:block;font-style:normal;font-size:8.5pt;color:var(--muted);margin-top:4px}
.tbl{width:100%;border-collapse:collapse;margin:6px 0 10px;font-size:9pt}.tbl th{background:#f3effe;text-align:left;font:700 8pt 'InterUI',Arial,sans-serif;letter-spacing:.03em;padding:5px 6px;border-bottom:1.5px solid #cfc4f5}
.tbl td{padding:5px 6px;border-bottom:1px solid var(--line);vertical-align:top}.tbl tr{break-inside:avoid}.tbl.compact{font-size:8.3pt}.tbl.compact td{padding:3px 5px}
.sources{font-size:8.6pt;padding-left:18px;columns:2;column-gap:22px}.sources li{margin-bottom:4px;break-inside:avoid}
.mail{border-left:3px solid #c9bdf3;background:#faf8ff;padding:8px 12px;margin:5px 0 9px;font-size:9.4pt;border-radius:0 8px 8px 0;break-inside:avoid}.mail-subj{font-weight:700;margin-bottom:6px}
.script{background:#fbfbfd;border:1px solid var(--line);border-radius:8px;padding:7px 10px;font-size:9.3pt;margin:4px 0 9px;break-inside:avoid}
.person{margin:0 0 14px;break-inside:auto}.person h3{font-size:12.5pt;background:#f3effe;border-radius:7px;padding:5px 9px;margin:14px 0 6px}
.facts{margin:0 0 6px;padding-left:18px;font-size:9.5pt}.facts li{margin:1px 0}
.pb{page-break-after:always}
.doc-head{border-bottom:2px solid var(--accent);padding-bottom:8px;margin-bottom:12px}
.doc-head h1{font-size:22pt}.doc-head .meta{color:var(--muted);font-size:9pt;margin-top:4px}
/* plain: the working-list look */
body.plain{font-size:10pt}
body.plain h1{font:700 21pt 'Segoe UI',Arial,sans-serif;color:#1f3f8f}
body.plain .doc-head{border-color:#1f3f8f}
body.plain .sec-head h2,body.plain .person h3,body.plain .sub-h{font-family:'Segoe UI',Arial,sans-serif;font-weight:700}
body.plain .sec-head h2{font-size:15pt;color:#1f3f8f}
body.plain section.sec{page-break-before:auto;margin-top:14px}
body.plain .sec-n{display:none}
body.plain .person h3{background:#eef3fb;color:#1f3f8f;font-size:12pt}
body.plain .tbl th{background:#eef3fb;border-color:#9fb3dc}
body.plain .mail{background:#f6f8fc;border-color:#9fb3dc;font-family:Consolas,'Courier New',monospace;font-size:8.8pt}
`;

/** The whole document as one printable HTML page. */
function toHtml(spec, { fontDir } = {}) {
  const s = spec || {};
  const look = s.look === 'plain' ? 'plain' : 'designed';
  const fd = fontDir || path.join(__dirname, '..', '..', 'renderer', 'assets', 'fonts');
  const title = String(s.title || 'Document');
  const foot = `${s.footer || `${s.brand || 'Euclidean Media'} | ${title}`}`;
  const pageCss = `@page{size:Letter;margin:.6in .65in .7in;@bottom-left{content:"${foot.replace(/["\\]/g, '')}";font:8pt Arial,sans-serif;color:#8a85a3}@bottom-right{content:counter(page);font:8pt Arial,sans-serif;color:#8a85a3}}${look === 'designed' ? '@page:first{margin:0;@bottom-left{content:none}@bottom-right{content:none}}' : ''}`;
  const titleParts = Array.isArray(s.titleLines) && s.titleLines.length ? [String(s.titleLines[0] || ''), String(s.titleLines[1] || '')] : (() => { const t = title; const m = /^(.*?)\s+(for|:)\s+(.+)$/i.exec(t); if (look === 'designed' && m && m[1].length > 2) return [m[1] + (m[2] === ':' ? '' : ''), `${m[2] === ':' ? '' : `${m[2]} `}${m[3]}`]; const w = t.split(' '); return w.length >= 3 ? [w.slice(0, Math.ceil(w.length / 2)).join(' '), w.slice(Math.ceil(w.length / 2)).join(' ')] : [t, '']; })();
  const cover = look === 'designed' ? `<div class="cover">
    ${s.kicker ? `<div class="kicker">${esc(s.kicker)}</div>` : ''}
    <h1>${esc(titleParts[0])}${titleParts[1] ? `<br><span class="l2">${esc(titleParts[1])}</span>` : ''}</h1>
    ${s.subtitle ? `<div class="subtitle">${inline(s.subtitle)}</div>` : ''}
    ${(s.chips || []).length ? `<div class="chips">${s.chips.slice(0, 8).map((c) => `<span class="chip">${esc(c)}</span>`).join('')}</div>` : ''}
    ${MOUNTAINS}
    <div class="cover-foot"><div><b>${esc(s.preparedByLabel || 'PREPARED BY EUCLIDEAN MEDIA')}</b><br>${esc(s.company || 'A ZSPAN LLC company | zspannetwork.com')}<br>${esc(s.preparedBy || 'Ben Gingold and Ryan Rosario, Co-founders')}</div><div class="r">${esc(s.purpose || '')}${s.purpose ? '<br>' : ''}<b style="font-size:9pt">${esc(s.date || '')}</b><br>${esc(s.note || 'Confidential draft')}</div></div>
  </div>` : `<div class="doc-head"><h1>${esc(title)}</h1>${s.subtitle ? `<div class="meta">${inline(s.subtitle)}</div>` : ''}${s.date || s.note ? `<div class="meta">${esc([s.date, s.note].filter(Boolean).join(' · '))}</div>` : ''}</div>`;
  let n = 0;
  const secs = (s.sections || []).map((sec, i) => {
    if (!sec) return '';
    const num = sec.number != null ? sec.number : look === 'designed' && sec.numbered !== false ? String(n++).padStart(2, '0') : '';
    const flow = look === 'plain' || sec.newPage === false || (look === 'designed' && i === 0 && s.coverless);
    return `<section class="sec${flow ? ' flow' : ''}">
      ${sec.title ? `<div class="sec-head">${num !== '' ? `<div class="sec-n">${esc(num)}</div>` : ''}<div>${sec.kicker ? `<div class="kicker">${esc(sec.kicker)}</div>` : ''}<h2>${inline(sec.title)}</h2></div></div>` : ''}
      ${sec.intro ? `<div class="txt">${paras(sec.intro)}</div>` : ''}
      ${(sec.blocks || []).map((b, k) => block(b, look, i + k)).join('\n')}
    </section>`;
  }).join('\n');
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>${fontFace(fd)}${pageCss}${CSS}</style></head><body class="${look}">${cover}${secs}</body></html>`;
}

/** Plain text of a spec (for the Data tab, search, the bots and email previews). */
function toText(spec) {
  const s = spec || {}; const out = [`# ${s.title || 'Document'}`]; if (s.subtitle) out.push(s.subtitle);
  const t = (x) => String(x ?? '').trim();
  for (const sec of s.sections || []) {
    out.push('', `## ${t(sec.title)}`); if (sec.intro) out.push(t(sec.intro));
    for (const b of sec.blocks || []) {
      if (!b) continue;
      if (b.type === 'text' || b.type === 'callout' || b.type === 'quote') out.push(`${b.title ? `${t(b.title)}: ` : ''}${t(b.text)}${b.by ? ` (${t(b.by)})` : ''}`);
      else if (b.type === 'bullets' || b.type === 'checklist') out.push(...(b.items || []).map((x) => `- ${t(typeof x === 'string' ? x : x.text)}`));
      else if (b.type === 'table') { out.push(`| ${(b.columns || []).join(' | ')} |`, `| ${(b.columns || []).map(() => '---').join(' | ')} |`, ...(b.rows || []).map((r) => `| ${(Array.isArray(r) ? r : (b.columns || []).map((c) => r?.[c] ?? '')).map((c) => t(c).replace(/\|/g, '/')).join(' | ')} |`)); }
      else if (b.type === 'cards' || b.type === 'steps' || b.type === 'tips') out.push(...(b.items || []).map((c) => `- ${[c.label, c.title].filter(Boolean).map(t).join(': ')}${c.text ? `. ${t(c.text)}` : ''}`));
      else if (b.type === 'stats') out.push((b.items || []).map((x) => `${t(x.value)} ${t(x.label)}`).join(' · '));
      else if (b.type === 'beats') out.push((b.items || []).map((x) => `${t(x.time)}: ${t(x.text)}`).join(' | '));
      else if (b.type === 'phone') out.push(`${t(b.title)}. ${t(b.text)}`);
      else if (b.type === 'email') out.push(`Subject: ${t(b.subject)}`, t(b.body));
      else if (b.type === 'sources') out.push(...(b.items || []).map((x) => `- ${typeof x === 'string' ? x : `${t(x.text || x.title)} ${t(x.url)}`}`));
      else if (b.type === 'person' || b.type === 'people') {
        for (const p of b.type === 'people' ? b.items || [] : [b]) {
          out.push('', `### ${p.n ? `${p.n}. ` : ''}${t(p.name)}${p.seat ? ` (${t(p.seat)})` : ''}${p.status ? ` ${t(p.status).toUpperCase()}` : ''}${p.tier ? ` [Tier ${t(p.tier)}]` : ''}`);
          for (const [k, v] of [['Result', p.result], ['Why', p.why], ['Phones', p.phones], ['Email', p.email], ['Verified hook', p.hook], ['Fact source', p.source], ['Next step', p.next]]) if (t(v)) out.push(`- **${k}:** ${t(v)}`);
          if (p.emailDraft) { const e = typeof p.emailDraft === 'string' ? { body: p.emailDraft } : p.emailDraft; out.push('', '### Email', e.subject ? `Subject: ${t(e.subject)}` : '', t(e.body)); }
          if (p.script) out.push('', '### Pickup script', t(p.script));
          if (p.voicemail) out.push('', '### Voicemail', t(p.voicemail));
          if (p.videoPrompt) out.push('', '### Video brief', t(p.videoPrompt));
        }
      } else if (b.text) out.push(t(b.text));
    }
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

module.exports = { toHtml, toText, phoneSvg, iconFor, inline, esc, TONES, TONE_HEX };
