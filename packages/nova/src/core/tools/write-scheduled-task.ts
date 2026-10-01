import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import {
	type AutomationPermissionMode,
	type RecurrenceKind,
	ScheduledTaskStore,
	type ScheduleRule,
	scheduledTaskSummary,
} from "../scheduled-task-store.ts";

const writeScheduledTaskSchema = Type.Object({
	action: Type.Union(
		[Type.Literal("create"), Type.Literal("update"), Type.Literal("delete"), Type.Literal("set_enabled")],
		{
			description:
				"create a new automation, update an existing one, delete when the user asked to remove it, or set_enabled to pause/resume",
		},
	),
	task_id: Type.Optional(
		Type.String({
			description: "Required for update / delete / set_enabled: exact id from query_scheduled_tasks",
		}),
	),
	title: Type.Optional(
		Type.String({
			minLength: 1,
			description: "Required for create: short automation name, e.g. 每日行业调研",
		}),
	),
	prompt: Type.Optional(
		Type.String({
			minLength: 1,
			description:
				"Required for create: the full task body Nova will receive when the schedule fires. Include goals and acceptance criteria.",
		}),
	),
	description: Type.Optional(
		Type.String({ description: "Optional UI note for the user; not sent to the agent unless copied into prompt" }),
	),
	project_path: Type.Optional(
		Type.String({
			description: "Absolute project path used as the agent cwd at fire time; required for create",
		}),
	),
	kind: Type.Optional(
		Type.Union([Type.Literal("once"), Type.Literal("recurring")], {
			description: "once fires a single time; recurring repeats. Required for create.",
		}),
	),
	run_at: Type.Optional(
		Type.String({ description: "once only: RFC 3339 timestamp of the single fire, e.g. 2026-09-24T09:30:00+08:00" }),
	),
	recurrence: Type.Optional(
		Type.Union([Type.Literal("daily"), Type.Literal("weekly"), Type.Literal("monthly"), Type.Literal("cron")], {
			description: "recurring only: repeat rule",
		}),
	),
	time_of_day: Type.Optional(
		Type.String({ description: "daily / weekly / monthly: local time as HH:mm, e.g. 09:30" }),
	),
	weekdays: Type.Optional(
		Type.Array(Type.Integer({ minimum: 0, maximum: 6 }), {
			maxItems: 7,
			description: "weekly only: weekdays 0=Mon .. 6=Sun",
		}),
	),
	month_days: Type.Optional(
		Type.Array(Type.Integer({ minimum: 1, maximum: 28 }), {
			maxItems: 28,
			description: "monthly only: days 1..28",
		}),
	),
	cron: Type.Optional(
		Type.String({ description: "cron recurrence only: 5-or-6 field cron expression in local time" }),
	),
	permission_mode: Type.Optional(
		Type.Union([Type.Literal("ask"), Type.Literal("edits"), Type.Literal("allow")], {
			description:
				"Automation tool permission when the schedule fires. Default ask. Prefer edits/allow for unattended runs.",
		}),
	),
	model: Type.Optional(Type.String({ description: "Optional model id override at fire time" })),
	provider: Type.Optional(Type.String({ description: "Optional provider id override at fire time" })),
	session_mode: Type.Optional(
		Type.Union([Type.Literal("fresh"), Type.Literal("reuse")], {
			description:
				"fresh starts a new Nova session on every fire; reuse (default for new tasks) keeps appending to one session so earlier context, e.g. research notes, stays available.",
		}),
	),
	worktree_enabled: Type.Optional(
		Type.Boolean({ description: "Run the fired agent in an isolated git worktree when the project is a git repo" }),
	),
	enabled: Type.Optional(
		Type.Boolean({ description: "set_enabled: true to resume, false to pause. create/update may also set this." }),
	),
});

export type WriteScheduledTaskInput = Static<typeof writeScheduledTaskSchema>;

export interface WriteScheduledTaskDetails {
	action: WriteScheduledTaskInput["action"];
	status: "ok" | "error";
	task?: ReturnType<typeof scheduledTaskSummary>;
	error?: string;
}

function errorResult(action: WriteScheduledTaskInput["action"], error: unknown) {
	const message = error instanceof Error ? error.message : String(error);
	return {
		content: [{ type: "text" as const, text: `Error: ${message}` }],
		details: { action, status: "error" as const, error: message },
	};
}

function buildRule(input: WriteScheduledTaskInput, base?: ScheduleRule): ScheduleRule {
	const kind = input.kind ?? base?.kind;
	if (kind === "once") {
		const runAt = input.run_at ?? base?.runAt;
		if (!runAt) throw new Error("once schedule requires run_at");
		return { kind: "once", runAt };
	}
	if (kind === "recurring") {
		const recurrence = (input.recurrence ?? base?.recurrence) as RecurrenceKind | undefined;
		if (!recurrence) throw new Error("recurring schedule requires recurrence");
		if (recurrence === "cron") {
			const cron = input.cron ?? base?.cron;
			if (!cron) throw new Error("cron recurrence requires cron");
			return { kind: "recurring", recurrence, cron };
		}
		const rule: ScheduleRule = {
			kind: "recurring",
			recurrence,
			timeOfDay: input.time_of_day ?? base?.timeOfDay ?? "09:30",
		};
		if (recurrence === "weekly") {
			rule.weekdays = input.weekdays?.length ? input.weekdays : (base?.weekdays ?? [0]);
		}
		if (recurrence === "monthly") {
			rule.monthDays = input.month_days?.length ? input.month_days : (base?.monthDays ?? [1]);
		}
		return rule;
	}
	throw new Error("create/update of the schedule rule requires kind (once | recurring)");
}

/**
 * Mutate the user's 定时任务 list. Only write when the user explicitly asked to
 * create, change, pause, or remove an automation — do not invent schedules from
 * casual chat. Pair with query_scheduled_tasks to avoid duplicates.
 */
export function createWriteScheduledTaskToolDefinition(): ToolDefinition<
	typeof writeScheduledTaskSchema,
	WriteScheduledTaskDetails
> {
	return {
		name: "write_scheduled_task",
		label: "write_scheduled_task",
		description:
			"Create, update, pause/resume, or delete a Nova scheduled task (定时任务) — a timed automation that spawns Nova with the stored prompt. The user sees these on the Nova Studio scheduled-task page. Always query_scheduled_tasks first so existing automations are updated instead of duplicated. Delete only when the user asked to remove the automation.",
		promptSnippet: "Create or change Nova scheduled tasks (定时任务 automations).",
		promptGuidelines: [
			"Only write scheduled tasks when the user explicitly asked for a timed/recurring automation; do not convert ordinary chat into schedules.",
			"Call query_scheduled_tasks with action list before create; prefer update on an existing id when the user is revising that automation.",
			"create requires title, prompt, project_path, and kind. once needs run_at (RFC 3339). recurring needs recurrence (daily/weekly/monthly/cron) plus time_of_day or cron.",
			"The prompt is what Nova receives at fire time — put the full job description and acceptance criteria there, not just a title.",
			"permission_mode defaults to ask and will block unattended runs on tool confirmations; suggest edits or allow when the user wants fully automatic execution.",
			"session_mode defaults to reuse so recurring research keeps its earlier context; use fresh when each run should start from a clean conversation.",
			"Use set_enabled to pause or resume without deleting. Use delete only when the user asked to remove the automation.",
			"Automations are separate from todos: do not use write_scheduled_task for ordinary deliverables, and do not use the todo tool for timed automations.",
		],
		parameters: writeScheduledTaskSchema,
		executionMode: "sequential",
		async execute(_toolCallId, input, _signal, _onUpdate, ctx) {
			try {
				const store = new ScheduledTaskStore();

				if (input.action === "create") {
					if (!input.title) throw new Error("create requires title");
					if (!input.prompt) throw new Error("create requires prompt");
					if (!input.project_path) throw new Error("create requires project_path");
					if (!input.kind) throw new Error("create requires kind (once | recurring)");
					const task = store.create({
						title: input.title,
						prompt: input.prompt,
						description: input.description,
						projectPath: input.project_path,
						schedule: buildRule(input),
						permissionMode: input.permission_mode as AutomationPermissionMode | undefined,
						model: input.model,
						provider: input.provider,
						sessionMode: input.session_mode,
						worktreeEnabled: input.worktree_enabled,
						enabled: input.enabled,
					});
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

				if (input.action === "delete") {
					if (!input.task_id) throw new Error("delete requires task_id");
					store.delete(input.task_id);
					return {
						content: [
							{
								type: "text" as const,
								text: JSON.stringify({ deleted: input.task_id }, null, 2),
							},
						],
						details: { action: input.action, status: "ok" as const },
					};
				}

				if (input.action === "set_enabled") {
					if (!input.task_id) throw new Error("set_enabled requires task_id");
					if (input.enabled === undefined) throw new Error("set_enabled requires enabled");
					const task = store.update(input.task_id, { enabled: input.enabled });
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

				if (!input.task_id) throw new Error("update requires task_id");
				const existing = store.get(input.task_id);
				const ruleTouched = Boolean(
					input.kind || input.run_at || input.recurrence || input.time_of_day || input.cron,
				);
				const task = store.update(input.task_id, {
					title: input.title,
					prompt: input.prompt,
					description: input.description,
					projectPath: input.project_path,
					schedule: ruleTouched ? buildRule(input, existing.schedule) : undefined,
					permissionMode: input.permission_mode as AutomationPermissionMode | undefined,
					model: input.model,
					provider: input.provider,
					sessionMode: input.session_mode,
					worktreeEnabled: input.worktree_enabled,
					enabled: input.enabled,
				});
				void ctx;
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({ task: scheduledTaskSummary(task) }, null, 2),
						},
					],
					details: { action: input.action, status: "ok" as const, task: scheduledTaskSummary(task) },
				};
			} catch (error) {
				return errorResult(input.action, error);
			}
		},
	};
}
