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
  environment: 'test', // 'test' redirects all outbound messages to the sandbox recipients and keeps publishing in Manual Pack mode
  sandbox: { phone: '', email: '' },
  ai: {
    roles: {
      operations: { provider: 'anthropic', model: 'claude-sonnet-5-5', fallbacks: ['openai', 'xai'], description: 'Client communications, triage, command routing, quality control' },
      analysis: { provider: 'openai', model: 'gpt-5', fallbacks: ['anthropic', 'xai'], description: 'Transcript analysis, clip discovery, editing plans' },
      research: { provider: 'xai', model: 'grok-4', fallbacks: ['anthropic', 'openai'], description: 'Prospect research, social audits, trend discovery' },
      writing: { provider: 'anthropic', model: 'claude-sonnet-5-5', fallbacks: ['openai'], description: 'Titles, captions, outreach drafts' },
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
    reserveRamMb: 6000,       // keep this much RAM free for Premiere/Astra; heavy jobs wait otherwise
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
