/**
 * Reading the text out of a PDF, in plain Node (no extra programs or packages), so a GrokBot export, a winners list,
 * a brief or any saved PDF can be dropped into the Data tab or read by a bot.
 *
 * Handles what Chrome/Edge ("Save as PDF"), WeasyPrint, Word and most exporters write: objects (also inside object
 * streams), Flate-compressed content, Type0/Identity-H and simple fonts with their ToUnicode maps and glyph widths,
 * the text and graphics matrices (BT/ET, Tm, Td, TD, T*, TL, cm, q/Q), Tj/TJ/'/". Text runs are put back into lines
 * by their position on the page (top to bottom, left to right), with a space where the gap is wider than a space.
 * Not handled: encrypted PDFs (they say so), scanned pages (no text to read), LZW/JBIG2 streams.
 */
const zlib = require('zlib');

function inflate(buf) {
  for (const f of [zlib.inflateSync, zlib.inflateRawSync]) { try { return f(buf); } catch { /* next */ } }
  // Some writers add junk after the data: take what decodes.
  try { return zlib.inflateSync(buf, { finishFlush: zlib.constants.Z_SYNC_FLUSH }); } catch { return Buffer.alloc(0); }
}

// ------------------------------------------------------------------ tokens and objects

const WS = new Set([0, 9, 10, 12, 13, 32]);
const DELIM = new Set('()<>[]{}/%'.split('').map((c) => c.charCodeAt(0)));

/** A small PDF object parser over a Buffer: numbers, names, strings (as Buffers), arrays, dicts, refs, operators. */
function Lexer(buf, pos = 0) {
  this.b = buf; this.p = pos;
}
Lexer.prototype.skip = function skip() {
  const b = this.b;
  for (;;) {
    while (this.p < b.length && WS.has(b[this.p])) this.p++;
    if (b[this.p] === 37) { while (this.p < b.length && b[this.p] !== 10 && b[this.p] !== 13) this.p++; continue; }
    return;
  }
};
Lexer.prototype.next = function next() {
  this.skip(); const b = this.b; if (this.p >= b.length) return null;
  const c = b[this.p];
  if (c === 47) { // name
    let s = ''; this.p++;
    while (this.p < b.length && !WS.has(b[this.p]) && !DELIM.has(b[this.p])) {
      if (b[this.p] === 35 && /[0-9a-f]{2}/i.test(String.fromCharCode(b[this.p + 1], b[this.p + 2]))) { s += String.fromCharCode(parseInt(String.fromCharCode(b[this.p + 1], b[this.p + 2]), 16)); this.p += 3; } else s += String.fromCharCode(b[this.p++]);
    }
    return { n: s };
  }
  if (c === 40) return { s: this.literal() };
  if (c === 60 && b[this.p + 1] === 60) { this.p += 2; return { op: '<<' }; }
  if (c === 62 && b[this.p + 1] === 62) { this.p += 2; return { op: '>>' }; }
  if (c === 60) { // hex string
    this.p++; let h = '';
    while (this.p < b.length && b[this.p] !== 62) { const ch = String.fromCharCode(b[this.p++]); if (/[0-9a-f]/i.test(ch)) h += ch; }
    this.p++; if (h.length % 2) h += '0';
    return { s: Buffer.from(h, 'hex') };
  }
  if (c === 91 || c === 93 || c === 123 || c === 125) { this.p++; return { op: String.fromCharCode(c) }; }
  let s = '';
  while (this.p < b.length && !WS.has(b[this.p]) && !DELIM.has(b[this.p])) s += String.fromCharCode(b[this.p++]);
  if (!s) { this.p++; return { op: String.fromCharCode(c) }; }
  if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(s)) return { v: parseFloat(s) };
  if (s === 'true' || s === 'false') return { v: s === 'true' };
  if (s === 'null') return { v: null };
  return { op: s };
};
Lexer.prototype.literal = function literal() {
  const b = this.b; this.p++; const out = []; let depth = 1;
  while (this.p < b.length) {
    const c = b[this.p++];
    if (c === 92) {
      const d = b[this.p++];
      const map = { 110: 10, 114: 13, 116: 9, 98: 8, 102: 12, 40: 40, 41: 41, 92: 92 };
      if (map[d] !== undefined) out.push(map[d]);
      else if (d >= 48 && d <= 55) { let o = d - 48; for (let k = 0; k < 2 && b[this.p] >= 48 && b[this.p] <= 55; k++) o = o * 8 + (b[this.p++] - 48); out.push(o & 255); }
      else if (d === 13) { if (b[this.p] === 10) this.p++; } else if (d !== 10) out.push(d);
      continue;
    }
    if (c === 40) depth++;
    if (c === 41 && --depth === 0) break;
    out.push(c);
  }
  return Buffer.from(out);
};
/** One full value (array/dict/ref aware). */
Lexer.prototype.value = function value(tok = this.next()) {
  if (!tok) return null;
  if (tok.op === '[') { const a = []; for (;;) { const t = this.next(); if (!t || t.op === ']') break; a.push(this.value(t)); } return a; }
  if (tok.op === '<<') {
    const d = {};
    for (;;) { const k = this.next(); if (!k || k.op === '>>') break; if (k.n === undefined) continue; d[k.n] = this.value(); }
    return { dict: d };
  }
  if (tok.v !== undefined && typeof tok.v === 'number' && Number.isInteger(tok.v)) {
    // "12 0 R"
    const save = this.p; const t2 = this.next(); const t3 = t2 && this.next();
    if (t2 && t2.v !== undefined && Number.isInteger(t2.v) && t3 && t3.op === 'R') return { ref: tok.v };
    this.p = save;
  }
  return tok;
};

function readObjects(buf) {
  const objs = new Map();
  const text = buf.toString('latin1');
  const re = /(\d+)\s+(\d+)\s+obj\b/g; let m;
  while ((m = re.exec(text))) {
    const num = +m[1]; const lx = new Lexer(buf, m.index + m[0].length);
    let val; try { val = lx.value(); } catch { continue; }
    let stream = null;
    lx.skip();
    if (text.startsWith('stream', lx.p)) {
      let s = lx.p + 6; if (buf[s] === 13) s++; if (buf[s] === 10) s++;
      const len = val?.dict?.Length;
      let e = typeof len?.v === 'number' && text.startsWith('endstream', skipWs(buf, s + len.v)) ? s + len.v : text.indexOf('endstream', s);
      if (e < 0) e = buf.length;
      stream = buf.subarray(s, e);
      re.lastIndex = e;
    }
    objs.set(num, { val, stream });
  }
  // Objects inside object streams.
  for (const [, o] of [...objs]) {
    if (o.val?.dict?.Type?.n !== 'ObjStm' || !o.stream) continue;
    const data = decode(o, objs); const n = o.val.dict.N?.v || 0; const first = o.val.dict.First?.v || 0;
    const lx = new Lexer(data, 0); const pairs = [];
    for (let i = 0; i < n; i++) { const a = lx.next(); const b = lx.next(); if (!a || !b) break; pairs.push([a.v, b.v]); }
    for (const [num, off] of pairs) { if (objs.has(num) && objs.get(num).stream) continue; try { const v = new Lexer(data, first + off).value(); objs.set(num, { val: v, stream: null }); } catch { /* skip */ } }
  }
  return objs;
}
function skipWs(buf, p) { while (p < buf.length && WS.has(buf[p])) p++; return p; }

function resolve(v, objs, depth = 0) { while (v && v.ref !== undefined && depth++ < 20) v = objs.get(v.ref)?.val; return v; }
function decode(o, objs) {
  if (!o?.stream) return Buffer.alloc(0);
  let f = resolve(o.val?.dict?.Filter, objs); if (!f) return o.stream;
  const list = Array.isArray(f) ? f.map((x) => resolve(x, objs)?.n) : [f.n];
  let data = o.stream;
  for (const name of list) {
    if (name === 'FlateDecode' || name === 'Fl') data = inflate(data);
    else if (name === 'ASCIIHexDecode') data = Buffer.from(data.toString('latin1').replace(/[^0-9a-f]/gi, ''), 'hex');
    else return Buffer.alloc(0); // images and the rarer filters carry no text we can read
  }
  return data;
}

// ------------------------------------------------------------------ fonts

function parseCMap(data) {
  const map = new Map(); let bytes = 1;
  const t = data.toString('latin1');
  const u16 = (hex) => { const b = Buffer.from(hex.length % 4 ? hex.padStart(hex.length + (4 - (hex.length % 4)), '0') : hex, 'hex'); let s = ''; for (let i = 0; i + 1 < b.length; i += 2) s += String.fromCharCode(b.readUInt16BE(i)); return s; };
  const cs = /begincodespacerange\s*<([0-9a-fA-F]+)>/.exec(t); if (cs) bytes = cs[1].length / 2;
  for (const blk of t.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) for (const m of blk[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g)) map.set(parseInt(m[1], 16), u16(m[2]));
  for (const blk of t.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const m of blk[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(<([0-9a-fA-F]+)>|\[([^\]]*)\])/g)) {
      const a = parseInt(m[1], 16); const b = parseInt(m[2], 16);
      if (b - a > 65535) continue;
      if (m[4] !== undefined) { const base = u16(m[4]); const last = base.charCodeAt(base.length - 1); for (let c = a; c <= b; c++) map.set(c, base.slice(0, -1) + String.fromCharCode(last + (c - a))); }
      else { const items = [...m[5].matchAll(/<([0-9a-fA-F]*)>/g)].map((x) => u16(x[1])); for (let c = a; c <= b && c - a < items.length; c++) map.set(c, items[c - a]); }
    }
  }
  return { map, bytes };
}

const WIN = (() => { // the common WinAnsi extras over Latin-1
  const m = {}; const extra = { 128: '€', 130: '‚', 131: 'ƒ', 132: '„', 133: '…', 134: '†', 135: '‡', 136: 'ˆ', 137: '‰', 138: 'Š', 139: '‹', 140: 'Œ', 142: 'Ž', 145: '‘', 146: '’', 147: '“', 148: '”', 149: '•', 150: '–', 151: '—', 152: '˜', 153: '™', 154: 'š', 155: '›', 156: 'œ', 158: 'ž', 159: 'Ÿ' };
  for (let i = 0; i < 256; i++) m[i] = extra[i] || String.fromCharCode(i); return m;
})();
const GLYPH = { space: ' ', bullet: '•', endash: '–', emdash: '—', quoteright: '’', quoteleft: '‘', quotedblleft: '“', quotedblright: '”', hyphen: '-', period: '.', comma: ',', colon: ':', semicolon: ';', ellipsis: '…', fi: 'fi', fl: 'fl', ampersand: '&', at: '@', slash: '/', parenleft: '(', parenright: ')', dollar: '$', percent: '%', numbersign: '#', plus: '+', equal: '=', question: '?', exclam: '!', quotesingle: "'", quotedbl: '"', underscore: '_', zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9' };

function fontOf(ref, objs, cache) {
  const key = ref?.ref ?? JSON.stringify(ref);
  if (cache.has(key)) return cache.get(key);
  const d = resolve(ref, objs)?.dict || {};
  const f = { two: resolve(d.Subtype, objs)?.n === 'Type0', map: null, widths: new Map(), dw: 1000, first: 0, enc: {}, unit: 1 / 1000 };
  // Type3 fonts (Chrome writes these) give widths in their own glyph space.
  const fm = resolve(d.FontMatrix, objs); if (resolve(d.Subtype, objs)?.n === 'Type3' && Array.isArray(fm)) f.unit = Math.abs(resolve(fm[0], objs)?.v || 0.001);
  const tu = d.ToUnicode && objs.get(d.ToUnicode.ref);
  if (tu) { const cm = parseCMap(decode(tu, objs)); f.map = cm.map; if (!f.two) f.two = cm.bytes === 2; }
  if (f.two) {
    const desc = resolve((resolve(d.DescendantFonts, objs) || [])[0], objs)?.dict || {};
    f.dw = resolve(desc.DW, objs)?.v || 1000;
    const w = resolve(desc.W, objs) || [];
    for (let i = 0; i < w.length;) {
      const c = resolve(w[i], objs)?.v; const nx = resolve(w[i + 1], objs);
      if (Array.isArray(nx)) { nx.forEach((x, k) => f.widths.set(c + k, resolve(x, objs)?.v || 0)); i += 2; }
      else { const c2 = nx?.v; const wv = resolve(w[i + 2], objs)?.v || 0; for (let k = c; k <= c2 && k - c < 65536; k++) f.widths.set(k, wv); i += 3; }
    }
  } else {
    f.first = resolve(d.FirstChar, objs)?.v || 0;
    (resolve(d.Widths, objs) || []).forEach((x, k) => f.widths.set(f.first + k, resolve(x, objs)?.v || 0));
    const enc = resolve(d.Encoding, objs);
    const diffs = resolve(enc?.dict?.Differences, objs);
    if (Array.isArray(diffs)) { let c = 0; for (const x of diffs) { const v = resolve(x, objs); if (typeof v?.v === 'number') c = v.v; else if (v?.n) { f.enc[c] = GLYPH[v.n] || (v.n.length === 1 ? v.n : /^uni([0-9A-F]{4})$/.test(v.n) ? String.fromCharCode(parseInt(v.n.slice(3), 16)) : ''); c++; } } }
  }
  cache.set(key, f);
  return f;
}
/** Bytes → [{ s, w }] (w as a fraction of the size). */
function glyphs(f, bytes) {
  const out = [];
  for (let i = 0; i < bytes.length;) {
    let code;
    if (f.two && i + 1 < bytes.length) { code = bytes.readUInt16BE(i); i += 2; } else code = bytes[i++];
    let s = f.map?.get(code);
    if (s === undefined) s = f.two ? '' : (f.enc[code] ?? WIN[code]);
    out.push({ s, w: (f.widths.get(code) ?? (f.two ? f.dw : 500 / f.unit / 1000)) * f.unit, code });
  }
  return out;
}

// ------------------------------------------------------------------ pages

const mul = (a, b) => [a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3], a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3], a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5]];

function pageList(objs) {
  const root = [...objs.values()].find((o) => resolve(o.val?.dict?.Type, objs)?.n === 'Catalog');
  const pages = [];
  const walk = (ref, inherited, depth) => {
    const node = resolve(ref, objs)?.dict; if (!node || depth > 40) return;
    const res = node.Resources || inherited;
    if (resolve(node.Type, objs)?.n === 'Pages' || node.Kids) { for (const k of resolve(node.Kids, objs) || []) walk(k, res, depth + 1); return; }
    pages.push({ node, res });
  };
  if (root) walk(root.val.dict.Pages, null, 0);
  if (!pages.length) for (const o of objs.values()) if (resolve(o.val?.dict?.Type, objs)?.n === 'Page') pages.push({ node: o.val.dict, res: o.val.dict.Resources });
  return pages;
}

function runsOf(content, resources, objs, fontCache, depth = 0) {
  const fonts = resolve(resolve(resources, objs)?.dict?.Font, objs)?.dict || {};
  const xobjs = resolve(resolve(resources, objs)?.dict?.XObject, objs)?.dict || {};
  const runs = [];
  const lx = new Lexer(content, 0); const stack = [];
  let ctm = [1, 0, 0, 1, 0, 0]; const gs = [];
  let tm = [1, 0, 0, 1, 0, 0]; let tlm = [1, 0, 0, 1, 0, 0];
  let font = null; let size = 10; let lead = 0; let cs = 0; let ws = 0; let th = 1; let rise = 0;
  const show = (items) => {
    if (!font) return;
    let text = ''; let start = null; let adv = 0;
    const emit = () => {
      if (text.trim()) {
        const m = mul([size * th, 0, 0, size, 0, rise], mul(tm, ctm));
        const p = start || [m[4], m[5]];
        const scale = Math.hypot(m[2], m[3]) || size;
        runs.push({ x: p[0], y: p[1], w: adv * Math.hypot(ctm[0], ctm[1]), size: scale, s: text });
      }
      text = ''; start = null; adv = 0;
    };
    for (const it of items) {
      if (typeof it === 'number') {
        const dx = (-it / 1000) * size * th;
        if (it < -250 && text) text += ' ';
        tm = mul([1, 0, 0, 1, dx, 0], tm); adv += dx; continue;
      }
      for (const g of glyphs(font, it)) {
        if (start === null) { const m = mul([1, 0, 0, 1, 0, rise], mul(tm, ctm)); start = [m[4], m[5]]; }
        text += g.s;
        const dx = (g.w * size + cs + (g.code === 32 && !font.two ? ws : 0)) * th;
        tm = mul([1, 0, 0, 1, dx, 0], tm); adv += dx;
      }
    }
    emit();
  };
  for (let t = lx.next(); t; t = lx.next()) {
    if (t.op === undefined || t.op === '[' || t.op === '<<') { stack.push(lx.value(t)); continue; }
    const a = stack; const num = (i) => +(a[a.length - i]?.v ?? 0);
    switch (t.op) {
      case 'q': gs.push(ctm); break;
      case 'Q': ctm = gs.pop() || ctm; break;
      case 'cm': ctm = mul([num(6), num(5), num(4), num(3), num(2), num(1)], ctm); break;
      case 'BT': tm = [1, 0, 0, 1, 0, 0]; tlm = tm; break;
      case 'Tf': { const nm = a[a.length - 2]?.n; size = num(1); font = nm && fonts[nm] ? fontOf(fonts[nm], objs, fontCache) : font; break; }
      case 'Tm': tm = tlm = [num(6), num(5), num(4), num(3), num(2), num(1)]; break;
      case 'Td': tm = tlm = mul([1, 0, 0, 1, num(2), num(1)], tlm); break;
      case 'TD': lead = -num(1); tm = tlm = mul([1, 0, 0, 1, num(2), num(1)], tlm); break;
      case 'TL': lead = num(1); break;
      case 'Tc': cs = num(1); break;
      case 'Tw': ws = num(1); break;
      case 'Tz': th = num(1) / 100; break;
      case 'Ts': rise = num(1); break;
      case 'T*': tm = tlm = mul([1, 0, 0, 1, 0, -lead], tlm); break;
      case 'Tj': { const s = a[a.length - 1]?.s; if (s) show([s]); break; }
      case "'": { tm = tlm = mul([1, 0, 0, 1, 0, -lead], tlm); const s = a[a.length - 1]?.s; if (s) show([s]); break; }
      case '"': { ws = num(3); cs = num(2); tm = tlm = mul([1, 0, 0, 1, 0, -lead], tlm); const s = a[a.length - 1]?.s; if (s) show([s]); break; }
      case 'TJ': { const arr = a[a.length - 1]; if (Array.isArray(arr)) show(arr.map((x) => (x?.s ? x.s : typeof x?.v === 'number' ? x.v : 0))); break; }
      case 'Do': {
        const nm = a[a.length - 1]?.n; const xo = nm && xobjs[nm] && objs.get(xobjs[nm].ref);
        if (xo && resolve(xo.val?.dict?.Subtype, objs)?.n === 'Form' && depth < 6) {
          const mx = resolve(xo.val.dict.Matrix, objs); const m = Array.isArray(mx) ? mx.map((x) => resolve(x, objs)?.v || 0) : [1, 0, 0, 1, 0, 0];
          for (const r of runsOf(decode(xo, objs), xo.val.dict.Resources || resources, objs, fontCache, depth + 1)) {
            const c = mul(m, ctm); runs.push({ ...r, x: r.x * c[0] + r.y * c[2] + c[4], y: r.x * c[1] + r.y * c[3] + c[5] });
          }
        }
        break;
      }
      case 'BI': { // inline image: skip to EI
        const s = content.indexOf('EI', lx.p, 'latin1'); lx.p = s < 0 ? content.length : s + 2; break;
      }
      default: break;
    }
    stack.length = 0;
  }
  return runs;
}

/** Runs → lines of text, top to bottom. */
function linesOf(runs) {
  const rs = runs.filter((r) => r.s && r.s.trim()).sort((a, b) => b.y - a.y || a.x - b.x);
  const lines = [];
  for (const r of rs) {
    const tol = Math.max(1.5, r.size * 0.35);
    const ln = lines.find((l) => Math.abs(l.y - r.y) <= tol);
    if (ln) ln.runs.push(r); else lines.push({ y: r.y, size: r.size, runs: [r] });
  }
  lines.sort((a, b) => b.y - a.y);
  const out = [];
  let prev = null;
  for (const l of lines) {
    l.runs.sort((a, b) => a.x - b.x);
    // Letter-spaced headings ("E U C L I D E A N"): when most gaps between single letters are wide, only a gap well
    // above the usual one is a space.
    const gaps = []; for (let i = 1; i < l.runs.length; i++) gaps.push((l.runs[i].x - (l.runs[i - 1].x + l.runs[i - 1].w)) / (l.runs[i].size || 1));
    const single = l.runs.filter((r) => r.s.trim().length === 1).length > l.runs.length * 0.7;
    const med = gaps.length > 3 ? [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)] : 0;
    const wordGap = single && med > 0.1 ? Math.max(0.18, med * 1.7) : 0.18;
    let s = ''; let end = null;
    for (const r of l.runs) {
      if (end !== null) {
        const gap = r.x - end;
        if (gap > r.size * 2.2) s += '   '; else if (gap > r.size * wordGap && !/\s$/.test(s) && !/^\s/.test(r.s)) s += ' ';
      }
      s += r.s; end = r.x + r.w;
    }
    // a bigger gap than one line means a new paragraph
    if (prev && prev.y - l.y > Math.max(prev.size, l.size) * 1.9) out.push('');
    out.push(s.replace(/\s+$/, ''));
    prev = l;
  }
  return out;
}

/** Read a PDF Buffer → { text, pages, encrypted }. */
function readPdf(buf) {
  if (!Buffer.isBuffer(buf) || buf.subarray(0, 1024).toString('latin1').indexOf('%PDF') < 0) throw new Error('That is not a PDF file.');
  const objs = readObjects(buf);
  if (/\/Encrypt\s/.test(buf.subarray(Math.max(0, buf.length - 4096)).toString('latin1')) || [...objs.values()].some((o) => o.val?.dict?.Encrypt)) {
    return { text: '', pages: 0, encrypted: true };
  }
  const fontCache = new Map(); const pages = pageList(objs); const texts = [];
  for (const pg of pages) {
    const c = resolve(pg.node.Contents, objs);
    const parts = Array.isArray(c) ? (resolve(pg.node.Contents, objs) || []).map((x) => objs.get(x.ref)) : [pg.node.Contents?.ref !== undefined ? objs.get(pg.node.Contents.ref) : null];
    const content = Buffer.concat(parts.filter(Boolean).map((o) => Buffer.concat([decode(o, objs), Buffer.from('\n')])));
    let runs = [];
    try { runs = runsOf(content, pg.res, objs, fontCache); } catch { runs = []; }
    texts.push(linesOf(runs).join('\n'));
  }
  const text = texts.map((t) => t.replace(/\n{3,}/g, '\n\n').trim()).join('\n\n\f\n\n');
  return { text, pages: pages.length, encrypted: false };
}

/** The text of a .docx (Word) file: paragraphs, tables as tab-separated rows, headings marked with #. */
function readDocx(buf) {
  const files = unzip(buf);
  const doc = files['word/document.xml']; if (!doc) throw new Error('That Word file has no document in it.');
  const x = doc.toString('utf8');
  const ent = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (m, n) => String.fromCharCode(+n)).replace(/&amp;/g, '&');
  const para = (p) => {
    let s = ''; for (const m of p.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\/>|<w:br\/>/g)) s += m[1] !== undefined ? ent(m[1]) : m[0] === '<w:tab/>' ? '\t' : '\n';
    const st = (/<w:pStyle w:val="([^"]+)"/.exec(p) || [])[1] || '';
    const h = /^(Heading|Title)(\d?)$/i.exec(st);
    if (h && s.trim()) return `${'#'.repeat(h[1].toLowerCase() === 'title' ? 1 : Math.min(6, +h[2] || 1))} ${s.trim()}`;
    if (/<w:numPr>/.test(p) && s.trim()) return `- ${s.trim()}`;
    return s;
  };
  const out = [];
  const body = x.replace(/<w:tbl>([\s\S]*?)<\/w:tbl>/g, (m, tbl) => {
    const rows = [...tbl.matchAll(/<w:tr[\s>][\s\S]*?<\/w:tr>/g)].map((r) => [...r[0].matchAll(/<w:tc>([\s\S]*?)<\/w:tc>/g)].map((c) => [...c[1].matchAll(/<w:p[\s>][\s\S]*?<\/w:p>/g)].map((p) => para(p[0]).trim()).filter(Boolean).join(' ').replace(/\|/g, '/')));
    if (!rows.length) return '';
    const md = [`| ${rows[0].join(' | ')} |`, `| ${rows[0].map(() => '---').join(' | ')} |`, ...rows.slice(1).map((r) => `| ${r.join(' | ')} |`)].join('\n');
    return `<w:p><w:r><w:t>\u0000TABLE${Buffer.from(md).toString('base64')}\u0000</w:t></w:r></w:p>`;
  });
  for (const m of body.matchAll(/<w:p[\s>][\s\S]*?<\/w:p>/g)) {
    const s = para(m[0]);
    const t = /\u0000TABLE([^\u0000]+)\u0000/.exec(s);
    out.push(t ? `\n${Buffer.from(t[1], 'base64').toString()}\n` : s);
  }
  return { text: out.join('\n').replace(/\n{3,}/g, '\n\n').trim() };
}

/** Files in a zip (stored or deflated), read from its central directory. */
function unzip(buf) {
  let e = buf.length - 22; while (e >= 0 && buf.readUInt32LE(e) !== 0x06054b50) e--;
  if (e < 0) throw new Error('That file is damaged (not a complete zip).');
  const count = buf.readUInt16LE(e + 10); let p = buf.readUInt32LE(e + 16); const out = {};
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10); const csize = buf.readUInt32LE(p + 20); const nlen = buf.readUInt16LE(p + 28); const xlen = buf.readUInt16LE(p + 30); const clen = buf.readUInt16LE(p + 32); const off = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString('utf8');
    const lnl = buf.readUInt16LE(off + 26); const lxl = buf.readUInt16LE(off + 28); const start = off + 30 + lnl + lxl;
    const data = buf.subarray(start, start + csize);
    try { out[name] = method === 0 ? data : method === 8 ? zlib.inflateRawSync(data) : null; } catch { out[name] = null; }
    p += 46 + nlen + xlen + clen;
  }
  return out;
}

/**
 * Lists exported to PDF (GrokBot's winners lists, master lists, research packs) print each person as
 * "1. Name (Seat) WON [Tier A]" followed by "• Phones: ..." and stand-alone "Email" / "Voicemail" headings.
 * Mark those up the way the Data tab reads people ("## ", "### Email", "Subject:").
 */
function markPeople(text) {
  return String(text)
    .replace(/\f/g, '')
    // Contact books: "1. JD Howard" on one line, the office on the next, then "Result:" / "Phone:" lines.
    .replace(/^[ \t]*(\d{1,3})\.\s+(\p{Lu}[\p{L}.'’-]+(?:\s+[\p{L}.'’()-]+){1,4})[ \t]*\n[ \t]*([^\n:]{3,80})\n(?=(?:[^\n]*\n){0,2}[ \t]*(?:Result|Phone|Phones|Email|Status):)/gmu, (m, n, name, office) => `## ${n}. ${name.trim()} (${office.trim().replace(/[()]/g, (c) => (c === '(' ? '[' : ']'))})\n`)
    .replace(/^[ \t]*(\d{1,3})\.\s+([A-Z][^\n()]{2,60}\((?:[^()\n]|\([^()\n]*\))+\)[^\n]*)$/gm, (m, n, rest) => (/\b(WON|LOST|Tier|VIDEO PICK)\b/.test(rest) || /\((?:[^()]*\b(?:AD|SD|LD|NY|CT|District|Assembly|Senate|House|County|Council|Mayor|Supervisor)\b)/.test(rest) ? `## ${n}. ${rest.trim()}` : m))
    .replace(/^[ \t]*(Email|First-touch email|Voicemail[^\n]{0,30}|Pickup script[^\n]{0,30}|Follow-up email[^\n]{0,30}|Video (?:prompt|brief)[^\n]{0,80})[ \t]*$/gim, (m, h) => `### ${h.trim()}`)
    .replace(/^[ \t]*[•●▪◦-][ \t]+([A-Z][\w /-]{1,30}):/gm, '- **$1:**')
    .replace(/^[ \t]+/gm, '');
}

module.exports = { readPdf, readDocx, unzip, markPeople, parseCMap };
