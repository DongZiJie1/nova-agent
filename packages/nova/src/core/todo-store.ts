import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "../config.ts";

/**
 * Nova's todo list.
 *
 * The file is shared with Nova Studio, which owns the 待办 page and the Rust
 * commands behind it: both sides read and write the same `todos.json` in the
 * agent directory. Keep the shape, validation, and write behaviour in sync with
 * `write_todo_state` / `create_todo` in nova-studio's `src-tauri/src/commands.rs`
 * or the two writers will disagree about what a stored todo looks like.
 */

export type TodoStatus = "pending" | "in_progress" | "completed";
export type TodoPriority = "low" | "medium" | "high";
export type TodoSource = "user" | "agent";

export interface TodoItem {
	id: string;
	title: string;
	description: string;
	status: TodoStatus;
	priority: TodoPriority;
	projectPath?: string;
	dueAt?: string;
	source: TodoSource;
	agentId?: string;
	sessionId?: string;
	createdAt: string;
	updatedAt: string;
	completedAt?: string;
	order: number;
}

export interface TodoState {
	version: 1;
	items: TodoItem[];
}

export interface CreateTodoInput {
	title: string;
	description?: string;
	priority?: TodoPriority;
	projectPath?: string;
	dueAt?: string;
	agentId?: string;
	sessionId?: string;
}

export interface UpdateTodoInput {
	title?: string;
	description?: string;
	status?: TodoStatus;
	priority?: TodoPriority;
	projectPath?: string;
	dueAt?: string;
}

export const TODO_TITLE_MAX = 120;
export const TODO_DESCRIPTION_MAX = 4_000;

const TODO_STATUSES: readonly TodoStatus[] = ["pending", "in_progress", "completed"];
const TODO_PRIORITIES: readonly TodoPriority[] = ["low", "medium", "high"];

export function isTodoStatus(value: string): value is TodoStatus {
	return (TODO_STATUSES as readonly string[]).includes(value);
}

export function isTodoPriority(value: string): value is TodoPriority {
	return (TODO_PRIORITIES as readonly string[]).includes(value);
}

export function normalizeTodoTitle(value: string): string {
	const title = value.trim().split(/\s+/).join(" ");
	if (!title) throw new Error("Todo title is required");
	if ([...title].length > TODO_TITLE_MAX) throw new Error(`Todo title must not exceed ${TODO_TITLE_MAX} characters`);
	return title;
}

export function normalizeTodoDescription(value: string | undefined): string {
	const description = (value ?? "").trim();
	if ([...description].length > TODO_DESCRIPTION_MAX)
		throw new Error(`Todo description must not exceed ${TODO_DESCRIPTION_MAX} characters`);
	return description;
}

/** `YYYY-MM-DD` for a day without a time, or an RFC 3339 timestamp. */
export function normalizeTodoDueAt(value: string | undefined): string | undefined {
	const dueAt = value?.trim();
	if (!dueAt) return undefined;
	const isDay = /^\d{4}-\d{2}-\d{2}$/.test(dueAt) && !Number.isNaN(Date.parse(`${dueAt}T00:00:00Z`));
	const isTimestamp = /^\d{4}-\d{2}-\d{2}T/.test(dueAt) && !Number.isNaN(Date.parse(dueAt));
	if (!isDay && !isTimestamp) throw new Error("Todo due date must be YYYY-MM-DD or RFC 3339");
	return dueAt;
}

function normalizeOptional(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

const emptyState = (): TodoState => ({ version: 1, items: [] });

/** Drops unreadable rows instead of failing the whole list, matching the Rust reader's tolerance. */
function parseTodoItem(value: unknown): TodoItem | undefined {
	if (!value || typeof value !== "object") return undefined;
	const item = value as Partial<TodoItem>;
	if (typeof item.id !== "string" || typeof item.title !== "string") return undefined;
	const status = typeof item.status === "string" && isTodoStatus(item.status) ? item.status : "pending";
	const priority = typeof item.priority === "string" && isTodoPriority(item.priority) ? item.priority : "medium";
	const timestamp = typeof item.updatedAt === "string" ? item.updatedAt : new Date().toISOString();
	return {
		id: item.id,
		title: item.title,
		description: typeof item.description === "string" ? item.description : "",
		status,
		priority,
		projectPath: typeof item.projectPath === "string" ? item.projectPath : undefined,
		dueAt: typeof item.dueAt === "string" ? item.dueAt : undefined,
		source: item.source === "agent" ? "agent" : "user",
		agentId: typeof item.agentId === "string" ? item.agentId : undefined,
		sessionId: typeof item.sessionId === "string" ? item.sessionId : undefined,
		createdAt: typeof item.createdAt === "string" ? item.createdAt : timestamp,
		updatedAt: timestamp,
		completedAt: typeof item.completedAt === "string" ? item.completedAt : undefined,
		order: typeof item.order === "number" ? item.order : 0,
	};
}

export class TodoStore {
	readonly path: string;

	constructor(agentDir: string = getAgentDir()) {
		this.path = join(agentDir, "todos.json");
	}

	read(): TodoState {
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
			items: items
				.map(parseTodoItem)
				.filter((item): item is TodoItem => item !== undefined)
				.sort((a, b) => a.order - b.order),
		};
	}

	list(status?: TodoStatus): TodoItem[] {
		const items = this.read().items;
		return status ? items.filter((item) => item.status === status) : items;
	}

	create(input: CreateTodoInput): TodoItem {
		const state = this.read();
		const now = new Date().toISOString();
		const priority = input.priority ?? "medium";
		if (!isTodoPriority(priority)) throw new Error(`Invalid todo priority: ${priority}`);
		const nextOrder = state.items.reduce((max, item) => Math.max(max, item.order), -1) + 1;
		const todo: TodoItem = {
			id: `todo_${randomUUID()}`,
			title: normalizeTodoTitle(input.title),
			description: normalizeTodoDescription(input.description),
			status: "pending",
			priority,
			projectPath: normalizeOptional(input.projectPath),
			dueAt: normalizeTodoDueAt(input.dueAt),
			source: "agent",
			agentId: normalizeOptional(input.agentId),
			sessionId: normalizeOptional(input.sessionId),
			createdAt: now,
			updatedAt: now,
			order: nextOrder,
		};
		state.items.push(todo);
		this.write(state);
		return todo;
	}

	update(id: string, input: UpdateTodoInput): TodoItem {
		const state = this.read();
		const todo = state.items.find((item) => item.id === id);
		if (!todo) throw new Error(`Todo not found: ${id}`);
		if (input.title !== undefined) todo.title = normalizeTodoTitle(input.title);
		if (input.description !== undefined) todo.description = normalizeTodoDescription(input.description);
		if (input.priority !== undefined) {
			if (!isTodoPriority(input.priority)) throw new Error(`Invalid todo priority: ${input.priority}`);
			todo.priority = input.priority;
		}
		if (input.projectPath !== undefined) todo.projectPath = normalizeOptional(input.projectPath);
		if (input.dueAt !== undefined) todo.dueAt = normalizeTodoDueAt(input.dueAt);
		if (input.status !== undefined) {
			if (!isTodoStatus(input.status)) throw new Error(`Invalid todo status: ${input.status}`);
			todo.status = input.status;
			todo.completedAt = input.status === "completed" ? new Date().toISOString() : undefined;
		}
		todo.updatedAt = new Date().toISOString();
		this.write(state);
		return todo;
	}

	private write(state: TodoState): void {
		const directory = dirname(this.path);
		if (!existsSync(directory)) mkdirSync(directory, { recursive: true, mode: 0o700 });
		const temporaryPath = `${this.path}.${process.pid}.tmp`;
		writeFileSync(temporaryPath, `${JSON.stringify(state, null, "\t")}\n`, { encoding: "utf8", mode: 0o600 });
		chmodSync(temporaryPath, 0o600);
		renameSync(temporaryPath, this.path);
		chmodSync(this.path, 0o600);
	}
}
