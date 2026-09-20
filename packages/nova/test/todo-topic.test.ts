import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { TodoStore, todoTopic } from "../src/core/todo-store.ts";
import { createTodoToolDefinition } from "../src/core/tools/todo.ts";

let dir: string;
let store: TodoStore;
const originalAgentDir = process.env.NOVA_CODING_AGENT_DIR;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "nova-topic-"));
	store = new TodoStore(dir);
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
	if (originalAgentDir === undefined) delete process.env.NOVA_CODING_AGENT_DIR;
	else process.env.NOVA_CODING_AGENT_DIR = originalAgentDir;
});

describe("todo topics", () => {
	it("groups items by topic, falling back to the first tag and then 未分类", () => {
		const tagged = store.create({ title: "Read", tags: ["论文", "RL"] });
		expect(todoTopic(tagged)).toBe("论文");

		const explicit = store.update(tagged.id, { topic: "专题" });
		expect(todoTopic(explicit)).toBe("专题");
		// Clearing the topic restores the tag fallback instead of dropping the group.
		expect(todoTopic(store.update(tagged.id, { topic: "" }))).toBe("论文");

		expect(todoTopic(store.create({ title: "Loose" }))).toBe("未分类");
	});

	it("reads the topic back without rewriting the file", () => {
		store.create({ title: "Read", tags: ["论文"] });
		const before = readFileSync(store.path, "utf8");
		expect(todoTopic(store.list()[0])).toBe("论文");
		expect(readFileSync(store.path, "utf8")).toBe(before);
	});

	it("filters by topic and paginates through the tool", async () => {
		process.env.NOVA_CODING_AGENT_DIR = dir;
		const tool = createTodoToolDefinition();
		const ctx = { cwd: dir } as ExtensionContext;

		for (const title of ["A", "B"]) {
			await tool.execute("create", { action: "create", title, topic: "实验" }, undefined, undefined, ctx);
		}
		await tool.execute("other", { action: "create", title: "C", topic: "论文" }, undefined, undefined, ctx);

		const first = await tool.execute("list", { action: "list", topic: "实验", limit: 1 }, undefined, undefined, ctx);
		const body = JSON.parse((first.content[0] as { text: string }).text);
		expect(body.total).toBe(2);
		expect(body.todos).toHaveLength(1);
		expect(body.todos[0].topic).toBe("实验");
		expect(body.truncated).toBe(true);
		expect(body.nextOffset).toBe(1);

		const second = await tool.execute(
			"list-2",
			{ action: "list", topic: "实验", limit: 1, offset: 1 },
			undefined,
			undefined,
			ctx,
		);
		const tail = JSON.parse((second.content[0] as { text: string }).text);
		expect(tail.todos).toHaveLength(1);
		expect(tail.todos[0].id).not.toBe(body.todos[0].id);
		expect(tail.truncated).toBe(false);
		expect(tail.availableTopics).toEqual(["实验", "论文"]);
	});
});
