// Motion for the whole app: smooth page switches (View Transitions, built into the browser), lists that glide when items
// come and go (AutoAnimate, MIT, vendor/auto-animate.js), and springy popups (the browser's own animations with a spring
// curve, on the separate translate/scale properties so a popup's own centring transform is never touched).
// Settings → Appearance → Animations (or the computer's own "reduce motion" setting) turns all of it off.
import autoAnimate from '../../vendor/auto-animate.js';

const KEY = 'eu.reduceMotion';
export function reduced() {
  try { if (localStorage.getItem(KEY) === '1') return true; if (localStorage.getItem(KEY) === '0') return false; } catch { /* default */ }
  return !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}
export function setReduced(v) {
  try { localStorage.setItem(KEY, v ? '1' : '0'); } catch { /* ignore */ }
  document.documentElement.toggleAttribute('data-reduce-motion', !!v);
}

/** Run a change to the page as a View Transition (a soft cross-fade/slide), when the browser can and motion is on. */
export function transition(apply) {
  if (reduced() || !document.startViewTransition || document.hidden) { apply(); return; }
  try { document.startViewTransition(() => new Promise((done) => { apply(); requestAnimationFrame(() => requestAnimationFrame(done)); })); } catch { apply(); }
}

/** A damped spring as a CSS easing curve (linear() with 40 points): settles with a hint of overshoot. */
const SPRING = (() => {
  const k = 260, c = 22, m = 1; let x = 0, v = 0; const pts = []; const dt = 1 / 120; const total = 0.6;
  for (let t = 0, i = 0; t <= total + 1e-9; t += dt, i++) { const a = (k * (1 - x) - c * v) / m; v += a * dt; x += v * dt; if (i % 2 === 0) pts.push(x); }
  const step = Math.max(1, Math.floor(pts.length / 40)); const out = pts.filter((_, i) => i % step === 0); out[out.length - 1] = 1;
  return `linear(${out.map((p) => p.toFixed(3)).join(', ')})`;
})();
/** A popup or drawer arriving: fades in and springs into place from a little below (or the side). */
export function springIn(el, { from = 'up' } = {}) {
  if (!el || reduced() || !el.animate) return;
  try {
    el.style.animation = 'none'; // the plain CSS entrance is replaced by the spring
    el.animate({ opacity: [0, 1] }, { duration: 180, easing: 'ease-out' });
    el.animate(from === 'right' ? { translate: ['28px 0', '0 0'] } : { translate: ['0 12px', '0 0'], scale: ['0.98', '1'] }, { duration: 600, easing: SPRING });
  } catch { /* the CSS entrance stays */ }
}

/** Lists marked data-animate glide when items are added, removed or reordered (watched across the whole app). */
export function watchLists(root = document.body) {
  const done = new WeakSet();
  const hook = (el) => { if (done.has(el)) return; done.add(el); if (!reduced()) { try { autoAnimate(el, { duration: 220, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' }); } catch { /* ignore */ } } };
  root.querySelectorAll('[data-animate]').forEach(hook);
  new MutationObserver((muts) => { for (const m of muts) for (const n of m.addedNodes) { if (n.nodeType !== 1) continue; if (n.hasAttribute?.('data-animate')) hook(n); n.querySelectorAll?.('[data-animate]').forEach(hook); } }).observe(root, { childList: true, subtree: true });
}

export function initMotion() {
  document.documentElement.toggleAttribute('data-reduce-motion', reduced());
  watchLists();
}
