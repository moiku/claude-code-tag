/**
 * Everything turn.ts needs to talk back to "the chat platform", kept free of
 * any Slack SDK types so the core engine (herdr / transcript / turn) stays
 * portable. Phase 1 implements this with @slack/bolt directly; Phase 4
 * (Hub–Spoke) implements it by forwarding over a WebSocket to the Hub.
 *
 * `blocks` is a plain JSON value (Slack Block Kit's block array) — treated as
 * opaque data here, not typed against the Slack SDK, so it forwards cleanly
 * over a WebSocket in the Hub–Spoke design too.
 */
export interface MessageHandle {
  update(text: string, blocks?: unknown[]): Promise<void>;
}

export interface Notifier {
  /** Posts a new message in the thread (used for the aggregated turn result). */
  postReply(channel: string, threadTs: string, text: string): Promise<void>;
  /** Posts a message that will be updated in place (status line, or a prompt with buttons). */
  postMessage(channel: string, threadTs: string, text: string, blocks?: unknown[]): Promise<MessageHandle>;
  /** Best-effort permalink lookup, used for the "already paired elsewhere" hint. */
  getPermalink?(channel: string, ts: string): Promise<string | null>;
  /**
   * Thread messages posted after cctag's own last message in this thread
   * (or the whole thread, if cctag hasn't posted yet), formatted as one
   * "speaker: text" line per message. `excludeTs` is the triggering
   * command's own message ts, dropped from the result. Used by the `log`
   * command to catch cctag up on conversation it wasn't mentioned in.
   */
  getThreadHistorySinceLastBotPost?(channel: string, threadTs: string, excludeTs: string): Promise<string[]>;
}
