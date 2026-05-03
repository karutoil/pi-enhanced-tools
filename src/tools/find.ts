/**
 * Find tool — structured file/directory search
 */

import { Type } from "typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { runCommand } from "../utils.js";

export function registerFindTool(pi: ExtensionAPI) {
	pi.registerTool({
		name: "find",
		label: "Find",
		description: "Search for files and directories by name, type, or pattern. Returns structured results with paths. Much cleaner than bash find for navigating projects.",
		promptSnippet: "Find files and directories by name or pattern",
		promptGuidelines: [
			"Use find instead of bash find or ls when searching for specific files or directories.",
			"Use find to locate configuration files, source files, or test files by name pattern.",
			"Use find with --type f to find files, --type d to find directories.",
			"Combine find with outline: find locates the file, outline shows its structure, read shows implementation.",
			"Use --maxdepth to limit search depth and avoid noise in node_modules or build directories.",
		],
		parameters: Type.Object({
			pattern: Type.String({ description: "Name pattern to match (supports * and ? wildcards)" }),
			path: Type.Optional(Type.String({ description: "Directory to search in (default: cwd)" })),
			type: Type.Optional(Type.String({ description: "Type filter: 'f' for files, 'd' for directories" })),
			maxdepth: Type.Optional(Type.Number({ description: "Maximum search depth (default: 3)" })),
			limit: Type.Optional(Type.Number({ description: "Maximum results to return (default: 50)" })),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			const searchPath = params.path ?? ".";
			const maxDepth = params.maxdepth ?? 3;
			const limit = params.limit ?? 50;
			const typeFilter = params.type;

			// Build find command (no shell — safe from metacharacter injection)
			const args: string[] = [searchPath, "-maxdepth", String(maxDepth)];
			if (typeFilter) args.push("-type", typeFilter);
			args.push("-name", params.pattern);

			const result = await runCommand("find", args, { cwd: ctx.cwd, signal, timeout: 10000 });
			// Permission errors go to stderr — ignore them
			const lines = result.stdout.split("\n").filter(Boolean).slice(0, limit);
			if (lines.length === 0) {
				return { content: [{ type: "text", text: "No matches found." }], details: { count: 0 } };
			}

			// Group by directory for readability
			const byDir = new Map<string, string[]>();
			for (const line of lines) {
				const rel = line.replace(ctx.cwd + "/", "").replace(/^\.\//, "");
				const dir = rel.includes("/") ? rel.substring(0, rel.lastIndexOf("/")) || "." : ".";
				const name = rel.includes("/") ? rel.substring(rel.lastIndexOf("/") + 1) : rel;
				if (!byDir.has(dir)) byDir.set(dir, []);
				byDir.get(dir)!.push(name);
			}

			const out: string[] = [];
			out.push(`Found ${lines.length} match(es):`);
			out.push("");

			for (const [dir, names] of byDir) {
				out.push(`${dir}/`);
				for (const name of names) {
					out.push(`  ${name}`);
				}
			}

			return { content: [{ type: "text", text: out.join("\n") }], details: { count: lines.length } };
		},
	});
}
