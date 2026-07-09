import Bolt from "@slack/bolt";
import type { Config } from "../config.js";
import { HerdrClient } from "../herdr/client.js";
import { PairingStore } from "../pairing.js";
import { TurnEngine } from "../turn.js";
import { agentPickerBlocks } from "./blocks.js";
import { SlackNotifier } from "./notifier.js";

const { App } = Bolt;

const HELP_TEXT = [
  "*cctag の使い方*",
  "• `@cctag connect` — このスレッドを Claude Code インスタンスに接続（オーナーのみ）",
  "• `@cctag disconnect` — 接続を解除（オーナーのみ）",
  "• `@cctag status` — 接続状態を表示",
  "• `@cctag list` — 稼働中のインスタンス一覧",
  "• `@cctag <メッセージ>` — 接続済みインスタンスにメッセージを送信",
].join("\n");

function stripMention(text: string): string {
  return text.replace(/<@[^>]+>/g, "").trim();
}

/**
 * Some Slack clients (observed: an AI-assisted composer used in this
 * workspace) append a trailing "*Sent using X* <@bot>"-style attribution to
 * every message. It's a single trailing "*bold text* <@mention>" run — not
 * necessarily on its own line — so match that specific shape at the very end
 * of the raw text (before mention-stripping) rather than assuming a newline.
 */
function stripComposerAttribution(rawText: string): string {
  return rawText.replace(/\s*\*[^*\n]+\*\s*<@[^>]+>\s*$/, "").trimEnd();
}

function threadTsOf(event: { thread_ts?: string; ts: string }): string {
  return event.thread_ts ?? event.ts;
}

export function buildApp(config: Config) {
  const herdr = new HerdrClient(config.herdrBin);
  const pairingStore = new PairingStore();

  const app = new App({
    token: config.slackBotToken,
    appToken: config.slackAppToken,
    socketMode: true,
  });

  const notifier = new SlackNotifier(app.client);
  const turnEngine = new TurnEngine(herdr, notifier, {
    turnTimeoutMs: config.turnTimeoutMs,
    pollIntervalMs: config.pollIntervalMs,
  });

  function isOwner(userId: string): boolean {
    return userId === config.ownerUserId;
  }

  app.event("app_mention", async ({ event, client }) => {
    if ("bot_id" in event && event.bot_id) return;
    const channel = event.channel;
    const threadTs = threadTsOf(event);
    const userId = event.user ?? "";
    const text = stripMention(stripComposerAttribution(event.text ?? ""));
    // Only single-word commands are recognized; anything else (including any
    // message containing whitespace/newlines) falls through to a turn below
    // using the FULL text, not a split fragment of it.
    const singleWordCmd = /^\S+$/.test(text) ? text.toLowerCase() : undefined;

    switch (singleWordCmd) {
      case "connect": {
        if (!isOwner(userId)) {
          await client.chat.postMessage({
            channel,
            thread_ts: threadTs,
            text: "⚠️ `connect` はオーナーのみ実行できます。",
          });
          return;
        }
        const agents = await herdr.agentList();
        await client.chat.postMessage({
          channel,
          thread_ts: threadTs,
          text: "接続するインスタンスを選択してください",
          blocks: agentPickerBlocks(agents),
        });
        return;
      }
      case "disconnect": {
        if (!isOwner(userId)) {
          await client.chat.postMessage({
            channel,
            thread_ts: threadTs,
            text: "⚠️ `disconnect` はオーナーのみ実行できます。",
          });
          return;
        }
        const pairing = pairingStore.get(channel, threadTs);
        if (!pairing) {
          await client.chat.postMessage({ channel, thread_ts: threadTs, text: "このスレッドは接続されていません。" });
          return;
        }
        await turnEngine.abortTurn(pairing.terminalId);
        pairingStore.remove(pairing.key);
        await client.chat.postMessage({ channel, thread_ts: threadTs, text: "🔌 接続を解除しました。" });
        return;
      }
      case "status": {
        const pairing = pairingStore.get(channel, threadTs);
        if (!pairing) {
          await client.chat.postMessage({ channel, thread_ts: threadTs, text: "このスレッドは接続されていません。" });
          return;
        }
        const agent = await herdr.agentGet(pairing.terminalId);
        const statusLine = agent
          ? `状態: ${agent.agentStatus} / cwd: ${agent.cwd}`
          : "⚠️ インスタンスが見つかりません（切断されている可能性があります）";
        await client.chat.postMessage({
          channel,
          thread_ts: threadTs,
          text: `🔗 接続先: ${pairing.cwd}\n${statusLine}`,
        });
        return;
      }
      case "list": {
        const agents = await herdr.agentList();
        const pairings = pairingStore.list();
        const lines = agents.map((a) => {
          const paired = pairings.find((p) => p.terminalId === a.terminalId);
          const mark = paired ? "🔗" : "・";
          return `${mark} ${a.agentStatus.padEnd(8)} ${a.cwd}`;
        });
        await client.chat.postMessage({
          channel,
          thread_ts: threadTs,
          text: lines.length ? "```\n" + lines.join("\n") + "\n```" : "稼働中のインスタンスがありません。",
        });
        return;
      }
      case "help":
      case undefined: {
        if (!text || singleWordCmd === "help") {
          await client.chat.postMessage({ channel, thread_ts: threadTs, text: HELP_TEXT });
          return;
        }
        break; // multi-word text with no recognized command -> fall through to turn dispatch
      }
    }

    // Anything else: treat as a turn message.
    const pairing = pairingStore.get(channel, threadTs);
    if (!pairing) {
      await client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text: "接続されていません。オーナーがこのスレッドで「@cctag connect」を実行し、Claude Code インスタンスを選択してください。",
      });
      return;
    }
    if (turnEngine.isBusy(pairing.terminalId)) {
      await client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text: "⏳ 現在の応答が完了するまでお待ちください。",
      });
      return;
    }
    try {
      await turnEngine.startTurn(pairing, userId, text);
    } catch (err) {
      if (err instanceof Error && err.message === "agent-not-found") {
        pairingStore.remove(pairing.key);
        await client.chat.postMessage({
          channel,
          thread_ts: threadTs,
          text: "⚠️ インスタンスが見つかりません。ペアリングを解除しました。",
        });
        return;
      }
      await client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text: `❌ エラー: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  });

  app.action("pair_select", async ({ ack, body, client }) => {
    await ack();
    const actionBody = body as unknown as {
      user: { id: string };
      channel?: { id: string };
      message?: { ts: string; thread_ts?: string };
      actions: Array<{ selected_option?: { value: string } }>;
    };
    const channel = actionBody.channel?.id;
    const threadTs = actionBody.message?.thread_ts ?? actionBody.message?.ts;
    const terminalId = actionBody.actions[0]?.selected_option?.value;
    if (!channel || !threadTs || !terminalId) return;

    if (!isOwner(actionBody.user.id)) {
      await client.chat.postMessage({ channel, thread_ts: threadTs, text: "⚠️ オーナーのみ接続できます。" });
      return;
    }

    const existing = pairingStore.byTerminal(terminalId);
    if (existing) {
      const link = await client.chat
        .getPermalink({ channel: existing.channel, message_ts: existing.threadTs ?? "" })
        .catch(() => null);
      await client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text: `⚠️ このインスタンスは既に他のスレッドに接続されています${link?.permalink ? `: ${link.permalink}` : ""}`,
      });
      return;
    }

    const agent = await herdr.agentGet(terminalId);
    if (!agent) {
      await client.chat.postMessage({ channel, thread_ts: threadTs, text: "⚠️ インスタンスが見つかりません。" });
      return;
    }

    pairingStore.add({
      key: PairingStore.threadKey(channel, threadTs),
      channel,
      threadTs,
      terminalId,
      cwd: agent.cwd,
      pairedBy: actionBody.user.id,
      pairedAt: new Date().toISOString(),
    });

    await client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: `✅ 接続しました: ${agent.cwd}`,
    });
  });

  app.action(/^aq_answer_/, async ({ ack, body, client }) => {
    await ack();
    const actionBody = body as unknown as {
      channel?: { id: string };
      message?: { ts: string; thread_ts?: string };
      actions: Array<{ value?: string }>;
    };
    const channel = actionBody.channel?.id;
    const threadTs = actionBody.message?.thread_ts ?? actionBody.message?.ts;
    const raw = actionBody.actions[0]?.value;
    if (!channel || !threadTs || !raw) return;
    const value = JSON.parse(raw) as { t: string; p: number; o: number };

    const result = await turnEngine.answerQuestionButton(value.t, value.p, value.o);
    if (!result.ok) {
      await client.chat.postMessage({ channel, thread_ts: threadTs, text: "⚠️ この質問は既に回答済みです。" });
    }
  });

  app.action(/^perm_choice_/, async ({ ack, body, client }) => {
    await ack();
    const actionBody = body as unknown as {
      channel?: { id: string };
      message?: { ts: string; thread_ts?: string };
      actions: Array<{ value?: string }>;
    };
    const channel = actionBody.channel?.id;
    const threadTs = actionBody.message?.thread_ts ?? actionBody.message?.ts;
    const raw = actionBody.actions[0]?.value;
    if (!channel || !threadTs || !raw) return;
    const value = JSON.parse(raw) as { t: string; p: number; n: string };

    const result = await turnEngine.answerPermissionButton(value.t, value.p, value.n);
    if (!result.ok) {
      await client.chat.postMessage({ channel, thread_ts: threadTs, text: "⚠️ このリクエストは既に処理済みです。" });
    }
  });

  // Free-text answers to a pending AskUserQuestion: any plain thread reply
  // (no mention needed) while that thread's paired turn is awaiting-question.
  app.event("message", async ({ event }) => {
    const msgEvent = event as unknown as {
      subtype?: string;
      bot_id?: string;
      channel: string;
      thread_ts?: string;
      text?: string;
    };
    if (msgEvent.subtype || msgEvent.bot_id) return;
    if (!msgEvent.thread_ts) return;
    const text = stripComposerAttribution(msgEvent.text ?? "").trim();
    if (!text || /<@[^>]+>/.test(text)) return; // mentions are handled by app_mention

    const pairing = pairingStore.get(msgEvent.channel, msgEvent.thread_ts);
    if (!pairing) return;

    await turnEngine.answerQuestionFreeText(pairing.terminalId, text);
    // if not ok: ordinary thread chatter, not an answer — ignore silently
  });

  return app;
}
