/**
 * Rg tool — enhanced code search with ripgrep or grep fallback
 */

import { runCommand, truncateHead, formatSize } from "../utils.js";
import { Type } from "typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export function registerRgTool(pi: ExtensionAPI) {
	pi.registerTool({
		name: "rg",
		label: "Rg",
		description: "Search for patterns across files using ripgrep (or grep fallback). Returns matching files with line numbers and context. Supports file-type filtering and exclusion of build artifacts.",
		promptSnippet: "Search code across files with context and line numbers",
		promptGuidelines: [
			"Use rg instead of bash grep for cross-file searches — it gives structured output with line numbers and context.",
			"Use rg to find where a function, class, or variable is defined or used.",
			"Use rg before read to locate the exact file and line to read.",
			"Use rg with a specific type filter (e.g., --type ts) to avoid noise in build artifacts.",
			"Combine rg with outline to quickly understand a codebase: rg finds the file, outline shows its structure, read shows the implementation.",
		],
		parameters: Type.Object({
			pattern: Type.String({ description: "Search pattern (ripgrep regex)" }),
			path: Type.Optional(Type.String({ description: "Directory or file to search in (default: cwd)" })),
			type: Type.Optional(Type.String({ description: "File type filter, e.g. 'ts', 'js', 'rs', 'py'" })),
			context: Type.Optional(Type.Number({ description: "Lines of context around each match (default: 2)" })),
			max_results: Type.Optional(Type.Number({ description: "Maximum number of matches to return (default: 50)" })),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			const pattern = params.pattern;
			const searchPath = params.path ? params.path : ".";
			const contextLines = params.context ?? 2;
			const maxResults = params.max_results ?? 50;

			// Try ripgrep first, fallback to grep
			let useRg = true;
			try {
				await runCommand("which", ["rg"], { signal });
			} catch {
				useRg = false;
			}

			const args: string[] = [];
			if (useRg) {
				args.push("--line-number", "--no-heading");
				if (contextLines > 0) args.push("-C", String(contextLines));
				if (params.type) args.push("-t", params.type);
				args.push("--max-count", String(maxResults));
				args.push("--color", "never");
				// Exclude common dirs
				args.push("-g", "!node_modules", "-g", "!.git", "-g", "!target", "-g", "!dist", "-g", "!build");
				args.push(pattern, searchPath);
			} else {
				// Fallback to grep -r
				args.push("-r", "-n");
				if (contextLines > 0) args.push("-C", String(contextLines));
				args.push("--exclude-dir=node_modules", "--exclude-dir=.git", "--exclude-dir=target", "--exclude-dir=dist", "--exclude-dir=build");
				args.push(pattern, searchPath);
			}

			const result = await runCommand(useRg ? "rg" : "grep", args, { cwd: ctx.cwd, signal });
			const output = result.stdout || result.stderr || "(no output)";

			const truncated = truncateHead(output, { maxLines: 2000, maxBytes: 50 * 1024 });
			let text = truncated.content;
			if (truncated.truncated) {
				text += `\n\n[Output truncated: ${truncated.outputLines} of ${truncated.totalLines} lines (${formatSize(truncated.outputBytes)} of ${formatSize(truncated.totalBytes)})]`;
			}

			const matchCount = output.split("\n").filter(l => l.match(/^[^:]+:\d+[:\-]/)).length;
			return {
				content: [{ type: "text", text: text || "No matches found." }],
				details: { matches: matchCount, tool: useRg ? "ripgrep" : "grep", exitCode: result.exitCode },
			};
		},
	});
}
