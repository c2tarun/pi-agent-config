/**
 * Basic Plan Mode Extension
 *
 * Toggle read-only planning mode on/off with F2 or /plan.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isSafeCommand } from "./utils.js";

const PLAN_MODE_TOOLS = ["read", "bash", "grep", "find", "ls"];
const NORMAL_MODE_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];

export default function planModeExtension(pi: ExtensionAPI): void {
	let planModeEnabled = false;

	pi.registerFlag("plan", {
		description: "Start in plan mode (read-only exploration)",
		type: "boolean",
		default: false,
	});

	function updateStatus(ctx: ExtensionContext): void {
		ctx.ui.setStatus(
			"plan-mode",
			planModeEnabled ? ctx.ui.theme.fg("warning", "⏸ plan") : undefined,
		);
	}

	function setPlanMode(enabled: boolean, ctx: ExtensionContext): void {
		planModeEnabled = enabled;
		pi.setActiveTools(planModeEnabled ? PLAN_MODE_TOOLS : NORMAL_MODE_TOOLS);
		ctx.ui.notify(planModeEnabled ? "Plan mode enabled" : "Plan mode disabled");
		updateStatus(ctx);
	}

	function togglePlanMode(ctx: ExtensionContext): void {
		setPlanMode(!planModeEnabled, ctx);
	}

	pi.registerCommand("plan", {
		description: "Toggle plan mode",
		handler: async (_args, ctx) => togglePlanMode(ctx),
	});

	pi.registerShortcut("f2", {
		description: "Toggle plan mode",
		handler: async (ctx) => togglePlanMode(ctx),
	});

	pi.on("tool_call", async (event) => {
		if (!planModeEnabled || event.toolName !== "bash") return;

		const command = event.input.command as string;
		if (!isSafeCommand(command)) {
			return {
				block: true,
				reason: `Plan mode: command blocked. Press F2 or run /plan to disable plan mode.\nCommand: ${command}`,
			};
		}
	});

	pi.on("context", async (event) => {
		if (planModeEnabled) return;

		return {
			messages: event.messages.filter((m) => {
				const msg = m as AgentMessage & { customType?: string };
				if (msg.customType === "plan-mode-context") return false;
				if (msg.role !== "user") return true;

				const content = msg.content;
				if (typeof content === "string") {
					return !content.includes("[PLAN MODE ACTIVE]");
				}
				if (Array.isArray(content)) {
					return !content.some(
						(c) => c.type === "text" && (c as TextContent).text?.includes("[PLAN MODE ACTIVE]"),
					);
				}
				return true;
			}),
		};
	});

	pi.on("before_agent_start", async () => {
		if (!planModeEnabled) return;

		return {
			message: {
				customType: "plan-mode-context",
				content: `[PLAN MODE ACTIVE]
You are in read-only plan mode.

Rules:
- Inspect and reason only. Do not modify files.
- You may use read-only tools: read, bash, grep, find, ls.
- Bash is restricted to read-only commands.
- Ask clarifying questions if needed.
- Produce a concise implementation plan.`,
				display: false,
			},
		};
	});

	pi.on("session_start", async (_event, ctx) => {
		if (pi.getFlag("plan") === true) {
			planModeEnabled = true;
			pi.setActiveTools(PLAN_MODE_TOOLS);
		}
		updateStatus(ctx);
	});
}
