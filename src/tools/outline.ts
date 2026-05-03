/**
 * Outline tool — show file structure without reading full content
 */

import { readFile, stat, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { detectLanguage, parseImports, parseFunctionDeclarations, parseClassDeclarations, truncateHead, formatSize } from "../utils.js";

export function registerOutlineTool(pi: ExtensionAPI) {
	pi.registerTool({
		name: "outline",
		label: "Outline",
		description: "Show the structure of a source file: imports, functions, classes, types, and exports. Does not read implementation details. Much faster than 'read' for understanding file organization.",
		promptSnippet: "Show file structure (imports, functions, classes) without implementation details",
		promptGuidelines: [
			"Use outline instead of read when you only need to know what a file contains, not how it's implemented.",
			"Use outline before read to decide which specific sections to read.",
			"Use outline to find where a function or class is defined before targeting it with read.",
			"Do not use outline if you need to see the actual code body — use read instead.",
		],
		parameters: Type.Object({
			path: Type.String({ description: "Path to the source file to outline" }),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const absPath = resolve(ctx.cwd, params.path);

			// Check if path is a directory
			const pathStat = await stat(absPath);
			if (pathStat.isDirectory()) {
				const entries = await readdir(absPath, { withFileTypes: true });
				const files = entries
					.filter(e => e.isFile() && !e.name.startsWith("."))
					.map(e => e.name)
					.slice(0, 50);
				const dirs = entries
					.filter(e => e.isDirectory() && !e.name.startsWith("."))
					.map(e => e.name + "/")
					.slice(0, 20);

				const lines: string[] = [];
				lines.push(`${params.path}/ is a directory.`);
				lines.push("");
				lines.push("Use outline on a specific file, or use 'project' for a high-level overview.");
				lines.push("");
				if (dirs.length > 0) {
					lines.push(`Subdirectories (${dirs.length}):`);
					for (const d of dirs) lines.push(`  ${d}`);
					lines.push("");
				}
				if (files.length > 0) {
					lines.push(`Files (${files.length}):`);
					for (const f of files) lines.push(`  ${f}`);
				}
				return { content: [{ type: "text", text: lines.join("\n").trim() }], details: { isDirectory: true, files: files.length, dirs: dirs.length } };
			}

			const content = await readFile(absPath, "utf-8");
			const lang = detectLanguage(params.path);

			const imports = parseImports(content, lang);
			const functions = parseFunctionDeclarations(content, lang);
			const classes = parseClassDeclarations(content, lang);

			const lines: string[] = [];
			lines.push(`File: ${params.path}`);
			lines.push(`Language: ${lang ?? "unknown"}`);
			lines.push(`Lines: ${content.split("\n").length}`);
			lines.push("");

			if (imports.length > 0) {
				lines.push(`Imports (${imports.length}):`);
				for (const imp of imports.slice(0, 30)) lines.push(`  ${imp}`);
				if (imports.length > 30) lines.push(`  ... and ${imports.length - 30} more`);
				lines.push("");
			}

			if (classes.length > 0) {
				lines.push(`Types/Classes (${classes.length}):`);
				for (const c of classes.slice(0, 30)) lines.push(`  ${c}`);
				if (classes.length > 30) lines.push(`  ... and ${classes.length - 30} more`);
				lines.push("");
			}

			if (functions.length > 0) {
				lines.push(`Functions (${functions.length}):`);
				for (const f of functions.slice(0, 30)) lines.push(`  ${f}()`);
				if (functions.length > 30) lines.push(`  ... and ${functions.length - 30} more`);
				lines.push("");
			}

			const result = lines.join("\n").trim();
			return { content: [{ type: "text", text: result }], details: { imports: imports.length, functions: functions.length, classes: classes.length } };
		},
	});
}
