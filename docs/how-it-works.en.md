🌐 [日本語](how-it-works.md) | **English**

---

This document explains how cctag works internally (for setup steps, see the [README](../README.md)).

# How cctag works

## 1. What this tool does

**cctag bridges a Slack thread to a Claude Code terminal session running on
your own machine.**

Anthropic's official "Claude Tag" (`@Claude` in Slack) runs Claude Code in a
sandbox Anthropic hosts in the cloud. It can't reach your local files or
network (lab servers, GPUs, mlx-proxy, etc.) directly.

cctag does the opposite: it remote-controls **a Claude Code instance you
are actually running on your own PC right now**. Start `claude` in your
terminal, and you can talk to that exact session from Slack — send it
instructions and get its replies back.

```
Slack thread (@cctag)
        ↕
   cctag (Hub / Spoke)
        ↕
      herdr
        ↕
   Claude Code (on your PC)
```

## 2. Overall shape: Hub and Spoke

So that multiple people can share a single `@cctag`, cctag splits into two
roles.

| | Role | Runs on | Can do |
|---|---|---|---|
| **Hub** | The one connection to Slack | The lab's OCI server (`cctag.example.com`) | Receives Slack messages and forwards them to the right person's Spoke. **Never touches Claude Code or herdr itself** |
| **Spoke** | The thing that actually drives Claude Code | **Your own PC** | Sends keystrokes into your local Claude Code via herdr, reads its output, and relays it back to Slack through the Hub |

The important part: **the Hub has no way to reach your terminal.** Even if
the lab server were compromised, it has no ability to control the Claude
Code running on your machine — only the Spoke running on your own PC can
actually do that. So anyone who wants to control their own PC's Claude Code
from Slack needs to have **their own Spoke running on their own PC**.

## 3. How this relates to herdr: why only "running agents" show up

cctag doesn't drive the terminal directly — it goes through
[herdr](https://herdr.dev). There are two layers to how that scopes things
down.

### herdr itself can write to any pane

herdr is fundamentally a tmux-like terminal multiplexer. Commands like
`pane read` (read the screen) and `pane send-keys` (send keystrokes) work
on **any pane herdr manages**, whether Claude Code is running in it or it's
just a plain shell. The in-house bridge that used raw tmux before herdr
(cc-slack-bridge v4) used exactly this raw power — it could send anything
to a hardcoded pane number, for better or worse.

### Only self-reported panes show up in the "agent list"

On the other hand, what shows up in `herdr agent list` (the command cctag
uses to build the `@cctag connect` picker) is **only panes where Claude
Code itself has told herdr "I'm running here."** Claude Code has a
`SessionStart` hook that fires on startup and reports to herdr's socket:
"session ID xxx is running in this pane." Only once that report arrives
does the pane get listed as an "agent."

Checked live on the Mac Studio: of the 16 panes herdr was managing, only 6
had Claude Code running and self-reporting. The other 10 (plain shells,
etc.) show up in `herdr pane list` but never in `herdr agent list`.

### What actually makes cctag safe is choosing not to use that raw power

herdr is just as capable as tmux underneath, but **cctag's code imposes its
own rule: only ever operate on a `terminalId` that came from `herdr agent
list`/`agent get`.** There's no Slack command that lets you target a raw
`pane_id` directly.

Put together:

- **herdr's self-reported registry** narrows down what's even a *candidate*
  (only panes running Claude Code)
- **cctag's implementation choice** narrows down what it will actually
  *operate on* (only things discovered via the agent list)

Both together are what produce the safe behavior of "only touches running
Claude Code agents, can't freely drive an arbitrary terminal." herdr the
tool doesn't forbid this on its own — it's a restriction that comes from
how cctag chooses to use it.

## 4. From `@cctag connect` to an actual conversation

1. **`@cctag connect`** (owner only) → posts a Slack button menu built from
   whatever `herdr agent list` finds
2. Pick one → that thread (channel + thread_ts) and the chosen terminalId
   are recorded as a "pairing" (one thread per terminal at a time)
3. In a paired thread, sending **`@cctag <message>`**:
   - Injects the text via herdr's `agent send`, then an Enter via
     `pane send-keys`
   - Polls `agent get` every 1.5s for status (working/blocked/idle/done)
   - Meanwhile reads the Claude Code session's transcript
     (`~/.claude/projects/.../*.jsonl`) incrementally, collecting the
     assistant's reply text
   - Once the turn finishes (idle/done), posts the collected text back to
     Slack as one message

## 5. How multiple-choice prompts (AskUserQuestion, permission menus) work

This is where a real gotcha turned up during development.

**Claude Code does not write an `AskUserQuestion` (multiple-choice
question) to its transcript until after it's answered.** The question and
its answer land together, as a single record, the moment it's answered.
While the question is still on screen, the transcript shows nothing about
it at all.

So detecting a pending question or a pending permission prompt (e.g. "Do
you want to run this tool?") can't use the transcript — it has to **read
the screen itself via `herdr pane read`** and parse the menu with a regex.
A line that reads `N. Type something.` means it's an AskUserQuestion menu;
its absence means it's a permission menu.

There are two ways to answer:

- **Click a button** → sends the matching digit key straight through herdr
  (confirmed on real hardware: a single digit both selects *and* confirms
  — no Enter needed)
- **Reply in the thread with free text** → moves the on-screen cursor down
  to the "Type something" row with the Down arrow key, types the text, and
  presses Enter

## 5.5 Work started without going through Slack

Everything in section 4 ("From `@cctag connect` to an actual conversation")
happens inside a **turn** — cctag only reads the transcript or watches
status while that turn is running.

So what happens if you start a conversation directly at the terminal
(Claude Code app), never touching Slack at all? **Nothing gets posted.**
There's no turn, so there's nothing watching.

That's awkward for a common workflow — start a long task at the terminal,
pair cctag partway through — so `src/watcher.ts`'s **background watcher**
covers this separately. It polls every paired instance with no active turn
roughly every 7 seconds; when one transitions from working/blocked to
idle/done, it posts the newly-produced text to the paired thread, prefixed
with 🖥️.

To avoid replaying old history, the very first time it sees a pairing
(right after pairing, right after an active turn just finished, or after a
session rotation) it just records the transcript's current end as a
baseline — it only ever reports what happens after that point.

## 5.6 Switching model or mode

`@cctag model <name>` (e.g. `model opus`) and `@cctag plan` are handled by a
separate path from a normal conversational turn. They just forward Claude
Code's own slash commands (`/model <name>`, `/plan`) as-is, and aren't
treated as a `TurnEngine` turn (their output doesn't reliably land in the
session transcript the way an LLM reply does).

Instead, `commands.ts`'s `runTuiCommand()`:

1. Sends the slash command via herdr, then confirms it with Enter
2. Polls status; if it goes `blocked` (e.g. the "Switch model? Yes/No"
   confirmation that appears when switching models mid-conversation), the
   existing permission-menu parser (`parsePermissionMenu`) auto-confirms the
   first option — asking for the switch already expressed that intent
3. Once it settles (`idle`/`done`), reads the screen and relays the
   command's own output back to Slack as-is

Step 3's pane read has a gotcha: the TUI's screen always ends with a fixed
footer (a separator, an empty prompt, another separator, then
model/context/cwd/mode status lines). Reading only the last few lines lands
entirely inside that footer, missing the actual command output above it. So
cctag reads a larger chunk and cuts everything from the model/context
status line downward (a distinctive `ctx ... /rc` pattern), then trims the
separator/padding right above that (`stripFooterChrome()`).

`TurnEngine` has a separate `externallyBusy` set alongside its normal turn
tracking, so these TUI commands are treated as "busy" the same way an
active turn is — this keeps the background watcher (section 5.5) from
trying to watch the same instance a TUI command is currently driving.

## 5.7 Catching up on messages cctag wasn't mentioned in

cctag normally only ever sees the literal text of a message that mentions
it. A review posted by another Slack bot (like `@Claude`) or a teammate
elsewhere in the same thread is otherwise invisible to it unless someone
manually copies it into an `@cctag` message.

`@cctag log [instruction]` closes that gap. Rather than guessing intent
from wording, it looks up the thread's actual history via Slack's
`conversations.replies` API, mechanically finds **cctag's own last
message** in that thread, and takes everything posted after it. Each
message is formatted as `sender: text` (human display names resolved via
`users.info`, bot names via `bot_profile.name`/`username`), then fed into
the paired session as one turn — reusing `startTurn()` unchanged, so any
permission prompt or AskUserQuestion that comes up mid-turn is handled by
the same existing machinery. With no instruction, it defaults to "act on
whatever the log contains"; with one, that instruction is appended
instead. If nothing's been posted since cctag's last message, it says so
rather than starting a no-op turn.

`Notifier` gains an optional `getThreadHistorySinceLastBotPost?`, mirroring
`getPermalink?`'s design: `SlackNotifier` implements it directly for
standalone mode, while Hub–Spoke mode proxies it through a `get_thread_history`
RPC call the Hub executes (since the Hub is the side holding the real Slack
client there). The actual formatting logic
(`formatThreadHistorySinceLastBotPost`) lives once in `slack/notifier.ts`
and is shared by both paths.

## 6. Connecting one PC to more than one Slack workspace

A Hub is tied to exactly one workspace (by its Slack app token). To reach a
second workspace, you run a second Hub (it can live on the same server)
and a second Spoke on your own PC.

In that case, **both Spokes are looking at the same herdr daemon**, so a
terminal paired in one workspace also shows up in the other workspace's
`connect` picker. Avoid pairing the same terminal from both at once — the
keystrokes would collide.

## 7. Security notes

- Anyone who can post in a paired thread can send text into a
  full-permission local agent. Only pair threads in channels with people
  you trust
- Permission prompts (e.g. confirming a dangerous command) still require a
  human's approval via Slack buttons — nothing runs unattended
- Anyone holding a Hub token (from `token issue`) can register as any Slack
  user, so only hand tokens to people you trust

## See also

- Source: https://github.com/moiku/claude-code-tag
- herdr: https://herdr.dev
