/**
 * Build tool — compile/bundle projects with structured output
 */

import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runCommand, truncateHead, formatSize } from "../utils.js";
import { Type } from "typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

interface BuildResult {
	status: "success" | "failed" | "warning";
	errors: Array<{ message: string; file?: string; line?: number }>;
	warnings: Array<{ message: string; file?: string; line?: number; code?: string }>;
	stats: Array<{ label: string; value: string }>;
}

async function detectBuildCommand(cwd: string): Promise<string[] | null> {
	// Check package.json scripts
	try {
		const pkg = JSON.parse(await readFile(resolve(cwd, "package.json"), "utf-8"));
		if (pkg.scripts?.build) return ["npm", "run", "build"];
		if (pkg.scripts?.compile) return ["npm", "run", "compile"];
	} catch { /* ignore */ }

	// Check Makefile
	try {
		await access(resolve(cwd, "Makefile"));
		return ["make", "build"];
	} catch { /* ignore */ }

	// Check Cargo
	try {
		await access(resolve(cwd, "Cargo.toml"));
		return ["cargo", "build"];
	} catch { /* ignore */ }

	// Check Go
	try {
		await access(resolve(cwd, "go.mod"));
		return ["go", "build", "./..."];
	} catch { /* ignore */ }

	return null;
}

function parseBuildOutput(output: string, command: string[]): BuildResult {
	const result: BuildResult = {
		status: "success",
		errors: [],
		warnings: [],
		stats: [],
	};

	const lines = output.split("\n");

	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) continue;

		// Vite/Rollup: [ERROR] or [WARNING]
		const viteError = line.match(/\[ERROR\]\s*(.+)/);
		if (viteError) {
			result.errors.push({ message: viteError[1] });
			result.status = "failed";
			continue;
		}

		const viteWarn = line.match(/\[(WARNING|INEFFECTIVE_[A-Z_]+)\]\s*(.+)/);
		if (viteWarn) {
			const msg = viteWarn[2];
			// Extract file from warnings like "src/services/api/client.ts is dynamically imported..."
			const fileMatch = msg.match(/^([\w/.-]+\.\w+)/) || msg.match(/(?:by|in)\s+([\w/.-]+\.\w+)/);
			result.warnings.push({
				message: msg,
				code: viteWarn[1],
				file: fileMatch ? fileMatch[1] : undefined,
			});
			if (result.status === "success") result.status = "warning";
			continue;
		}

		// TypeScript/Vite errors: src/file.ts:12:34 - error TS...
		const tsError = line.match(/^(.+?\.(ts|tsx|js|jsx)):(\d+)(?::(\d+))?\s*-\s*error\s*(.+)/i);
		if (tsError) {
			result.errors.push({
				file: tsError[1],
				line: parseInt(tsError[3]),
				message: tsError[5],
			});
			result.status = "failed";
			continue;
		}

		// Rust errors
		const rustError = line.match(/^error\[E\d+\]:\s*(.+)/);
		if (rustError) {
			result.errors.push({ message: rustError[1] });
			result.status = "failed";
			continue;
		}

		// Go errors
		const goError = line.match(/^(.+?\.go):(\d+):(\d+):\s*error:\s*(.+)/);
		if (goError) {
			result.errors.push({
				file: goError[1],
				line: parseInt(goError[2]),
				message: goError[4],
			});
			result.status = "failed";
			continue;
		}

		// Build stats: "dist/assets/index-xxx.js  819.68 kB │ gzip: 242.49 kB"
		const statMatch = line.match(/^\s*(dist\/.+?)\s+(\d+\.?\d*\s*(?:kB|MB|B|gb))\s*(?:│\|)?\s*(.*)/);
		if (statMatch) {
			result.stats.push({
				label: statMatch[1].trim(),
				value: `${statMatch[2]}${statMatch[3] ? ` (${statMatch[3]})` : ""}`,
			});
			continue;
		}

		// Build time: "built in 1.18s" or "✓ built in 1.18s"
		const timeMatch = line.match(/built in\s+([\d.]+s)/);
		if (timeMatch) {
			result.stats.push({ label: "Build time", value: timeMatch[1] });
			continue;
		}

		// Error markers (generic)
		if (line.match(/error|Error|ERROR/) && !line.match(/errorHandler|onError/)) {
			// Only capture if we haven't already parsed it above
			if (!result.errors.some(e => e.message === trimmed)) {
				result.errors.push({ message: trimmed.slice(0, 200) });
				result.status = "failed";
			}
		}
	}

	// Deduplicate
	result.errors = result.errors.filter((e, i, arr) =>
		i === arr.findIndex(x => x.message === e.message && x.file === e.file)
	);
	result.warnings = result.warnings.filter((w, i, arr) =>
		i === arr.findIndex(x => x.message === w.message && x.file === w.file)
	);

	return result;
}

export function registerBuildTool(pi: ExtensionAPI) {
	pi.registerTool({
		name: "build",
		label: "Build",
		description: "Compile or bundle the project. Auto-detects the build command from package.json, Makefile, Cargo.toml, or go.mod. Extracts errors, warnings, and output stats from verbose build output.",
		promptSnippet: "Compile or bundle the project and report errors/warnings",
		promptGuidelines: [
			"Use build after making code changes to verify the project still compiles/bundles correctly.",
			"Use build to catch bundler warnings (unused exports, large chunks, dynamic import issues) that compile checks miss.",
			"Use build before test — if the build fails, tests won't run.",
			"If build reports warnings like [INEFFECTIVE_DYNAMIC_IMPORT], investigate whether the dynamic import is actually needed.",
			"Use build alongside validate: validate catches type errors, build catches bundler/compilation issues.",
		],
		parameters: Type.Object({
			command: Type.Optional(Type.String({ description: "Override auto-detected build command (e.g. 'npm run build', 'cargo build --release')" })),
			path: Type.Optional(Type.String({ description: "Project directory to build in (default: cwd)" })),
		}),
		async execute(_id, params, signal, onUpdate, ctx) {
			const buildCwd = params.path ? resolve(ctx.cwd, params.path) : ctx.cwd;
			let cmd: string[];

			if (params.command) {
				cmd = params.command.split(" ");
			} else {
				const detected = await detectBuildCommand(buildCwd);
				if (!detected) throw new Error("Could not auto-detect build command. No package.json with scripts.build, Makefile, Cargo.toml, or go.mod found. Specify command manually.");
				cmd = detected;
			}

			onUpdate?.({ content: [{ type: "text", text: `Building with: ${cmd.join(" ")}...` }], details: {} });

			const result = await runCommand(cmd[0], cmd.slice(1), { cwd: buildCwd, signal, timeout: 300000 });
			const output = result.stdout + (result.stderr ? "\n" + result.stderr : "");
			const parsed = parseBuildOutput(output, cmd);

			if (result.exitCode !== 0 && parsed.errors.length === 0) {
				// Build failed but we didn't parse any errors — add the last line as generic error
				const lastLine = output.split("\n").filter(Boolean).pop() ?? "Build failed";
				parsed.errors.push({ message: lastLine });
				parsed.status = "failed";
			}

			// Generate summary
			const lines: string[] = [];
			lines.push(`Build: ${parsed.status === "success" ? "✅ Success" : parsed.status === "warning" ? "⚠️ Warnings" : "❌ Failed"}`);
			lines.push("");

			if (parsed.errors.length > 0) {
				lines.push(`Errors (${parsed.errors.length}):`);
				for (const e of parsed.errors.slice(0, 10)) {
					const loc = e.file ? `${e.file}${e.line ? `:${e.line}` : ""}: ` : "";
					lines.push(`  ✗ ${loc}${e.message}`);
				}
				if (parsed.errors.length > 10) lines.push(`  ... and ${parsed.errors.length - 10} more`);
				lines.push("");
			}

			if (parsed.warnings.length > 0) {
				lines.push(`Warnings (${parsed.warnings.length}):`);
				for (const w of parsed.warnings.slice(0, 10)) {
					const code = w.code ? `[${w.code}] ` : "";
					const loc = w.file ? `${w.file}: ` : "";
					lines.push(`  ⚠ ${code}${loc}${w.message.slice(0, 150)}`);
				}
				if (parsed.warnings.length > 10) lines.push(`  ... and ${parsed.warnings.length - 10} more`);
				lines.push("");
			}

			if (parsed.stats.length > 0) {
				lines.push("Stats:");
				for (const s of parsed.stats) {
					lines.push(`  ${s.label}: ${s.value}`);
				}
				lines.push("");
			}

			// Show truncated raw output if needed
			const truncated = truncateHead(output, { maxLines: 50, maxBytes: 10 * 1024 });
			if (parsed.errors.length === 0 && parsed.warnings.length === 0) {
				lines.push("Output:");
				lines.push(truncated.content);
			}

			return {
				content: [{ type: "text", text: lines.join("\n").trim() }],
				details: { status: parsed.status, errors: parsed.errors.length, warnings: parsed.warnings.length },
			};
		},
	});
}
