'use strict';
/**
 * HAL's rating and fit score (Part 5 of the master prompt; normalize_prospect in HAL_CORE_CODE.py), deterministic and
 * identical to his old program, mapped onto Euclidean's prospect fields. Pipeline stages map HAL's CRM words onto the
 * stages the Politics board already uses.
 */
const MARGIN_RE = /([DR])\s*\+\s*([0-9]+(?:\.[0-9]+)?)/i;
const WEAK = /no video|minimal|unknown|dormant|thin/i;

// HAL's stages ↔ Euclidean's (Growth/Politics board)
const STAGE_TO_EU = { NEW: 'new', CONTACTED: 'contacted', REPLIED: 'replied', 'CALL BOOKED': 'meeting', CLIENT: 'won', PASSED: 'lost' };
const STAGE_FROM_EU = { new: 'NEW', drafted: 'NEW', contacted: 'CONTACTED', replied: 'REPLIED', meeting: 'CALL BOOKED', proposal: 'CALL BOOKED', won: 'CLIENT', lost: 'PASSED' };

const fmtMargin = (dir, mag) => `${dir}+${String(Math.round(mag * 10) / 10).replace(/\.0$/, '')}`;

/** Rating, race class, fit score, band and board tag for one prospect. Never invents a margin. */
function rate(p) {
  const raw = String(p.race || p.rate || '').trim();
  const m = MARGIN_RE.exec(raw); const dir = m ? m[1].toUpperCase() : null; const mag = m ? Number(m[2]) : null;
  let cat, rc, margin = '';
  if (mag != null) {
    if (mag < 3) { cat = 'TOSS-UP'; rc = 'toss'; } else if (mag < 7) { cat = `LEAN ${dir}`; rc = 'lean'; } else if (mag < 15) { cat = `LIKELY ${dir}`; rc = 'likely'; } else { cat = `SAFE ${dir}`; rc = 'safe'; }
    margin = fmtMargin(dir, mag);
  } else {
    const up = raw.toUpperCase().replace(/\*/g, '').trim();
    if (up.startsWith('TOSS')) { cat = 'TOSS-UP'; rc = 'toss'; } else if (up.startsWith('LEAN')) { cat = up || 'LEAN D'; rc = 'lean'; } else if (up.startsWith('LIKELY')) { cat = up || 'LIKELY D'; rc = 'likely'; } else if (up.startsWith('SAFE')) { cat = up || 'SAFE D'; rc = 'safe'; } else { cat = 'UNRATED'; rc = 'lo'; }
  }
  let score = { toss: 46, lean: 33, likely: 19, safe: 7 }[rc] ?? 24;
  if (mag != null) score += Math.round(Math.max(0, (6 - Math.min(6, mag)) * 2)); // dead-heat bonus, up to +12
  const weakVideo = WEAK.test(p.social || p.soc || '');
  if (weakVideo) score += 20;
  const advertising = p.adc === 'ady' || /\b(running|runs|buying|bought)\b.*\bads?\b|\badvertis/i.test(p.adNote || p.adtxt || '');
  if (advertising) score += 15;
  const why = String(p.why || '').toLowerCase();
  if (why.includes('open') || why.includes('challenger')) score += 7;
  if (String(p.email || p.publicContact || '').includes('@')) score += 5;
  score = Math.max(5, Math.min(99, Math.round(score)));
  const scc = score >= 70 ? 'hi' : score >= 45 ? 'mid' : 'lo';
  const tag = (rc === 'toss' || rc === 'lean') && weakVideo ? 'PRIME' : advertising ? 'WARM' : (rc === 'toss' || rc === 'lean') ? 'SWING' : weakVideo ? 'OPENING' : 'WATCH';
  return { rateCat: cat, margin, rating: margin ? `${cat} · ${margin}` : cat, rc, fit: score, band: scc, tag, weakVideo, advertising };
}

/** Political prospects ranked by fit (best targets first). */
function rank(prospects, limit = 8) {
  return prospects.filter((p) => p.type === 'political').map((p) => ({ p, r: rate(p) })).sort((a, b) => b.r.fit - a.r.fit).slice(0, limit);
}

/** Funnel over the board (Part 6), on Euclidean's stages. */
function funnel(prospects) {
  const counts = { NEW: 0, CONTACTED: 0, REPLIED: 0, 'CALL BOOKED': 0, CLIENT: 0, PASSED: 0 };
  for (const p of prospects) counts[STAGE_FROM_EU[p.stage] || 'NEW']++;
  const contacted = counts.CONTACTED + counts.REPLIED + counts['CALL BOOKED'] + counts.CLIENT + counts.PASSED;
  const replied = counts.REPLIED + counts['CALL BOOKED'] + counts.CLIENT;
  return { counts, contacted, replyRate: contacted ? Math.round((100 * replied) / contacted) : 0, closeRate: contacted ? Math.round((100 * counts.CLIENT) / contacted) : 0, total: prospects.length };
}

module.exports = { rate, rank, funnel, STAGE_TO_EU, STAGE_FROM_EU };
