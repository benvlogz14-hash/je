# Euclidean

Desktop app for Euclidean Media (founders Ryan Rosario and Ben Gingold), a short-form video agency for creators and political campaigns. It runs clients, footage, clip production, approvals, messaging, publishing, analytics and AI agents in one place.

## How it's built
- **Electron shell:** `app/main.js` and `app/preload.js`. The engine runs inside it; `ctx` hooks include `pickFolder`, `pickFiles`, `relaunch` and `revealFile`.
- **Node engine:** `server/index.js` and `server/api.js` (a custom Router: `r.get/post/patch/del(path, (req, body, params) => ..., { roles, stream, raw })`).
  - JSON store: `server/core/store.js` (`ctx.store.all/get/find/insert/update/remove`).
  - Audit log: `server/core/audit.js`.
  - Server-sent events: `server/core/events.js`.
- **Jobs:** `server/jobs/queue.js` and `server/jobs/handlers.js`. Every automated step is a `queue.register(name, { title, run(job, h) })` handler; `h.progress(frac, text)` reports progress.
- **AI:** `server/integrations/ai.js`. Use `ai.ask({ role, system, prompt, json, search, clientId, jobId })`; it routes by role to Anthropic, OpenAI or xAI with fallback, budgets and usage tracking. `search: true` gives live web search on xAI only.
- **Messaging:** `server/automation/messaging.js`.
  - `createOutbound(...)` puts AI drafts and first contact with prospects into Approvals.
  - `deliver` re-checks opt-outs, quiet hours, the hourly cap and Test mode before sending.
  - In Test mode, mail goes to the sandbox address.
  - Email is SMTP/IMAP (`server/integrations/email.js`); texts and calls use Twilio (`server/integrations/twilio.js`).
- **Video:**
  - FFmpeg helpers: `server/video/ffmpeg.js`.
  - Studio exporter with 47 xfade transitions, keyframes and ASS titles: `server/video/studio.js`.
  - AI edit operations: `server/video/edit-ops.js`.
  - Preview proxies: `server/video/proxy.js`.
  - Looking through video: `server/video/vision.js` (`look`, `cached`, `summarize`, `shotAt`). FFmpeg finds the shots, grabs a still per shot, measures brightness, sharpness and motion; faces are counted; an AI that can see (`ai.ask({ images })`, Claude/GPT/Grok, or the free `llama3.2-vision` via Ollama) describes each shot (kind, what, on-screen text, quality, usable). Runs in the `analyze` job (setting `video.lookThrough`) and on demand (`video.look`, Production → Footage → Look through / Shots); feeds clip discovery and the speech ads' B-roll and line picking.
- **Agent network:** `server/agents/` (registry, adapters, broker, protocol, routes). Peer-to-peer agents; nobody is the central orchestrator; external actions need human approval.
- **Creators analytics:** `server/integrations/creators.js` (yt-dlp, Social Blade-style report).
- **Renderer:** Preact + htm with no build step, in `renderer/js`. Modules are in `renderer/js/modules/*.js` (studio, analytics, growth, agents, settings, production and others).
  - Light theme only: white base, pastel accents and buttons.
- **Phone app:** `mobile/`, an Expo SDK 57 React Native remote for the engine.
  - Run it with `Start Phone App.bat` (Expo Go).
  - `.github/workflows/ios-app.yml` builds an unsigned `.ipa` for Sideloadly.
- **Launchers:** `Start Euclidean.bat` installs Node, FFmpeg and yt-dlp, runs `npm install`, creates a desktop shortcut and starts the app. `Build Installer.bat` runs `npm run dist`. `.bat` files must keep CRLF line endings.

## Run and test
- `npm start` runs the Electron app; `npm run engine` runs the engine only (`--data <dir> --port <n>`). The login link with its token is printed in the log.
- To test the UI, drive the engine's web UI with Playwright (Chromium is at `/opt/pw-browsers/chromium` in cloud sessions).
- Check rendered video by grabbing frames with FFmpeg.
- Don't run `npm run selftest` unless asked; the user rejected it as too long.

## Working rules (from Ryan)
- Write for beginners: plain-English errors, no terminal, config or JSON for the user, setup through buttons.
- Commit and push finished work to the working branch. Don't open pull requests unless asked.
- Never send texts or emails, post, or change CRM records or accounts without human approval. The one exception is outreach autopilot, which a founder switches on per lane: drafts that pass every check in `server/outreach/autopilot.js` may send automatically. Contrast/attack ads always need a person. Keep each client's data inside its workspace.

## Outreach offer and tone
- Pitch: two free tailored example videos (one vertical, one horizontal) that they can use free of charge whether or not they talk to us, and the ask "Could you give us 20 minutes?"
- Emails are personal and specific, have one clear ask, make no invented claims, and include an opt-out line. Ryan's email templates are the house style.
- Video style: bubbly, poppy motion graphics drawn entirely in code, tailored to each target.

## Political package system (base built; see status below)
Build it into the existing prospects/Growth module (prospect `type: 'political'` already exists, with `prospect.research`, `prospect.audit` and `/api/prospects/:id/outreach`).

1. **Scout:** find new leads from a plain-English query using OpenStates, FEC, Congress.gov, Wikidata, news and xAI search. Skip duplicates.
2. **Research brief:** every claim has a cited source. Cover office, district, committees, votes and bills, fundraising, recent news, social presence, and a public campaign or press contact.
   - Public, professional information only; no home addresses or family details.
3. **Email:** tailored from Ryan's templates, with the free-videos and 20-minute ask. It goes to the campaign or press contact (not official .gov addresses) and waits in Approvals. Batch approve is allowed; nothing sends automatically.
4. **Package:**
   - Videos: about 40 seconds by default (adjustable to 4 minutes), 1080×1920 and 1920×1080. Scenes are laid out in HTML/CSS, screenshotted by headless Edge/Chromium (or an offscreen Electron window), then animated and joined with FFmpeg (zoom, slide-ins, xfade). Optional narrator voice through OpenAI text-to-speech.
   - A one-page PDF sheet showing both videos, the offer and a booking link.
   - Only real public photos and quotes; never fake the politician's face or voice. Add a small "Concept by Euclidean Media" tag.
5. **Calls:**
   - A call list with one-click Twilio dialing and a tailored script, made by a person.
   - An optional voice note in your own (cloned) voice attached to the email.
   - Cloned-voice AI only for inbound callbacks.
   - **No automated robocalls:** under the TCPA they need prior consent, and the FCC counts AI voices as artificial.
6. **Automation:** paste names or run a scout, and each lead becomes a background job with progress and re-runnable steps, per-hour sending caps, opt-out handling and reply tracking. Show it on a Political screen on the desktop and in the phone app.

API keys to connect: Anthropic (required), xAI (lead search), OpenAI (narrator), api.data.gov (Congress.gov and FEC), OpenStates, Twilio and ElevenLabs (calls/voice). Use a separate outreach email domain with SPF, DKIM and DMARC records.

### Status (base build)
Built and tested end to end with sample data; live lookups were blocked in the cloud session, so they still need testing on a real PC.
- `server/political/sources.js`: lookup from Wikipedia, Wikidata, congress-legislators, FEC, Open States, Google News and the target's own sites (contact emails are ranked campaign/press first and .gov last), plus `rosterSearch` for Open States.
- `server/political/render.js`: HTML scene layouts → headless Edge/Chrome sprite screenshot → FFmpeg animation (pop, slide, float, slow zoom, xfade) for 1080×1920 and 1920×1080. Fonts come from `renderer/assets/fonts`, with a "Concept by Euclidean Media" tag. About 85 seconds to render 30 seconds of video per orientation.
- `server/political/package.js`: the steps research → brief → creative → video_v → video_h → sheet (PDF) → email. Results are stored on `prospect.pkg`, and any step can be re-run. `vetStoryboard` drops quotes and numbers that aren't in the research.
- Jobs: `political.package` and `political.scout` in `server/jobs/handlers.js`.
- API: `/api/political/packages|scout|approve|steps`, `/api/prospects/:id/package`, `/api/prospects/:id/file/:kind`.
- UI: Growth → **Political packages** (`renderer/js/modules/political.js`). The Open States and api.data.gov keys are in Settings → Connections.
- Settings live under `political.*` in `server/core/defaults.js`.

**Not built yet:**
- Twilio click-to-dial (calls are currently a tel: link plus a script and outcome logging).
- Recording and attaching the voice note.
- Cloned-voice answering of inbound calls.
- A Political tab in the phone app (its email drafts already show in Approvals there).
- Reply tracking that moves the prospect's stage automatically.

## Outreach lanes (Growth → Creators | Politics)
- **Creators** get an email only, never sample videos. Offers (`creatorOffers.*` in defaults):
  - Shorts package, $1,200 a month (the Stringer Media deal terms). This is the lead offer.
  - Full YouTube management, $2,200 a month. Creators with no YouTube channel are pitched this.
  - Code: `server/outreach/creators.js` (scout, research, email), jobs `creator.scout` and `creator.outreach`.
- **Politicians** get the package: three ads (a short vertical, a short horizontal and a long horizontal), a one-pager and an email. The political plan is 12 posts a week for $949 (`political.plan`).
  - Style: `political.videoStyle = 'campaign'` is the modern campaign-ad look in `server/video/campaign.js`; 'pop' is the bubbly look.
  - Factual scenes show their sources on screen.
  - Contrast ads are off by default (`political.contrastAds`). They need a researched opponent and cited facts, and are never auto-sent.
- **Speech ads** (`political.videoStyle = 'speech'`, `server/political/footage.js`, package step `footage`):
  - Finds public videos of the candidate with no login: links pasted on the lead (`prospect.footageLinks`), public Facebook videos/reels found through web search and their sites, their YouTube channel and YouTube search. Downloads the first 10 minutes of up to `political.footageClips` with yt-dlp.
  - Transcribes (OpenAI Whisper or local whisper.cpp), then AI picks whole sentences the candidate says (never cut inside a sentence or splice words), with short issue titles and a tagline.
  - Each line: face-following crop, B-roll (quiet parts of other videos, background and candidate photos) laid over part of it while their voice continues, word captions, issue title pill, name lower third, footage credit. Campaign-graphics opening title and vote card, music ducked under the voice.
  - Falls back to the graphic ads when fewer than two usable lines are found. Clips not posted by the candidate are marked `own: false` and the email then calls the ads concepts.
- **Autopilot** (`server/outreach/autopilot.js`, ticked by the scheduler):
  - Daily scout rotates through saved searches.
  - Auto-send has a daily cap with a warm-up ramp.
  - It only auto-sends when the email is confirmed on the person's own pages or comes from an imported list, it isn't a .gov or state address, it isn't on the exclusions list, they haven't opted out or already replied, a mailing address is set (CAN-SPAM), and, for politicians, the package is finished and has no contrast ad.
  - Anything that fails a check waits in the review queue (the "bubbles") with the reason shown.
- **House rules** (`server/outreach/common.js`):
  - No em dashes.
  - Every email has an opt-out line and the postal address.
  - Never pitch government addresses.
  - Never invent contacts.
- **Leads:** `server/outreach/leads.js` imports any CSV and remembers its columns; the export writes leads back in the same layout. Ryan's brief and the 238-lead list (95 YouTube creators and 143 Connecticut Democrats) still need to be imported.
- **Follow-ups** (`server/outreach/followups.js`, run from the autopilot tick every 10 minutes): off by default, switched on per lane (`outreach.<lane>.followUps`, `followUpDays` e.g. "4, 10"). Leads still at Contacted with no reply get a short follow-up in the same email thread; it sends on its own only when auto-send is on and the safety checks pass, otherwise it waits in Approvals.
- **Free speech-to-text:** `server/setup/whisper.js` installs whisper.cpp and the base.en model from the setup checklist (job `setup.whisper`).
- **Replies:** an email "stop" opts the contact out, and any reply moves the prospect to Replied (`messaging.receive`).
- **Still to do:** a check of the Stringer contract terms against the signed agreement, importing Ryan's brief and lead list, and live testing on a real PC.
