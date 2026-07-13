import type { AgentInfo } from "../herdr/types.js";
import type { AskUserQuestionPaneInfo, PermissionMenu } from "../prompts.js";
import { isDangerousSnippet, isRefusalLabel } from "../prompts.js";

const STATUS_ICON: Record<string, string> = {
  idle: "🟢",
  working: "🟡",
  blocked: "🔴",
  done: "🟢",
  unknown: "⚪",
};

function truncateLeft(s: string, max: number): string {
  if (s.length <= max) return s;
  return "…" + s.slice(s.length - max + 1);
}

/** A static_select of currently running herdr agents, for `@cctag connect`. */
export function agentPickerBlocks(agents: AgentInfo[]) {
  if (agents.length === 0) {
    return [
      {
        type: "section",
        text: { type: "mrkdwn", text: "現在 herdr 上で稼働中の Claude Code インスタンスが見つかりません。" },
      },
    ];
  }
  return [
    {
      type: "section",
      text: { type: "mrkdwn", text: "*接続するインスタンスを選択してください:*" },
      accessory: {
        type: "static_select",
        action_id: "pair_select",
        placeholder: { type: "plain_text", text: "インスタンスを選択" },
        options: agents.map((a) => ({
          text: {
            type: "plain_text",
            text: `${STATUS_ICON[a.agentStatus] ?? "⚪"} ${truncateLeft(a.cwd, 60)}`.slice(0, 75),
          },
          value: a.terminalId,
        })),
      },
    },
  ];
}

export function statusText(agent: AgentInfo | null, elapsedSec?: number, lastTool?: string): string {
  if (!agent) return "⚠️ インスタンスが見つかりません";
  if (agent.agentStatus === "blocked") return "⏸ 応答待ち…";
  const suffix = lastTool ? ` — 🔧 ${lastTool}` : "";
  const time = elapsedSec !== undefined ? ` (${elapsedSec}s)` : "";
  return `⚙️ 実行中…${time}${suffix}`;
}

export function doneStatusText(elapsedSec: number, toolCounts: Record<string, number>): string {
  const parts = Object.entries(toolCounts).map(([name, n]) => `${name}×${n}`);
  const suffix = parts.length ? ` — 🔧 ${parts.join(", ")}` : "";
  return `✅ 完了 (${elapsedSec}s)${suffix}`;
}

interface AqButtonValue {
  k: "aq";
  t: string; // terminalId
  p: number; // promptId (race guard — this prompt's slot in the turn)
  o: number; // option index
}

/** Renders an AskUserQuestion prompt read off the pane (one question at a time). */
export function askUserQuestionBlocks(terminalId: string, promptId: number, info: AskUserQuestionPaneInfo) {
  const header = `❓ ${info.header}`;
  const blocks: unknown[] = [{ type: "section", text: { type: "mrkdwn", text: `*${header}*\n${info.question}` } }];

  if (info.multiSelect) {
    const optionLines = info.options.map(
      (o, i) => `${i + 1}. *${o.label}*${o.description ? ` — ${o.description}` : ""}`,
    );
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `複数選択可能な質問です。このスレッドへの返信で、選びたい項目をまとめて自由記述で答えてください:\n${optionLines.join("\n")}`,
      },
    });
    return blocks;
  }

  blocks.push({
    type: "actions",
    elements: info.options.slice(0, 4).map((o, i) => ({
      type: "button",
      text: { type: "plain_text", text: `${i + 1}. ${o.label}`.slice(0, 75) },
      value: JSON.stringify({ k: "aq", t: terminalId, p: promptId, o: i } satisfies AqButtonValue),
      action_id: `aq_answer_${i}`,
    })),
  });
  const descriptions = info.options
    .map((o, i) => (o.description ? `${i + 1}. ${o.description}` : null))
    .filter(Boolean);
  if (descriptions.length) {
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: descriptions.join(" ／ ") }] });
  }
  blocks.push({
    type: "context",
    elements: [{ type: "mrkdwn", text: "ボタンを押すか、このスレッドに返信すると自由記述で回答できます" }],
  });
  return blocks;
}

export function askUserQuestionAnsweredText(header: string, answer: string): string {
  return `✅ *${header}* → ${answer}`;
}

interface PermButtonValue {
  k: "perm";
  t: string;
  p: number;
  n: string;
}

export function permissionBlocks(terminalId: string, promptId: number, menu: PermissionMenu, headerOverride?: string) {
  const danger = isDangerousSnippet(menu.snippet);
  const header = headerOverride ?? (danger ? "🚨 許可リクエスト（危険な可能性）" : "⚠️ 許可リクエスト");
  const blocks: unknown[] = [
    { type: "section", text: { type: "mrkdwn", text: `*${header}*` } },
    { type: "section", text: { type: "mrkdwn", text: "```\n" + menu.snippet.slice(0, 2900) + "\n```" } },
    {
      type: "actions",
      elements: menu.choices.slice(0, 5).map((c) => ({
        type: "button",
        text: { type: "plain_text", text: `${c.num}. ${c.label}`.slice(0, 75) },
        style: c.num === "1" ? "primary" : isRefusalLabel(c.label) ? "danger" : undefined,
        value: JSON.stringify({ k: "perm", t: terminalId, p: promptId, n: c.num } satisfies PermButtonValue),
        action_id: `perm_choice_${c.num}`,
      })),
    },
  ];
  return blocks;
}

export function permissionParseFailureBlocks(terminalId: string, promptId: number, rawSnippet: string) {
  return [
    { type: "section", text: { type: "mrkdwn", text: "⚠️ 許可リクエスト（メニューを解析できませんでした）" } },
    { type: "section", text: { type: "mrkdwn", text: "```\n" + rawSnippet.slice(0, 2900) + "\n```" } },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "✅ 承認 (y)" },
          style: "primary",
          value: JSON.stringify({ k: "perm", t: terminalId, p: promptId, n: "y" } satisfies PermButtonValue),
          action_id: "perm_choice_y",
        },
        {
          type: "button",
          text: { type: "plain_text", text: "❌ 拒否 (n)" },
          style: "danger",
          value: JSON.stringify({ k: "perm", t: terminalId, p: promptId, n: "n" } satisfies PermButtonValue),
          action_id: "perm_choice_n",
        },
      ],
    },
  ];
}
