// Interface sounds, synthesized with Web Audio (no sample files). Quiet by design.
let ctx = null; let enabled = true; let volume = 0.5;
try { const v = localStorage.getItem('eu.sound'); if (v !== null) enabled = v === '1'; } catch { /* storage unavailable */ }

function ac() {
  if (!ctx) { const C = window.AudioContext || window.webkitAudioContext; if (!C) return null; ctx = new C(); }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

function tone({ f = 880, f2, dur = 0.06, type = 'sine', gain = 0.06, at = 0, attack = 0.004 }) {
  const a = ac(); if (!a) return;
  const t = a.currentTime + at;
  const o = a.createOscillator(); const g = a.createGain();
  o.type = type; o.frequency.setValueAtTime(f, t);
  if (f2) o.frequency.exponentialRampToValueAtTime(f2, t + dur);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(gain * volume, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(a.destination);
  o.start(t); o.stop(t + dur + 0.02);
}

const SOUNDS = {
  tap: () => tone({ f: 1650, dur: 0.035, gain: 0.035, type: 'triangle' }),
  press: () => tone({ f: 420, f2: 300, dur: 0.05, gain: 0.05, type: 'sine' }),
  toggle: () => { tone({ f: 980, dur: 0.04, gain: 0.04 }); tone({ f: 1470, dur: 0.05, gain: 0.03, at: 0.035 }); },
  send: () => { tone({ f: 520, f2: 1240, dur: 0.14, gain: 0.05, type: 'sine' }); },
  receive: () => { tone({ f: 1046.5, dur: 0.16, gain: 0.05 }); tone({ f: 1568, dur: 0.22, gain: 0.04, at: 0.09 }); },
  success: () => { tone({ f: 784, dur: 0.12, gain: 0.04 }); tone({ f: 988, dur: 0.12, gain: 0.04, at: 0.07 }); tone({ f: 1318.5, dur: 0.2, gain: 0.04, at: 0.14 }); },
  error: () => { tone({ f: 260, f2: 190, dur: 0.18, gain: 0.07, type: 'triangle' }); },
  holdTick: () => tone({ f: 1200, dur: 0.02, gain: 0.02, type: 'triangle' }),
  confirm: () => { tone({ f: 660, dur: 0.08, gain: 0.05 }); tone({ f: 990, dur: 0.16, gain: 0.05, at: 0.06 }); },
  open: () => tone({ f: 700, f2: 980, dur: 0.07, gain: 0.03 }),
  close: () => tone({ f: 900, f2: 640, dur: 0.07, gain: 0.03 }),
};

export function play(name) { if (!enabled) return; try { (SOUNDS[name] || SOUNDS.tap)(); } catch { /* audio blocked */ } }
export function setSound(on) { enabled = !!on; try { localStorage.setItem('eu.sound', on ? '1' : '0'); } catch { /* ignore */ } if (on) play('toggle'); }
export function soundOn() { return enabled; }
