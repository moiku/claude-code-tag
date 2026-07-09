import type { WebClient } from "@slack/web-api";
import type { MessageHandle, Notifier } from "../notifier.js";

export class SlackNotifier implements Notifier {
  constructor(private readonly client: WebClient) {}

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
}
