# Euclidean command list

Type these in any Euclidean composer, the Ctrl+K palette, the Lite window, or send them from any connected agent with `POST /api/agent/command`. Commands marked AI need a Claude, GPT or Grok key. Without a slash, your words go to the operations agent, which picks the right commands.

## Communication

| Command | What it does |
|---|---|
| `/inbox` | Unread conversations and messages waiting for approval |
| `/text <contact> <message>` | Send a text message |
| `/email <contact> <subject> \| <message>` | Send an email |
| `/reply <message>` | Reply in the open conversation on its last channel |
| `/draft <contact> <goal>` | Have the writing agent draft a message for approval (AI) |
| `/followup` | Contacts who are waiting on us or have gone quiet |
| `/note <text>` | Internal note in this conversation (never sent) |

## Clients

| Command | What it does |
|---|---|
| `/clients` | Active clients with quota status |
| `/client <name>` | Open a client workspace |
| `/newclient <name> [creator\|political]` | Create a client workspace |
| `/remember <client>: <preference>` | Save a client preference applied to all future work |
| `/quota <client> <n>/day` | Set shorts per day and turn on autopilot |

## Production

| Command | What it does |
|---|---|
| `/ingest <file path or link> [for <client>]` | Import footage and start the pipeline |
| `/discover <client> [n]` | Find n more clips in the client's newest footage |
| `/clips [client]` | Recent clips and where each one is |
| `/edit <clip#> <instruction>` | Re-edit a clip from plain-language direction (e.g. "/edit 104 start at the joke, no hook") (AI) |
| `/render <clip#\|all <client>>` | Re-render one clip, or batch re-render every clip in review for a client |
| `/approve [clip#\|all <client>]` | Approve a clip, or open the approval queue |
| `/reject <clip#>` | Reject a clip |
| `/premiere <clip#>` | Hand a clip to Astra for editing in Adobe Premiere |
| `/studio [clip#]` | Open the Studio editor (optionally with a clip loaded) |

## Publishing

| Command | What it does |
|---|---|
| `/schedule [client]` | Upcoming posts |
| `/publish <clip#> [now]` | Schedule an approved clip into the next slot, or publish now |

## Growth

| Command | What it does |
|---|---|
| `/prospect <who you want>` | Research qualified prospects (e.g. "/prospect CT state house candidates 2026 with weak TikTok") (AI) |
| `/audit <prospect>` | Write a social media audit for a prospect (AI) |

## Business

| Command | What it does |
|---|---|
| `/revenue` | Revenue, costs, profit and founder distributions this month |
| `/analytics [client]` | Performance of published posts |
| `/invoice` | Draft this month's retainer invoices (not sent) |

## System

| Command | What it does |
|---|---|
| `/agents` | AI agents, roles, spend and computer-use status |
| `/queue` | Running and pending jobs |
| `/retry <job id\|all>` | Retry a failed job, or all failed jobs |
| `/cancel <job id>` | Cancel a job |
| `/pause` | Emergency stop: halt all sending, publishing and production |
| `/resume` | Resume automation after an emergency stop |
| `/logs [filter]` | Recent activity from the audit log |
| `/health` | Check every integration, worker and tool |
| `/lite` | Lite mode: vital functions only, frees RAM for Premiere |
| `/full` | Full mode: everything runs |
| `/background` | Close the window to the tray; the engine keeps working |
| `/backup` | Back up the database now |
| `/status` | One-line system status |
| `/help [command]` | All commands |
