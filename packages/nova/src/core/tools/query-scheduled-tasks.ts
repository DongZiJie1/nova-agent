import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import { type ScheduledTask, ScheduledTaskStore, scheduledTaskSummary } from "../scheduled-task-store.ts";

const MAX_LIST = 50;

const queryScheduledTasksSchema = Type.Object({
	action: Type.Union([Type.Literal("list"), Type.Literal("get")], {
		description: "list returns filtered tasks; get returns one task by task_id",
	}),
	task_id: Type.Optional(
		Type.String({ description: "Required for get: exact id returned by write_scheduled_task or list" }),
	),
	enabled: Type.Optional(Type.Boolean({ description: "list only: filter by enabled flag" })),
	kind: Type.Optional(
		Type.Union([Type.Literal("once"), Type.Literal("recurring")], {
			description: "list only: filter by schedule kind",
		}),
	),
	query: Type.Optional(
		Type.String({ description: "list only: case-insensitive substring match on title and prompt" }),
	),
	offset: Type.Optional(
		Type.Integer({ minimum: 0, description: "List pagination offset; use with limit to read the entire list." }),
	),
	limit: Type.Optional(Type.Number({ minimum: 1, maximum: MAX_LIST, description: "Maximum tasks to list" })),
});

export type QueryScheduledTasksInput = Static<typeof queryScheduledTasksSchema>;

export interface QueryScheduledTasksDetails {
	action: QueryScheduledTasksInput["action"];
	status: "ok" | "error";
	task?: ReturnType<typeof scheduledTaskSummary>;
	tasks?: ReturnType<typeof scheduledTaskSummary>[];
	total?: number;
	error?: string;
}

function errorResult(action: QueryScheduledTasksInput["action"], error: unknown) {
	const message = error instanceof Error ? error.message : String(error);
	return {
		content: [{ type: "text" as const, text: `Error: ${message}` }],
		details: { action, status: "error" as const, error: message },
	};
}

function matchesFilters(task: ScheduledTask, input: QueryScheduledTasksInput): boolean {
	if (input.enabled !== undefined && task.enabled !== input.enabled) return false;
	if (input.kind && task.schedule.kind !== input.kind) return false;
	const query = input.query?.trim().toLocaleLowerCase();
	if (query) {
		const haystack = `${task.title}\n${task.prompt}\n${task.description ?? ""}`.toLocaleLowerCase();
		if (!haystack.includes(query)) return false;
	}
	return true;
}

/**
 * Read-only view of the user's 定时任务 list (the Nova Studio scheduled-task
 * page). Use before write_scheduled_task so an already-tracked automation is
 * updated instead of duplicated.
 */
export function createQueryScheduledTasksToolDefinition(): ToolDefinition<
	typeof queryScheduledTasksSchema,
	QueryScheduledTasksDetails
> {
	return {
		name: "query_scheduled_tasks",
		label: "query_scheduled_tasks",
		description:
			"Read Nova scheduled tasks (定时任务) — the automations on the Nova Studio scheduled-task page. Use action list to survey existing automations before creating or changing one, and action get to inspect a single task including its schedule and recent runs. This tool never writes.",
		promptSnippet: "Read the user's Nova scheduled tasks (定时任务).",
		promptGuidelines: [
			"Scheduled tasks are timed automations that spawn Nova at a trigger; they are not the same as todo items.",
			"Call query_scheduled_tasks with action list before write_scheduled_task so an existing automation is updated instead of duplicated.",
			"Use get with task_id when the user asks about one automation's schedule, next run, or recent run history.",
			"nextRunAt is the planned slot; lastRunStatus describes the most recent fire (running / completed / error / missed / skipped).",
		],
		parameters: queryScheduledTasksSchema,
		executionMode: "sequential",
		async execute(_toolCallId, input) {
			try {
				const store = new ScheduledTaskStore();

				if (input.action === "get") {
					if (!input.task_id) throw new Error("get requires task_id");
					const task = store.get(input.task_id);
					return {
						content: [
							{
								type: "text" as const,
								text: JSON.stringify({ task: scheduledTaskSummary(task) }, null, 2),
							},
						],
						details: { action: input.action, status: "ok" as const, task: scheduledTaskSummary(task) },
					};
				}

				const all = store.list().filter((task) => matchesFilters(task, input));
				const offset = input.offset ?? 0;
				const limit = Math.min(input.limit ?? MAX_LIST, MAX_LIST);
				const page = all.slice(offset, offset + limit);
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify(
								{
									total: all.length,
									tasks: page.map(scheduledTaskSummary),
									truncated: all.length > offset + limit,
									nextOffset: all.length > offset + limit ? offset + limit : undefined,
								},
								null,
								2,
							),
						},
					],
					details: {
						action: input.action,
						status: "ok" as const,
						tasks: page.map(scheduledTaskSummary),
						total: all.length,
					},
				};
			} catch (error) {
				return errorResult(input.action, error);
			}
		},
	};
}
