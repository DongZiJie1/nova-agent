import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import { type TodoItem, type TodoPriority, type TodoStatus, TodoStore, todoTopic } from "../todo-store.ts";

const MAX_LIST = 50;
const MAX_DESCRIPTION_CHARS = 600;
const MAX_TAGS_LISTED = 24;

const todoSchema = Type.Object({
	topic: Type.Optional(
		Type.String({
			description: "Topic this todo belongs to; defaults to the first tag, or 未分类. Also filters list by topic.",
		}),
	),
	offset: Type.Optional(
		Type.Integer({ minimum: 0, description: "List pagination offset; use with limit to read the entire list." }),
	),
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
	tags: Type.Optional(
		Type.Array(Type.String(), {
			maxItems: 5,
			description:
				"Up to 5 short labels for later grouping, e.g. 论文 / 实验 / 工程 / 学习. Create: the todo's tags. Update: replaces the whole list (pass an empty array to clear). Reuse a tag that already exists instead of inventing a near-duplicate.",
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
	tag: Type.Optional(
		Type.String({
			description: "list only: return the todos carrying this tag (case-insensitive)",
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
	availableTags?: string[];
	error?: string;
}

/** Descriptions can be long; the model only needs enough to recognize the item. */
function todoSummary(todo: TodoItem) {
	return {
		id: todo.id,
		title: todo.title,
		status: todo.status,
		topic: todoTopic(todo),
		priority: todo.priority,
		tags: todo.tags,
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

/** Distinct tags in use, most frequent first, so the model reuses them. */
function existingTags(todos: readonly TodoItem[]): string[] {
	const counts = new Map<string, { label: string; count: number }>();
	for (const todo of todos) {
		for (const tag of todo.tags) {
			const key = tag.toLocaleLowerCase();
			const entry = counts.get(key);
			if (entry) entry.count += 1;
			else counts.set(key, { label: tag, count: 1 });
		}
	}
	return [...counts.values()]
		.sort((left, right) => right.count - left.count || left.label.localeCompare(right.label))
		.slice(0, MAX_TAGS_LISTED)
		.map((entry) => entry.label);
}

export function createTodoToolDefinition(): ToolDefinition<typeof todoSchema, TodoToolDetails> {
	return {
		name: "todo",
		label: "todo",
		description:
			"Nova's todo list — the items the user sees on the 待办 page of Nova Studio. Use it to record work that should outlive this conversation, and to keep an existing item's status current. Create one todo per deliverable, list before creating to avoid duplicates, and update the same todo while working on it instead of creating another one. Always tag a new todo so the user can group the list later.",
		promptSnippet: "Record and update items on the user's Nova todo list.",
		promptGuidelines: [
			"Every todo belongs to a topic that defaults to its first tag. List first to obtain IDs, and keep related work in the same topic so the page stays grouped.",
			"When the user requests a plan, create its actionable steps. Use offset to read subsequent pages when truncated is true.",
			"Record user-requested plans and deliverables. Do not fill the user's list with your internal scratch work.",
			"Call todo with action list before creating, so an already-tracked item is updated instead of duplicated.",
			"Tag every todo you create or touch when its kind is obvious: 论文 for reading/summarizing papers, 实验 for training or code experiments, 工程 for repo/tooling work, 学习 for study plans, 求职 for career work. One to three tags is usually enough.",
			"Prefer the tags already listed in availableTags over new synonyms (论文, not 文献/Paper/阅读); only add a new tag when the existing ones genuinely do not fit.",
			"Use list with tag to answer questions like “还有哪些论文待办”, and add or fix tags with update when the user renames a group.",
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
						topic: input.topic,
						title: input.title,
						description: input.description,
						tags: input.tags,
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
					const snapshot = store.list();
					const all = status ? snapshot.filter((todo) => todo.status === status) : snapshot;
					const tag = input.tag?.trim().toLocaleLowerCase();
					const tagged = tag
						? all.filter((todo) => todo.tags.some((value) => value.toLocaleLowerCase() === tag))
						: all;
					const todos = input.topic
						? tagged.filter(
								(todo) => todoTopic(todo).toLocaleLowerCase() === input.topic!.trim().toLocaleLowerCase(),
							)
						: tagged;
					const offset = input.offset ?? 0;
					const limit = Math.min(input.limit ?? MAX_LIST, MAX_LIST);
					return {
						content: [
							{
								type: "text" as const,
								text: JSON.stringify(
									{
										total: todos.length,
										todos: todos.slice(offset, offset + limit).map((todo) => ({
											...todoSummary(todo),
										})),
										// Listed so the model reuses the user's existing vocabulary
										// instead of inventing a synonym for every new todo.
										availableTags: existingTags(snapshot),
										availableTopics: [...new Set(snapshot.map(todoTopic))],
										truncated: todos.length > offset + limit,
										nextOffset: todos.length > offset + limit ? offset + limit : undefined,
									},
									null,
									2,
								),
							},
						],
						details: {
							action: input.action,
							status: "ok" as const,
							todos: todos.slice(offset, offset + limit),
							total: todos.length,
							availableTags: existingTags(snapshot),
						},
					};
				}

				if (!input.todo_id) throw new Error("update requires todo_id");
				const todo = store.update(input.todo_id, {
					topic: input.topic,
					title: input.title,
					description: input.description,
					tags: input.tags,
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
