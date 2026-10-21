'use strict';
/**
 * Everything the full outreach process needs, in one list: what's ready, what's
 * missing, why it matters, and a button that fixes it (or opens the right page).
 */
const ctx = require('../core/ctx');
const secrets = require('../core/secrets');

async function build() {
  const ai = require('../integrations/ai');
  const email = require('../integrations/email');
  const twilio = require('../integrations/twilio');
  const motion = require('../video/motion');
  const cutout = require('../video/cutout');
  const ollama = await require('./ollama').status();
  const eyes = await require('./ollama').visionReady();
  const S = (k, d) => ctx.setting(k, d);
  const caps = ctx.capabilities || {};
  const item = (group, key, label, ok, why, fix, level = 'required') => ({ group, key, label, ok: !!ok, why, fix, level });
  const go = (route, label = 'Open') => ({ type: 'goto', route, label });
  const act = (action, label) => ({ type: 'action', action, label });
  const prod = S('environment', 'test') === 'production';
  return [
    // The brain
    item('AI', 'llama', 'Free AI on this computer (Ollama)', ollama.running && ollama.modelReady, ollama.running ? (ollama.modelReady ? 'Running. Research, scouting and the chat use it for free.' : `Running, but the ${ollama.model} model isn't downloaded yet.`) : ollama.installed ? 'Installed but not running.' : 'Not installed. Does most of the thinking for free.', act('ollama', ollama.running && ollama.modelReady ? 'Running' : 'Turn on Ollama'), 'recommended'),
    item('AI', 'claude', 'Claude (best writing for emails and ads)', ai.connected('anthropic'), 'Writes the emails, ad scripts and briefs. Llama can stand in, with weaker writing.', go('/settings?tab=connections', 'Add key'), 'recommended'),
    item('AI', 'grok', 'Grok web search (optional)', ai.connected('xai'), 'Live web search for scouting. Free DuckDuckGo search is used without it.', go('/settings?tab=connections', 'Add key'), 'optional'),
    // Email
    item('Email', 'email', 'Outreach email inbox (send + receive replies)', email.configured(), 'Sends the emails and reads replies so leads move to Replied. Use a separate outreach inbox, not your main one.', go('/settings?tab=connections', 'Connect email')),
    item('Email', 'address', 'Your mailing address', !!String(S('outreach.mailingAddress', '') || S('political.mailingAddress', '')).trim(), 'The law (CAN-SPAM) requires it at the bottom of every outreach email. Auto-send stays paused without it.', go('/growth', 'Add in Autopilot settings')),
    item('Email', 'sandbox', 'Test inbox (where Test mode sends)', !!S('sandbox.email', ''), 'While Euclidean is in Test mode, every email goes here instead, so you can check them safely.', go('/settings?tab=general', 'Add')),
    item('Email', 'live', 'Switch to Production when ready', prod, prod ? 'Live: emails go to the real recipients.' : 'Test mode: nothing reaches real people yet. Switch when you have reviewed a few.', go('/settings?tab=general', 'Open'), 'optional'),
    // Texting and calls
    item('Texts & calls', 'twilio', 'Twilio (texting and one-click calling)', twilio.configured(), 'Texts with clients, and the Call button that rings your phone and connects you to a lead.', go('/settings?tab=connections', 'Connect Twilio'), 'recommended'),
    item('Texts & calls', 'phone', 'Your phone number for calls', !!S('outreach.callerPhone', ''), 'The number Twilio rings first when you press Call on a lead.', go('/growth', 'Add in Autopilot settings'), 'recommended'),
    // Research data
    item('Research', 'openstates', 'Open States key (state legislators, free)', secrets.has('global.political.openStatesKey'), 'Finds and checks state and local legislators. Free sign-up.', go('/settings?tab=connections', 'Add key'), 'recommended'),
    item('Research', 'datagov', 'api.data.gov key (Congress and FEC money, free)', secrets.has('global.political.dataGovKey'), 'Full-speed fundraising and Congress data. Works slowly without it.', go('/settings?tab=connections', 'Add key'), 'optional'),
    // Video
    item('Video', 'ffmpeg', 'FFmpeg (makes the videos)', caps.ffmpeg, 'Renders every ad and clip. Installed by Start Euclidean.', go('/system', 'Check')),
    item('Video', 'browser', 'Edge or Chrome (draws the graphics)', !!motion.findBrowser(), 'Draws every scene of the ads and the one-page sheet. Windows already has Edge.', go('/system', 'Check')),
    item('Video', 'ytdlp', 'yt-dlp (YouTube data and reference ads)', caps.ytdlp, 'Creator stats, YouTube scouting and copying a reference ad\'s pacing.', go('/system', 'Check'), 'recommended'),
    item('Video', 'cutout', 'Photo background removal', !!cutout.available(), cutout.available() ? `Using ${cutout.available()}.` : 'Cuts candidates out of their photos for the cut-out ad look. Free tool, one click.', act('rembg', 'Install free tool'), 'optional'),
    item('Video', 'vision', 'AI that can see video (looks through footage shot by shot)', eyes || ['anthropic', 'openai', 'xai'].some((p) => ai.connected(p)), eyes ? 'Llama vision is installed: looking through video is free.' : ['anthropic', 'openai', 'xai'].some((p) => ai.connected(p)) ? 'Using your paid AI (a fraction of a cent per shot). Download the free one to stop paying.' : 'Lets Euclidean see what is in each shot to pick clips and B-roll. Free download, about 8 GB.', act('vision', eyes ? 'Installed' : 'Download free'), 'recommended'),
    item('Video', 'whisper', 'Free speech-to-text (Whisper)', require('./whisper').status().ready || ai.connected('openai'), require('./whisper').status().ready ? 'Installed. Captions and speech ads transcribe for free on this computer.' : ai.connected('openai') ? 'Using OpenAI (paid, about 36 cents an hour of video). Install the free tool to stop paying.' : 'Turns speeches into text for captions and the "their own speeches" ads. Free tool, one click.', act('whisper', require('./whisper').status().ready ? 'Installed' : 'Install free tool'), 'recommended'),
    // Outreach content
    item('Outreach', 'booking', 'Booking link', !!(S('political.bookingUrl', '') || S('creatorOffers.bookingUrl', '')), 'Shown in every email and on the one-pager so leads can book the 20 minutes.', go('/growth', 'Add in Package settings'), 'recommended'),
    item('Outreach', 'templates', 'Your best outreach emails', !!(String(S('political.templates', '')).trim() || String(S('creatorOffers.templates', '')).trim()), 'The writer copies your voice and structure.', go('/growth', 'Paste them'), 'recommended'),
    item('Outreach', 'searches', 'Saved searches for the scout', !!(String(S('outreach.political.scoutQueries', '')).trim() || String(S('outreach.creators.scoutQueries', '')).trim()), 'What the daily and all-day scout looks for. Tell the scout chat in plain words.', go('/growth', 'Talk to the scout'), 'recommended'),
  ];
}

module.exports = { build };
