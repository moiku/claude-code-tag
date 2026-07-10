# cctag

<img src="assets/icon.png" alt="cctag icon" width="120" />

Bridge a Slack thread to a **locally running Claude Code TUI session**, the
way [Claude Tag](https://www.anthropic.com/news/introducing-claude-tag) bridges
Slack to a cloud session — except cctag drives *your own terminal*.

```
Slack thread (@cctag)
   ⇅ Socket Mode (@slack/bolt) — no public server required
cctag daemon (Node/TS, runs on your machine)
   ├─ inject:  herdr agent send <terminal_id> <text> + Enter
   ├─ detect:  herdr agent get  <terminal_id>  (idle / working / blocked / done)
   ├─ read:    ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl
   └─ pairing: thread (channel, thread_ts) ⇔ herdr terminal_id
```

cctag controls Claude Code through [herdr](https://herdr.dev) (a terminal
workspace manager) rather than screen-scraping tmux — agent discovery,
keystroke injection, and status detection all go through the `herdr` CLI.
Turn output is read from Claude Code's own structured JSONL transcripts, not
parsed off the screen.

## Status

**v0.1.** Text-in / text-out turns work end-to-end. Multiple-choice prompts
are also supported: when Claude Code shows an `AskUserQuestion` prompt or a
tool-permission menu, cctag renders it as Slack buttons (plus a free-text
reply option for `AskUserQuestion`) and answers are sent back into the
terminal for you. If someone answers directly at the keyboard instead, the
Slack message updates to say so.

Note on how this works: Claude Code does **not** write an `AskUserQuestion`
tool call to its session transcript until *after* it's answered, so pending
questions (like pending permission prompts) are read directly off the
terminal screen via `herdr pane read`, not from the transcript. See
`src/prompts.ts`.

## Requirements

- [herdr](https://herdr.dev) installed and running, with one or more Claude
  Code instances started as herdr agents (`herdr agent start <name> --cwd
  <dir> -- claude`, or any Claude Code instance herdr already tracks).
- Node.js 20+.
- A Slack workspace where you can create an app (Socket Mode; no public
  server or open ports needed).

## Setup

1. **Create the Slack app** from `manifest.yaml`: https://api.slack.com/apps
   → *Create New App* → *From an app manifest* → paste `manifest.yaml` →
   pick your workspace.
2. Under **Basic Information → App-Level Tokens**, create a token with the
   `connections:write` scope. This is `SLACK_APP_TOKEN` (`xapp-...`).
3. **Install the app** to your workspace. Under **OAuth & Permissions**,
   copy the **Bot User OAuth Token** — this is `SLACK_BOT_TOKEN` (`xoxb-...`).
4. (Optional) Under **Basic Information → Display Information**, upload
   `assets/icon-512.png` as the app icon.
5. Invite the bot to a channel: `/invite @cctag`.
6. Find your own Slack user ID (three-dot menu on your profile → *Copy
   member ID*) — this is `CCTAG_OWNER_USER_ID`. Only this user can run
   `connect`/`disconnect`.
7. Copy `.env.example` to `.env` and fill in the four values above.

```bash
cp .env.example .env
$EDITOR .env
npm install
npm run dev   # or: npm run build && npm start
```

## Usage

In a Slack channel with `@cctag` invited, start a thread and mention the
bot:

| Command | Who | What it does |
|---|---|---|
| `@cctag connect` | owner | Lists running herdr/Claude Code agents; pick one to pair with this thread |
| `@cctag disconnect` | owner | Unpairs this thread |
| `@cctag status` | anyone | Shows the paired instance and its live status |
| `@cctag list` | anyone | Lists all running agents and which are paired |
| `@cctag <anything else>` | anyone (in a paired thread) | Sends the text into the paired Claude Code session; its reply is posted back in the thread |

Only one thread can be paired to a given terminal at a time. Only single-word
messages (`connect`, `status`, ...) are treated as commands — anything with a
space, including a message that merely *starts* with a command word, is
sent to Claude Code as a turn.

When Claude Code is waiting on a decision, cctag posts buttons in the
thread:

- **AskUserQuestion**: one button per option; click one, or just reply in
  the thread with free text for a custom answer. Multi-select questions
  aren't rendered as buttons (toggling checkboxes reliably over a terminal
  isn't robust yet) — reply in the thread listing what you'd pick instead.
- **Permission prompts** (e.g. "Do you want to run `rm -rf ...`?"): one
  button per choice, first option styled primary, anything that looks like a
  refusal ("No", "Cancel", "拒否") styled as a danger button.

Multi-question `AskUserQuestion` prompts are answered one question at a
time — after you answer, cctag reads the next one off the screen.

## Multi-user setups

Slack's Socket Mode delivers each event to exactly one of an app's open
connections — so multiple people each running their own cctag daemon
**against the same Slack app token** will steal each other's events, not
share them. Two ways to have more than one person use cctag:

- **Simplest**: each person creates their own Slack app (their own `@cctag-
  yourname` bot) from `manifest.yaml` and runs their own daemon against their
  own machine. Zero code changes — this is standalone mode (`npm run dev`).
- **Shared bot, Hub–Spoke**: one always-on **Hub** holds the single Socket
  Mode connection and a small always-on server; everyone else runs a
  **Spoke** on their own machine, which connects out to the Hub over an
  authenticated WebSocket (`wss://`) and drives their local herdr/Claude
  Code instances exactly like standalone mode does. The Hub doesn't run or
  see anyone's Claude Code session — it only routes Slack events to the
  right Spoke and relays messages back.

### Running a Hub

The Hub needs the same `SLACK_BOT_TOKEN`/`SLACK_APP_TOKEN` as standalone
mode, plus a public `wss://` endpoint (a domain + TLS in front of it —
[Caddy](https://caddyserver.com) gets you automatic HTTPS with almost no
config). A single Oracle Cloud "Always Free" `VM.Standard.E2.1.Micro`
instance is plenty.

```bash
git clone https://github.com/moiku/claude-code-tag.git /opt/cctag
cd /opt/cctag && npm install && npm run build
cat > .env <<EOF
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
CCTAG_HUB_PORT=8765
EOF
```

Point a domain at the box (an A record, DNS-only / not proxied through
Cloudflare or similar — Caddy needs to complete its own ACME/TLS handshake)
and give Caddy a one-line `/etc/caddy/Caddyfile`:

```
your.domain.example {
	reverse_proxy localhost:8765
}
```

Run the Hub under systemd (`ExecStart=/usr/bin/node dist/hub/index.js`,
`EnvironmentFile=/opt/cctag/.env`) so it survives reboots — see
`assets/cctag-hub.service` for a template unit file — then `systemctl
enable --now caddy cctag-hub`.

Issue each person a token from the Hub (this is the auth boundary — anyone
holding a token can register as any owner, so only hand these to people you
trust):

```bash
node dist/hub/index.js token issue <name>   # prints a token
node dist/hub/index.js token list
node dist/hub/index.js token revoke <name>
```

### Running a Spoke

Same `.env` as standalone mode (`CCTAG_OWNER_USER_ID`, `CCTAG_HERDR_BIN`,
etc.) but with the Slack tokens replaced by the Hub connection:

```bash
CCTAG_HUB_URL=wss://your.domain.example
CCTAG_SPOKE_TOKEN=<token from `token issue`>
```

```bash
npm run build
npm run start:spoke   # or dev:spoke while iterating
```

The Spoke reconnects automatically (with backoff) if the connection drops.
Pairing state still lives locally on the Spoke's machine
(`~/.cctag/pairings-<hub-url>.json`, namespaced per Hub — see below) — the
Hub only keeps a lightweight, in-memory "which thread belongs to which
Spoke" map, rebuilt from what each Spoke reports on connect.

### Connecting to more than one Slack workspace

A Hub is tied to exactly one Slack app/workspace (its `SLACK_BOT_TOKEN`/
`SLACK_APP_TOKEN`). To bridge a second workspace, run a second Hub — it
doesn't need its own machine; a second lightweight process (own port, own
`.env`, own systemd unit) on the same box is enough — and a second Spoke on
each machine that should reach both workspaces.

Both Spokes on one machine still talk to the **same local herdr daemon**,
so they see the same pool of Claude Code instances — pairing one workspace
to a terminal doesn't stop the other workspace's picker from also offering
it. cctag doesn't guard against this across separate Spoke processes (only
within one Spoke's own pairings); avoid pairing the same terminal from two
workspaces at once, or you'll get keystrokes interleaved from both.

To run two Spokes from a single checkout, point `CCTAG_ENV_FILE` at a
per-instance `.env` (e.g. `.env.workspace2`) instead of duplicating the
whole directory — everything else (`CCTAG_HUB_URL`, `CCTAG_SPOKE_TOKEN`,
pairing storage) is automatically kept separate per Hub URL:

```bash
CCTAG_ENV_FILE=/opt/cctag/.env.workspace2 node dist/spoke/index.js
```

For a persistent second instance, add a second launchd
`LaunchAgent`/systemd unit whose `EnvironmentVariables`/`Environment` sets
`CCTAG_ENV_FILE` to that second `.env` file.

## Security notes

Anyone who can post in a paired thread can send arbitrary text into a
full-permission local coding agent. Pairing is owner-opt-in per thread, the
owner can disconnect at any time, and tool permission prompts still require
someone to approve them (today: at the terminal; Slack buttons are planned).
Only pair threads in channels with people you trust.

## License

MIT — see `LICENSE`.
