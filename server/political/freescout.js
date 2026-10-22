'use strict';
/**
 * Scouting with no API keys and no AI: free public lists of candidates and officials.
 *
 *  - Ballotpedia election pages ("Connecticut House of Representatives elections, 2026"):
 *    every candidate, with party when the page shows it.
 *  - Wikidata (free query service): everyone currently holding a seat in that chamber,
 *    with party and official website.
 *
 * The query is plain English ("Connecticut Democrats running for state house in 2026");
 * state, chamber, party and year are read from it.
 */
const UA = 'EuclideanMedia/1.0 (lead research; https://euclidean.media)';

const STATES = ['Alabama', 'Alaska', 'Arizona', 'Arkansas', 'California', 'Colorado', 'Connecticut', 'Delaware', 'Florida', 'Georgia', 'Hawaii', 'Idaho', 'Illinois', 'Indiana', 'Iowa', 'Kansas', 'Kentucky', 'Louisiana', 'Maine', 'Maryland', 'Massachusetts', 'Michigan', 'Minnesota', 'Mississippi', 'Missouri', 'Montana', 'Nebraska', 'Nevada', 'New Hampshire', 'New Jersey', 'New Mexico', 'New York', 'North Carolina', 'North Dakota', 'Ohio', 'Oklahoma', 'Oregon', 'Pennsylvania', 'Rhode Island', 'South Carolina', 'South Dakota', 'Tennessee', 'Texas', 'Utah', 'Vermont', 'Virginia', 'Washington', 'West Virginia', 'Wisconsin', 'Wyoming'];
// The lower chamber's real name where it isn't "House of Representatives".
const LOWER = { California: 'State Assembly', Nevada: 'Assembly', 'New York': 'State Assembly', Wisconsin: 'State Assembly', 'New Jersey': 'General Assembly', Maryland: 'House of Delegates', Virginia: 'House of Delegates', 'West Virginia': 'House of Delegates' };

/** State, chamber, party and year from a plain-English search. */
function parse(query) {
  const q = String(query || '');
  const state = STATES.slice().sort((a, b) => b.length - a.length).find((s) => new RegExp(`\\b${s}\\b`, 'i').test(q)) || null;
  const chamber = /senate/i.test(q) ? 'upper' : /house|assembly|representative|delegate|legislat/i.test(q) ? 'lower' : /congress|u\.?s\.? house/i.test(q) ? 'congress' : 'lower';
  const party = /democrat/i.test(q) ? 'Democratic' : /republican|gop/i.test(q) ? 'Republican' : null;
  const year = Number((q.match(/\b20\d\d\b/) || [])[0]) || new Date().getFullYear();
  const running = /running|candidate|challenger|campaign|election|race/i.test(q);
  return { state, chamber, party, year, running };
}

async function get(url, { json = false, timeoutMs = 20000 } = {}) {
  const res = await fetch(url, { headers: { 'user-agent': UA, accept: json ? 'application/sparql-results+json, application/json' : 'text/html' }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`${new URL(url).hostname} ${res.status}`);
  return json ? res.json() : res.text();
}
const strip = (s) => String(s).replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/\s+/g, ' ').trim();

/** Candidates listed on Ballotpedia's election page for that chamber and year. */
async function ballotpedia({ state, chamber, party, year }) {
  if (!state) return [];
  const body = chamber === 'upper' ? 'State_Senate' : chamber === 'congress' ? null : (LOWER[state] || 'House_of_Representatives').replace(/ /g, '_');
  const page = body ? `${state.replace(/ /g, '_')}_${body}_elections,_${year}` : `United_States_House_of_Representatives_elections_in_${state.replace(/ /g, '_')},_${year}`;
  const html = await get(`https://ballotpedia.org/${page}`);
  const out = []; const seen = new Set();
  // Candidate lists are tables; each row names a district and its candidates, often with the party.
  for (const row of html.split(/<tr[\s>]/i).slice(1)) {
    const text = strip(row);
    const district = (text.match(/District\s+\d+[A-Z]?/i) || [''])[0];
    for (const td of row.split(/<t[dh][\s>]/i)) for (const m of td.matchAll(/<a[^>]+href="(?:https:\/\/ballotpedia\.org)?\/([A-Z][A-Za-z.'-]+(?:_[A-Za-z.'"()-]+){1,4})"[^>]*>([^<]{4,60})<\/a>/g)) {
      const name = strip(m[2]); const slug = m[1];
      if (!/^[A-Z][a-z.'-]+( [A-Z][A-Za-z.'"-]+){1,3}$/.test(name) || /District|Election|House|Senate|Party|Ballotpedia|Assembly|County/.test(name) || seen.has(name)) continue;
      // Party: from the link's own cell when shown, else the row.
      const cell = td; // the candidate's own cell shows their party
      const p = /Democratic|\(D\)/.test(cell) ? 'Democratic' : /Republican|\(R\)/.test(cell) ? 'Republican' : null;
      if (party && p && p !== party) continue;
      seen.add(name);
      out.push({ name, party: p, office: `${state} ${chamber === 'upper' ? 'State Senate' : chamber === 'congress' ? 'U.S. House' : LOWER[state] || 'House of Representatives'}${district ? `, ${district}` : ''}`, url: `https://ballotpedia.org/${slug}`, source: 'Ballotpedia', why: `Listed as a ${year} candidate${district ? ` in ${district}` : ''}${p ? ` (${p})` : ''} on Ballotpedia.` });
    }
  }
  return out;
}

/** Everyone currently holding a seat in that chamber, from Wikidata (free). */
async function wikidata({ state, chamber, party }) {
  if (!state) return [];
  const label = chamber === 'upper' ? `member of the ${state} Senate` : chamber === 'congress' ? 'member of the United States House of Representatives' : `member of the ${state} ${LOWER[state] || 'House of Representatives'}`;
  const s = await get(`https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(label)}&language=en&type=item&limit=3&format=json`, { json: true });
  const pos = (s.search || []).find((x) => /^member of/i.test(x.label || ''))?.id; if (!pos) return [];
  const stateFilter = chamber === 'congress' ? `?st pq:P768 ?dist . ?dist wdt:P131* ?stItem . ?stItem rdfs:label "${state}"@en .` : '';
  const sparql = `SELECT DISTINCT ?p ?pLabel ?partyLabel ?site WHERE { ?p p:P39 ?st . ?st ps:P39 wd:${pos} . FILTER NOT EXISTS { ?st pq:P582 ?end } ${stateFilter} OPTIONAL { ?p wdt:P102 ?party } OPTIONAL { ?p wdt:P856 ?site } SERVICE wikibase:label { bd:serviceParam wikibase:language "en". } } LIMIT 400`;
  const r = await get(`https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(sparql)}`, { json: true, timeoutMs: 40000 });
  const out = []; const seen = new Set();
  for (const b of r.results?.bindings || []) {
    const name = b.pLabel?.value; if (!name || /^Q\d+$/.test(name) || seen.has(name)) continue;
    const p = b.partyLabel?.value || '';
    if (party && p && !p.includes(party.replace('ic', ''))) continue;
    seen.add(name);
    out.push({ name, party: p || null, office: label.replace(/^member of the /, ''), url: b.site?.value || '', source: 'Wikidata', why: `Currently serving${p ? ` (${p})` : ''}, per Wikidata.` });
  }
  return out;
}

/** Free scout: returns [{ name, party, office, url, source, why }]. */
async function scout(query, { count = 15, log = () => {} } = {}) {
  const q = parse(query);
  if (!q.state) return { leads: [], note: 'Name a state in the search (for example "Connecticut Democrats running for state house in 2026") so the free lists can be used.' };
  const leads = [];
  try { leads.push(...await ballotpedia(q)); } catch (e) { log(`Ballotpedia: ${e.message}`); }
  if (!q.running || leads.length < count) { try { const have = new Set(leads.map((x) => x.name)); leads.push(...(await wikidata(q)).filter((x) => !have.has(x.name))); } catch (e) { log(`Wikidata: ${e.message}`); } }
  // Spread the picks across the list each day instead of always taking the first few.
  const day = Math.floor(Date.now() / 864e5); const start = leads.length ? (day * 7) % leads.length : 0;
  return { leads: [...leads.slice(start), ...leads.slice(0, start)], parsed: q };
}

module.exports = { scout, parse, ballotpedia, wikidata };
