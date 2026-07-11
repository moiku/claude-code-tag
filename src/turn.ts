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
import { parseAskUserQuestionPane, parsePermissionMenu, type AskUserQuestionPaneInfo } from "./prompts.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

  constructor(
    private readonly herdr: HerdrClient,
    private readonly notifier: Notifier,
    private readonly opts: TurnEngineOptions,
  ) {}

  isBusy(terminalId: string): boolean {
    return this.turns.has(terminalId) || this.externallyBusy.has(terminalId);
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
    if (this.turns.has(terminalId)) {
      throw new Error("busy");
    }

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

    await this.herdr.agentSend(terminalId, normalized);
    await sleep(300);
    await this.herdr.paneSendKeys(agent.paneId, "Enter");

    void this.pollLoop(terminalId).catch((err) => {
      console.error(`[turn ${terminalId}] poll loop crashed:`, err);
      this.turns.delete(terminalId);
    });
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
    if (this.turns.has(terminalId)) return;

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
    state.phase = "running";
    return { ok: true };
  }

  private async pollLoop(terminalId: string): Promise<void> {
    const state = this.turns.get(terminalId);
    if (!state) return;

    while (!state.abort.signal.aborted) {
      const interval = state.phase === "running" ? this.opts.pollIntervalMs : Math.max(this.opts.pollIntervalMs, 5_000);
      await sleep(interval);

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
            state.promptHandle = await this.notifier.postMessage(
              state.pairing.channel,
              state.pairing.threadTs ?? "",
              "⚠️ 許可リクエスト",
              menu
                ? permissionBlocks(terminalId, state.currentPromptId, menu)
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
        state.phase = "running";
      }

      if (agent.agentStatus === "idle" || agent.agentStatus === "done") {
        await this.finalize(terminalId);
        return;
      }

      if (Date.now() - state.startedAt > this.opts.turnTimeoutMs) {
        await this.finalize(terminalId, "⚠️ タイムアウトしました（エージェントはまだ動作中の可能性があります）");
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
}
