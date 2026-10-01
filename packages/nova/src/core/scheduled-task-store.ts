import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "../config.ts";

/**
 * Nova's scheduled tasks (定时任务).
 *
 * Shared with Nova Studio: both sides read and write the same
 * `scheduled-tasks.json` in the agent directory. Keep the shape, validation,
 * and write behaviour in sync with `write_scheduled_task_state` /
 * `create_scheduled_task_state` in nova-studio's `src-tauri/src/scheduled_tasks.rs`
 * or the two writers will disagree about what a stored task looks like.
 *
 * Automations stay separate from `todos.json` — different permission mode and
 * run state from normal todos (product requirement).
 */

export type ScheduleKind = "once" | "recurring";
export type RecurrenceKind = "daily" | "weekly" | "monthly" | "cron";
export type ScheduleRunStatus = "running" | "completed" | "error" | "missed" | "skipped";
export type AutomationPermissionMode = "ask" | "edits" | "allow";
/**
 * Session continuity for scheduled runs: `fresh` starts a new Nova session on
 * every fire, `reuse` keeps appending to the task's stored session file.
 */
export type AutomationSessionMode = "fresh" | "reuse";

export interface ScheduleRule {
	kind: ScheduleKind;
	runAt?: string;
	recurrence?: RecurrenceKind;
	timeOfDay?: string;
	weekdays?: number[];
	monthDays?: number[];
	cron?: string;
	timezone?: string;
}

export interface ScheduledRun {
	id: string;
	taskId: string;
	startedAt: string;
	finishedAt?: string;
	status: ScheduleRunStatus;
	agentId?: string;
	sessionId?: string;
	error?: string;
	summary?: string;
	catchUp?: boolean;
}

export interface ScheduledTask {
	id: string;
	title: string;
	prompt: string;
	description?: string;
	projectPath: string;
	enabled: boolean;
	schedule: ScheduleRule;
	permissionMode: AutomationPermissionMode;
	model?: string;
	provider?: string;
	sessionMode: AutomationSessionMode;
	sessionFile?: string;
	worktreeEnabled: boolean;
	lastRunAt?: string;
	lastRunStatus?: ScheduleRunStatus;
	lastAgentId?: string;
	lastSessionId?: string;
	nextRunAt?: string;
	missedCount: number;
	runs: ScheduledRun[];
	createdAt: string;
	updatedAt: string;
	completedAt?: string;
}

export interface ScheduledTaskState {
	version: 1;
	items: ScheduledTask[];
}

export interface CreateScheduledTaskInput {
	title: string;
	prompt: string;
	description?: string;
	projectPath: string;
	schedule: ScheduleRule;
	permissionMode?: AutomationPermissionMode;
	model?: string;
	provider?: string;
	sessionMode?: AutomationSessionMode;
	worktreeEnabled?: boolean;
	enabled?: boolean;
}

export interface UpdateScheduledTaskInput {
	title?: string;
	prompt?: string;
	description?: string;
	projectPath?: string;
	schedule?: ScheduleRule;
	permissionMode?: AutomationPermissionMode;
	model?: string;
	provider?: string;
	sessionMode?: AutomationSessionMode;
	worktreeEnabled?: boolean;
	enabled?: boolean;
}

export const SCHEDULE_TITLE_MAX = 120;
export const SCHEDULE_PROMPT_MAX = 50_000;
export const SCHEDULE_RUNS_CAP = 20;

const SCHEDULE_KINDS: readonly ScheduleKind[] = ["once", "recurring"];
const RECURRENCE_KINDS: readonly RecurrenceKind[] = ["daily", "weekly", "monthly", "cron"];
const PERMISSION_MODES: readonly AutomationPermissionMode[] = ["ask", "edits", "allow"];
const SESSION_MODES: readonly AutomationSessionMode[] = ["fresh", "reuse"];
const RUN_STATUSES: readonly ScheduleRunStatus[] = ["running", "completed", "error", "missed", "skipped"];

export function isScheduleKind(value: string): value is ScheduleKind {
	return (SCHEDULE_KINDS as readonly string[]).includes(value);
}

export function isRecurrenceKind(value: string): value is RecurrenceKind {
	return (RECURRENCE_KINDS as readonly string[]).includes(value);
}

export function isAutomationPermissionMode(value: string): value is AutomationPermissionMode {
	return (PERMISSION_MODES as readonly string[]).includes(value);
}

export function isAutomationSessionMode(value: string): value is AutomationSessionMode {
	return (SESSION_MODES as readonly string[]).includes(value);
}

export function isScheduleRunStatus(value: string): value is ScheduleRunStatus {
	return (RUN_STATUSES as readonly string[]).includes(value);
}

export function normalizeScheduleTitle(value: string): string {
	const title = value.trim().split(/\s+/).join(" ");
	if (!title) throw new Error("Scheduled task title is required");
	if ([...title].length > SCHEDULE_TITLE_MAX)
		throw new Error(`Scheduled task title must not exceed ${SCHEDULE_TITLE_MAX} characters`);
	return title;
}

export function normalizeSchedulePrompt(value: string): string {
	const prompt = (value ?? "").trim();
	if (!prompt) throw new Error("Scheduled task prompt is required");
	if ([...prompt].length > SCHEDULE_PROMPT_MAX)
		throw new Error(`Scheduled task prompt must not exceed ${SCHEDULE_PROMPT_MAX} characters`);
	return prompt;
}

export function normalizeOptional(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

function parseTimeOfDay(value: string): number[] {
	const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
	if (!match) throw new Error(`timeOfDay must be HH:mm, got: ${value}`);
	const hours = Number(match[1]);
	const minutes = Number(match[2]);
	if (hours > 23 || minutes > 59) throw new Error(`timeOfDay must be HH:mm, got: ${value}`);
	return [hours, minutes];
}

function parseRfc3339(value: string): Date {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) throw new Error(`Expected RFC 3339 timestamp, got: ${value}`);
	return date;
}

export function normalizeScheduleRule(rule: ScheduleRule): ScheduleRule {
	const kindValue = rule.kind?.trim() ?? "";
	if (!isScheduleKind(kindValue)) throw new Error(`Invalid schedule kind: ${rule.kind}`);
	const kind = kindValue;
	const next: ScheduleRule = { kind };

	if (kind === "once") {
		if (!rule.runAt) throw new Error("once schedule requires runAt");
		// Normalize through Date so later parsing is stable (matches Rust).
		next.runAt = parseRfc3339(rule.runAt).toISOString();
		return next;
	}

	const recurrenceValue = rule.recurrence?.trim() ?? "";
	if (!isRecurrenceKind(recurrenceValue)) throw new Error(`Invalid recurrence: ${rule.recurrence}`);
	const recurrence = recurrenceValue;
	next.recurrence = recurrence;

	if (recurrence === "cron") {
		const cron = rule.cron?.trim();
		if (!cron) throw new Error("cron schedule requires cron");
		// Light structural check; the Rust scheduler owns authoritative parse.
		if (cron.split(/\s+/).length < 5) throw new Error(`Invalid cron expression: ${cron}`);
		next.cron = cron;
		return next;
	}

	const timeOfDay = rule.timeOfDay?.trim();
	if (!timeOfDay) throw new Error(`${recurrence} schedule requires timeOfDay`);
	parseTimeOfDay(timeOfDay);
	next.timeOfDay = timeOfDay;

	if (recurrence === "weekly") {
		const days = [...new Set(rule.weekdays ?? [])].sort((a, b) => a - b);
		if (days.length === 0) throw new Error("weekly schedule requires at least one weekday");
		for (const day of days) {
			if (day < 0 || day > 6) throw new Error(`Invalid weekday: ${day} (expected 0=Mon..6=Sun)`);
		}
		next.weekdays = days;
	}

	if (recurrence === "monthly") {
		const days = [...new Set(rule.monthDays ?? [])].sort((a, b) => a - b);
		if (days.length === 0) throw new Error("monthly schedule requires at least one month day");
		for (const day of days) {
			if (day < 1 || day > 28) throw new Error(`Invalid month day: ${day} (expected 1..=28)`);
		}
		next.monthDays = days;
	}

	return next;
}

function startOfDay(date: Date): Date {
	const next = new Date(date);
	next.setHours(0, 0, 0, 0);
	return next;
}

function atTimeOfDay(date: Date, hours: number, minutes: number): Date {
	const next = new Date(date);
	next.setHours(hours, minutes, 0, 0);
	return next;
}

/** Next fire strictly after `after`, based on the scheduled slot (not fire time). */
export function computeNextRun(rule: ScheduleRule, after: Date): Date | undefined {
	if (rule.kind === "once") {
		if (!rule.runAt) return undefined;
		const runAt = parseRfc3339(rule.runAt);
		return runAt.getTime() > after.getTime() ? runAt : undefined;
	}

	if (rule.recurrence === "cron") {
		// Agent-side cron next-run is best-effort; Studio Rust owns firing.
		// Leave the slot unset so the scheduler recomputes on its next write,
		// or keep a daily fallback when the expression looks like `m h * * *`.
		const parts = (rule.cron ?? "").trim().split(/\s+/);
		if (parts.length >= 5 && parts[2] === "*" && parts[3] === "*" && parts[4] === "*") {
			const minutes = Number(parts[0]);
			const hours = Number(parts[1]);
			if (Number.isFinite(minutes) && Number.isFinite(hours) && hours <= 23 && minutes <= 59) {
				return nextTimeOfDay(after, hours, minutes, () => true);
			}
		}
		return undefined;
	}

	const [hours, minutes] = parseTimeOfDay(rule.timeOfDay ?? "09:30");
	if (rule.recurrence === "daily") {
		return nextTimeOfDay(after, hours, minutes, () => true);
	}
	if (rule.recurrence === "weekly") {
		const days = new Set(rule.weekdays ?? []);
		// 0=Mon..6=Sun to match Rust chrono::Weekday::num_days_from_monday
		return nextTimeOfDay(after, hours, minutes, (date) => days.has(weekdayFromMonday(date)));
	}
	if (rule.recurrence === "monthly") {
		const days = new Set(rule.monthDays ?? []);
		return nextTimeOfDay(after, hours, minutes, (date) => days.has(date.getDate()));
	}
	return undefined;
}

/** JS getDay(): 0=Sun..6=Sat → 0=Mon..6=Sun (matches Rust num_days_from_monday). */
function weekdayFromMonday(date: Date): number {
	return (date.getDay() + 6) % 7;
}

function nextTimeOfDay(after: Date, hours: number, minutes: number, dayOk: (date: Date) => boolean): Date | undefined {
	const base = startOfDay(after);
	for (let offset = 0; offset < 400; offset += 1) {
		const date = new Date(base);
		date.setDate(base.getDate() + offset);
		if (!dayOk(date)) continue;
		const candidate = atTimeOfDay(date, hours, minutes);
		if (candidate.getTime() > after.getTime()) return candidate;
	}
	return undefined;
}

function applyNextRun(task: ScheduledTask, after: Date): void {
	if (!task.enabled || task.completedAt) {
		task.nextRunAt = undefined;
		return;
	}
	if (task.schedule.kind === "once") {
		// Keep the slot even when past so startup catch-up can fire or mark missed.
		task.nextRunAt = task.schedule.runAt;
		return;
	}
	const next = computeNextRun(task.schedule, after);
	task.nextRunAt = next?.toISOString();
}

function emptyState(): ScheduledTaskState {
	return { version: 1, items: [] };
}

function parseScheduledRun(value: unknown): ScheduledRun | undefined {
	if (!value || typeof value !== "object") return undefined;
	const item = value as Record<string, unknown>;
	if (typeof item.id !== "string" || typeof item.taskId !== "string") return undefined;
	const status = typeof item.status === "string" ? item.status : "error";
	if (!isScheduleRunStatus(status)) return undefined;
	return {
		id: item.id,
		taskId: item.taskId,
		startedAt: typeof item.startedAt === "string" ? item.startedAt : new Date().toISOString(),
		finishedAt: typeof item.finishedAt === "string" ? item.finishedAt : undefined,
		status,
		agentId: typeof item.agentId === "string" ? item.agentId : undefined,
		sessionId: typeof item.sessionId === "string" ? item.sessionId : undefined,
		error: typeof item.error === "string" ? item.error : undefined,
		summary: typeof item.summary === "string" ? item.summary : undefined,
		catchUp: typeof item.catchUp === "boolean" ? item.catchUp : undefined,
	};
}

function parseScheduledTask(value: unknown): ScheduledTask | undefined {
	if (!value || typeof value !== "object") return undefined;
	const item = value as Record<string, unknown>;
	if (typeof item.id !== "string" || typeof item.title !== "string") return undefined;
	if (typeof item.prompt !== "string" || typeof item.projectPath !== "string") return undefined;
	const scheduleRaw = item.schedule as ScheduleRule | undefined;
	if (!scheduleRaw || typeof scheduleRaw !== "object" || typeof scheduleRaw.kind !== "string") return undefined;
	const timestamp = new Date().toISOString();
	const runs = Array.isArray(item.runs)
		? item.runs.map(parseScheduledRun).filter((run): run is ScheduledRun => run !== undefined)
		: [];
	const permissionMode =
		typeof item.permissionMode === "string" && isAutomationPermissionMode(item.permissionMode)
			? item.permissionMode
			: "ask";
	const lastRunStatus =
		typeof item.lastRunStatus === "string" && isScheduleRunStatus(item.lastRunStatus)
			? item.lastRunStatus
			: undefined;
	const sessionMode =
		typeof item.sessionMode === "string" && isAutomationSessionMode(item.sessionMode)
			? item.sessionMode
			: // Stored tasks without the field predate session reuse and keep firing fresh.
				"fresh";
	return {
		id: item.id,
		title: item.title,
		prompt: item.prompt,
		description: typeof item.description === "string" ? item.description : undefined,
		projectPath: item.projectPath,
		enabled: item.enabled !== false,
		schedule: scheduleRaw,
		permissionMode,
		model: typeof item.model === "string" ? item.model : undefined,
		provider: typeof item.provider === "string" ? item.provider : undefined,
		sessionMode,
		sessionFile: typeof item.sessionFile === "string" ? item.sessionFile : undefined,
		worktreeEnabled: item.worktreeEnabled === true,
		lastRunAt: typeof item.lastRunAt === "string" ? item.lastRunAt : undefined,
		lastRunStatus,
		lastAgentId: typeof item.lastAgentId === "string" ? item.lastAgentId : undefined,
		lastSessionId: typeof item.lastSessionId === "string" ? item.lastSessionId : undefined,
		nextRunAt: typeof item.nextRunAt === "string" ? item.nextRunAt : undefined,
		missedCount: typeof item.missedCount === "number" ? item.missedCount : 0,
		runs,
		createdAt: typeof item.createdAt === "string" ? item.createdAt : timestamp,
		updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : timestamp,
		completedAt: typeof item.completedAt === "string" ? item.completedAt : undefined,
	};
}

export class ScheduledTaskStore {
	readonly path: string;

	constructor(agentDir: string = getAgentDir()) {
		this.path = join(agentDir, "scheduled-tasks.json");
	}

	read(): ScheduledTaskState {
		if (!existsSync(this.path)) return emptyState();
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(this.path, "utf8"));
		} catch (error) {
			throw new Error(`Unable to parse ${this.path}: ${error instanceof Error ? error.message : String(error)}`);
		}
		const items = parsed && typeof parsed === "object" ? (parsed as { items?: unknown }).items : undefined;
		if (!Array.isArray(items)) return emptyState();
		return {
			version: 1,
			items: items.map(parseScheduledTask).filter((item): item is ScheduledTask => item !== undefined),
		};
	}

	list(): ScheduledTask[] {
		return this.read().items;
	}

	get(id: string): ScheduledTask {
		const task = this.read().items.find((item) => item.id === id);
		if (!task) throw new Error(`Scheduled task not found: ${id}`);
		return task;
	}

	create(input: CreateScheduledTaskInput): ScheduledTask {
		const state = this.read();
		const now = new Date();
		const timestamp = now.toISOString();
		const projectPath = input.projectPath.trim();
		if (!projectPath) throw new Error("projectPath is required for scheduled tasks");
		const permissionMode = input.permissionMode ?? "ask";
		if (!isAutomationPermissionMode(permissionMode)) throw new Error(`Invalid permission mode: ${permissionMode}`);
		// New tasks continue one conversation by default; stored legacy tasks
		// without the field stay on fresh sessions until the user flips it.
		const sessionMode = input.sessionMode ?? "reuse";
		if (!isAutomationSessionMode(sessionMode)) throw new Error(`Invalid session mode: ${sessionMode}`);
		const task: ScheduledTask = {
			id: `sch_${randomUUID()}`,
			title: normalizeScheduleTitle(input.title),
			prompt: normalizeSchedulePrompt(input.prompt),
			description: normalizeOptional(input.description),
			projectPath,
			enabled: input.enabled ?? true,
			schedule: normalizeScheduleRule(input.schedule),
			permissionMode,
			model: normalizeOptional(input.model),
			provider: normalizeOptional(input.provider),
			sessionMode,
			worktreeEnabled: input.worktreeEnabled === true,
			missedCount: 0,
			runs: [],
			createdAt: timestamp,
			updatedAt: timestamp,
		};
		applyNextRun(task, now);
		state.items.push(task);
		this.write(state);
		return task;
	}

	update(id: string, input: UpdateScheduledTaskInput): ScheduledTask {
		const state = this.read();
		const task = state.items.find((item) => item.id === id);
		if (!task) throw new Error(`Scheduled task not found: ${id}`);
		const now = new Date();
		let scheduleChanged = false;
		let enabledChanged = false;

		if (input.title !== undefined) task.title = normalizeScheduleTitle(input.title);
		if (input.prompt !== undefined) task.prompt = normalizeSchedulePrompt(input.prompt);
		if (input.description !== undefined) task.description = normalizeOptional(input.description);
		if (input.projectPath !== undefined) {
			const projectPath = input.projectPath.trim();
			if (!projectPath) throw new Error("projectPath is required for scheduled tasks");
			if (task.projectPath !== projectPath) {
				// Sessions belong to one project; never continue the old one here.
				task.sessionFile = undefined;
				task.lastSessionId = undefined;
			}
			task.projectPath = projectPath;
		}
		if (input.schedule !== undefined) {
			task.schedule = normalizeScheduleRule(input.schedule);
			scheduleChanged = true;
			if (task.completedAt && task.schedule.kind !== "once") task.completedAt = undefined;
		}
		if (input.permissionMode !== undefined) {
			if (!isAutomationPermissionMode(input.permissionMode))
				throw new Error(`Invalid permission mode: ${input.permissionMode}`);
			task.permissionMode = input.permissionMode;
		}
		if (input.model !== undefined) task.model = normalizeOptional(input.model);
		if (input.provider !== undefined) task.provider = normalizeOptional(input.provider);
		if (input.sessionMode !== undefined) {
			if (!isAutomationSessionMode(input.sessionMode)) throw new Error(`Invalid session mode: ${input.sessionMode}`);
			task.sessionMode = input.sessionMode;
		}
		if (input.worktreeEnabled !== undefined) task.worktreeEnabled = input.worktreeEnabled === true;
		if (input.enabled !== undefined && task.enabled !== input.enabled) {
			task.enabled = input.enabled === true;
			enabledChanged = true;
		}
		task.updatedAt = now.toISOString();
		if (scheduleChanged || enabledChanged) applyNextRun(task, now);
		if (!task.enabled) task.nextRunAt = undefined;
		this.write(state);
		return task;
	}

	delete(id: string): void {
		const state = this.read();
		const before = state.items.length;
		state.items = state.items.filter((item) => item.id !== id);
		if (before === state.items.length) throw new Error(`Scheduled task not found: ${id}`);
		this.write(state);
	}

	private write(state: ScheduledTaskState): void {
		const directory = dirname(this.path);
		if (!existsSync(directory)) mkdirSync(directory, { recursive: true, mode: 0o700 });
		const temporaryPath = `${this.path}.${process.pid}.tmp`;
		writeFileSync(temporaryPath, `${JSON.stringify(state, null, "\t")}\n`, {
			encoding: "utf8",
			mode: 0o600,
		});
		chmodSync(temporaryPath, 0o600);
		renameSync(temporaryPath, this.path);
		chmodSync(this.path, 0o600);
	}
}

/** Compact projection for tool results — drops long prompts and full run history. */
export function scheduledTaskSummary(task: ScheduledTask) {
	return {
		id: task.id,
		title: task.title,
		enabled: task.enabled,
		permissionMode: task.permissionMode,
		sessionMode: task.sessionMode,
		sessionFile: task.sessionFile,
		projectPath: task.projectPath,
		schedule: task.schedule,
		nextRunAt: task.nextRunAt,
		lastRunAt: task.lastRunAt,
		lastRunStatus: task.lastRunStatus,
		lastAgentId: task.lastAgentId,
		lastSessionId: task.lastSessionId,
		missedCount: task.missedCount,
		worktreeEnabled: task.worktreeEnabled,
		model: task.model,
		provider: task.provider,
		description: task.description,
		promptPreview: task.prompt.length > 400 ? `${task.prompt.slice(0, 400)}…` : task.prompt,
		recentRuns: task.runs.slice(0, 3).map((run) => ({
			id: run.id,
			status: run.status,
			startedAt: run.startedAt,
			finishedAt: run.finishedAt,
			agentId: run.agentId,
			sessionId: run.sessionId,
			catchUp: run.catchUp,
			error: run.error,
			summary: run.summary,
		})),
		createdAt: task.createdAt,
		updatedAt: task.updatedAt,
		completedAt: task.completedAt,
	};
}
