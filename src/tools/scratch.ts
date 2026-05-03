/**
 * Scratch tool — agent memory pad
 */

import { Type } from "typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

interface ScratchEntry {
	type: "note" | "todo" | "convention";
	text: string;
	timestamp: number;
}

const SCRATCH_KEY = "enhanced-tools-scratch";

function loadScratch(sessionEntries: Array<any>): ScratchEntry[] {
	const entries: ScratchEntry[] = [];
	for (const entry of sessionEntries) {
		if (entry.type === "custom" && entry.customType === SCRATCH_KEY && entry.data) {
			try {
				const data = typeof entry.data === "string" ? JSON.parse(entry.data) : entry.data;
				if (Array.isArray(data)) entries.push(...data);
			} catch { /* ignore */ }
		}
	}
	return entries;
}

export function registerScratchTool(pi: ExtensionAPI) {
	pi.registerTool({
		name: "scratch",
		label: "Scratch",
		description: "Read or write notes, todos, and conventions to a persistent session scratchpad. Survives context compaction. Use it to remember plans, conventions, and discoveries across turns.",
		promptSnippet: "Read or write session notes, todos, and conventions",
		promptGuidelines: [
			"Use scratch write to save important conventions discovered mid-session (e.g., 'Always use WORK_DIR not TMPDIR').",
			"Use scratch write to store a task plan before starting a long refactor.",
			"Use scratch read at the start of each turn to recall your plan and conventions.",
			"Use scratch write todo to track sub-tasks: scratch write --type todo 'Fix auth tests'.",
			"Use scratch clear to reset when starting a completely new task.",
			"Do not store secrets or sensitive data in scratch.",
		],
		parameters: Type.Object({
			action: Type.String({ description: "Action: read, write, or clear" }),
			text: Type.Optional(Type.String({ description: "Text to write (required for write action)" })),
			note_type: Type.Optional(Type.String({ description: "Type for write: note, todo, or convention (default: note)" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const entries = loadScratch(ctx.sessionManager.getEntries());

			if (params.action === "read") {
				if (entries.length === 0) {
					return { content: [{ type: "text", text: "Scratchpad is empty." }], details: { count: 0 } };
				}
				const lines: string[] = [];
				for (const e of entries) {
					const date = new Date(e.timestamp).toLocaleTimeString();
					lines.push(`[${e.type.toUpperCase()}] ${date}: ${e.text}`);
				}
				return { content: [{ type: "text", text: lines.join("\n") }], details: { count: entries.length } };
			}

			if (params.action === "write") {
				if (!params.text) throw new Error("text is required for write action");
				const newEntry: ScratchEntry = {
					type: (params.note_type as any) ?? "note",
					text: params.text,
					timestamp: Date.now(),
				};
				entries.push(newEntry);
				pi.appendEntry(SCRATCH_KEY, JSON.stringify(entries));
				return { content: [{ type: "text", text: `Saved: ${params.text}` }], details: { count: entries.length } };
			}

			if (params.action === "clear") {
				pi.appendEntry(SCRATCH_KEY, JSON.stringify([]));
				return { content: [{ type: "text", text: "Scratchpad cleared." }], details: { count: 0 } };
			}

			throw new Error(`Unknown action: ${params.action}. Use read, write, or clear.`);
		},
	});
}
