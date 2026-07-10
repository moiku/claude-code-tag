import type { HerdrClient } from "./herdr/client.js";
import { PairingStore } from "./pairing.js";
import type { TurnEngine } from "./turn.js";
import type { Notifier } from "./notifier.js";
import { agentPickerBlocks } from "./slack/blocks.js";
import { parsePermissionMenu } from "./prompts.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const HELP_TEXT = [
  "*cctag の使い方*",
  "• `@cctag connect` — このスレッドを Claude Code インスタンスに接続（オーナーのみ）",
  "• `@cctag disconnect` — 接続を解除（オーナーのみ）",
  "• `@cctag status` — 接続状態を表示",
  "• `@cctag list` — 稼働中のインスタンス一覧",
  "• `@cctag model <name>` — Claude Code のモデルを切り替え（例: `model opus`）",
  "• `@cctag plan` — Plan Mode を有効化",
  "• `@cctag log [指示]` — cctagの最終発言以降のスレッド履歴を読み込んで対応（例: `log`, `log 上記を直してpushして`）",
  "• `@cctag <メッセージ>` — 接続済みインスタンスにメッセージを送信",
].join("\n");

const MODEL_COMMAND_RE = /^model\s+(\S+)$/i;
const LOG_COMMAND_RE = /^log(?:\s+([\s\S]+))?$/i;

/**
 * The TUI always ends with a fixed ~7-line footer (a separator, an empty
 * prompt, another separator, then model/context/cwd/mode status lines) plus
 * a variable amount of blank padding above it. A small `--lines N` read off
 * the bottom lands entirely inside that footer, missing the actual command
 * output higher up — so read a larger chunk and strip the footer/padding
 * off the end instead of trusting a short tail read.
 */
function stripFooterChrome(raw: string): string {
  const lines = raw.split("\n");
  // The model/context status line ("Sonnet 5 │ ctx ▒▒▒ ... /rc") is a
  // distinctive marker for the start of the fixed ~4-line footer (it's
  // always followed by a usage-window line, the cwd basename, and a mode
  // line — none of which are reliably pattern-matchable on their own, e.g.
  // the cwd line is arbitrary text). Find its last occurrence and cut
  // everything from there to the end in one shot, then also drop the
  // separator/empty-prompt/separator directly above it and any blank
  // padding above that.
  let end = lines.length;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/ctx\s.*\/rc/.test(lines[i])) {
      end = i;
      break;
    }
  }
  while (end > 0 && (/^[─\s]*$/.test(lines[end - 1]) || /^❯\s*$/.test(lines[end - 1].trim()))) end--;
  while (end > 0 && !lines[end - 1].trim()) end--;
  return lines.slice(0, end).join("\n").trim();
}

export interface MentionContext {
  channel: string;
  threadTs: string;
  userId: string;
  /** Already mention-stripped and composer-attribution-stripped. */
  text: string;
  /** This message's own Slack ts — used by `log` to exclude itself from fetched thread history. */
  ts: string;
}

export interface PairSelectContext {
  channel: string;
  threadTs: string;
  userId: string;
  terminalId: string;
}

export interface AskUserQuestionButtonContext {
  channel: string;
  threadTs: string;
  terminalId: string;
  promptId: number;
  optionIndex: number;
}

export interface PermissionButtonContext {
  channel: string;
  threadTs: string;
  terminalId: string;
  promptId: number;
  num: string;
}

export interface FreeTextContext {
  channel: string;
  threadTs: string;
  /** Already composer-attribution-stripped; mentions already excluded by the caller. */
  text: string;
}

/**
 * All the Slack-SDK-agnostic business logic behind `@cctag` commands and
 * button clicks. Used directly in standalone mode (slack/app.ts) and, in
 * Hub–Spoke mode, on the Spoke side (driven by events forwarded from the Hub
 * over a WebSocket instead of Bolt).
 */
export class CommandHandler {
  constructor(
    private readonly herdr: HerdrClient,
    private readonly pairingStore: PairingStore,
    private readonly turnEngine: TurnEngine,
    private readonly notifier: Notifier,
    private readonly ownerUserId: string,
  ) {}

  isOwner(userId: string): boolean {
    return userId === this.ownerUserId;
  }

  async handleMention(ctx: MentionContext): Promise<void> {
    const { channel, threadTs, userId, text, ts } = ctx;
    // Only single-word commands are recognized; anything else (including any
    // message containing whitespace/newlines) falls through to a turn below
    // using the FULL text, not a split fragment of it.
    const singleWordCmd = /^\S+$/.test(text) ? text.toLowerCase() : undefined;

    const modelMatch = MODEL_COMMAND_RE.exec(text);
    if (modelMatch) {
      const pairing = this.pairingStore.get(channel, threadTs);
      if (!pairing) {
        await this.notifier.postReply(
          channel,
          threadTs,
          "接続されていません。オーナーがこのスレッドで「@cctag connect」を実行し、Claude Code インスタンスを選択してください。",
        );
        return;
      }
      await this.runTuiCommand(channel, threadTs, pairing.terminalId, `/model ${modelMatch[1]}`);
      return;
    }

    const logMatch = LOG_COMMAND_RE.exec(text);
    if (logMatch) {
      await this.handleLog(channel, threadTs, userId, ts, logMatch[1]?.trim());
      return;
    }

    switch (singleWordCmd) {
      case "plan": {
        const pairing = this.pairingStore.get(channel, threadTs);
        if (!pairing) {
          await this.notifier.postReply(
            channel,
            threadTs,
            "接続されていません。オーナーがこのスレッドで「@cctag connect」を実行し、Claude Code インスタンスを選択してください。",
          );
          return;
        }
        await this.runTuiCommand(channel, threadTs, pairing.terminalId, "/plan");
        return;
      }
      case "connect": {
        if (!this.isOwner(userId)) {
          await this.notifier.postReply(channel, threadTs, "⚠️ `connect` はオーナーのみ実行できます。");
          return;
        }
        const agents = await this.herdr.agentList();
        await this.notifier.postMessage(channel, threadTs, "接続するインスタンスを選択してください", agentPickerBlocks(agents));
        return;
      }
      case "disconnect": {
        if (!this.isOwner(userId)) {
          await this.notifier.postReply(channel, threadTs, "⚠️ `disconnect` はオーナーのみ実行できます。");
          return;
        }
        const pairing = this.pairingStore.get(channel, threadTs);
        if (!pairing) {
          await this.notifier.postReply(channel, threadTs, "このスレッドは接続されていません。");
          return;
        }
        await this.turnEngine.abortTurn(pairing.terminalId);
        this.pairingStore.remove(pairing.key);
        await this.notifier.postReply(channel, threadTs, "🔌 接続を解除しました。");
        return;
      }
      case "status": {
        const pairing = this.pairingStore.get(channel, threadTs);
        if (!pairing) {
          await this.notifier.postReply(channel, threadTs, "このスレッドは接続されていません。");
          return;
        }
        const agent = await this.herdr.agentGet(pairing.terminalId);
        const statusLine = agent
          ? `状態: ${agent.agentStatus} / cwd: ${agent.cwd}`
          : "⚠️ インスタンスが見つかりません（切断されている可能性があります）";
        await this.notifier.postReply(channel, threadTs, `🔗 接続先: ${pairing.cwd}\n${statusLine}`);
        return;
      }
      case "list": {
        const agents = await this.herdr.agentList();
        const pairings = this.pairingStore.list();
        const lines = agents.map((a) => {
          const paired = pairings.find((p) => p.terminalId === a.terminalId);
          const mark = paired ? "🔗" : "・";
          return `${mark} ${a.agentStatus.padEnd(8)} ${a.cwd}`;
        });
        await this.notifier.postReply(
          channel,
          threadTs,
          lines.length ? "```\n" + lines.join("\n") + "\n```" : "稼働中のインスタンスがありません。",
        );
        return;
      }
      case "help":
      case undefined: {
        if (!text || singleWordCmd === "help") {
          await this.notifier.postReply(channel, threadTs, HELP_TEXT);
          return;
        }
        break; // multi-word text with no recognized command -> fall through to turn dispatch
      }
    }

    // Anything else: treat as a turn message.
    const pairing = this.pairingStore.get(channel, threadTs);
    if (!pairing) {
      await this.notifier.postReply(
        channel,
        threadTs,
        "接続されていません。オーナーがこのスレッドで「@cctag connect」を実行し、Claude Code インスタンスを選択してください。",
      );
      return;
    }
    if (this.turnEngine.isBusy(pairing.terminalId)) {
      await this.notifier.postReply(channel, threadTs, "⏳ 現在の応答が完了するまでお待ちください。");
      return;
    }
    try {
      await this.turnEngine.startTurn(pairing, userId, text);
    } catch (err) {
      if (err instanceof Error && err.message === "agent-not-found") {
        this.pairingStore.remove(pairing.key);
        await this.notifier.postReply(channel, threadTs, "⚠️ インスタンスが見つかりません。ペアリングを解除しました。");
        return;
      }
      await this.notifier.postReply(channel, threadTs, `❌ エラー: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Runs a CLI slash command (`/model <name>`, `/plan`, ...) rather than a
   * normal conversational turn. These don't reliably show up in the session
   * transcript the way an LLM reply does, so — unlike startTurn() — this
   * reads the result straight off the pane instead. If a confirmation menu
   * appears (e.g. switching models mid-conversation asks "Switch model?
   * Yes/No"), it's auto-confirmed with the first option, since the user
   * asking for the command already expressed that intent.
   */
  private async runTuiCommand(channel: string, threadTs: string, terminalId: string, command: string): Promise<void> {
    if (this.turnEngine.isBusy(terminalId)) {
      await this.notifier.postReply(channel, threadTs, "⏳ 現在の応答が完了するまでお待ちください。");
      return;
    }
    const agent = await this.herdr.agentGet(terminalId);
    if (!agent) {
      await this.notifier.postReply(channel, threadTs, "⚠️ インスタンスが見つかりません。");
      return;
    }

    this.turnEngine.markBusy(terminalId);
    try {
      await this.herdr.agentSend(terminalId, command);
      await sleep(300);
      await this.herdr.paneSendKeys(agent.paneId, "Enter");

      let settled = false;
      for (let i = 0; i < 10 && !settled; i++) {
        await sleep(600);
        const cur = await this.herdr.agentGet(terminalId);
        if (!cur) break;
        if (cur.agentStatus === "blocked") {
          const paneText = await this.herdr.paneRead(agent.paneId, { source: "recent", lines: 40 });
          const menu = parsePermissionMenu(paneText);
          if (menu && menu.choices.length > 0) {
            await this.herdr.agentSend(terminalId, menu.choices[0].num);
          }
          continue;
        }
        if (cur.agentStatus === "idle" || cur.agentStatus === "done") {
          settled = true;
        }
      }

      const raw = await this.herdr.paneRead(agent.paneId, { source: "recent", lines: 40 });
      const snippet = stripFooterChrome(raw);
      await this.notifier.postReply(channel, threadTs, "```\n" + snippet.slice(-1500) + "\n```");
    } finally {
      this.turnEngine.clearBusy(terminalId);
    }
  }

  /**
   * `@cctag log [instruction]` — catches the paired instance up on thread
   * conversation it wasn't mentioned in (e.g. a review posted by another
   * Slack bot/human), scoped to messages posted after cctag's own last
   * message in this thread. With no instruction, defaults to asking the
   * agent to act on whatever the log contains.
   */
  private async handleLog(channel: string, threadTs: string, userId: string, ts: string, instruction?: string): Promise<void> {
    const pairing = this.pairingStore.get(channel, threadTs);
    if (!pairing) {
      await this.notifier.postReply(
        channel,
        threadTs,
        "接続されていません。オーナーがこのスレッドで「@cctag connect」を実行し、Claude Code インスタンスを選択してください。",
      );
      return;
    }
    if (this.turnEngine.isBusy(pairing.terminalId)) {
      await this.notifier.postReply(channel, threadTs, "⏳ 現在の応答が完了するまでお待ちください。");
      return;
    }
    if (!this.notifier.getThreadHistorySinceLastBotPost) {
      await this.notifier.postReply(channel, threadTs, "⚠️ このモードでは `log` コマンドは使えません。");
      return;
    }

    let lines: string[];
    try {
      lines = await this.notifier.getThreadHistorySinceLastBotPost(channel, threadTs, ts);
    } catch (err) {
      await this.notifier.postReply(channel, threadTs, `❌ 履歴取得エラー: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    if (lines.length === 0) {
      await this.notifier.postReply(channel, threadTs, "cctagの最終発言以降、新しいメッセージはありませんでした。");
      return;
    }

    const combined = [
      "[Slackスレッドの履歴（cctagの最終発言以降）]",
      lines.join("\n"),
      "---",
      instruction || "上記を踏まえて対応してください。",
    ].join("\n");

    try {
      await this.turnEngine.startTurn(pairing, userId, combined);
    } catch (err) {
      if (err instanceof Error && err.message === "agent-not-found") {
        this.pairingStore.remove(pairing.key);
        await this.notifier.postReply(channel, threadTs, "⚠️ インスタンスが見つかりません。ペアリングを解除しました。");
        return;
      }
      await this.notifier.postReply(channel, threadTs, `❌ エラー: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async handlePairSelect(ctx: PairSelectContext): Promise<void> {
    const { channel, threadTs, userId, terminalId } = ctx;
    if (!this.isOwner(userId)) {
      await this.notifier.postReply(channel, threadTs, "⚠️ オーナーのみ接続できます。");
      return;
    }

    const agent = await this.herdr.agentGet(terminalId);
    if (!agent) {
      await this.notifier.postReply(channel, threadTs, "⚠️ インスタンスが見つかりません。");
      return;
    }

    const existing = this.pairingStore.byTerminal(terminalId);
    if (existing) {
      // The old pairing might be a zombie: its terminalId can still exist
      // in herdr (e.g. Claude Code was exited and a new session started in
      // the same pane) even though the conversation it was paired to is
      // long gone. Only block on a *live* conflict with someone else's
      // pairing — a stale entry, or the same owner re-picking a terminal
      // they already had paired, gets moved automatically instead.
      if (existing.pairedBy === userId) {
        this.pairingStore.remove(existing.key);
        if (existing.key !== PairingStore.threadKey(channel, threadTs)) {
          await this.notifier.postReply(
            existing.channel,
            existing.threadTs ?? "",
            "🔌 このインスタンスは別のスレッドに接続し直されました。",
          );
        }
      } else {
        const link = await this.notifier.getPermalink?.(existing.channel, existing.threadTs ?? "").catch(() => null);
        await this.notifier.postReply(
          channel,
          threadTs,
          `⚠️ このインスタンスは既に他のスレッドに接続されています${link ? `: ${link}` : ""}`,
        );
        return;
      }
    }

    this.pairingStore.add({
      key: PairingStore.threadKey(channel, threadTs),
      channel,
      threadTs,
      terminalId,
      cwd: agent.cwd,
      pairedBy: userId,
      pairedAt: new Date().toISOString(),
    });

    await this.notifier.postReply(channel, threadTs, `✅ 接続しました: ${agent.cwd}`);
  }

  async handleAskUserQuestionButton(ctx: AskUserQuestionButtonContext): Promise<void> {
    const result = await this.turnEngine.answerQuestionButton(ctx.terminalId, ctx.promptId, ctx.optionIndex);
    if (!result.ok) {
      await this.notifier.postReply(ctx.channel, ctx.threadTs, "⚠️ この質問は既に回答済みです。");
    }
  }

  async handlePermissionButton(ctx: PermissionButtonContext): Promise<void> {
    const result = await this.turnEngine.answerPermissionButton(ctx.terminalId, ctx.promptId, ctx.num);
    if (!result.ok) {
      await this.notifier.postReply(ctx.channel, ctx.threadTs, "⚠️ このリクエストは既に処理済みです。");
    }
  }

  /** Free-text answer to a pending AskUserQuestion (no mention needed). Silently a no-op if nothing is pending. */
  async handleFreeTextMessage(ctx: FreeTextContext): Promise<void> {
    const pairing = this.pairingStore.get(ctx.channel, ctx.threadTs);
    if (!pairing) return;
    await this.turnEngine.answerQuestionFreeText(pairing.terminalId, ctx.text);
  }
}

export function stripMention(text: string): string {
  return text.replace(/<@[^>]+>/g, "").trim();
}

/**
 * Some Slack clients (observed: an AI-assisted composer used in one
 * workspace) append a trailing "*Sent using X* <@bot>"-style attribution to
 * every message. It's a single trailing "*bold text* <@mention>" run — not
 * necessarily on its own line — so match that specific shape at the very end
 * of the raw text (before mention-stripping) rather than assuming a newline.
 */
export function stripComposerAttribution(rawText: string): string {
  return rawText.replace(/\s*\*[^*\n]+\*\s*<@[^>]+>\s*$/, "").trimEnd();
}
