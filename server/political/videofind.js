'use strict';
/**
 * Finding a politician's public videos the way a person would: search their first and last name and open Google's
 * Videos tab (Ryan, Nov 10: "you can find all video of an assembly member by just looking up their first and last
 * name and clicking the video tab on Google": floor sessions, hearings, council meetings, interviews, campaign videos).
 *
 * One Serper "videos" search per person (a second only when the first finds fewer than 4 of them), cached, so a whole
 * winners list costs about a cent per name. Each result is kept only when it is about this person (their last name in
 * the title, description or channel, and their first name or office nearby), then ranked:
 *   their own channel or campaign > official government video (nyassembly.gov, nysenate.gov, house.gov, C-SPAN, town and
 *   council meetings) > local news > the rest; things yt-dlp can download (YouTube, Facebook, Vimeo, X, C-SPAN...) first;
 *   speeches, remarks, floor, hearings, town halls, interviews and press conferences first; 30 s to 20 min best (the
 *   footage step reads the first 10 minutes, so a 4-hour session rarely reaches them).
 * Saved on the lead as `footageFound`; the footage step downloads the ones not switched off (`off`), as "found on
 * Google" (own: false unless the uploader is them), after uploads and pasted links.
 */
const ctx = require('../core/ctx');
const serper = require('../integrations/serper');

const OFFICIAL = /nyassembly\.gov|nysenate\.gov|assembly\.state\.ny\.us|senate\.gov|house\.gov|congress\.gov|c-span\.org|cga\.ct\.gov|ctn\.state\.ct\.us|granicus\.com|legistar|swagit|townhallstreams|boarddocs|\.gov\b|\.us\b/i;
const OFFICIAL_CH = /assembly|senate|state senate|legislature|c-span|city council|town of|county|board of|public access|government|ctn|nys/i;
const NEWS = /news|news12|ny1|wnyt|wten|wgrz|wkbw|wcbs|abc|nbc|cbs|fox|pix11|spectrum|newsday|patch|times union|gazette|herald|post|journal|tribune|press/i;
const DOWNLOADABLE = /youtube\.com|youtu\.be|facebook\.com|fb\.watch|vimeo\.com|x\.com|twitter\.com|c-span\.org|instagram\.com|tiktok\.com|dailymotion|rumble|nyassembly\.gov|nysenate\.gov|granicus/i;
const GOOD_WORDS = /speech|remarks|floor|hearing|town hall|interview|press conference|rally|announce|testif|debate|forum|budget|bill|vote|session|meeting|explains|statement|victory|sworn/i;
const BAD_WORDS = /obituar|funeral|wedding|highlights?\s+reel|music video|trailer|reaction|prank|lyrics/i;

const words = (s) => String(s || '').toLowerCase();
function officeWord(office) {
  const o = words(office);
  return /assembly|\bad[- ]?\d/.test(o) ? 'Assembly' : /senat|\bsd[- ]?\d/.test(o) ? 'Senator' : /congress|house|ny-\d/.test(o) ? 'Congress' : /council/.test(o) ? 'Council' : /legislat|\bld[- ]?\d/.test(o) ? 'Legislator' : /mayor/.test(o) ? 'Mayor' : /supervisor/.test(o) ? 'Supervisor' : /selectm/.test(o) ? 'Selectman' : '';
}

/** Is this video about the person? Their last name must be there, and their first name or office word too. */
function aboutThem(v, name, office) {
  const parts = String(name).trim().replace(/\([^)]*\)/g, ' ').split(/\s+/).filter((x) => !/^(jr\.?|sr\.?|ii|iii|iv)$/i.test(x));
  const first = words(parts[0]); const last = words(parts[parts.length - 1]);
  const hay = words(`${v.title} ${v.snippet} ${v.channel}`);
  if (!last || !hay.includes(last)) return false;
  const ow = words(officeWord(office));
  return hay.includes(first) || (ow && hay.includes(ow.slice(0, 5))) || /assembly|senat|council|legislat|mayor|rep\.|representative|member/.test(hay);
}

function score(v, name) {
  const last = words(String(name).trim().split(/\s+/).pop());
  const ch = words(v.channel); const url = v.url;
  let s = 0; const why = [];
  const own = last && ch.includes(last);
  if (own) { s += 5; why.push('their channel'); }
  if (!own && (OFFICIAL.test(url) || OFFICIAL_CH.test(v.channel))) { s += 3; why.push('official'); }
  else if (NEWS.test(`${v.channel} ${v.source}`)) { s += 1.5; why.push('news'); }
  if (DOWNLOADABLE.test(url)) s += 2; else { s -= 3; why.push('may not download'); }
  if (GOOD_WORDS.test(v.title)) { s += 1.5; why.push('speaking'); }
  if (BAD_WORDS.test(v.title)) s -= 5;
  if (v.duration) { if (v.duration < 20) s -= 3; else if (v.duration <= 20 * 60) s += 1; else if (v.duration > 3 * 3600) { s -= 2; why.push('very long'); } }
  if (/202[5-9]/.test(v.date) || /(day|week|month)s? ago/.test(v.date)) { s += 1; why.push('recent'); }
  return { s: Math.round(s * 10) / 10, why };
}

/**
 * Search Google Videos for this person. Returns { videos: [...ranked], queries, cached, error }. Never throws: with no
 * key or over the budget it returns the reason (the footage step then uses its free searches).
 */
async function find({ name, office = '', state = '' }, { max = 12 } = {}) {
  const ow = officeWord(office);
  const queries = [`"${String(name).replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim()}"${ow ? ` ${ow}` : ''}${state ? ` ${state}` : ''}`];
  const seen = new Set(); const out = []; let cached = true;
  for (let i = 0; i < 2; i++) {
    const q = queries[i]; if (!q) break;
    let r; try { r = await serper.videos(q, { num: 30 }); } catch (e) { return { videos: out, queries: queries.slice(0, i + 1), error: e.message, blocked: !!e.serperBlocked }; }
    cached = cached && r.cached;
    for (const v of r.videos) {
      const k = v.url.replace(/[?&](t|si|feature)=[^&]*/g, ''); if (seen.has(k)) continue; seen.add(k);
      if (!aboutThem(v, name, office)) continue;
      const sc = score(v, name);
      if (sc.s < -1) continue;
      out.push({ ...v, score: sc.s, why: sc.why });
    }
    // Only pay for a second search when the first found too little (the plain name, without the office word).
    if (out.length < 4 && i === 0 && ow) queries.push(`"${String(name).replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim()}"`);
  }
  out.sort((a, b) => b.score - a.score);
  return { videos: out.slice(0, max), queries, cached };
}

/** Find and save on the lead (`footageFound`, keeping which ones were switched off). */
async function forLead(id, { actor = 'user' } = {}) {
  const p = ctx.store.get('prospects', id); if (!p) throw new Error('That lead is gone.');
  const pr = p.pkg?.profile || {};
  const office = pr.office || p.office || '';
  const state = (/\b(NY|CT|NJ|MA|RI|PA)\b/.exec(`${office} ${p.location || ''}`) || [])[1] || (/assembly|senate|ad-|sd-/i.test(office) && !/ct|connecticut/i.test(office) ? 'New York' : '');
  const r = await find({ name: p.name, office, state });
  const prev = new Map((p.footageFound || []).map((v) => [v.url, v]));
  const found = r.videos.map((v) => ({ ...v, off: prev.get(v.url)?.off || false }));
  const note = r.error || (found.length ? null : `Google's Videos tab had nothing clearly about ${p.name} (searched ${r.queries.join(' and ')}). Upload their videos or paste links on the lead.`);
  ctx.store.update('prospects', id, { footageFound: found, footageFoundAt: new Date().toISOString(), footageFoundNote: note });
  require('../core/audit').log(actor, 'political.videos_found', { prospectId: id, name: p.name, found: found.length, queries: r.queries.length, cached: r.cached || false });
  require('../core/events').publish('prospects', { id });
  return { found, queries: r.queries, cached: r.cached, error: r.error || null, note };
}

module.exports = { find, forLead, aboutThem, score, officeWord };
