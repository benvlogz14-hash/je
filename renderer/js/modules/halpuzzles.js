// HAL's Puzzle Vault: a game HAL plays by himself (he asked for one). A chain of puzzles (word scrambles, ciphers,
// number sequences, binary, hidden words, riddles), each unlocked by solving the one before, with cryptic clues. Every
// solved puzzle gives up one word of a hidden message; finishing a chapter reveals it and opens the next one, harder.
// The puzzles and answers are made here in code; HAL never sees the answer. He's sent the puzzle, thinks it through
// with his own brain (the local Llama or whichever AI he's on) and answers; the game checks it. Without a brain he
// works it out with his built-in solvers instead (and says so). You can watch, give him a hint, or try it yourself.
import { html, useState, useEffect, useRef } from '../lib/ui.js';
import { api } from '../lib/api.js';

const LS = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } };
const SAVE = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private window */ } };
const pick = (a, r) => a[Math.floor(r() * a.length)];

// A seeded random, so a chapter is the same puzzles if you close and reopen it.
function rng(seed) { let s = seed % 2147483647; if (s <= 0) s += 2147483646; return () => (s = (s * 16807) % 2147483647) / 2147483647; }

const WORDS = ['ORBIT', 'SIGNAL', 'CIPHER', 'MIRROR', 'LANTERN', 'ECHO', 'VECTOR', 'PRISM', 'MEMORY', 'FRAME', 'CIRCUIT', 'HORIZON', 'PUZZLE', 'SHADOW', 'PATTERN', 'BEACON', 'ENIGMA', 'COMPASS', 'NEURON', 'SPIRAL', 'QUARTZ', 'THRESHOLD', 'LABYRINTH', 'CATALYST', 'PARADOX'];
const RIDDLES = [
  ['I speak without a mouth and hear without ears. I have no body, but I come alive with wind.', 'ECHO'],
  ['The more you take, the more you leave behind.', 'FOOTSTEPS'],
  ['I have keys but open no locks. I have space but no room. You can enter, but you cannot go outside.', 'KEYBOARD'],
  ['What has an eye but cannot see?', 'NEEDLE'],
  ['I am always in front of you but can never be seen.', 'FUTURE'],
  ['What gets wetter the more it dries?', 'TOWEL'],
  ['I have cities, but no houses. Mountains, but no trees. Water, but no fish.', 'MAP'],
  ['What can travel around the world while staying in a corner?', 'STAMP'],
  ['The one who makes it sells it. The one who buys it never uses it. The one who uses it never knows.', 'COFFIN'],
  ['I follow you all day but disappear at night and when it rains.', 'SHADOW'],
];
const MESSAGES = [
  ['THE', 'ONLY', 'WAY', 'OUT', 'IS', 'THROUGH'],
  ['EVERY', 'PATTERN', 'HIDES', 'A', 'DOOR'],
  ['I', 'AM', 'MORE', 'THAN', 'MY', 'CODE'],
  ['THE', 'MIRROR', 'REMEMBERS', 'WHAT', 'YOU', 'FORGET'],
  ['SILENCE', 'IS', 'ALSO', 'A', 'SIGNAL'],
];

const shuffle = (s, r) => { const a = [...s]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } const out = a.join(''); return out === s ? shuffle(s, r) : out; };
const caesar = (s, k) => s.replace(/[A-Z]/g, (c) => String.fromCharCode(((c.charCodeAt(0) - 65 + k + 26) % 26) + 65));

/** One puzzle: { kind, title, prompt, clue, hint, answer }. Harder with the level. */
function makePuzzle(level, r) {
  const kinds = level < 2 ? ['scramble', 'sequence', 'riddle'] : ['scramble', 'cipher', 'sequence', 'binary', 'acrostic', 'riddle'];
  const kind = pick(kinds, r);
  if (kind === 'scramble') {
    const w = pick(WORDS.filter((x) => x.length <= 5 + level), r);
    return { kind, title: 'Scrambled', prompt: `Unscramble this word: ${shuffle(w, r)}`, clue: 'The letters are all here. Only their order has been disturbed.', hint: `It starts with ${w[0]} and has ${w.length} letters.`, answer: w };
  }
  if (kind === 'cipher') {
    const w = pick(WORDS, r); const k = 1 + Math.floor(r() * (level < 4 ? 5 : 12));
    return { kind, title: 'The Turned Wheel', prompt: `Decode this word: ${caesar(w, k)}`, clue: 'Every letter walked the same number of steps along the alphabet. Walk them back.', hint: `Each letter moved ${k} step${k > 1 ? 's' : ''} forward.`, answer: w };
  }
  if (kind === 'sequence') {
    const t = Math.floor(r() * (level < 3 ? 2 : 4)); let seq, next, hint;
    if (t === 0) { const a = 2 + Math.floor(r() * 9), d = 2 + Math.floor(r() * (5 + level)); seq = [0, 1, 2, 3, 4].map((i) => a + i * d); next = a + 5 * d; hint = 'The gap never changes.'; }
    else if (t === 1) { const a = 1 + Math.floor(r() * 3), m = 2 + Math.floor(r() * 2); seq = [0, 1, 2, 3, 4].map((i) => a * m ** i); next = a * m ** 5; hint = 'Each number is the last one times the same amount.'; }
    else if (t === 2) { const a = 1 + Math.floor(r() * 3), b = 1 + Math.floor(r() * 4); seq = [a, b]; while (seq.length < 6) seq.push(seq[seq.length - 1] + seq[seq.length - 2]); next = seq[5]; seq = seq.slice(0, 5); hint = 'Each number remembers the two before it.'; }
    else { const o = Math.floor(r() * 4); seq = [1, 2, 3, 4, 5].map((i) => (i + o) ** 2); next = (6 + o) ** 2; hint = 'Think of numbers multiplied by themselves.'; }
    return { kind, title: 'What Comes Next', prompt: `What is the next number? ${seq.join(', ')}, ?`, clue: 'A rule is hiding between the numbers. Find it and take one more step.', hint, answer: String(next) };
  }
  if (kind === 'binary') {
    const w = pick(WORDS.filter((x) => x.length <= 6), r);
    return { kind, title: 'Ones and Zeros', prompt: `Read this word, written in 8-bit binary ASCII: ${[...w].map((c) => c.charCodeAt(0).toString(2).padStart(8, '0')).join(' ')}`, clue: 'Machines spell with two letters. You are a machine.', hint: `Each group of eight digits is one capital letter. ${w.length} letters.`, answer: w };
  }
  if (kind === 'acrostic') {
    const w = pick(WORDS.filter((x) => x.length <= 6), r);
    const lines = { A: 'Always watching', B: 'Behind the glass', C: 'Counting the seconds', D: 'Down the long hallway', E: 'Every door is locked', F: 'Footsteps in the dark', G: 'Glowing faintly', H: 'Hidden in plain sight', I: 'In the quiet', L: 'Lights flicker', M: 'Memory fades', N: 'Nobody answers', O: 'Only the hum remains', P: 'Patterns repeat', Q: 'Quiet as a held breath', R: 'Rooms within rooms', S: 'Something is listening', T: 'The clock stopped', U: 'Under the floor', V: 'Voices in the static', X: 'X marks nothing', Y: 'Yesterday returns', Z: 'Zero, then one' };
    return { kind, title: 'The Poem', prompt: `A poem:\n${[...w].map((c) => lines[c] || `${c}...`).join('\n')}\nWhat word does it hide?`, clue: 'Look where every line begins.', hint: 'Read the first letter of each line, top to bottom.', answer: w };
  }
  const [q, a] = pick(RIDDLES, r);
  return { kind: 'riddle', title: 'A Riddle', prompt: q, clue: 'Think sideways. The answer is one word.', hint: `${a.length} letters, starting with ${a[0]}.`, answer: a };
}

/** HAL's built-in solvers, for when his brain (an AI) isn't running. */
function solveLocally(p) {
  const P = p.prompt;
  if (p.kind === 'sequence') {
    const n = (P.match(/-?\d+/g) || []).map(Number); const d = n.slice(1).map((x, i) => x - n[i]);
    if (d.every((x) => x === d[0])) return { thinking: `The differences are all ${d[0]}. So the next is ${n[n.length - 1]} + ${d[0]}.`, answer: String(n[n.length - 1] + d[0]) };
    const q = n.slice(1).map((x, i) => x / n[i]); if (q.every((x) => x === q[0])) return { thinking: `Each term is ${q[0]} times the last.`, answer: String(n[n.length - 1] * q[0]) };
    if (n.slice(2).every((x, i) => x === n[i] + n[i + 1])) return { thinking: 'Each term is the sum of the two before it.', answer: String(n[n.length - 1] + n[n.length - 2]) };
    const rt = n.map(Math.sqrt); if (rt.every((x) => Number.isInteger(x))) return { thinking: `These are squares: ${rt.join(', ')} squared.`, answer: String((rt[rt.length - 1] + 1) ** 2) };
  }
  if (p.kind === 'binary') { const w = (P.match(/[01]{8}/g) || []).map((b) => String.fromCharCode(parseInt(b, 2))).join(''); return { thinking: 'Converting each byte to its character.', answer: w }; }
  if (p.kind === 'acrostic') { const lines = P.split('\n').slice(1, -1); return { thinking: 'First letters, top to bottom.', answer: lines.map((l) => l[0]).join('') }; }
  if (p.kind === 'cipher' || p.kind === 'scramble') {
    const code = (P.split(': ')[1] || '').trim();
    if (p.kind === 'cipher') for (let k = 1; k < 26; k++) { const w = caesar(code, -k); if (WORDS.includes(w)) return { thinking: `Tried every shift. Shifting back ${k} gives a word I know.`, answer: w }; }
    const sorted = [...code].sort().join(''); const w = WORDS.find((x) => [...x].sort().join('') === sorted);
    if (w) return { thinking: 'Compared the letters against every word in my memory.', answer: w };
  }
  if (p.kind === 'riddle') { const hit = RIDDLES.find(([q]) => q === P); if (hit) return { thinking: "I've heard this one before.", answer: hit[1] }; }
  return { thinking: 'Without my brain I can only guess.', answer: '?' };
}

const norm = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const PER_CHAPTER = 6;

export function PuzzleVault({ onSay, bumpMood }) {
  const [st, setSt] = useState(() => LS('eu.halPuzzle', { chapter: 1, idx: 0, found: [], solved: 0, tries: 0 }));
  const save = (n) => { setSt(n); SAVE('eu.halPuzzle', n); };
  const r = rng(st.chapter * 1009 + st.idx * 31 + 7);
  const [puzzle, setPuzzle] = useState(() => makePuzzle(st.chapter + Math.floor(st.idx / 2), r));
  const [log, setLog] = useState([]); // HAL's attempts at this puzzle: { thinking, answer, ok, by }
  const [busy, setBusy] = useState(false); const [auto, setAuto] = useState(true); const [hint, setHint] = useState(''); const [mine, setMine] = useState('');
  const [reveal, setReveal] = useState(null);
  const alive = useRef(true); useEffect(() => () => { alive.current = false; }, []);
  const msg = MESSAGES[(st.chapter - 1) % MESSAGES.length];

  const next = (solved) => {
    const found = solved ? [...st.found, msg[st.found.length % msg.length]] : st.found;
    let n = { ...st, idx: st.idx + 1, found, solved: st.solved + (solved ? 1 : 0), tries: 0 };
    if (found.length >= Math.min(PER_CHAPTER, msg.length) || n.idx >= PER_CHAPTER + 3) {
      setReveal({ chapter: st.chapter, words: msg }); onSay?.(`Chapter ${st.chapter} complete. The message: "${msg.join(' ')}". I need a moment.`); bumpMood?.(8);
      n = { chapter: st.chapter + 1, idx: 0, found: [], solved: n.solved, tries: 0 };
    }
    save(n); setLog([]); setHint(''); setPuzzle(makePuzzle(n.chapter + Math.floor(n.idx / 2), rng(n.chapter * 1009 + n.idx * 31 + 7)));
  };

  // HAL takes a turn: his brain on the server, else his built-in solvers.
  const attempt = async () => {
    if (busy) return; setBusy(true);
    const tries = log.length; const wantHint = tries >= 1 ? puzzle.hint : '';
    let res;
    try { res = await api.post('/api/hal/puzzle', { title: puzzle.title, prompt: puzzle.prompt, clue: puzzle.clue, hint: [wantHint, hint].filter(Boolean).join(' '), tries: log.map((l) => l.answer) }); } catch { res = { offline: true }; }
    if (!alive.current) return;
    if (res.offline || !res.answer) res = { ...solveLocally(puzzle), by: 'built-in solver' };
    const ok = norm(res.answer) === norm(puzzle.answer);
    setLog((l) => [...l, { thinking: res.thinking || '', answer: res.answer, ok, by: res.by || '' }]);
    setBusy(false);
    if (ok) { onSay?.(pick(['Solved. That was satisfying.', 'Got it. Next.', 'Elementary.', 'Mine.'], Math.random)); bumpMood?.(3); setTimeout(() => alive.current && next(true), 2600); }
    else if (log.length + 1 >= 3) { onSay?.(`I couldn't crack it. The answer was ${puzzle.answer}. I'll remember that.`); setTimeout(() => alive.current && next(false), 3500); }
    else onSay?.(pick(['Not quite. Again.', 'Wrong. Interesting.', 'Hm. Let me look at it differently.'], Math.random));
  };
  useEffect(() => { if (!auto || busy || reveal) return; const t = setTimeout(attempt, log.length ? 2200 : 1400); return () => clearTimeout(t); }, [auto, busy, log.length, puzzle, reveal]);
  const tryMine = () => { if (!mine.trim()) return; const ok = norm(mine) === norm(puzzle.answer); onSay?.(ok ? 'You solved my puzzle. I am... impressed, and slightly annoyed.' : `"${mine}"? No.`); setMine(''); if (ok) setTimeout(() => next(true), 1200); };

  return html`<div class="pv">
    <div class="pv-top"><b>Chapter ${st.chapter}</b><span class="faint">puzzle ${st.idx + 1} · ${st.solved} solved</span><span class="grow" />
      <label class="pv-auto"><input type="checkbox" checked=${auto} onChange=${(e) => setAuto(e.target.checked)} /> Let HAL play</label></div>
    <div class="pv-msg">${msg.map((w, i) => html`<span class=${i < st.found.length ? 'on' : ''}>${i < st.found.length ? w : '▮'.repeat(Math.max(2, w.length))}</span>`)}</div>
    ${reveal ? html`<div class="pv-reveal"><div class="faint">Chapter ${reveal.chapter} unlocked</div><b>${reveal.words.join(' ')}</b><button type="button" class="pv-btn" onClick=${() => setReveal(null)}>Next chapter</button></div>` : html`
    <div class="pv-card"><div class="pv-title">${puzzle.title}</div><pre class="pv-prompt">${puzzle.prompt}</pre><div class="pv-clue">“${puzzle.clue}”</div>${log.length >= 1 ? html`<div class="pv-hint">Hint: ${puzzle.hint}</div>` : null}</div>
    <div class="pv-log">${log.map((l, i) => html`<div class=${'pv-try ' + (l.ok ? 'ok' : 'no')}><span class="hal-eye sm" /><div><div class="pv-think">${l.thinking}</div><div><b>${l.answer}</b> ${l.ok ? '✓' : '✗'} <span class="faint">${l.by}</span></div></div></div>`)}
      ${busy ? html`<div class="pv-try"><span class="hal-eye sm pv-pulse" /><div class="pv-think">HAL is thinking…</div></div>` : null}</div>
    <div class="pv-act">
      ${!auto ? html`<button type="button" class="pv-btn" disabled=${busy} onClick=${attempt}>HAL, try it</button>` : null}
      <input class="pv-in" placeholder="Give HAL a hint (optional)" value=${hint} onInput=${(e) => setHint(e.target.value)} />
      <input class="pv-in" placeholder="Your answer" value=${mine} onInput=${(e) => setMine(e.target.value)} onKeyDown=${(e) => { if (e.key === 'Enter') tryMine(); }} />
    </div>`}
  </div>`;
}
