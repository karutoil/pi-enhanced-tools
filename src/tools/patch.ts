/**
 * Patch tool — unified diff application with auto-locate support
 */

import { withFileMutationQueue } from "@mariozechner/pi-coding-agent";
import { readFile, writeFile, access, mkdir, unlink } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve, dirname } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

interface DiffLine { type: " " | "-" | "+"; text: string; noNewline?: boolean; }
interface Hunk {
	oldStart: number | null; oldCount: number | null;
	newStart: number | null; newCount: number | null;
	lines: DiffLine[]; autoLocate: boolean;
}
interface FilePatch {
	oldPath: string | null; newPath: string | null;
	hunks: Hunk[]; isNewFile: boolean; isDeleted: boolean;
}

function parseDiffPath(raw: string): string {
	let path = raw;
	if (path.startsWith('"') && path.endsWith('"')) path = path.slice(1, -1).replace(/\\(.)/g, "$1");
	if (path.startsWith("a/") || path.startsWith("b/")) path = path.slice(2);
	return path;
}

function parseUnifiedDiff(diff: string): FilePatch[] {
	const lines = diff.split("\n");
	const patches: FilePatch[] = [];
	let currentPatch: FilePatch | null = null;
	let currentHunk: Hunk | null = null;
	let i = 0;

	while (i < lines.length) {
		const line = lines[i];
		if (line.startsWith("--- ")) {
			if (currentPatch) {
				if (currentHunk) { currentPatch.hunks.push(currentHunk); currentHunk = null; }
				patches.push(currentPatch);
			}
			const nextLine = lines[i + 1];
			if (!nextLine || !nextLine.startsWith("+++ ")) throw new Error(`Invalid diff at line ${i + 1}: expected +++ after ---`);
			const oldRaw = line.slice(4).trim();
			const newRaw = nextLine.slice(4).trim();
			currentPatch = {
				oldPath: oldRaw === "/dev/null" ? null : parseDiffPath(oldRaw),
				newPath: newRaw === "/dev/null" ? null : parseDiffPath(newRaw),
				hunks: [],
				isNewFile: oldRaw === "/dev/null",
				isDeleted: newRaw === "/dev/null",
			};
			i += 2;
			continue;
		}
		if (!currentPatch) { i++; continue; }

		const autoLocateMatch = line.match(/^@@\s+@@/);
		const numberedMatch = autoLocateMatch ? null : line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
		if (autoLocateMatch || numberedMatch) {
			if (currentHunk) currentPatch.hunks.push(currentHunk);
			if (autoLocateMatch) {
				currentHunk = { oldStart: null, oldCount: null, newStart: null, newCount: null, lines: [], autoLocate: true };
			} else {
				currentHunk = {
					oldStart: parseInt(numberedMatch![1], 10), oldCount: parseInt(numberedMatch![2] ?? "1", 10),
					newStart: parseInt(numberedMatch![3], 10), newCount: parseInt(numberedMatch![4] ?? "1", 10),
					lines: [], autoLocate: false,
				};
			}
			i++;
			continue;
		}
		if (!currentHunk) { i++; continue; }
		if (line === "\\ No newline at end of file") {
			const prev = currentHunk.lines[currentHunk.lines.length - 1];
			if (prev) prev.noNewline = true;
			i++;
			continue;
		}
		if (line.length > 0 && (line[0] === " " || line[0] === "-" || line[0] === "+")) {
			currentHunk.lines.push({ type: line[0] as " " | "-" | "+", text: line.slice(1) });
		}
		i++;
	}
	if (currentHunk && currentPatch) currentPatch.hunks.push(currentHunk);
	if (currentPatch) patches.push(currentPatch);
	if (patches.length === 0) throw new Error("No file patches found. Ensure diff contains --- and +++ headers.");
	return patches;
}

function splitLines(content: string) {
	if (content === "") return { lines: [] as string[], hasTrailingNewline: false };
	const hasTrailingNewline = content.endsWith("\n");
	return { lines: (hasTrailingNewline ? content.slice(0, -1) : content).split("\n"), hasTrailingNewline };
}
function arraysEqual(a: string[], b: string[]) {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}
function findAllMatches(haystack: string[], needle: string[]) {
	const matches: number[] = [];
	if (needle.length === 0) return matches;
	for (let i = 0; i <= haystack.length - needle.length; i++) {
		if (arraysEqual(haystack.slice(i, i + needle.length), needle)) matches.push(i);
	}
	return matches;
}
function findHunkByContext(fileLines: string[], hunk: Hunk): number {
	const contextLines = hunk.lines.filter(l => l.type === " " || l.type === "-").map(l => l.text);
	if (contextLines.length === 0) return Math.max(0, Math.min((hunk.oldStart ?? 1) - 1, fileLines.length));
	const matches = findAllMatches(fileLines, contextLines);
	if (matches.length === 1) return matches[0];
	if (matches.length === 0) return -1;
	for (const idx of matches) {
		let ok = true, lineIdx = idx;
		for (const dl of hunk.lines) {
			if (dl.type === " " || dl.type === "-") {
				if (fileLines[lineIdx] !== dl.text) { ok = false; break; }
				lineIdx++;
			}
		}
		if (ok) return idx;
	}
	return -1;
}
function findHunkLocation(fileLines: string[], hunk: Hunk): { index: number; fuzzy: boolean } {
	if (hunk.autoLocate) {
		const idx = findHunkByContext(fileLines, hunk);
		return { index: idx, fuzzy: idx !== -1 };
	}
	const oldLines = hunk.lines.filter(l => l.type === " " || l.type === "-").map(l => l.text);
	if (oldLines.length === 0) return { index: Math.max(0, Math.min((hunk.oldStart ?? 1) - 1, fileLines.length)), fuzzy: false };
	const startIdx = (hunk.oldStart ?? 1) - 1;
	if (startIdx >= 0 && startIdx + oldLines.length <= fileLines.length && arraysEqual(fileLines.slice(startIdx, startIdx + oldLines.length), oldLines))
		return { index: startIdx, fuzzy: false };
	for (let offset = 1; offset <= 20; offset++) {
		for (const delta of [-offset, offset]) {
			const idx = startIdx + delta;
			if (idx < 0 || idx + oldLines.length > fileLines.length) continue;
			if (arraysEqual(fileLines.slice(idx, idx + oldLines.length), oldLines)) return { index: idx, fuzzy: true };
		}
	}
	for (let i = 0; i <= fileLines.length - oldLines.length; i++) {
		if (arraysEqual(fileLines.slice(i, i + oldLines.length), oldLines)) return { index: i, fuzzy: true };
	}
	return { index: -1, fuzzy: false };
}
function applyFilePatch(fileContent: string, patch: FilePatch): string {
	if (patch.isNewFile) {
		const lines: string[] = [];
		for (const hunk of patch.hunks) for (const line of hunk.lines) if (line.type === "+") lines.push(line.text);
		const result = lines.join("\n");
		const lastLine = patch.hunks[patch.hunks.length - 1]?.lines.slice(-1)[0];
		if (lastLine?.noNewline) return result;
		return result + "\n";
	}
	if (patch.isDeleted) return "";
	const { lines, hasTrailingNewline } = splitLines(fileContent);
	for (let h = patch.hunks.length - 1; h >= 0; h--) {
		const hunk = patch.hunks[h];
		const { index } = findHunkLocation(lines, hunk);
		if (index === -1) {
			const preview = hunk.lines.filter(l => l.type === " " || l.type === "-").slice(0, 5).map(l => (l.type === "-" ? "-" : " ") + l.text).join("\n");
			throw new Error(`Hunk could not be applied. Context does not match. Expected:\n${preview}`);
		}
		const oldLines = hunk.lines.filter(l => l.type === " " || l.type === "-");
		const newLines = hunk.lines.filter(l => l.type === " " || l.type === "+").map(l => l.text);
		lines.splice(index, oldLines.length, ...newLines);
	}
	let result = lines.join("\n");
	const lastLine = patch.hunks[patch.hunks.length - 1]?.lines.slice(-1)[0];
	if (lastLine?.noNewline) return result;
	if (hasTrailingNewline) result += "\n";
	return result;
}

export function registerPatchTool(pi: ExtensionAPI) {
	pi.registerTool({
		name: "patch",
		label: "Patch",
		description: "Apply unified diff patches to files. Supports standard numbered @@ headers AND auto-locate @@ @@ headers. Multi-file, fuzzy matching, new/deleted files.",
		promptSnippet: "Apply unified diff patches for reliable batch file modifications",
		promptGuidelines: [
			"Use the patch tool for ALL multi-line or multi-location changes. It is far more reliable than edit for batch changes.",
			"Use patch when modifying more than one location in a file, or when modifying multiple files at once.",
			"Prefer patch over edit for all non-trivial changes. Only use edit for a single, isolated text replacement in one file.",
			"When using patch, generate a proper unified diff: start with --- and +++ headers, then @@ hunk markers with context lines.",
			"Use @@ @@ (no numbers) for hunk headers — the tool will auto-locate the context by matching. You do NOT need to know exact line numbers.",
			"Include at least 3 lines of context around each change for robust matching. Copy these directly from the file read output.",
			"The patch tool supports multiple files in one call — group related changes into a single patch.",
			"When a patch fails, read the relevant file sections and regenerate the diff with more surrounding context.",
			"For creating new files, use '--- /dev/null' and '+++ path/to/file' with @@ @@ or @@ -0,0 +1,N @@.",
			"For deleting files, use '--- path/to/file' and '+++ /dev/null'.",
		],
		parameters: Type.Object({
			diff: Type.String({ description: "Unified diff string. Must contain --- and +++ headers per file, followed by @@ hunk markers. Use @@ @@ (no numbers) for auto-locate. Lines with '-' removed, '+' added, ' ' context." }),
		}),
		async execute(_id, params, _signal, onUpdate, ctx) {
			onUpdate?.({ content: [{ type: "text", text: "Parsing diff..." }], details: {} });
			const patches = parseUnifiedDiff(params.diff);
			const results: Array<{ path: string; status: string; message: string }> = [];

			for (const patch of patches) {
				const filePath = patch.newPath ?? patch.oldPath;
				if (!filePath) { results.push({ path: "(unknown)", status: "error", message: "No file path" }); continue; }
				const absPath = resolve(ctx.cwd, filePath);
				onUpdate?.({ content: [{ type: "text", text: `Applying ${filePath}...` }], details: {} });

				try {
					await withFileMutationQueue(absPath, async () => {
						if (patch.isDeleted) {
							try { await access(absPath, constants.F_OK); await unlink(absPath); results.push({ path: filePath, status: "deleted", message: "File deleted" }); }
							catch { results.push({ path: filePath, status: "unchanged", message: "File did not exist" }); }
							return;
						}
						let currentContent = "", fileExisted = false;
						try { currentContent = await readFile(absPath, "utf-8"); fileExisted = true; } catch { /* new file */ }
						if (patch.isNewFile && fileExisted && currentContent.trim().length > 0) throw new Error(`File ${filePath} already exists with content.`);
						const newContent = applyFilePatch(currentContent, patch);
						if (!fileExisted) await mkdir(dirname(absPath), { recursive: true });
						await writeFile(absPath, newContent, "utf-8");
						results.push({ path: filePath, status: fileExisted ? "modified" : "created", message: fileExisted ? `Patched ${patch.hunks.length} hunk(s)` : `Created ${patch.hunks.length} hunk(s)` });
					});
				} catch (err: any) {
					results.push({ path: filePath, status: "error", message: err.message });
				}
			}

			const summary = results.map(r => {
				const icon = r.status === "created" ? "+" : r.status === "modified" ? "~" : r.status === "deleted" ? "-" : r.status === "unchanged" ? "=" : "✗";
				return `${icon} ${r.path}: ${r.message}`;
			}).join("\n");
			const errors = results.filter(r => r.status === "error");
			if (errors.length > 0) throw new Error(`Patch partially failed. ${errors.length} file(s) could not be patched:\n${summary}`);
			return { content: [{ type: "text", text: summary }], details: { results } };
		},
	});
}
