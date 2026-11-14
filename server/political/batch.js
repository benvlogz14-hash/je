'use strict';
/**
 * A batch of videos for one politician (Nov 13, Ryan: "create all the videos we need for a politician each month ...
 * put a name in, it pulls their videos, transcribes, makes the graphics, cuts them together ... prompt it by typing,
 * or baseline prompts ... just put in the topic").
 *
 *   orders (one line of typing per video, or a count)        "housing" · "quick video about childcare" · "intro"
 *     └─ their footage is read ONCE (uploads, else found online; transcribed, shots looked through)
 *     └─ for each order: the template's beats are filled with their own lines about that topic (footage.pickStory),
 *        never opening or closing on a line another video in the batch already used
 *     └─ the ad engine cuts, draws, mixes and checks it (adengine.make), in the order's style or the batch's rotation
 *   → prospect.videos[] (files in <data>/political/<id>/videos), shown in the Ad machine's Videos tab
 *
 * Nothing is sent or posted: these are files for the founders to review.
 */
const fs = require('fs');
const path = require('path');
const ctx = require('../core/ctx');
const audit = require('../core/audit');
const events = require('../core/events');
const ff = require('../video/ffmpeg');
const T = require('./templates');
const looks = require('./looks');

const MAX = 40; // videos per batch
const S = (k, d) => ctx.setting(`political.${k}`, d);
const now = () => new Date().toISOString();
const uid = () => `v${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** Styles a batch rotates through: 'mix' = the old motion-graphics looks and the new creator looks, turn about. */
const MIX = ['bold', 'street', 'pastel', 'field', 'direct'];
function styleList(styles, p) {
  if (styles === 'mix' || (Array.isArray(styles) && styles.includes('mix'))) return MIX;
  const list = [].concat(styles || []).filter((id) => looks.PRESETS[id]);
  return list.length ? list : [null]; // null = this candidate's own look (or the default)
}

/** The orders for a batch: what was typed, else `count` videos planned from what their footage is about. */
function planOrders({ text = '', orders = null, count = 0, sentences = [] }) {
  const typed = Array.isArray(orders) && orders.length ? orders.map((o) => (typeof o === 'string' ? T.parseAsk(o, looks) : o)).filter(Boolean) : T.parseOrders(text, looks);
  if (typed.length) return typed.slice(0, MAX);
  const n = Math.max(1, Math.min(MAX, Number(count) || 8));
  // What they talk about most, from the footage itself (the same families the icons use).
  const { ICONS, TOPIC_NAMES: NAMES } = require('./footage');
  const themes = ICONS.map(([k, rx]) => ({ k, n: sentences.filter((x) => rx.test(x.text)).length })).filter((t) => t.n >= 3 && NAMES[t.k]).sort((a, b) => b.n - a.n).map((t) => NAMES[t.k]);
  const out = ['best', 'intro'].map((template) => ({ ask: T.byId(template).name, template, topic: '', brief: '' }));
  for (const topic of themes) out.push({ ask: `About ${topic}`, template: 'topic', topic, brief: '' });
  for (const template of ['delivered', 'local', 'promise', 'values', 'people', 'numbers']) out.push({ ask: T.byId(template).name, template, topic: '', brief: '' });
  for (const topic of themes) out.push({ ask: `Quick video about ${topic}`, template: 'quick', topic, brief: '' });
  return out.slice(0, n);
}

/** Real headlines about them from the research (for press clippings): [{ title, outlet, date }]. */
function newsFor(p) {
  const pkg = p.pkg || {}; const out = [];
  for (const f of (pkg.facts || []).filter((x) => x.topic === 'news')) {
    const src = typeof f.src === 'number' ? (pkg.sources || [])[f.src] || (pkg.sources || []).find((s) => s.n === f.src) : f.src;
    const label = String(src?.label || src?.title || src?.name || '');
    const m = String(f.text).match(/^(\w{3},? \d{1,2} \w{3} \d{4}|\d{4}-\d\d-\d\d|\w+ \d{1,2},? \d{4})?\s*(.+)$/);
    const title = (m ? m[2] : f.text).replace(/\s+-\s+[^-]{2,40}$/, '').trim(); // Google News adds " - Outlet" at the end
    const outlet = (label.split(':')[0] || (String(f.text).match(/\s-\s([^-]{2,40})$/) || [])[1] || '').trim();
    if (title && outlet && outlet.toLowerCase() !== 'news') out.push({ title, outlet, date: (m && m[1]) || '' });
  }
  return out.slice(0, 30);
}

function publicVideo(v) { const { file, poster, wideFile, layers, ...rest } = v; return { ...rest, hasWide: !!wideFile, canEdit: !!layers }; }
function list(prospectId) { const p = ctx.store.get('prospects', prospectId); return { videos: (p?.videos || []).filter((v) => v.file && fs.existsSync(v.file)).map(publicVideo).reverse(), last: p?.videoRun || null }; }
function remove(prospectId, vid) {
  const p = ctx.store.get('prospects', prospectId); const v = (p?.videos || []).find((x) => x.id === vid); if (!v) return false;
  for (const f of [v.file, v.poster, v.wideFile]) if (f) fs.rmSync(f, { force: true });
  ctx.store.update('prospects', prospectId, (cur) => ({ videos: (cur.videos || []).filter((x) => x.id !== vid) })); events.publish('prospects', { id: prospectId });
  return true;
}

/**
 * Their footage, read once (found or uploaded, transcribed, looked through), with other speakers' lines marked.
 * Returns { p, ft, saved, sentences }. Throws a plain reason when there's nothing usable.
 */
async function read(prospectId, h, actor = 'user', span = [0, 1]) {
  const pkgMod = require('./package');
  const prog = (f, t) => h.progress(span[0] + (span[1] - span[0]) * f, t);
  let p = ctx.store.get('prospects', prospectId); if (!p) throw Object.assign(new Error('That candidate is not on the board.'), { permanent: true });
  const dir = pkgMod.dirFor(p); const sentFile = path.join(dir, 'footage', 'sentences.json');
  if (!fs.existsSync(sentFile) || !pkgMod.sameFootage(p, p.pkg?.footage) || !(p.pkg?.footage?.clips || []).length) {
    prog(0.02, 'Reading their footage (once, then every video uses it)');
    await pkgMod.run(prospectId, { only: 'footage', actor }, { progress: (f, t) => prog(0.02 + 0.85 * f, t) });
  }
  p = ctx.store.get('prospects', prospectId);
  const ft = p.pkg?.footage;
  if (!fs.existsSync(sentFile) || !(ft?.clips || []).length) throw Object.assign(new Error(`No usable footage of ${p.name} yet. ${p.pkg?.steps?.footage?.note || p.pkg?.steps?.footage?.error || 'Upload their videos, or paste links to them, then try again.'}`), { permanent: true });
  const saved = JSON.parse(fs.readFileSync(sentFile, 'utf8'));
  // Whose voice is it? Hearings and interviews have other speakers. Lines that are clearly the member's own (they say
  // "my district", "I represent", "Madam Speaker"...) give their voice's pitch; lines far from it are someone else's.
  if (!saved.voiced) {
    try {
      prog(0.9, 'Telling their voice from other speakers');
      const edit = require('./edit');
      for (let k = 0; k < ft.clips.length; k++) { const mine = saved.sentences.filter((x) => x.clip === k); if (!mine.length || !fs.existsSync(ft.clips[k].file)) continue; const f0 = await edit.pitches(ft.clips[k].file, mine.map((x) => [x.s, x.e])); mine.forEach((x, i) => { x.f0 = f0[i]; }); }
      const OWN = /\b(my district|my constituents|i represent|my bill|i (sponsor|introduced|wrote|carry)|as (a|your) (assembly|senator|council|representative|legislator|mayor)|i rise|madam speaker|mr\.? speaker|my colleagues|my community|my neighbors)\b/i;
      const anchors = saved.sentences.filter((x) => x.f0 && OWN.test(x.text)).map((x) => x.f0).sort((a, b) => a - b);
      if (anchors.length >= 2 && anchors[anchors.length - 1] / anchors[0] < 1.35) { const mid = anchors[anchors.length >> 1]; for (const x of saved.sentences) x.other = !!(x.f0 && (x.f0 / mid > 1.3 || x.f0 / mid < 0.77)); saved.voice = mid; }
      saved.voiced = true; fs.writeFileSync(sentFile, JSON.stringify(saved));
    } catch { /* without it, every line is treated as theirs */ }
  }
  const sentences = saved.sentences.filter((x) => ft.clips[x.clip]?.file && fs.existsSync(ft.clips[x.clip].file));
  events.publish('prospects', { id: prospectId });
  return { p, ft, saved, sentences };
}

/**
 * What's in a candidate's footage (Ad machine → What's in their footage): topics, the best openings, how many videos
 * it can carry. { ready: false, why } until the footage has been read.
 */
function insight(prospectId) {
  const pkgMod = require('./package'); const footage = require('./footage');
  const p = ctx.store.get('prospects', prospectId); if (!p) return { ready: false, why: 'Pick a candidate.' };
  const sentFile = path.join(pkgMod.dirFor(p), 'footage', 'sentences.json'); const ft = p.pkg?.footage;
  const has = (p.footageUploads || []).some((u) => !u.off) || (p.footageLinks || []).length || (p.footageFound || []).some((v) => !v.off);
  if (!fs.existsSync(sentFile) || !(ft?.clips || []).length) return { ready: false, hasFootage: !!has, why: has ? 'Their footage has not been read yet.' : 'No footage yet. Upload their videos, or find their public ones.', note: p.pkg?.steps?.footage?.error || '' };
  let saved; try { saved = JSON.parse(fs.readFileSync(sentFile, 'utf8')); } catch { return { ready: false, hasFootage: !!has, why: 'Their footage needs to be read again.' }; }
  const sentences = (saved.sentences || []).filter((x) => ft.clips[x.clip]?.file);
  return { ready: true, stale: !pkgMod.sameFootage(p, ft), clips: ft.clips.length, minutes: Math.round(ft.clips.reduce((a, c) => a + (c.duration || 0), 0) / 6) / 10, ...footage.insight(sentences) };
}

/** Make the batch. Returns { made, skipped: [{ ask, why }], seconds }. */
async function make(prospectId, { text = '', orders = null, count = 0, styles = null, density = null, wide = false, prompt = '', textStyle = null, purpose = null, edit = null, actor = 'user' } = {}, h) {
  const pkgMod = require('./package'); const footage = require('./footage'); const eng = require('./adengine');
  let p = ctx.store.get('prospects', prospectId); if (!p) throw Object.assign(new Error('That candidate is not on the board.'), { permanent: true });
  const t0 = Date.now();
  const dir = pkgMod.dirFor(p);
  // 1. Who they are (office, state, facts) and their footage, read once. Research can fail offline: the videos don't need it.
  if (!p.pkg?.profile) { h.progress(0.01, 'Looking up who they are'); try { await pkgMod.run(prospectId, { only: 'research', actor }, { progress: (f, t) => h.progress(0.01 + 0.04 * f, t) }); } catch { /* carry on with what we have */ } }
  const rd = await read(prospectId, h, actor, [0.05, 0.3]);
  p = rd.p; const ft = rd.ft; const sentences = rd.sentences;
  const pr = p.pkg?.profile || {}; const office = pkgMod.shortOffice(pr.office || p.office || p.location || '');
  // Words on screen in their videos (name bars, signs) count as facts for graphics, like the research does.
  const seen = [...new Set(sentences.map((x) => x.shot?.text).filter(Boolean))].slice(0, 20).join(' | ');
  const facts = [pkgMod.factsFor(p), seen].filter(Boolean).join(' | ').slice(0, 3600);
  const news = newsFor(p);

  // 2. The orders.
  const todo = planOrders({ text, orders, count, sentences });
  const rotation = styleList(styles, p); const own = pkgMod.lookFor(p);
  let music = null;
  if (S('musicOn', true) !== false) { try { const m = await require('../video/music').pick('speech'); music = m?.file || null; } catch { /* no music */ } }
  const outDir = path.join(dir, 'videos'); fs.mkdirSync(outDir, { recursive: true });
  const batch = uid(); const avoid = { open: new Set(), close: new Set(), body: new Set() }; const sigs = new Set();
  const made = []; const skipped = [];
  const slug = String(p.name).replace(/[^\w\- .]+/g, '').trim().slice(0, 40) || 'Candidate';

  for (let i = 0; i < todo.length; i++) {
    const o = todo[i]; const tpl = T.byId(o.template) || T.byId('best');
    const base = 0.3 + 0.7 * (i / todo.length); const span = 0.7 / todo.length;
    h.progress(base, `Video ${i + 1} of ${todo.length}: ${o.ask}`);
    try {
      const focus = [o.brief || o.topic, prompt].filter(Boolean).join('. ');
      const sc = tpl.id === 'script' ? footage.matchScript(sentences, o.brief) : null;
      if (sc && sc.picks.length >= 2 && sc.missed.length) skipped.push({ ask: o.ask.slice(0, 60), why: `Made, but these script lines were not found in their footage: ${sc.missed.map((m) => `“${m.slice(0, 60)}”`).join(', ')}` });
      if (sc && sc.picks.length < 2) { skipped.push({ ask: o.ask.slice(0, 60), why: 'Fewer than two of the script\'s lines were found in their footage. Use words close to what they actually say.' }); continue; }
      // The opening: a line they asked for ("hook: ..."), the n-th best hook ("3 hooks about housing"), else the picker's own.
      let hookId = null;
      if (o.hookId != null && sentences.some((x) => x.id === o.hookId)) hookId = o.hookId;
      else if (o.hook) { const hx = footage.findLine(sentences, o.hook); if (!hx) { skipped.push({ ask: o.ask.slice(0, 60), why: 'That opening line was not found in their footage. Pick one from the hook list, or use words close to what they say.' }); continue; } hookId = hx.id; }
      else if (o.hookRank != null) { const hs = footage.hooks(sentences, 8, o.topic || ''); const hx = hs[o.hookRank]; if (!hx) { skipped.push({ ask: o.ask, why: `Their footage has only ${hs.length} strong opening line${hs.length === 1 ? '' : 's'}${o.topic ? ` about “${o.topic}”` : ''}.` }); continue; } hookId = hx.id; }
      const st = sc ? { picks: sc.picks, agent: 'your script', onTopic: null } : await footage.pickStory({ name: p.name, office, sentences, story: focus ? { mode: 'brief', brief: focus } : { mode: 'auto' }, facts, template: tpl, seconds: o.seconds || null, avoid: hookId != null ? { ...avoid, open: new Set() } : avoid, hookId });
      const bites = st.picks.map((x) => ({ id: x.id, clip: x.clip, s: x.s, e: x.e, text: x.text, words: x.words, role: x.role, gfx: x.gfx || null, icons: x.icons || [] }));
      if (bites.length < 2) { skipped.push({ ask: o.ask, why: st.weak || 'Not enough clear lines in their footage for this one.' }); continue; }
      if (o.topic && st.onTopic != null && st.onTopic < Math.min(2, bites.length - 1)) { skipped.push({ ask: o.ask, why: `Their footage says little or nothing about “${o.topic}”.` }); continue; }
      const sig = bites.map((b) => b.id).join('-');
      if (sigs.has(sig)) { skipped.push({ ask: o.ask, why: 'It came out as the same lines as an earlier video in this batch (not enough different footage).' }); continue; }
      sigs.add(sig); avoid.open.add(bites[0].id); avoid.close.add(bites[bites.length - 1].id); bites.forEach((b) => avoid.body.add(b.id));

      const styleId = o.style || rotation[i % rotation.length];
      let look = styleId ? looks.preset(styleId) : own.look ? looks.normalize(own.look, own.look) : looks.preset('bold');
      const dens = o.density || density; if (dens) look = looks.withDensity(look, dens);
      if (textStyle) look = looks.withText(look, textStyle);
      // The kind of edit: the batch's choice, with anything this line said itself on top.
      const ed = looks.withEdit(look, { ...(edit || {}), ...(o.edit || {}) }); look = ed.look;
      if (o.density && !(o.edit || {}).kind) look = looks.withDensity(look, o.density);
      const social = (purpose || S('purpose', 'social')) !== 'campaign';
      const id = uid(); const title = tpl.id === 'script' ? `Script: ${bites[0].text.split(' ').slice(0, 5).join(' ')}` : `${tpl.name}${o.topic ? `: ${o.topic}` : ''}`;
      const file = path.join(outDir, `${slug} - ${String(i + 1).padStart(2, '0')} ${title.replace(/[^\w\- ]+/g, '').slice(0, 40)} - ${id}.mp4`);
      const common = { bites, footage: ft, music: ed.music ? music : null, name: p.name, office, place: p.pkg?.brief?.place || '', state: pr.state || '', cta: social ? 'Follow' : 'Vote', endFor: social ? '' : null, site: pkgMod.siteOf(p.pkg || {}), tag: S('conceptTag', true) ? `Concept by ${ctx.setting('agency.name', 'Euclidean Media')}` : '', notes: [own.notes, prompt, o.brief].filter(Boolean).join(' | '), look, sound: ed.sfx || S('adSound', 'full'), news, crf: Number(S('batchCrf', 21)) || 21 };
      const r = await eng.make({ ...common, vertical: true, out: file, work: path.join(dir, `work_batch_${id}`), onProgress: (f, t) => h.progress(base + span * (o.wide || wide ? 0.5 : 0.95) * f, `Video ${i + 1} of ${todo.length}: ${t}`) });
      fs.rmSync(path.join(dir, `work_batch_${id}`), { recursive: true, force: true });
      let wideFile = null;
      if (o.wide || wide) {
        wideFile = file.replace(/\.mp4$/, ' (wide).mp4');
        try { await eng.make({ ...common, vertical: false, out: wideFile, work: path.join(dir, `work_batch_${id}w`), onProgress: (f, t) => h.progress(base + span * (0.5 + 0.45 * f), `Video ${i + 1} of ${todo.length}, wide: ${t}`) }); } catch { wideFile = null; }
        fs.rmSync(path.join(dir, `work_batch_${id}w`), { recursive: true, force: true });
      }
      const poster = file.replace(/\.mp4$/, '.jpg');
      await ff.thumbnail(file, poster, Math.min(2.5, r.duration / 4), 540).catch(() => {});
      const rec = { id, batch, n: i + 1, at: now(), ask: o.ask, title, template: tpl.id, topic: o.topic || '', style: styleId || 'own', styleName: look.name, density: look.density, edit: (o.edit || {}).kind || (edit || {}).kind || 'graphics', hook: bites[0].text, duration: Math.round(r.duration * 10) / 10, file, poster: fs.existsSync(poster) ? poster : null, wideFile, qa: r.qa || null, lines: bites.map((b) => b.text), layers: r.layers || null, graphics: [...new Set(r.spec.segs.flatMap((s) => [s.tag?.kind, s.card?.kind !== 'video' ? s.card?.kind : null]).filter(Boolean))], agent: st.agent, review: !!tpl.review, by: actor };
      ctx.store.update('prospects', prospectId, (cur) => ({ videos: [...(cur.videos || []), rec].slice(-200) }));
      events.publish('prospects', { id: prospectId });
      made.push(rec);
    } catch (e) {
      skipped.push({ ask: o.ask, why: String(e.message || e).split('\n')[0].slice(0, 200) });
    }
  }
  const run = { at: now(), batch, asked: todo.length, made: made.length, skipped, seconds: Math.round((Date.now() - t0) / 1000) };
  ctx.store.update('prospects', prospectId, () => ({ videoRun: run })); events.publish('prospects', { id: prospectId });
  audit.log(actor, 'political.batch', { prospectId, name: p.name, made: made.length, skipped: skipped.length, seconds: run.seconds });
  if (!made.length) throw Object.assign(new Error(`No videos made for ${p.name}. ${skipped[0]?.why || ''}`.trim()), { permanent: true });
  return { made: made.length, skipped, seconds: run.seconds };
}

/**
 * Open a batch video in the Studio as layers: every cut of their footage on V1 with its sound on A1 (from the original
 * files, so each piece can be trimmed, moved or swapped), the captions as editable titles on their own track, and the
 * music on its own track. The motion graphics are not layers (they are drawn by the ad designer); the finished video
 * stays in the Videos tab.
 */
async function toStudio(prospectId, vid) {
  const p = ctx.store.get('prospects', prospectId); const v = (p?.videos || []).find((x) => x.id === vid);
  if (!v) throw new Error('That video is not in the list any more.');
  if (!v.layers) throw new Error('This video was made before layers were kept. Make it again, then open it in the Studio.');
  const W = 1080; const H = 1920; let nid = 1; const an = (base) => ({ base });
  const clip = (o) => ({ id: String(nid++), type: o.type, mediaId: o.mediaId || '', name: o.name || '', start: o.start, duration: o.duration, in: o.in || 0, speed: 1, preservePitch: false, linkId: String(o.linkId || 0), enabled: true, posX: an(0), posY: an(0), scaleX: an(o.scale ?? 1), scaleY: an(o.scale ?? 1), rotation: an(0), opacity: an(1), volume: an(o.volume ?? 1), uniformScale: true, effects: [], transIn: { type: 0, duration: 1 }, transOut: { type: 0, duration: 1 }, ...(o.text ? { text: o.text, isCaption: true } : {}) });
  const files = [...new Set(v.layers.lines.map((l) => l.file))].filter((f) => fs.existsSync(f));
  if (!files.length) throw new Error('Their original footage for this video is no longer on this computer.');
  const media = []; const info = {};
  for (const f of files) { const i = await ff.probe(f); info[f] = i; media.push({ id: `m${media.length + 1}`, path: f, name: path.basename(f), kind: 0, duration: i.duration, width: i.width, height: i.height, fps: i.fps, hasVideo: true, hasAudio: i.hasAudio, srcIn: 0, srcOut: -1 }); }
  const v1 = []; const a1 = []; let t = 0;
  v.layers.lines.forEach((l, k) => { const m = media[files.indexOf(l.file)]; if (!m) return; for (const [a, b] of l.keep) { const d = Math.max(0.1, b - a); const link = nid + 1000; v1.push(clip({ type: 0, mediaId: m.id, name: `Line ${k + 1}`, start: t, duration: d, in: a, linkId: link, scale: Math.max(W / m.width, H / m.height) })); a1.push(clip({ type: 1, mediaId: m.id, name: `Line ${k + 1}`, start: t, duration: d, in: a, linkId: link })); t += d; } });
  // Captions: a phrase at a time (a new one at a pause, a sentence end, or after 5 words).
  const caps = []; let cur = [];
  const flush = () => { if (!cur.length) return; const s = cur[0].s; const e = cur[cur.length - 1].e; caps.push(clip({ type: 3, name: cur.map((w) => w.w).join(' ').slice(0, 40), start: s, duration: Math.max(0.3, e - s), text: { text: cur.map((w) => w.w).join(' '), family: v.layers.fonts?.cap || 'Inter', pixelSize: 64, bold: true, italic: false, color: '#ffffffff', outlineColor: '#ff000000', outlineWidth: 5, shadow: 2, shadowColor: '#90000000' } })); caps[caps.length - 1].posY = an(H * 0.2); cur = []; };
  for (const w of v.layers.words) { if (cur.length && (cur.length >= 5 || w.s - cur[cur.length - 1].e > 0.4)) flush(); cur.push(w); if (/[.!?]$/.test(w.w)) flush(); }
  flush();
  const music = [];
  if (v.layers.music && fs.existsSync(v.layers.music)) { const mi = await ff.probe(v.layers.music).catch(() => ({ duration: 600 })); media.push({ id: 'mu1', path: v.layers.music, name: path.basename(v.layers.music), kind: 1, duration: mi.duration || 600, hasVideo: false, hasAudio: true, srcIn: 0, srcOut: -1 }); music.push({ ...clip({ type: 1, mediaId: 'mu1', name: 'Music', start: 0, duration: Math.min(t, mi.duration || t), volume: 0.26 }), transOut: { type: 2, duration: 1 } }); }
  const track = (type, nm, clips) => ({ type, name: nm, muted: false, locked: false, volume: an(1), clips });
  const data = { app: 'velo', version: 1, media, sequences: [{ id: 's1', name: v.title, width: W, height: H, fps: 30, videoTracks: [track(0, 'V1', v1), track(0, 'Captions', caps)], audioTracks: [track(1, 'A1', a1), track(1, 'Music', music)] }], openTabs: ['s1'], activeSequence: 's1', nextClipId: String(nid + 2000) };
  const proj = ctx.store.insert('projects', { name: `${p.name}: ${v.title}`, clientId: null, prospectId, data, exports: [] });
  audit.log('user', 'political.video_to_studio', { prospectId, video: vid, project: proj.id });
  return { id: proj.id, name: proj.name };
}

/** Start batches for people by name or id (a name not on the board is added as a political lead). */
function start({ ids = [], names = [], add = true, actor = 'user', ...opts } = {}) {
  const queue = require('../jobs/queue');
  const all = ctx.store.all('prospects', (p) => p.type === 'political');
  const list = []; const skipped = [];
  for (const id of ids) { const p = ctx.store.get('prospects', id); if (p) list.push(p); else skipped.push(`${id} (not found)`); }
  for (const raw of names) {
    const [nm, ...rest] = String(raw).split(/\s*[,|]\s*/); const k = nm.toLowerCase().trim(); if (!k) continue;
    let p = all.find((x) => String(x.name).toLowerCase() === k) || all.find((x) => String(x.name).toLowerCase().includes(k));
    if (!p && add) p = ctx.store.insert('prospects', { name: nm.trim(), type: 'political', location: rest.join(', '), stage: 'new', verified: true, source: 'batch', triage: null });
    if (p) list.push(p); else skipped.push(`${nm} (not on the board)`);
  }
  const started = [];
  for (const p of [...new Map(list.map((x) => [x.id, x])).values()].slice(0, 25)) {
    if (p.hold) { skipped.push(`${p.name} (HOLD)`); continue; }
    const job = queue.enqueue('political.batch', { prospectId: p.id, name: p.name, ...opts }, { actor, priority: 4, dedupeKey: `polpkg:${p.id}`, title: `Videos for ${p.name}` });
    started.push({ id: p.id, name: p.name, jobId: job.id });
  }
  if (!started.length) throw new Error(skipped.length ? `Nothing started: ${skipped.join(', ')}.` : 'Name the politician, or pick one.');
  return { started, skipped };
}

module.exports = { read, insight, toStudio, make, start, list, remove, planOrders, newsFor, MIX };
