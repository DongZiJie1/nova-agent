import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import { type TodoItem, type TodoPriority, type TodoStatus, TodoStore } from "../todo-store.ts";

const MAX_LIST = 50;
const MAX_DESCRIPTION_CHARS = 600;

const todoSchema = Type.Object({
	action: Type.Union([Type.Literal("create"), Type.Literal("list"), Type.Literal("update")], {
		description: "Todo operation to perform",
	}),
	title: Type.Optional(
		Type.String({
			minLength: 1,
			description: "Required for create: one self-contained deliverable the user can track, not a single step",
		}),
	),
	description: Type.Optional(
		Type.String({
			description: "Optional background, goal, or acceptance criteria shown in the todo detail panel",
		}),
	),
	priority: Type.Optional(
		Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")], {
			description: "Defaults to medium when creating; sets the priority when updating",
		}),
	),
	project_path: Type.Optional(
		Type.String({
			description:
				"Absolute path of the project this work belongs to; defaults to the current working directory when creating",
		}),
	),
	due_at: Type.Optional(Type.String({ description: "Due date as YYYY-MM-DD, or an RFC 3339 timestamp" })),
	todo_id: Type.Optional(
		Type.String({ description: "Required for update: exact id returned by an earlier create or list call" }),
	),
	status: Type.Optional(
		Type.Union([Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("completed")], {
			description: "New status for update, or a filter for list",
		}),
	),
	limit: Type.Optional(Type.Number({ minimum: 1, maximum: MAX_LIST, description: "Maximum todos to list" })),
});

export type TodoToolInput = Static<typeof todoSchema>;

export interface TodoToolDetails {
	action: TodoToolInput["action"];
	status: "ok" | "error";
	todo?: TodoItem;
	todos?: TodoItem[];
	total?: number;
	error?: string;
}

/** Descriptions can be long; the model only needs enough to recognize the item. */
function todoSummary(todo: TodoItem) {
	return {
		id: todo.id,
		title: todo.title,
		status: todo.status,
		priority: todo.priority,
		projectPath: todo.projectPath,
		dueAt: todo.dueAt,
		source: todo.source,
		description:
			todo.description.length > MAX_DESCRIPTION_CHARS
				? `${todo.description.slice(0, MAX_DESCRIPTION_CHARS)}…`
				: todo.description,
		createdAt: todo.createdAt,
		updatedAt: todo.updatedAt,
		completedAt: todo.completedAt,
	};
}

function errorResult(action: TodoToolInput["action"], error: unknown) {
	const message = error instanceof Error ? error.message : String(error);
	return {
		content: [{ type: "text" as const, text: `Error: ${message}` }],
		details: { action, status: "error" as const, error: message },
	};
}

/**
 * Nova's own scratch checkouts are not projects. Linking a todo to a worktree
 * under `~/.nova/worktrees/` or to a temp runtime directory would make the
 * 待办 page offer to start future work in a directory that will disappear.
 */
function defaultProjectPath(cwd: string): string | undefined {
	const normalized = cwd.replace(/\\/g, "/");
	const directoryName = normalized.split("/").filter(Boolean).pop() ?? "";
	if (directoryName.startsWith("pi-runtime")) return undefined;
	if (normalized.includes("/.nova/worktrees/")) return undefined;
	return cwd;
}

export function createTodoToolDefinition(): ToolDefinition<typeof todoSchema, TodoToolDetails> {
	return {
		name: "todo",
		label: "todo",
		description:
			"Nova's todo list — the items the user sees on the 待办 page of Nova Studio. Use it to record work that should outlive this conversation, and to keep an existing item's status current. Create one todo per deliverable, list before creating to avoid duplicates, and update the same todo while working on it instead of creating another one.",
		promptSnippet: "Record and update items on the user's Nova todo list.",
		promptGuidelines: [
			"A todo is a deliverable the user tracks later, not a step of the current task: record it when the user asks for a reminder, or when work is agreed but cannot be finished now.",
			"Call todo with action list before creating, so an already-tracked item is updated instead of duplicated.",
			"Mark a todo in_progress when work on it actually starts and completed only when the work is done and verified — never to look finished.",
			"The todo list belongs to the user: do not delete or reprioritize their entries unless they asked for it.",
		],
		parameters: todoSchema,
		executionMode: "sequential",
		async execute(_toolCallId, input, _signal, _onUpdate, ctx) {
			try {
				// Nova Studio tags every agent process with its agent id; todos created
				// here stay linked to that conversation so the UI can reopen it.
				const agentId = process.env.NOVA_AGENT_ID?.trim();
				const store = new TodoStore();

				if (input.action === "create") {
					if (!input.title) throw new Error("create requires title");
					const todo = store.create({
						title: input.title,
						description: input.description,
						priority: input.priority as TodoPriority | undefined,
						projectPath: input.project_path ?? defaultProjectPath(ctx.cwd),
						dueAt: input.due_at,
						agentId,
						sessionId: agentId,
					});
					return {
						content: [{ type: "text" as const, text: JSON.stringify({ todo: todoSummary(todo) }, null, 2) }],
						details: { action: input.action, status: "ok" as const, todo },
					};
				}

				if (input.action === "list") {
					const status = input.status as TodoStatus | undefined;
					const todos = store.list(status);
					const limit = Math.min(input.limit ?? MAX_LIST, MAX_LIST);
					return {
						content: [
							{
								type: "text" as const,
								text: JSON.stringify(
									{
										total: todos.length,
										todos: todos.slice(0, limit).map(todoSummary),
										truncated: todos.length > limit,
									},
									null,
									2,
								),
							},
						],
						details: {
							action: input.action,
							status: "ok" as const,
							todos: todos.slice(0, limit),
							total: todos.length,
						},
					};
				}

				if (!input.todo_id) throw new Error("update requires todo_id");
				const todo = store.update(input.todo_id, {
					title: input.title,
					description: input.description,
					status: input.status as TodoStatus | undefined,
					priority: input.priority as TodoPriority | undefined,
					projectPath: input.project_path,
					dueAt: input.due_at,
				});
				return {
					content: [{ type: "text" as const, text: JSON.stringify({ todo: todoSummary(todo) }, null, 2) }],
					details: { action: input.action, status: "ok" as const, todo },
				};
			} catch (error) {
				return errorResult(input.action, error);
			}
		},
	};
}
