import { createReadStream, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Claude Code encodes the project cwd into the transcript directory name by
// replacing every non-alphanumeric character with "-". Verified empirically
// (Phase 0): "/private/tmp/cctag-scratch" -> "-private-tmp-cctag-scratch".
export function encodeCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

export function transcriptPath(cwd: string, sessionId: string): string {
  return join(homedir(), ".claude", "projects", encodeCwd(cwd), `${sessionId}.jsonl`);
}

export function transcriptSizeSafe(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

interface ContentBlock {
  type: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  text?: string;
  content?: unknown;
}

export interface TranscriptRecord {
  type?: string;
  uuid?: string;
  timestamp?: string;
  message?: { role?: string; content?: unknown };
}

function contentBlocks(record: TranscriptRecord): ContentBlock[] {
  const content = record.message?.content;
  if (Array.isArray(content)) return content as ContentBlock[];
  return [];
}

/**
 * Reads all complete JSONL lines after `offset` bytes. Returns the parsed
 * records and the new offset (which stops at the last full line — a
 * partially-written trailing line is left unconsumed for the next read).
 */
export async function readNewRecords(
  path: string,
  offset: number,
): Promise<{ records: TranscriptRecord[]; newOffset: number }> {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return { records: [], newOffset: offset };
  }
  if (size <= offset) return { records: [], newOffset: offset };

  const chunk = await new Promise<Buffer>((resolve, reject) => {
    const parts: Buffer[] = [];
    const stream = createReadStream(path, { start: offset });
    stream.on("data", (d) => parts.push(d as Buffer));
    stream.on("end", () => resolve(Buffer.concat(parts)));
    stream.on("error", reject);
  });

  const text = chunk.toString("utf8");
  const lastNewline = text.lastIndexOf("\n");
  if (lastNewline === -1) {
    // no complete line yet
    return { records: [], newOffset: offset };
  }
  const complete = text.slice(0, lastNewline);
  const newOffset = offset + Buffer.byteLength(complete, "utf8") + 1; // +1 for the newline

  const records: TranscriptRecord[] = [];
  for (const line of complete.split("\n")) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line) as TranscriptRecord);
    } catch {
      // skip malformed line defensively
    }
  }
  return { records, newOffset };
}

/** Concatenates all assistant text blocks in the given records, in order. */
export function extractAssistantText(records: TranscriptRecord[]): string[] {
  const texts: string[] = [];
  for (const r of records) {
    if (r.type !== "assistant") continue;
    for (const block of contentBlocks(r)) {
      if (block.type === "text" && block.text) texts.push(block.text);
    }
  }
  return texts;
}

/** Human-readable one-line summaries of tool_use blocks, in order (for the status line). */
export function extractToolUseSummaries(records: TranscriptRecord[]): string[] {
  const summaries: string[] = [];
  for (const r of records) {
    if (r.type !== "assistant") continue;
    for (const block of contentBlocks(r)) {
      if (block.type !== "tool_use" || !block.name) continue;
      if (block.name === "AskUserQuestion") continue; // handled separately
      summaries.push(block.name);
    }
  }
  return summaries;
}
