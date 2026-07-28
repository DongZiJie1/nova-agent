import { type Static, Type } from "typebox";
import type { AgentHarnessTool } from "../types.ts";
import type { ExecutionToolContext } from "./tool-context.ts";

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

export interface AskUserQuestionToolOptions {
	askUser: (
		question: string,
		options: AskUserQuestionOption[] | undefined,
		signal?: AbortSignal,
	) => Promise<string | null>;
}

export function createAskUserQuestionTool<TContext extends ExecutionToolContext = ExecutionToolContext>(
	options: AskUserQuestionToolOptions,
): AgentHarnessTool<TContext, typeof askUserQuestionSchema, AskUserQuestionDetails> {
	return {
		name: "ask_user_question",
		label: "ask_user_question",
		description:
			"Ask the user a question and wait for their response. Use when you need user input, clarification, or a decision to proceed. Provide options for the user to pick from, or omit options for free-text input.",
		parameters: askUserQuestionSchema,
		async execute(_toolCallId, { question, options: toolOptions }, signal) {
			const simpleOptions = toolOptions?.map((o) => o.label) ?? [];

			if (toolOptions && toolOptions.length === 0) {
				return {
					content: [{ type: "text", text: "Error: options array must not be empty if provided" }],
					details: { question, options: simpleOptions, answer: null },
				};
			}

			const answer = await options.askUser(question, toolOptions, signal);

			if (answer === null) {
				return {
					content: [{ type: "text", text: "User cancelled the question" }],
					details: { question, options: simpleOptions, answer: null },
				};
			}

			return {
				content: [{ type: "text", text: `User answered: ${answer}` }],
				details: { question, options: simpleOptions, answer },
			};
		},
	};
}
