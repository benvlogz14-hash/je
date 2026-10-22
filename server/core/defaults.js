'use strict';
/** Default settings. Every value is editable in Settings; nothing here is hard-wired. */
module.exports = {
  agency: {
    name: 'Euclidean Media',
    founders: [
      { id: 'ryan', name: 'Ryan Rosario', ownershipPct: 50, distributionPct: 50 },
      { id: 'ben', name: 'Ben Gingold', ownershipPct: 50, distributionPct: 50 },
    ],
    taxReservePct: 30,
    retainedEarningsPct: 10,
    currency: 'USD',
    timezone: 'America/New_York',
  },
  political: {
    videoStyle: 'campaign',    // 'campaign' (modern political ad look), 'speech' (their own speeches + B-roll, graphics as fallback) or 'pop' (bubbly)
    footageClips: 4,           // public videos downloaded per lead for 'speech' ads
    shortSeconds: 20,          // the short vertical and short horizontal ads
    videoSeconds: 60,          // the long horizontal ad (30 to 240)
    longVideo: true,           // make the long horizontal ad
    backgrounds: 'photo',      // 'photo' = real stock-style photos of their town/state behind the text; 'vector' = plain colour graphics
    photoMode: 'auto',         // auto (cut-out when available, else full photo, else silhouette) | cutout | full | silhouette
    photoCutout: true,         // remove the photo background (needs a remove.bg key or the free rembg tool)
    campaignPhotos: true,
    jinaReader: true,          // read JavaScript-built websites through Jina Reader (r.jina.ai, public pages only)      // also use the share image from the candidate's own website (credited)
    brandColors: true,         // campaign style uses the candidate's website colour when found
    contrastAds: false,        // allow contrast ads that compare with a researched opponent (never auto-sent)
    plan: '12 posts a week for $949',
    bookingUrl: '',            // e.g. a Calendly link, shown in the email and on the sheet
    senderName: '',            // who signs the email; defaults to the first founder
    offer: '',                 // your offer in your own words; a sensible default is used when empty
    templates: '',             // paste your best outreach emails here; the writer matches their voice
    mailingAddress: '',        // required by CAN-SPAM in every commercial email; autopilot will not send without it
    theme: 'auto',             // pop style colours: auto (by party), blue, red, purple, green
    narration: false,          // AI narrator voice (OpenAI) over the long ad
    voice: 'alloy',
    musicDir: '',              // folder of music tracks; one is picked per video
    maxAttachMB: 20,           // total attachment size per email; the long ad is dropped first
    allowGov: false,           // allow drafts to official .gov addresses
  },
  // Automatic outreach. Off until a founder switches it on; each lane has its own daily limits.
  voice: { voiceId: '', autoVoiceNote: false, callbacks: false, model: 'eleven_multilingual_v2' },  // your cloned voice (ElevenLabs): voice notes + inbound callback assistant
  video: { lookThrough: true },  // look through footage shot by shot (FFmpeg stills + faces + an AI that can see, when connected)
  outreach: {
    exclusions: '',            // names, organisations or email domains never to contact (one per line)
    political: { autoGraduate: false, graduateAt: 0.9, graduateWindow: 25, scout: false, continuous: false, scoutEveryMin: 30, maxLeadsPerDay: 60, scoutQueries: '', scoutPerDay: 15, scoutHour: 7, autoSend: false, sendPerDay: 50, warmupStart: 15, warmupStep: 10, followUps: false, followUpDays: '4, 10', lessons: '' },
    creators: { autoGraduate: false, graduateAt: 0.9, graduateWindow: 25, scout: false, continuous: false, scoutEveryMin: 30, maxLeadsPerDay: 60, scoutQueries: '', scoutPerDay: 15, scoutHour: 7, autoSend: false, sendPerDay: 50, warmupStart: 15, warmupStep: 10, followUps: false, followUpDays: '4, 10', lessons: '' },
  },
  creatorOffers: {
    shorts: { name: 'Shorts package', price: '$1,200 a month', details: '6 Shorts a day, Sabbath and holiday Shorts delivered and scheduled ahead of time, 6+ thumbnails plus SEO titles, descriptions and tags for each long-form video. Month to month: cancel anytime. You own the work.' },
    youtube: { name: 'Full YouTube management', price: '$2,200 a month', details: 'We build and run your YouTube channel end to end: Shorts, long-form packaging, thumbnails, SEO, uploads and scheduling.' },
    lead: 'shorts',            // which offer emails lead with
    senderName: '', bookingUrl: '', templates: '',
  },
  environment: 'test', // 'test' redirects all outbound messages to the sandbox recipients and keeps publishing in Manual Pack mode
  sandbox: { phone: '', email: '' },
  ai: {
    // Lowest cost first: your own AI account (no API key, rate-limited), then free Llama on this PC, then paid keys.
    local: 'all',
    bridge: { use: 'first', site: 'grok', perHour: 20 },
    roles: {
      operations: { provider: 'anthropic', model: 'claude-sonnet-5-5', fallbacks: ['openai', 'xai'], description: 'Client communications, triage, command routing, quality control' },
      analysis: { provider: 'openai', model: 'gpt-5', fallbacks: ['anthropic', 'xai'], description: 'Transcript analysis, clip discovery, editing plans' },
      research: { provider: 'xai', model: 'grok-4', fallbacks: ['anthropic', 'openai'], description: 'Prospect research, social audits, trend discovery' },
      writing: { provider: 'anthropic', model: 'claude-sonnet-5-5', fallbacks: ['openai', 'xai'], description: 'Titles, captions, outreach drafts' },
    },
    transcription: { provider: 'openai', model: 'whisper-1', localWhisperPath: '', localWhisperModel: '' },
    budgetsUsd: { anthropic: 60, openai: 60, xai: 30 },
    // Estimated USD per 1M tokens [input, output]; used only for cost tracking, editable in Settings.
    prices: {
      anthropic: { default: [3, 15] },
      openai: { default: [1.25, 10], 'whisper-1': [0, 0] },
      xai: { default: [3, 15] },
    },
    whisperPerMinuteUsd: 0.006,
  },
  messaging: {
    quietHours: { enabled: true, start: 21, end: 8 },
    maxOutboundPerHour: 40,
    autoSendRoutine: true,   // acknowledgements and status updates to existing clients
    signature: 'Euclidean Media',
    smsPollSeconds: 20,
    emailPollSeconds: 60,
    // Categories that always wait for a founder's approval before sending
    approvalRequired: ['prospecting', 'pricing', 'commitment', 'complaint', 'contract', 'sensitive', 'unknown_contact'],
  },
  production: {
    defaultClipCount: 6,
    minClipSec: 20,
    maxClipSec: 59,
    reframe: 'face',       // 'face' (tracks the speaker) | 'smart-blur' | 'crop' | 'fit'
    encoder: 'auto',       // 'auto' | 'libx264' | 'h264_nvenc' | 'h264_qsv' | 'h264_amf'
    crf: 20,
    loudnessLufs: -14,
    preferPremiere: false, // when true, edit jobs go to the Astra/Premiere handoff instead of the native renderer
  },
  publishing: {
    provider: 'manual', // 'manual' | 'ayrshare'
    youtubeDirect: false,
  },
  resources: {
    mode: 'full',             // 'full' | 'lite' | 'background'
    maxConcurrentRenders: 1,
    maxConcurrentLight: 4,
    renderThreads: 0,         // 0 = let FFmpeg decide
    renderPriority: 'below_normal',
    reserveRamMb: 1000,       // keep up to this much RAM free for other apps (capped at 12% of the PC's RAM); heavy jobs wait otherwise
    pauseHeavyWhenCpuAbove: 85,
    pauseHeavyWhenPremiereOpen: true,
    autoLiteWhenPremiereOpen: false,
    runHeavyJobsLocally: true,
  },
  // Agent Connections: peer-to-peer messaging between Grok, Claude, GPT/Codex, Cursor, opencode and custom agents.
  // Per-agent setup lives in agentNet.agents.<id> and is written by Settings → Agent Connections.
  agentNet: {
    paused: false,           // pauses every automatic agent-to-agent delivery
    maxAutoTurns: 12,        // a thread pauses itself after this many agent replies in a row without a person
    replyTimeoutSec: 300,
    agents: {},
  },
  server: { port: 4870, lan: false },
  notifications: { desktop: true, smsFounderOnCritical: false, founderPhone: '' },
  schedule: { dailyDigestHour: 8 },
};
