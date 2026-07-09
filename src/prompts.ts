/**
 * Parses Claude Code's TUI menus out of a pane screen capture: both
 * permission-approval menus ("Do you want to proceed? > 1. Yes / 2. ... /
 * 3. No") and AskUserQuestion menus.
 *
 * IMPORTANT (found empirically, corrects the original design): the
 * AskUserQuestion tool_use is NOT written to the session transcript while
 * the question is pending — Claude Code writes the tool_use and its
 * tool_result together, atomically, only AFTER the question is answered.
 * So there is no way to detect or read a *pending* AskUserQuestion from the
 * transcript; it must be read off the pane, exactly like a permission menu.
 * The two are told apart by the presence of a "N. Type something." row,
 * which only appears in AskUserQuestion menus.
 */

export interface PermissionChoice {
  num: string;
  label: string;
}

export interface PermissionMenu {
  choices: PermissionChoice[];
  snippet: string;
}

const NUMBERED_LINE_RE = /^\s*(?:❯\s*)?(\d+)\.\s*(.+?)\s*$/;
const CURSOR_LINE_RE = /❯\s*\d+\./;

export function parsePermissionMenu(paneText: string): PermissionMenu | null {
  const lines = paneText.split("\n");

  let cursorIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (CURSOR_LINE_RE.test(lines[i])) {
      cursorIdx = i;
      break;
    }
  }
  if (cursorIdx === -1) return null;

  let start = cursorIdx;
  while (start - 1 >= 0 && NUMBERED_LINE_RE.test(lines[start - 1])) start--;
  let end = cursorIdx;
  while (end + 1 < lines.length && NUMBERED_LINE_RE.test(lines[end + 1])) end++;

  const choices: PermissionChoice[] = [];
  for (let i = start; i <= end; i++) {
    const m = NUMBERED_LINE_RE.exec(lines[i]);
    if (!m) continue;
    choices.push({ num: m[1], label: m[2] });
  }

  if (choices.length < 2) return null;
  for (let i = 0; i < choices.length; i++) {
    if (choices[i].num !== String(i + 1)) return null; // must be consecutive 1..n
  }

  const snippetStart = Math.max(0, start - 8);
  const snippet = lines
    .slice(snippetStart, end + 1)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { choices, snippet };
}

export interface AskUserQuestionOption {
  label: string;
  description?: string;
}

export interface AskUserQuestionPaneInfo {
  header: string;
  question: string;
  options: AskUserQuestionOption[];
  multiSelect: boolean;
}

const TYPE_SOMETHING_RE = /^\s*(?:❯\s*)?(\d+)\.\s*Type something\.?\s*$/;
const OPTION_LINE_RE = /^\s*(?:❯\s*)?(\d+)\.\s*(?:\[([ x✔])\]\s*)?(.+?)\s*$/;
const HEADER_LINE_RE = /^\s*[☐☒]\s*(.+?)\s*$/;
const NUMBERED_START_RE = /^\s*(?:❯\s*)?\d+\./;

/** Returns null if this pane text isn't showing an AskUserQuestion menu. */
export function parseAskUserQuestionPane(paneText: string): AskUserQuestionPaneInfo | null {
  const lines = paneText.split("\n");

  let typeSomethingIdx = -1;
  let typeSomethingNum = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = TYPE_SOMETHING_RE.exec(lines[i]);
    if (m) {
      typeSomethingIdx = i;
      typeSomethingNum = parseInt(m[1], 10);
      break;
    }
  }
  if (typeSomethingIdx === -1) return null;

  let headerLineIdx = -1;
  for (let i = typeSomethingIdx; i >= 0; i--) {
    if (HEADER_LINE_RE.test(lines[i])) {
      headerLineIdx = i;
      break;
    }
  }
  const header = headerLineIdx >= 0 ? (HEADER_LINE_RE.exec(lines[headerLineIdx])?.[1] ?? "質問") : "質問";

  let questionLineIdx = -1;
  for (let i = headerLineIdx + 1; i < typeSomethingIdx; i++) {
    if (lines[i].trim() && !NUMBERED_START_RE.test(lines[i])) {
      questionLineIdx = i;
      break;
    }
  }
  const question = questionLineIdx >= 0 ? lines[questionLineIdx].trim() : "";

  const options: AskUserQuestionOption[] = [];
  let multiSelect = false;
  const firstOptionSearchStart = questionLineIdx >= 0 ? questionLineIdx + 1 : headerLineIdx + 1;
  for (let i = firstOptionSearchStart; i < typeSomethingIdx; i++) {
    const m = OPTION_LINE_RE.exec(lines[i]);
    if (!m) continue;
    const num = parseInt(m[1], 10);
    if (num < 1 || num >= typeSomethingNum) continue;
    if (m[2] !== undefined) multiSelect = true;

    let description = "";
    for (let j = i + 1; j < typeSomethingIdx; j++) {
      if (NUMBERED_START_RE.test(lines[j]) || !lines[j].trim()) break;
      description += (description ? " " : "") + lines[j].trim();
    }
    options[num - 1] = { label: m[3], description: description || undefined };
  }
  if (options.length !== typeSomethingNum - 1 || options.some((o) => !o)) return null;

  return { header, question, options, multiSelect };
}

const DANGER_WORDS_RE = /\b(rm\s+-rf|sudo|--force|DROP\s+TABLE)\b/i;
const REFUSAL_LABEL_RE = /no|cancel|拒否|キャンセル|don'?t/i;

export function isDangerousSnippet(snippet: string): boolean {
  return DANGER_WORDS_RE.test(snippet);
}

export function isRefusalLabel(label: string): boolean {
  return REFUSAL_LABEL_RE.test(label);
}
