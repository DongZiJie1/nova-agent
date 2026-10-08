import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { TodoStore } from "../src/core/todo-store.ts";

it("preserves user progress checkpoints when the agent appends or creates tasks", () => {
	const dir = mkdtempSync(join(tmpdir(), "nova-progress-"));
	try {
		const store = new TodoStore(dir);
		const todo = store.create({ title: "验收" });
		expect(store.read().items[0].progress).toEqual([]);
		const entry = store.appendProgress(todo.id, {
			content: "已完成联调\n待补充文档",
			percent: 40,
			source: "user",
		});
		expect(entry.source).toBe("user");
		expect(entry.percent).toBe(40);
		store.appendProgress(todo.id, { content: "补齐了文档", percent: 70, source: "agent" });
		store.update(todo.id, { status: "completed" });
		store.create({ title: "后续任务" });
		const items = JSON.parse(readFileSync(store.path, "utf8")).items;
		expect(items[0].progress).toHaveLength(2);
		expect(items[0].progress[0].content).toBe("已完成联调\n待补充文档");
		expect(items[0].progress[0].source).toBe("user");
		expect(items[0].progress[1].source).toBe("agent");
		expect(items[0].progress[1].percent).toBe(70);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

it("wraps legacy completionNotes as the first checkpoint and never writes the field back", () => {
	const dir = mkdtempSync(join(tmpdir(), "nova-progress-legacy-"));
	try {
		const store = new TodoStore(dir);
		writeFileSync(
			store.path,
			JSON.stringify({
				version: 1,
				items: [
					{
						id: "todo_legacy",
						title: "旧任务",
						description: "",
						completionNotes: "已完成联调\n待补充文档",
						status: "pending",
						priority: "medium",
						source: "user",
						createdAt: "2026-09-01T00:00:00.000Z",
						updatedAt: "2026-09-02T00:00:00.000Z",
						order: 0,
					},
				],
			}),
		);
		const todo = store.get("todo_legacy");
		expect(todo.progress).toHaveLength(1);
		expect(todo.progress[0].content).toBe("已完成联调\n待补充文档");
		expect(todo.progress[0].source).toBe("user");
		store.appendProgress("todo_legacy", { content: "追加一笔", source: "agent" });
		const raw = JSON.parse(readFileSync(store.path, "utf8")).items[0];
		expect(raw.completionNotes).toBeUndefined();
		expect(raw.progress).toHaveLength(2);
		expect(raw.progress[0].content).toBe("已完成联调\n待补充文档");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

it("edits and deletes a single progress checkpoint without touching the rest", () => {
	const dir = mkdtempSync(join(tmpdir(), "nova-progress-edit-"));
	try {
		const store = new TodoStore(dir);
		const todo = store.create({ title: "时间线" });
		const first = store.appendProgress(todo.id, { content: "第一笔", percent: 10, source: "user" });
		const second = store.appendProgress(todo.id, { content: "第二笔", percent: 50, source: "agent" });
		const edited = store.editProgress(todo.id, { entryId: first.id, content: "第一笔（已修正）", percent: 20 });
		expect(edited.content).toBe("第一笔（已修正）");
		expect(edited.percent).toBe(20);
		expect(edited.editedAt).toBeTruthy();
		expect(edited.at).toBe(first.at);
		store.deleteProgress(todo.id, second.id);
		const items = store.read().items;
		expect(items[0].progress).toHaveLength(1);
		expect(items[0].progress[0].content).toBe("第一笔（已修正）");
		expect(() => store.deleteProgress(todo.id, second.id)).toThrow(/not found/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
