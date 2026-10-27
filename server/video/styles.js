'use strict';
/**
 * Video styles a client can switch between in Production (client.production.videoStyle). Picking one copies its
 * caption look and production settings onto that client only; every value can still be changed afterwards.
 *  - documentary: the narrator-led look of the best-performing Stringer short (drone opening under the voice, cuts every
 *    ~2-3 s, full-screen picture, big Montserrat captions two words at a time with key words in yellow, an all-caps title
 *    with a black outline at the top for the first ~6 s).
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
