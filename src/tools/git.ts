/**
 * Git tool — semantic git operations
 */

import { runCommand } from "../utils.js";
import { Type } from "typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export function registerGitTool(pi: ExtensionAPI) {
	pi.registerTool({
		name: "git",
		label: "Git",
		description: "Run git commands with structured output. Supports status, diff, log, and branch operations. Returns summarized results instead of raw git output.",
		promptSnippet: "Check git status, diff, or history in a structured way",
		promptGuidelines: [
			"Use git status to see what files have been modified before making more changes.",
			"Use git diff to review your changes before finishing a task.",
			"Use git log to understand recent changes to a file or the project.",
			"Do not use git for destructive operations (reset, clean, force-push) unless explicitly asked.",
			"Prefer git over bash for git commands — it gives structured, truncated output.",
		],
		parameters: Type.Object({
			subcommand: Type.String({ description: "Git subcommand: status, diff, log, branch, show" }),
			args: Type.Optional(Type.String({ description: "Additional arguments for the subcommand (e.g., --oneline, -5, src/auth.ts)" })),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			const sub = params.subcommand;
			const extraArgs = params.args ? params.args.split(" ") : [];
			let args: string[] = [sub, ...extraArgs];
			let text = "";

			switch (sub) {
				case "status": {
					args = ["status", "--short", ...extraArgs];
					const result = await runCommand("git", args, { cwd: ctx.cwd, signal });
					const lines = result.stdout.trim().split("\n").filter(Boolean);
					if (lines.length === 0) {
						text = "Working tree clean — no changes.";
					} else {
						const staged = lines.filter(l => l.match(/^[MADRC]/));
						const unstaged = lines.filter(l => l.match(/^.[MADRC]/));
						const untracked = lines.filter(l => l.startsWith("??"));
						text = `Changes: ${lines.length} file(s)\n`;
						if (staged.length > 0) text += `\nStaged (${staged.length}):\n${staged.map(l => "  " + l).join("\n")}`;
						if (unstaged.length > 0) text += `\n\nModified (${unstaged.length}):\n${unstaged.map(l => "  " + l).join("\n")}`;
						if (untracked.length > 0) text += `\n\nUntracked (${untracked.length}):\n${untracked.map(l => "  " + l).join("\n")}`;
					}
					break;
				}
				case "diff": {
					args = ["diff", ...extraArgs];
					const result = await runCommand("git", args, { cwd: ctx.cwd, signal });
					if (!result.stdout.trim()) {
						text = "No differences.";
					} else {
						// Count files changed
						const files = result.stdout.match(/^diff --git/g);
						const fileCount = files?.length ?? 0;
						// Summarize: show files changed + stat
						const statResult = await runCommand("git", ["diff", "--stat", ...extraArgs], { cwd: ctx.cwd, signal });
						text = `${fileCount} file(s) changed:\n${statResult.stdout.trim()}`;
					}
					break;
				}
				case "log": {
					args = ["log", "--oneline", "-20", ...extraArgs];
					const result = await runCommand("git", args, { cwd: ctx.cwd, signal });
					text = result.stdout.trim() || "No commits.";
					break;
				}
				case "branch": {
					const result = await runCommand("git", ["branch", "-vv", ...extraArgs], { cwd: ctx.cwd, signal });
					text = result.stdout.trim() || "No branches.";
					break;
				}
				case "show": {
					const result = await runCommand("git", ["show", "--stat", "-p", ...extraArgs], { cwd: ctx.cwd, signal });
					text = result.stdout.trim() || "Nothing to show.";
					break;
				}
				default: {
					const result = await runCommand("git", args, { cwd: ctx.cwd, signal });
					text = result.stdout.trim() || result.stderr.trim() || "(no output)";
				}
			}

			return { content: [{ type: "text", text }], details: { subcommand: sub } };
		},
	});
}
