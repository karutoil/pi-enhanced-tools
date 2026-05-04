/**
 * Scratch tool — agent memory pad
 */

import { Type } from "typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

/** Snapshot checkpoint data stored alongside regular scratch entries */
interface SnapshotData {
	files_read: string[];
	hypotheses: string[];
	todos: string[];
	validation_results: string[];
	notes?: string;
}

interface ScratchEntry {
	type: "note" | "todo" | "convention" | "snapshot";
	text: string;
	timestamp: number;
}

/** Type guard to identify snapshot entries and extract their data */
function isSnapshotEntry(entry: ScratchEntry): entry is ScratchEntry & { type: "snapshot"; snapshotData: SnapshotData } {
	return entry.type === "snapshot" && "snapshotData" in entry;
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
			"Use scratch snapshot to save your investigation state before a long operation or context reset.",
			"Use scratch restore to resume from your last saved checkpoint.",
			"Do not store secrets or sensitive data in scratch.",
		],
		parameters: Type.Object({
			action: Type.String({ description: "Action: read, write, clear, snapshot, or restore" }),
			text: Type.Optional(Type.String({ description: "Text to write (required for write action)" })),
			note_type: Type.Optional(Type.String({ description: "Type for write: note, todo, convention, or snapshot (default: note)" })),
			files_read: Type.Optional(Type.Array(Type.String({ description: "List of files read during investigation" }))),
			hypotheses: Type.Optional(Type.Array(Type.String({ description: "Hypotheses being tested" }))),
			todos: Type.Optional(Type.Array(Type.String({ description: "Pending tasks at checkpoint time" }))),
			validation_results: Type.Optional(Type.Array(Type.String({ description: "Validation/error results at checkpoint time" }))),
			notes: Type.Optional(Type.String({ description: "Additional freeform notes" })),
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

			if (params.action === "snapshot") {
				const snapshotData: SnapshotData = {
					files_read: params.files_read ?? [],
					hypotheses: params.hypotheses ?? [],
					todos: params.todos ?? [],
					validation_results: params.validation_results ?? [],
					notes: params.notes,
				};
				const snapshotEntry: ScratchEntry & { snapshotData: SnapshotData } = {
					type: "snapshot",
					text: "Investigation checkpoint",
					timestamp: Date.now(),
					snapshotData,
				};
				entries.push(snapshotEntry);
				pi.appendEntry(SCRATCH_KEY, JSON.stringify(entries));
				const snapshotId = new Date(snapshotEntry.timestamp).toISOString().replace(/[T:\.]/g, " ").slice(0, 19);
				return {
					content: [{ type: "text", text: `Checkpoint saved (ID: ${snapshotId})` }],
					details: { count: entries.length, snapshotId },
				};
			}

			if (params.action === "restore") {
				const latestSnapshot = [...entries].reverse().find(isSnapshotEntry);
				if (!latestSnapshot) {
					return { content: [{ type: "text", text: "No snapshots found. Use scratch snapshot to save a checkpoint first." }], details: { count: 0 } };
				}
				const { snapshotData } = latestSnapshot;
				const dateStr = new Date(latestSnapshot.timestamp).toLocaleString();
				const lines: string[] = [];
				lines.push(`Snapshot from ${dateStr}`);
				lines.push("─".repeat(42));

				if (snapshotData.files_read.length > 0) {
					lines.push("Files read:");
					for (const f of snapshotData.files_read) {
						lines.push(`  - ${f}`);
					}
				}

				if (snapshotData.hypotheses.length > 0) {
					lines.push("Hypotheses:");
					for (const h of snapshotData.hypotheses) {
						lines.push(`  - ${h}`);
					}
				}

				if (snapshotData.todos.length > 0) {
					lines.push("Todos:");
					for (const t of snapshotData.todos) {
						lines.push(`  - ${t}`);
					}
				}

				if (snapshotData.validation_results.length > 0) {
					lines.push("Validation results:");
					for (const v of snapshotData.validation_results) {
						lines.push(`  - ${v}`);
					}
				}

				if (snapshotData.notes) {
					lines.push("Notes:");
					lines.push(`  - ${snapshotData.notes}`);
				}

				return { content: [{ type: "text", text: lines.join("\n") }], details: { count: entries.length } };
			}

			if (params.action === "clear") {
				pi.appendEntry(SCRATCH_KEY, JSON.stringify([]));
				return { content: [{ type: "text", text: "Scratchpad cleared." }], details: { count: 0 } };
			}

			throw new Error(`Unknown action: ${params.action}. Use read, write, clear, snapshot, or restore.`);
		},
	});
}
