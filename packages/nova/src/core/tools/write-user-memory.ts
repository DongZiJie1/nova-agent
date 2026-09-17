import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import { UserMemoryStore } from "../user-memory.ts";

const writeUserMemorySchema = Type.Object({
	section_id: Type.Optional(
		Type.String({ description: "Existing section id when updating; omit to create a new section" }),
	),
	title: Type.String({
		minLength: 1,
		description: "A concise custom section title chosen for this user's information",
	}),
	content: Type.String({
		minLength: 1,
		description: "The complete replacement text for this profile section, preserving still-valid existing details",
	}),
});

export type WriteUserMemoryInput = Static<typeof writeUserMemorySchema>;

export interface WriteUserMemoryDetails {
	sectionId?: string;
	title: string;
	content: string;
	action: "created" | "updated" | "error";
}

export function createWriteUserMemoryToolDefinition(): ToolDefinition<
	typeof writeUserMemorySchema,
	WriteUserMemoryDetails
> {
	return {
		name: "write_user_memory",
		label: "write_user_memory",
		description:
			"Create or update a custom section in the user's durable profile. Use an existing section_id for related information, preserving still-valid details because content replaces the entire section. Omit section_id and choose a concise title only when no existing section fits.",
		promptSnippet: "Update one section of the user's durable multi-section profile.",
		promptGuidelines: [
			"Use write_user_memory only for stable user information explicitly shared or clearly confirmed; section titles are user-specific and must not come from a fixed taxonomy.",
			"The tool replaces the complete target section, so retain all still-valid details from that section when adding or changing information.",
			"Never store credentials, secrets, payment information, sensitive personal information, temporary task details, or inferences about the user.",
		],
		parameters: writeUserMemorySchema,
		executionMode: "sequential",
		async execute(_toolCallId, input) {
			try {
				const memory = new UserMemoryStore().upsertSection(input.section_id, input.title, input.content);
				return {
					content: [{ type: "text", text: `User memory section updated: ${memory.title}` }],
					details: {
						sectionId: memory.id,
						title: memory.title,
						content: memory.content,
						action: input.section_id ? "updated" : "created",
					},
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					content: [{ type: "text", text: `Unable to save user memory: ${message}` }],
					details: { sectionId: input.section_id, title: input.title, content: input.content, action: "error" },
				};
			}
		},
	};
}
