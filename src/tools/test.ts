/**
 * Test tool — run tests and extract failures with location
 */

import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { runCommand, truncateHead, formatSize } from "../utils.js";
import { Type } from "typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

async function detectTestCommand(cwd: string): Promise<string[] | null> {
	const checks = [
		{ file: "package.json", cmd: ["npm", "test"] },
		{ file: "Cargo.toml", cmd: ["cargo", "test"] },
		{ file: "go.mod", cmd: ["go", "test", "./..."] },
		{ file: "pyproject.toml", cmd: ["pytest"] },
		{ file: "setup.py", cmd: ["pytest"] },
		{ file: "requirements.txt", cmd: ["pytest"] },
		{ file: "Makefile", cmd: ["make", "test"] },
	];
	for (const { file, cmd } of checks) {
		try { await access(resolve(cwd, file)); return cmd; } catch { /* continue */ }
	}
	// Check for test files
	try {
		const result = await runCommand("find", [".", "-maxdepth", "2", "-name", "*.test.*", "-o", "-name", "*_test.*", "-o", "-name", "test_*.py"], { cwd });
		if (result.stdout.trim()) return ["pytest"];
	} catch { /* ignore */ }
	return null;
}

function parseTestOutput(output: string, framework: string) {
	const failures: Array<{ file?: string; line?: number; test?: string; message: string }> = [];
	const lines = output.split("\n");

	if (framework === "jest" || framework === "vitest" || framework === "npm") {
		// Look for ● fail markers or FAIL file paths
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			const failMatch = line.match(/FAIL\s+(\S+)/);
			if (failMatch) {
				const file = failMatch[1];
				// Collect next few lines as error message
				const msg = lines.slice(i + 1, i + 6).filter(l => l.trim() && !l.startsWith("  ")).join("; ").slice(0, 200);
				failures.push({ file, message: msg || "Test failed" });
			}
			// Jest individual test failure
			const testFail = line.match(/●\s+(.+)/);
			if (testFail) {
				const testName = testFail[1].trim();
				const msg = lines.slice(i + 1, i + 4).join("; ").slice(0, 200);
				failures.push({ test: testName, message: msg || "Test failed" });
			}
		}
	} else if (framework === "cargo") {
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			const failMatch = line.match(/failures:\s*$/);
			if (failMatch) {
				// Read until "test result:"
				for (let j = i + 1; j < lines.length && !lines[j].includes("test result:"); j++) {
					const testName = lines[j].trim();
					if (testName) failures.push({ test: testName, message: "Test failed" });
				}
			}
		}
	} else if (framework === "go") {
		for (const line of lines) {
			const match = line.match(/---\s+FAIL:\s+(\S+)\s+\(([^)]+)\)/);
			if (match) failures.push({ test: match[1], message: match[2] });
		}
	} else if (framework === "pytest") {
		for (const line of lines) {
			const match = line.match(/FAILED\s+(\S+)::(\S+)/);
			if (match) failures.push({ file: match[1], test: match[2], message: "Test failed" });
		}
	}

	// Try to extract a summary line
	const summaryLine = lines.find(l =>
		l.match(/test result:|Test Suites:|passed|failed/) ||
		l.match(/\d+ passed|\d+ failed/)
	);

	return { failures, summary: summaryLine?.trim() ?? "See output for details", raw: output };
}

export function registerTestTool(pi: ExtensionAPI) {
	pi.registerTool({
		name: "test",
		label: "Test",
		description: "Run the project's test suite and report results. Auto-detects the test framework (jest/vitest, cargo test, go test, pytest). Extracts failure locations so you can fix them directly.",
		promptSnippet: "Run tests and report failures with file locations",
		promptGuidelines: [
			"Use test after making code changes to verify they work correctly.",
			"Use test before declaring a task complete — never assume code works without running tests.",
			"If tests fail, use the reported file and line numbers to navigate directly to the failure.",
			"Use test with a specific pattern (e.g., test --pattern auth) to run only relevant tests when the full suite is slow.",
			"If test auto-detection fails, specify the command manually with bash instead.",
		],
		parameters: Type.Object({
			pattern: Type.Optional(Type.String({ description: "Test pattern to filter (passed to the test runner)" })),
			command: Type.Optional(Type.String({ description: "Override the auto-detected test command (e.g. 'npm test -- src/auth')" })),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			let cmd: string[];
			let framework = "npm";

			if (params.command) {
				cmd = params.command.split(" ");
			} else {
				const detected = await detectTestCommand(ctx.cwd);
				if (!detected) throw new Error("Could not auto-detect test framework. No package.json, Cargo.toml, go.mod, pyproject.toml, or Makefile found. Specify command manually.");
				cmd = [...detected];
				if (detected[0] === "cargo") framework = "cargo";
				else if (detected[0] === "go") framework = "go";
				else if (detected[0] === "pytest") framework = "pytest";
			}

			if (params.pattern) {
				if (framework === "npm") cmd.push("--", params.pattern);
				else if (framework === "cargo") cmd.push(params.pattern);
				else if (framework === "pytest") cmd.push("-k", params.pattern);
				else cmd.push(params.pattern);
			}

			const result = await runCommand(cmd[0], cmd.slice(1), { cwd: ctx.cwd, signal, timeout: 120000 });
			const output = result.stdout + (result.stderr ? "\n" + result.stderr : "");
			const parsed = parseTestOutput(output, framework);

			const truncated = truncateHead(output, { maxLines: 200, maxBytes: 20 * 1024 });
			let text = "";

			if (parsed.summary) text += `Summary: ${parsed.summary}\n\n`;

			if (parsed.failures.length > 0) {
				text += `Failures (${parsed.failures.length}):\n`;
				for (const f of parsed.failures.slice(0, 20)) {
					const loc = f.file ? `${f.file}${f.line ? `:${f.line}` : ""}` : f.test ?? "unknown";
					text += `  ✗ ${loc}: ${f.message.slice(0, 120)}\n`;
				}
				if (parsed.failures.length > 20) text += `  ... and ${parsed.failures.length - 20} more\n`;
				text += "\n";
			}

			if (truncated.truncated) {
				text += `[Output truncated: ${truncated.outputLines} of ${truncated.totalLines} lines]`;
			} else {
				text += truncated.content;
			}

			return {
				content: [{ type: "text", text: text.trim() || "Tests completed." }],
				details: { failures: parsed.failures.length, summary: parsed.summary, exitCode: result.exitCode },
			};
		},
	});
}
