import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import Bolt from "@slack/bolt";
import { WebSocketServer } from "ws";
import { loadHubConfig } from "../config.js";
import { TokenStore } from "./tokenStore.js";
import { WsRpc } from "../ws/rpc.js";

const { App } = Bolt;

interface RegisterPayload {
  ownerUserId: string;
  pairings: Array<{ channel: string; threadTs?: string }>;
}

function threadKey(channel: string, threadTs?: string): string {
  return threadTs ? `${channel}:${threadTs}` : channel;
}

function threadTsOf(event: { thread_ts?: string; ts: string }): string {
  return event.thread_ts ?? event.ts;
}

/**
 * One machine can run multiple Hubs (one per Slack workspace, via
 * CCTAG_ENV_FILE — see config.ts / spoke/index.ts's equivalent pairing-store
 * namespacing). Without this, every Hub on the box would share one
 * `~/.cctag-hub/tokens.json`, so a token issued for one workspace would also
 * be accepted by every other Hub's WebSocket server. The default (no
 * CCTAG_ENV_FILE) path is left unchanged for backwards compatibility.
 */
function tokenStorePath(): string | undefined {
  const envFile = process.env.CCTAG_ENV_FILE;
  if (!envFile) return undefined;
  const safe = envFile.replace(/[^a-zA-Z0-9]/g, "-");
  return join(homedir(), ".cctag-hub", `tokens-${safe}.json`);
}

async function runServer(): Promise<void> {
  const config = loadHubConfig();
  const tokenStore = new TokenStore(tokenStorePath());

  const spokesByOwner = new Map<string, WsRpc>();
  const threadOwner = new Map<string, string>();
  const messageLocations = new Map<string, { channel: string; ts: string }>();
  let msgSeq = 0;

  const app = new App({
    token: config.slackBotToken,
    appToken: config.slackAppToken,
    socketMode: true,
  });

  function spokeFor(ownerUserId: string): WsRpc | undefined {
    return spokesByOwner.get(ownerUserId);
  }

  async function notConnectedReply(channel: string, threadTs: string): Promise<void> {
    await app.client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: "⚠️ 起動していません。オーナーの cctag spoke デーモンが起動しているか確認してください。",
    });
  }

  const httpServer = createServer();
  const wss = new WebSocketServer({ server: httpServer, path: "/spoke" });

  wss.on("connection", (ws, req) => {
    const url = new URL(req.url ?? "", "http://localhost");
    const token = url.searchParams.get("token") ?? "";
    const issued = tokenStore.validate(token);
    if (!issued) {
      ws.close(4001, "invalid token");
      return;
    }

    const rpc = new WsRpc(ws);
    let registeredOwnerId: string | undefined;

    rpc.onCall("register", (payload) => {
      const { ownerUserId, pairings } = payload as RegisterPayload;
      registeredOwnerId = ownerUserId;
      const prior = spokesByOwner.get(ownerUserId);
      if (prior && prior !== rpc) prior.close();
      spokesByOwner.set(ownerUserId, rpc);

      for (const [key, owner] of threadOwner) {
        if (owner === ownerUserId) threadOwner.delete(key);
      }
      for (const p of pairings) threadOwner.set(threadKey(p.channel, p.threadTs), ownerUserId);

      console.log(`[hub] spoke registered: ${issued.name} -> ${ownerUserId} (${pairings.length} pairing(s))`);
      return { ok: true };
    });

    rpc.onNotify("pairing_changed", (payload) => {
      const p = payload as { channel: string; threadTs?: string; action: "add" | "remove" };
      const key = threadKey(p.channel, p.threadTs);
      if (p.action === "add" && registeredOwnerId) threadOwner.set(key, registeredOwnerId);
      else if (p.action === "remove") threadOwner.delete(key);
    });

    rpc.onCall("post_reply", async (payload) => {
      const p = payload as { channel: string; threadTs: string; text: string };
      await app.client.chat.postMessage({ channel: p.channel, thread_ts: p.threadTs || undefined, text: p.text });
      return {};
    });

    rpc.onCall("post_message", async (payload) => {
      const p = payload as { channel: string; threadTs: string; text: string; blocks?: unknown[] };
      const res = await app.client.chat.postMessage({
        channel: p.channel,
        thread_ts: p.threadTs || undefined,
        text: p.text,
        blocks: p.blocks as never,
      });
      const msgId = `m${++msgSeq}`;
      messageLocations.set(msgId, { channel: p.channel, ts: res.ts as string });
      return { msgId };
    });

    rpc.onCall("update_message", async (payload) => {
      const p = payload as { msgId: string; text: string; blocks?: unknown[] };
      const loc = messageLocations.get(p.msgId);
      if (!loc) return {};
      await app.client.chat.update({ channel: loc.channel, ts: loc.ts, text: p.text, blocks: p.blocks as never });
      return {};
    });

    rpc.onCall("get_permalink", async (payload) => {
      const p = payload as { channel: string; ts: string };
      const res = await app.client.chat.getPermalink({ channel: p.channel, message_ts: p.ts }).catch(() => null);
      return { permalink: res?.permalink ?? null };
    });

    ws.on("close", () => {
      if (registeredOwnerId && spokesByOwner.get(registeredOwnerId) === rpc) {
        spokesByOwner.delete(registeredOwnerId);
        console.log(`[hub] spoke disconnected: ${issued.name}`);
      }
    });
  });

  app.event("app_mention", async ({ event }) => {
    if ("bot_id" in event && event.bot_id) return;
    const channel = event.channel;
    const threadTs = threadTsOf(event);
    const userId = event.user ?? "";
    const key = threadKey(channel, threadTs);
    const ownerUserId = threadOwner.get(key) ?? userId;
    const spoke = spokeFor(ownerUserId);
    if (!spoke) {
      await notConnectedReply(channel, threadTs);
      return;
    }
    await spoke.call("app_mention", { channel, threadTs, userId, text: event.text ?? "" }).catch((err) =>
      console.error("[hub] app_mention dispatch failed:", err),
    );
  });

  app.event("message", async ({ event }) => {
    const msgEvent = event as unknown as { subtype?: string; bot_id?: string; channel: string; thread_ts?: string; text?: string };
    if (msgEvent.subtype || msgEvent.bot_id || !msgEvent.thread_ts) return;
    const key = threadKey(msgEvent.channel, msgEvent.thread_ts);
    const ownerUserId = threadOwner.get(key);
    if (!ownerUserId) return; // unpaired thread — ordinary chatter, ignore
    const spoke = spokeFor(ownerUserId);
    if (!spoke) return;
    await spoke
      .call("message", { channel: msgEvent.channel, threadTs: msgEvent.thread_ts, text: msgEvent.text ?? "" })
      .catch((err) => console.error("[hub] message dispatch failed:", err));
  });

  app.action("pair_select", async ({ ack, body }) => {
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
    const spoke = spokeFor(actionBody.user.id);
    if (!spoke) {
      await notConnectedReply(channel, threadTs);
      return;
    }
    await spoke
      .call("pair_select", { channel, threadTs, userId: actionBody.user.id, terminalId })
      .catch((err) => console.error("[hub] pair_select dispatch failed:", err));
  });

  const actionRoute = (kind: "aq_answer" | "perm_choice") =>
    async ({ ack, body }: { ack: () => Promise<void>; body: unknown }) => {
      await ack();
      const actionBody = body as {
        channel?: { id: string };
        message?: { ts: string; thread_ts?: string };
        actions: Array<{ value?: string }>;
      };
      const channel = actionBody.channel?.id;
      const threadTs = actionBody.message?.thread_ts ?? actionBody.message?.ts;
      const raw = actionBody.actions[0]?.value;
      if (!channel || !threadTs || !raw) return;
      const key = threadKey(channel, threadTs);
      const ownerUserId = threadOwner.get(key);
      const spoke = ownerUserId ? spokeFor(ownerUserId) : undefined;
      if (!spoke) {
        await notConnectedReply(channel, threadTs);
        return;
      }
      await spoke.call(kind, { channel, threadTs, value: raw }).catch((err) => console.error(`[hub] ${kind} dispatch failed:`, err));
    };
  app.action(/^aq_answer_/, actionRoute("aq_answer"));
  app.action(/^perm_choice_/, actionRoute("perm_choice"));

  await new Promise<void>((resolve) => httpServer.listen(config.wsPort, resolve));
  console.log(`[hub] WebSocket server listening on :${config.wsPort} (path /spoke)`);

  await app.start();
  console.log("[hub] ⚡️ Slack connection running (Socket Mode)");
}

function runTokenCli(argv: string[]): void {
  const tokenStore = new TokenStore(tokenStorePath());
  const [cmd, arg] = argv;
  switch (cmd) {
    case "issue": {
      if (!arg) throw new Error("usage: token issue <name>");
      const issued = tokenStore.issue(arg);
      console.log(`Issued token for "${arg}":`);
      console.log(issued.token);
      console.log("\nSet this as CCTAG_SPOKE_TOKEN in that person's spoke .env file.");
      return;
    }
    case "revoke": {
      if (!arg) throw new Error("usage: token revoke <name>");
      const removed = tokenStore.revoke(arg);
      console.log(removed ? `Revoked token(s) for "${arg}".` : `No token found for "${arg}".`);
      return;
    }
    case "list": {
      for (const t of tokenStore.list()) {
        console.log(`${t.name}\tissued ${t.issuedAt}\t${t.token}`);
      }
      return;
    }
    default:
      throw new Error(`unknown token subcommand: ${cmd}\nusage: token <issue|revoke|list> [name]`);
  }
}

async function main() {
  const [, , cmd, ...rest] = process.argv;
  if (cmd === "token") {
    runTokenCli(rest);
    return;
  }
  await runServer();
}

main().catch((err) => {
  console.error("cctag-hub failed:", err);
  process.exit(1);
});
