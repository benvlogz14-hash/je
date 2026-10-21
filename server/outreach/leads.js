'use strict';
/**
 * Lead spreadsheets in and out. Import accepts any CSV with a header row and
 * recognises common column names; the original columns are remembered so the
 * export writes new leads back in exactly the same layout.
 */
const ctx = require('../core/ctx');
const events = require('../core/events');
const audit = require('../core/audit');
const { nameMatch } = require('../political/sources');
const { isGov, excluded } = require('./common');

function parseCsv(text) {
  const rows = []; let row = []; let cell = ''; let q = false;
  const s = String(text || '').replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) { if (ch === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; continue; }
    if (ch === '"') q = true;
    else if (ch === ',' || ch === '\t') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && s[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => String(c).trim()));
}

const FIELDS = {
  name: /^(name|full name|creator|candidate|politician|lead|contact name|channel name)$/i,
  email: /^(e-?mail|email address|contact email|public email|business email|public contact|contact)$/i,
  handle: /^(handle|channel|youtube|youtube url|url|link|profile|profile url|social|website|campaign site|site)$/i,
  platform: /^(platform|network)$/i,
  followers: /^(followers|subscribers|subs|audience|follower count)$/i,
  location: /^(office|position|title|seat|race|district|town|city|municipality|location|state|county)$/i,
  party: /^(party)$/i,
  why: /^(notes|why|reason|angle|pitch|about)$/i,
  stage: /^(status|stage)$/i,
  phone: /^(phone|phone number)$/i,
};

function mapHeaders(headers) {
  const map = {};
  headers.forEach((h, i) => {
    const k = Object.keys(FIELDS).find((f) => FIELDS[f].test(String(h).trim())); if (!k) return;
    if (k === 'location') (map.location ||= []).push(i); else if (map[k] == null) map[k] = i;
  });
  return map;
}

/** lane: 'political' | 'creators'. Returns { added, updated, skipped, columns }. */
function importCsv({ lane, csv, actor }) {
  const rows = parseCsv(csv); if (rows.length < 2) throw new Error('The file needs a header row and at least one lead.');
  const headers = rows[0].map((h) => String(h).trim()); const map = mapHeaders(headers);
  if (map.name == null) throw new Error(`No name column found. Columns seen: ${headers.join(', ')}`);
  const type = lane === 'political' ? 'political' : 'creator';
  const saved = { ...(ctx.store.settings._leadColumns || {}) }; saved[lane] = headers; ctx.store.settings._leadColumns = saved; ctx.store.touch();
  let added = 0; let updated = 0; const skipped = [];
  for (const r of rows.slice(1)) {
    const get = (k) => (map[k] == null ? '' : String(r[map[k]] || '').trim());
    const name = get('name'); if (!name) continue;
    const email = get('email').toLowerCase().replace(/^mailto:/, '');
    const loc = (map.location || []).map((i) => String(r[i] || '').trim()).filter(Boolean).join(', ');
    const raw = Object.fromEntries(headers.map((h, i) => [h, r[i] ?? '']));
    if (excluded({ name, email, handle: get('handle') })) { skipped.push(`${name}: excluded`); continue; }
    const contact = email && /@/.test(email) && !isGov(email) ? email : '';
    if (email && !contact) skipped.push(`${name}: government email not used`);
    const followers = Number(String(get('followers')).replace(/[^\d.]/g, '')) || null;
    const ex = ctx.store.find('prospects', (p) => (contact && String(p.publicContact).toLowerCase() === contact) || (nameMatch(p.name, name) && nameMatch(name, p.name)));
    const fields = { name, type, handle: get('handle'), platforms: get('platform') ? [get('platform').toLowerCase()] : [], location: loc, why: [get('party'), get('why')].filter(Boolean).join(' · '), publicContact: contact, contactVerified: !!contact, followers, imported: true, sheet: raw, verified: true, source: 'import' };
    if (ex) { ctx.store.update('prospects', ex.id, Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== '' && v != null && !(Array.isArray(v) && !v.length)))); updated++; }
    else { ctx.store.insert('prospects', { ...fields, angle: '', stage: 'new' }); added++; }
  }
  events.publish('prospects', {});
  audit.log(actor || 'user', 'leads.imported', { lane, added, updated, skipped: skipped.length });
  return { added, updated, skipped, columns: headers, recognised: Object.keys(map) };
}

/** CSV of a lane's leads in the imported layout (or a standard one), new leads included. */
function exportCsv(lane) {
  const type = lane === 'political' ? 'political' : 'creator';
  const list = ctx.store.all('prospects', (p) => (type === 'political' ? p.type === 'political' : p.type !== 'political'));
  const headers = ctx.store.settings._leadColumns?.[lane] || ['Name', 'Email', 'Handle', 'Platform', 'Followers', 'Office', 'Party', 'Notes', 'Status'];
  const map = mapHeaders(headers);
  const q = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const rows = list.map((p) => headers.map((h, i) => {
    if (p.sheet && h in p.sheet && !['email', 'stage'].some((k) => map[k] === i)) return p.sheet[h];
    if (map.name === i) return p.name; if (map.email === i) return p.publicContact; if (map.handle === i) return p.handle; if (map.platform === i) return (p.platforms || [])[0];
    if (map.followers === i) return p.followers; if ((map.location || []).includes(i)) return p.pkg?.profile?.office || p.location; if (map.party === i) return p.pkg?.profile?.party || '';
    if (map.why === i) return p.why; if (map.stage === i) return p.stage || 'new'; return '';
  }));
  return '﻿' + [headers, ...rows].map((r) => r.map(q).join(',')).join('\r\n');
}

module.exports = { parseCsv, importCsv, exportCsv };
