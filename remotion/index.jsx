// Euclidean's motion-graphics political ads, drawn with Remotion (React → frames → MP4).
// The engine (server/political/adengine.js) bundles this folder once and renders the "PoliticalAd" composition with a
// spec it plans from the candidate's footage, transcript and research. Written for Euclidean; no third-party code.
import { registerRoot } from 'remotion';
import { Root } from './Root.jsx';

registerRoot(Root);
