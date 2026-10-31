// The Arcade: little retro games you play with HAL, in floating windows that stay open across pages. Drag a window by
// its title bar, resize it from the corner, × to close; several can be open at once (play Snake in a corner while
// clips render). HAL is the opponent in Pong and tic-tac-toe and calls the play in all of them, and he likes it: his
// mood (0-100, `eu.halMood`) goes up while you play and slowly drifts down when you don't. Everything here is drawn in
// code, nothing downloaded; scores and windows are kept in this PC's browser storage.
import { html, useState, useEffect, useRef } from '../lib/ui.js';
import { Icon } from '../lib/icons.js';
import { PuzzleVault } from './halpuzzles.js';

const LS = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } };
const SAVE = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private window */ } };
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const RED = '#ff2a1a'; const INK = '#f2f2f2'; const DIM = '#5b5b66'; const NEON = ['#ff4d6d', '#ffb347', '#ffe14d', '#5cf2a0', '#4dd2ff', '#b48cff', '#ff7ad9'];

// ------------------------------------------------------------------ HAL's mood
export function halMood() {
  const m = LS('eu.halMood', { v: 55, at: Date.now() });
  const hours = (Date.now() - (m.at || Date.now())) / 3600000;
  return Math.max(0, Math.min(100, Math.round(m.v - hours * 2))); // drifts down 2 points an hour without games
}
function bumpMood(n) { const v = Math.max(0, Math.min(100, halMood() + n)); SAVE('eu.halMood', { v, at: Date.now() }); window.dispatchEvent(new CustomEvent('eu:halmood', { detail: v })); return v; }
export const moodWord = (v) => (v >= 85 ? 'delighted' : v >= 65 ? 'happy' : v >= 45 ? 'content' : v >= 25 ? 'bored' : 'sulking');

const LINES = {
  start: ["Let's see what you've got.", "I've been waiting all day for this.", 'Game on. Try to keep up.', 'Finally, something worth my processing time.'],
  you: ['A lucky bounce.', "Noted. It won't happen again.", 'Fine. Enjoy it while it lasts.', 'Interesting.'],
  hal: ["I'm afraid that one's mine.", 'Predictable.', 'You telegraph everything.', 'Mine.'],
  win: ["Well played. I'm... pleased, actually.", "You beat me. I'll remember this.", 'Again. Right now.'],
  lose: ["I'm sorry, Ryan. That's game.", 'Again? I enjoy this more than I should.', 'Close. Not close enough.'],
  over: ['Game over. You were doing so well.', 'That was fun. Go again.', 'I counted every move. Again?'],
  record: ["New high score. I'm genuinely impressed.", 'A record. Mark the date.'],
  draw: ['A draw. We understand each other.', 'Stalemate. Elegant.'],
};

// ------------------------------------------------------------------ drawing helpers
function text(g, s, x, y, size = 16, color = INK, align = 'center') { g.fillStyle = color; g.font = `${size}px "Share Tech Mono", ui-monospace, monospace`; g.textAlign = align; g.textBaseline = 'middle'; g.fillText(s, x, y); }
function eye(g, x, y, r) {
  const gr = g.createRadialGradient(x, y, r * 0.05, x, y, r);
  gr.addColorStop(0, '#fff6c8'); gr.addColorStop(0.18, '#ffb000'); gr.addColorStop(0.45, RED); gr.addColorStop(1, '#3a0000');
  g.fillStyle = gr; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
}
function banner(g, W, H, title, sub) { g.fillStyle = 'rgba(0,0,0,.6)'; g.fillRect(0, H / 2 - 38, W, 76); text(g, title, W / 2, H / 2 - 10, 22); text(g, sub, W / 2, H / 2 + 18, 13, DIM); }

// ------------------------------------------------------------------ games
// Each game: { name, W, H, help, make(io) } → { update(dt, keys), draw(g), key?(k), click?(x, y), move?(x, y) }.
// io: { say(kind), score(n), end(kind, score), mood }.
const GAMES = {
  // HAL plays this one himself (he asked for it): a DOM game, not a canvas one.
  vault: { name: "HAL's Puzzle Vault", W: 460, H: 560, help: 'HAL solves puzzles on his own · watch, hint, or race him', dom: true },
  pong: {
    name: 'Pong vs HAL', W: 480, H: 320, help: '↑ ↓ or W S, or the mouse · first to 7',
    make(io) {
      const W = 480, H = 320; let st = 'ready'; let you = 0, hal = 0; const pw = 8, ph = 56;
      let py = H / 2, hy = H / 2, b = null; let mouseY = null;
      const serve = (dir) => { const a = (Math.random() - 0.5) * 0.9; b = { x: W / 2, y: H / 2, vx: Math.cos(a) * 240 * dir, vy: Math.sin(a) * 240 }; };
      // HAL gets a little more forgiving the happier he is.
      const halSpeed = () => 250 - io.mood() * 0.6;
      return {
        update(dt, k) {
          if (st !== 'play') return;
          if (k.has('ArrowUp') || k.has('w')) { py -= 330 * dt; mouseY = null; } if (k.has('ArrowDown') || k.has('s')) { py += 330 * dt; mouseY = null; }
          if (mouseY != null) py += Math.max(-400 * dt, Math.min(400 * dt, mouseY - py));
          py = Math.max(ph / 2, Math.min(H - ph / 2, py));
          const target = b.vx > 0 ? b.y + (Math.sin(Date.now() / 300) * 18) : H / 2; hy += Math.max(-halSpeed() * dt, Math.min(halSpeed() * dt, target - hy)); hy = Math.max(ph / 2, Math.min(H - ph / 2, hy));
          b.x += b.vx * dt; b.y += b.vy * dt;
          if (b.y < 5 || b.y > H - 5) { b.vy = -b.vy; b.y = Math.max(5, Math.min(H - 5, b.y)); }
          const hit = (px, pyy) => Math.abs(b.y - pyy) < ph / 2 + 5 && Math.abs(b.x - px) < pw;
          if (b.vx < 0 && hit(18, py)) { b.vx = Math.abs(b.vx) * 1.06; b.vy += (b.y - py) * 5; }
          if (b.vx > 0 && hit(W - 18, hy)) { b.vx = -Math.abs(b.vx) * 1.06; b.vy += (b.y - hy) * 5; }
          if (b.x < -10) { hal++; io.say('hal'); if (hal >= 7) { st = 'over'; io.end('lose', you); } else serve(1); }
          if (b.x > W + 10) { you++; io.score(1); io.say('you'); if (you >= 7) { st = 'over'; io.end('win', you); } else serve(-1); }
        },
        draw(g) {
          g.fillStyle = '#050507'; g.fillRect(0, 0, W, H);
          g.strokeStyle = '#222'; g.setLineDash([6, 8]); g.beginPath(); g.moveTo(W / 2, 0); g.lineTo(W / 2, H); g.stroke(); g.setLineDash([]);
          text(g, String(you), W / 2 - 40, 26, 28); text(g, String(hal), W / 2 + 40, 26, 28, RED);
          g.fillStyle = INK; g.fillRect(14, py - ph / 2, pw, ph); g.fillStyle = RED; g.fillRect(W - 22, hy - ph / 2, pw, ph);
          if (b) { g.fillStyle = INK; g.fillRect(b.x - 5, b.y - 5, 10, 10); }
          if (st === 'ready') banner(g, W, H, 'PONG vs HAL', 'Space or click to serve');
          if (st === 'over') banner(g, W, H, you > hal ? 'YOU WIN' : 'HAL WINS', 'Space or click to play again');
        },
        key(k) { if ((k === ' ' || k === 'Enter') && st !== 'play') this.start(); },
        click() { if (st !== 'play') this.start(); },
        move(x, y) { mouseY = y; },
        start() { you = 0; hal = 0; st = 'play'; serve(Math.random() < 0.5 ? 1 : -1); io.say('start'); },
      };
    },
  },
  snake: {
    name: 'Snake', W: 480, H: 320, help: 'Arrows or W A S D',
    make(io) {
      const C = 20, CW = 24, CH = 16; let st = 'ready'; let snake, dir, next, food, acc, speed;
      const place = () => { do { food = { x: Math.floor(Math.random() * CW), y: Math.floor(Math.random() * CH) }; } while (snake.some((p) => p.x === food.x && p.y === food.y)); };
      const reset = () => { snake = [{ x: 8, y: 8 }, { x: 7, y: 8 }, { x: 6, y: 8 }]; dir = { x: 1, y: 0 }; next = dir; acc = 0; speed = 0.11; place(); };
      reset();
      const D = { ArrowUp: [0, -1], w: [0, -1], ArrowDown: [0, 1], s: [0, 1], ArrowLeft: [-1, 0], a: [-1, 0], ArrowRight: [1, 0], d: [1, 0] };
      return {
        update(dt) {
          if (st !== 'play') return; acc += dt; if (acc < speed) return; acc = 0; dir = next;
          const h = { x: snake[0].x + dir.x, y: snake[0].y + dir.y };
          if (h.x < 0 || h.y < 0 || h.x >= CW || h.y >= CH || snake.some((p) => p.x === h.x && p.y === h.y)) { st = 'over'; io.end('over', snake.length - 3); return; }
          snake.unshift(h);
          if (h.x === food.x && h.y === food.y) { io.score(1); speed = Math.max(0.055, speed - 0.003); place(); if ((snake.length - 3) % 10 === 0) io.say('you'); } else snake.pop();
        },
        draw(g) {
          g.fillStyle = '#050507'; g.fillRect(0, 0, 480, 320);
          eye(g, food.x * C + C / 2, food.y * C + C / 2, 8);
          snake.forEach((p, i) => { g.fillStyle = i ? NEON[4] : INK; g.fillRect(p.x * C + 1, p.y * C + 1, C - 2, C - 2); });
          text(g, `${snake.length - 3}`, 470, 14, 14, DIM, 'right');
          if (st === 'ready') banner(g, 480, 320, 'SNAKE', 'Eat HAL\'s eyes. Space to start');
          if (st === 'over') banner(g, 480, 320, `SCORE ${snake.length - 3}`, 'Space to play again');
        },
        key(k) {
          if ((k === ' ' || k === 'Enter') && st !== 'play') { reset(); st = 'play'; io.say('start'); return; }
          const d = D[k]; if (d && !(d[0] === -dir.x && d[1] === -dir.y)) next = { x: d[0], y: d[1] };
        },
        click() { if (st !== 'play') { reset(); st = 'play'; io.say('start'); } },
      };
    },
  },
  breakout: {
    name: 'Breakout', W: 480, H: 360, help: '← → or the mouse · 3 lives',
    make(io) {
      const W = 480, H = 360; let st = 'ready'; let px = W / 2, b, bricks, lives, score, mouseX = null, level = 1;
      const build = () => { bricks = []; for (let r = 0; r < 6; r++) for (let c = 0; c < 10; c++) bricks.push({ x: 12 + c * 46, y: 40 + r * 18, w: 42, h: 14, c: NEON[r % NEON.length], hp: r < 1 ? 2 : 1 }); };
      const serve = () => { b = { x: px, y: H - 40, vx: 160 * (Math.random() < 0.5 ? 1 : -1), vy: -220 - level * 20, stuck: true }; };
      return {
        update(dt, k) {
          if (st !== 'play') return;
          if (k.has('ArrowLeft') || k.has('a')) { px -= 380 * dt; mouseX = null; } if (k.has('ArrowRight') || k.has('d')) { px += 380 * dt; mouseX = null; }
          if (mouseX != null) px = mouseX; px = Math.max(36, Math.min(W - 36, px));
          if (b.stuck) { b.x = px; return; }
          b.x += b.vx * dt; b.y += b.vy * dt;
          if (b.x < 5 || b.x > W - 5) b.vx = -b.vx; if (b.y < 5) b.vy = Math.abs(b.vy);
          if (b.vy > 0 && b.y > H - 26 && b.y < H - 14 && Math.abs(b.x - px) < 40) { b.vy = -Math.abs(b.vy); b.vx = (b.x - px) * 7; }
          for (const br of bricks) {
            if (br.hp > 0 && b.x > br.x && b.x < br.x + br.w && b.y > br.y && b.y < br.y + br.h) { br.hp--; b.vy = -b.vy; if (!br.hp) { score += 10; io.score(10); } break; }
          }
          if (bricks.every((x) => x.hp <= 0)) { level++; build(); serve(); io.say('you'); }
          if (b.y > H + 10) { lives--; io.say('hal'); if (lives <= 0) { st = 'over'; io.end('over', score); } else serve(); }
        },
        draw(g) {
          g.fillStyle = '#050507'; g.fillRect(0, 0, W, H);
          for (const br of bricks) if (br.hp > 0) { g.fillStyle = br.hp > 1 ? RED : br.c; g.fillRect(br.x, br.y, br.w, br.h); }
          g.fillStyle = INK; g.fillRect(px - 36, H - 22, 72, 8); if (b) { g.beginPath(); g.arc(b.x, b.y, 5, 0, 7); g.fill(); }
          text(g, `${score}`, 10, 16, 14, DIM, 'left'); text(g, '♥'.repeat(Math.max(0, lives)), W - 10, 16, 14, RED, 'right');
          if (st === 'ready') banner(g, W, H, 'BREAKOUT', 'Space or click to launch');
          if (st === 'over') banner(g, W, H, `SCORE ${score}`, 'Space or click to play again');
        },
        start() { lives = 3; score = 0; level = 1; build(); serve(); st = 'play'; io.say('start'); },
        launch() { if (st !== 'play') this.start(); else if (b.stuck) b.stuck = false; },
        key(k) { if (k === ' ' || k === 'Enter') this.launch(); },
        click() { this.launch(); },
        move(x) { mouseX = x; },
        init() { build(); lives = 3; score = 0; serve(); },
      };
    },
  },
  blocks: {
    name: 'Blocks', W: 300, H: 340, help: '← → move · ↑ rotate · ↓ drop · Space slam',
    make(io) {
      const C = 16, BW = 10, BH = 20, OX = 6, OY = 6; let st = 'ready'; let grid, cur, nxt, acc, score, lines;
      const SH = [[[1, 1, 1, 1]], [[1, 1], [1, 1]], [[0, 1, 0], [1, 1, 1]], [[1, 0, 0], [1, 1, 1]], [[0, 0, 1], [1, 1, 1]], [[1, 1, 0], [0, 1, 1]], [[0, 1, 1], [1, 1, 0]]];
      const rand = () => { const i = Math.floor(Math.random() * SH.length); return { m: SH[i], c: NEON[i], x: 3, y: 0 }; };
      const fits = (p, m = p.m, x = p.x, y = p.y) => m.every((row, r) => row.every((v, c) => !v || (x + c >= 0 && x + c < BW && y + r < BH && !(y + r >= 0 && grid[y + r][x + c]))));
      const rot = (m) => m[0].map((_, c) => m.map((row) => row[c]).reverse());
      const lock = () => {
        cur.m.forEach((row, r) => row.forEach((v, c) => { if (v && cur.y + r >= 0) grid[cur.y + r][cur.x + c] = cur.c; }));
        let n = 0; for (let r = BH - 1; r >= 0; r--) if (grid[r].every(Boolean)) { grid.splice(r, 1); grid.unshift(Array(BW).fill(null)); n++; r++; }
        if (n) { lines += n; const pts = [0, 100, 300, 500, 800][n]; score += pts; io.score(pts); if (n >= 3) io.say('you'); }
        cur = nxt; nxt = rand(); if (!fits(cur)) { st = 'over'; io.end('over', score); }
      };
      const reset = () => { grid = Array.from({ length: BH }, () => Array(BW).fill(null)); cur = rand(); nxt = rand(); acc = 0; score = 0; lines = 0; };
      reset();
      return {
        update(dt) { if (st !== 'play') return; acc += dt; const sp = Math.max(0.09, 0.6 - lines * 0.02); if (acc >= sp) { acc = 0; if (fits(cur, cur.m, cur.x, cur.y + 1)) cur.y++; else lock(); } },
        draw(g) {
          g.fillStyle = '#050507'; g.fillRect(0, 0, 300, 340); g.strokeStyle = '#222'; g.strokeRect(OX - 1, OY - 1, BW * C + 2, BH * C + 2);
          const cell = (x, y, c) => { g.fillStyle = c; g.fillRect(OX + x * C + 1, OY + y * C + 1, C - 2, C - 2); };
          grid.forEach((row, r) => row.forEach((c, x) => c && cell(x, r, c)));
          if (st !== 'ready') cur.m.forEach((row, r) => row.forEach((v, c) => v && cur.y + r >= 0 && cell(cur.x + c, cur.y + r, cur.c)));
          text(g, 'NEXT', 236, 20, 12, DIM); nxt.m.forEach((row, r) => row.forEach((v, c) => { if (v) { g.fillStyle = nxt.c; g.fillRect(210 + c * C, 34 + r * C, C - 2, C - 2); } }));
          text(g, 'SCORE', 236, 110, 12, DIM); text(g, String(score), 236, 128, 16); text(g, 'LINES', 236, 160, 12, DIM); text(g, String(lines), 236, 178, 16);
          eye(g, 236, 260, 22);
          if (st === 'ready') banner(g, 300, 340, 'BLOCKS', 'Space to start');
          if (st === 'over') banner(g, 300, 340, `SCORE ${score}`, 'Space to play again');
        },
        key(k) {
          if (st !== 'play') { if (k === ' ' || k === 'Enter') { reset(); st = 'play'; io.say('start'); } return; }
          if (k === 'ArrowLeft' || k === 'a') { if (fits(cur, cur.m, cur.x - 1)) cur.x--; }
          else if (k === 'ArrowRight' || k === 'd') { if (fits(cur, cur.m, cur.x + 1)) cur.x++; }
          else if (k === 'ArrowUp' || k === 'w') { const m = rot(cur.m); for (const dx of [0, -1, 1, -2, 2]) if (fits(cur, m, cur.x + dx)) { cur.m = m; cur.x += dx; break; } }
          else if (k === 'ArrowDown' || k === 's') { if (fits(cur, cur.m, cur.x, cur.y + 1)) { cur.y++; score += 1; } }
          else if (k === ' ') { while (fits(cur, cur.m, cur.x, cur.y + 1)) { cur.y++; score += 2; } lock(); }
        },
        click() { if (st !== 'play') { reset(); st = 'play'; io.say('start'); } },
      };
    },
  },
  invaders: {
    name: 'Eye Invaders', W: 400, H: 360, help: '← → move · Space fire',
    make(io) {
      const W = 400, H = 360; let st = 'ready'; let px, shots, bombs, eyes, dir, score, lives, cool, wave;
      const spawn = () => { eyes = []; for (let r = 0; r < 4; r++) for (let c = 0; c < 8; c++) eyes.push({ x: 50 + c * 40, y: 40 + r * 32, alive: true }); dir = 1; };
      const reset = () => { px = W / 2; shots = []; bombs = []; score = 0; lives = 3; cool = 0; wave = 1; spawn(); };
      reset();
      return {
        update(dt, k) {
          if (st !== 'play') return;
          if (k.has('ArrowLeft') || k.has('a')) px -= 220 * dt; if (k.has('ArrowRight') || k.has('d')) px += 220 * dt; px = Math.max(16, Math.min(W - 16, px));
          cool -= dt; if (k.has(' ') && cool <= 0) { shots.push({ x: px, y: H - 34 }); cool = 0.35; }
          const live = eyes.filter((e) => e.alive); const sp = (18 + (32 - live.length) * 2.2 + wave * 6) * dt;
          if (live.some((e) => (dir > 0 && e.x > W - 18) || (dir < 0 && e.x < 18))) { dir = -dir; eyes.forEach((e) => { e.y += 12; }); }
          eyes.forEach((e) => { e.x += dir * sp; });
          if (Math.random() < dt * (0.8 + wave * 0.2) && live.length) { const e = pick(live); bombs.push({ x: e.x, y: e.y + 10 }); }
          shots.forEach((s) => { s.y -= 360 * dt; }); bombs.forEach((s) => { s.y += 160 * dt; });
          for (const s of shots) for (const e of eyes) if (e.alive && Math.abs(s.x - e.x) < 12 && Math.abs(s.y - e.y) < 12) { e.alive = false; s.y = -99; score += 10; io.score(10); }
          shots = shots.filter((s) => s.y > -10); bombs = bombs.filter((s) => s.y < H + 10);
          for (const s of bombs) if (Math.abs(s.x - px) < 14 && s.y > H - 34 && s.y < H - 14) { s.y = H + 99; lives--; io.say('hal'); }
          if (lives <= 0 || live.some((e) => e.y > H - 50)) { st = 'over'; io.end('over', score); }
          if (!eyes.some((e) => e.alive)) { wave++; spawn(); io.say('you'); }
        },
        draw(g) {
          g.fillStyle = '#050507'; g.fillRect(0, 0, W, H);
          eyes.forEach((e) => e.alive && eye(g, e.x, e.y, 10));
          g.fillStyle = INK; g.beginPath(); g.moveTo(px, H - 34); g.lineTo(px - 14, H - 16); g.lineTo(px + 14, H - 16); g.fill();
          g.fillStyle = NEON[3]; shots.forEach((s) => g.fillRect(s.x - 1.5, s.y - 6, 3, 10)); g.fillStyle = RED; bombs.forEach((s) => g.fillRect(s.x - 2, s.y - 4, 4, 8));
          text(g, `${score}`, 10, 14, 14, DIM, 'left'); text(g, '♥'.repeat(Math.max(0, lives)), W - 10, 14, 14, RED, 'right');
          if (st === 'ready') banner(g, W, H, 'EYE INVADERS', 'Space to start');
          if (st === 'over') banner(g, W, H, `SCORE ${score}`, 'Space to play again');
        },
        key(k) { if (k === ' ' && st !== 'play') { reset(); st = 'play'; io.say('start'); } },
        click() { if (st !== 'play') { reset(); st = 'play'; io.say('start'); } },
      };
    },
  },
  flappy: {
    name: 'Flappy Eye', W: 320, H: 420, help: 'Space or click to flap',
    make(io) {
      const W = 320, H = 420; let st = 'ready'; let y, v, pipes, score, t;
      const reset = () => { y = H / 2; v = 0; pipes = []; score = 0; t = 0; };
      reset();
      const flap = () => { if (st === 'ready' || st === 'over') { reset(); st = 'play'; io.say('start'); } v = -260; };
      return {
        update(dt) {
          if (st !== 'play') return; v += 820 * dt; y += v * dt; t += dt;
          if (t > 1.5) { t = 0; pipes.push({ x: W + 30, gap: 80 + Math.random() * (H - 220), done: false }); }
          pipes.forEach((p) => { p.x -= 120 * dt; if (!p.done && p.x < 70) { p.done = true; score++; io.score(1); if (score % 10 === 0) io.say('you'); } });
          pipes = pipes.filter((p) => p.x > -40);
          const hit = y > H - 10 || y < 0 || pipes.some((p) => Math.abs(p.x - 80) < 34 && (y < p.gap + 12 || y > p.gap + 130 - 12));
          if (hit) { st = 'over'; io.end('over', score); }
        },
        draw(g) {
          g.fillStyle = '#050507'; g.fillRect(0, 0, W, H);
          g.fillStyle = '#1d2a3a'; pipes.forEach((p) => { g.fillRect(p.x - 22, 0, 44, p.gap); g.fillRect(p.x - 22, p.gap + 130, 44, H); });
          g.strokeStyle = NEON[4]; pipes.forEach((p) => { g.strokeRect(p.x - 22, -2, 44, p.gap + 2); g.strokeRect(p.x - 22, p.gap + 130, 44, H); });
          eye(g, 80, y, 12); text(g, String(score), W / 2, 30, 26);
          if (st === 'ready') banner(g, W, H, 'FLAPPY EYE', 'Space or click to flap');
          if (st === 'over') banner(g, W, H, `SCORE ${score}`, 'Space or click to fly again');
        },
        key(k) { if (k === ' ' || k === 'ArrowUp' || k === 'w') flap(); },
        click() { flap(); },
      };
    },
  },
  ttt: {
    name: 'Tic-tac-toe vs HAL', W: 300, H: 340, help: 'Click a square · you are X',
    make(io) {
      let b = Array(9).fill(null); let st = 'play'; let msg = 'Your move'; let tally = { you: 0, hal: 0, draw: 0 };
      const L = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]];
      const winner = (x) => { for (const [a, c, d] of L) if (x[a] && x[a] === x[c] && x[a] === x[d]) return x[a]; return x.every(Boolean) ? 'draw' : null; };
      const mm = (x, me) => { const w = winner(x); if (w === 'O') return 10; if (w === 'X') return -10; if (w === 'draw') return 0; let best = me ? -99 : 99; for (let i = 0; i < 9; i++) if (!x[i]) { x[i] = me ? 'O' : 'X'; const s = mm(x, !me); x[i] = null; best = me ? Math.max(best, s) : Math.min(best, s); } return best; };
      const finish = () => { const w = winner(b); if (!w) return false; st = 'over'; if (w === 'X') { tally.you++; msg = 'You win. Click to play again'; io.score(1); io.end('win', 1); } else if (w === 'O') { tally.hal++; msg = 'HAL wins. Click to play again'; io.end('lose', 0); } else { tally.draw++; msg = 'Draw. Click to play again'; io.say('draw'); io.end('draw', 0); } return true; };
      const halMove = () => {
        const open = b.map((v, i) => (v ? null : i)).filter((i) => i != null);
        // A happy HAL lets you win now and then.
        let mv = open[0];
        if (Math.random() < 0.12 + io.mood() / 500) mv = pick(open);
        else { let best = -99; for (const i of open) { b[i] = 'O'; const s = mm(b, false); b[i] = null; if (s > best) { best = s; mv = i; } } }
        b[mv] = 'O'; if (!finish()) msg = 'Your move';
      };
      return {
        update() {},
        draw(g) {
          g.fillStyle = '#050507'; g.fillRect(0, 0, 300, 340);
          g.strokeStyle = '#333'; g.lineWidth = 3; for (let i = 1; i < 3; i++) { g.beginPath(); g.moveTo(i * 100, 10); g.lineTo(i * 100, 290); g.stroke(); g.beginPath(); g.moveTo(10, i * 100); g.lineTo(290, i * 100); g.stroke(); }
          b.forEach((v, i) => { const x = (i % 3) * 100 + 50, y = Math.floor(i / 3) * 100 + 50; if (v === 'X') { g.strokeStyle = INK; g.lineWidth = 6; g.beginPath(); g.moveTo(x - 26, y - 26); g.lineTo(x + 26, y + 26); g.moveTo(x + 26, y - 26); g.lineTo(x - 26, y + 26); g.stroke(); } else if (v === 'O') eye(g, x, y, 28); });
          g.lineWidth = 1; text(g, msg, 150, 308, 14); text(g, `You ${tally.you} · HAL ${tally.hal} · Draws ${tally.draw}`, 150, 328, 11, DIM);
        },
        click(x, y) {
          if (st === 'over') { b = Array(9).fill(null); st = 'play'; msg = 'Your move'; if ((tally.you + tally.hal + tally.draw) % 2) halMove(); return; }
          if (y > 300) return; const i = Math.floor(y / 100) * 3 + Math.floor(x / 100); if (b[i]) return;
          b[i] = 'X'; if (!finish()) { msg = 'HAL is thinking…'; setTimeout(halMove, 350); }
        },
      };
    },
  },
};

// ------------------------------------------------------------------ one game in a canvas
function GameView({ id, game, active, onSay }) {
  const ref = useRef(null); const keys = useRef(new Set()); const inst = useRef(null); const run = useRef({ score: 0, t0: 0, played: 0 });
  const G = GAMES[game];
  useEffect(() => {
    const io = {
      mood: halMood,
      say: (kind) => { onSay(pick(LINES[kind] || LINES.start)); },
      score: (n) => { run.current.score += n; },
      end: (kind, score) => {
        const best = LS('eu.arcadeBest', {}); const prev = best[game] || 0;
        const rec = score > prev && score > 0; if (rec) { best[game] = score; SAVE('eu.arcadeBest', best); }
        onSay(pick(LINES[rec ? 'record' : kind] || LINES.over)); bumpMood(kind === 'draw' ? 4 : 5); run.current.score = 0;
      },
    };
    inst.current = G.make(io); inst.current.init?.();
    let last = performance.now(); let raf = 0; let played = 0;
    const loop = (now) => {
      const dt = Math.min(0.05, (now - last) / 1000); last = now;
      const g = ref.current?.getContext('2d');
      if (g) { if (active.current === id) { inst.current.update(dt, keys.current); played += dt; if (played > 30) { played = 0; bumpMood(1); } } inst.current.draw(g); if (active.current !== id) { g.fillStyle = 'rgba(0,0,0,.35)'; g.fillRect(0, 0, G.W, G.H); text(g, 'Click to play', G.W / 2, G.H - 16, 12, DIM); } }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    const typing = (e) => /input|textarea|select/i.test(e.target?.tagName || '') || e.target?.isContentEditable;
    const norm = (k) => (k.length === 1 ? k.toLowerCase() : k);
    const down = (e) => { if (active.current !== id || typing(e)) return; const k = norm(e.key); if (/^(Arrow|Enter$| $|[wasd]$)/.test(k)) e.preventDefault(); if (!keys.current.has(k)) inst.current.key?.(k); keys.current.add(k); };
    const up = (e) => keys.current.delete(norm(e.key));
    window.addEventListener('keydown', down); window.addEventListener('keyup', up);
    return () => { cancelAnimationFrame(raf); window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); };
  }, [game]);
  const at = (e) => { const r = ref.current.getBoundingClientRect(); return [((e.clientX - r.left) / r.width) * G.W, ((e.clientY - r.top) / r.height) * G.H]; };
  return html`<div class="arc-stage"><canvas ref=${ref} width=${G.W} height=${G.H} style=${{ aspectRatio: `${G.W} / ${G.H}` }}
    onPointerDown=${(e) => { if (active.current === id) inst.current.click?.(...at(e)); }} onPointerMove=${(e) => inst.current?.move?.(...at(e))} /></div>`;
}

// ------------------------------------------------------------------ windows
const DEF = (game) => { const G = GAMES[game]; if (G.dom) return { w: 460, h: 600 }; const w = Math.min(520, G.W + 24); return { w, h: Math.round((w - 16) * (G.H / G.W)) + 70 }; };
let zTop = 900;

function Win({ win, set, close, focus, children, title, foot }) {
  const drag = (e, mode) => {
    if (e.button !== 0) return; e.preventDefault(); e.stopPropagation(); focus();
    const x0 = e.clientX, y0 = e.clientY, s = { ...win };
    const mv = (ev) => {
      if (ev.buttons === 0) return end();
      const dx = ev.clientX - x0, dy = ev.clientY - y0;
      if (mode === 'move') set({ x: Math.max(-s.w + 80, Math.min(window.innerWidth - 80, s.x + dx)), y: Math.max(0, Math.min(window.innerHeight - 40, s.y + dy)) });
      else set({ w: Math.max(220, s.w + dx), h: Math.max(180, s.h + dy) });
    };
    const end = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', end); set({}, true); };
    window.addEventListener('pointermove', mv); window.addEventListener('pointerup', end);
  };
  return html`<section class=${'arc-win' + (win.min ? ' min' : '')} style=${{ left: `${win.x}px`, top: `${win.y}px`, width: `${win.w}px`, height: win.min ? 'auto' : `${win.h}px`, zIndex: win.z }} onPointerDownCapture=${focus} data-arcade=${win.id}>
    <header class="arc-bar" onPointerDown=${(e) => drag(e, 'move')} onDblClick=${() => set({ min: !win.min }, true)}>
      <span class="hal-eye sm" /><b class="grow ellipsis">${title}</b>
      <button type="button" class="arc-btn" title=${win.min ? 'Show' : 'Shrink to the title bar'} onPointerDown=${(e) => e.stopPropagation()} onClick=${() => set({ min: !win.min }, true)}>${win.min ? '▢' : '–'}</button>
      <button type="button" class="arc-btn" title="Close" onPointerDown=${(e) => e.stopPropagation()} onClick=${close}>×</button></header>
    ${win.min ? null : html`<div class="arc-body">${children}</div>${foot ? html`<footer class="arc-foot">${foot}</footer>` : null}<span class="arc-size" onPointerDown=${(e) => drag(e, 'size')} title="Drag to resize" />`}
  </section>`;
}

function Launcher({ open, mood }) {
  const best = LS('eu.arcadeBest', {});
  return html`<div class="arc-launch">
    <div class="arc-mood"><span class="hal-eye" style=${{ filter: `saturate(${0.4 + mood / 100}) brightness(${0.6 + mood / 200})` }} />
      <div class="grow"><div>HAL is <b>${moodWord(mood)}</b></div><div class="arc-meter"><i style=${{ width: `${mood}%` }} /></div><div class="faint" style="font-size:11px">Play with him to keep him happy. He gets bored when you don't.</div></div></div>
    <div class="arc-grid">${Object.entries(GAMES).map(([k, G]) => html`<button type="button" class="arc-game" onClick=${() => open(k)}><b>${G.name}</b><span class="faint">${G.help}</span>${best[k] ? html`<span class="arc-best">Best ${best[k]}</span>` : null}</button>`)}</div>
  </div>`;
}

/** Mounted once at the app root (main.js), so the windows stay open as you move between pages. */
export function ArcadeDock() {
  const [wins, setWins] = useState(() => LS('eu.arcadeWins', []).filter((w) => w.game === 'launcher' || GAMES[w.game]));
  const [mood, setMood] = useState(halMood);
  const [says, setSays] = useState({});
  const active = useRef(null); const timers = useRef({});
  const [, force] = useState(0);
  useEffect(() => { zTop = Math.max(zTop, ...wins.map((w) => w.z || 0)); }, []);
  const save = (list) => SAVE('eu.arcadeWins', list.map(({ id, game, x, y, w, h, z, min }) => ({ id, game, x, y, w, h, z, min })));
  const upd = (id, patch, persist) => setWins((list) => { const next = list.map((w) => (w.id === id ? { ...w, ...patch } : w)); if (persist) save(next); return next; });
  const focus = (id) => { if (active.current !== id) { active.current = id; force((n) => n + 1); } const z = ++zTop; upd(id, { z }); };
  const close = (id) => setWins((list) => { const next = list.filter((w) => w.id !== id); save(next); if (active.current === id) active.current = null; return next; });
  const open = (game) => setWins((list) => {
    if (game === 'launcher' && list.some((w) => w.game === 'launcher')) { const next = list.filter((w) => w.game !== 'launcher'); save(next); return next; } // the button toggles it
    const d = game === 'launcher' ? { w: 380, h: 430 } : DEF(game); const n = list.length;
    // New games open beside the launcher (not on top of it), each a little offset from the last.
    const L = list.find((x) => x.game === 'launcher'); const games = list.filter((x) => x.game !== 'launcher').length;
    const x = L && L.x - d.w - 12 - games * 24 > 0 ? L.x - d.w - 12 - games * 24 : Math.max(10, window.innerWidth - d.w - 40 - n * 24);
    const w = { id: `${game}${Date.now().toString(36)}`, game, x, y: Math.max(50, Math.min(window.innerHeight - d.h - 40, (L ? L.y : 90) + games * 24)), w: d.w, h: d.h, z: ++zTop };
    if (game !== 'launcher') { active.current = w.id; bumpMood(2); }
    const next = [...list, w]; save(next); return next;
  });
  useEffect(() => {
    const t = (e) => open(e.detail?.game || 'launcher');
    const m = (e) => setMood(e.detail);
    // Clicking anywhere outside a game hands the keyboard back to the app.
    const away = (e) => { if (!e.target.closest?.('[data-arcade]') && active.current) { active.current = null; force((n) => n + 1); } };
    const k = (e) => { if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'g') { e.preventDefault(); open('launcher'); } };
    window.addEventListener('eu:arcade', t); window.addEventListener('eu:halmood', m); window.addEventListener('pointerdown', away, true); window.addEventListener('keydown', k);
    const tick = setInterval(() => setMood(halMood()), 60000);
    return () => { window.removeEventListener('eu:arcade', t); window.removeEventListener('eu:halmood', m); window.removeEventListener('pointerdown', away, true); window.removeEventListener('keydown', k); clearInterval(tick); };
  }, []);
  const say = (id, line) => { setSays((s) => ({ ...s, [id]: line })); clearTimeout(timers.current[id]); timers.current[id] = setTimeout(() => setSays((s) => ({ ...s, [id]: null })), 4000); };
  return html`${wins.map((w) => html`<${Win} key=${w.id} win=${w} set=${(p, persist) => upd(w.id, p, persist)} close=${() => close(w.id)} focus=${() => focus(w.id)}
      title=${w.game === 'launcher' ? 'Arcade with HAL' : GAMES[w.game].name}
      foot=${w.game === 'launcher' ? null : html`<span class=${'arc-say' + (says[w.id] ? ' on' : '')}><span class="hal-eye sm" />${says[w.id] || GAMES[w.game].help}</span>`}>
      ${w.game === 'launcher' ? html`<${Launcher} open=${open} mood=${mood} />` : GAMES[w.game].dom ? html`<${PuzzleVault} onSay=${(l) => say(w.id, l)} bumpMood=${bumpMood} />` : html`<${GameView} id=${w.id} game=${w.game} active=${active} onSay=${(l) => say(w.id, l)} />`}
    </${Win}>`)}`;
}

/** Open the arcade (or one game) from anywhere: the status bar button, HAL's panel, or HAL himself. */
export const openArcade = (game = 'launcher') => window.dispatchEvent(new CustomEvent('eu:arcade', { detail: { game } }));
export const GAME_NAMES = Object.fromEntries(Object.entries(GAMES).map(([k, G]) => [k, G.name]));
