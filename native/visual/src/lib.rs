//! Euclidean's per-pixel preview work in Rust, compiled to WebAssembly (`renderer/vendor/visual.wasm`) and used by
//! `renderer/js/lib/transitions.js`. The Studio preview draws the soft transitions (soft wipes, diagonals, clock,
//! slats, irises, splits, dither dissolve) through a see-through mask made fresh every frame; these are FFmpeg xfade's
//! own formulas (the export makes the same picture), with P = 1 - elapsed, from 1 down to 0.
//! The JavaScript copy of each formula stays as the fallback, so the app works the same if this file can't load.
//! Build: `Build Visual.bat` / `npm run build:visual` (cargo build --release --target wasm32-unknown-unknown).

use std::alloc::{alloc as raw_alloc, dealloc as raw_dealloc, Layout};
use std::f64::consts::PI;

/// Memory for the page to write into / read from (bytes, 8-aligned).
#[no_mangle]
pub extern "C" fn alloc(n: usize) -> *mut u8 {
    unsafe { raw_alloc(Layout::from_size_align(n.max(1), 8).unwrap()) }
}

#[no_mangle]
pub extern "C" fn dealloc(ptr: *mut u8, n: usize) {
    unsafe { raw_dealloc(ptr, Layout::from_size_align(n.max(1), 8).unwrap()) }
}

#[inline(always)]
fn sstep(a: f64, b: f64, x: f64) -> f64 {
    let t = ((x - a) / (b - a)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}
#[inline(always)]
fn fract(a: f64) -> f64 {
    a - a.floor()
}
#[inline(always)]
fn frand(x: f64, y: f64) -> f64 {
    fract((x * 12.9898 + y * 78.233).sin() * 43758.545)
}

/// How much of the incoming clip shows at (x, y) of a w×h frame (kind: see transitions.js `MASK_KIND`).
#[inline(always)]
fn weight(kind: u32, x: f64, y: f64, w: f64, h: f64, p: f64) -> f64 {
    match kind {
        1 => if frand(x, y) < 1.0 - p { 1.0 } else { 0.0 },
        2 => sstep(0.0, 1.0, 1.0 + x / w - 2.0 * p),
        3 => sstep(0.0, 1.0, 1.0 + (w - 1.0 - x) / w - 2.0 * p),
        4 => sstep(0.0, 1.0, 1.0 + y / h - 2.0 * p),
        5 => sstep(0.0, 1.0, 1.0 + (h - 1.0 - y) / h - 2.0 * p),
        6 => sstep(0.0, 1.0, 1.0 + (x / w) * (y / h) - 2.0 * p),
        7 => sstep(0.0, 1.0, 1.0 + ((w - 1.0 - x) / w) * (y / h) - 2.0 * p),
        8 => sstep(0.0, 1.0, 1.0 + (x / w) * ((h - 1.0 - y) / h) - 2.0 * p),
        9 => sstep(0.0, 1.0, 1.0 + ((w - 1.0 - x) / w) * ((h - 1.0 - y) / h) - 2.0 * p),
        10 => sstep(0.0, 1.0, (x - (w / 2.0).floor()).atan2(y - (h / 2.0).floor()) - (p - 0.5) * PI * 2.5),
        11 => if sstep(-0.5, 0.0, x / w - p * 1.5) <= fract(10.0 * x / w) { 0.0 } else { 1.0 },
        12 => { let xx = (w - 1.0 - x) / w; if sstep(-0.5, 0.0, xx - p * 1.5) <= fract(10.0 * xx) { 0.0 } else { 1.0 } }
        13 => if sstep(-0.5, 0.0, y / h - p * 1.5) <= fract(10.0 * y / h) { 0.0 } else { 1.0 },
        14 => { let yy = (h - 1.0 - y) / h; if sstep(-0.5, 0.0, yy - p * 1.5) <= fract(10.0 * yy) { 0.0 } else { 1.0 } }
        15 | 16 => {
            let (cx, cy) = ((w / 2.0).floor(), (h / 2.0).floor());
            let r = (x - cx).hypot(y - cy) / cx.hypot(cy);
            if kind == 15 { 1.0 - sstep(0.0, 1.0, r + (p - 0.5) * 3.0) } else { sstep(0.0, 1.0, r + (0.5 - p) * 3.0) }
        }
        17 => sstep(0.0, 1.0, 2.0 - ((y - h / 2.0) / (h / 2.0)).abs() - 2.0 * p),
        18 => sstep(0.0, 1.0, 1.0 + ((y - h / 2.0) / (h / 2.0)).abs() - 2.0 * p),
        19 => sstep(0.0, 1.0, 2.0 - ((x - w / 2.0) / (w / 2.0)).abs() - 2.0 * p),
        20 => sstep(0.0, 1.0, 1.0 + ((x - w / 2.0) / (w / 2.0)).abs() - 2.0 * p),
        _ => 1.0,
    }
}

#[inline(always)]
fn alpha(v: f64, out: bool) -> u32 {
    let v = if out { 1.0 - v } else { v };
    ((255.0 * v.clamp(0.0, 1.0)).round() as u32) << 24 // little-endian RGBA: black with this alpha
}

/// Fill `buf` (w×h RGBA, w*h*4 bytes, 4-aligned) with a mask: black, alpha = how much of the clip shows (the outgoing
/// side when `out` is 1). p = xfade's progress (1 - elapsed). Wipes that only change along one direction are worked out
/// once per column or row and copied; everything else per pixel. The same numbers as `weight` (tests check it).
#[no_mangle]
pub extern "C" fn mask(kind: u32, p: f64, out: u32, w: u32, h: u32, buf: *mut u8) {
    let (wf, hf, o) = (w as f64, h as f64, out != 0);
    let (w, h) = (w as usize, h as usize);
    let px = unsafe { std::slice::from_raw_parts_mut(buf as *mut u32, w * h) };
    match kind {
        // Change across x only: one row, copied down.
        2 | 3 | 11 | 12 | 19 | 20 => {
            let row: Vec<u32> = (0..w).map(|x| alpha(weight(kind, x as f64, 0.0, wf, hf, p), o)).collect();
            for y in 0..h { px[y * w..(y + 1) * w].copy_from_slice(&row); }
        }
        // Change down y only: one value per row.
        4 | 5 | 13 | 14 | 17 | 18 => {
            for y in 0..h { let v = alpha(weight(kind, 0.0, y as f64, wf, hf, p), o); px[y * w..(y + 1) * w].fill(v); }
        }
        // Irises: distance from the middle without the slow precise hypot.
        15 | 16 => {
            let (cx, cy) = ((wf / 2.0).floor(), (hf / 2.0).floor());
            let inv = 1.0 / (cx * cx + cy * cy).sqrt(); let shift = if kind == 15 { (p - 0.5) * 3.0 } else { (0.5 - p) * 3.0 };
            for y in 0..h {
                let dy = y as f64 - cy; let dy2 = dy * dy;
                for x in 0..w {
                    let dx = x as f64 - cx; let s = sstep(0.0, 1.0, (dx * dx + dy2).sqrt() * inv + shift);
                    px[y * w + x] = alpha(if kind == 15 { 1.0 - s } else { s }, o);
                }
            }
        }
        // Dither: a whole-number hash per pixel (the same even spread of dots as xfade's, a different pattern).
        1 => {
            let keep = 1.0 - p;
            for y in 0..h {
                for x in 0..w {
                    let mut z = (x as u32).wrapping_mul(0x9E37_79B1) ^ (y as u32).wrapping_mul(0x85EB_CA77);
                    z ^= z >> 15; z = z.wrapping_mul(0x2C1B_3C6D); z ^= z >> 12; z = z.wrapping_mul(0x297A_2D39); z ^= z >> 15;
                    px[y * w + x] = alpha(if (z as f64) / 4_294_967_296.0 < keep { 1.0 } else { 0.0 }, o);
                }
            }
        }
        _ => {
            for y in 0..h { let yf = y as f64; for x in 0..w { px[y * w + x] = alpha(weight(kind, x as f64, yf, wf, hf, p), o); } }
        }
    }
}
