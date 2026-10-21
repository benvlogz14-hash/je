'use strict';
/** Voice notes on outreach emails: a founder's recording, or the voice-note script read in their cloned voice. */
const fs = require('fs');
const path = require('path');
const ctx = require('../core/ctx');
const paths = require('../core/paths');
const ff = require('../video/ffmpeg');
const { run } = require('../core/util');

const dirFor = (p) => { const d = path.join(paths.root, 'outreach-voice', p.id); fs.mkdirSync(d, { recursive: true }); return d; };
const sender = () => String(ctx.setting('political.senderName', '') || ctx.setting('agency.founders', [])[0]?.name || ctx.setting('agency.name', 'Euclidean Media')).replace(/[^\w .-]/g, '');
const draftOf = (p) => { const id = p.type === 'political' ? p.pkg?.messageId : p.outreach?.messageId; return id ? ctx.store.get('messages', id) : null; };

/** Turn any recording into a small MP3 and attach it to the lead's waiting draft (and future redrafts). */
async function attach(p, src) {
  const out = path.join(dirFor(p), `Voice note from ${sender()}.mp3`);
  await run(ff.bin('ffmpeg'), ['-y', '-i', src, '-vn', '-ac', '1', '-ar', '44100', '-b:a', '96k', '-af', 'loudnorm=I=-16:TP=-1.5', out], { timeoutMs: 120000 });
  const msg = draftOf(p);
  if (msg?.status === 'pending_approval') ctx.store.update('messages', msg.id, { attachments: [...(msg.attachments || []).filter((a) => !/^Voice note/.test(a.name)), { name: path.basename(out), path: out, size: fs.statSync(out).size }] });
  ctx.store.update('prospects', p.id, { voiceNote: out });
  return out;
}

function script(p) {
  const first = String(p.name).split(/\s+/)[0]; const agency = ctx.setting('agency.name', 'Euclidean Media');
  if (p.type === 'political' && p.pkg?.creative?.voiceNote) return p.pkg.creative.voiceNote;
  if (p.outreach?.voiceNote) return p.outreach.voiceNote;
  return p.type === 'political'
    ? `Hey ${first} team, it's ${sender()} from ${agency}. We put together a few ads for ${p.name}, they're attached to this email. If you've got 20 minutes this week, I'd love to walk you through them.`
    : `Hey ${first}, it's ${sender()} from ${agency}. Big fan of what you're doing. I sent over a quick note about helping with your Shorts. If you've got 20 minutes this week, I'd love to chat.`;
}

/** Read the lead's voice-note script in the founder's cloned voice and attach it. */
async function fromScript(p, text) {
  const el = require('../integrations/elevenlabs');
  const raw = path.join(dirFor(p), 'cloned.mp3');
  await el.speak(text || script(p), raw);
  return attach(p, raw);
}

/** After a draft is made: attach a cloned-voice note automatically when that's switched on. Never throws. */
async function auto(p) {
  try {
    if (!ctx.setting('voice.autoVoiceNote', false) || !require('../integrations/elevenlabs').cloned()) return null;
    return await fromScript(ctx.store.get('prospects', p.id) || p);
  } catch (e) { require('../core/audit').log('system', 'voice.note_failed', { prospectId: p.id, error: e.message }, 'warn'); return null; }
}

module.exports = { attach, fromScript, auto, script };
