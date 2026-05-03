/**
 * Deps tool — dependency graph (imports / exports)
 */

import { readFile, readdir } from "node:fs/promises";
import { resolve, relative } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { detectLanguage, parseImports, runCommand, truncateHead } from "../utils.js";

export function registerDepsTool(pi: ExtensionAPI) {
	pi.registerTool({
		name: "deps",
		label: "Deps",
		description: "Show what a file imports and what files import it. Helps understand cross-file dependencies before refactoring.",
		promptSnippet: "Show file import/export dependencies",
		promptGuidelines: [
			"Use deps before renaming a function or class to find all files that import it.",
			"Use deps to understand the module graph of a project.",
			"Use deps --used-by to find all callers of a module before changing its API.",
			"Use deps alongside rg to find specific symbol usage across the codebase.",
		],
		parameters: Type.Object({
			path: Type.String({ description: "Path to the file to analyze" }),
			mode: Type.String({ description: "Mode: imports (what this file imports), used-by (what files import this), or both" }),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			const absPath = resolve(ctx.cwd, params.path);
			const relPath = relative(ctx.cwd, absPath);
			const mode = params.mode;
			const lines: string[] = [];

			if (mode === "imports" || mode === "both") {
				const content = await readFile(absPath, "utf-8");
				const lang = detectLanguage(params.path);
				const imports = parseImports(content, lang);
				lines.push(`Imports in ${params.path}:`);
				if (imports.length === 0) lines.push("  (none)");
				else for (const imp of imports) lines.push(`  ${imp}`);
				lines.push("");
			}

			if (mode === "used-by" || mode === "both") {
				// Search for imports of this file
				const fileName = params.path.replace(/^\.\/|\/.*$/g, ""); // rough basename
				const searchPatterns = [
					params.path.replace(/\.[^.]+$/, ""), // without extension
					params.path,
					fileName,
				];
				const found = new Set<string>();

				for (const pattern of searchPatterns) {
					const result = await runCommand("rg", ["--files-with-matches", "--type", detectLanguage(params.path) ?? "", "-g", "!node_modules", "-g", "!.git", pattern, "."], { cwd: ctx.cwd, signal }).catch(() => null);
					if (result?.stdout) {
						for (const file of result.stdout.split("\n").filter(Boolean)) {
							if (file !== params.path) found.add(file);
						}
					}
				}

				lines.push(`Files importing ${params.path}:`);
				if (found.size === 0) lines.push("  (none found)");
				else for (const f of found) lines.push(`  ${f}`);
			}

			return { content: [{ type: "text", text: lines.join("\n").trim() }], details: { mode, file: params.path } };
		},
	});
}
