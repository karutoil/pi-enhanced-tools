/**
 * Project tool — high-level project overview
 */

import { readdir, stat, access } from "node:fs/promises";
import { resolve, basename } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

interface ProjectInfo {
	name: string;
	root: string;
	stack: string[];
	keyFiles: string[];
	dirs: Array<{ name: string; type: "src" | "test" | "config" | "docs" | "other" }>;
}

const STACK_MARKERS: Record<string, string[]> = {
	"Node.js/TypeScript": ["package.json", "tsconfig.json"],
	"Rust": ["Cargo.toml"],
	"Go": ["go.mod"],
	"Python": ["pyproject.toml", "setup.py", "requirements.txt", "Pipfile"],
	"Ruby": ["Gemfile"],
	"Java": ["pom.xml", "build.gradle"],
	"Docker": ["Dockerfile", "docker-compose.yml"],
};

const DIR_TYPES: Array<{ names: string[]; type: "src" | "test" | "config" | "docs" | "other" }> = [
	{ names: ["src", "lib", "app", "core", "packages", "internal"], type: "src" },
	{ names: ["test", "tests", "spec", "specs", "__tests__", "e2e"], type: "test" },
	{ names: ["config", "configs", ".config"], type: "config" },
	{ names: ["docs", "doc", "documentation", "wiki"], type: "docs" },
];

async function detectStack(cwd: string): Promise<string[]> {
	const stacks: string[] = [];
	for (const [name, files] of Object.entries(STACK_MARKERS)) {
		for (const file of files) {
			try { await access(resolve(cwd, file)); stacks.push(name); break; } catch { /* continue */ }
		}
	}
	return [...new Set(stacks)];
}

async function getTopLevelItems(cwd: string, maxItems: number = 30): Promise<ProjectInfo> {
	const entries = await readdir(cwd, { withFileTypes: true });
	const items = entries.filter(e => !e.name.startsWith(".") || [".github", ".pi", ".vscode"].includes(e.name));

	const dirs: Array<{ name: string; type: "src" | "test" | "config" | "docs" | "other" }> = [];
	const files: string[] = [];

	for (const item of items.slice(0, maxItems)) {
		if (item.isDirectory()) {
			const dirType = DIR_TYPES.find(d => d.names.includes(item.name.toLowerCase()))?.type ?? "other";
			dirs.push({ name: item.name, type: dirType });
		} else {
			files.push(item.name);
		}
	}

	// Sort dirs: src first, then test, then others
	dirs.sort((a, b) => {
		const order = { src: 0, test: 1, config: 2, docs: 3, other: 4 };
		return order[a.type] - order[b.type];
	});

	const stack = await detectStack(cwd);

	return {
		name: basename(cwd),
		root: cwd,
		stack,
		keyFiles: files.filter(f => ["package.json", "Cargo.toml", "go.mod", "pyproject.toml", "README.md", "Dockerfile"].includes(f)),
		dirs,
	};
}

export function registerProjectTool(pi: ExtensionAPI) {
	pi.registerTool({
		name: "project",
		label: "Project",
		description: "Get a high-level overview of the project: technology stack, key files, and directory structure. Use this first when exploring an unfamiliar codebase instead of raw ls/find.",
		promptSnippet: "Show project overview: stack, key files, and directory structure",
		promptGuidelines: [
			"Use project as the FIRST tool when starting work on an unfamiliar codebase.",
			"Use project to understand the technology stack before choosing which tools to use.",
			"Use project to find the main source directory, test directory, and configuration files.",
			"After project, use find to locate specific files, then outline or read to examine them.",
			"Do not use bash ls or bash find for initial exploration — use project instead.",
		],
		parameters: Type.Object({
			path: Type.Optional(Type.String({ description: "Project root to overview (default: cwd)" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const root = params.path ? resolve(ctx.cwd, params.path) : ctx.cwd;
			const info = await getTopLevelItems(root);

			const lines: string[] = [];
			lines.push(`Project: ${info.name}`);
			lines.push(`Root: ${info.root}`);
			lines.push("");

			if (info.stack.length > 0) {
				lines.push(`Stack: ${info.stack.join(", ")}`);
				lines.push("");
			}

			if (info.keyFiles.length > 0) {
				lines.push("Key files:");
				for (const f of info.keyFiles) lines.push(`  ${f}`);
				lines.push("");
			}

			if (info.dirs.length > 0) {
				lines.push("Directories:");
				for (const d of info.dirs) {
					const icon = d.type === "src" ? "📁" : d.type === "test" ? "🧪" : d.type === "config" ? "⚙️" : d.type === "docs" ? "📖" : "📂";
					lines.push(`  ${icon} ${d.name}/ (${d.type})`);
				}
			}

			return { content: [{ type: "text", text: lines.join("\n") }], details: { stack: info.stack, dirs: info.dirs.length } };
		},
	});
}
