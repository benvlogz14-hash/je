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
