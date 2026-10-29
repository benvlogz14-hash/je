'use strict';
/**
 * Pipeline words HAL understands ("mark Judy contacted", "call booked") mapped onto the stages the Politics board uses,
 * and the funnel over the board. (The old Targeting System's race ratings and fit scores are gone: the midterms are
 * over, and the outreach guide ranks its own best picks.)
 */
const STAGE_TO_EU = { NEW: 'new', CONTACTED: 'contacted', REPLIED: 'replied', 'CALL BOOKED': 'meeting', CLIENT: 'won', PASSED: 'lost' };
const STAGE_FROM_EU = { new: 'NEW', drafted: 'NEW', contacted: 'CONTACTED', replied: 'REPLIED', meeting: 'CALL BOOKED', proposal: 'CALL BOOKED', won: 'CLIENT', lost: 'PASSED' };

/** Funnel over the board, on Euclidean's stages. */
function funnel(prospects) {
  const counts = { NEW: 0, CONTACTED: 0, REPLIED: 0, 'CALL BOOKED': 0, CLIENT: 0, PASSED: 0 };
  for (const p of prospects) counts[STAGE_FROM_EU[p.stage] || 'NEW']++;
  const contacted = counts.CONTACTED + counts.REPLIED + counts['CALL BOOKED'] + counts.CLIENT + counts.PASSED;
  const replied = counts.REPLIED + counts['CALL BOOKED'] + counts.CLIENT;
  return { counts, contacted, replyRate: contacted ? Math.round((100 * replied) / contacted) : 0, closeRate: contacted ? Math.round((100 * counts.CLIENT) / contacted) : 0, total: prospects.length };
}

module.exports = { funnel, STAGE_TO_EU, STAGE_FROM_EU };
