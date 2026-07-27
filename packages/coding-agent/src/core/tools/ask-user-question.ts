import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";

const OptionSchema = Type.Object({
	label: Type.String({ description: "Display label for the option" }),
	description: Type.Optional(Type.String({ description: "Optional description shown below label" })),
});

const askUserQuestionSchema = Type.Object({
	question: Type.String({ description: "The question to ask the user" }),
	options: Type.Optional(
		Type.Array(OptionSchema, { description: "Options for the user to choose from (omit for free-text input)" }),
	),
});

export type AskUserQuestionToolInput = Static<typeof askUserQuestionSchema>;

export interface AskUserQuestionOption {
	label: string;
	description?: string;
}

export interface AskUserQuestionDetails {
	question: string;
	options: string[];
	answer: string | null;
}

export function createAskUserQuestionToolDefinition(): ToolDefinition<typeof askUserQuestionSchema, AskUserQuestionDetails> {
	return {
		name: "ask_user_question",
		label: "ask_user_question",
		description:
			"Ask the user a question and wait for their response. Use when you need user input, clarification, or a decision to proceed. Provide options for the user to pick from, or omit options for free-text input.",
		promptSnippet: "Ask the user a question to get input or make a decision.",
		parameters: askUserQuestionSchema,
		async execute(_toolCallId, { question, options }, _signal, _onUpdate, ctx) {
			if (!ctx?.ui) {
				return {
					content: [{ type: "text", text: "Error: UI not available (running in non-interactive mode)" }],
					details: { question, options: options?.map((o) => o.label) ?? [], answer: null },
				};
			}

			if (options && options.length === 0) {
				return {
					content: [{ type: "text", text: "Error: options array must not be empty if provided" }],
					details: { question, options: [], answer: null },
				};
			}

			const simpleOptions = options?.map((o) => o.label) ?? [];

			if (options) {
				const allOptions = [...options.map((o) => o.label), "Type something"];
				const selected = await ctx.ui.select(question, allOptions);

				if (selected === undefined) {
					return {
						content: [{ type: "text", text: "User cancelled the question" }],
						details: { question, options: simpleOptions, answer: null },
					};
				}

				if (selected === "Type something") {
					const customAnswer = await ctx.ui.input(question, "Type your answer...");
					if (customAnswer === undefined) {
						return {
							content: [{ type: "text", text: "User cancelled the question" }],
							details: { question, options: simpleOptions, answer: null },
						};
					}
					return {
						content: [{ type: "text", text: `User wrote: ${customAnswer}` }],
						details: { question, options: simpleOptions, answer: customAnswer },
					};
				}

				return {
					content: [{ type: "text", text: `User selected: ${selected}` }],
					details: { question, options: simpleOptions, answer: selected },
				};
			}

			const answer = await ctx.ui.input(question, "Type your answer...");
			if (answer === undefined) {
				return {
					content: [{ type: "text", text: "User cancelled the question" }],
					details: { question, options: [], answer: null },
				};
			}

			return {
				content: [{ type: "text", text: `User answered: ${answer}` }],
				details: { question, options: [], answer },
			};
		},
	};
}
