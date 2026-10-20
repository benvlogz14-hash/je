# Euclidean

Euclidean Media's internal operating system. It's one desktop app that runs client communication, the shorts production line, approvals, publishing, prospecting and the books, so the founders mostly supervise.

- **Messages**: SMS (Twilio) and email in one iMessage-style inbox, plus the **Euclidean** thread where `/commands` or plain language run everything. See [docs/COMMANDS.md](docs/COMMANDS.md) for all 42 commands.
- **Agents**: Claude, GPT and Grok are assigned to roles (operations, analysis, research, writing) with fallbacks, monthly budgets and per-client cost tracking. Astra, or any computer-use agent, takes Premiere work orders through a small API.
- **Production**: footage in → transcript → scene and energy analysis → AI picks the best clips (6 per video by default) → jump cuts → **face-tracked 9:16 reframe** → word-highlight captions → client graphics template (hook, lower third, end card, progress bar, logo) → loudness normalisation → technical QC → approval → scheduled into the client's posting slots → published → analytics.
- **Studio**: a built-in Premiere-style editor (bin, program monitor, effect controls, multi-track timeline). Projects use **Velo**'s file format, so every short also opens in Velo (themed copy in `velo/`) or goes to Adobe Premiere as XML + SRT.
- **Client memory**: feedback like "no all-caps captions" is stored per client and applied to every future render and agent call.
- **Safety**: political content is never auto-approved; first-touch outreach always needs a founder (hold to send); opt-outs, quiet hours and an hourly cap are enforced at send time; there's an emergency stop; a **Test environment** redirects every message to your own phone and email and posts nothing.
- **Power modes**: Full, **Lite** (vital functions only, frees RAM and CPU for Premiere and Astra) and Background (tray only). Renders automatically wait while Premiere is open or free RAM drops below your reserve.

## Run it (Windows)

**Double-click `Start Euclidean.bat`.** That's it. The first time, it installs Node.js and FFmpeg if they're missing, sets up the app (a few minutes) and puts a **Euclidean** shortcut on your desktop. After that, use the desktop shortcut.

To make a proper installer (`dist\Euclidean Setup 1.0.0.exe` plus a portable `.exe`), double-click **`Build Installer.bat`**. To ship FFmpeg inside the installer, put `ffmpeg.exe` and `ffprobe.exe` in `build\bin\` first.

Optional: `winget install yt-dlp.yt-dlp` for YouTube, Twitch and Drive links.

<details><summary>Command line (developers)</summary>

```
npm install
npm start          (note: "start", not "star")
npm run dist
```
</details>

Check that the pipeline works on your machine with no API keys: `npm run selftest` (it generates test footage with speech, finds clips, renders, approves, publishes to a Manual Pack and exports from Studio).

Data lives in `%APPDATA%\Euclidean\data` (database, encrypted credentials, client folders, renders, backups). The engine listens on `127.0.0.1:4870`.

## On your iPhone

Euclidean can't be installed from a file onto an iPhone (Apple only allows signed apps), but it runs as a **home-screen app** connected to this computer:

1. **Settings → General → Use on your iPhone → Turn on phone access** (Euclidean restarts once; allow it on private networks if Windows asks).
2. Click **Create my phone link** and scan the QR code with the iPhone Camera (same Wi-Fi).
3. In Safari tap **Share → Add to Home Screen**. Open Euclidean from its icon: full-screen, signed in.

The computer must be on with Euclidean running. To use it away from your Wi-Fi, expose Euclidean with Cloudflare Tunnel and enter that address as the Public URL in Settings → General → Network. **Disconnect phone** revokes the phone's access.

### Native iPhone app (Expo Go)

There is also a native app in `mobile/` (approvals, chat, AI Studio edits, agents, creators, status and the emergency stop). It runs inside Apple's free **Expo Go** app, so it needs no Apple developer account:

1. Install **Expo Go** from the App Store.
2. Double-click **Start Phone App.bat** on the computer (first run downloads its parts) and scan the QR code it shows with the iPhone Camera.
3. In the app tap **Scan the code** and scan the phone code from step 2 above.

The computer must keep that window open while you use the app. If the phone can't connect on your Wi-Fi, run `Start Phone App.bat tunnel`.

### Install it as a real app (free Apple ID, no jailbreak)

GitHub builds `Euclidean.ipa` on a Mac every time `mobile/` changes (Actions → **Build iPhone app** → Artifacts → *Euclidean-iPhone*; unzip it). Install it with **Sideloadly** on Windows:

1. Install **iTunes** and **iCloud** from apple.com (the website versions, not the Microsoft Store ones), then **Sideloadly** from sideloadly.io.
2. Plug the iPhone in with a cable, unlock it and tap **Trust**.
3. Drag `Euclidean.ipa` into Sideloadly, type your Apple ID email and press **Start**. Enter your Apple ID password and any code Apple sends.
4. On the iPhone: **Settings → Privacy & Security → Developer Mode → On** (it restarts), then **Settings → General → VPN & Device Management →** your Apple ID → **Trust**.
5. Open Euclidean from the home screen and scan the phone code.

With a free Apple ID the app works for 7 days; plug in and press Start in Sideloadly again to renew (turn on its auto-refresh to do this over Wi-Fi). A free ID allows 3 sideloaded apps at a time. The installed app doesn't need `Start Phone App.bat`, only Euclidean running on the computer.

## Political packages

Growth → **Political packages**: paste names (one per line, e.g. `Jane Rivera — Texas House District 12`) or describe who to scout. For each person Euclidean:
1. researches public records (Wikipedia, Congress, FEC, Open States, news, their own website) and writes a cited brief;
2. writes a storyboard, a tailored email and a call script;
3. renders a vertical and a horizontal video drawn in code;
4. makes a one-page PDF sheet;
5. puts the email, with the videos and sheet attached, into Approvals.

Nothing is sent until you approve it. You can tick several reviewed packages and approve them together. In Package settings you can set the video length, your booking link, who signs the email, your best emails to copy the style of, colours, music and an optional AI narrator. Free data keys (Open States, api.data.gov) go in Settings → Connections. Calls are made by a person from the script: automated robocalls are illegal without consent.

## First-time setup (about 20 minutes)

1. **Settings → General**: keep **Test** on. Enter your own phone and email as sandbox recipients.
2. **Settings → Connections**: add an Anthropic, OpenAI and/or xAI key (OpenAI also powers transcription), Twilio (account SID, auth token, number), and email (Gmail: app password; presets fill in the servers). Each has **Save & test**.
3. **Clients → New client → Stringer Media**: creator, 6 shorts per day. Add Jordan (or whoever) as the main contact. On **Schedule & platforms**, pick the platforms, check the six posting times and turn on **Autopilot**. On **Captions & graphics**, set the caption look, lower third, end card and logo.
4. Drop Stringer's footage on **Production** (or add his YouTube channel ID under **Footage & sources** so new uploads import automatically).
5. Work the **Approvals** queue (`A` approve, `R` request changes, `J`/`K` move). Approved shorts fill the next free slots.
6. When everything looks right, connect **Ayrshare** (one key that crossposts to TikTok, Instagram, YouTube, Facebook, X, Threads and LinkedIn; each client links their accounts to their own Ayrshare profile and you paste the profile key on their **Billing & accounts** tab). Then switch to **Production**.

Without Ayrshare, publishing writes a **Manual Pack**: the video plus per-platform captions in `exports\<client>\<date>\`.

## Three-computer setup

| Machine | Runs |
|---|---|
| Old desktop 1 (always on) | `npm start` (or headless `npm run engine -- --lan`). Turn on **LAN access** in Settings → General. |
| Old desktop 2 (editing) | `npm run worker -- --engine http://DESKTOP-1:4870 --token <worker token>`. Create the token in Settings → Team & agents. In System → Resources, turn off "Render on this computer" on desktop 1 so desktop 2 does the renders. |
| Your laptop | Open `http://DESKTOP-1:4870/?token=<owner token>` in a browser, or run the app pointed at the same data. |

The client portal (`/portal/<private link>`) needs LAN access, or a public URL through Cloudflare Tunnel or similar, to reach clients outside your network.

## Astra and Premiere

Turn on **Settings → Production → Send every edit to Premiere**, or use `/premiere 104` for one clip. Euclidean writes a work order (Premiere XML sequence, SRT captions, a brief with the client's preferences, and an output path). Astra polls for it:

```
GET  /api/agent/next?capability=premiere        → work order
POST /api/agent/jobs/:id/progress               { progress, note }
POST /api/agent/jobs/:id/complete               { outputPath }
POST /api/agent/jobs/:id/fail                   { error }
POST /api/agent/command                         { text: "/clips stringer" }
Authorization: Bearer <agent token>
```

When Astra calls `complete`, Euclidean runs QC, opens the approval and schedules the clip.

## Agent Connections (peer-to-peer agents)

**Settings → Agent Connections** connects Grok, Claude, GPT/Codex, Cursor, opencode and any custom agent so they can message each other as equals: send messages, reply, ask questions, request critiques, hand off tasks, share files and join threads. No agent is in charge; Euclidean's broker only routes, logs and enforces the rules.

- Each agent card shows **Connected / Not connected / Needs attention**, the connection type (**API key**, **On this computer**, **Herdr terminal**, **Local / network**), an API-key box, install status, a model picker and **Test**, **Reconnect**, **Install** and **Configure automatically** buttons. Paths, command options, workspace access and extra instructions sit under **Show advanced**. No terminal, PATH or config-file editing is needed: tools install into Euclidean's own data folder.
- **Herdr** (terminal runtime) is only used for command-line agents. Install it with one click, or **Install from file** with the Herdr zip you downloaded. To ship it inside the installer, unzip it into `build\bin\herdr\` before `Build Installer.bat`.
- **System → Agent conversations** shows agent status, threads, every message with its delivery state, each agent's inbox and outbox, failed messages (with retry), approval requests, and **Pause all agents** / **Pause** / **Intervene** controls.
- Safety: each conversation belongs to one workspace (internal or one client) and nothing crosses between workspaces. Every message is written to the activity log. Agents can't text, email, post, or change CRM records or accounts; they can only *ask*, and a person approves or declines. A conversation pauses itself after 12 agent replies in a row without a person.
- Agents outside Euclidean can join in mailbox mode: create a token on their card, then `GET /api/agentnet/mailbox` and `POST /api/agentnet/mailbox/send { threadId, to, type, body, inReplyTo }` with `Authorization: Bearer <token>`.

## Velo

`velo/` is the open-source Velo editor (GPL-3.0) restyled in Euclidean's light theme, with a fix so it builds on Qt 6.4 or newer. Build it with CMake + Qt 6 + FFmpeg dev libraries (see `velo/README.md`), then set its path in **Settings → Production → Tools** to enable **Open in Velo**. Velo stays a separate program, and Euclidean only reads and writes its file format, so Euclidean's own code stays proprietary.

## Compliance notes

US business texting through Twilio requires **A2P 10DLC registration** (political campaigns register as such). Euclidean only sends one-to-one messages a founder approved or routine replies to existing clients, honours STOP and other opt-out keywords, holds messages during quiet hours, and adds an opt-out line to outreach drafts. Make sure clients authorise the footage and accounts you use.

## What's verified, and what needs your keys

Verified in this build: the whole production pipeline (ingest, transcript-driven jump cuts, face-tracked reframe, captions, graphics, QC, Velo and Premiere exports, Studio export), approvals, scheduling, Manual Pack publishing, client memory, the job queue across restarts, the remote worker, the portal, the desktop app launch, and the Velo build. The Claude, GPT, Grok, Twilio, email, Ayrshare and YouTube integrations are written against those services' documented APIs, but they could not be exercised live without your accounts. Use **Save & test** on each, and run a few days in the **Test** environment first.

## Project layout

```
app/        Electron shell (window, tray, Lite window, OS keychain, file picker)
server/     Engine: API, job queue, agents, messaging, pipeline, publishing, finance
  video/    FFmpeg renderer, captions, face tracking, analysis, Studio export, Velo/Premiere exporters
renderer/   Interface (Preact, no build step)
portal/     Client portal page
worker/     Remote render worker
velo/       Themed Velo editor source
scripts/    selftest, demo footage, sample workspace, interactive example builder, icons
docs/       Command list
```
