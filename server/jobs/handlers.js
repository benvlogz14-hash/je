'use strict';
/** Job handlers: every automated step in Euclidean is one of these, run by the queue. */
const fs = require('fs');
const path = require('path');
const ctx = require('../core/ctx');
const events = require('../core/events');
const audit = require('../core/audit');
const paths = require('../core/paths');
const queue = require('./queue');
const ff = require('../video/ffmpeg');
const render = require('../video/render');
const intel = require('../video/intelligence');
const analysis = require('../video/analysis');
const facetrack = require('../video/facetrack');
const exporters = require('../video/exporters');
const ai = require('../integrations/ai');
const publishing = require('../integrations/publishing');
const pipeline = require('../automation/pipeline');
const messaging = require('../automation/messaging');
const { run, now, slug } = require('../core/util');

const permanent = (msg) => Object.assign(new Error(msg), { permanent: true });

// ------------------------------------------------------------ footage intake
queue.register('ingest.file', {
  title: () => 'Import footage',
  async run(job, h) {
    const asset = ctx.store.get('assets', job.payload.assetId);
    if (!asset) throw permanent('Asset no longer exists');
    if (!ctx.capabilities.ffprobe) await require('../setup/production').refreshTools(true);
    if (!ctx.capabilities.ffprobe) throw Object.assign(new Error("FFmpeg isn't installed, so the video can't be read. Press Install FFmpeg at the top of Production, then Retry."), { notConnected: true });
    h.progress(0.1, 'Reading media');
    const info = await ff.probe(asset.path);
    if (!info.hasVideo && !info.hasAudio) throw permanent('File has no audio or video streams');
    if (!info.hasVideo) { ctx.store.update('assets', asset.id, { info, status: 'ready', error: `This is an audio-only file (${path.extname(asset.path) || 'no picture'}). Shorts need video: upload the .mp4 instead.` }); events.publish('assets', { id: asset.id }); return { audioOnly: true }; }
    h.progress(0.4, 'Generating thumbnails');
    const thumb = path.join(asset.workDir, 'thumb.jpg');
    if (info.hasVideo) await ff.thumbnail(asset.path, thumb, Math.min(3, info.duration / 3));
    const strip = path.join(asset.workDir, 'filmstrip.jpg');
    if (info.hasVideo && ctx.setting('resources.mode') !== 'lite') { try { await ff.filmstrip(asset.path, strip, info.duration, 24, 54); } catch (e) { h.log(`Filmstrip skipped: ${e.message}`); } }
    h.progress(0.75, 'Analyzing audio');
    if (info.hasAudio) { try { fs.writeFileSync(path.join(asset.workDir, 'waveform.json'), JSON.stringify(await ff.waveform(asset.path, 1200))); } catch (e) { h.log(`Waveform skipped: ${e.message}`); } }
    ctx.store.update('assets', asset.id, { error: null, info, status: 'ready', thumb: fs.existsSync(thumb) ? thumb : null, filmstrip: fs.existsSync(strip) ? strip : null });
    events.publish('assets', ctx.store.get('assets', asset.id));
    const client = ctx.store.get('clients', asset.clientId);
    const pay = ctx.store.get('jobs', job.id)?.payload || job.payload; // autoProcess can be set just after the job is queued
    if (pay.autoProcess !== false && (client?.schedule?.autopilot || pay.autoProcess)) {
      h.enqueue('transcribe', { assetId: asset.id, thenDiscover: true }, { title: `Transcribe ${asset.name}`, dedupeKey: `transcribe:${asset.id}` });
    }
    return { duration: info.duration, width: info.width, height: info.height };
  },
});

queue.register('ingest.url', {
  title: (p) => `Download ${p.url}`,
  async run(job, h) {
    const { url, clientId } = job.payload;
    const dir = paths.clientDir(clientId, 'footage');
    const ytdlp = ff.ytdlpBin();
    let file = null;
    if (/\.(mp4|mov|m4v|webm|mkv)(\?|$)/i.test(url)) {
      h.progress(0.05, 'Downloading file');
      const res = await fetch(url, { signal: h.signal });
      if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
      file = path.join(dir, path.basename(new URL(url).pathname).replace(/[^\w.\-]/g, '_') || `download-${Date.now()}.mp4`);
      const total = Number(res.headers.get('content-length') || 0); let got = 0;
      const out = fs.createWriteStream(file);
      for await (const chunk of res.body) { out.write(chunk); got += chunk.length; if (total) h.progress(got / total * 0.95, 'Downloading file'); }
      await new Promise((r) => out.end(r));
    } else {
      if (!ctx.capabilities.ytdlp) throw Object.assign(new Error('yt-dlp is not installed, so links from YouTube/Drive/Twitch cannot be downloaded. Install yt-dlp or upload the file.'), { notConnected: true });
      h.progress(0.02, 'Resolving link');
      const r = await run(ytdlp, ['--no-playlist', '-f', 'bv*[height<=1080]+ba/b[height<=1080]/b', '--merge-output-format', 'mp4', '-o', path.join(dir, '%(title).80s [%(id)s].%(ext)s'), '--print', 'after_move:filepath', '--newline', url], {
        signal: h.signal, timeoutMs: 4 * 3600000,
        onLine: (l) => { const m = /\[download\]\s+([\d.]+)%/.exec(l); if (m) h.progress(Number(m[1]) / 100 * 0.95, 'Downloading'); else if (fs.existsSync(l)) file = l; },
      });
      file = file || r.out.trim().split('\n').filter((l) => fs.existsSync(l)).pop();
      if (!file) throw new Error('yt-dlp finished but no file was produced');
    }
    const asset = pipeline.addAsset({ clientId, filePath: file, source: url, actor: job.createdBy });
    if (job.payload.autoProcess) ctx.store.update('jobs', ctx.store.find('jobs', (j) => j.dedupeKey === `ingest:${asset.id}`)?.id, (j) => ({ payload: { ...j.payload, autoProcess: true } }));
    return { assetId: asset.id, file };
  },
});

// ------------------------------------------------------------ transcription & discovery
queue.register('transcribe', {
  title: () => 'Transcribe footage',
  // Local whisper.cpp is CPU/GPU heavy; the OpenAI path is light. Decided per run.
  heavy: () => !!(ctx.setting('ai.transcription.localWhisperPath', '') && ctx.setting('ai.transcription.localWhisperModel', '')),
  remote: true,
  async run(job, h) {
    const asset = ctx.store.get('assets', job.payload.assetId);
    if (!asset) throw permanent('Asset no longer exists');
    if (!asset.info) throw new Error('Asset not imported yet');
    if (!asset.info.hasAudio) { ctx.store.update('assets', asset.id, { status: 'ready', transcript: null }); if (job.payload.thenDiscover) discoverOrWait(h, asset, { dedupeKey: `discover:${asset.id}:${Date.now()}` }); return { skipped: 'no audio' }; }
    ctx.store.update('assets', asset.id, { status: 'transcribing' }); events.publish('assets', { id: asset.id });
    h.progress(0.05, 'Extracting audio');
    // No speech-to-text yet: install the free one (Whisper) right here, once, instead of making clips without captions.
    if (!ai.connected('openai') && !require('../setup/whisper').status().ready && !job.payload.noInstall) {
      try { await require('../setup/whisper').install({ progress: (f, t) => h.progress(0.02 + f * 0.08, `Installing free speech-to-text (one time): ${t || ''}`) }); }
      catch (e) { h.log(`Couldn't install speech-to-text: ${e.message}`); }
    }
    try {
      const t = await intel.transcribe(asset, { jobId: job.id, onProgress: (p) => h.progress(0.1 + p * 0.85, 'Transcribing') });
      ctx.store.update('assets', asset.id, { status: 'ready', transcript: { engine: t.engine, words: t.words.length, language: t.language || null, preview: t.text.slice(0, 280) } });
      events.publish('assets', { id: asset.id });
      if (job.payload.thenDiscover) h.enqueue('analyze', { assetId: asset.id, thenDiscover: true }, { title: `Analyze ${asset.name}`, dedupeKey: `analyze:${asset.id}` });
      // Clips already made from this video without captions: render them again, now with captions.
      for (const c of ctx.store.all('clips', (x) => x.assetId === asset.id && ['review', 'client_review'].includes(x.status) && x.versions?.length && !x.versions[x.versions.length - 1].captioned)) {
        try { pipeline.requestRender(c, { reason: 'captions added' }); } catch { /* already queued */ }
      }
      return { engine: t.engine, words: t.words.length };
    } catch (e) {
      ctx.store.update('assets', asset.id, { status: 'ready' });
      // Without transcription, continue with heuristic discovery (no captions) rather than stalling the client's quota.
      if (e.notConnected && job.payload.thenDiscover) { h.log(e.message); h.enqueue('analyze', { assetId: asset.id, thenDiscover: true }, { title: `Analyze ${asset.name}`, dedupeKey: `analyze:${asset.id}` }); return { skipped: 'no transcription engine' }; }
      throw e;
    }
  },
});

queue.register('studio.transcribe', {
  title: (j) => `Transcribe ${path.basename(j.payload.path || '')} for captions`,
  heavy: () => !!(ctx.setting('ai.transcription.localWhisperPath', '') && ctx.setting('ai.transcription.localWhisperModel', '')),
  async run(job, h) {
    const file = job.payload.path; if (!file || !fs.existsSync(file)) throw permanent('That video file is gone');
    const a = { ...studioAsset(file), info: await ff.probe(file) };
    if (!a.info.hasAudio) return { skipped: 'no audio' };
    if (!ai.connected('openai') && !require('../setup/whisper').status().ready) {
      try { await require('../setup/whisper').install({ progress: (f, t) => h.progress(0.02 + f * 0.08, `Installing free speech-to-text (one time): ${t || ''}`) }); } catch (e) { h.log(`Couldn't install speech-to-text: ${e.message}`); }
    }
    const t = await intel.transcribe(a, { jobId: job.id, onProgress: (p) => h.progress(0.1 + p * 0.85, 'Transcribing') });
    return { engine: t.engine, words: t.words.length };
  },
});

queue.register('analyze', {
  title: () => 'Analyze footage', heavy: true,
  async run(job, h) {
    const asset = ctx.store.get('assets', job.payload.assetId);
    if (!asset) throw permanent('Asset no longer exists');
    h.progress(0.05, 'Finding scene cuts and energy peaks');
    const a = await analysis.analyze(asset, { signal: h.signal, onProgress: (p) => h.progress(0.05 + p * 0.9, 'Analyzing video and audio') });
    ctx.store.update('assets', asset.id, { analysis: { scenes: a.scenes.length, peaks: a.peaks.length } });
    // Look through the picture too: every shot's still, faces, quality and (with an AI that can see) a description.
    if (ctx.setting('video.lookThrough', true) && asset.info?.hasVideo) {
      try {
        const v = await require('../video/vision').look(asset.path, { workDir: asset.workDir, clientId: asset.clientId, jobId: job.id, signal: h.signal, purpose: 'finding short-form clips', onProgress: (p, t) => h.progress(0.6 + p * 0.38, t) });
        ctx.store.update('assets', asset.id, { vision: { shots: v.shots.length, engine: v.engine, usable: v.shots.filter((x) => x.usable).length } });
      } catch (e) { h.log(`Looking through the video: ${e.message}`); }
    }
    if (job.payload.thenDiscover) discoverOrWait(h, asset, { dedupeKey: `discover:${asset.id}:auto` });
    return { scenes: a.scenes.length, peaks: a.peaks.length };
  },
});

function loadAnalysis(asset) {
  const f = path.join(asset.workDir, `${asset.id}.analysis.json`);
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
}

/**
 * Cut-away shots (source [start, end]) the other clips of the same video already use: what they planned for the render in
 * progress (coverSrcs) or their current version's covers, plus B-roll edits' shots. Used so each clip gets different B-roll.
 */
function coversElsewhere(clip) {
  const out = [];
  for (const c of ctx.store.all('clips', (x) => x.assetId === clip.assetId && x.id !== clip.id)) {
    const v = (c.versions || [])[(c.currentVersion || (c.versions || []).length) - 1];
    const list = c.coverSrcs || (v?.covers || []).map((k) => [k.src, k.src + k.dur]);
    out.push(...list.filter((r) => Array.isArray(r) && r[1] > r[0]));
    if (v?.broll?.segs) out.push(...v.broll.segs.map((g) => [g.src, g.src + g.dur]));
  }
  return out;
}

/** A video used in Studio that isn't footage in Production: transcripts kept under <data>/studio/transcripts. */
function studioAsset(file) {
  const workDir = path.join(paths.root, 'studio', 'transcripts'); fs.mkdirSync(workDir, { recursive: true });
  return { id: 'st' + require('crypto').createHash('sha1').update(file).digest('hex').slice(0, 16), path: file, workDir };
}
/** The transcript for any video file: its Production footage transcript, or one made for Studio. */
function studioTranscript(file) {
  const a = ctx.store.find('assets', (x) => x.path === file);
  try { return loadTranscript(a || studioAsset(file)); } catch { return null; }
}

/**
 * After import, transcription and analysis, pick clips now, or (the default) wait for "Make clips" so the clip
 * length, count and AI tips can still be changed. Autopilot clients and footage already started don't wait.
 */
function discoverOrWait(h, asset, opts = {}) {
  const a = ctx.store.get('assets', asset.id) || asset; const cl = ctx.store.get('clients', a.clientId);
  if (cl?.production?.waitForStart !== false && !cl?.schedule?.autopilot && !a.started) {
    ctx.store.update('assets', a.id, { status: 'waiting' }); events.publish('assets', { id: a.id }); h.log('Ready. Waiting for "Make clips".'); return;
  }
  h.enqueue('discover', { assetId: a.id }, { title: `Find clips in ${a.name}`, ...opts });
}

function loadTranscript(asset) {
  const f = path.join(asset.workDir, `${asset.id}.transcript.json`);
  if (!fs.existsSync(f)) return null;
  const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
  // Tidy word times and repetition loops once, and save it, so captions, cuts and the caption editor all agree.
  const t = require('../video/transcript-fix').clean(raw);
  if (t !== raw) { try { fs.writeFileSync(f, JSON.stringify(t)); } catch { /* read-only */ } }
  return t;
}

queue.register('video.look', {
  title: () => 'Look through the video', heavy: true,
  async run(job, h) {
    const asset = ctx.store.get('assets', job.payload.assetId);
    if (!asset) throw permanent('Asset no longer exists');
    const v = await require('../video/vision').look(asset.path, { workDir: asset.workDir, clientId: asset.clientId, jobId: job.id, signal: h.signal, purpose: 'finding short-form clips', onProgress: (p, t) => h.progress(p, t) });
    ctx.store.update('assets', asset.id, { vision: { shots: v.shots.length, engine: v.engine, usable: v.shots.filter((x) => x.usable).length } });
    events.publish('assets', { id: asset.id });
    return { shots: v.shots.length, engine: v.engine };
  },
});

queue.register('discover', {
  title: () => 'Find clips',
  async run(job, h) {
    const asset = ctx.store.get('assets', job.payload.assetId);
    if (!asset) throw permanent('Asset no longer exists');
    const client = ctx.store.get('clients', asset.clientId);
    const count = job.payload.count || client.production?.clipsPerFootage || ctx.setting('production.defaultClipCount', 6);
    // Story text style: no talking clips; each edit tells one part of the video in text lines over its best shots.
    if (client.production?.videoStyle === 'story' && asset.info?.hasVideo !== false) {
      const made = pipeline.createStoryClips(asset, count);
      ctx.store.update('assets', asset.id, { discoveredAt: now(), discoveryMethod: 'story' });
      audit.log('system', 'clips.discovered', { clientId: asset.clientId, assetId: asset.id, count: made.length, method: 'story' });
      return { clips: made.length, method: 'story' };
    }
    h.progress(0.2, 'Measuring the footage');
    const transcript = loadTranscript(asset);
    const result = await intel.discoverClips(asset, transcript, { count, jobId: job.id, onProgress: (f, t) => h.progress(f, t), exclude: pipeline.usedRanges(asset.id), analysis: loadAnalysis(asset), vision: require('../video/vision').cached(asset.path, asset.workDir) });
    if (!result.clips.length) { ctx.store.update('assets', asset.id, { exhausted: true }); return { clips: 0, note: 'No further usable moments found' }; }
    h.progress(0.8, `Creating ${result.clips.length} clips`);
    const clips = pipeline.createClips(asset, result);
    if (client.production?.brollEdit && asset.info?.hasVideo !== false && !ctx.store.find('clips', (c) => c.assetId === asset.id && c.kind === 'broll')) { try { pipeline.createBrollClip(asset); } catch (e) { h.log(`B-roll edit skipped: ${e.message}`); } }
    ctx.store.update('assets', asset.id, { discoveredAt: now(), discoveryMethod: result.method });
    audit.log('system', 'clips.discovered', { clientId: asset.clientId, assetId: asset.id, count: clips.length, method: result.method });
    return { clips: clips.length, method: result.method };
  },
});

// ------------------------------------------------------------ rendering + QC
/** A B-roll edit clip: the best shots of the whole video, cut together to mood music, no original audio. */
async function renderBroll(job, h, clip) {
  const asset = ctx.store.get('assets', clip.assetId); if (!asset) throw permanent('Footage no longer exists');
  const client = ctx.store.get('clients', clip.clientId);
  const n = (clip.versions || []).length + 1; const outDir = path.join(asset.workDir, 'clips', clip.id); fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `v${n}.mp4`);
  h.progress(0.05, 'Picking the best shots');
  const vis = require('../video/vision').cached(asset.path, asset.workDir); const an = loadAnalysis(asset);
  let black = []; try { black = await require('../video/montage').blackIntervals(asset.path, asset.workDir); } catch { /* none */ }
  const be = require('../video/brolledit');
  h.progress(0.15, 'Choosing the music');
  const music = require('../video/music'); const mood = clip.music && !['auto', 'off'].includes(clip.music) ? clip.music : (clip.kind === 'story' ? client?.production?.storyMood || 'suspense' : client?.production?.brollMood || 'darkbeat');
  const track = clip.musicTrack ? { file: await music.resolve(clip.musicTrack) } : await music.pick(mood);
  // Shots used by this footage's earlier B-roll edits are skipped when there are enough others (so daily edits differ).
  const story = clip.kind === 'story';
  const others = ctx.store.all('clips', (c) => c.assetId === asset.id && c.kind === clip.kind && c.id !== clip.id);
  // Story edits avoid the other edits' current shots; B-roll edits avoid every shot earlier edits ever used (daily edits differ).
  const avoid = others.flatMap((c) => (story ? (c.versions || []).slice(-1) : c.versions || []).flatMap((v) => (v.broll?.segs || []).map((s) => [s.src, s.src + s.dur])));
  // Story edits: text lines written for this part of the video, shown on the cuts (story.js).
  let lines = null;
  const texts = story ? async (grid) => {
    const st = require('../video/story');
    h.progress(0.3, 'Writing the story lines');
    const count = Math.max(4, Math.min(10, Math.round(grid.total / 6)));
    const used = others.flatMap((c) => c.versions?.[c.versions.length - 1]?.story?.lines || []);
    lines = clip.storyLines?.length ? { lines: clip.storyLines, by: 'edited' } : await st.lines({ shots: vis?.shots || [], words: loadTranscript(asset)?.words || [], window: clip.window, count, title: asset.name, clientId: clip.clientId, jobId: job.id, avoid: used, part: Math.max(0, (clip.part || 1) - 1) });
    return st.writeAss({ lines: lines.lines, grid, file: path.join(outDir, `v${n}.story.ass`) }).file;
  } : null;
  h.progress(0.2, 'Finding the beat and cutting the shots to it');
  const r = await be.make({ source: asset.path, duration: asset.info?.duration || 0, shots: vis?.shots || [], scenes: an?.scenes || [], black, avoid, music: track?.file || null, length: clip.end - clip.start, out: outPath, volume: Number(clip.musicVol ?? 0.9), signal: h.signal,
    ...(story ? { raw: true, window: clip.window || null, cutBeats: 2.6, texts, strict: true } : {}) });
  const segs = r.segs;
  const qc = await ff.qualityCheck(outPath, { expectWidth: 1080, expectHeight: 1920, minSec: 3, maxSec: 180 });
  const thumb = path.join(outDir, `v${n}.jpg`); await ff.thumbnail(outPath, thumb, Math.min(1.5, r.duration / 2), 405);
  const version = { n, path: outPath, thumb, duration: r.duration, renderedAt: now(), qc: { passed: qc.passed, issues: qc.issues }, captioned: false, broll: { shots: segs.length, mood, track: track?.source || null, bpm: r.bpm, synced: r.synced, segs }, ...(lines ? { story: { lines: lines.lines, by: lines.by } } : {}) };
  ctx.store.update('clips', clip.id, (c) => ({ versions: [...(c.versions || []), version], currentVersion: n, pendingChanges: null }));
  pipeline.afterQc(clip.id, qc);
  return { version: n, duration: r.duration, shots: segs.length };
}

queue.register('render.short', {
  title: () => 'Render short',
  heavy: true, remote: true,
  async run(job, h) {
    const clip = ctx.store.get('clips', job.payload.clipId);
    if (clip?.kind === 'broll' || clip?.kind === 'story') return renderBroll(job, h, clip);
    if (!clip) throw permanent('Clip no longer exists');
    const asset = ctx.store.get('assets', clip.assetId); const client = ctx.store.get('clients', clip.clientId);
    // Check the file itself (not just what import recorded): no picture means no short, so stop here with a clear reason.
    const live = asset && fs.existsSync(asset.path) ? await ff.probe(asset.path).catch(() => null) : null;
    if (!asset || !fs.existsSync(asset.path)) throw permanent("The original video file is missing (moved or deleted). Upload it again.");
    if (!live?.hasVideo) {
      ctx.store.update('assets', asset.id, { info: { ...(asset.info || {}), ...(live || {}), hasVideo: false }, error: 'Audio only: this file has no picture, so it can\'t make shorts. Upload the .mp4 video instead.' });
      for (const j of ctx.store.all('jobs', (x) => x.type === 'render.short' && x.id !== job.id && ['queued'].includes(x.status) && ctx.store.get('clips', x.payload?.clipId)?.assetId === asset.id)) queue.cancel(j.id, 'system');
      for (const c of ctx.store.all('clips', (x) => x.assetId === asset.id && ['queued', 'rendering'].includes(x.status))) ctx.store.update('clips', c.id, { status: 'failed', error: 'Comes from an audio-only file (no picture). Delete these clips and upload the .mp4.' });
      events.publish('clips', {});
      throw permanent('This clip comes from an audio-only file (no picture). Delete it and upload the video (.mp4).');
    }
    if (!ctx.capabilities.ffmpeg) throw Object.assign(new Error('FFmpeg not found'), { notConnected: true });
    ctx.store.update('clips', clip.id, { renderProgress: 0, error: null });
    if (!ctx.capabilities.libass) h.log('Warning: this FFmpeg build lacks libass; captions cannot be burned in.');
    const transcript = loadTranscript(asset);
    const n = (clip.versions || []).length + 1;
    const outDir = paths.clientDir(client.id, 'renders', clip.id);
    const outPath = path.join(outDir, `v${n}-${slug(clip.title).slice(0, 40)}.mp4`);
    const facePath = await faceTrackFor(clip, asset, h);
    // Visual cuts: weak or static stretches get the best shots from elsewhere (drone first) while the voice keeps going.
    let src = { source: asset.path, info: asset.info, range: { start: clip.start, end: clip.end }, words: transcript?.words || [], facePath };
    let covers = []; let assembled = null;
    if (clip.visualCuts !== false && client.production?.visualCuts !== false) {
      try {
        const montage = require('../video/montage');
        const vis = require('../video/vision').cached(asset.path, asset.workDir);
        if (vis?.shots?.length) {
          const sig = await montage.signals({ asset, transcript, vision: vis, analysis: null });
          const avoid = ctx.store.all('clips', (c) => c.assetId === asset.id && c.id !== clip.id).map((c) => ({ start: c.start, end: c.end }));
          let black = []; try { black = await montage.blackIntervals(asset.path, asset.workDir); } catch { /* no scan */ }
          covers = montage.planCovers({ start: clip.start, end: clip.end, shots: sig.shots, sents: sig.sents, avoid, black, elsewhere: coversElsewhere(clip) });
          ctx.store.update('clips', clip.id, { coverSrcs: covers.map((c) => [c.src, c.src + c.dur]) }); // so clips rendering at the same time see these too
          if (covers.length) {
            h.progress(0.08, `Cutting in ${covers.length} shot${covers.length > 1 ? 's' : ''}`);
            assembled = path.join(outDir, `v${n}-assembled.mp4`); fs.mkdirSync(outDir, { recursive: true });
            await montage.assemble({ source: asset.path, info: asset.info, start: clip.start, end: clip.end, covers, out: assembled, signal: h.signal });
            const len = clip.end - clip.start;
            src = { source: assembled, info: await ff.probe(assembled), range: { start: 0, end: len }, words: (transcript?.words || []).filter((w) => w.e > clip.start && w.s < clip.end).map((w) => ({ ...w, s: w.s - clip.start, e: w.e - clip.start })), facePath: facePath ? facePath.map((p) => ({ ...p, t: p.t - clip.start })) : null };
          }
        }
      } catch (e) { covers = []; assembled = null; h.log(`Visual cuts skipped: ${e.message}`); }
    }
    // Black stretches in this clip's part of the footage are found before rendering (only these seconds are scanned) and
    // covered with good shots now, so the clip renders once. The check after rendering stays as a safety net.
    try {
      const montage = require('../video/montage');
      const pre = (await montage.blackInRange(asset.path, clip.start, clip.end)).filter(([a, b]) => b - a >= 0.2);
      const open = pre.filter(([a, b]) => !covers.some((c) => c.at <= a + 0.05 && c.at + c.dur >= b - 0.05));
      if (open.length) {
        const vis = require('../video/vision').cached(asset.path, asset.workDir);
        const extra = await montage.coverBlack({ forced: open, start: clip.start, end: clip.end, duration: asset.info?.duration || clip.end, shots: vis?.shots || [], scenes: loadAnalysis(asset)?.scenes || [], black: [...open], used: covers.map((c) => [c.src, c.src + c.dur]), elsewhere: coversElsewhere(clip), isDark: (a, d) => montage.darkAt(asset.path, a, d).catch(() => false) });
        if (extra.length) {
          covers = [...covers.filter((c) => !extra.some((x) => c.at < x.at + x.dur && c.at + c.dur > x.at)), ...extra].sort((a, b) => a.at - b.at);
          assembled = path.join(outDir, `v${n}-assembled.mp4`); fs.mkdirSync(outDir, { recursive: true });
          await montage.assemble({ source: asset.path, info: asset.info, start: clip.start, end: clip.end, covers, out: assembled, signal: h.signal });
          src = { source: assembled, info: await ff.probe(assembled), range: { start: 0, end: clip.end - clip.start }, words: (transcript?.words || []).filter((w) => w.e > clip.start && w.s < clip.end).map((w) => ({ ...w, s: w.s - clip.start, e: w.e - clip.start })), facePath: facePath ? facePath.map((p) => ({ ...p, t: p.t - clip.start })) : null };
          h.log(`Covered ${open.length} black stretch${open.length > 1 ? 'es' : ''} before rendering`);
        }
      }
    } catch (e) { h.log(`Black check before rendering skipped: ${e.message}`); }
    h.progress(0.12, `Rendering v${n}`);
    const pauses = (await pausesFor(asset)) || [];
    const renderArgs = () => ({ facePath: src.facePath, graphics: client.graphics,
      source: src.source, info: src.info, range: src.range, words: src.words, style: { ...(client.style || {}), ...(clip.style || {}) }, hook: clip.hook, keywords: clip.keywords || null,
      reframe: clip.reframe, focusX: clip.focusX, plan: { keep: (clip.keep || []).map(([a, b]) => (assembled ? [a - clip.start, b - clip.start] : [a, b])), silenceCut: clip.silenceCut !== false, silences: pauses.map(([a, b]) => (assembled ? [a - clip.start, b - clip.start] : [a, b])), retakeCut: client.production?.retakeCut !== false && clip.retakeCut !== false, punchIns: clip.punchIns }, logo: client.production?.logoPath || null,
      outPath, crf: ctx.setting('production.crf', 20), loudness: ctx.setting('production.loudnessLufs', -14), signal: h.signal,
      onProgress: (p) => { h.progress(0.12 + p * 0.7, `Rendering v${n}`); const pct = Math.round((0.12 + p * 0.7) * 100); if (pct - (ctx.store.get('clips', clip.id)?.renderProgress || 0) >= 4) { ctx.store.update('clips', clip.id, { renderProgress: pct }); events.publish('clips', { id: clip.id }); } },
    });
    let r = await render.renderShort(renderArgs());
    // Black-frame guard: any black stretch left in the finished clip (long fades, black between scenes, footage that
    // wasn't looked through) is covered with good picture from elsewhere while the voice keeps going, then re-checked.
    try {
      const montage = require('../video/montage');
      for (let pass = 0; pass < 2; pass++) {
        const outBlack = (await montage.blackIntervals(outPath, outDir, { loose: true, cache: false })).filter(([a, b]) => b - a >= 0.25);
        if (!outBlack.length) break;
        const forced = montage.outputToSource(outBlack, r.segments, assembled ? clip.start : 0);
        const vis = require('../video/vision').cached(asset.path, asset.workDir);
        let srcBlack = []; try { srcBlack = await montage.blackIntervals(asset.path, asset.workDir, { cachedOnly: true }); } catch { /* no scan */ } // only a scan already saved; candidates are checked one by one (darkAt)
        const extra = await montage.coverBlack({ forced, start: clip.start, end: clip.end, duration: asset.info?.duration || clip.end, shots: vis?.shots || [], scenes: loadAnalysis(asset)?.scenes || [], black: [...srcBlack, ...forced], used: covers.map((c) => [c.src, c.src + c.dur]), elsewhere: coversElsewhere(clip), isDark: (a, d) => montage.darkAt(asset.path, a, d).catch(() => false) });
        if (!extra.length) { h.log('Black frames found, but no clean shots to cover them'); break; }
        h.log(`Covering ${outBlack.length} black stretch${outBlack.length > 1 ? 'es' : ''} with ${extra.length} shot${extra.length > 1 ? 's' : ''}`);
        covers = [...covers.filter((c) => !extra.some((x) => c.at < x.at + x.dur && c.at + c.dur > x.at)), ...extra].sort((a, b) => a.at - b.at);
        assembled = path.join(outDir, `v${n}-assembled.mp4`);
        await montage.assemble({ source: asset.path, info: asset.info, start: clip.start, end: clip.end, covers, out: assembled, signal: h.signal });
        src = { source: assembled, info: await ff.probe(assembled), range: { start: 0, end: clip.end - clip.start }, words: (transcript?.words || []).filter((w) => w.e > clip.start && w.s < clip.end).map((w) => ({ ...w, s: w.s - clip.start, e: w.e - clip.start })), facePath: facePath ? facePath.map((p) => ({ ...p, t: p.t - clip.start })) : null };
        h.progress(0.6, 'Re-rendering without the black frames');
        r = await render.renderShort(renderArgs());
      }
    } catch (e) { h.log(`Black-frame check skipped: ${e.message}`); }
    // Music: decides when it plays and its mood (creepy, suspense, triumphant...), ducked under the voice.
    let musicSheet = null;
    const musicOn = client.production?.music !== false && clip.music !== 'off' && ctx.setting('production.music', true) !== false;
    const voiceGain = Number(clip.voiceVol ?? 1);
    if (musicOn || Math.abs(voiceGain - 1) > 0.01) {
      try {
        h.progress(0.83, 'Adding music');
        const vis = require('../video/vision').cached(asset.path, asset.workDir);
        const off = assembled ? clip.start : 0; // the assembled file starts at the clip's start
        const shots = (vis?.shots || []).filter((x) => x.e > clip.start && x.s < clip.end).map((x) => ({ ...x, s: render.remap(Math.max(x.s, clip.start) - off, r.segments), e: render.remap(Math.min(x.e, clip.end) - off, r.segments) })).filter((x) => x.e > x.s);
        musicSheet = await require('../video/score').plan({ words: r.cutWords || [], shots, duration: r.duration, title: clip.title, hook: clip.hook, forced: musicOn ? clip.music || client.production?.musicMood || 'auto' : 'off', track: clip.musicTrack, clientId: client.id, jobId: job.id });
        if (musicSheet?.cues.some((c) => c.file) || Math.abs(voiceGain - 1) > 0.01) {
          const tmp = outPath.replace(/\.mp4$/, '.music.mp4');
          const done = await require('../video/music').scoreVideo({ video: outPath, cues: musicSheet?.cues || [], out: tmp, duration: r.duration, voice: voiceGain, volume: Number(clip.musicVol ?? client.production?.musicVolume ?? ctx.setting('production.musicVolume', 0.3)) });
          if (done) fs.renameSync(tmp, outPath);
        }
      } catch (e) { musicSheet = null; h.log(`Music skipped: ${e.message}`); }
    }
    // Both sizes: the same cut, captions and music in full frame (16:9), for a side-by-side look.
    let wideOut = null;
    if (clip.wide) {
      try {
        h.progress(0.84, 'Rendering the full-frame version');
        wideOut = outPath.replace(/\.mp4$/, '-wide.mp4');
        const rw = await render.renderShort({ graphics: client.graphics, source: src.source, info: src.info, range: src.range, words: src.words, style: { ...(client.style || {}), ...(clip.style || {}) }, hook: clip.hook, keywords: clip.keywords || null, wide: true,
          plan: { keep: (clip.keep || []).map(([a, b]) => (assembled ? [a - clip.start, b - clip.start] : [a, b])), silenceCut: clip.silenceCut !== false, silences: ((await pausesFor(asset)) || []).map(([a, b]) => (assembled ? [a - clip.start, b - clip.start] : [a, b])), retakeCut: client.production?.retakeCut !== false && clip.retakeCut !== false, punchIns: clip.punchIns }, logo: client.production?.logoPath || null,
          outPath: wideOut, crf: ctx.setting('production.crf', 20), loudness: ctx.setting('production.loudnessLufs', -14), signal: h.signal });
        if (musicSheet?.cues.some((c) => c.file) || Math.abs(voiceGain - 1) > 0.01) {
          const tmp = wideOut.replace(/\.mp4$/, '.music.mp4');
          if (await require('../video/music').scoreVideo({ video: wideOut, cues: musicSheet?.cues || [], out: tmp, duration: rw.duration, voice: voiceGain, volume: Number(clip.musicVol ?? client.production?.musicVolume ?? ctx.setting('production.musicVolume', 0.3)) })) fs.renameSync(tmp, wideOut);
        }
      } catch (e) { wideOut = null; h.log(`Full-frame version skipped: ${e.message}`); }
    }
    if (assembled) { try { fs.unlinkSync(assembled); } catch { /* in use */ } }
    h.progress(0.85, 'Quality check');
    const qc = await ff.qualityCheck(outPath, { expectWidth: 1080, expectHeight: 1920, minSec: 5, maxSec: 180 });
    const thumb = path.join(outDir, `v${n}.jpg`);
    await ff.thumbnail(outPath, thumb, Math.min(1.5, r.duration / 2), 405);
    // Interchange files so a human can finish the edit in Velo or Premiere.
    const velo = path.join(outDir, `v${n}.velo`);
    fs.writeFileSync(velo, JSON.stringify(exporters.toVelo({ name: clip.title, source: asset.path, info: asset.info, range: { start: clip.start, end: clip.end }, words: transcript?.words || [], style: { ...(client.style || {}), ...(clip.style || {}) }, hook: clip.hook, focusX: clip.focusX }), null, 1));
    const xml = path.join(outDir, `v${n}.premiere.xml`);
    fs.writeFileSync(xml, exporters.toFcpXml({ name: clip.title, source: asset.path, info: asset.info, range: { start: clip.start, end: clip.end } }));
    const version = { n, path: outPath, ...(wideOut ? { wide: wideOut } : {}), thumb, duration: r.duration, renderedAt: now(), encoder: r.encoder, qc: { passed: qc.passed, issues: qc.issues }, srt: r.srtPath, velo, xml, changes: clip.pendingChanges || null, captioned: !!transcript, look: (({ font, size, hookFont }) => ({ font: font || 'Montserrat', size, hookFont }))({ ...(client.style || {}), ...(clip.style || {}) }), cuts: covers.length, covers, music: musicSheet ? { how: musicSheet.how, cues: musicSheet.cues.map((c) => ({ start: Math.round(c.start * 10) / 10, end: Math.round(c.end * 10) / 10, mood: c.mood, why: c.why || '', track: c.track || null, source: c.source || null })) } : null };
    ctx.store.update('clips', clip.id, (c) => ({ versions: [...(c.versions || []), version], currentVersion: n, pendingChanges: null, coverSrcs: covers.map((k) => [k.src, k.src + k.dur]) }));
    pipeline.afterQc(clip.id, qc);
    return { version: n, duration: r.duration, qc: qc.passed ? 'passed' : 'failed', encoder: r.encoder };
  },
});

/** Pauses in the footage's audio (cached), for jump cuts when there is no transcript yet. */
async function pausesFor(asset) {
  if (!asset.info?.hasAudio) return null;
  const f = path.join(asset.workDir || path.dirname(asset.path), `${asset.id}.pauses.json`);
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { /* not yet */ }
  try { const { silences } = await ff.speechWindows(asset.path); fs.writeFileSync(f, JSON.stringify(silences)); return silences; } catch { return null; }
}

/** Face-track the clip range once (cached on the clip) when the reframe mode uses it. */
async function faceTrackFor(clip, asset, h) {
  if (!['face', 'smart-blur'].includes(clip.reframe) || !asset.info?.hasVideo) return null;
  if (!ctx.capabilities.faceTracking) { h.log('Face tracking unavailable; using the fixed focus position'); return null; }
  const c = clip.faceTrack;
  if (c && c.start === clip.start && c.end === clip.end) return c.coverage >= 0.15 ? c.path : null;
  h.progress(0.03, 'Tracking faces');
  try {
    const t = await facetrack.track(asset.path, asset.info, clip.start, clip.end, { fps: 3 });
    ctx.store.update('clips', clip.id, { faceTrack: { start: clip.start, end: clip.end, path: t.path, coverage: Math.round(t.coverage * 100) / 100 } });
    h.log(`Face tracking: faces in ${Math.round(t.coverage * 100)}% of frames, ${t.path.length} camera keyframes`);
    return t.coverage >= 0.15 ? t.path : null;
  } catch (e) { h.log(`Face tracking skipped: ${e.message}`); return null; }
}

queue.register('studio.export', {
  title: () => 'Export Studio project', heavy: true,
  async run(job, h) {
    const studio = require('../video/studio');
    const proj = ctx.store.get('projects', job.payload.projectId);
    if (!proj) throw permanent('Project not found');
    const dir = job.payload.outDir || (proj.clientId ? paths.clientDir(proj.clientId, 'studio') : paths.exports('studio'));
    fs.mkdirSync(dir, { recursive: true });
    const baseName = job.payload.fileName || `${slug(proj.name || 'Untitled edit')}-${Date.now().toString(36)}`;
    let out = path.join(dir, `${baseName}.mp4`); let n = 2;
    while (fs.existsSync(out)) out = path.join(dir, `${baseName} (${n++}).mp4`); // never overwrite an earlier export
    const r = await studio.exportProject(proj.data, out, { signal: h.signal, onProgress: (p) => h.progress(p * 0.95, 'Rendering timeline') });
    ctx.store.update('projects', proj.id, (p) => ({ exports: [...(p.exports || []), { path: out, at: now(), warnings: r.warnings }] }));
    events.publish('notify', { title: 'Export finished', body: path.basename(out) });
    events.publish('studio.exported', { projectId: proj.id, path: out, warnings: r.warnings });
    if (job.payload.reveal !== false && ctx.revealFile) ctx.revealFile(out);
    return { path: out, warnings: r.warnings };
  },
});

// ------------------------------------------------------------ revisions (feedback → GPT/Claude → re-edit)
queue.register('clip.revise', {
  title: () => 'Apply feedback',
  async run(job, h) {
    const clip = ctx.store.get('clips', job.payload.clipId);
    if (!clip) throw permanent('Clip no longer exists');
    const client = ctx.store.get('clients', clip.clientId); const asset = ctx.store.get('assets', clip.assetId);
    h.progress(0.2, 'Interpreting feedback');
    const plan = await intel.planRevision({ clip, client, feedback: job.payload.feedback, transcriptExcerpt: intel.transcriptExcerpt(loadTranscript(asset), clip.start, clip.end), jobId: job.id });
    const ch = plan.changes || {};
    const patch = {};
    for (const k of ['start', 'end', 'hook', 'title', 'caption', 'reframe', 'focusX', 'silenceCut', 'punchIns']) if (ch[k] !== undefined) patch[k] = ch[k];
    if (patch.start != null || patch.end != null) {
      const s = Math.max(0, Number(patch.start ?? clip.start)), e = Math.min(asset.info.duration, Number(patch.end ?? clip.end));
      if (e - s >= 3) { patch.start = s; patch.end = e; } else { delete patch.start; delete patch.end; }
    }
    // One-off style change for this clip vs durable preference for all future videos.
    if (plan.remember?.length) pipeline.remember(client.id, plan.remember, { source: job.payload.source === 'client' ? 'client feedback' : 'founder feedback', actor: `agent:${plan.agent}` });
    else if (ch.style) ctx.store.update('clients', client.id, (c) => ({ style: { ...c.style, ...pipeline.sanitizeStyle(ch.style) } }));
    ctx.store.update('clips', clip.id, patch);
    if (plan.needsHuman) {
      ctx.store.update('clips', clip.id, { status: 'review' });
      ctx.store.insert('approvals', { kind: 'clip', refId: clip.id, clientId: client.id, title: `Needs a human: ${clip.title}`, summary: plan.reason || job.payload.feedback, status: 'pending', stage: 'internal', createdBy: 'system' });
      return { needsHuman: true, reason: plan.reason };
    }
    pipeline.requestRender(ctx.store.get('clips', clip.id), { reason: 'revision', changes: { feedback: job.payload.feedback, applied: patch, remembered: (plan.remember || []).map((r) => r.text) } });
    // Acknowledge client feedback in the same thread it came from.
    if (job.payload.source === 'client' && plan.reply && job.payload.conversationId) {
      try { messaging.createOutbound({ conversationId: job.payload.conversationId, body: plan.reply, aiGenerated: true, agent: plan.agent, category: 'routine', actor: 'system' }); } catch (e) { h.log(`Reply not sent: ${e.message}`); }
    }
    return { applied: patch, remembered: plan.remember || [], agent: plan.agent };
  },
});

// ------------------------------------------------------------ Premiere via Astra (external agent)
queue.register('premiere.handoff', {
  external: true, assignee: 'computer-use',
  title: () => 'Premiere edit (Astra)',
  async run() { throw new Error('Completed by a computer-use agent through the API'); },
});

// ------------------------------------------------------------ publishing
queue.register('publish.post', {
  vital: true,
  title: () => 'Publish post',
  async run(job, h) {
    const post = ctx.store.get('posts', job.payload.postId);
    if (!post) throw permanent('Post no longer exists');
    if (post.status === 'published' || post.status === 'canceled') return { skipped: post.status };
    const client = ctx.store.get('clients', post.clientId); const clip = ctx.store.get('clips', post.clipId);
    if (clip.status !== 'scheduled' && clip.status !== 'approved') throw permanent(`Clip is ${clip.status}; only approved content is published`);
    const v = clip.versions[(post.version || clip.currentVersion) - 1];
    if (!v || !fs.existsSync(v.path)) throw permanent('Rendered video file is missing');
    ctx.store.update('posts', post.id, { status: 'publishing' }); events.publish('posts', { id: post.id });
    h.progress(0.2, 'Uploading');
    try {
      const r = await publishing.publish({ client, post: { ...post, videoPath: v.path }, videoPath: v.path });
      ctx.store.update('posts', post.id, { status: 'published', publishedAt: now(), results: r.results, mode: r.mode, providerId: r.providerId || null, packagePath: r.path || null, note: r.note || null });
      ctx.store.update('clips', clip.id, { status: 'published' });
      audit.log('system', 'post.published', { postId: post.id, clientId: client.id, mode: r.mode, platforms: post.platforms });
      events.publish('posts', { id: post.id });
      return r;
    } catch (e) {
      ctx.store.update('posts', post.id, { status: 'scheduled', lastError: e.message });
      throw e;
    }
  },
});

queue.register('analytics.sync', {
  title: () => 'Sync analytics',
  async run(job, h) {
    const posts = ctx.store.all('posts', (p) => p.status === 'published' && p.publishedAt > new Date(Date.now() - 30 * 864e5).toISOString());
    let updated = 0; const errors = [];
    const byClient = {};
    for (const p of posts) (byClient[p.clientId] = byClient[p.clientId] || []).push(p);
    for (const [clientId, list] of Object.entries(byClient)) {
      const client = ctx.store.get('clients', clientId);
      const yt = list.map((p) => p.results?.youtube?.id).filter(Boolean);
      if (yt.length && require('../core/secrets').has(`client.${clientId}.youtube.token`)) {
        try {
          const stats = await publishing.ytStats(clientId, yt);
          for (const p of list) { const s = stats[p.results?.youtube?.id]; if (s) { ctx.store.update('posts', p.id, (x) => ({ stats: { ...(x.stats || {}), youtube: s }, statsAt: now() })); updated++; } }
        } catch (e) { errors.push(`${client.name} YouTube: ${e.message}`); }
      }
      if (publishing.ayrConfigured()) {
        for (const p of list.filter((x) => x.mode?.includes('ayrshare') && x.providerId)) {
          for (const pid of String(p.providerId).split(',')) {
            try {
              const a = await publishing.ayrAnalytics(pid, p.platforms, client);
              const stats = {};
              for (const plat of p.platforms) { const d = a[plat]?.analytics || a[plat]; if (d) stats[plat] = { views: d.views ?? d.videoViews ?? d.playCount ?? d.impressionCount ?? 0, likes: d.likes ?? d.likeCount ?? d.reactions ?? 0, comments: d.comments ?? d.commentCount ?? 0, shares: d.shares ?? d.shareCount ?? 0 }; }
              ctx.store.update('posts', p.id, (x) => ({ stats: { ...(x.stats || {}), ...stats }, statsAt: now() })); updated++;
            } catch (e) { errors.push(`${client.name} Ayrshare: ${e.message}`); }
          }
        }
      }
    }
    // Tracked creators (Analytics → Creators) refresh on the same schedule.
    for (const c of ctx.store.all('creators')) if (!c.syncedAt || Date.now() - new Date(c.syncedAt).getTime() > 5 * 3600e3) queue.enqueue('creator.sync', { creatorId: c.id }, { dedupeKey: `creator:${c.id}` });
    h.progress(1, `${updated} posts updated`);
    if (!updated && errors.length) throw new Error(errors.slice(0, 3).join(' · '));
    return { updated, errors };
  },
});

// ------------------------------------------------------------ tracked creators (Analytics → Creators)
queue.register('creator.sync', {
  title: (p) => `Update creator stats${ctx.store.get('creators', p.creatorId) ? `: ${ctx.store.get('creators', p.creatorId).name}` : ''}`,
  maxAttempts: 2,
  async run(job, h) {
    const creators = require('../integrations/creators');
    const c = ctx.store.get('creators', job.payload.creatorId);
    if (!c) return { skipped: true };
    const full = !!job.payload.full;
    h.progress(0.2, full ? 'Collecting the full upload history' : 'Fetching public stats');
    let st;
    try { st = await creators.fetchStats(c, { full }); }
    catch (e) { ctx.store.update('creators', c.id, { syncError: e.message, syncedAt: now() }); events.publish('creators', {}); throw permanent(e.message); }
    h.progress(0.85, 'Saving');
    const videos = creators.mergeVideos(c.videos || [], st.videos || []);
    const m = creators.metrics(videos);
    const followers = st.followers ?? c.followers ?? null;
    ctx.store.update('creators', c.id, (x) => ({
      name: x.nameLocked ? x.name : st.name || x.name, handle: x.handle || st.handle || '', avatar: st.avatar || x.avatar || null, about: st.about || x.about || '',
      keywords: st.keywords?.length ? st.keywords : x.keywords || [], channelId: x.channelId || st.channelId || null, totalVideos: st.totalVideos ?? x.totalVideos ?? null,
      followers, followersSource: st.followers != null ? 'auto' : x.followersSource, videos, metrics: m, syncedAt: now(), syncError: null, verified: true, partial: !!st.partial,
      fullHistoryAt: full ? now() : x.fullHistoryAt || null,
      // one follower snapshot per day is enough for monthly numbers
      history: [...(x.history || []).filter((hh) => String(hh.at).slice(0, 10) !== now().slice(0, 10)), { at: now(), followers, avgViews: m.avgViews, medianViews: m.medianViews, uploads: videos.length, totalViews: m.totalViews }].slice(-800),
    }));
    events.publish('creators', {});
    return { followers, uploads: videos.length, new: videos.length - (c.videos || []).length };
  },
});

// ------------------------------------------------------------ messaging
queue.register('message.send', { vital: true, maxAttempts: 5, title: () => 'Send message', run: messaging.deliver });

const TRIAGE_SYSTEM = `You are the operations agent for a video agency, reading one new inbound message from a client or lead.
Classify it and decide safe actions. Return JSON:
{"intent":"footage_submission"|"revision_request"|"approval"|"question"|"scheduling"|"complaint"|"pricing"|"new_lead"|"thanks"|"other",
 "urgency":"low"|"normal"|"high","sentiment":"positive"|"neutral"|"negative","summary":"<=20 words",
 "actions":[
   {"type":"approve_clips","refs":[numbers from the review list] or "all"},
   {"type":"revise_clip","ref":number,"feedback":"the client's requested change in their words"},
   {"type":"ingest_links","urls":["..."]},
   {"type":"remember","text":"durable preference stated by the client"}
 ],
 "reply":{"text":"reply in a warm, concise, professional voice; never invent prices, dates or promises","category":"routine"|"pricing"|"commitment"|"complaint"|"contract"|"sensitive"}}
Rules: only approve clips the client clearly approved. Questions about money, contracts, scope, or anything upset → category is not routine. If no reply is needed, set reply to null.`;

queue.register('message.triage', {
  vital: true,
  title: () => 'Triage message',
  async run(job, h) {
    const msg = ctx.store.get('messages', job.payload.messageId);
    if (!msg) throw permanent('Message deleted');
    const contact = ctx.store.get('contacts', msg.contactId);
    const client = msg.clientId ? ctx.store.get('clients', msg.clientId) : null;
    const history = ctx.store.all('messages', (m) => m.conversationId === msg.conversationId && m.direction !== 'internal').slice(-12)
      .map((m) => `${m.direction === 'in' ? contact.name : 'Agency'} (${m.channel}${m.subject ? `, "${m.subject}"` : ''}): ${m.body}`).join('\n');
    const reviewList = client ? ctx.store.all('clips', (c) => c.clientId === client.id && c.status === 'client_review') : [];
    const r = await ai.ask({
      role: 'operations', json: true, clientId: client?.id, jobId: job.id, system: TRIAGE_SYSTEM, maxTokens: 1200,
      prompt: `Sender: ${contact.name} (${contact.role}${client ? `, client ${client.name}` : ''})\n${reviewList.length ? `Videos currently awaiting their review:\n${reviewList.map((c, i) => `${i + 1}. ${c.title}`).join('\n')}\n` : ''}\nRecent thread:\n${history}\n\nNEW MESSAGE: ${msg.subject ? `Subject: ${msg.subject}\n` : ''}${msg.body}${msg.attachments?.length ? `\n[${msg.attachments.length} attachment(s): ${msg.attachments.map((a) => a.name).join(', ')}]` : ''}`,
    });
    const t = r.json; const done = [];
    ctx.store.update('messages', msg.id, { triage: { intent: t.intent, urgency: t.urgency, sentiment: t.sentiment, summary: t.summary, agent: `${r.provider}:${r.model}` } });
    for (const a of t.actions || []) {
      try {
        if (a.type === 'approve_clips' && client) {
          const targets = a.refs === 'all' ? reviewList : (a.refs || []).map((n) => reviewList[n - 1]).filter(Boolean);
          for (const c of targets) pipeline.decideClip(c.id, 'approve', { actor: `contact:${contact.id}`, stage: 'client' });
          done.push(`Approved ${targets.length} clip(s)`);
        } else if (a.type === 'revise_clip' && client) {
          const c = reviewList[(a.ref || 1) - 1] || reviewList[0];
          if (c) { pipeline.decideClip(c.id, 'changes', { actor: `contact:${contact.id}`, note: a.feedback || msg.body, stage: 'client' }); const rj = ctx.store.all('jobs', (j) => j.type === 'clip.revise' && j.payload.clipId === c.id).pop(); if (rj) ctx.store.update('jobs', rj.id, (j) => ({ payload: { ...j.payload, conversationId: msg.conversationId } })); done.push(`Revision queued for "${c.title}"`); }
        } else if (a.type === 'ingest_links' && client) {
          for (const url of (a.urls || []).filter((u) => /^https?:\/\//.test(u)).slice(0, 10)) queue.enqueue('ingest.url', { url, clientId: client.id, autoProcess: true }, { clientId: client.id, actor: `contact:${contact.id}` });
          done.push(`Queued ${(a.urls || []).length} link(s) for download`);
        } else if (a.type === 'remember' && client && a.text) {
          pipeline.remember(client.id, [{ text: a.text }], { source: 'client message', actor: `agent:${r.provider}` }); done.push('Saved a client preference');
        }
      } catch (e) { h.log(`Action ${a.type} failed: ${e.message}`); }
    }
    // A revision triggers its own acknowledgement after the edit plan is made; avoid double replies.
    const revising = (t.actions || []).some((a) => a.type === 'revise_clip');
    if (t.reply?.text && !revising) {
      try { messaging.createOutbound({ conversationId: msg.conversationId, body: t.reply.text, aiGenerated: true, agent: `${r.provider}:${r.model}`, category: t.reply.category || 'routine', actor: 'system' }); }
      catch (e) { h.log(`Reply draft not created: ${e.message}`); }
    }
    if (done.length) messaging.addMessage(ctx.store.get('conversations', msg.conversationId), { direction: 'internal', channel: 'note', body: `Automation: ${done.join(' · ')}`, status: 'note', aiGenerated: true, agent: `${r.provider}:${r.model}` });
    return { intent: t.intent, actions: done };
  },
});

// ------------------------------------------------------------ prospecting
const PROSPECT_SYSTEM = `You research potential clients for Euclidean Media, a short-form video and social media agency serving political campaigns and online creators.
Use only publicly available, professional information. Never include personal phone numbers or home addresses. Mark anything uncertain.
Return JSON: {"prospects":[{"name":"","type":"political"|"creator"|"organization","handle":"main social handle or URL","platforms":["..."],"followers":"approx, if known","location":"","why":"specific reason they need short-form help","angle":"the pitch angle","publicContact":"official campaign/business email or contact page URL if publicly listed, else empty","confidence":"high"|"medium"|"low"}]}`;

queue.register('prospect.research', {
  title: (p) => `Research: ${p.query}`,
  async run(job, h) {
    h.progress(0.2, 'Research agent working');
    const r = await ai.ask({ role: 'research', json: true, jobId: job.id, search: true, maxTokens: 3500, system: PROSPECT_SYSTEM, prompt: `Find up to ${job.payload.count || 8} qualified prospects: ${job.payload.query}` });
    const list = (r.json.prospects || []).slice(0, 20);
    const created = [];
    for (const p of list) {
      if (ctx.store.find('prospects', (x) => x.name.toLowerCase() === String(p.name).toLowerCase())) continue;
      created.push(ctx.store.insert('prospects', { ...p, stage: 'new', query: job.payload.query, agent: `${r.provider}:${r.model}`, verified: false }));
    }
    events.publish('prospects', {});
    audit.log(`agent:${r.provider}`, 'prospects.researched', { query: job.payload.query, count: created.length });
    return { added: created.length, ids: created.map((p) => p.id) };
  },
});

queue.register('prospect.audit', {
  title: () => 'Social media audit',
  async run(job, h) {
    const p = ctx.store.get('prospects', job.payload.prospectId);
    if (!p) throw permanent('Prospect not found');
    h.progress(0.2, 'Auditing public presence');
    const r = await ai.ask({ role: 'research', search: true, jobId: job.id, maxTokens: 2500, system: 'You write concise, specific social media audits for a short-form video agency. Base observations on public information only and say clearly when you could not verify something.', prompt: `Audit the public social media presence of ${p.name} (${p.handle || 'no handle given'}; ${p.type}). Cover: current posting cadence and formats, what is working, three missed short-form opportunities, and a 30-day plan Euclidean Media could execute. Under 350 words, plain text with short headings.` });
    ctx.store.update('prospects', p.id, { audit: r.text, auditAgent: `${r.provider}:${r.model}`, auditedAt: now() });
    events.publish('prospects', {});
    return { chars: r.text.length };
  },
});

// ------------------------------------------------------------ political outreach packages
const political = require('../political/package');
const polSources = require('../political/sources');

queue.register('political.package', {
  title: (p) => `Package: ${p.name || 'prospect'}${p.only ? ` (${p.only})` : ''}`,
  heavy: true, maxAttempts: 1,
  async run(job, h) {
    if (!ctx.capabilities.ffmpeg && !['research', 'brief', 'creative', 'email'].includes(job.payload.only)) throw Object.assign(new Error('FFmpeg not found'), { notConnected: true });
    return political.run(job.payload.prospectId, { from: job.payload.from, only: job.payload.only, actor: job.createdBy }, h);
  },
});

queue.register('outreach.revise', {
  title: (p) => `Revise: ${p.name || 'lead'}${p.target ? ` (${p.target})` : ''}`, heavy: true, maxAttempts: 1,
  run: (job, h) => (job.payload.lane === 'political' ? political.revise(job.payload.prospectId, { note: job.payload.note, target: job.payload.target, actor: job.createdBy }, h) : creatorOutreach.revise(job.payload.prospectId, { note: job.payload.note, actor: job.createdBy }, h)),
});

queue.register('political.reference', {
  title: () => 'Study a reference ad', heavy: true, maxAttempts: 1,
  async run(job, h) {
    const ref = await require('../video/reference').analyze(job.payload.src, path.join(paths.root, 'political', '_reference'), (t) => h.progress(0.3, t));
    ctx.store.setSettings({ political: { reference: ref } });
    events.publish('settings', {});
    return ref;
  },
});

queue.register('video.reverse', {
  title: (p) => `Study the style of ${/^https?:/.test(p.src || '') ? String(p.src).replace(/^https?:\/\/(www\.)?/, '').slice(0, 50) : require('path').basename(String(p.src || 'a video')).replace(/^\d+-/, '')}`, heavy: true, maxAttempts: 1,
  async run(job, h) {
    const r = await require('../video/reverse').study(job.payload.src, { jobId: job.id, onProgress: (f, t) => h.progress(f, t) });
    events.publish('settings', {});
    events.publish('notify', { title: 'Recipe ready', body: r.recipe?.summary?.slice(0, 160) || 'The breakdown is ready.', route: '/growth' });
    return { id: r.id };
  },
});

queue.register('setup.ollama', { title: () => 'Turn on Ollama', maxAttempts: 1, vital: true, run: (job, h) => require('../setup/ollama').setup(h) });
queue.register('setup.vision', { title: () => 'Download free video vision (Llama vision)', maxAttempts: 1, vital: true, run: (job, h) => require('../setup/ollama').setupVision(h) });
queue.register('setup.ffmpeg', { title: () => 'Install FFmpeg and yt-dlp', maxAttempts: 1, vital: true, run: (job, h) => require('../setup/production').installFfmpeg(h) });
queue.register('music.fill', { title: () => 'Download free music (all moods)', maxAttempts: 1, run: async (job, h) => ({ tracks: await require('../video/music').fillAll((f, t) => h.progress(f, t)) }) });
queue.register('setup.whisper', { title: () => 'Install free speech-to-text (Whisper)', maxAttempts: 1, run: (job, h) => require('../setup/whisper').install(h) });
queue.register('setup.rembg', { title: () => 'Install the free photo cut-out tool', maxAttempts: 1, run: (job, h) => require('../setup/rembg').install(h) });

queue.register('political.scout', {
  title: (p) => `Scout: ${p.query}`,
  async run(job, h) {
    const { query, count = 10, autoPackage } = job.payload;
    const found = [];
    // Public rosters first (Open States, when connected and the query names a state).
    const st = /\b(alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|new york|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|virginia|washington|west virginia|wisconsin|wyoming)\b/i.exec(query);
    if (st && /legislat|house|senate|assembly|representative|delegate/i.test(query)) {
      h.progress(0.15, 'Checking Open States');
      try { for (const x of await polSources.rosterSearch({ state: st[1], chamber: /senate/i.test(query) ? 'upper' : /house|assembly|representative|delegate/i.test(query) ? 'lower' : '', limit: count * 2 })) found.push({ name: x.name, type: 'political', location: x.office, publicContact: x.email && !/\.gov$/.test(x.email) ? x.email : '', why: `${x.party || ''} ${x.office}`.trim(), source: 'openstates', confidence: 'high', handle: x.url || '' }); }
      catch (e) { h.log(`Open States: ${e.message}`); }
    }
    // Free public lists next (Ballotpedia candidates, Wikidata office-holders): no API keys, no AI.
    const known = (n) => ctx.store.find('prospects', (y) => polSources.nameMatch(y.name, n) && polSources.nameMatch(n, y.name));
    if (found.filter((x) => !known(x.name)).length < count) {
      h.progress(0.3, 'Checking free candidate lists (Ballotpedia, Wikidata)');
      try { const fr = await require('../political/freescout').scout(query, { count, log: (m) => h.log(m) }); if (fr.note) h.log(fr.note); for (const x of fr.leads) if (!found.some((y) => y.name === x.name)) found.push({ name: x.name, type: 'political', location: x.office, why: x.why, handle: x.url, source: x.source.toLowerCase(), confidence: 'high', publicContact: '' }); }
      catch (e) { h.log(`Free lists: ${e.message}`); }
    }
    if (found.filter((x) => !known(x.name)).length < count && ai.anyConnected()) {
      h.progress(0.4, 'Research agent searching');
      const r = await ai.ask({ role: 'research', json: true, jobId: job.id, search: true, maxTokens: 3500, system: PROSPECT_SYSTEM + '\nOnly return real, currently active political officials, candidates or campaigns. Never make up contact details; only give an email that is publicly listed. No government emails. No em dashes.' + require('../outreach/learning').scoutBlock('political'), prompt: `Find up to ${count - found.length} political prospects: ${query}` });
      for (const x of (r.json.prospects || [])) found.push({ ...x, type: 'political', agent: `${r.provider}:${r.model}`, source: 'research' });
    }
    if (!found.length) throw permanent('No prospects found. Name a state and office (for example "Connecticut Democrats running for state house in 2026"), or turn on Ollama for free AI searching.');
    const created = [];
    for (const x of found) {
      if (created.length >= Math.max(1, Math.min(100, count))) break;
      if (known(x.name)) continue;
      if (require('../outreach/common').excluded({ name: x.name, email: x.publicContact, handle: x.handle })) continue;
      const pr = ctx.store.insert('prospects', { triage: autoPackage ? 'approved' : 'pending', name: x.name, type: 'political', handle: x.handle || '', platforms: x.platforms || [], why: x.why || '', angle: x.angle || '', publicContact: x.publicContact || '', location: x.location || '', followers: x.followers || null, confidence: x.confidence || 'medium', stage: 'new', verified: x.source === 'openstates', source: x.source, agent: x.agent, query });
      created.push(pr);
      if (autoPackage) queue.enqueue('political.package', { prospectId: pr.id, name: pr.name }, { actor: job.createdBy, priority: 4, dedupeKey: `polpkg:${pr.id}` });
    }
    events.publish('prospects', {});
    if (created.length) events.publish('notify', { title: `${created.length} new political lead${created.length === 1 ? '' : 's'}`, route: '/politics', body: autoPackage ? `Making packages: ${created.slice(0, 5).map((x) => x.name).join(', ')}` : `Waiting in New prospects: ${created.slice(0, 5).map((x) => x.name).join(', ')}` });
    audit.log(job.createdBy || 'system', 'political.scouted', { query, count: created.length });
    return { added: created.length };
  },
});

// ------------------------------------------------------------ creator outreach (email only, no sample videos)
const creatorOutreach = require('../outreach/creators');
queue.register('creator.outreach', { title: (p) => `Creator outreach: ${p.name || 'creator'}`, maxAttempts: 2, run: (job, h) => creatorOutreach.run(job.payload.prospectId, h) });
queue.register('creator.scout', { title: (p) => `Scout creators: ${p.query}`, run: (job, h) => creatorOutreach.scout(job.payload, h, job) });

// ------------------------------------------------------------ footage sources (creator channels)
queue.register('source.check', {
  title: () => 'Check footage sources',
  async run(job, h) {
    const clients = ctx.store.all('clients', (c) => c.status === 'active' && (c.sources || []).some((s) => s.type === 'youtube_channel' && s.auto));
    let found = 0;
    for (const c of clients) {
      for (const s of c.sources.filter((x) => x.type === 'youtube_channel' && x.auto)) {
        const chId = String(s.value).trim();
        const feedUrl = /^UC[\w-]{20,}$/.test(chId) ? `https://www.youtube.com/feeds/videos.xml?channel_id=${chId}` : null;
        if (!feedUrl) { h.log(`${c.name}: source needs a channel ID starting with UC`); continue; }
        const res = await fetch(feedUrl, { signal: AbortSignal.timeout(20000) });
        if (!res.ok) { h.log(`${c.name}: feed HTTP ${res.status}`); continue; }
        const xml = await res.text();
        const entries = [...xml.matchAll(/<entry>[\s\S]*?<yt:videoId>([^<]+)<\/yt:videoId>[\s\S]*?<title>([^<]*)<\/title>[\s\S]*?<published>([^<]+)<\/published>/g)].map((m) => ({ id: m[1], title: m[2], published: m[3] }));
        const since = s.lastSeen || new Date(Date.now() - 2 * 864e5).toISOString();
        for (const e of entries.filter((x) => x.published > since)) {
          queue.enqueue('ingest.url', { url: `https://www.youtube.com/watch?v=${e.id}`, clientId: c.id, autoProcess: true }, { clientId: c.id, dedupeKey: `yt:${e.id}`, title: `Download: ${e.title}` });
          found++;
        }
        if (entries[0]) { s.lastSeen = entries.map((e) => e.published).sort().pop(); ctx.store.update('clients', c.id, { sources: c.sources }); }
      }
    }
    return { found };
  },
});

queue.register('backup', {
  vital: true, title: () => 'Backup database',
  async run() { const f = ctx.store.backup(paths.backups()); audit.log('system', 'backup.created', { file: path.basename(f) }); return { file: f }; },
});

module.exports = { loadTranscript, studioTranscript, loadAnalysis, faceTrackFor };
