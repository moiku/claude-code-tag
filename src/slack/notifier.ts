import type { WebClient } from "@slack/web-api";
import type { MessageHandle, Notifier } from "../notifier.js";
import { stripComposerAttribution } from "../commands.js";

export class SlackNotifier implements Notifier {
  private botUserId: string | undefined;

  constructor(private readonly client: WebClient) {}

  private async getBotUserId(): Promise<string | undefined> {
    if (this.botUserId === undefined) {
      const res = await this.client.auth.test().catch(() => null);
      this.botUserId = (res?.user_id as string | undefined) ?? undefined;
    }
    return this.botUserId;
  }

  async postReply(channel: string, threadTs: string, text: string): Promise<void> {
    await this.client.chat.postMessage({
      channel,
      thread_ts: threadTs || undefined,
      text,
    });
  }

  async postMessage(channel: string, threadTs: string, text: string, blocks?: unknown[]): Promise<MessageHandle> {
    const res = await this.client.chat.postMessage({
      channel,
      thread_ts: threadTs || undefined,
      text,
      blocks: blocks as never,
    });
    const ts = res.ts as string;
    return {
      update: async (newText: string, newBlocks?: unknown[]) => {
        await this.client.chat.update({ channel, ts, text: newText, blocks: newBlocks as never });
      },
    };
  }

  async getPermalink(channel: string, ts: string): Promise<string | null> {
    const res = await this.client.chat.getPermalink({ channel, message_ts: ts }).catch(() => null);
    return res?.permalink ?? null;
  }

  async getThreadHistorySinceLastBotPost(channel: string, threadTs: string, excludeTs: string): Promise<string[]> {
    return formatThreadHistorySinceLastBotPost(this.client, channel, threadTs, excludeTs, await this.getBotUserId());
  }
}

interface RepliesMessage {
  ts: string;
  user?: string;
  bot_id?: string;
  username?: string;
  bot_profile?: { name?: string };
  text?: string;
}

/**
 * Shared by both the standalone SlackNotifier and the Hub's RPC handler
 * (hub/index.ts) — both hold a real @slack/bolt WebClient, just wired
 * through different entry points.
 */
export async function formatThreadHistorySinceLastBotPost(
  client: WebClient,
  channel: string,
  threadTs: string,
  excludeTs: string,
  botUserId: string | undefined,
): Promise<string[]> {
  const res = await client.conversations.replies({ channel, ts: threadTs, limit: 200 }).catch(() => null);
  const messages = (res?.messages ?? []) as RepliesMessage[];

  let lastBotIdx = -1;
  if (botUserId) {
    for (let i = 0; i < messages.length; i++) {
      if (messages[i].user === botUserId) lastBotIdx = i;
    }
  }

  const nameCache = new Map<string, string>();
  const lines: string[] = [];
  for (const m of messages.slice(lastBotIdx + 1)) {
    if (m.ts === excludeTs || !m.text) continue;
    const text = stripComposerAttribution(m.text).trim();
    if (!text) continue;
    let label: string;
    if (m.bot_id) {
      label = m.username || m.bot_profile?.name || "bot";
    } else if (m.user) {
      if (!nameCache.has(m.user)) {
        const info = await client.users.info({ user: m.user }).catch(() => null);
        nameCache.set(m.user, info?.user?.real_name || info?.user?.name || m.user);
      }
      label = nameCache.get(m.user)!;
    } else {
      label = "unknown";
    }
    lines.push(`${label}: ${text}`);
  }
  return lines;
}
