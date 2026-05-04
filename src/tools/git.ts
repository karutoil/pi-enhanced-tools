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
		description: "Run git commands with structured output. Supports status, diff, log, branch, show, blame, and archeology operations. Returns summarized results instead of raw git output.",
		promptSnippet: "Check git status, diff, or history in a structured way",
		promptGuidelines: [
			"Use git status to see what files have been modified before making more changes.",
			"Use git diff to review your changes before finishing a task.",
			"Use git log to understand recent changes to a file or the project.",
			"Use git blame to find who last modified a specific line and why.",
			"Use git archeology to trace when a line of code was introduced and how it evolved.",
			"Do not use git for destructive operations (reset, clean, force-push) unless explicitly asked.",
			"Prefer git over bash for git commands — it gives structured, truncated output.",
		],
		parameters: Type.Object({
			subcommand: Type.String({ description: "Git subcommand: status, diff, log, branch, show, blame, archeology" }),
			args: Type.Optional(Type.String({ description: "Additional arguments for the subcommand (e.g., --oneline, -5, src/auth.ts)" })),
			file: Type.Optional(Type.String({ description: "File path for blame/archeology subcommands" })),
			line: Type.Optional(Type.Number({ description: "Line number for blame (specific line) or archeology (required)" })),
			pattern: Type.Optional(Type.String({ description: "Search pattern for archeology pickaxe mode (-S search)" })),
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
				case "blame": {
					const blameFile = (params as any).file as string | undefined;
					const blameLine = (params as any).line as number | undefined;
					if (!blameFile) {
						text = "Error: 'file' parameter is required for git blame.";
						break;
					}
					const blameArgs = blameLine ? ["blame", "-L", `${blameLine},${blameLine}`, blameFile] : ["blame", blameFile];
					const result = await runCommand("git", blameArgs, { cwd: ctx.cwd, signal });
					if (!result.stdout.trim()) {
						text = `No blame information for '${blameFile}'. File may not exist in the repository.`;
						break;
					}
					const blameLines = result.stdout.trim().split("\n");
					const entries: string[] = [];
					for (const line of blameLines) {
						const contentMatch = line.match(/\)\s+(.+)$/);
						const lineContent = contentMatch ? contentMatch[1] : "";
						const hashMatch = line.match(/^([0-9a-f]{40})\s+/);
						const authorMatch = line.match(/(\([^)]+\))/);
						if (hashMatch) {
							const hash = hashMatch[1];
							const authorInfo = authorMatch ? authorMatch[1].trim() : "";
							entries.push(`  ${hash.slice(0, 7)} | ${authorInfo}`);
							if (lineContent) entries.push(`    → ${lineContent}`);
						} else {
							if (!line.match(/^\s+\d+\s+/)) {
								entries.push(`  ${line}`);
							}
						}
					}
					text = `Blame for '${blameFile}'${blameLine ? ` (line ${blameLine})` : ''}:\n\n`;
					text += entries.join("\n");
					if (blameLine) {
						const firstHash = blameLines[0]?.match(/^([0-9a-f]{40})/)?.[1];
						if (firstHash) {
							const showResult = await runCommand("git", ["show", "--format=%H%n%s%n%an%n%ad", "--no-patch", firstHash], {
								cwd: ctx.cwd, signal,
							});
							if (showResult.stdout.trim()) {
								const showLines = showResult.stdout.trim().split("\n");
								const fullHash = showLines[0];
								const subject = showLines[1] || "(no subject)";
								const author = showLines[2] || "(unknown author)";
								const date = showLines[3] || "(unknown date)";
								text += `\n\n---\nCommit: ${fullHash}\nSubject: ${subject}\nAuthor: ${author}\nDate: ${date}`;
							}
						}
					}
					break;
				}
				case "archeology": {
					const archeoFile = (params as any).file as string | undefined;
					const archeoLine = (params as any).line as number | undefined;
					const archeoPattern = (params as any).pattern as string | undefined;
					if (!archeoFile && !archeoPattern) {
						text = "Error: Either 'file' or 'pattern' parameter is required for git archeology.";
						break;
					}
					if (archeoFile && archeoLine) {
						const logResult = await runCommand("git", ["log", "-L", `${archeoLine},${archeoLine}:${archeoFile}`, "--oneline"], {
							cwd: ctx.cwd, signal,
						});
						const output = logResult.stdout.trim();
						if (!output) {
							text = `No history found for line ${archeoLine} in '${archeoFile}'. The line may have always had this content or the file was recently added.`;
							break;
						}
						const commitLines = output.split("\n").filter(l => l.match(/^[0-9a-f]+\s+/));
						text = `Line history for line ${archeoLine} in '${archeoFile}' (introduced/changed in ${commitLines.length} commit(s)):\n\n`;
						text += commitLines.join("\n");
					} else if (archeoPattern) {
						const logResult = await runCommand("git", ["log", "-p", "-S", archeoPattern, "--oneline"], {
							cwd: ctx.cwd, signal,
						});
						const output = logResult.stdout.trim();
						if (!output) {
							text = `No commits found that introduced or removed '${archeoPattern}'.`;
							break;
						}
						const commitLines = output.split("\n").filter(l => l.match(/^[0-9a-f]+\s+/));
						text = `Pickaxe search for '${archeoPattern}' — ${commitLines.length} commit(s) that changed occurrences:\n\n`;
						text += commitLines.join("\n");
					}
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
