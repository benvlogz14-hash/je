'use strict';
/**
 * ElevenLabs: a founder's own cloned voice.
 *  - Voice notes: the email's voice-note script read in the founder's voice, attached as an MP3.
 *  - Callbacks: an AI assistant in the founder's voice answers INBOUND calls to the Twilio
 *    number (people calling back). It says it is an AI assistant, takes a message and
 *    never places calls itself: no robocalls (TCPA; the FCC treats AI voices as artificial).
 */
const fs = require('fs');
const path = require('path');
const ctx = require('../core/ctx');
const secrets = require('../core/secrets');
const audit = require('../core/audit');
const events = require('../core/events');

const KEY = 'global.elevenlabs.apiKey';
const API = 'https://api.elevenlabs.io/v1';
const V = (k, d) => ctx.setting(`voice.${k}`, d);

function configured() { return secrets.has(KEY); }
function cloned() { return configured() && !!V('voiceId', ''); }

async function call(method, url, { json, form, raw = false, timeoutMs = 120000 } = {}) {
  if (!configured()) throw new Error('Add your ElevenLabs key in Settings → Connections first.');
  const headers = { 'xi-api-key': secrets.get(KEY) };
  if (json) headers['content-type'] = 'application/json';
  let res;
  try { res = await fetch(`${API}${url}`, { method, headers, body: json ? JSON.stringify(json) : form, signal: AbortSignal.timeout(timeoutMs) }); }
  catch (e) { throw new Error(`Couldn't reach ElevenLabs. Check the internet connection. (${e.message})`); }
  if (!res.ok) {
    const t = await res.text(); let msg = t.slice(0, 300);
    try { const j = JSON.parse(t); msg = j.detail?.message || j.detail?.status || (typeof j.detail === 'string' ? j.detail : '') || msg; } catch { /* text */ }
    if (res.status === 401) msg = 'ElevenLabs did not accept the key. Check it in Settings → Connections.';
    throw new Error(`ElevenLabs: ${msg}`);
  }
  return raw ? Buffer.from(await res.arrayBuffer()) : res.json();
}

async function test() { try { await call('GET', '/user'); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; } }

/** Clone the founder's voice from one or more recordings (a minute or more of clear speech). */
async function cloneVoice(files, name) {
  const fd = new FormData();
  fd.append('name', name || `${ctx.setting('agency.name', 'Euclidean Media')} founder`);
  fd.append('description', 'Founder voice for Euclidean outreach voice notes and callbacks (own voice, with consent).');
  for (const f of files) fd.append('files', new Blob([fs.readFileSync(f)]), path.basename(f));
  const r = await call('POST', '/voices/add', { form: fd, timeoutMs: 300000 });
  if (!r.voice_id) throw new Error('ElevenLabs did not return a voice.');
  ctx.store.setSettings({ voice: { voiceId: r.voice_id, voiceName: name || '', clonedAt: new Date().toISOString() } });
  audit.log('user', 'voice.cloned', { voiceId: r.voice_id });
  return r.voice_id;
}

/** Read text aloud in the cloned voice; writes an MP3. */
async function speak(text, out) {
  if (!cloned()) throw new Error('Clone your voice first (Settings → Connections → Your voice).');
  const buf = await call('POST', `/text-to-speech/${encodeURIComponent(V('voiceId'))}?output_format=mp3_44100_128`, { json: { text: String(text).slice(0, 2500), model_id: V('model', 'eleven_multilingual_v2'), voice_settings: { stability: 0.45, similarity_boost: 0.85 } }, raw: true, timeoutMs: 180000 });
  fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, buf);
  return out;
}

function agentPrompt() {
  const agency = ctx.setting('agency.name', 'Euclidean Media');
  const founder = ctx.setting('political.senderName', '') || ctx.setting('agency.founders', [])[0]?.name || 'the founder';
  const offers = [`Political campaigns: ${ctx.setting('political.plan', '12 posts a week for $949')}; we send candidates free sample ads made from their public record.`,
    ...Object.values(ctx.setting('creatorOffers', {}) || {}).filter((o) => o && o.name && o.price).map((o) => `${o.name}: ${o.price}. ${o.details || ''}`)].join('\n');
  const booking = ctx.setting('political.bookingUrl', '') || ctx.setting('creatorOffers.bookingUrl', '');
  return `You answer calls for ${agency}, a short-form video agency for creators and political campaigns, in ${founder}'s voice. The people calling are returning our emails or calls.
Start by saying you are ${founder}'s AI assistant. If anyone asks whether you are a real person or an AI, say plainly that you are an AI assistant.
Your job: be warm and brief, answer simple questions about what we do, and take a message: their name, who they are with (campaign or channel), the best number or email, and a good time for ${founder} to call back. Say ${founder} will get back to them soon.${booking ? ` If they want to book, say we'll send our booking link (${booking}) by email.` : ''}
What we offer:
${offers}
Never invent prices, results, clients or promises beyond this. Never discuss other clients. Never make political claims or say anything about any candidate or opponent. If they ask to stop being contacted, apologise, confirm we will not contact them again, and note it in the message.`;
}

/** Turn on the callback assistant: create or update the agent, connect the Twilio number, route inbound calls to it. */
async function enableCallbacks() {
  if (!cloned()) throw new Error('Clone your voice first.');
  const tw = require('./twilio');
  if (!tw.configured() || !secrets.has(tw.K.from)) throw new Error('Connect Twilio with a phone number first (Settings → Connections).');
  const founder = ctx.setting('political.senderName', '') || ctx.setting('agency.founders', [])[0]?.name || 'the team';
  const conversation_config = { agent: { first_message: `Hi, this is ${founder}'s AI assistant at ${ctx.setting('agency.name', 'Euclidean Media')}. Thanks for calling back! Who do I have the pleasure of speaking with?`, language: 'en', prompt: { prompt: agentPrompt() } }, tts: { voice_id: V('voiceId') } };
  let agentId = V('agentId', '');
  if (agentId) { try { await call('PATCH', `/convai/agents/${agentId}`, { json: { conversation_config } }); } catch { agentId = ''; } }
  if (!agentId) { const r = await call('POST', '/convai/agents/create', { json: { name: 'Euclidean callbacks', conversation_config } }); agentId = r.agent_id; }
  let phoneId = V('phoneNumberId', '');
  if (!phoneId) {
    const r = await call('POST', '/convai/phone-numbers', { json: { phone_number: secrets.get(tw.K.from), label: 'Euclidean outreach line', sid: secrets.get(tw.K.sid), token: secrets.get(tw.K.token), provider: 'twilio' } });
    phoneId = r.phone_number_id;
  }
  await call('PATCH', `/convai/phone-numbers/${phoneId}`, { json: { agent_id: agentId } });
  ctx.store.setSettings({ voice: { agentId, phoneNumberId: phoneId, callbacks: true } });
  audit.log('user', 'voice.callbacks_on', { agentId });
  return { agentId, phoneId };
}

async function disableCallbacks() {
  const phoneId = V('phoneNumberId', '');
  if (phoneId) { try { await call('PATCH', `/convai/phone-numbers/${phoneId}`, { json: { agent_id: null } }); } catch (e) { audit.log('user', 'voice.callbacks_off_failed', { error: e.message }, 'warn'); } }
  ctx.store.setSettings({ voice: { callbacks: false } });
  return { ok: true };
}

/** Pull new callback conversations into the app: a message log, a notification, and Replied for a known lead. */
let lastPoll = 0;
async function pollCalls() {
  if (!V('callbacks', false) || !V('agentId', '') || Date.now() - lastPoll < 5 * 60000) return;
  lastPoll = Date.now();
  let list;
  try { list = await call('GET', `/convai/conversations?agent_id=${encodeURIComponent(V('agentId'))}&page_size=20`); } catch { return; }
  const seen = new Set((ctx.store.settings._callLog || []).map((c) => c.id));
  const log = ctx.store.settings._callLog || [];
  for (const c of (list.conversations || []).filter((x) => !seen.has(x.conversation_id))) {
    let d = {}; try { d = await call('GET', `/convai/conversations/${c.conversation_id}`); } catch { /* summary only */ }
    const from = d.metadata?.phone_call?.external_number || d.metadata?.phone_call?.from_number || '';
    const summary = d.analysis?.transcript_summary || c.call_summary_title || '';
    const transcript = (d.transcript || []).map((t) => `${t.role === 'agent' ? 'Assistant' : 'Caller'}: ${t.message || ''}`).join('\n').slice(0, 6000);
    const digits = from.replace(/\D/g, '').slice(-10);
    const contact = digits && ctx.store.find('contacts', (x) => (x.phones || []).some((ph) => String(ph).replace(/\D/g, '').slice(-10) === digits));
    const prospect = contact && ctx.store.find('prospects', (x) => x.contactId === contact.id);
    if (prospect && !['meeting', 'won', 'client'].includes(prospect.stage)) ctx.store.update('prospects', prospect.id, (cur) => ({ stage: 'replied', notes: `${cur.notes ? cur.notes + '\n' : ''}${new Date().toLocaleDateString()}: called back (AI assistant took a message): ${summary}` }));
    log.unshift({ id: c.conversation_id, at: new Date((c.start_time_unix_secs || Date.now() / 1000) * 1000).toISOString(), from, name: contact?.name || '', prospectId: prospect?.id || null, seconds: c.call_duration_secs || 0, summary, transcript });
    events.publish('notify', { title: `Callback from ${contact?.name || from || 'a caller'}`, body: summary.slice(0, 160) || 'The AI assistant took a message.', route: '/agents' });
  }
  ctx.store.settings._callLog = log.slice(0, 100); ctx.store.touch();
}

function status() { return { configured: configured(), cloned: cloned(), voiceName: V('voiceName', ''), clonedAt: V('clonedAt', null), callbacks: !!V('callbacks', false), autoVoiceNote: !!V('autoVoiceNote', false), calls: (ctx.store.settings._callLog || []).slice(0, 20).map(({ transcript, ...c }) => ({ ...c, hasTranscript: !!transcript })) }; }

module.exports = { KEY, configured, cloned, test, cloneVoice, speak, enableCallbacks, disableCallbacks, pollCalls, status, agentPrompt };
