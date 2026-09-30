import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { TodoStore } from "../src/core/todo-store.ts";

it("preserves user completion notes when the agent changes or creates tasks", () => {
	const dir = mkdtempSync(join(tmpdir(), "nova-completion-"));
	try {
		const store = new TodoStore(dir);
		const todo = store.create({ title: "验收" });
		expect(store.read().items[0].completionNotes).toBe("");
		const state = store.read();
		state.items[0].completionNotes = "已完成联调\n待补充文档";
		writeFileSync(store.path, JSON.stringify(state));
		store.update(todo.id, { status: "completed" });
		store.create({ title: "后续任务" });
		expect(JSON.parse(readFileSync(store.path, "utf8")).items[0].completionNotes).toBe("已完成联调\n待补充文档");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
