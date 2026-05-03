/**
 * Enhanced Tools Extension for pi
 *
 * Replaces and augments built-in tools with agent-friendly alternatives:
 * - patch: unified diff with auto-locate (no line numbers needed)
 * - outline: file structure without implementation noise
 * - rg: enhanced code search with structured output
 * - test: auto-detect and run tests, extract failures
 * - validate: compile/typecheck with error locations
 * - git: semantic git operations
 * - scratch: persistent session notes
 * - deps: import/dependency graph
 * - refactor: multi-file rename
 * - history: track session file changes
 * - ask: pause to ask user questions
 * - find: structured file/directory search
 * - project: high-level project overview
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerPatchTool } from "./tools/patch.js";
import { registerOutlineTool } from "./tools/outline.js";
import { registerRgTool } from "./tools/rg.js";
import { registerTestTool } from "./tools/test.js";
import { registerValidateTool } from "./tools/validate.js";
import { registerGitTool } from "./tools/git.js";
import { registerScratchTool } from "./tools/scratch.js";
import { registerDepsTool } from "./tools/deps.js";
import { registerRefactorTool } from "./tools/refactor.js";
import { registerHistoryTool, trackChange } from "./tools/history.js";
import { registerAskTool } from "./tools/ask.js";
import { registerFindTool } from "./tools/find.js";
import { registerProjectTool } from "./tools/project.js";
import { registerBuildTool } from "./tools/build.js";

export default function enhancedToolsExtension(pi: ExtensionAPI) {
	// ─── Register all tools ──────────────────────────────────────────
	registerPatchTool(pi);
	registerOutlineTool(pi);
	registerRgTool(pi);
	registerTestTool(pi);
	registerValidateTool(pi);
	registerGitTool(pi);
	registerScratchTool(pi);
	registerDepsTool(pi);
	registerRefactorTool(pi);
	registerHistoryTool(pi);
	registerAskTool(pi);
	registerFindTool(pi);
	registerProjectTool(pi);
	registerBuildTool(pi);

	// ─── Track file changes for history ──────────────────────────────
	let turnIndex = 0;

	pi.on("turn_start", () => {
		turnIndex++;
	});

	pi.on("tool_result", async (event: any, _ctx) => {
		if (event.toolName === "patch" && !event.isError && event.details?.results) {
			for (const r of event.details.results) {
				if (r.status === "created" || r.status === "modified" || r.status === "deleted") {
					trackChange(pi, turnIndex, "patch", r.path, r.status);
				}
			}
		}
		if (event.toolName === "write" && !event.isError) {
			const path = event.input?.path ?? "unknown";
			trackChange(pi, turnIndex, "write", path, "created");
		}
		if (event.toolName === "edit" && !event.isError) {
			const path = event.input?.path ?? "unknown";
			trackChange(pi, turnIndex, "edit", path, "modified");
		}
		if (event.toolName === "refactor" && !event.isError && event.details?.files) {
			trackChange(pi, turnIndex, "refactor", (event.input?.old ?? "") + "→" + (event.input?.new ?? ""), "modified");
		}
	});

	// ─── Notify on load ──────────────────────────────────────────────
	pi.on("session_start", async (_event, ctx) => {
		const tools = ["patch", "outline", "rg", "test", "validate", "build", "git", "scratch", "deps", "refactor", "history", "ask", "find", "project"];
		ctx.ui.notify(`Enhanced tools loaded: ${tools.join(", ")}`, "info");
	});
}
