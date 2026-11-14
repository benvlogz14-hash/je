'use strict';
/**
 * Polish (Nov 14, Ryan: "let it look at its own clips and edit out silences and sync up fonts better ... revise videos,
 * make em almost perfect and then resend them to approval"). After a clip renders and before it goes to review, its
 * finished cut is checked once. Anything off is fixed with the clip's own switches and the clip is rendered again;
 * the renderer itself is unchanged. Checks:
 *  - pauses left in the cut: the usual pause cuts happen only where the audio is quiet, so with wind or room noise a
 *    gap of a second or two with nobody talking stays in. A gap over 0.9 s between words inside the kept cut → the
 *    clip is cut by the words themselves (`clip.cutByWords`: the pause cuts no longer wait for quiet audio);
 *  - pause cuts switched off for this clip → on;
 *  - the look drifted from its style (Documentary, Walkthrough, Explorer, Highlights...): font, sizes and colours put
 *    back to that style's look (the words, title and anything else stay);
 *  - no captions although the video now has a transcript → rendered again with them.
 * Only talking clips (not B-roll or story edits), once per clip (`clip.polish`), and only when the client has it on
 * (`production.autoPolish`, default on). The approval card says what was fixed.
 */
const ctx = require('../core/ctx');

const LOOK_KEYS = ['font', 'size', 'primary', 'highlight', 'highlightMode', 'outline', 'outlineWidth', 'wordsPerLine', 'uppercase', 'position', 'hookFont', 'hookSize', 'hookColor', 'hookOutline', 'hookOutlineWidth', 'hookPosition', 'hookUpper', 'hookCapsFirst'];

function enabled(client) { return client?.production?.autoPolish !== false; }

/** What to change on this clip (patch) and why (notes); an empty patch means it's fine. */
function check(clip, { words = null } = {}) {
  const patch = {}; const notes = [];
  if (!clip || clip.kind === 'broll' || clip.kind === 'story') return { patch, notes };
  const v = (clip.versions || [])[clip.currentVersion - 1]; if (!v) return { patch, notes };
  if (clip.silenceCut === false) { patch.silenceCut = true; notes.push('turned pause cuts back on'); }
  // Gaps between words inside what was kept.
  if (words?.length && Array.isArray(v.segs) && v.segs.length && !clip.cutByWords) {
    let long = 0; let worst = 0;
    for (const [a, b] of v.segs) {
      const ws = words.filter((w) => w.s >= a - 0.05 && w.e <= b + 0.05);
      for (let i = 1; i < ws.length; i++) { const gap = ws[i].s - ws[i - 1].e; if (gap > 0.9) { long++; worst = Math.max(worst, gap); } }
    }
    if (long) { patch.cutByWords = true; notes.push(`cut ${long} pause${long > 1 ? 's' : ''} the noise had kept in (longest ${worst.toFixed(1)} s)`); }
  }
  // The look of its style.
  const preset = clip.videoStyle && require('./styles').PRESETS[clip.videoStyle];
  if (preset?.style && Object.keys(preset.style).length) {
    const cur = clip.style || {}; const off = LOOK_KEYS.filter((k) => preset.style[k] !== undefined && JSON.stringify(cur[k]) !== JSON.stringify(preset.style[k]));
    if (off.length) { patch.style = require('../automation/pipeline').sanitizeStyle({ ...cur, ...Object.fromEntries(LOOK_KEYS.filter((k) => preset.style[k] !== undefined).map((k) => [k, preset.style[k]])) }); notes.push(`put the ${preset.label} font and look back (${off.slice(0, 4).join(', ')})`); }
  }
  if (v.captioned === false && words?.length) { patch._recaption = true; notes.push('added the captions (the transcript is ready now)'); }
  return { patch, notes };
}

/**
 * Called when a render has passed QC, before the clip goes to review. true = it's being rendered again with fixes
 * (review waits for that version).
 */
function maybe(clipId) {
  const clip = ctx.store.get('clips', clipId); if (!clip || clip.polish) return false;
  const client = ctx.store.get('clients', clip.clientId); if (!enabled(client)) return false;
  let words = null;
  try { const asset = ctx.store.get('assets', clip.assetId); words = asset ? require('../jobs/handlers').loadTranscript(asset)?.words || null : null; } catch { words = null; }
  const { patch, notes } = check(clip, { words });
  const at = new Date().toISOString();
  if (!notes.length) { ctx.store.update('clips', clipId, { polish: { at, notes: [], version: clip.currentVersion } }); return false; }
  delete patch._recaption;
  ctx.store.update('clips', clipId, { ...patch, polish: { at, notes, version: clip.currentVersion } });
  require('../core/audit').log('system', 'clip.polished', { clipId, clientId: clip.clientId, notes });
  require('../automation/pipeline').requestRender(ctx.store.get('clips', clipId), { reason: 'polish' });
  return true;
}

/** Polish clips already waiting in review (the button on Production): each one checked again, fixed ones re-rendered. */
function sweep(clientId) {
  let fixed = 0; let ok = 0;
  for (const c of ctx.store.all('clips', (x) => x.clientId === clientId && x.status === 'review' && x.kind !== 'broll' && x.kind !== 'story')) {
    ctx.store.update('clips', c.id, { polish: null });
    if (maybe(c.id)) fixed++; else ok++;
  }
  return { fixed, ok };
}

module.exports = { check, maybe, sweep, enabled };
