/**
 * Security Scanner tool — lightweight SAST for the working tree or diff
 *
 * Auto-detects semgrep; falls back to built-in regex patterns via ripgrep.
 */

import { runCommand, truncateHead, formatSize } from "../utils.js";
import { Type } from "typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ScanFinding {
	file: string;
	line?: number;
	severity: "error" | "warning" | "info";
	category: "secret" | "injection" | "xss" | "transport" | "crypto" | "dynamic-exec" | "log-leak";
	message: string;
}

interface BuiltInPattern {
	pattern: string;
	category: ScanFinding["category"];
	severity: ScanFinding["severity"];
	message: string;
}

// ─── Semgrep helpers ────────────────────────────────────────────────────────

async function hasSemgrep(signal?: AbortSignal): Promise<boolean> {
	try {
		await runCommand("which", ["semgrep"], { signal });
		return true;
	} catch {
		return false;
	}
}

function isTestPath(file: string): boolean {
	return (
		file.includes("/test/") ||
		file.includes("/tests/") ||
		file.includes("/__tests__/") ||
		file.includes("/__mocks__/") ||
		file.includes(".test.") ||
		file.includes(".spec.") ||
		file.includes("/fixtures/") ||
		file.includes("/snapshots/")
	);
}

/**
 * Parse semgrep --json output into our finding format.
 * Semgrep JSON is an array of result objects with:
 *   { path, start: { line }, extra: { message, severity, metadata: { category } } }
 */
function parseSemgrepOutput(jsonRaw: string): ScanFinding[] {
	const findings: ScanFinding[] = [];
	try {
		const parsed = JSON.parse(jsonRaw) as Record<string, unknown>;
		const results = (parsed.results ?? parsed.matches ?? []) as unknown[];
		for (const r of results) {
			const obj = r as Record<string, unknown>;
			const path = (obj.path as string) ?? (obj.location as Record<string, unknown>)?.path as string ?? "";
			const start = obj.start as Record<string, unknown> | undefined;
			const line = start ? Number(start.line) : undefined;
			const extra = obj.extra as Record<string, unknown> | undefined;
			const metadata = extra?.metadata as Record<string, unknown> | undefined;

			const severityStr = extra?.severity as string ?? metadata?.severity as string ?? "";
			let severity: ScanFinding["severity"] = "warning";
			if (severityStr === "ERROR" || severityStr === "error") severity = "error";
			if (severityStr === "WARNING" || severityStr === "warning") severity = "warning";
			if (severityStr === "INFO" || severityStr === "info") severity = "info";

			const message = (extra?.message as string) ?? (metadata?.description as string) ?? "Security issue detected";
			const category = inferCategoryFromMessage(message);

			findings.push({
				file: path,
				line,
				severity,
				category,
				message,
			});
		}
	} catch {
		// If JSON parsing fails, return empty — caller should fall back to regex.
	}
	return findings;
}

/**
 * Infer a security category from a semgrep rule message.
 */
function inferCategoryFromMessage(msg: string): ScanFinding["category"] {
	const lower = msg.toLowerCase();
	if (/\b(secret|password|credential|token|api.?key|private.?key)\b/.test(lower)) return "secret";
	if (/\b(sql|sqli|injection)\b/.test(lower)) return "injection";
	if (/\b(xss|cross.?site|dom.?purify)\b/.test(lower)) return "xss";
	if (/\b(insecure.?transport|http|cleartext|tls|ssl)\b/.test(lower)) return "transport";
	if (/\b(crypto|md5|sha1|weak|hash|cipher)\b/.test(lower)) return "crypto";
	if (/\b(eval|function.?constructor|exec|child.?process|command.?injection)\b/.test(lower))
		return "dynamic-exec";
	return "log-leak";
}

async function scanWithSemgrep(
	params: ScanParams,
	signal?: AbortSignal,
): Promise<{ findings: ScanFinding[]; source: string }> {
	const targetPath = params.path ?? ".";
	const args = ["--config=auto", "--json", "--timeout", "60000", "--quiet", targetPath];

	const result = await runCommand("semgrep", args, {
		cwd: params.path ? undefined : undefined,
		signal,
		timeout: 90000,
	});

	const jsonRaw = result.stdout || "";
	const findings = parseSemgrepOutput(jsonRaw);
	// Apply path filter (exclude test files, node_modules, etc.)
	return { findings: filterFindings(findings, params), source: "semgrep" };
}

// ─── Built-in regex patterns ────────────────────────────────────────────────

function getBuiltInPatterns(): BuiltInPattern[] {
	return [
		// ── Secrets (error) ──
		{
			pattern: '(?:password|passwd|pwd)\\s*[:=]\\s*["\'][^"\']+["\']',
			category: "secret",
			severity: "error",
			message: "Possible hardcoded password",
		},
		{
			pattern: '(?:api.?key|apikey|api_key)\\s*[:=]\\s*["\'][^"\']+["\']',
			category: "secret",
			severity: "error",
			message: "Possible hardcoded API key",
		},
		{
			pattern: '(?:secret|secret.?key)\\s*[:=]\\s*["\'][^"\']+["\']',
			category: "secret",
			severity: "error",
			message: "Possible hardcoded secret",
		},
		{
			pattern: '(?:token|auth.?token|access.?token)\\s*[:=]\\s*["\'][^"\']+["\']',
			category: "secret",
			severity: "error",
			message: "Possible hardcoded token",
		},
		{
			pattern: '(?:private.?key|PRIVATE.?KEY)\\s*[:=]\\s*["\'][^"\']+["\']',
			category: "secret",
			severity: "error",
			message: "Possible hardcoded private key",
		},
		// ── SQL Injection (error) ──
		{
			pattern: '(?:"SELECT\\b[^"]*FROM\\b[^"]*"\\s*\\+\\s*\\w+)',
			category: "injection",
			severity: "error",
			message: "Possible SQL injection via string concatenation",
		},
		{
			pattern: "(?:SELECT|INSERT|UPDATE|DELETE|DROP)\\b[^;]*\\.format\\s*\\(",
			category: "injection",
			severity: "error",
			message: "Possible SQL injection via string formatting",
		},
		{
			pattern: '(?:SELECT|INSERT|UPDATE|DELETE)\\b[^`]*`\\$\\{',
			category: "injection",
			severity: "error",
			message: "Possible SQL injection via template literal",
		},
		// ── eval / Function (error) ──
		{
			pattern: "\\beval\\s*\\(",
			category: "dynamic-exec",
			severity: "error",
			message: "Use of eval() — potential code injection",
		},
		{
			pattern: "\\bnew\\s+Function\\s*\\(",
			category: "dynamic-exec",
			severity: "error",
			message: "Use of Function() constructor — potential code injection",
		},
		// ── XSS (error) ──
		{
			pattern: "\\.(?:innerHTML|outerHTML)\\s*=",
			category: "xss",
			severity: "error",
			message: "Direct DOM manipulation via innerHTML/outerHTML — XSS risk",
		},
		{
			pattern: "dangerouslySetInnerHTML",
			category: "xss",
			severity: "error",
			message: "Use of dangerouslySetInnerHTML — XSS risk",
		},
		// ── Insecure transport (warning) ──
		{
			pattern: '["\']https?://(?!localhost|127\\.0\\.0\\.1|0\\.0\\.0\\.0)[^"\']*(?:api|auth|webhook)@?[^"\']*["\']',
			category: "transport",
			severity: "warning",
			message: "Possible insecure HTTP URL for API/auth/webhook endpoint",
		},
		{
			pattern: "(?:protocol\\s*[=:]\\s*[\"']|PROTOCOL\\s*=\\s*[\"'])(https?://)(?!localhost|127\\.0\\.0\\.1)",
			category: "transport",
			severity: "warning",
			message: "Insecure protocol (HTTP) for non-localhost URL",
		},
		// ── Weak crypto (warning) ──
		{
			pattern: "\\b(?:createHash|hash|md5|sha1)\\s*\\(\\s*[\"'](?:md5|sha1)[\"']",
			category: "crypto",
			severity: "warning",
			message: "Weak hash algorithm for security-sensitive use",
		},
		{
			pattern: "\\b(?:crypto|Crypto)(?:p|P)(?:r|p)(?:o|O)(?:t|O)(?:o|o)(?:c|O)(?:c|O)\\.(?:md5|sha1)",
			category: "crypto",
			severity: "warning",
			message: "Deprecated/cryptographic weak hash",
		},
		// ── Log leaks (info) ──
		{
			pattern: "console\\.(?:log|debug|warn|info)\\s*\\([^)]*(?:password|secret|token|api.?key|credential|private.?key|access.?key)",
			category: "log-leak",
			severity: "info",
			message: "Sensitive variable name in console output — potential leak",
		},
	];
}

// ─── Core scanning logic ────────────────────────────────────────────────────

interface ScanParams {
	path?: string;
	diff_only?: boolean;
	severity?: "error" | "warning" | "info";
}

function shouldExcludeFile(file: string): boolean {
	const excluded = [
		"/node_modules/",
		"/.git/",
		"/vendor/",
		"/dist/",
		"/build/",
		"/target/",
		"/.next/",
		"/.nuxt/",
		"/coverage/",
		"/.venv/",
		"/venv/",
		"/__pycache__/",
	];
	for (const prefix of excluded) {
		if (file.includes(prefix)) return true;
	}
	return false;
}

function filterFindings(findings: ScanFinding[], params: ScanParams): ScanFinding[] {
	return findings.filter((f) => {
		// Exclude test files from secret/crypto detections
		if (
			(f.category === "secret" || f.category === "crypto") &&
			isTestPath(f.file)
		) {
			return false;
		}
		// Global exclusions
		if (shouldExcludeFile(f.file)) return false;
		// Severity filter
		if (params.severity && f.severity !== params.severity) return false;
		return true;
	});
}

/**
 * Run built-in regex scans via ripgrep, returning findings.
 */
async function scanWithRegex(
	params: ScanParams,
	signal?: AbortSignal,
): Promise<{ findings: ScanFinding[]; source: string }> {
	const patterns = getBuiltInPatterns();
	const targetPath = params.path ?? ".";
	const findings: ScanFinding[] = [];

	for (const p of patterns) {
		const args = [
			"--line-number",
			"--no-heading",
			"--color",
			"never",
			"-g",
			"!*node_modules*",
			"-g",
			"!.git*",
			"-g",
			"!*vendor*",
			"-g",
			"!*dist*",
			"-g",
			"!*build*",
			"-g",
			"!*target*",
			p.pattern,
			targetPath,
		];

		const result = await runCommand("rg", args, {
			cwd: params.path ? undefined : undefined,
			signal,
			timeout: 60000,
		});

		const output = result.stdout || "";
		for (const line of output.split("\n")) {
			if (!line.trim()) continue;
			const match = line.match(/^(.+?):(\d+):(.+)$/);
			if (match) {
				const file = match[1];
				const lineNum = parseInt(match[2]);
				const context = match[3].trim();

				// Build a more descriptive message with the matched line context
				const displayMsg = `${p.message} — matched: ${context.slice(0, 100)}`;

				findings.push({
					file,
					line: lineNum,
					severity: p.severity,
					category: p.category,
					message: displayMsg,
				});
			}
		}
	}

	// Filter (excludes tests, excludes paths, applies severity filter)
	const filtered = filterFindings(findings, params);
	return { findings: filtered, source: "regex" };
}

/**
 * Scan only the current git diff. Useful for pre-commit checks.
 */
async function scanDiffOnly(
	params: ScanParams,
	signal?: AbortSignal,
): Promise<{ findings: ScanFinding[]; source: string }> {
	const patterns = getBuiltInPatterns();
	const findings: ScanFinding[] = [];

	// Get the diff
	const diffResult = await runCommand(
		"git",
		["diff", "--no-color", "HEAD"],
		{ cwd: params.path ? undefined : undefined, signal, timeout: 30000 },
	);

	const diffOutput = diffResult.stdout || "";
	if (!diffOutput.trim()) {
		return { findings: [], source: "git-diff" };
	}

	// We parse the diff to associate patterns with lines
	// The approach: for each pattern, search within the diff text
	// and report line-relative findings.

	let inNewFile = false;
	let currentFile = "";
	let lineOffset = 0;

	const lines = diffOutput.split("\n");
	for (const line of lines) {
		// Detect new file header
		const fileMatch = line.match(/^diff --git a\/(.+) b\/(.+)$/);
		if (fileMatch) {
			currentFile = fileMatch[2];
			inNewFile = true;
			lineOffset = 0;
			continue;
		}

		if (line.startsWith("--- ") || line.startsWith("+++ ")) {
			continue;
		}

		if (line.startsWith("@@")) {
			// Parse @@ -X,Y +A,B @@
			const hunkMatch = line.match(/^\@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
			if (hunkMatch) lineOffset = parseInt(hunkMatch[1]);
			continue;
		}

		if (line.startsWith("+") && (inNewFile || line.length > 1)) {
			const content = line.slice(1);
			for (const p of patterns) {
				if (p.severity === "info") continue; // skip info-level in diff
				let regex: RegExp;
				try {
					regex = new RegExp(p.pattern, "i");
				} catch (e: any) {
					// eslint-disable-next-line no-console
					console.error(`[scan] Skipping invalid regex pattern: ${JSON.stringify(p.pattern)} — ${e.message}`);
					continue; // skip patterns with Rust-only syntax
				}
				if (regex.test(content)) {
					const matchedLine = lineOffset;
					const displayMsg = `${p.message} — diff line: ${content.slice(0, 100)}`;
					findings.push({
						file: currentFile,
						line: matchedLine,
						severity: p.severity,
						category: p.category,
						message: displayMsg,
					});
				}
			}
			lineOffset++;
		}
	}

	const filtered = filterFindings(findings, params);
	return { findings: filtered, source: "git-diff" };
}

// ─── Formatting helpers ─────────────────────────────────────────────────────

function severityEmoji(severity: string): string {
	if (severity === "error") return "✗";
	if (severity === "warning") return "⚠";
	return "ℹ";
}

function formatFindings(
	findings: ScanFinding[],
	source: string,
): string {
	if (findings.length === 0) {
		return `Scan complete (${source}): No security issues found.`;
	}

	const errorCount = findings.filter((f) => f.severity === "error").length;
	const warningCount = findings.filter((f) => f.severity === "warning").length;
	const infoCount = findings.filter((f) => f.severity === "info").length;
	const lines: string[] = [
		`Scan complete (${source}): ${findings.length} finding(s): ${errorCount} error(s), ${warningCount} warning(s), ${infoCount} info`,
		"",
	];

	// Group by severity
	for (const sev of ["error", "warning", "info"] as const) {
		const sevFindings = findings.filter((f) => f.severity === sev);
		if (sevFindings.length === 0) continue;

		lines.push(`── ${sev.toUpperCase()} (${sevFindings.length}) ──`);
		for (const f of sevFindings.slice(0, 30)) {
			const loc = f.line ? `${f.file}:${f.line}` : f.file;
			lines.push(
				`  ${severityEmoji(f.severity)} ${loc} [${f.category}] ${f.message.slice(0, 120)}`,
			);
		}
		if (sevFindings.length > 30) {
			lines.push(`  ... and ${sevFindings.length - 30} more`);
		}
		lines.push("");
	}

	return lines.join("\n").trim();
}

// ─── Tool registration ──────────────────────────────────────────────────────

export function registerScanTool(pi: ExtensionAPI) {
	pi.registerTool({
		name: "scan",
		label: "Security Scanner",
		description:
			"Lightweight SAST that scans the working tree (or a specific diff/file) for security issues. Uses semgrep if available, falls back to built-in regex patterns.",
		promptSnippet:
			"Scan the working tree for security issues using semgrep (or built-in patterns)",
		promptGuidelines: [
			"Use scan before committing to catch security issues early.",
			"Use diff_only: true to scan only uncommitted changes — fast and focused.",
			"Run scan on a specific path to target a single file or directory.",
			"Filter by severity to focus on critical issues first (severity: 'error').",
			"If semgrep is installed, it provides comprehensive analysis. Otherwise built-in regex patterns cover common issues.",
			"Fix errors before warnings; review info items for potential leaks.",
		],
		parameters: Type.Object({
			path: Type.Optional(
				Type.String({
					description:
						"Directory or file to scan (default: cwd)",
				}),
			),
			diff_only: Type.Optional(
				Type.Boolean({
					description:
						"If true, scan only git diff output instead of full tree. Useful for pre-commit checks.",
				}),
			),
			severity: Type.Optional(
				Type.Union([
					Type.Literal("error"),
					Type.Literal("warning"),
					Type.Literal("info"),
				], {
					description:
						"Filter findings by severity (default: scan all)",
				}),
			),
		}),
		async execute(
			_id: string,
			params: ScanParams,
			signal: AbortSignal | undefined,
			_onUpdate: any,
			ctx: any,
		) {
			let findings: ScanFinding[] = [];
			let source = "";

			if (params.diff_only) {
				// Diff-only scanning
				const result = await scanDiffOnly(params, signal);
				findings = result.findings;
				source = result.source;
			} else {
				// Try semgrep first, fall back to regex
				const available = await hasSemgrep(signal);
				if (available) {
					try {
						const result = await scanWithSemgrep(params, signal);
						if (result.findings.length > 0) {
							findings = result.findings;
							source = result.source;
						}
					} catch {
						// semgrep failed, fall through to regex
					}
				}

				if (findings.length === 0) {
					// Built-in regex scan
					const result = await scanWithRegex(params, signal);
					findings = result.findings;
					source = result.source;
				}
			}

			const output = formatFindings(findings, source);
			const errorCount = findings.filter((f) => f.severity === "error").length;
			const warningCount = findings.filter((f) => f.severity === "warning").length;
			const infoCount = findings.filter((f) => f.severity === "info").length;

			return {
				content: [{ type: "text", text: output }],
				details: {
					findings: findings.length,
					errors: errorCount,
					warnings: warningCount,
					info: infoCount,
					source,
				},
			};
		},
	});
}
