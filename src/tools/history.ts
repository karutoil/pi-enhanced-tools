/**
 * History tool — track file changes in the session
 */

import { Type } from "typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

interface ChangeRecord {
	turn: number;
	tool: string;
	file: string;
	action: "created" | "modified" | "deleted";
	timestamp: number;
}

const HISTORY_KEY = "enhanced-tools-history";
let changeLog: ChangeRecord[] = [];

export function trackChange(pi: ExtensionAPI, turn: number, tool: string, file: string, action: "created" | "modified" | "deleted") {
	changeLog.push({ turn, tool, file, action, timestamp: Date.now() });
	pi.appendEntry(HISTORY_KEY, JSON.stringify(changeLog));
}

export function registerHistoryTool(pi: ExtensionAPI) {
	pi.registerTool({
		name: "history",
		label: "History",
		description: "Show a chronological log of file changes made during this session. Helps avoid re-reading files you already modified.",
		promptSnippet: "View session file change history",
		promptGuidelines: [
			"Use history to see what you've already changed before making more edits.",
			"Use history to avoid accidentally re-modifying a file you already fixed.",
			"Use history to generate a summary of changes for the user.",
			"History is session-scoped and resets with /new.",
		],
		parameters: Type.Object({
			file: Type.Optional(Type.String({ description: "Filter to a specific file path" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			// Also load from session entries in case of reload
			for (const entry of ctx.sessionManager.getEntries()) {
				if (entry.type === "custom" && entry.customType === HISTORY_KEY && entry.data) {
					try {
						const data = typeof entry.data === "string" ? JSON.parse(entry.data) : entry.data;
						if (Array.isArray(data)) changeLog = data;
					} catch { /* ignore */ }
				}
			}

			let filtered = changeLog;
			if (params.file) {
				filtered = changeLog.filter(c => c.file.includes(params.file!));
			}

			if (filtered.length === 0) {
				return { content: [{ type: "text", text: "No file changes recorded in this session yet." }], details: { count: 0 } };
			}

			const lines: string[] = [];
			lines.push(`Session changes: ${filtered.length} operation(s)`);
			lines.push("");

			for (const c of filtered) {
				const icon = c.action === "created" ? "+" : c.action === "deleted" ? "-" : "~";
				lines.push(`Turn ${c.turn}  ${icon}  ${c.file}  (${c.tool})`);
			}

			return { content: [{ type: "text", text: lines.join("\n") }], details: { count: filtered.length } };
		},
	});
}
