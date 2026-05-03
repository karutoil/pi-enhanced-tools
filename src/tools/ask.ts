/**
 * Ask tool — pause to ask the user a question
 */

import { Type } from "typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export function registerAskTool(pi: ExtensionAPI) {
	pi.registerTool({
		name: "ask",
		label: "Ask",
		description: "Pause execution and ask the user a question. Use when you need clarification, a decision, or confirmation before proceeding. Only works in interactive mode.",
		promptSnippet: "Ask the user a clarifying question",
		promptGuidelines: [
			"Use ask when you encounter ambiguity and the wrong choice would waste significant effort.",
			"Use ask for confirmation before destructive operations (deleting files, major rewrites).",
			"Use ask when the user request has multiple valid interpretations.",
			"Keep questions concise and provide clear options when possible.",
			"Do not use ask for trivial decisions the agent should make itself.",
			"If ask fails (non-interactive mode), fall back to making a reasonable assumption and stating it.",
		],
		parameters: Type.Object({
			question: Type.String({ description: "The question to ask the user" }),
			options: Type.Optional(Type.Array(Type.String(), { description: "Optional preset answers for the user to choose from" })),
			recommended: Type.Optional(Type.String({ description: "Recommended fallback answer. If options are provided, this should match one of them. Auto-selected if user does not respond in time." })),
			timeout: Type.Optional(Type.Number({ default: 60, description: "Seconds to wait for a user response before auto-selecting the recommended answer. Default: 60." })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (!ctx.hasUI) {
				return {
					content: [{ type: "text", text: `[Non-interactive mode: cannot ask user. Falling back to default assumption.]\nQuestion was: ${params.question}` }],
					details: { answered: false, fallback: true },
				};
			}

			const timeoutMs = (params.timeout ?? 60) * 1000;
			let answer: string | undefined;
			let timedOut = false;

			if (params.options && params.options.length > 0) {
				// Determine the recommended option
				let recommended: string | undefined;
				if (params.recommended !== undefined) {
					// Try exact match first, then index
					if (params.options.includes(params.recommended)) {
						recommended = params.recommended;
					} else {
						const idx = parseInt(params.recommended, 10);
						if (!Number.isNaN(idx) && idx >= 0 && idx < params.options.length) {
							recommended = params.options[idx];
						}
					}
				}
				// Default recommended to first option if not specified
				if (!recommended) {
					recommended = params.options[0];
				}

				answer = await Promise.race([
					ctx.ui.select(params.question, params.options).then(c => c ?? "(cancelled)"),
					new Promise<string>(resolve => {
						setTimeout(() => {
							timedOut = true;
							resolve(recommended!);
						}, timeoutMs);
					}),
				]);
			} else {
				const fallback = params.recommended ?? "(no response)";
				answer = await Promise.race([
					ctx.ui.input(params.question, "Answer...").then(i => i ?? "(cancelled)"),
					new Promise<string>(resolve => {
						setTimeout(() => {
							timedOut = true;
							resolve(fallback);
						}, timeoutMs);
					}),
				]);
			}

			return {
				content: [{ type: "text", text: timedOut
					? `Timed out after ${params.timeout ?? 60}s — auto-selected: ${answer}`
					: `User answered: ${answer}` }],
				details: { answered: true, answer, timedOut },
			};
		},
	});
}
