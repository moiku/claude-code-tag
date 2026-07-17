import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parsePlanFilePath } from "./prompts.js";

/** Expands a leading ~ to the user's home directory. */
function expandHome(p: string): string {
  return p.startsWith("~/") || p === "~" ? p.replace(/^~/, homedir()) : p;
}

/**
 * Resolves the plan markdown Claude Code wrote to ~/.claude/plans/<slug>.md
 * for the current ExitPlanMode approval prompt.
 *
 * The path shown in the pane footer gets truncated when the pane is narrow
 * (the .md suffix can be cut off), so the pane-parsed path is only a
 * preferred hint: if it doesn't parse to an existing file, fall back to the
 * most-recently-modified plan file, which Claude Code writes immediately
 * before showing the approval prompt.
 */
export function resolvePlanFile(paneText: string): string | null {
  const hinted = parsePlanFilePath(paneText);
  if (hinted) {
    const abs = expandHome(hinted);
    if (existsSync(abs)) return abs;
  }
  // Fallback: newest *.md in ~/.claude/plans/.
  const dir = join(homedir(), ".claude", "plans");
  try {
    let newest: { path: string; mtime: number } | null = null;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".md")) continue;
      const p = join(dir, name);
      const mtime = statSync(p).mtimeMs;
      if (!newest || mtime > newest.mtime) newest = { path: p, mtime };
    }
    return newest?.path ?? null;
  } catch {
    return null;
  }
}
