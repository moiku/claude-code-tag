🌐 [日本語](README.ja.md) | **English**

---

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

## What this actually looks like in use

### One shared session, more than one person driving it

Pairing a thread to a Claude Code session doesn't restrict who can talk to
it — anyone in that thread can. In practice this means two people with
different expertise can both instruct the *same* session directly, instead
of one of them acting as a manual relay between the other and the AI: a
domain specialist asks it to work through a domain question, an engineer
asks it a separate implementation question in the same thread, and the
session picks up context from both without either person needing to
translate for the other.

The same shape shows up outside research, too. A common failure mode for
deploying an AI coding agent with a client is needing one person who's
simultaneously good at customer discovery *and* good at engineering — a
high bar, close to what people mean by "Forward Deployed Engineer." Letting
a customer-facing person and an engineer both drive one shared session
lowers that bar: the customer-facing person runs the discovery
conversation, the engineer handles anything that needs deeper technical
judgment, and — because the customer-facing person is present for and
gradually absorbs the technical exchange rather than receiving it
secondhand — the split isn't static. Over repeated use they typically pick
up enough fluency to drive routine work themselves, and the engineer's
role narrows toward the critical moments that still need it.

### Claude Tag for discussion, cctag for the work itself

If you also use [Claude Tag](https://www.anthropic.com/news/introducing-claude-tag)
(Anthropic's own Slack bot), the two pair naturally rather than overlap.
Claude Tag starts with zero memory every time, but a shared GitHub repo
gives it continuity anyway: point it at a repo's existing docs to pick up
prior context, and have it push a summary of a discussion's conclusions
back before the thread ends. cctag then picks up from there for anything
that's long-running, resource-heavy, or needs your own machine's tools and
files rather than a sandbox.

cctag doesn't try to absorb what Claude Tag does, deliberately — they sit
at different points in the same workflow. A casual, exploratory discussion
(a "seminar") and a long real execution run (a "production job") are
different modes and probably shouldn't share an environment; keeping them
as two tools connected through an ordinary GitHub repo, rather than one
tool trying to do both, is the point, not a gap to close.

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

For a fuller walkthrough of the mechanism (aimed at lab students) — Hub/Spoke
roles, how herdr's agent registry differs from raw pane access, the
AskUserQuestion detection quirk, multi-workspace caveats — see
[docs/how-it-works.md](docs/how-it-works.md) (日本語) /
[docs/how-it-works.en.md](docs/how-it-works.en.md) (English).

## Two ways to run cctag

- **Standalone** — you create your own Slack app and run everything on one
  machine. Simplest option if you're the only person using cctag.
- **Hub–Spoke** — one shared Slack app, one always-on **Hub**, and one
  lightweight **Spoke** per person. Needed as soon as more than one person
  wants to use the same `@cctag` bot: Slack's Socket Mode delivers each
  event to exactly one of an app's open connections, so two people each
  running a full daemon against the same Slack app token would steal each
  other's events instead of sharing them. The Hub holds the single Socket
  Mode connection and only routes events; it never runs or sees anyone's
  Claude Code session. Each Spoke connects out to the Hub over an
  authenticated WebSocket and drives that person's own local herdr/Claude
  Code instances, exactly like standalone mode does.

**If someone else already runs a Hub for your lab/team** (e.g. your
supervisor), you only need [For Spoke users](#for-spoke-users) below —
skip straight there, none of the Slack app setup applies to you.

## Requirements

- **Node.js 20+** — needed everywhere cctag runs (Hub, Spoke, or standalone).
- **[herdr](https://herdr.dev)**, installed and running, with your Claude
  Code instance started as a herdr agent — needed only on machines that
  actually run Claude Code (standalone setups and every Spoke). A Hub-only
  machine never runs Claude Code and doesn't need herdr at all.
- **A Slack workspace where you can create an app** (Socket Mode; no public
  server or open ports needed) — needed only if you're creating the Slack
  app yourself (standalone or Hub operator). Spoke users never touch Slack
  app credentials.

### Installing herdr (macOS notes)

Install herdr with **one** method — Homebrew or the [official
installer](https://herdr.dev) — not both; mixing them leaves two `herdr`
binaries on `PATH` and makes `CCTAG_HERDR_BIN` ambiguous.

```bash
brew install herdr
brew services start herdr   # herdr runs as a background daemon via launchd
```

Register your Claude Code terminal as a herdr agent — the agent name comes
*first*, before `--cwd`:

```bash
herdr agent start <name> --cwd <project-dir> -- claude
herdr integration install claude
```

If Node is managed by `nvm`, the launchd-started herdr daemon doesn't
source `.zshrc`/`.zshenv` and only sees a minimal `PATH`
(`/usr/bin:/bin:/usr/sbin:/sbin`), so it can't find `claude` or `node`. Pass
the nvm bin directory explicitly:

```bash
herdr agent start <name> --cwd <project-dir> \
  --env PATH="$HOME/.nvm/versions/node/<version>/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
  -- claude
```

Check `herdr agent list` shows your agent as `idle` before continuing.

## For Hub operators

*(Skip this whole section if you're connecting to a Hub someone else
already runs — see [For Spoke users](#for-spoke-users) instead.)*

### Create the Slack app

1. From `manifest.yaml`: https://api.slack.com/apps → *Create New App* →
   *From an app manifest* → paste `manifest.yaml` → pick your workspace.
2. Under **Basic Information → App-Level Tokens**, create a token with the
   `connections:write` scope. This is `SLACK_APP_TOKEN` (`xapp-...`).
3. **Install the app** to your workspace. Under **OAuth & Permissions**,
   copy the **Bot User OAuth Token** — this is `SLACK_BOT_TOKEN` (`xoxb-...`).
4. (Optional) Under **Basic Information → Display Information**, upload
   `assets/icon-512.png` as the app icon.
5. Invite the bot to a channel: `/invite @cctag`.

### Running standalone

Find your own Slack user ID (three-dot menu on your profile → *Copy member
ID*) — this is `CCTAG_OWNER_USER_ID`. Only this user can run
`connect`/`disconnect`.

```bash
cp .env.example .env
$EDITOR .env   # SLACK_BOT_TOKEN, SLACK_APP_TOKEN, CCTAG_OWNER_USER_ID, CCTAG_HERDR_BIN
npm install
npm run dev   # or: npm run build && npm start
```

### Running a Hub (for more than one person)

The Hub needs the same `SLACK_BOT_TOKEN`/`SLACK_APP_TOKEN` as standalone
mode, plus a public `wss://` endpoint (a domain + TLS in front of it —
[Caddy](https://caddyserver.com) gets you automatic HTTPS with almost no
config). A single Oracle Cloud "Always Free" `VM.Standard.E2.1.Micro`
instance is plenty. This machine does **not** need herdr or Claude Code.

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

Issue each person a token from the Hub, bound to their own Slack user ID —
a token can only ever register as the owner it was issued for, so a leaked
or misused token can't be used to impersonate someone else's connection
(but it can still act on that owner's own paired threads, so only hand
these to people you trust):

```bash
node dist/hub/index.js token issue <name> <ownerUserId>   # prints a token
node dist/hub/index.js token list
node dist/hub/index.js token revoke <name>
```

Send each person the printed token, the Hub's `wss://` URL, and the
`ownerUserId` you issued it for — that's everything they need for [For
Spoke users](#for-spoke-users).

### Bridging a second Slack workspace

A Hub is tied to exactly one Slack app/workspace (its `SLACK_BOT_TOKEN`/
`SLACK_APP_TOKEN`). To bridge a second workspace, run a second Hub — it
doesn't need its own machine; a second lightweight process (own port, own
`.env`, own systemd unit) on the same box is enough.

**Tokens are namespaced per Hub.** If the second Hub is started with
`CCTAG_ENV_FILE=/opt/cctag/.env.workspace2` pointing at its own `.env`
(rather than a duplicated checkout), its `token issue`/`list`/`revoke`
commands also need that same `CCTAG_ENV_FILE` prefix, or they silently
operate on the *first* Hub's token store instead:

```bash
CCTAG_ENV_FILE=/opt/cctag/.env.workspace2 node dist/hub/index.js token issue <name> <ownerUserId>
```

## For Spoke users

*(This is the section for you if someone else already runs a Hub and just
handed you a token, a Hub URL, and a Slack user ID.)*

You can't generate any of these yourself — get them from your Hub operator:

- `CCTAG_HUB_URL` — the Hub's `wss://...` address
- `CCTAG_SPOKE_TOKEN` — a token issued specifically for you
- `CCTAG_OWNER_USER_ID` — your own Slack user ID; must match the ID the
  token was issued for, or the Hub rejects the connection

Make sure herdr is installed and your Claude Code instance is registered as
a herdr agent first — see [Installing herdr](#installing-herdr-macos-notes)
above.

```bash
git clone https://github.com/moiku/claude-code-tag.git
cd claude-code-tag
npm install
cp .env.example .env
$EDITOR .env   # CCTAG_HUB_URL, CCTAG_SPOKE_TOKEN, CCTAG_OWNER_USER_ID, CCTAG_HERDR_BIN
npm run build
npm run start:spoke   # or dev:spoke while iterating
```

The Spoke reconnects automatically (with backoff) if the connection drops.
Pairing state lives locally on your machine
(`~/.cctag/pairings-<hub-url>.json`, namespaced per Hub) — the Hub only
keeps a lightweight, in-memory "which thread belongs to which Spoke" map,
rebuilt from what each Spoke reports on connect.

### Connecting to more than one workspace

If your operator runs more than one Hub (e.g. two Slack workspaces), you
need one Spoke per Hub, each with its own token. Run a second Spoke from
the same checkout by pointing `CCTAG_ENV_FILE` at a per-instance `.env`
instead of duplicating the whole directory — `CCTAG_HUB_URL`,
`CCTAG_SPOKE_TOKEN`, and pairing storage are all kept separate per Hub URL
automatically:

```bash
CCTAG_ENV_FILE=/opt/cctag/.env.workspace2 node dist/spoke/index.js
```

For a persistent second instance, add a second launchd
`LaunchAgent`/systemd unit whose `EnvironmentVariables`/`Environment` sets
`CCTAG_ENV_FILE` to that second `.env` file.

Both Spokes on one machine still talk to the **same local herdr daemon**,
so they see the same pool of Claude Code instances — pairing one workspace
to a terminal doesn't stop the other workspace's picker from also offering
it. cctag doesn't guard against this across separate Spoke processes (only
within one Spoke's own pairings); avoid pairing the same terminal from two
workspaces at once, or you'll get keystrokes interleaved from both.

### Troubleshooting: "invalid token"

```
[spoke] disconnected from hub (code 4001: invalid token)
```

This means the Hub you're connecting to doesn't recognize your token —
almost always because it was issued somewhere other than the exact Hub
process you're pointed at (a different machine, or, on a Hub bridging
multiple workspaces, a different workspace's token store — see [Bridging a
second Slack workspace](#bridging-a-second-slack-workspace)). Ask your
operator to double-check:

- `CCTAG_HUB_URL` in your `.env` matches the Hub they issued the token
  against
- `CCTAG_OWNER_USER_ID` exactly matches the `ownerUserId` the token was
  issued for
- `node dist/hub/index.js token list`, run on the actual Hub machine (with
  the matching `CCTAG_ENV_FILE`, if it bridges more than one workspace),
  shows your name

If it's not listed there, ask them to re-issue it.

## Usage

In a Slack channel with `@cctag` invited, start a thread and mention the
bot:

| Command | Who | What it does |
|---|---|---|
| `@cctag connect` | owner | Lists running herdr/Claude Code agents; pick one to pair with this thread |
| `@cctag disconnect` | owner | Unpairs this thread |
| `@cctag status` | anyone | Shows the paired instance and its live status |
| `@cctag list` | anyone | Lists all running agents and which are paired |
| `@cctag model <name>` | anyone (in a paired thread) | Runs `/model <name>` in the paired session (e.g. `model opus`, `model sonnet`) |
| `@cctag mode <name>` | anyone (in a paired thread) | Switches the Shift+Tab mode: `manual` / `accept-edits` / `plan` / `auto` |
| `@cctag plan` | anyone (in a paired thread) | Enables Plan Mode (same as `mode plan`) |
| `@cctag log [instruction]` | anyone (in a paired thread) | Feeds thread messages since cctag's last post (not just @cctag mentions) into the paired session, optionally with an instruction |
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

### Switching model

`@cctag model <name>` runs Claude Code's `/model <name>` slash command
directly, rather than starting a conversational turn — the reply is the
command's own output (e.g. "Set model to Opus and saved as your default for
new sessions"), read straight off the terminal screen. If switching models
mid-conversation triggers a confirmation menu ("Switch model? Yes/No"),
it's auto-confirmed, since asking for the switch already expressed that
intent.

### Switching mode

`@cctag mode <name>` selects one of Claude Code's four Shift+Tab modes —
`manual`, `accept-edits`, `plan`, `auto`. There's no slash command for
these; the only control is cycling with Shift+Tab, so cctag reads the
current mode off the terminal footer and cycles one press at a time until
it reaches the target (a raw backtab control sequence — herdr's plain
`send-keys shift+tab` doesn't register with Claude Code). If the target
isn't reachable (not present in that Claude Code build), it reports so and
leaves the mode exactly where it started. `@cctag plan` is a shorthand for
`mode plan`. These commands are blocked while a turn is in progress on the
same instance.

### Plan Mode over Slack

When a plan-mode turn finishes and Claude Code shows its "ready to code?"
approval prompt, cctag:

- **attaches the plan** to the thread as a downloadable `.md` file (read
  from `~/.claude/plans/`), on top of the approval buttons, so the full
  plan is readable even where the terminal render is line-wrapped;
- lets you **approve with a button** (proceed / proceed + auto-accept), or
- lets you **reply with changes in the thread** — a plain reply is routed
  into Claude Code's "tell it what to change" path, which refines the plan
  and stays in plan mode, so you can iterate on the plan from Slack before
  any code runs.

### Catching up on thread activity cctag wasn't mentioned in

cctag only ever sees the literal text of messages that mention it — a
review posted by another Slack bot or a teammate elsewhere in the thread is
otherwise invisible to it. `@cctag log` closes that gap: it fetches every
message posted after cctag's own last message in the thread (found by
looking up the thread's actual history, not by guessing from wording),
formats each as `sender: text` (resolving human display names and bot
names), and feeds the result into the paired session as context. With no
instruction, it defaults to "act on whatever the log contains"; with one
(`@cctag log <instruction>`), that instruction is appended instead. If
nothing's been posted since cctag's last message, it says so instead of
starting a no-op turn.

### Work started outside of Slack

cctag only actively watches a paired instance while a Slack-initiated turn
is running. If you start something directly at the terminal — before ever
pairing, or a long task you kicked off locally and paired mid-run — a
background watcher (polling every ~7s) notices once it settles
(working → idle/done) and posts the new output to the paired thread,
prefixed with 🖥️. It never replays old history, so pairing mid-task only
reports what happens *after* pairing.

If that terminal-driven work instead hits an `AskUserQuestion` or
permission prompt, the watcher doesn't just wait for it to resolve on its
own — it hands the terminal off to the same turn machinery a Slack-initiated
message uses, so the prompt gets posted as Slack buttons (and can be
answered from the thread) even though nothing was ever sent via `@cctag`.

Multi-question `AskUserQuestion` prompts are answered one question at a
time — after you answer, cctag reads the next one off the screen.

## Security notes

Anyone who can post in a paired thread can send arbitrary text into a
full-permission local coding agent. Pairing is owner-opt-in per thread, the
owner can disconnect at any time, and tool permission prompts still require
a human's approval via Slack buttons — nothing runs unattended. Only pair
threads in channels with people you trust.

## License

MIT — see `LICENSE`.
