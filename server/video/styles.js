'use strict';
/**
 * Video styles a client can switch between in Production (client.production.videoStyle). Picking one copies its
 * caption look and production settings onto that client only; every value can still be changed afterwards.
 *  - documentary: the narrator-led look of the best-performing Stringer short (drone opening under the voice, cuts every
 *    ~2-3 s, full-screen picture, big Montserrat captions two words at a time with key words in yellow, an all-caps title
 *    with a black outline at the top for the first ~6 s).
 *  - walkthrough: Montserrat captions with the spoken word in gold, a bold TikTok Sans title.
 *  - highlights: TikTok's own text (TikTok Sans) for captions and title.
 *  - story: no voice; intense music and short text lines that drive the story (story.js), modelled on a 6M-view video.
 *  - custom: the client's own settings, untouched.
 */
const PRESETS = {
  documentary: {
    label: 'Documentary',
    blurb: 'Narrator over drone and B-roll, two-word captions with yellow key words, big title up top',
    style: { font: 'Montserrat', size: 150, uppercase: false, wordsPerLine: 2, primary: '#FFFFFF', highlight: '#F8D800', highlightMode: 'keywords', outline: '#000000', outlineWidth: 6, shadow: 3, position: 'lower', animation: 'none', box: false, rotate: 0,
      hook: true, hookSeconds: 6, hookFont: 'Montserrat', hookSize: 215, hookUpper: true, hookBox: false, hookColor: '#FFFFFF', hookOutline: '#000000', hookOutlineWidth: 9, hookShadow: 5, hookPosition: 'upper', hookTilt: 0, hookAnim: 'fade', hookRadius: 0 },
    production: { reframe: 'face', minClipSec: 22, maxClipSec: 40, visualCuts: true, punchIns: false },
  },
  walkthrough: {
    label: 'Walkthrough',
    blurb: 'Your best Stringer short: 3 words a line with the spoken word in gold, smaller captions, a bold TikTok title for 3 s',
    // Matched to "WHY DID they leave it all behind..." (caption and title widths measured from the video).
    style: { font: 'Montserrat', size: 120, uppercase: false, wordsPerLine: 3, primary: '#FFFFFF', highlight: '#F5B850', highlightMode: 'word', outline: '#000000', outlineWidth: 3, shadow: 3, position: 'lower', animation: 'none', box: false, rotate: 0,
      hook: true, hookSeconds: 3, hookFont: 'TikTok Sans Bold', hookSize: 144, hookUpper: false, hookCapsFirst: true, hookBox: false, hookColor: '#FFFFFF', hookOutline: '#000000', hookOutlineWidth: 4, hookShadow: 3, hookPosition: 'upper', hookTilt: 0, hookAnim: 'fade', hookRadius: 0 },
    production: {}, // look only: clip picking, length and cutting stay exactly as they are
  },
  highlights: {
    label: 'Highlights',
    blurb: 'The normal clip, tightened: the strongest moments back to back with the dead air cut, ending on a hook',
    // TikTok's own text (TikTok Sans): captions 3 words a line with the spoken word in yellow, a plain white title up top.
    // The rest of the difference is in picking and cutting (story cuts + an ending hook + tighter jump cuts).
    style: { font: 'TikTok Sans Bold', size: 110, uppercase: false, wordsPerLine: 3, primary: '#FFFFFF', highlight: '#FFE14D', highlightMode: 'word', outline: '#000000', outlineWidth: 4, shadow: 2, position: 'lower', animation: 'none', box: false, rotate: 0,
      hook: true, hookSeconds: 3, hookFont: 'TikTok Sans', hookSize: 150, hookUpper: false, hookCapsFirst: false, hookBox: false, hookColor: '#FFFFFF', hookOutline: '#000000', hookOutlineWidth: 3, hookShadow: 3, hookPosition: 'upper', hookTilt: 0, hookAnim: 'fade', hookRadius: 0 },
    production: {},
  },
  story: {
    label: 'Story text',
    blurb: 'No talking: intense music, text lines that tell the story, quick cuts of the best shots',
    style: {},
    production: { storySeconds: 45, storyMood: 'suspense' },
  },
};

function patchFor(id, client) {
  const p = PRESETS[id]; if (!p) return { production: { ...(client.production || {}), videoStyle: 'custom' } };
  return { style: { ...(client.style || {}), ...p.style }, production: { ...(client.production || {}), ...p.production, videoStyle: id } };
}

module.exports = { PRESETS, patchFor };
