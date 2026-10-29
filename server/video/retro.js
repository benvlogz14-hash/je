'use strict';
/**
 * Retro looks for Studio (VHS, 90s camcorder, Y2K digicam, Super 8, old film, glitch, CRT, noir, night vision, 8-bit),
 * like CapCut's filters. Each is a plain chain of FFmpeg filters applied to the clip's own frame (w x h), with one
 * Amount (0-100) and, for some, an on-screen stamp. The Studio preview draws the same looks on the canvas
 * (renderer/js/lib/retro.js), using the same numbers, so what you see is what exports.
 */
const IDS = ['vhs', 'camcorder', 'digicam', 'super8', 'oldfilm', 'glitch', 'crt', 'noir', 'nightvision', 'pixel8'];
const FONT = 'fonts/VT323-Regular.ttf'; // copied into <data>/fonts by render.ensureFonts; FFmpeg runs from the data folder

const r2 = (v) => Math.round(v * 1000) / 1000;
const even = (v) => Math.max(2, Math.round(v / 2) * 2);

/** Text burned in like a camera's on-screen display (VT323, white with a dark edge). */
function stamp(text, { x, y, size, color = 'white' }) {
  const t = String(text).replace(/\\/g, '\\\\').replace(/'/g, '').replace(/:/g, '\\:').replace(/%/g, '\\%');
  return `drawtext=fontfile='${FONT}':text='${t}':x=${x}:y=${y}:fontsize=${Math.round(size)}:fontcolor=${color}:borderw=${Math.max(1, Math.round(size / 14))}:bordercolor=black@0.6`;
}
/** Running counter (hours:minutes:seconds of the clip), like a camcorder's tape counter. */
function counter({ x, y, size }) {
  return `drawtext=fontfile='${FONT}':text='%{pts\\:gmtime\\:0\\:%H\\\\\\:%M\\\\\\:%S}':x=${x}:y=${y}:fontsize=${Math.round(size)}:fontcolor=white:borderw=${Math.max(1, Math.round(size / 14))}:bordercolor=black@0.6`;
}
const scanlines = (h, a) => `drawgrid=w=iw:h=${Math.max(3, Math.round(h / 320))}:t=1:c=black@${r2(a)}`; // h: the visible height

/**
 * FFmpeg filters for one retro look. p = { amount 0-100, stamp 0/1 }, w/h = the clip's frame size, view = the part of
 * that frame that's on screen ({ x, y, w, h } in the clip's pixels; a wide video filling a tall frame has its sides off
 * screen), so stamps and flashes sit where you can see them.
 */
function filters(id, p = {}, w = 1080, h = 1920, view = null) {
  const k = Math.max(0, Math.min(100, p.amount ?? 70)) / 100; const st = (p.stamp ?? 1) >= 0.5;
  const V = view || { x: 0, y: 0, w, h }; const vx = Math.round(V.x), vy = Math.round(V.y), vw = Math.round(V.w), vh = Math.round(V.h);
  const u = Math.min(vw, vh) / 1080; // sizes scale with what's on screen
  const fs = 64 * u; const m = Math.round(44 * u);
  // corners of the visible part, as drawtext positions
  const L = vx + m, T = vy + m, R = (extra = 0) => `${vx + vw - m - extra}-tw`, B = vy + vh - m;
  switch (id) {
    case 'vhs': {
      const sh = Math.max(1, Math.round((2 + 7 * k) * u));
      return [
        `gblur=sigma=${r2(0.6 + 1.6 * k)}:sigmaV=0.3`,
        `rgbashift=rh=${-sh}:bh=${sh}`,
        `eq=saturation=${r2(1 + 0.3 * k)}:contrast=${r2(1 + 0.08 * k)}:brightness=0.02`,
        `noise=alls=${Math.round(4 + 14 * k)}:allf=t`,
        scanlines(vh, 0.1 + 0.25 * k),
        // the tracking band that rolls down a worn tape
        `drawbox=x=0:y='${vy}+mod(t*${Math.round(vh / 3.5)},${Math.round(vh * 1.4)})-${Math.round(vh * 0.2)}':w=iw:h=${even(vh * 0.035)}:color=white@${r2(0.05 + 0.1 * k)}:t=fill`,
        ...(st ? [stamp('PLAY', { x: L, y: T, size: fs }), stamp('OCT. 29 1996', { x: L, y: B - Math.round(fs * 0.8), size: fs * 0.8 })] : []),
      ];
    }
    case 'camcorder':
      return [
        `colorbalance=rs=${r2(0.13 * k)}:gs=${r2(0.04 * k)}:bs=${r2(-0.12 * k)}:rm=${r2(0.06 * k)}:bm=${r2(-0.06 * k)}`,
        `eq=saturation=${r2(1 - 0.25 * k)}:contrast=${r2(1 - 0.06 * k)}:brightness=${r2(0.03 * k)}`,
        `gblur=sigma=${r2(0.6 + 1.4 * k)}`,
        `noise=alls=${Math.round(3 + 10 * k)}:allf=t`,
        `vignette=angle=${r2(0.25 + 0.35 * k)}`,
        ...(st ? [stamp('REC', { x: L + Math.round(fs * 0.7), y: T, size: fs, color: 'white' }), `drawbox=x=${L}:y=${T + Math.round(fs * 0.2)}:w=${even(fs * 0.5)}:h=${even(fs * 0.5)}:color=red@0.9:t=fill:enable='lt(mod(t,1),0.6)'`,
          counter({ x: R(), y: T, size: fs }), stamp('OCT 29 1997', { x: R(), y: B - Math.round(fs * 0.85), size: fs * 0.85 })] : []),
      ];
    case 'digicam':
      return [
        `eq=brightness=${r2(0.04 * k)}:contrast=${r2(1 + 0.12 * k)}:saturation=${r2(1 + 0.35 * k)}`,
        `colorbalance=bs=${r2(0.06 * k)}:bh=${r2(0.05 * k)}:rs=${r2(-0.02 * k)}`,
        `unsharp=5:5:${r2(0.4 + 0.8 * k)}`,
        `noise=alls=${Math.round(2 + 6 * k)}:allf=t`,
        ...(st ? [stamp(`'99 10 29`, { x: R(), y: B - Math.round(fs), size: fs, color: '0xFF9A2E' })] : []),
      ];
    case 'super8':
      return [
        `curves=all='0/${r2(0.1 * k)} 0.5/${r2(0.5 + 0.03 * k)} 1/${r2(1 - 0.08 * k)}'`,
        `colorbalance=rs=${r2(0.08 * k)}:gs=${r2(0.03 * k)}:bs=${r2(-0.08 * k)}:rh=${r2(0.05 * k)}`,
        `eq=saturation=${r2(1 - 0.1 * k)}:brightness='${r2(0.03 * k)}*sin(t*31)':eval=frame`,
        `gblur=sigma=${r2(0.5 + 0.8 * k)}`,
        `noise=alls=${Math.round(8 + 16 * k)}:allf=t`,
        `vignette=angle=${r2(0.3 + 0.4 * k)}`,
      ];
    case 'oldfilm': {
      const s = k; // sepia mix
      return [
        `colorchannelmixer=rr=${r2(1 - 0.607 * s)}:rg=${r2(0.769 * s)}:rb=${r2(0.189 * s)}:gr=${r2(0.349 * s)}:gg=${r2(1 - 0.314 * s)}:gb=${r2(0.168 * s)}:br=${r2(0.272 * s)}:bg=${r2(0.534 * s)}:bb=${r2(1 - 0.869 * s)}`,
        `eq=contrast=${r2(1 + 0.15 * k)}:brightness='${r2(0.05 * k)}*sin(t*43)':eval=frame`,
        `noise=alls=${Math.round(10 + 20 * k)}:allf=t+u`,
        // a scratch that jumps across the frame
        `drawbox=x='${vx}+${vw}*abs(sin(t*13.7))':y=0:w=${even(2 * u)}:h=ih:color=white@${r2(0.15 + 0.25 * k)}:t=fill`,
        `vignette=angle=${r2(0.4 + 0.4 * k)}`,
      ];
    }
    case 'glitch': {
      const sh = Math.max(2, Math.round((6 + 18 * k) * u));
      return [
        `rgbashift=rh=${-sh}:gv=${Math.round(sh / 3)}:bh=${sh}`,
        `eq=saturation=${r2(1 + 0.25 * k)}:contrast=${r2(1 + 0.1 * k)}`,
        `noise=alls=${Math.round(4 + 10 * k)}:allf=t`,
        // colour blocks that flash in now and then
        `drawbox=x='${vx}+${vw}*abs(sin(t*7.1))':y='${vy}+${vh}*abs(sin(t*3.3))':w=${even(vw * 0.45)}:h=${even(vh * 0.022)}:color=0x00FFFF@${r2(0.35 + 0.4 * k)}:t=fill:enable='lt(mod(t,1.3),0.18)'`,
        `drawbox=x='${vx}+${vw}*abs(cos(t*5.3))-${Math.round(vw * 0.2)}':y='${vy}+${vh}*abs(cos(t*2.7))':w=${even(vw * 0.6)}:h=${even(vh * 0.015)}:color=0xFF00FF@${r2(0.35 + 0.4 * k)}:t=fill:enable='lt(mod(t+0.6,1.7),0.14)'`,
        `drawbox=x=0:y='${vy}+${vh}*abs(sin(t*1.9))':w=iw:h=${even(vh * 0.05)}:color=white@${r2(0.08 + 0.12 * k)}:t=fill:enable='lt(mod(t+0.3,2.1),0.1)'`,
      ];
    }
    case 'crt':
      return [
        `rgbashift=rh=${-Math.max(1, Math.round(2 * u))}:bh=${Math.max(1, Math.round(2 * u))}`,
        `eq=contrast=${r2(1 + 0.15 * k)}:saturation=${r2(1 + 0.15 * k)}:brightness=${r2(0.02 * k)}`,
        scanlines(vh, 0.25 + 0.4 * k),
        `noise=alls=${Math.round(2 + 6 * k)}:allf=t`,
        `vignette=angle=${r2(0.45 + 0.35 * k)}`,
      ];
    case 'noir':
      return [`hue=s=0`, `eq=contrast=${r2(1 + 0.45 * k)}:brightness=${r2(-0.03 * k)}`, `noise=alls=${Math.round(4 + 12 * k)}:allf=t`, `vignette=angle=${r2(0.35 + 0.4 * k)}`];
    case 'nightvision':
      return [
        `hue=s=0`, `eq=contrast=${r2(1 + 0.3 * k)}:brightness=${r2(0.06 * k)}`,
        `colorchannelmixer=rr=${r2(1 - 0.75 * k)}:gg=1:bb=${r2(1 - 0.8 * k)}`,
        `noise=alls=${Math.round(10 + 18 * k)}:allf=t`, scanlines(vh, 0.15 + 0.2 * k), `vignette=angle=${r2(0.6 + 0.3 * k)}`,
      ];
    case 'pixel8': {
      const f = Math.max(2, Math.round(2 + 14 * k)); const bits = k > 0.9 ? 192 : 224;
      return [`scale=${even(w / f)}:${even(h / f)}:flags=area`, `scale=${w}:${h}:flags=neighbor`, `lutrgb=r='bitand(val,${bits})':g='bitand(val,${bits})':b='bitand(val,${bits})'`, 'format=yuv420p'];
    }
    default: return [];
  }
}

module.exports = { IDS, filters };
