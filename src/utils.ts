/**
 * Shared utilities for enhanced-tools extension
 */

import { execFile } from "node:child_process";

export const DEFAULT_MAX_BYTES = 50 * 1024;
export const DEFAULT_MAX_LINES = 2000;

export interface TruncationResult {
	content: string;
	truncated: boolean;
	outputLines: number;
	totalLines: number;
	outputBytes: number;
	totalBytes: number;
}

export function truncateHead(
	text: string,
	opts: { maxLines?: number; maxBytes?: number } = {},
): TruncationResult {
	const maxLines = opts.maxLines ?? DEFAULT_MAX_LINES;
	const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;

	const lines = text.split("\n");
	const totalLines = lines.length;
	const totalBytes = Buffer.byteLength(text, "utf-8");

	let output = text;
	let truncated = false;

	if (totalLines > maxLines) {
		output = lines.slice(0, maxLines).join("\n");
		truncated = true;
	}

	const outputBytes = Buffer.byteLength(output, "utf-8");
	if (outputBytes > maxBytes) {
		// Trim bytes carefully to avoid splitting multi-byte chars
		const buf = Buffer.from(output, "utf-8");
		output = buf.slice(0, maxBytes).toString("utf-8");
		truncated = true;
	}

	const outputLines = output.split("\n").length;

	return {
		content: output,
		truncated,
		outputLines,
		totalLines,
		outputBytes: Buffer.byteLength(output, "utf-8"),
		totalBytes,
	};
}

export function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export async function runCommand(
	command: string,
	args: string[],
	opts: { cwd?: string; timeout?: number; signal?: AbortSignal } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number; killed?: boolean }> {
	return new Promise((resolve) => {
		const child = execFile(command, args, {
			cwd: opts.cwd,
			timeout: opts.timeout ?? 30000,
			signal: opts.signal as any,
			maxBuffer: 50 * 1024 * 1024,
		}, (error, stdout, stderr) => {
			if (error) {
				resolve({
					stdout,
					stderr,
					exitCode: (error as any).code ?? 1,
					killed: (error as any).killed,
				});
			} else {
				resolve({ stdout, stderr, exitCode: 0 });
			}
		});
	});
}

export function detectLanguage(filePath: string): string | null {
	const ext = filePath.split(".").pop()?.toLowerCase();
	const map: Record<string, string> = {
		ts: "typescript", tsx: "typescript",
		js: "javascript", jsx: "javascript",
		py: "python",
		rs: "rust",
		go: "go",
		java: "java",
		kt: "kotlin",
		scala: "scala",
		c: "c", h: "c",
		cpp: "cpp", cc: "cpp", hpp: "cpp",
		cs: "csharp",
		rb: "ruby",
		php: "php",
		swift: "swift",
		m: "objective-c",
		sh: "bash", bash: "bash", zsh: "bash",
		md: "markdown",
		yml: "yaml", yaml: "yaml",
		json: "json",
		toml: "toml",
		html: "html", htm: "html",
		css: "css", scss: "css", sass: "css",
		sql: "sql",
		vue: "vue",
		svelte: "svelte",
	};
	return map[ext ?? ""] ?? null;
}

export function parseImports(content: string, lang: string | null): string[] {
	const imports: string[] = [];
	const lines = content.split("\n");

	for (const line of lines) {
		let match: RegExpMatchArray | null = null;

		if (lang === "typescript" || lang === "javascript") {
			// import { x } from "./path" or import x from "./path"
			match = line.match(/import\s+(?:[\s\S]*?)\s+from\s+['"]([^'"]+)['"]/);
			if (!match) {
				// const x = require("./path")
				match = line.match(/require\s*\(\s*['"]([^'"]+)['"]\s*\)/);
			}
			if (!match) {
				// import "./path"
				match = line.match(/import\s+['"]([^'"]+)['"]/);
			}
		} else if (lang === "python") {
			match = line.match(/(?:from|import)\s+([\w.]+)/);
		} else if (lang === "rust") {
			match = line.match(/use\s+([\w:]+)/);
		} else if (lang === "go") {
			match = line.match(/import\s+(?:\(\s*["']|["'])([^"']+)/);
		} else if (lang === "ruby") {
			match = line.match(/require\s+['"]([^'"]+)['"]/);
		} else if (lang === "php") {
			match = line.match(/(?:use|require|include)\s+([\w\\]+)/);
		}

		if (match && match[1]) {
			imports.push(match[1]);
		}
	}

	return [...new Set(imports)];
}

export function parseFunctionDeclarations(content: string, lang: string | null): string[] {
	const funcs: string[] = [];
	const lines = content.split("\n");

	for (const line of lines) {
		let match: RegExpMatchArray | null = null;
		const trimmed = line.trim();

		if (lang === "typescript" || lang === "javascript") {
			// function name(...) or async function name(...) or const name = (...) =>
			match = trimmed.match(/(?:async\s+)?function\s+(\w+)/);
			if (!match) {
				match = trimmed.match(/(?:export\s+)?(?:async\s+)?(?:function\s+)?(\w+)\s*[:=]\s*(?:async\s*)?\(/);
			}
		} else if (lang === "python") {
			match = trimmed.match(/def\s+(\w+)/);
		} else if (lang === "rust") {
			match = trimmed.match(/(?:pub\s+)?fn\s+(\w+)/);
		} else if (lang === "go") {
			match = trimmed.match(/func\s+(?:\([^)]+\)\s+)?(\w+)/);
		} else if (lang === "ruby") {
			match = trimmed.match(/def\s+(\w+)/);
		} else if (lang === "bash") {
			match = trimmed.match(/(\w+)\s*\(\)/);
		}

		if (match && match[1]) {
			funcs.push(match[1]);
		}
	}

	return [...new Set(funcs)];
}

export function parseClassDeclarations(content: string, lang: string | null): string[] {
	const classes: string[] = [];
	const lines = content.split("\n");

	for (const line of lines) {
		let match: RegExpMatchArray | null = null;
		const trimmed = line.trim();

		if (lang === "typescript" || lang === "javascript" || lang === "java" || lang === "csharp") {
			match = trimmed.match(/(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/);
			if (!match) {
				match = trimmed.match(/(?:export\s+)?interface\s+(\w+)/);
			}
			if (!match) {
				match = trimmed.match(/(?:export\s+)?type\s+(\w+)/);
			}
		} else if (lang === "python") {
			match = trimmed.match(/class\s+(\w+)/);
		} else if (lang === "rust") {
			match = trimmed.match(/(?:pub\s+)?(?:struct|enum|trait|impl)\s+(?:<[^>]+>\s+)?(\w+)/);
		} else if (lang === "go") {
			match = trimmed.match(/type\s+(\w+)/);
		} else if (lang === "ruby") {
			match = trimmed.match(/class\s+(\w+)/);
		}

		if (match && match[1]) {
			classes.push(match[1]);
		}
	}

	return [...new Set(classes)];
}
