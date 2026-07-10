import { homedir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { loadSpokeConfig } from "../config.js";
import { HerdrClient } from "../herdr/client.js";
import { PairingStore } from "../pairing.js";
import { TurnEngine } from "../turn.js";
import { CommandHandler, stripComposerAttribution, stripMention } from "../commands.js";
import { BackgroundWatcher } from "../watcher.js";
import { WsRpc } from "../ws/rpc.js";
import { WsNotifier } from "./notifier.js";

function wsUrlFor(hubUrl: string, token: string): string {
  const url = new URL(hubUrl.replace(/\/+$/, "") + "/spoke");
  url.searchParams.set("token", token);
  return url.toString();
}

/**
 * One machine can run multiple Spokes (one per Slack workspace/Hub, via
 * CCTAG_ENV_FILE — see config.ts). All of them talk to the same local herdr
 * daemon, so they'd silently clobber each other's pairing state if they
 * shared one `~/.cctag/pairings.json`. Namespace it by Hub URL automatically
 * so no extra config is needed for this to just work.
 */
function pairingStorePathFor(hubUrl: string): string {
  const safe = hubUrl.replace(/[^a-zA-Z0-9]/g, "-");
  return join(homedir(), ".cctag", `pairings-${safe}.json`);
}

function connectOnce(config: ReturnType<typeof loadSpokeConfig>): Promise<void> {
  const herdr = new HerdrClient(config.herdrBin);
  const pairingStore = new PairingStore(pairingStorePathFor(config.hubUrl));

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrlFor(config.hubUrl, config.spokeToken));

    ws.on("open", async () => {
      const rpc = new WsRpc(ws);
      const notifier = new WsNotifier(rpc);
      const turnEngine = new TurnEngine(herdr, notifier, {
        turnTimeoutMs: config.turnTimeoutMs,
        pollIntervalMs: config.pollIntervalMs,
      });
      const commands = new CommandHandler(herdr, pairingStore, turnEngine, notifier, config.ownerUserId);
      const watcher = new BackgroundWatcher(herdr, pairingStore, turnEngine, notifier);
      watcher.start();
      ws.once("close", () => watcher.stop());

      pairingStore.onChange = (change) => {
        rpc.notify("pairing_changed", {
          channel: change.pairing.channel,
          threadTs: change.pairing.threadTs,
          action: change.action,
        });
      };

      rpc.onCall("app_mention", async (payload) => {
        const p = payload as { channel: string; threadTs: string; userId: string; text: string; ts: string };
        const text = stripMention(stripComposerAttribution(p.text));
        await commands.handleMention({ channel: p.channel, threadTs: p.threadTs, userId: p.userId, text, ts: p.ts });
        return {};
      });

      rpc.onCall("message", async (payload) => {
        const p = payload as { channel: string; threadTs: string; text: string };
        const text = stripComposerAttribution(p.text).trim();
        if (!text || /<@[^>]+>/.test(text)) return {};
        await commands.handleFreeTextMessage({ channel: p.channel, threadTs: p.threadTs, text });
        return {};
      });

      rpc.onCall("pair_select", async (payload) => {
        const p = payload as { channel: string; threadTs: string; userId: string; terminalId: string };
        await commands.handlePairSelect(p);
        return {};
      });

      rpc.onCall("aq_answer", async (payload) => {
        const p = payload as { channel: string; threadTs: string; value: string };
        const v = JSON.parse(p.value) as { t: string; p: number; o: number };
        await commands.handleAskUserQuestionButton({ channel: p.channel, threadTs: p.threadTs, terminalId: v.t, promptId: v.p, optionIndex: v.o });
        return {};
      });

      rpc.onCall("perm_choice", async (payload) => {
        const p = payload as { channel: string; threadTs: string; value: string };
        const v = JSON.parse(p.value) as { t: string; p: number; n: string };
        await commands.handlePermissionButton({ channel: p.channel, threadTs: p.threadTs, terminalId: v.t, promptId: v.p, num: v.n });
        return {};
      });

      try {
        await rpc.call("register", {
          ownerUserId: config.ownerUserId,
          pairings: pairingStore.list().map((p) => ({ channel: p.channel, threadTs: p.threadTs })),
        });
        console.log("[spoke] registered with hub");
      } catch (err) {
        reject(err);
        return;
      }
    });

    ws.on("close", (code, reason) => {
      console.log(`[spoke] disconnected from hub (code ${code}${reason ? `: ${reason}` : ""})`);
      resolve();
    });
    ws.on("error", (err) => {
      console.error("[spoke] connection error:", err.message);
    });
  });
}

async function main() {
  const config = loadSpokeConfig();
  console.log(`[spoke] connecting to ${config.hubUrl} as owner ${config.ownerUserId}...`);

  let backoffMs = 1_000;
  for (;;) {
    try {
      await connectOnce(config);
      backoffMs = 1_000;
    } catch (err) {
      console.error("[spoke] connection failed:", err instanceof Error ? err.message : err);
    }
    await new Promise((r) => setTimeout(r, backoffMs));
    backoffMs = Math.min(backoffMs * 2, 30_000);
    console.log("[spoke] reconnecting...");
  }
}

main().catch((err) => {
  console.error("cctag-spoke failed:", err);
  process.exit(1);
});
