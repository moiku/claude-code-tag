import type { MessageHandle, Notifier } from "../notifier.js";
import type { WsRpc } from "../ws/rpc.js";

/** Proxies every Notifier call to the Hub over the WebSocket RPC connection. */
export class WsNotifier implements Notifier {
  constructor(private readonly rpc: WsRpc) {}

  async postReply(channel: string, threadTs: string, text: string): Promise<void> {
    await this.rpc.call("post_reply", { channel, threadTs, text });
  }

  async postMessage(channel: string, threadTs: string, text: string, blocks?: unknown[]): Promise<MessageHandle> {
    const { msgId } = await this.rpc.call<{ msgId: string }>("post_message", { channel, threadTs, text, blocks });
    return {
      update: async (newText: string, newBlocks?: unknown[]) => {
        await this.rpc.call("update_message", { msgId, text: newText, blocks: newBlocks });
      },
    };
  }

  async getPermalink(channel: string, ts: string): Promise<string | null> {
    const { permalink } = await this.rpc.call<{ permalink: string | null }>("get_permalink", { channel, ts });
    return permalink;
  }

  async getThreadHistorySinceLastBotPost(channel: string, threadTs: string, excludeTs: string): Promise<string[]> {
    const { lines } = await this.rpc.call<{ lines: string[] }>("get_thread_history", { channel, threadTs, excludeTs });
    return lines;
  }

  async uploadTextFile(
    channel: string,
    threadTs: string,
    args: { content: string; filename: string; title?: string; comment?: string },
  ): Promise<void> {
    await this.rpc.call("upload_text_file", { channel, threadTs, ...args });
  }
}
