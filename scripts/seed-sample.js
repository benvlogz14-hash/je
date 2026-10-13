'use strict';
/**
 * Seeds a sample workspace (clearly marked sample data) and keeps the engine
 * running, for trying the interface without real clients:
 *   node scripts/seed-sample.js [dataDir] [port]
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const dataDir = path.resolve(process.argv[2] || path.join(os.tmpdir(), 'euclidean-sample'));
const port = Number(process.argv[3] || 4870);
process.env.EUCLIDEAN_DATA = dataDir;
const engine = require('../server/index');
const wait = async (fn, ms = 600000) => { const t = Date.now(); for (;;) { const v = fn(); if (v) return v; if (Date.now() - t > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 500)); } };

(async () => {
  const fresh = !fs.existsSync(path.join(dataDir, 'db', 'euclidean.json'));
  const { port: p } = await engine.start({ dataDir, port });
  const s = engine.ctx.store;
  const pipeline = require('../server/automation/pipeline');
  const messaging = require('../server/automation/messaging');
  const queue = require('../server/jobs/queue');
  if (fresh) {
    const demo = JSON.parse(execFileSync(process.execPath, [path.join(__dirname, 'make-demo-media.js'), path.join(dataDir, 'demo')]).toString());
    const stringer = pipeline.createClient({ name: 'Stringer Media', type: 'creator', package: 'Shorts · 6/day crosspost', retainer: { amount: 949, interval: 'monthly', billingDay: 1, renewalDate: new Date(Date.now() + 20 * 864e5).toISOString().slice(0, 10) },
      profile: { about: 'Local-news creator covering town meetings and zoning boards (sample profile).', audience: 'Residents 22–45 who follow local politics on TikTok and Reels', voice: 'Fast, plain-spoken, a little dry', topics: 'Town councils, zoning, school budgets', avoid: 'Clickbait claims about officials', hashtags: '#localnews #ct' },
      schedule: { autopilot: true, shortsPerDay: 6, slots: ['08:00', '10:30', '13:15', '15:45', '18:30', '21:00'], platforms: ['tiktok', 'instagram', 'youtube', 'facebook', 'twitter'], bufferDays: 2 }, production: { clipsPerFootage: 4 } }, 'ryan');
    const campaign = pipeline.createClient({ name: 'Hartwell for State Rep', type: 'political', package: 'Campaign shorts · 3/day', retainer: { amount: 949, interval: 'monthly', billingDay: 15 }, schedule: { autopilot: false, shortsPerDay: 3, slots: ['10:00', '14:00', '19:00'], platforms: ['instagram', 'facebook', 'tiktok'] } }, 'ryan');
    const jordan = s.insert('contacts', { name: 'Jordan (Stringer Media)', phones: ['+15555550123'], emails: ['jordan@example.com'], role: 'client', clientId: stringer.id, optedOut: {} });
    s.update('clients', stringer.id, { contactIds: [jordan.id], primaryContactId: jordan.id });
    const pat = s.insert('contacts', { name: 'Pat Hartwell', phones: ['+15555550188'], emails: [], role: 'client', clientId: campaign.id, optedOut: {} });
    s.update('clients', campaign.id, { contactIds: [pat.id], primaryContactId: pat.id });
    const lead = s.insert('contacts', { name: 'Riverside Eats (lead)', phones: [], emails: ['hello@example.org'], role: 'prospect', clientId: null, optedOut: {} });

    pipeline.remember(stringer.id, [{ text: 'Prefers punchy hooks under six words' }, { text: 'No all-caps captions; sentence case with teal highlight', style: { uppercase: false, highlight: '#6CC3B8' } }], { source: 'client feedback', actor: 'ryan' });
    const asset = pipeline.addAsset({ clientId: stringer.id, filePath: demo.video, source: 'client portal' });
    await wait(() => s.get('assets', asset.id).status === 'ready');
    const a = s.get('assets', asset.id);
    fs.copyFileSync(demo.transcript, path.join(a.workDir, `${a.id}.transcript.json`));
    s.update('assets', a.id, { transcript: { engine: 'demo alignment', words: demo.words, preview: '' } });
    const hooks = [['Nobody covers the zoning board', 'Who shows up when the school budget gets cut? Usually nobody. So we did.'], ['One clip, 200K views', 'One council meeting clip hit 200K views in a day.'], ['It\'s just a phone and a tripod', 'How we actually get the footage, start to finish.'], ['An official changed a vote', 'After one clip went viral, a vote changed.']];
    const segs = JSON.parse(fs.readFileSync(demo.transcript)).segments;
    const pickSeg = (i) => { const st = segs[Math.min(segs.length - 1, i * 3)]; const en = segs[Math.min(segs.length - 1, i * 3 + 2)]; return { start: Math.max(0, st.s - 0.2), end: Math.min(a.info.duration, en.e + 0.3) }; };
    pipeline.createClips(a, { method: 'ai', clips: hooks.map(([hook, caption], i) => ({ ...pickSeg(i), title: hook, hook, caption, hashtags: ['localnews', 'ct', 'townhall'], score: 92 - i * 6, reason: 'Opens on a question, single complete point, ends on a payoff (sample).', agent: 'openai:gpt-5' })) });
    await wait(() => s.all('clips', (c) => c.assetId === a.id).every((c) => c.status === 'review'));
    const clips = s.all('clips', (c) => c.assetId === a.id);
    pipeline.decideClip(clips[0].id, 'approve', { actor: 'ryan' });
    pipeline.decideClip(clips[1].id, 'approve', { actor: 'ben' });
    // conversation history
    const conv = messaging.ensureConversation(jordan);
    messaging.receive({ channel: 'sms', providerId: 'sample-1', from: jordan.phones[0], fromName: jordan.name, body: 'Just uploaded Tuesday\'s council meeting to the portal. Can we get the zoning fight out first?', at: new Date(Date.now() - 3 * 3600e3).toISOString() });
    messaging.addMessage(conv, { direction: 'out', channel: 'sms', body: 'Got it. Four clips are rendering now, the zoning one goes in the 10:30 slot.', status: 'sent', sentAt: new Date(Date.now() - 2.8 * 3600e3).toISOString(), createdBy: 'ryan' });
    messaging.receive({ channel: 'sms', providerId: 'sample-2', from: jordan.phones[0], fromName: jordan.name, body: 'Love the first two. For the tripod one, start right at "honestly" and make the captions a bit smaller?', at: new Date(Date.now() - 40 * 60e3).toISOString() });
    messaging.addMessage(conv, { direction: 'out', channel: 'sms', body: 'Thanks Jordan! Trimming the start of the tripod clip and dropping the caption size a notch. New version shortly.', status: 'pending_approval', aiGenerated: true, agent: 'anthropic:claude-sonnet-5-5', category: 'commitment', createdBy: 'system' });
    const lconv = messaging.ensureConversation(lead);
    messaging.createOutbound({ contactId: lead.id, channel: 'email', subject: 'Short-form video for Riverside Eats', body: 'Hi there, I run Euclidean Media with my partner Ben. Your kitchen videos on Instagram get great saves, but you post about once a month. We turn long footage into daily shorts for TikTok, Reels and YouTube. Open to a 15-minute call next week?\n\nIf you\'d rather not hear from us, just reply "no thanks".', aiGenerated: true, agent: 'anthropic:claude-sonnet-5-5', category: 'prospecting', actor: 'system' });
    s.insert('prospects', { name: 'Riverside Eats', type: 'creator', handle: '@riverside.eats (sample)', platforms: ['instagram'], followers: '18K', location: 'Hartford, CT', why: 'Strong saves, posts monthly', angle: 'Daily kitchen shorts from one weekly shoot', publicContact: 'hello@example.org', stage: 'drafted', verified: true, contactId: lead.id });
    s.insert('prospects', { name: 'Sample Town Council Candidate', type: 'political', handle: 'campaign site (sample)', platforms: ['facebook'], why: 'No short-form presence 5 weeks before election', angle: 'Three debate clips a day', stage: 'new', confidence: 'medium', verified: false, agent: 'xai:grok-4' });
    s.insert('expenses', { label: 'Ayrshare Premium', amount: 149, category: 'software', date: new Date().toISOString().slice(0, 10), recurring: true });
    s.insert('expenses', { label: 'Cloud storage', amount: 12, category: 'storage', date: new Date().toISOString().slice(0, 10), recurring: true });
    for (const [prov, model, role, cost, inT, outT] of [['openai', 'gpt-5', 'analysis', 0.042, 18000, 1200], ['anthropic', 'claude-sonnet-5-5', 'operations', 0.011, 2400, 300], ['openai', 'whisper-1', 'transcription', 0.02, 0, 0], ['xai', 'grok-4', 'research', 0.031, 6000, 900]]) s.insert('usage', { provider: prov, model, role, clientId: stringer.id, inTok: inT, outTok: outT, costUsd: cost, kind: 'chat', month: new Date().toISOString().slice(0, 7) });
    s.insert('timelogs', { userId: 'ryan', clientId: stringer.id, minutes: 35, note: 'Approval session', date: new Date().toISOString().slice(0, 10) });
    queue.enqueue('backup', {});
    console.log('[seed] sample workspace created');
  }
  const owner = s.all('users', (u) => u.role === 'owner')[0];
  console.log(`[seed] ready: http://127.0.0.1:${p}/?token=${owner.token}`);
  fs.writeFileSync(path.join(dataDir, 'owner-url.txt'), `http://127.0.0.1:${p}/?token=${owner.token}\n`);
})().catch((e) => { console.error(e); process.exit(1); });
