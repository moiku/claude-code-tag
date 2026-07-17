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
