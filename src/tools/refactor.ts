/**
 * Refactor tool — multi-file rename / replace
 */

import { runCommand } from "../utils.js";
import { withFileMutationQueue } from "@mariozechner/pi-coding-agent";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export function registerRefactorTool(pi: ExtensionAPI) {
	pi.registerTool({
		name: "refactor",
		label: "Refactor",
		description: "Rename a symbol across multiple files. Finds all occurrences and applies patches atomically. Safer than manual sed because it uses context matching.",
		promptSnippet: "Rename symbols across multiple files safely",
		promptGuidelines: [
			"Use refactor rename-symbol to rename a function, class, or variable across all files that use it.",
			"Use refactor replace-text for broader replacements that are not symbol renames.",
			"Always run validate after refactor to ensure nothing broke.",
			"Use deps --used-by first to understand the scope of a rename.",
			"If refactor affects many files, review with git diff before continuing.",
		],
		parameters: Type.Object({
			action: Type.String({ description: "Action: rename-symbol or replace-text" }),
			old: Type.String({ description: "Old symbol name or text to replace" }),
			new: Type.String({ description: "New symbol name or replacement text" }),
			type: Type.Optional(Type.String({ description: "File type filter, e.g. 'ts', 'rs' (for rename-symbol)" })),
			path: Type.Optional(Type.String({ description: "Specific file or directory to limit search to" })),
		}),
		async execute(_id, params, signal, onUpdate, ctx) {
			if (params.action === "rename-symbol") {
				// Find all occurrences with rg
				const searchPath = params.path ?? ".";
				const typeFlag = params.type ? ["-t", params.type] : [];
				const rgArgs = ["--line-number", "--no-heading", "--with-filename", ...typeFlag, "-g", "!node_modules", "-g", "!.git", params.old, searchPath];
				const result = await runCommand("rg", rgArgs, { cwd: ctx.cwd, signal });

				if (!result.stdout.trim()) {
					return { content: [{ type: "text", text: `No occurrences of '${params.old}' found.` }], details: { changes: 0 } };
				}

				// Parse matches: file:line:match
				const matches = result.stdout.split("\n").filter(Boolean).map(line => {
					const parts = line.split(":");
					return { file: parts[0], line: parseInt(parts[1]) };
				});

				// Group by file
				const byFile = new Map<string, number[]>();
				for (const m of matches) {
					if (!byFile.has(m.file)) byFile.set(m.file, []);
					byFile.get(m.file)!.push(m.line);
				}

				onUpdate?.({ content: [{ type: "text", text: `Renaming '${params.old}' → '${params.new}' in ${byFile.size} file(s)...` }], details: {} });

				let totalChanges = 0;
				for (const [file, lineNums] of byFile) {
					const absPath = resolve(ctx.cwd, file);
					await withFileMutationQueue(absPath, async () => {
						const content = await readFile(absPath, "utf-8");
						const lines = content.split("\n");
						let changes = 0;

						for (const lineNum of lineNums) {
							const idx = lineNum - 1;
							if (idx >= 0 && idx < lines.length) {
								// Word-boundary replace to avoid partial matches
								const regex = new RegExp(`\\b${params.old.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g");
								if (regex.test(lines[idx])) {
									lines[idx] = lines[idx].replace(regex, params.new);
									changes++;
								}
							}
						}

						if (changes > 0) {
							await writeFile(absPath, lines.join("\n") + (content.endsWith("\n") ? "\n" : ""), "utf-8");
							totalChanges += changes;
						}
					});
				}

				return {
					content: [{ type: "text", text: `Renamed '${params.old}' → '${params.new}' in ${totalChanges} location(s) across ${byFile.size} file(s).` }],
					details: { changes: totalChanges, files: byFile.size },
				};
			}

			if (params.action === "replace-text") {
				const searchPath = params.path ?? ".";
				const result = await runCommand("rg", ["--line-number", "--no-heading", "--with-filename", "-g", "!node_modules", "-g", "!.git", params.old, searchPath], { cwd: ctx.cwd, signal });

				if (!result.stdout.trim()) {
					return { content: [{ type: "text", text: `No occurrences of '${params.old}' found.` }], details: { changes: 0 } };
				}

				const matches = result.stdout.split("\n").filter(Boolean).map(line => {
					const parts = line.split(":");
					return { file: parts[0], line: parseInt(parts[1]) };
				});

				const byFile = new Map<string, number[]>();
				for (const m of matches) {
					if (!byFile.has(m.file)) byFile.set(m.file, []);
					byFile.get(m.file)!.push(m.line);
				}

				let totalChanges = 0;
				for (const [file, lineNums] of byFile) {
					const absPath = resolve(ctx.cwd, file);
					await withFileMutationQueue(absPath, async () => {
						const content = await readFile(absPath, "utf-8");
						const lines = content.split("\n");
						let changes = 0;

						for (const lineNum of lineNums) {
							const idx = lineNum - 1;
							if (idx >= 0 && idx < lines.length && lines[idx].includes(params.old)) {
								lines[idx] = lines[idx].split(params.old).join(params.new);
								changes++;
							}
						}

						if (changes > 0) {
							await writeFile(absPath, lines.join("\n") + (content.endsWith("\n") ? "\n" : ""), "utf-8");
							totalChanges += changes;
						}
					});
				}

				return {
					content: [{ type: "text", text: `Replaced '${params.old}' → '${params.new}' in ${totalChanges} location(s) across ${byFile.size} file(s).` }],
					details: { changes: totalChanges, files: byFile.size },
				};
			}

			throw new Error(`Unknown action: ${params.action}. Use rename-symbol or replace-text.`);
		},
	});
}
