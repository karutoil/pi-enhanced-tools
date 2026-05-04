/**
 * Architecture Rule Checker — validates import boundaries across a codebase.
 *
 * Scans source files (excluding node_modules, .git, dist, build, target),
 * parses their imports, and flags violations of user-defined rules like
 * "src/ui must not import from src/db".
 */

import { readFile } from "node:fs/promises";
import { resolve, relative, dirname, join } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { detectLanguage, parseImports, runCommand, truncateHead } from "../utils.js";

// Extensions the tool considers as "source files"
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".py", ".rs", ".go", ".java", ".kt", ".rb", ".php", ".cs", ".swift"];

/**
 * Check whether a file path matches a glob-like segment (e.g. "src/ui").
 * Matches:
 *   src/ui      → src/ui/component.tsx, src/ui.tsx, src/ui/index.ts
 *   src/db      → src/db/client.py, src/db.ts
 */
function pathMatchesSegment(filePath: string, segment: string): boolean {
	// Normalize to forward slashes
	const normalizedFile = filePath.replace(/\\/g, "/");
	const normalizedSeg = segment.replace(/\\/g, "/");

	// Match as directory: file is under segment/
	if (normalizedFile.startsWith(normalizedSeg + "/")) return true;

	// Match as file: basename is segment or segment.<ext>
	const basename = normalizedFile.split("/").pop() ?? normalizedFile;
	if (basename === normalizedSeg) return true;
	if (basename.startsWith(normalizedSeg + ".")) return true;

	return false;
}

export function registerRulesTool(pi: ExtensionAPI) {
	pi.registerTool({
		name: "rules",
		label: "Rules",
		description:
			"Architecture Rule Checker — validates import boundaries across a codebase. " +
			"Scans source files and reports violations of rules like 'does /ui import from /db?'. " +
			"Use before refactors to check boundary violations.",
		promptSnippet: "Check architectural boundary rules for import violations",
		promptGuidelines: [
			"Use the rules tool before refactors to check boundary violations and layer dependencies.",
			"Define rules as '{ from: '<dir>', to: '<dir>', allowed: true/false }' to enforce architectural boundaries.",
			"The 'from' and 'to' paths support glob-like matching — e.g. 'src/ui' matches 'src/ui/component.tsx' and files under 'src/ui/'.",
			"A rule with allowed:false flags any file under 'from' that imports something matching 'to'.",
			"Set allowed:true to whitelist specific cross-boundary imports that are intentional.",
			"The tool excludes node_modules, .git, dist, build, and target directories from scanning.",
			"Review violations carefully — import paths in source may use relative paths that don't match segment names directly.",
			"Run rules before merging PRs that touch layer boundaries to catch accidental coupling.",
		],
		parameters: Type.Object({
			rules: Type.Array(
				Type.Object({
					from: Type.String({ description: "Source directory or file segment (e.g. 'src/ui') — files under this path are checked" }),
					to: Type.String({ description: "Target directory or file segment (e.g. 'src/db') — import paths are matched against this" }),
					allowed: Type.Boolean({ description: "true = this import is allowed; false = this import is a violation" }),
				}),
				{ minItems: 1 },
			),
			path: Type.Optional(
				Type.String({ description: "Root directory to scan (default: current working directory)" }),
			),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			const scanRoot = params.path ?? ctx.cwd;
			const absRoot = resolve(scanRoot);
			const rules = params.rules;

			// Step 1 — discover source files (excluding noisy directories)
			const excludedDirs = ["node_modules", ".git", "dist", "build", "target"];
			const args: string[] = [absRoot, "-type", "f"];
			for (const d of excludedDirs) {
				args.push("-not", "-path", join(absRoot, d, "*"));
			}
			// Group OR conditions: match any source extension
			args.push("(");
			for (let i = 0; i < SOURCE_EXTENSIONS.length; i++) {
				if (i > 0) args.push("-o");
				args.push("-name", `*${SOURCE_EXTENSIONS[i]}`);
			}
			args.push(")");

			const result = await runCommand("find", args, { cwd: scanRoot, signal, timeout: 30000 });

			const filePaths = result.stdout
				.split("\n")
				.filter(Boolean)
				.map((p) => relative(scanRoot, p))
				.filter((p) => !p.startsWith(".."));

			if (filePaths.length === 0) {
				return {
					content: [
						{
							type: "text",
							text: [
								"Architecture Rule Check",
								"=======================",
								"",
								`Scanned: ${scanRoot}`,
								"Rules: 0",
								"Violations: 0",
								"",
								"No source files found in the given directory.",
							].join("\n"),
						},
					],
					details: { rulesChecked: 0, violationsFound: 0, violations: [] },
				};
			}

			// Step 2 — check each file against each rule
			const violations: Array<{
				file: string;
				rule: { from: string; to: string; allowed: boolean };
				importPaths: string[];
				lineContent: string;
			}> = [];

			// Cache parsed files: path -> Set of import strings
			const parsedCache = new Map<string, { imports: string[]; lang: string | null }>();

			for (const relPath of filePaths) {
				const absPath = resolve(absRoot, relPath);
				const content = await readFile(absPath, "utf-8").catch(() => null);
				if (!content) continue;

				const parsed = parseFile(content, relPath);
				parsedCache.set(relPath, parsed);

				for (const rule of rules) {
					if (!pathMatchesSegment(relPath, rule.from)) continue;

					const matchingImports = findMatchingImports(parsed.imports, rule.to);
					if (matchingImports.length === 0) continue;

					const isViolation = !rule.allowed;

					if (isViolation) {
						violations.push({
							file: relPath,
							rule: { ...rule },
							importPaths: matchingImports,
							lineContent: "", // filled in below
						});
					}
				}
			}

			// Step 3 — extract line content for each violation
			for (const v of violations) {
				const content = await readFile(resolve(absRoot, v.file), "utf-8").catch(() => null);
				if (content) {
					const lines = content.split("\n");
					const foundLines: string[] = [];
					for (const importRef of v.importPaths) {
						for (let i = 0; i < lines.length; i++) {
							if (lines[i].includes(importRef)) {
								foundLines.push(`${i + 1}: ${lines[i].trim()}`);
								if (foundLines.length >= 5) break; // cap per import ref
							}
						}
					}
					v.lineContent = foundLines.join("\n") || "(no matching lines found)";
				}
			}

			// Step 4 — build structured report
			const reportLines: string[] = [];
			reportLines.push("Architecture Rule Check");
			reportLines.push("=======================");
			reportLines.push("");
			reportLines.push(`Scanned: ${scanRoot}`);
			reportLines.push(`Files: ${filePaths.length}`);
			reportLines.push(`Rules checked: ${rules.length}`);
			reportLines.push(`Violations: ${violations.length}`);
			reportLines.push("");

			if (violations.length > 0) {
				reportLines.push("VIOLATIONS");
				reportLines.push("----------");
				reportLines.push("");

				// Group by file
				const byFile = new Map<string, typeof violations>();
				for (const v of violations) {
					if (!byFile.has(v.file)) byFile.set(v.file, []);
					byFile.get(v.file)!.push(v);
				}

				let i = 1;
				for (const [file, fileViolations] of byFile) {
					reportLines.push(`[${i}] ${file}`);
					for (const v of fileViolations) {
						reportLines.push(`    Rule: ${v.rule.from} → ${v.rule.to} (allowed: ${v.rule.allowed})`);
						reportLines.push(`    Import paths: ${v.importPaths.join(", ")}`);
						reportLines.push(`    Lines:`);
						for (const line of v.lineContent.split("\n")) {
							reportLines.push(`      ${line}`);
						}
						reportLines.push("");
					}
					i++;
				}
			} else {
				reportLines.push("All rules passed — no violations found.");
			}

			return {
				content: [{ type: "text", text: reportLines.join("\n") }],
				details: {
					rulesChecked: rules.length,
					violationsFound: violations.length,
					filesScanned: filePaths.length,
					violations: violations.map((v) => ({
						file: v.file,
						rule: v.rule,
						importPaths: v.importPaths,
					})),
				},
			};
		},
	});
}

/**
 * Parse a file's content: detect language and extract imports.
 */
function parseFile(content: string, filePath: string): { imports: string[]; lang: string | null } {
	const lang = detectLanguage(filePath);
	const imports = parseImports(content, lang);
	return { imports, lang };
}

/**
 * Find imports that match a target segment (glob-like matching).
 * An import "matches" the target if the import path contains the segment
 * as a directory or file component.
 */
function findMatchingImports(imports: string[], segment: string): string[] {
	const normalized = segment.replace(/\\/g, "/");
	return imports.filter((imp) => {
		// Match segment as a path component in the import string
		// e.g. import from "../db/client" matches segment "db"
		// e.g. import from "@app/db" matches segment "db" (if the segment is "app/db" then match "app/db")
		const impNorm = imp.replace(/\\/g, "/");

		// Direct path match
		if (impNorm.includes(normalized)) return true;

		// Match against file path components derived from the import
		// For relative paths like "../../src/db/util"
		const parts = impNorm.split("/");
		for (let i = 0; i < parts.length; i++) {
			const subpath = parts.slice(i).join("/");
			if (subpath.startsWith(normalized + "/") || subpath === normalized || subpath.startsWith(normalized + ".")) {
				return true;
			}
		}

		return false;
	});
}
