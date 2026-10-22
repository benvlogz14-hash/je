'use strict';
/**
 * "Their own words" ads: real public footage of the candidate speaking, cut
 * together with B-roll, captions and campaign graphics.
 *
 *   find → download → transcribe → pick soundbites → render
 *
 * Footage comes from public posts only, with no login: links the founders paste
 * on the lead, public Facebook videos and reels (found through web search and
 * their own sites), their YouTube channel and YouTube search.
 *
 * Soundbites are whole sentences exactly as said. We never cut inside a
 * sentence or join words to make them say something they didn't.
 */
const fs = require('fs');
const path = require('path');
const ctx = require('../core/ctx');
const paths = require('../core/paths');
const ai = require('../integrations/ai');
const websearch = require('../integrations/websearch');
const ff = require('../video/ffmpeg');
const intel = require('../video/intelligence');
const captions = require('../video/captions');
const motion = require('../video/motion');
const campaign = require('../video/campaign');
const { ensureFonts } = require('../video/render');
const { run } = require('../core/util');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
const FB_VIDEO = /https?:\/\/(?:www\.|m\.|web\.)?(?:facebook\.com\/(?:[^/\s"'?<>]+\/videos\/(?:[^/\s"'?<>]+\/)?\d+|watch\/?\?v=\d+|reel\/\d+|share\/[rv]\/[A-Za-z0-9]+)|fb\.watch\/[A-Za-z0-9_-]+)/g;
const YT_VIDEO = /https?:\/\/(?:www\.)?(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/g;
const FORMAT = 'bv*[height<=1080][ext=mp4]+ba[ext=m4a]/b[height<=1080][ext=mp4]/bv*[height<=1080]+ba/b';
const FPS = 30;

const platformOf = (u) => (/facebook\.com|fb\.watch/.test(u) ? 'Facebook' : /youtu/.test(u) ? 'YouTube' : /instagram/.test(u) ? 'Instagram' : /(^|\/\/|\.)(x|twitter)\.com/.test(u) ? 'X' : /tiktok/.test(u) ? 'TikTok' : /c-span/.test(u) ? 'C-SPAN' : 'the web');
const shortErr = (e) => String(e?.message || e).replace(/^.*?ERROR:\s*/s, '').split('\n')[0].slice(0, 140);

// ------------------------------------------------------------------ find

async function ytdlpList(target, n) {
  const r = await run(ff.ytdlpBin(), ['--flat-playlist', '-I', `1:${n}`, '--print', '%(url)s\t%(title)s\t%(duration)s', '--', target], { timeoutMs: 120000 });
  return r.out.split('\n').map((l) => l.split('\t')).filter((a) => /^https?:/.test(a[0])).map(([url, title, d]) => ({ url, title, duration: Number(d) || 0 }));
}

/** Public videos of the candidate, best first. */
async function find({ name, socials = [], sites = [], links = [] }, onStep = () => {}) {
  const list = []; const errors = [];
  const last = String(name).trim().split(/\s+/).slice(-1)[0].toLowerCase();
  const add = (url, platform, title = '', how = '', duration = 0) => {
    url = String(url).replace(/&amp;/g, '&').trim();
    if (!/^https?:\/\//.test(url) || list.some((x) => x.url === url)) return;
    if (duration && (duration < 15 || duration > 4 * 3600)) return;
    list.push({ url, platform, title, how, duration });
  };
  for (const l of links) add(l, platformOf(l), '', 'pasted');

  onStep('Looking for public Facebook videos');
  for (const q of [`"${name}" facebook video`, `"${name}" site:facebook.com videos`, `"${name}" facebook reel speech`]) {
    try { for (const r of await websearch.search(q, 10)) for (const m of `${r.url} ${r.snippet}`.matchAll(FB_VIDEO)) add(m[0], 'Facebook', r.title, 'search'); }
    catch (e) { errors.push(`Web search: ${shortErr(e)}`); break; }
  }
  onStep('Checking their websites for videos');
  for (const s of [...sites.slice(0, 3), ...socials.filter((x) => /facebook\.com/.test(x)).slice(0, 1)]) {
    try {
      const html = await (await fetch(s, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(15000) })).text();
      for (const m of html.matchAll(FB_VIDEO)) add(m[0], 'Facebook', '', 'their site');
      for (const m of html.matchAll(YT_VIDEO)) add(`https://www.youtube.com/watch?v=${m[1]}`, 'YouTube', '', 'their site');
    } catch (e) { errors.push(`${s}: ${shortErr(e)}`); }
  }
  const channel = socials.find((s) => /youtube\.com\/(channel|c|user|@)/.test(s));
  if (channel) {
    onStep('Reading their YouTube channel');
    try { for (const v of await ytdlpList(`${channel.replace(/\/$/, '')}/videos`, 12)) add(v.url, 'YouTube', v.title, 'their channel', v.duration); }
    catch (e) { errors.push(`YouTube channel: ${shortErr(e)}`); }
  }
  onStep('Searching YouTube for speeches');
  for (const q of [`ytsearch8:${name} speech`, `ytsearch6:${name} interview`, `ytsearch5:${name} campaign`]) {
    try { for (const v of await ytdlpList(q, 8)) if (String(v.title).toLowerCase().includes(last)) add(v.url, 'YouTube', v.title, 'search', v.duration); }
    catch (e) { errors.push(`YouTube search: ${shortErr(e)}`); break; }
  }
  const rank = { pasted: 0, 'their site': 1, 'their channel': 2, search: 3 };
  const prefer = (x) => (x.platform === 'Facebook' ? -0.5 : 0) + (/speech|rally|remarks|floor|town hall|announce/i.test(x.title) ? -0.3 : 0);
  list.sort((a, b) => rank[a.how] + prefer(a) - (rank[b.how] + prefer(b)));
  return { list, errors };
}

/** Download up to `want` usable videos (the first 10 minutes of each). */
async function download(list, dir, { want = 4, name = '', onStep = () => {} } = {}) {
  const last = String(name).trim().split(/\s+/).slice(-1)[0].toLowerCase();
  fs.mkdirSync(dir, { recursive: true });
  const got = []; const errors = [];
  for (const c of list) {
    if (got.length >= want) break;
    const out = path.join(dir, `clip${got.length + 1}.mp4`);
    try { fs.unlinkSync(out); } catch { /* none */ }
    onStep(`Downloading ${c.platform} video ${got.length + 1} of ${want}`);
    try {
      const r = await run(ff.ytdlpBin(), ['-f', FORMAT, '--merge-output-format', 'mp4', '--no-playlist', '--max-filesize', '500M', '--download-sections', '*0-600', '--print', 'after_move:%(uploader)s\t%(title)s', '-o', out, '--', c.url], { timeoutMs: 900000 });
      const [uploader, title] = (r.out.trim().split('\n').pop() || '').split('\t');
      if (!fs.existsSync(out)) throw new Error('nothing downloaded');
      const info = await ff.probe(out);
      if (!info.hasAudio || !info.hasVideo || info.duration < 8) { fs.unlinkSync(out); continue; }
      // Their own post (pasted, from their site or channel, or uploaded by them) vs. someone else's coverage.
      const own = ['pasted', 'their site', 'their channel'].includes(c.how) || (!!last && String(uploader || '').toLowerCase().includes(last));
      got.push({ ...c, own, uploader: uploader && uploader !== 'NA' ? uploader : '', title: c.title || (title !== 'NA' ? title : ''), file: out, duration: info.duration, width: info.width, height: info.height });
    } catch (e) { errors.push(`${c.platform} ${c.url}: ${shortErr(e)}`); }
  }
  return { clips: got, errors };
}

// ------------------------------------------------------------------ transcripts and sentences

/** Put the transcript's punctuation back on the words (OpenAI returns bare words; segments keep it). */
function punctuate(words, segments) {
  if (words.some((w) => /[.!?]["”']?$/.test(w.w))) return words;
  const out = words.map((w) => ({ ...w }));
  for (const s of segments || []) {
    const idx = out.map((w, i) => i).filter((i) => out[i].s >= s.s - 0.08 && out[i].e <= s.e + 0.08);
    const tokens = String(s.t || '').split(/\s+/).filter(Boolean);
    if (idx.length && tokens.length === idx.length) idx.forEach((i, k) => { out[i].w = tokens[k]; });
    else if (idx.length && /[.!?]["”']?$/.test(s.t || '')) out[idx[idx.length - 1]].w = out[idx[idx.length - 1]].w.replace(/[.!?]*$/, '.');
  }
  return out;
}

/** Whole sentences with their timings. */
function sentences(words, clip) {
  const out = []; let cur = [];
  const flush = () => { if (cur.length) out.push({ clip, s: cur[0].s, e: cur[cur.length - 1].e, words: cur, text: cur.map((w) => w.w).join(' ').replace(/\s+([,.!?])/g, '$1') }); cur = []; };
  for (const w of words) {
    if (cur.length && w.s - cur[cur.length - 1].e > 1.2) flush();
    cur.push(w);
    if (/[.!?]["”']?$/.test(w.w)) flush();
  }
  flush();
  return out.filter((x) => x.e - x.s >= 1 && x.e - x.s <= 14 && x.words.length >= 4);
}

async function transcribeClips(clips, dir, onStep = () => {}) {
  const all = []; const errors = [];
  for (let k = 0; k < clips.length; k++) {
    onStep(`Turning speech into text (${k + 1} of ${clips.length})`);
    try {
      const t = await intel.transcribe({ id: `clip${k + 1}`, path: clips[k].file, workDir: dir, info: { duration: clips[k].duration }, clientId: null });
      clips[k].words = punctuate(t.words || [], t.segments || []);
      all.push(...sentences(clips[k].words, k));
    } catch (e) {
      if (e.notConnected) throw Object.assign(new Error('Turning speeches into text needs OpenAI connected, or the free local Whisper tool set up in Settings → AI.'), { permanent: true });
      errors.push(`Transcript ${k + 1}: ${shortErr(e)}`);
    }
  }
  all.forEach((x, i) => { x.id = i + 1; });
  return { sentences: all, errors };
}

// ------------------------------------------------------------------ soundbites

const PROMISE = /\b(fight|fighting|will|I'll|we'll|deliver|lower|protect|stand|work|bring|make sure|for you|families|our community|every)\b/i;

function heuristicPick(list, name, targetSec) {
  const first = String(name).split(/\s+/)[0]; const last = String(name).split(/\s+/).slice(-1)[0];
  const intro = new RegExp(`\\bI(?:'m| am) (?:${first}|${last})`, 'i');
  const scored = list.map((x) => ({ x, score: (intro.test(x.text) ? 5 : 0) + (PROMISE.test(x.text) ? 2 : 0) + (/\b(I|my|I'm|I'll)\b/.test(x.text) ? 1 : 0) - (/\?$/.test(x.text) ? 3 : 0) }))
    .filter((y) => y.score >= 2).sort((a, b) => b.score - a.score);
  const pick = []; let total = 0;
  for (const { x } of scored) { if (total + (x.e - x.s) > targetSec + 2) continue; pick.push(x); total += x.e - x.s; if (total >= targetSec) break; }
  pick.sort((a, b) => (intro.test(b.text) ? 1 : 0) - (intro.test(a.text) ? 1 : 0));
  return pick;
}

/** Choose whole sentences for the short and long ads, plus short on-screen issue titles. */
async function pickBites({ name, office, sentences: list, clips, shortSec, longSec, themes = [], contrast = false, notes = '' }) {
  const byId = new Map(list.map((x) => [x.id, x]));
  const shortTarget = Math.max(8, shortSec - 6); const longTarget = Math.max(20, longSec - 7);
  let short = []; let long = []; let labels = {}; let tagline = ''; let agent = 'basic';
  if (ai.anyConnected() && list.length) {
    const lines = list.filter((x) => x.shot?.usable !== false).slice(0, 400).map((x) => `#${x.id} [video ${x.clip + 1}, ${(x.e - x.s).toFixed(1)}s${x.shot ? `, on screen: ${x.shot.kind}${x.shot.what ? ` - ${x.shot.what}` : ''}` : ''}] ${x.text}`).join('\n').slice(0, 26000);
    const vids = clips.map((c, k) => `video ${k + 1}: ${c.platform}${c.title ? `, "${c.title}"` : ''}`).join('\n');
    const r = await ai.ask({ role: 'writing', json: true, maxTokens: 2500, system: `You edit campaign ads from a candidate's own public speeches. You pick whole sentences from transcripts; you never change, shorten or combine words, and never invent lines. Pick ONLY sentences the candidate ${name} clearly says themselves (first person about their own values, record or plans, or introducing themselves). Skip anything an interviewer, host, reporter or other speaker says, questions, crosstalk, filler and anything unclear; when unsure, skip it. ${contrast ? 'Criticism of an opponent is allowed only if the candidate said it.' : 'Skip attacks on opponents.'} Prefer lines where the shot shows them speaking (speaker or interview) over lines where they are off screen. Tell a story: an introduction or strong hook, then what they will fight for (issue by issue), then a closing line.`, prompt: `CANDIDATE: ${name}${office ? `, ${office}` : ''}\nTHEIR ISSUES: ${themes.join(', ') || 'unknown'}\n${notes ? `FOUNDER NOTES: ${notes}\n` : ''}\nVIDEOS\n${vids}\n\nSENTENCES\n${lines}\n\nReturn JSON: {"short":[sentence ids in play order, about ${shortTarget} seconds total],"long":[ids in play order, about ${longTarget} seconds total],"labels":{"id":"2-5 word on-screen issue title taken from what that sentence says, e.g. Lower health care costs; only for issue sentences"},"tagline":"a short opening title like '${name} is *fighting for you*' (wrap 1-3 words in *stars* for the accent colour; no facts or numbers)"}` });
    const j = r.json || {}; agent = `${r.provider}:${r.model}`;
    const clean = (ids) => [...new Set([].concat(ids || []).map(Number))].map((id) => byId.get(id)).filter(Boolean);
    short = clean(j.short); long = clean(j.long);
    for (const [id, l] of Object.entries(j.labels || {})) { const x = byId.get(Number(id)); const t = String(l || '').replace(/[—–]/g, '-').trim(); if (x && t && t.length <= 40 && (t.match(/\d+/g) || []).every((d) => x.text.includes(d))) labels[x.id] = t; }
    tagline = String(j.tagline || '').replace(/[—–]/g, '-').replace(/\d+/g, '').slice(0, 60);
  }
  if (short.length < 2) { short = heuristicPick(list, name, shortTarget); agent = 'basic'; }
  if (long.length < 2) long = heuristicPick(list, name, longTarget);
  const trim = (arr, max) => { const out = []; let t = 0; for (const x of arr) { if (out.length && t + (x.e - x.s) > max) break; out.push(x); t += x.e - x.s; } return out; };
  const pack = (arr, max) => trim(arr, max).map((x) => ({ id: x.id, clip: x.clip, s: x.s, e: x.e, text: x.text, label: labels[x.id] || null, words: x.words }));
  return { short: pack(short, shortTarget + 4), long: pack(long, longTarget + 6), tagline: tagline || `${name} is *fighting for you*`, agent };
}

/** Quiet stretches (no speech) inside each video, usable as muted B-roll. */
function quietWindows(clips) {
  const out = [];
  clips.forEach((c, k) => {
    const w = c.words || []; let prev = 0.5;
    for (const x of [...w, { s: c.duration - 0.5 }]) { if (x.s - prev >= 2.6) out.push({ clip: k, s: prev + 0.2, e: x.s - 0.2 }); prev = Math.max(prev, x.e || 0); }
    if (!w.length) for (let t = 2; t + 3 < Math.min(c.duration, 120); t += 15) out.push({ clip: k, s: t, e: t + 3 });
  });
  return out;
}

/** B-roll from what's actually on screen: usable crowd and scenery shots, best first. */
function visualBroll(clips) {
  const out = [];
  clips.forEach((c, k) => {
    for (const x of c.vision?.shots || []) {
      if (!x.usable || !['broll', 'crowd'].includes(x.kind) || (x.quality || 3) < 3 || x.e - x.s < 2) continue;
      out.push({ clip: k, s: x.s + 0.15, e: x.e - 0.15, quality: x.quality, what: x.what });
    }
  });
  return out.sort((a, b) => (b.quality || 0) - (a.quality || 0));
}

/** Everything the speech ads need, saved on prospect.pkg.footage. */
async function prepare({ name, office, socials, sites, links, dir, themes, shortSec, longSec, contrast, notes, want = 4, onStep = () => {} }) {
  const found = await find({ name, socials, sites, links }, onStep);
  if (!found.list.length) return { clips: [], bites: { short: [], long: [] }, errors: [...found.errors, 'No public videos found. Paste a few video links on the lead (Facebook, YouTube, X).'] };
  const dl = await download(found.list, path.join(dir, 'footage'), { want, name, onStep });
  if (!dl.clips.length) return { clips: [], bites: { short: [], long: [] }, errors: [...found.errors, ...dl.errors, "Couldn't download any of the videos found."] };
  const tr = await transcribeClips(dl.clips, path.join(dir, 'footage'), onStep);
  // Look through each video shot by shot: who's on camera, crowds, scenery, and what's unusable.
  const vision = require('../video/vision');
  for (let k = 0; k < dl.clips.length; k++) {
    try { dl.clips[k].vision = await vision.look(dl.clips[k].file, { workDir: path.join(dir, 'footage'), maxShots: 30, purpose: `a campaign ad for ${name}: find shots of them speaking and good B-roll`, onProgress: (f, t) => onStep(`Video ${k + 1}: ${t}`) }); }
    catch { dl.clips[k].vision = null; }
  }
  for (const x of tr.sentences) { const sh = vision.shotAt(dl.clips[x.clip].vision, (x.s + x.e) / 2); if (sh) x.shot = sh; }
  onStep('Picking the best lines');
  const bites = await pickBites({ name, office, sentences: tr.sentences, clips: dl.clips, shortSec, longSec, themes, contrast, notes });
  const clips = dl.clips.map(({ words, vision: v, ...c }) => ({ ...c, words: (words || []).length, shots: v?.shots?.length || 0, seen: v?.engine || null }));
  return { clips, bites: { short: bites.short, long: bites.long }, tagline: bites.tagline, agent: bites.agent, broll: [...visualBroll(dl.clips), ...quietWindows(dl.clips)], found: found.list.length, errors: [...found.errors, ...dl.errors, ...tr.errors].slice(0, 12) };
}

// ------------------------------------------------------------------ render

const even = (n) => Math.round(n / 2) * 2;

/** Filter that fills W×H from a video of size sw×sh (centre or face-following crop; blurred fill for tall video in a wide frame). */
function fill(inp, outLabel, sw, sh, W, H, cropX) {
  const sa = sw / sh; const oa = W / H;
  if (sa < oa * 0.8) {
    // Tall video in a wide frame: soft blurred copy behind the full-height picture.
    return `[${inp}]split[${outLabel}a][${outLabel}b];[${outLabel}a]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=28:4,eq=brightness=-0.1[${outLabel}bg];[${outLabel}b]scale=-2:${H}[${outLabel}fg];[${outLabel}bg][${outLabel}fg]overlay=(W-w)/2:0,setsar=1[${outLabel}]`;
  }
  if (sa > oa) { const w2 = even(H * sa); return `[${inp}]scale=${w2}:${H}:flags=lanczos,crop=${W}:${H}:${cropX ?? `(iw-ow)/2`}:0,setsar=1[${outLabel}]`; }
  const h2 = even(W / sa); return `[${inp}]scale=${W}:${h2}:flags=lanczos,crop=${W}:${H}:0:(ih-oh)/2,setsar=1[${outLabel}]`;
}

/** One soundbite: the candidate on camera, B-roll laid over part of it while their voice carries on. */
async function renderBite(b, k, { clips, W, H, vertical, brollPool, stills, work }) {
  const c = clips[b.clip];
  const start = Math.max(0, b.s - 0.08); const dur = Math.min(c.duration - start, b.e - b.s + 0.3);
  // Follow the face in vertical crops of wide video; voice-over when the speaker is hardly on screen.
  let cropX = null; let onCamera = 1;
  try {
    const ft = require('../video/facetrack');
    if (await ft.available()) {
      const tr = await ft.track(c.file, { width: c.width, height: c.height }, start, start + dur, { fps: 3 });
      onCamera = tr.coverage;
      if (vertical && c.width / c.height > 1 && tr.path.length) cropX = ft.cropExpr(tr.path.map((x) => ({ t: x.t - start, x: x.x })), even(H * c.width / c.height), W);
    }
  } catch { /* centre crop */ }
  const overlays = [];
  const cover = onCamera < 0.3 ? [[0, dur]] : dur >= 9 ? [[dur * 0.3, Math.min(3, dur * 0.25)], [dur * 0.68, Math.min(2.6, dur * 0.22)]] : dur >= 4.5 ? [[dur * 0.42, Math.min(3.2, dur * 0.4)]] : [];
  for (const [at, len] of cover) {
    for (let t = at; t < at + len - 0.4; t += 3.4) {
      const L = Math.min(3.4, at + len - t);
      const src = brollPool.next(b.clip);
      if (src) overlays.push({ at: t, len: src.e ? Math.max(1.2, Math.min(L, src.e - src.s)) : L, ...src });
    }
  }
  const inputs = ['-ss', start.toFixed(3), '-t', dur.toFixed(3), '-i', c.file];
  const f = [fill('0:v', 'a0', c.width, c.height, W, H, cropX)];
  f.push(`[a0]eq=contrast=1.05:saturation=1.1,scale=w='trunc(${W}*(1+0.045*t/${dur.toFixed(2)})/2)*2':h=-2:eval=frame,crop=${W}:${H},fps=${FPS}[base]`);
  let last = 'base';
  overlays.forEach((o, i) => {
    const n = i + 1; const lab = `b${n}`;
    if (o.still) {
      inputs.push('-loop', '1', '-framerate', String(FPS), '-t', o.len.toFixed(2), '-i', o.still);
      const W2 = even(W * 1.14); const H2 = even(H * 1.14);
      f.push(`[${n}:v]scale=${W2}:${H2}:force_original_aspect_ratio=increase,crop=${W2}:${H2},crop=${W}:${H}:x='(iw-ow)*t/${o.len.toFixed(2)}':y='(ih-oh)/2',setsar=1[${lab}r]`);
    } else {
      const bc = clips[o.clip];
      inputs.push('-ss', o.s.toFixed(2), '-t', o.len.toFixed(2), '-i', bc.file);
      f.push(fill(`${n}:v`, `${lab}r`, bc.width, bc.height, W, H, null));
    }
    f.push(`[${lab}r]fps=${FPS},format=yuva420p,fade=t=in:st=0:d=0.18:alpha=1,fade=t=out:st=${Math.max(0, o.len - 0.18).toFixed(2)}:d=0.18:alpha=1,setpts=PTS-STARTPTS+${o.at.toFixed(2)}/TB[${lab}]`);
    f.push(`[${last}][${lab}]overlay=eof_action=pass:enable='between(t,${o.at.toFixed(2)},${(o.at + o.len).toFixed(2)})'[o${n}]`);
    last = `o${n}`;
  });
  f.push(`[${last}]format=yuv420p[v]`);
  f.push(`[0:a]aresample=48000,aformat=channel_layouts=stereo,highpass=f=80,afade=t=in:d=0.05,afade=t=out:st=${Math.max(0, dur - 0.15).toFixed(2)}:d=0.15,loudnorm=I=-15:TP=-1.5:LRA=9,aresample=48000[a]`);
  const out = path.join(work, `bite${k}.mp4`);
  await ff.ffmpegWithProgress([...inputs, '-filter_complex', f.join(';'), '-map', '[v]', '-map', '[a]', '-t', dur.toFixed(3), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '17', '-pix_fmt', 'yuv420p', '-r', String(FPS), '-c:a', 'aac', '-b:a', '192k', out], { totalSec: dur });
  return { file: out, dur, start, onCamera, credit: `Footage: ${[c.uploader, c.platform !== 'the web' && c.platform].filter(Boolean).join(' on ') || 'public video'}` };
}

/** B-roll source rotation: quiet stretches of other videos first, then background and candidate photos. */
function pool({ broll = [], stills = [] }) {
  let i = 0; let j = 0;
  return {
    next(avoidClip) {
      const vids = broll.filter((x) => x.clip !== avoidClip);
      const useStill = stills.length && (!vids.length || (i + j) % 2 === 1);
      if (useStill) return { still: stills[j++ % stills.length] };
      if (vids.length) { const w = vids[i++ % vids.length]; return { clip: w.clip, s: w.s, e: w.e }; }
      return null;
    },
  };
}

const assEsc = (t) => String(t || '').replace(/[{}\\]/g, '').replace(/\*/g, '').trim();

/**
 * Render one speech ad. bites from prepare(); info as for motion.renderVideo.
 * Returns { file, duration }.
 */
async function renderSpeechAd({ bites, footage, info, vertical, out, work, music, tagline, office, site, onProgress = () => {} }) {
  const W = vertical ? 1080 : 1920; const H = vertical ? 1920 : 1080; const XF = 0.35;
  fs.mkdirSync(work, { recursive: true });
  const P = campaign.paletteFor({ tone: info.tone, party: info.party, brand: info.brand });
  const clips = footage.clips.map((c) => ({ ...c }));
  const stills = [...(info.backgrounds || []), ...(info.photo ? [info.photo] : [])].filter((x) => x && fs.existsSync(x));
  const brollPool = pool({ broll: footage.broll || [], stills });

  // Graphics: opening title and closing vote card, drawn like the campaign ads.
  onProgress(0.03, 'Drawing the opening title');
  const gInfo = { ...info, style: 'campaign', noTag: true };
  const intro = await motion.renderVideo({ scenes: [{ type: 'photo', who: 'candidate', headline: tagline, sub: office || '', sec: 2.8 }], info: { ...gInfo, noDisclaimer: true }, vertical, out: path.join(work, 'intro.mp4'), work: path.join(work, 'g1') });
  const outro = await motion.renderVideo({ scenes: [{ type: 'vote', headline: `Vote ${info.name}`, button: site || '', sec: 3 }, { type: 'disclaimer', text: `Concept ad by Euclidean Media using public footage of ${info.name}. Not paid for or authorized by any candidate or committee.${info.musicCredit ? ` ${info.musicCredit}.` : ''}`, sec: 2.5 }], info: gInfo, vertical, out: path.join(work, 'outro.mp4'), work: path.join(work, 'g2') });

  const parts = [];
  for (let k = 0; k < bites.length; k++) {
    onProgress(0.1 + 0.7 * (k / bites.length), `Cutting line ${k + 1} of ${bites.length}`);
    parts.push(await renderBite(bites[k], k, { clips, W, H, vertical, brollPool, stills, work }));
  }

  // Captions (their exact words), issue titles, name lower third and footage credits on the montage timeline.
  let off = 0; const words = []; const extra = [];
  const big = vertical ? 66 : 54; const small = vertical ? 30 : 24;
  parts.forEach((pt, k) => {
    const b = bites[k];
    for (const w of b.words || []) words.push({ w: w.w, s: off + (w.s - pt.start), e: off + (w.e - pt.start) });
    if (b.label) {
      const x = vertical ? 70 : 90; const y = vertical ? 300 : 80; const end = off + Math.min(pt.dur, 3);
      extra.push(`Dialogue: 4,${assT(off + 0.1)},${assT(end)},Issue,,0,0,0,,{\\move(${x - 60},${y},${x},${y},0,260)\\fad(140,220)}${assEsc(b.label).toUpperCase()}`);
    }
    extra.push(`Dialogue: 1,${assT(off)},${assT(off + pt.dur)},Credit,,0,0,0,,{\\pos(${vertical ? 50 : 44},${H - (vertical ? 70 : 34)})}${assEsc(pt.credit)}`);
    off += pt.dur;
  });
  const montageDur = off;
  const style = { preset: 'clean-pop', font: 'Montserrat', size: vertical ? 74 : 58, highlight: P.c, wordsPerLine: vertical ? 3 : 5, uppercase: true, hook: false, position: 'lower', outlineWidth: 6 };
  let ass = captions.buildAss({ words, range: { start: 0, end: montageDur }, style, graphics: { lowerThird: { enabled: true, name: info.name, title: office || '', seconds: 3.4 } }, width: W, height: H });
  ass = ass.replace('\n[Events]', `\nStyle: Issue,Montserrat,${big},${captions.assColor('#FFFFFF')},${captions.assColor('#FFFFFF')},${captions.assColor(P.b)},${captions.assColor(P.b)},-1,0,0,0,100,100,1,0,3,18,0,7,0,0,0,1\nStyle: Credit,Montserrat,${small},${captions.assColor('#FFFFFF', 0x30)},${captions.assColor('#FFFFFF')},${captions.assColor('#000000', 0x70)},${captions.assColor('#000000', 0x70)},0,0,0,0,100,100,0,0,1,2,0,1,0,0,0,1\n\n[Events]`) + extra.join('\n') + '\n';
  ensureFonts();
  const assFile = path.join(work, 'speech.ass'); fs.writeFileSync(assFile, ass);
  const rel = path.relative(paths.root, assFile).split(path.sep).join('/').replace(/'/g, '');

  // Tag (same pill as the graphic ads).
  const T = motion.themeFor(info.party, info.theme);
  const tagHtml = path.join(work, 'tag.html'); const tagFile = path.join(work, 'tag.png');
  fs.writeFileSync(tagHtml, `<!doctype html><html><head><meta charset="utf-8"><style>${motion.css(T)}</style></head><body style="width:460px;height:300px"><div style="position:relative;width:460px;height:84px"><div class="pill" style="inset:8px;background:rgba(0,0,0,.45);box-shadow:none;padding:0 26px"><div class="fit" style="font-size:24px;font-weight:600;color:#fff"><span>${motion.esc(info.tag || 'Concept by Euclidean Media')}</span></div></div></div>${motion.FIT}</body></html>`);
  await motion.screenshot(tagHtml, tagFile, 460, 300, work);

  onProgress(0.85, 'Putting it together');
  const inputs = ['-i', intro.file]; const f = [];
  parts.forEach((pt) => inputs.push('-i', pt.file));
  const oi = parts.length + 1; inputs.push('-i', outro.file);
  const ti = oi + 1; inputs.push('-i', tagFile);
  f.push(`${parts.map((_, k) => `[${k + 1}:v][${k + 1}:a]`).join('')}concat=n=${parts.length}:v=1:a=1[mv][ma]`);
  f.push(`[mv]subtitles=filename='${rel}':fontsdir='fonts',fps=${FPS},settb=AVTB[ms]`);
  f.push(`[0:v]fps=${FPS},settb=AVTB[iv];[${oi}:v]fps=${FPS},settb=AVTB[ov]`);
  const o1 = intro.duration - XF; const o2 = o1 + montageDur - XF;
  f.push(`[iv][ms]xfade=transition=fade:duration=${XF}:offset=${o1.toFixed(3)}[x1];[x1][ov]xfade=transition=fadewhite:duration=${XF}:offset=${o2.toFixed(3)}[x2]`);
  f.push(`[${ti}:v]crop=460:84:0:0[tg];[x2][tg]overlay=x=${W - 460 - 24}:y=${H - 84 - (vertical ? 60 : 24)}[vt]`);
  const total = o2 + outro.duration;
  const delay = Math.round(o1 * 1000);
  f.push(`[ma]adelay=${delay}|${delay},apad,atrim=0:${total.toFixed(3)}[sp]`);
  if (music && fs.existsSync(music)) {
    inputs.push('-stream_loop', '-1', '-i', music);
    f.push(`[sp]asplit=2[sv][sk]`, `[${ti + 1}:a]aresample=48000,aformat=channel_layouts=stereo,volume=0.45,afade=t=out:st=${Math.max(0, total - 1.5).toFixed(2)}:d=1.5[mu]`,
      '[mu][sk]sidechaincompress=threshold=0.02:ratio=12:attack=10:release=400:makeup=1[md]', '[sv][md]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.95[a]');
  } else f.push('[sp]anull[a]');
  await ff.ffmpegWithProgress([...inputs, '-filter_complex', f.join(';'), '-map', '[vt]', '-map', '[a]', '-t', total.toFixed(3),
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-maxrate', '9M', '-bufsize', '18M', '-pix_fmt', 'yuv420p', '-r', String(FPS),
    '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', out], { totalSec: total, cwd: paths.root, onProgress: (p) => onProgress(0.85 + p * 0.15, 'Putting it together') });
  return { file: out, duration: total };
}
function assT(t) { t = Math.max(0, t); const h = Math.floor(t / 3600); const m = Math.floor((t % 3600) / 60); const s = Math.floor(t % 60); const cs = Math.floor((t * 100) % 100); return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`; }

module.exports = { find, download, prepare, pickBites, sentences, punctuate, quietWindows, renderSpeechAd, FB_VIDEO, platformOf };
