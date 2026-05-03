/**
 * Validate tool — compile / typecheck / lint
 */

import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { runCommand, truncateHead, formatSize } from "../utils.js";
import { Type } from "typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

interface ValidatorConfig {
	name: string;
	files: string[];
	command: string[];
	parseErrors: (output: string) => Array<{ file: string; line?: number; col?: number; message: string; severity: string }>;
}

function parseTscErrors(output: string) {
	const errors: Array<{ file: string; line?: number; col?: number; message: string; severity: string }> = [];
	const lines = output.split("\n");
	for (const line of lines) {
		const match = line.match(/^(.+?)\((\d+),(\d+)\):\s*(error|warning)\s+TS\d+:\s*(.+)$/);
		if (match) {
			errors.push({ file: match[1], line: parseInt(match[2]), col: parseInt(match[3]), severity: match[4], message: match[5] });
		}
	}
	return errors;
}

function parseCargoErrors(output: string) {
	const errors: Array<{ file: string; line?: number; col?: number; message: string; severity: string }> = [];
	const lines = output.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const match = lines[i].match(/^\s*-->\s+(.+?):(\d+):(\d+)/);
		if (match && i > 0) {
			errors.push({ file: match[1], line: parseInt(match[2]), col: parseInt(match[3]), severity: "error", message: lines[i - 1].trim() });
		}
	}
	return errors;
}

function parseGoErrors(output: string) {
	const errors: Array<{ file: string; line?: number; col?: number; message: string; severity: string }> = [];
	const lines = output.split("\n");
	for (const line of lines) {
		const match = line.match(/^(.+?):(\d+):(\d+):\s*(.+)$/);
		if (match) {
			errors.push({ file: match[1], line: parseInt(match[2]), col: parseInt(match[3]), severity: "error", message: match[4] });
		}
	}
	return errors;
}

function parsePythonErrors(output: string) {
	const errors: Array<{ file: string; line?: number; col?: number; message: string; severity: string }> = [];
	const lines = output.split("\n");
	for (const line of lines) {
		const match = line.match(/^(.+?):(\d+):(\d+):\s*(E|W|F)\d+\s+(.+)$/);
		if (match) {
			errors.push({ file: match[1], line: parseInt(match[2]), col: parseInt(match[3]), severity: match[4] === "E" || match[4] === "F" ? "error" : "warning", message: match[5] });
		}
	}
	return errors;
}

async function detectValidators(cwd: string): Promise<ValidatorConfig[]> {
	const validators: ValidatorConfig[] = [];

	if (await fileExists(resolve(cwd, "package.json"))) {
		if (await fileExists(resolve(cwd, "tsconfig.json"))) {
			validators.push({
				name: "TypeScript",
				files: ["tsconfig.json"],
				command: ["npx", "tsc", "--noEmit"],
				parseErrors: parseTscErrors,
			});
		}
		if (await fileExists(resolve(cwd, ".eslintrc.js")) || await fileExists(resolve(cwd, ".eslintrc.json")) || await fileExists(resolve(cwd, "eslint.config.js"))) {
			validators.push({
				name: "ESLint",
				files: [".eslintrc.js"],
				command: ["npx", "eslint", ".", "--format", "compact"],
				parseErrors: parseTscErrors, // compact format is similar
			});
		}
	}

	if (await fileExists(resolve(cwd, "Cargo.toml"))) {
		validators.push({
			name: "Rust",
			files: ["Cargo.toml"],
			command: ["cargo", "check"],
			parseErrors: parseCargoErrors,
		});
	}

	if (await fileExists(resolve(cwd, "go.mod"))) {
		validators.push({
			name: "Go",
			files: ["go.mod"],
			command: ["go", "build", "./..."],
			parseErrors: parseGoErrors,
		});
	}

	if (await fileExists(resolve(cwd, "pyproject.toml")) || await fileExists(resolve(cwd, "setup.py"))) {
		validators.push({
			name: "Python",
			files: ["pyproject.toml"],
			command: ["python", "-m", "py_compile", "."], // Simple compile check
			parseErrors: parsePythonErrors,
		});
	}

	return validators;
}

async function fileExists(path: string): Promise<boolean> {
	try { await access(path); return true; } catch { return false; }
}

export function registerValidateTool(pi: ExtensionAPI) {
	pi.registerTool({
		name: "validate",
		label: "Validate",
		description: "Compile, typecheck, or lint the project. Auto-detects the project type and runs the appropriate validator (tsc, cargo check, go build, etc). Reports errors with file:line locations.",
		promptSnippet: "Compile or typecheck the project and report errors",
		promptGuidelines: [
			"Use validate after making code changes to catch compile-time or type errors.",
			"Use validate before declaring a refactor complete.",
			"If validate reports errors, fix them in order — start with the first error since later errors may be caused by it.",
			"Use validate alongside test: validate catches static errors, test catches runtime behavior.",
			"If the auto-detected validator is wrong, run the correct command manually with bash.",
		],
		parameters: Type.Object({
			command: Type.Optional(Type.String({ description: "Override auto-detection with a specific command (e.g. 'npx tsc --noEmit')" })),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			let validators: ValidatorConfig[];

			if (params.command) {
				const parts = params.command.split(" ");
				validators = [{
					name: "Custom",
					files: [],
					command: parts,
					parseErrors: (out: string) => {
						// Generic parser: look for file:line patterns
						const errs: Array<{ file: string; line?: number; col?: number; message: string; severity: string }> = [];
						for (const line of out.split("\n")) {
							const match = line.match(/^(.+?):(\d+)(?::(\d+))?:\s*(.+)$/);
							if (match) errs.push({ file: match[1], line: parseInt(match[2]), col: match[3] ? parseInt(match[3]) : undefined, severity: "error", message: match[4] });
						}
						return errs;
					},
				}];
			} else {
				validators = await detectValidators(ctx.cwd);
				if (validators.length === 0) throw new Error("Could not auto-detect project type. No package.json, Cargo.toml, go.mod, or pyproject.toml found. Specify command manually.");
			}

			const lines: string[] = [];
			let totalErrors = 0;
			let totalWarnings = 0;

			for (const validator of validators) {
				const result = await runCommand(validator.command[0], validator.command.slice(1), { cwd: ctx.cwd, signal, timeout: 120000 });
				const output = result.stdout + (result.stderr ? "\n" + result.stderr : "");
				const errors = validator.parseErrors(output);

				const errCount = errors.filter(e => e.severity === "error").length;
				const warnCount = errors.filter(e => e.severity === "warning").length;
				totalErrors += errCount;
				totalWarnings += warnCount;

				lines.push(`${validator.name}: ${errCount} error(s), ${warnCount} warning(s)`);

				if (errors.length > 0) {
					for (const err of errors.slice(0, 20)) {
						const loc = `${err.file}${err.line ? `:${err.line}` : ""}${err.col ? `:${err.col}` : ""}`;
						lines.push(`  ${err.severity === "error" ? "✗" : "⚠"} ${loc}: ${err.message.slice(0, 120)}`);
					}
					if (errors.length > 20) lines.push(`  ... and ${errors.length - 20} more`);
				}
				lines.push("");
			}

			lines.unshift(`Validation: ${totalErrors} error(s), ${totalWarnings} warning(s) total`);
			lines.push("");

			return {
				content: [{ type: "text", text: lines.join("\n").trim() }],
				details: { errors: totalErrors, warnings: totalWarnings },
			};
		},
	});
}
