import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { todoPrompt } from "../src/core/todo-prompt.ts";
import { TodoStore } from "../src/core/todo-store.ts";
import { todoSummary } from "../src/core/tools/todo.ts";

it("records only actual due date and status changes and includes them in summaries and startup context", () => {
	const directory = mkdtempSync(join(tmpdir(), "nova-todo-history-"));
	try {
		const store = new TodoStore(directory);
		const created = store.create({ title: "交付报告", dueAt: "2026-09-30" });
		expect(store.get(created.id).history).toEqual([]);
		store.update(created.id, { dueAt: "2026-09-30", status: "pending" });
		expect(store.get(created.id).history).toEqual([]);
		store.update(created.id, { dueAt: "2026-10-05", status: "in_progress" });
		store.update(created.id, { dueAt: "", status: "completed" });
		const todo = store.get(created.id);
		expect(todo.history.map(({ type, from, to }) => ({ type, from, to }))).toEqual([
			{ type: "due_at_changed", from: "2026-09-30", to: "2026-10-05" },
			{ type: "status_changed", from: "pending", to: "in_progress" },
			{ type: "due_at_changed", from: "2026-10-05", to: null },
			{ type: "status_changed", from: "in_progress", to: "completed" },
		]);
		expect(todo.history.every((entry) => !Number.isNaN(Date.parse(entry.changedAt)))).toBe(true);
		expect(todoSummary(todo).history).toEqual(todo.history);
		expect(todoPrompt(directory)).toContain('"type":"due_at_changed"');
		store.update(created.id, { status: "completed" });
		expect(store.get(created.id).completedAt).toBe(todo.completedAt);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
