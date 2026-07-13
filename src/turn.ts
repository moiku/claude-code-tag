import type { HerdrClient } from "./herdr/client.js";
import type { Pairing } from "./pairing.js";
import type { MessageHandle, Notifier } from "./notifier.js";
import { extractAssistantText, extractToolUseSummaries, readNewRecords, transcriptPath, transcriptSizeSafe } from "./transcript.js";
import { chunkForSlack, markdownToMrkdwn } from "./slack/mrkdwn.js";
import {
  askUserQuestionAnsweredText,
  askUserQuestionBlocks,
  doneStatusText,
  permissionBlocks,
  permissionParseFailureBlocks,
} from "./slack/blocks.js";
import {
  findPlanFeedbackOption,
  parseAskUserQuestionPane,
  parsePermissionMenu,
  parsePlanFilePath,
  type AskUserQuestionPaneInfo,
} from "./prompts.js";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Expands a leading ~ to the user's home directory. */
function expandHome(p: string): string {
  return p.startsWith("~/") || p === "~" ? p.replace(/^~/, homedir()) : p;
}

export type TurnPhase = "running" | "awaiting-question" | "awaiting-permission";

interface TurnState {
  phase: TurnPhase;
  pairing: Pairing;
  requesterUserId: string;
  paneId: string;
  sessionId: string;
  transcriptPath: string;
  offset: number;
  collected: string[];
  toolCounts: Record<string, number>;
  statusHandle: MessageHandle;
  lastStatusUpdateAt: number;
  startedAt: number;
  abort: AbortController;
  // AskUserQuestion / permission prompts are read off the pane, not the
  // transcript — see prompts.ts for why. Each newly-posted prompt gets a
  // fresh id so stale button clicks (from an already-resolved or
  // already-superseded prompt) can be rejected.
  currentPromptId: number;
  promptHandle?: MessageHandle;
  pendingQuestionInfo?: AskUserQuestionPaneInfo;
  // Set when the current awaiting-permission prompt is Claude Code's
  // ExitPlanMode approval, which uniquely offers a "Tell Claude what to
  // change" free-text option — recorded so a plain thread reply can be
  // routed to it (refine the plan, stay in plan mode) instead of being
  // ignored the way free-text is for ordinary permission menus.
  planFeedbackOptionNum?: number;
}

export interface TurnEngineOptions {
  turnTimeoutMs: number;
  pollIntervalMs: number;
}

export type AnswerResult = { ok: true } | { ok: false; reason: "not-pending" };

/** Transcript-tracking state BackgroundWatcher had already collected for a
 * pairing before it noticed the terminal was blocked — handed over so
 * adoptBlockedTerminal() doesn't lose or re-read anything. */
export interface BlockedTerminalHandoff {
  sessionId: string;
  transcriptPath: string;
  offset: number;
  collected: string[];
  paneId: string;
}

export class TurnEngine {
  private turns = new Map<string, TurnState>();
  // Terminals busy for a reason other than an active turn (e.g. commands.ts
  // running a /model or /plan TUI command) — kept separate from `turns` so
  // isBusy() covers both, and the BackgroundWatcher doesn't try to watch the
  // same instance a non-turn command is currently driving.
  private externallyBusy = new Set<string>();
  // Terminals in the middle of startTurn()'s async setup, before a TurnState
  // exists in `turns` yet — closes the race where two concurrent calls for
  // the same terminal could both pass the busy check.
  private reserving = new Set<string>();

  constructor(
    private readonly herdr: HerdrClient,
    private readonly notifier: Notifier,
    private readonly opts: TurnEngineOptions,
  ) {}

  isBusy(terminalId: string): boolean {
    return this.turns.has(terminalId) || this.externallyBusy.has(terminalId) || this.reserving.has(terminalId);
  }

  markBusy(terminalId: string): void {
    this.externallyBusy.add(terminalId);
  }

  clearBusy(terminalId: string): void {
    this.externallyBusy.delete(terminalId);
  }

  async abortTurn(terminalId: string): Promise<void> {
    const state = this.turns.get(terminalId);
    if (!state) return;
    state.abort.abort();
    this.turns.delete(terminalId);
  }

  async startTurn(pairing: Pairing, requesterUserId: string, text: string): Promise<void> {
    const terminalId = pairing.terminalId;
    // Reserve the slot synchronously, before any `await` — otherwise two
    // concurrent calls for the same terminal (e.g. a duplicate Slack event)
    // can both pass the busy check before either inserts into `turns`,
    // leaving one turn's state silently overwritten and untracked.
    if (this.isBusy(terminalId)) {
      throw new Error("busy");
    }
    this.reserving.add(terminalId);

    try {
      const agent = await this.herdr.agentGet(terminalId);
      if (!agent) {
        throw new Error("agent-not-found");
      }

      const sessionId = agent.sessionId ?? "";
      const tPath = sessionId ? transcriptPath(agent.cwd, sessionId) : "";
      const offset = tPath ? transcriptSizeSafe(tPath) : 0;

      const statusHandle = await this.notifier.postMessage(pairing.channel, pairing.threadTs ?? "", "⚙️ 実行中…");

      const state: TurnState = {
        phase: "running",
        pairing,
        requesterUserId,
        paneId: agent.paneId,
        sessionId,
        transcriptPath: tPath,
        offset,
        collected: [],
        toolCounts: {},
        statusHandle,
        lastStatusUpdateAt: 0,
        startedAt: Date.now(),
        abort: new AbortController(),
        currentPromptId: 0,
      };
      this.turns.set(terminalId, state);

      const normalized = text
        .replace(/<@[^>|]+(\|[^>]+)?>/g, "")
        .replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, "$2 ($1)")
        .replace(/<(https?:\/\/[^>]+)>/g, "$1")
        .trim();

      try {
        await this.herdr.agentSend(terminalId, normalized);
        await sleep(300);
        await this.herdr.paneSendKeys(agent.paneId, "Enter");
      } catch (err) {
        // Input injection failed after the state was already registered —
        // roll it back so the terminal doesn't stay stuck "busy" forever.
        this.turns.delete(terminalId);
        await statusHandle.update("❌ 開始に失敗しました").catch(() => {});
        throw err;
      }

      void this.pollLoop(terminalId).catch((err) => {
        console.error(`[turn ${terminalId}] poll loop crashed:`, err);
        this.turns.delete(terminalId);
      });
    } finally {
      this.reserving.delete(terminalId);
    }
  }

  /**
   * BackgroundWatcher calls this when it notices a paired terminal has gone
   * `blocked` with no active Slack-initiated turn running (i.e. work started
   * directly at the terminal just hit an AskUserQuestion or permission
   * prompt). Registering a TurnState and running the same pollLoop() a
   * normal turn uses means the existing AskUserQuestion/permission button
   * flow — and answering it from Slack — works identically whether the turn
   * was Slack-initiated or discovered mid-flight; no input is sent, since
   * the terminal is already sitting at the prompt.
   */
  async adoptBlockedTerminal(pairing: Pairing, handoff: BlockedTerminalHandoff): Promise<void> {
    const terminalId = pairing.terminalId;
    // Same reservation as startTurn() — a Slack-initiated turn could start
    // for this terminal in the window between the watcher's isBusy() check
    // and this method actually registering a TurnState.
    if (this.isBusy(terminalId)) return;
    this.reserving.add(terminalId);

    try {
      const statusHandle = await this.notifier.postMessage(
        pairing.channel,
        pairing.threadTs ?? "",
        "🖥️ ターミナル側で入力待ちを検出しました…",
      );

      const state: TurnState = {
        phase: "running",
        pairing,
        requesterUserId: pairing.pairedBy,
        paneId: handoff.paneId,
        sessionId: handoff.sessionId,
        transcriptPath: handoff.transcriptPath,
        offset: handoff.offset,
        collected: [...handoff.collected],
        toolCounts: {},
        statusHandle,
        lastStatusUpdateAt: 0,
        startedAt: Date.now(),
        abort: new AbortController(),
        currentPromptId: 0,
      };
      this.turns.set(terminalId, state);

      void this.pollLoop(terminalId).catch((err) => {
        console.error(`[turn ${terminalId}] poll loop crashed:`, err);
        this.turns.delete(terminalId);
      });
    } finally {
      this.reserving.delete(terminalId);
    }
  }

  async answerQuestionButton(terminalId: string, promptId: number, optionIndex: number): Promise<AnswerResult> {
    const state = this.turns.get(terminalId);
    if (!state || state.phase !== "awaiting-question" || state.currentPromptId !== promptId || !state.pendingQuestionInfo) {
      return { ok: false, reason: "not-pending" };
    }
    const info = state.pendingQuestionInfo;
    const label = info.options[optionIndex]?.label ?? String(optionIndex + 1);

    await this.herdr.agentSend(terminalId, String(optionIndex + 1));
    await state.promptHandle?.update(askUserQuestionAnsweredText(info.header, label), []).catch(() => {});
    state.promptHandle = undefined;
    state.pendingQuestionInfo = undefined;
    state.phase = "running";
    return { ok: true };
  }

  async answerQuestionFreeText(terminalId: string, freeText: string): Promise<AnswerResult> {
    const state = this.turns.get(terminalId);
    if (!state || state.phase !== "awaiting-question" || !state.pendingQuestionInfo) {
      return { ok: false, reason: "not-pending" };
    }
    const info = state.pendingQuestionInfo;

    // Navigate down to the "Type something" row (Phase 0: digit-select only
    // works for real options; the free-text row must be reached via arrows
    // and then have its placeholder replaced before Enter).
    const downs = Array(info.options.length).fill("Down");
    if (downs.length) await this.herdr.paneSendKeys(state.paneId, ...downs);
    await this.herdr.agentSend(terminalId, freeText);
    await sleep(200);
    await this.herdr.paneSendKeys(state.paneId, "Enter");

    await state.promptHandle?.update(askUserQuestionAnsweredText(info.header, freeText), []).catch(() => {});
    state.promptHandle = undefined;
    state.pendingQuestionInfo = undefined;
    state.phase = "running";
    return { ok: true };
  }

  async answerPermissionButton(terminalId: string, promptId: number, num: string): Promise<AnswerResult> {
    const state = this.turns.get(terminalId);
    if (!state || state.phase !== "awaiting-permission" || state.currentPromptId !== promptId) {
      return { ok: false, reason: "not-pending" };
    }
    await this.herdr.agentSend(terminalId, num);
    await state.promptHandle?.update(`→ ${num} を送信しました`, []).catch(() => {});
    state.promptHandle = undefined;
    state.planFeedbackOptionNum = undefined;
    state.phase = "running";
    return { ok: true };
  }

  /**
   * Free-text reply to an ExitPlanMode approval prompt: routes the text into
   * Claude Code's "Tell Claude what to change" option (verified mechanics:
   * send the option's digit to move the cursor there, type the feedback —
   * which replaces the option's placeholder label inline — then Enter, which
   * refines the plan and stays in plan mode). Only valid while the current
   * awaiting-permission prompt actually offered that option.
   */
  async answerPlanFeedback(terminalId: string, freeText: string): Promise<AnswerResult> {
    const state = this.turns.get(terminalId);
    if (!state || state.phase !== "awaiting-permission" || state.planFeedbackOptionNum === undefined) {
      return { ok: false, reason: "not-pending" };
    }
    await this.herdr.agentSend(terminalId, String(state.planFeedbackOptionNum));
    await sleep(200);
    await this.herdr.agentSend(terminalId, freeText);
    await sleep(200);
    await this.herdr.paneSendKeys(state.paneId, "Enter");

    await state.promptHandle?.update(`→ 修正を依頼しました: ${freeText}`, []).catch(() => {});
    state.promptHandle = undefined;
    state.planFeedbackOptionNum = undefined;
    state.phase = "running";
    return { ok: true };
  }

  private async pollLoop(terminalId: string): Promise<void> {
    const state = this.turns.get(terminalId);
    if (!state) return;

    while (!state.abort.signal.aborted) {
      const interval = state.phase === "running" ? this.opts.pollIntervalMs : Math.max(this.opts.pollIntervalMs, 5_000);
      await sleep(interval);
      // Re-check: this loop's turn may have been aborted (and a new one
      // started for the same terminal) while we were asleep. finalize()
      // looks up state by terminalId, not by this closure's object identity,
      // so a stale loop reaching it after abort could delete/finalize a
      // different, newly-started turn.
      if (state.abort.signal.aborted) return;

      const agent = await this.herdr.agentGet(terminalId).catch(() => null);
      if (!agent) {
        await this.finalize(terminalId, "⚠️ インスタンスが終了しました（部分的な出力のみ）");
        return;
      }

      if (agent.sessionId && agent.sessionId !== state.sessionId) {
        state.sessionId = agent.sessionId;
        state.transcriptPath = transcriptPath(agent.cwd, agent.sessionId);
        state.offset = 0;
      }

      if (state.transcriptPath) {
        const { records, newOffset } = await readNewRecords(state.transcriptPath, state.offset);
        state.offset = newOffset;
        state.collected.push(...extractAssistantText(records));
        for (const name of extractToolUseSummaries(records)) {
          state.toolCounts[name] = (state.toolCounts[name] ?? 0) + 1;
        }
      }

      if (state.phase === "running") {
        const now = Date.now();
        if (now - state.lastStatusUpdateAt > 3_000) {
          state.lastStatusUpdateAt = now;
          const lastTool = Object.keys(state.toolCounts).pop();
          const elapsed = Math.round((now - state.startedAt) / 1000);
          const suffix = lastTool ? ` — 🔧 ${lastTool}` : "";
          await state.statusHandle.update(`⚙️ 実行中… (${elapsed}s)${suffix}`).catch(() => {});
        }
      }

      // Applied before the `blocked` branch's `continue` below — otherwise an
      // unanswered prompt (nobody at the keyboard, nobody clicking the Slack
      // button) would keep the terminal "busy" forever, since blocked never
      // reaches the timeout check further down.
      if (Date.now() - state.startedAt > this.opts.turnTimeoutMs) {
        await this.finalize(terminalId, "⚠️ タイムアウトしました（エージェントはまだ動作中の可能性があります）");
        return;
      }

      if (agent.agentStatus === "blocked") {
        if (state.phase === "running") {
          // A NEW prompt appeared (either the first one this turn, or the
          // next one in a multi-question flow — each is independently
          // parsed off the pane; see prompts.ts).
          const paneText = await this.herdr.paneRead(state.paneId, { source: "recent", lines: 60 });
          const aq = parseAskUserQuestionPane(paneText);
          state.currentPromptId += 1;
          if (aq) {
            state.pendingQuestionInfo = aq;
            state.promptHandle = await this.notifier.postMessage(
              state.pairing.channel,
              state.pairing.threadTs ?? "",
              `❓ ${aq.header}: ${aq.question}`,
              askUserQuestionBlocks(terminalId, state.currentPromptId, aq),
            );
            state.phase = "awaiting-question";
          } else {
            const menu = parsePermissionMenu(paneText);
            // Is this the ExitPlanMode approval (plan mode finished, awaiting
            // go-ahead)? Detect it from the *parsed menu's* choices (the
            // active menu parsePermissionMenu isolated), not the raw pane —
            // otherwise a "Tell Claude what to change" line left in scrollback
            // by an earlier resolved plan prompt could misclassify a later
            // ordinary permission prompt. The plan path is likewise the
            // bottom-most match. If so, attach the plan file and remember the
            // feedback option so a free-text reply can refine the plan.
            const feedbackNum = findPlanFeedbackOption(paneText);
            const isPlanPrompt = feedbackNum !== null;
            state.planFeedbackOptionNum = feedbackNum ?? undefined;

            if (isPlanPrompt && this.notifier.uploadTextFile) {
              await this.attachPlanFile(state, paneText).catch((err) =>
                console.error(`[turn ${terminalId}] plan file attach failed:`, err),
              );
            }

            // Drop the "Tell Claude what to change" option from the buttons:
            // its digit only moves the cursor, it doesn't confirm (it expects
            // typed feedback next), so a button for it would be a dead end.
            // That path is handled by a free-text thread reply instead
            // (answerPlanFeedback), which the header points the user to.
            const buttonMenu =
              menu && feedbackNum !== null
                ? { ...menu, choices: menu.choices.filter((c) => c.num !== String(feedbackNum)) }
                : menu;

            const header = isPlanPrompt
              ? "📋 プランが提示されました。ボタンで承認するか、修正内容をこのスレッドに返信してください。"
              : "⚠️ 許可リクエスト";
            state.promptHandle = await this.notifier.postMessage(
              state.pairing.channel,
              state.pairing.threadTs ?? "",
              header,
              buttonMenu
                ? permissionBlocks(terminalId, state.currentPromptId, buttonMenu, isPlanPrompt ? header : undefined)
                : permissionParseFailureBlocks(terminalId, state.currentPromptId, paneText),
            );
            state.phase = "awaiting-permission";
          }
        }
        // else: already showing a prompt for this blocked state — keep waiting.
        continue;
      }

      if (state.phase !== "running") {
        // Was awaiting an answer, and the terminal is no longer blocked —
        // resolved, either by our own button/free-text (which already
        // cleared promptHandle) or directly at the terminal keyboard.
        if (state.promptHandle) {
          await state.promptHandle.update("（ターミナル側で回答済み）", []).catch(() => {});
          state.promptHandle = undefined;
        }
        state.pendingQuestionInfo = undefined;
        state.planFeedbackOptionNum = undefined;
        state.phase = "running";
      }

      if (agent.agentStatus === "idle" || agent.agentStatus === "done") {
        await this.finalize(terminalId);
        return;
      }
    }
  }

  private async finalize(terminalId: string, warning?: string): Promise<void> {
    const state = this.turns.get(terminalId);
    if (!state) return;
    this.turns.delete(terminalId);

    const elapsed = Math.round((Date.now() - state.startedAt) / 1000);
    const text = state.collected.join("\n\n").trim();

    if (text) {
      const mrkdwn = markdownToMrkdwn(text);
      for (const chunk of chunkForSlack(mrkdwn)) {
        await this.notifier.postReply(state.pairing.channel, state.pairing.threadTs ?? "", chunk);
      }
    }
    if (warning) {
      await this.notifier.postReply(state.pairing.channel, state.pairing.threadTs ?? "", warning);
    }
    const label = text ? doneStatusText(elapsed, state.toolCounts) : `✅ 完了 (${elapsed}s)（テキスト応答なし）`;
    await state.statusHandle.update(label).catch(() => {});
  }

  /**
   * Reads the plan markdown Claude Code wrote to ~/.claude/plans/<slug>.md
   * and uploads it to the thread, so the full plan is available as a
   * downloadable file rather than only rendered (line-wrapped) in the pane.
   *
   * The path shown in the pane footer gets truncated when the pane is narrow
   * (the .md suffix can be cut off), so the pane-parsed path is only a
   * preferred hint: if it doesn't parse to an existing file, fall back to the
   * most-recently-modified plan file, which Claude Code writes immediately
   * before showing the approval prompt.
   */
  private async attachPlanFile(state: TurnState, paneText: string): Promise<void> {
    if (!this.notifier.uploadTextFile) return;
    const abs = this.resolvePlanFile(paneText);
    if (!abs) return;
    const content = readFileSync(abs, "utf8");
    if (!content.trim()) return;
    await this.notifier.uploadTextFile(state.pairing.channel, state.pairing.threadTs ?? "", {
      content,
      filename: basename(abs),
      title: "Claude Code のプラン",
      comment: "📋 プラン全文（.md）",
    });
  }

  private resolvePlanFile(paneText: string): string | null {
    const hinted = parsePlanFilePath(paneText);
    if (hinted) {
      const abs = expandHome(hinted);
      if (existsSync(abs)) return abs;
    }
    // Fallback: newest *.md in ~/.claude/plans/.
    const dir = join(homedir(), ".claude", "plans");
    try {
      let newest: { path: string; mtime: number } | null = null;
      for (const name of readdirSync(dir)) {
        if (!name.endsWith(".md")) continue;
        const p = join(dir, name);
        const mtime = statSync(p).mtimeMs;
        if (!newest || mtime > newest.mtime) newest = { path: p, mtime };
      }
      return newest?.path ?? null;
    } catch {
      return null;
    }
  }
}
