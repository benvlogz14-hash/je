'use strict';
/**
 * End-to-end self test of the core workflow with no API keys required:
 * client → footage → (demo) transcript → clip discovery → render with
 * captions → QC → approval → scheduled post → publish (Manual Pack, test env)
 * → client-memory style change → re-render → Studio export.
 *   npm run selftest
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'euclidean-selftest-'));
process.env.EUCLIDEAN_DATA = dataDir;
const engine = require('../server/index');

const waitFor = async (label, fn, ms = 240000) => {
  const t0 = Date.now();
  for (;;) { const v = fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error(`Timed out waiting for ${label}`); await new Promise((r) => setTimeout(r, 400)); }
};
const ok = (m) => console.log(`  ✓ ${m}`);

(async () => {
  console.log(`selftest: data in ${dataDir}`);
  const { port } = await engine.start({ dataDir, port: 0 });
  const ctx = engine.ctx; const s = ctx.store;
  const pipeline = require('../server/automation/pipeline');
  const queue = require('../server/jobs/queue');
  const commands = require('../server/commands');
  ok(`engine on port ${port}`);

  const demo = JSON.parse(execFileSync(process.execPath, [path.join(__dirname, 'make-demo-media.js'), path.join(dataDir, 'demo')]).toString());
  ok(`demo footage ${demo.duration.toFixed(1)}s (${demo.speech}), ${demo.words} words`);

  let r = await commands.execute('/newclient Stringer Media creator', { actor: 'ryan' });
  const client = s.find('clients', (c) => c.name === 'Stringer Media');
  ok(r.text);
  r = await commands.execute('/quota stringer 6/day', { actor: 'ryan' }); ok(r.text);
  s.update('clients', client.id, (c) => ({ schedule: { ...c.schedule, autopilot: false }, production: { ...c.production, clipsPerFootage: 2 } }));
  const contact = s.insert('contacts', { name: 'Stringer Test', phones: ['+15555550100'], emails: ['stringer@example.com'], role: 'client', clientId: client.id, optedOut: {} });
  s.update('clients', client.id, { contactIds: [contact.id], primaryContactId: contact.id });

  const asset = pipeline.addAsset({ clientId: client.id, filePath: demo.video, source: 'selftest' });
  await waitFor('ingest', () => s.get('assets', asset.id).status === 'ready' && s.get('assets', asset.id).info);
  const a = s.get('assets', asset.id);
  ok(`ingested ${a.info.width}x${a.info.height} ${a.info.duration.toFixed(1)}s, thumb=${!!a.thumb}, filmstrip=${!!a.filmstrip}`);
  fs.copyFileSync(demo.transcript, path.join(a.workDir, `${a.id}.transcript.json`));
  s.update('assets', a.id, { transcript: { engine: 'demo', words: demo.words } });

  queue.enqueue('discover', { assetId: a.id, count: 2 }, { clientId: client.id });
  const clips = await waitFor('clips', () => { const c = s.all('clips', (x) => x.assetId === a.id); return c.length ? c : null; });
  ok(`discovered ${clips.length} clip(s) via ${clips[0].method}: ${clips.map((c) => `#${c.ref} ${c.start}-${c.end}s`).join(', ')}`);

  await waitFor('renders', () => s.all('clips', (x) => x.assetId === a.id).every((c) => c.status === 'review'), 600000);
  for (const c of s.all('clips', (x) => x.assetId === a.id)) {
    const v = c.versions[0];
    const probe = await require('../server/video/ffmpeg').probe(v.path);
    ok(`#${c.ref} rendered ${probe.width}x${probe.height} ${probe.duration.toFixed(1)}s via ${v.encoder}; QC ${v.qc.passed ? 'passed' : 'FAILED'} ${v.qc.issues.map((i) => i.code).join(',')}; velo=${fs.existsSync(v.velo)} xml=${fs.existsSync(v.xml)} srt=${fs.existsSync(v.srt)}`);
  }
  const pending = s.all('approvals', (x) => x.status === 'pending' && x.kind === 'clip');
  ok(`${pending.length} approval(s) waiting`);

  const first = s.all('clips', (x) => x.assetId === a.id)[0];
  r = await commands.execute(`/approve ${first.ref}`, { actor: 'ryan' }); ok(r.text);
  const post = s.get('posts', s.get('clips', first.id).postId);
  if (!post) throw new Error('approved clip was not scheduled');
  r = await commands.execute(`/publish ${first.ref} now`, { actor: 'ryan' }); ok(r.text);
  await waitFor('publish', () => s.get('posts', post.id).status === 'published', 60000);
  const pp = s.get('posts', post.id);
  ok(`published via ${pp.mode}: ${pp.packagePath && fs.existsSync(pp.packagePath) ? path.relative(dataDir, pp.packagePath) : 'no package'}${pp.note ? ` (${pp.note})` : ''}`);

  pipeline.remember(client.id, [{ text: 'Client dislikes all-caps captions; use sentence case and teal highlights', style: { uppercase: false, highlight: '#6CC3B8' } }], { source: 'selftest' });
  const second = s.all('clips', (x) => x.assetId === a.id)[1] || first;
  pipeline.requestRender(second, { reason: 'memory test' });
  await waitFor('re-render', () => s.get('clips', second.id).versions.length >= 2 && s.get('clips', second.id).status !== 'rendering' && ['review','approved','scheduled','published'].includes(s.get('clips', second.id).status), 600000);
  const ass = fs.readFileSync(s.get('clips', second.id).versions.slice(-1)[0].path.replace('.mp4', '.ass'), 'utf8');
  const dialogue = ass.split('\n').find((l) => l.startsWith('Dialogue: 0'));
  if (/[a-z]/.test(dialogue.split(',,').pop().replace(/\{[^}]*\}/g, ''))) ok('client memory applied: captions now sentence case on v2'); else throw new Error('memory style not applied');

  const proj = s.insert('projects', { name: 'Selftest edit', clientId: client.id, data: require('../server/video/exporters').toVelo({ name: 'x', source: a.path, info: a.info, range: { start: 2, end: 14 }, words: JSON.parse(fs.readFileSync(demo.transcript)).words, style: s.get('clients', client.id).style, hook: 'Local news matters', focusX: 0.5 }) });
  proj.data.sequences[0].videoTracks[0].clips[0].effects = [{ effectId: 'color_correction', enabled: true, params: { brightness: { base: 5 }, contrast: { base: 10 }, saturation: { base: 120 }, temperature: { base: 10 } } }, { effectId: 'vignette', enabled: true, params: { amount: { base: 40 } } }];
  queue.enqueue('studio.export', { projectId: proj.id }, { clientId: client.id });
  await waitFor('studio export', () => (s.get('projects', proj.id).exports || []).length, 600000);
  const ex = s.get('projects', proj.id).exports[0];
  const pr = await require('../server/video/ffmpeg').probe(ex.path);
  ok(`Studio export ${pr.width}x${pr.height} ${pr.duration.toFixed(1)}s${ex.warnings.length ? ` (warnings: ${ex.warnings.join('; ')})` : ''}`);

  const failed = s.all('jobs', (j) => j.status === 'failed');
  if (failed.length) throw new Error(`failed jobs: ${failed.map((j) => `${j.type}: ${j.error}`).join(' | ')}`);
  console.log(`selftest: OK  (outputs kept in ${dataDir})`);
  await engine.stop();
  process.exit(0);
})().catch(async (e) => { console.error('selftest: FAILED', e.stack || e.message); try { const s = engine.ctx.store; for (const j of s.all('jobs', (x) => x.status === 'failed' || x.error)) console.error(' job', j.type, j.status, j.error); } catch { /* ignore */ } process.exit(1); });
