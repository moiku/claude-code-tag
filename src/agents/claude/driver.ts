import type { AgentDriver, BlockedPrompt } from "../driver.js";
import type { HerdrClient } from "../../herdr/client.js";
import {
  BACKTAB,
  findPlanFeedbackOption,
  MODE_ALIASES,
  MODE_RING,
  parseAskUserQuestionPane,
  parseCurrentMode,
  parsePermissionMenu,
  stripFooterChrome,
} from "./prompts.js";
import { extractAssistantText, extractToolUseSummaries, transcriptPath, type TranscriptRecord } from "./transcript.js";
import { resolvePlanFile } from "./plan.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Runs a CLI slash command (`/model <name>`, ...) rather than a normal
 * conversational turn. These don't reliably show up in the session
 * transcript the way an LLM reply does, so this reads the result straight
 * off the pane. If a confirmation menu appears (e.g. switching models
 * mid-conversation asks "Switch model? Yes/No"), it's auto-confirmed with
 * the first option, since the user asking for the command already expressed
 * that intent.
 */
async function runClaudeSlashCommand(
  herdr: HerdrClient,
  agent: { terminalId: string; paneId: string },
  command: string,
): Promise<string> {
  await herdr.agentSend(agent.terminalId, command);
  await sleep(300);
  await herdr.paneSendKeys(agent.paneId, "Enter");

  let settled = false;
  for (let i = 0; i < 10 && !settled; i++) {
    await sleep(600);
    const cur = await herdr.agentGet(agent.terminalId);
    if (!cur) break;

    // Some confirmation menus — notably "Switch model? ... this
    // conversation is cached, switching means the full history gets
    // re-read" — don't flip agentStatus to "blocked" the way ordinary
    // permission/AskUserQuestion prompts do; herdr keeps reporting "idle"
    // while the menu sits on screen waiting for input (verified
    // empirically: status stayed "idle" for the entire time the dialog was
    // up). So check the pane for a parseable menu on every iteration, not
    // only when status says "blocked" — otherwise this dialog is mistaken
    // for "already settled" and left unanswered.
    const paneText = await herdr.paneRead(agent.paneId, { source: "recent", lines: 40 });
    const menu = parsePermissionMenu(paneText);
    if (menu && menu.choices.length > 0) {
      await herdr.agentSend(agent.terminalId, menu.choices[0].num);
      continue;
    }

    if (cur.agentStatus === "idle" || cur.agentStatus === "done") {
      settled = true;
    }
  }

  const raw = await herdr.paneRead(agent.paneId, { source: "recent", lines: 40 });
  const snippet = stripFooterChrome(raw);
  return "```\n" + snippet.slice(-1500) + "\n```";
}

export const claudeDriver: AgentDriver = {
  kind: "claude",
  displayName: "Claude Code",
  paneReadSource: "recent",

  locateTranscript(cwd, sessionId) {
    return sessionId ? transcriptPath(cwd, sessionId) : null;
  },

  extractTurnOutput(records) {
    const r = records as TranscriptRecord[];
    return { texts: extractAssistantText(r), toolNames: extractToolUseSummaries(r) };
  },

  parseBlockedPane(paneText): BlockedPrompt {
    const aq = parseAskUserQuestionPane(paneText);
    if (aq) return { kind: "question", info: aq };
    const menu = parsePermissionMenu(paneText);
    const feedbackNum = findPlanFeedbackOption(paneText);
    return {
      kind: "permission",
      menu,
      isPlanPrompt: feedbackNum !== null,
      planFeedbackOptionNum: feedbackNum ?? undefined,
    };
  },

  async answerOption(herdr, terminalId, _paneId, value) {
    await herdr.agentSend(terminalId, value);
  },

  async answerQuestionFreeText(herdr, terminalId, paneId, info, text) {
    // Navigate down to the "Type something" row (the free-text row must be
    // reached via arrows and then have its placeholder replaced before Enter).
    const downs = Array(info.options.length).fill("Down");
    if (downs.length) await herdr.paneSendKeys(paneId, ...downs);
    await herdr.agentSend(terminalId, text);
    await sleep(200);
    await herdr.paneSendKeys(paneId, "Enter");
  },

  async answerPlanFeedback(herdr, terminalId, paneId, optionNum, text) {
    // Verified mechanics: send the option's digit to move the cursor there,
    // type the feedback — which replaces the option's placeholder label
    // inline — then Enter, which refines the plan and stays in plan mode.
    await herdr.agentSend(terminalId, String(optionNum));
    await sleep(200);
    await herdr.agentSend(terminalId, text);
    await sleep(200);
    await herdr.paneSendKeys(paneId, "Enter");
  },

  resolvePlanFile,

  modes: {
    ring: MODE_RING,
    aliases: MODE_ALIASES,
    parseCurrent: parseCurrentMode,
    async cycle(herdr, paneId) {
      // herdr's `send-keys shift+tab` is a no-op for Claude Code; the raw
      // CSI Z sequence sent as text does work (verified empirically).
      await herdr.paneSendText(paneId, BACKTAB);
    },
  },

  async runModelCommand(herdr, agent, argsText) {
    return runClaudeSlashCommand(herdr, agent, `/model ${argsText}`);
  },
};
