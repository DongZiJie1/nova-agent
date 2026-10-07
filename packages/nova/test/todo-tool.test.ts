import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { createTodoToolDefinition, type TodoToolDetails } from "../src/core/tools/todo.ts";

const tempDirs: string[] = [];
const originalAgentDir = process.env.NOVA_CODING_AGENT_DIR;
const originalAgentId = process.env.NOVA_AGENT_ID;

const tool = createTodoToolDefinition();

function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

function context(cwd = "/project/alpha"): ExtensionContext {
	return { cwd } as unknown as ExtensionContext;
}

function resultText(result: { content: Array<{ type: string; text?: string }> }): string {
	const first = result.content[0];
	return first?.type === "text" ? (first.text ?? "") : "";
}

function todoFile(): string {
	return join(process.env.NOVA_CODING_AGENT_DIR ?? "", "todos.json");
}

function storedState(): {
	version: number;
	items: Array<Record<string, unknown>>;
} {
	return JSON.parse(readFileSync(todoFile(), "utf8"));
}

type StoredProgressEntry = {
	id: string;
	at: string;
	content: string;
	source: string;
	percent?: number;
	editedAt?: string;
};

function storedProgress(index = 0): StoredProgressEntry[] {
	const progress = storedState().items[index].progress;
	return Array.isArray(progress) ? (progress as StoredProgressEntry[]) : [];
}

function seedStudioTodo(overrides: Record<string, unknown> = {}): void {
	mkdirSync(process.env.NOVA_CODING_AGENT_DIR ?? "", { recursive: true });
	writeFileSync(
		todoFile(),
		JSON.stringify({
			version: 1,
			items: [
				{
					id: "todo_existing",
					title: "Written by the 待办 page",
					description: "",
					status: "pending",
					priority: "low",
					source: "user",
					createdAt: "2026-09-01T00:00:00.000Z",
					updatedAt: "2026-09-01T00:00:00.000Z",
					order: 3,
					...overrides,
				},
			],
		}),
	);
}

beforeEach(() => {
	const dir = mkdtempSync(join(tmpdir(), "nova-todo-"));
	tempDirs.push(dir);
	process.env.NOVA_CODING_AGENT_DIR = dir;
	delete process.env.NOVA_AGENT_ID;
});

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	restoreEnv("NOVA_CODING_AGENT_DIR", originalAgentDir);
	restoreEnv("NOVA_AGENT_ID", originalAgentId);
});

describe("todo tool", () => {
	it("uses an object-shaped top-level JSON schema", () => {
		expect(tool.parameters.type).toBe("object");
	});

	it("creates a todo in the store Nova Studio reads, linked to this agent", async () => {
		process.env.NOVA_AGENT_ID = "agent-1234";

		const result = await tool.execute(
			"create-1",
			{
				action: "create",
				title: "  Ship   the todo tool  ",
				description: "Wire the tool into Nova Studio.",
				priority: "high",
				due_at: "2026-09-30",
			},
			undefined,
			undefined,
			context(),
		);

		expect(result.details).toMatchObject({
			action: "create",
			status: "ok",
			todo: {
				title: "Ship the todo tool",
				status: "pending",
				priority: "high",
				projectPath: "/project/alpha",
				dueAt: "2026-09-30",
				source: "agent",
				agentId: "agent-1234",
				sessionId: "agent-1234",
			},
		});
		expect(JSON.parse(resultText(result)).todo.id).toMatch(/^todo_/);

		const state = storedState();
		expect(state.version).toBe(1);
		expect(state.items).toHaveLength(1);
		expect(state.items[0]).toMatchObject({
			title: "Ship the todo tool",
			description: "Wire the tool into Nova Studio.",
			status: "pending",
			priority: "high",
			projectPath: "/project/alpha",
			dueAt: "2026-09-30",
			source: "agent",
			agentId: "agent-1234",
			order: 0,
		});
		expect(state.items[0].createdAt).toBe(state.items[0].updatedAt);
	});

	it("appends to todos the 待办 page already stored", async () => {
		seedStudioTodo();

		const result = await tool.execute(
			"create-2",
			{ action: "create", title: "Follow-up from this session" },
			undefined,
			undefined,
			context("/project/beta"),
		);

		expect(result.details.status).toBe("ok");
		const state = storedState();
		expect(state.items.map((item) => item.source)).toEqual(["user", "agent"]);
		expect(state.items[0].title).toBe("Written by the 待办 page");
		expect(state.items[1]).toMatchObject({ order: 4, projectPath: "/project/beta" });
	});

	it("includes stored change history in list results", async () => {
		seedStudioTodo({
			history: [{ type: "due_at_changed", from: "2026-09-30", to: "2026-10-05", changedAt: "2026-09-29T00:00:00Z" }],
		});
		const result = await tool.execute("list-history", { action: "list" }, undefined, undefined, context());
		expect(JSON.parse(resultText(result)).todos[0].history).toEqual([
			{ type: "due_at_changed", from: "2026-09-30", to: "2026-10-05", changedAt: "2026-09-29T00:00:00Z" },
		]);
	});

	it("does not link a todo to Nova's own scratch checkout", async () => {
		const worktree = await tool.execute(
			"create-worktree",
			{ action: "create", title: "Written from a worktree agent" },
			undefined,
			undefined,
			context("/Users/dev/.nova/worktrees/nova-studio/agent-1234"),
		);
		const runtime = await tool.execute(
			"create-runtime",
			{ action: "create", title: "Written from a temporary agent" },
			undefined,
			undefined,
			context("/tmp/pi-runtime-abc123"),
		);
		const explicit = await tool.execute(
			"create-explicit",
			{ action: "create", title: "Explicit project wins", project_path: "/project/gamma" },
			undefined,
			undefined,
			context("/tmp/pi-runtime-abc123"),
		);

		expect((worktree.details as TodoToolDetails).todo?.projectPath).toBeUndefined();
		expect((runtime.details as TodoToolDetails).todo?.projectPath).toBeUndefined();
		expect((explicit.details as TodoToolDetails).todo?.projectPath).toBe("/project/gamma");
	});

	it("lists stored todos, filtered and bounded", async () => {
		seedStudioTodo();
		const created = await tool.execute(
			"create-3",
			{ action: "create", title: "Second entry" },
			undefined,
			undefined,
			context(),
		);
		const createdId = (created.details as TodoToolDetails).todo?.id ?? "";
		await tool.execute(
			"update-1",
			{ action: "update", todo_id: createdId, status: "completed" },
			undefined,
			undefined,
			context(),
		);

		const all = await tool.execute("list-1", { action: "list" }, undefined, undefined, context());
		expect(all.details).toMatchObject({ action: "list", status: "ok", total: 2 });
		expect(JSON.parse(resultText(all)).todos.map((todo: { title: string }) => todo.title)).toEqual([
			"Written by the 待办 page",
			"Second entry",
		]);

		const pending = await tool.execute(
			"list-2",
			{ action: "list", status: "pending" },
			undefined,
			undefined,
			context(),
		);
		expect(pending.details).toMatchObject({ total: 1 });

		const bounded = await tool.execute("list-3", { action: "list", limit: 1 }, undefined, undefined, context());
		expect(bounded.details).toMatchObject({ total: 2 });
		expect(bounded.details.todos).toHaveLength(1);
		expect(JSON.parse(resultText(bounded)).truncated).toBe(true);
	});

	it("stores tags, cleans them up, and filters the list by tag", async () => {
		const created = await tool.execute(
			"tag-create",
			{
				action: "create",
				title: "读 DeepSeekMath",
				tags: [" 论文 ", "论文", "RL", ""],
			},
			undefined,
			undefined,
			context(),
		);
		const createdId = (created.details as TodoToolDetails).todo?.id ?? "";
		expect((created.details as TodoToolDetails).todo?.tags).toEqual(["论文", "RL"]);

		await tool.execute(
			"tag-create-2",
			{ action: "create", title: "跑通 GRPO", tags: ["实验"] },
			undefined,
			undefined,
			context(),
		);

		const papers = await tool.execute("tag-list", { action: "list", tag: "论文" }, undefined, undefined, context());
		expect(papers.details.total).toBe(1);
		expect(JSON.parse(resultText(papers)).todos[0].tags).toEqual(["论文", "RL"]);
		// Equal counts fall back to locale order, so ASCII sorts before CJK.
		expect(JSON.parse(resultText(papers)).availableTags).toEqual(["RL", "实验", "论文"]);

		// update replaces the whole list; an empty array clears it
		const retagged = await tool.execute(
			"tag-update",
			{ action: "update", todo_id: createdId, tags: ["实验", "论文"] },
			undefined,
			undefined,
			context(),
		);
		expect((retagged.details as TodoToolDetails).todo?.tags).toEqual(["实验", "论文"]);
		await tool.execute(
			"tag-clear",
			{ action: "update", todo_id: createdId, tags: [] },
			undefined,
			undefined,
			context(),
		);
		expect(storedState().items[0].tags).toEqual([]);
	});

	it("reads todos written before tags existed", async () => {
		seedStudioTodo();
		expect(storedState().items[0].tags).toBeUndefined();

		const listed = await tool.execute("legacy-list", { action: "list" }, undefined, undefined, context());
		expect((listed.details as TodoToolDetails).todos?.[0].tags).toEqual([]);
	});

	it("rejects tags that break the shared contract", async () => {
		const tooMany = await tool.execute(
			"tag-bad-1",
			{ action: "create", title: "Too many tags", tags: ["a", "b", "c", "d", "e", "f"] },
			undefined,
			undefined,
			context(),
		);
		const tooLong = await tool.execute(
			"tag-bad-2",
			{ action: "create", title: "Long tag", tags: ["x".repeat(25)] },
			undefined,
			undefined,
			context(),
		);

		expect(tooMany.details.error).toContain("more than 5 tags");
		expect(tooLong.details.error).toContain("24 characters");
		expect(existsSync(todoFile())).toBe(false);
	});

	it("updates an existing todo and stamps completion", async () => {
		seedStudioTodo({ id: "todo_target" });

		const completed = await tool.execute(
			"update-2",
			{ action: "update", todo_id: "todo_target", status: "completed", priority: "high" },
			undefined,
			undefined,
			context(),
		);
		expect(completed.details).toMatchObject({
			action: "update",
			status: "ok",
			todo: { id: "todo_target", status: "completed", priority: "high" },
		});
		expect(storedState().items[0].completedAt).toEqual(expect.any(String));

		const reopened = await tool.execute(
			"update-3",
			{ action: "update", todo_id: "todo_target", status: "pending" },
			undefined,
			undefined,
			context(),
		);
		expect(reopened.details.status).toBe("ok");
		expect(storedState().items[0].completedAt).toBeUndefined();
	});

	it("reports invalid input instead of writing", async () => {
		const blank = await tool.execute("bad-1", { action: "create", title: "   " }, undefined, undefined, context());
		const priority = await tool.execute(
			"bad-2",
			// @ts-expect-error the model can still call with an unlisted priority
			{ action: "create", title: "Valid title", priority: "urgent" },
			undefined,
			undefined,
			context(),
		);
		const due = await tool.execute(
			"bad-3",
			{ action: "create", title: "Valid title", due_at: "tomorrow" },
			undefined,
			undefined,
			context(),
		);

		for (const result of [blank, priority, due]) {
			expect(result.details.status).toBe("error");
			expect(resultText(result)).toMatch(/^Error: /);
		}
		expect(existsSync(todoFile())).toBe(false);
	});

	it("returns the full record for get, including description and the full progress timeline", async () => {
		const longDescription = `Acceptance criteria: ${"x".repeat(700)}`;
		const longCheckpoint = `Verified against the studio checklist. ${"z".repeat(300)}`;
		seedStudioTodo({
			id: "todo_detail",
			description: longDescription,
			progress: [
				{
					id: "progress_a",
					at: "2026-09-01T00:00:00.000Z",
					content: "Earlier checkpoint kept for history.",
					source: "user",
				},
				{
					id: "progress_b",
					at: "2026-09-02T00:00:00.000Z",
					content: longCheckpoint,
					source: "agent",
					percent: 60,
				},
			],
		});

		const listed = await tool.execute("get-list", { action: "list" }, undefined, undefined, context());
		const listedTodo = JSON.parse(resultText(listed)).todos[0];
		const listedDescription = listedTodo.description as string;
		expect(listedDescription.endsWith("…")).toBe(true);
		expect(listedDescription.length).toBeLessThan(longDescription.length);
		expect(listedTodo.progressCount).toBe(2);
		expect(listedTodo.latestProgress.content.endsWith("…")).toBe(true);
		expect(listedTodo.latestProgress.percent).toBe(60);
		expect(listedTodo.latestProgress.content).not.toContain("Earlier checkpoint");

		const got = await tool.execute(
			"get-1",
			{ action: "get", todo_id: "todo_detail" },
			undefined,
			undefined,
			context(),
		);
		expect(got.details).toMatchObject({ action: "get", status: "ok" });
		const todo = JSON.parse(resultText(got)).todo;
		expect(todo.description).toBe(longDescription);
		expect(todo.progress).toHaveLength(2);
		expect(todo.progress[0].content).toBe("Earlier checkpoint kept for history.");
		expect(todo.progress[1].content).toBe(longCheckpoint);
		expect((got.details as TodoToolDetails).todo).toMatchObject({
			id: "todo_detail",
			description: longDescription,
		});
	});

	it("appends progress checkpoints like git commits without rewriting earlier ones", async () => {
		seedStudioTodo({ id: "todo_timeline", progress: [] });

		const first = await tool.execute(
			"append-1",
			{ action: "append_progress", todo_id: "todo_timeline", content: "10月1日完成方案设计", percent: 30 },
			undefined,
			undefined,
			context(),
		);
		const second = await tool.execute(
			"append-2",
			{
				action: "append_progress",
				todo_id: "todo_timeline",
				content: "10月15日完成联调",
				percent: 60,
			},
			undefined,
			undefined,
			context(),
		);

		expect(first.details).toMatchObject({ action: "append_progress", status: "ok" });
		const entry = (first.details as TodoToolDetails).entry;
		expect(entry).toMatchObject({ content: "10月1日完成方案设计", percent: 30, source: "agent" });

		const progress = storedProgress();
		expect(progress).toHaveLength(2);
		expect(progress[0].content).toBe("10月1日完成方案设计");
		expect(progress[1].content).toBe("10月15日完成联调");
		expect(progress[1].percent).toBe(60);
		expect(progress[1].source).toBe("agent");
		expect(JSON.parse(resultText(second)).todo.progressCount).toBe(2);
	});

	it("edits and deletes a single progress checkpoint via the tool", async () => {
		seedStudioTodo({
			id: "todo_edit",
			progress: [
				{ id: "progress_keep", at: "2026-10-01T00:00:00.000Z", content: "keep me", source: "user" },
				{ id: "progress_edit", at: "2026-10-02T00:00:00.000Z", content: "typo", source: "agent" },
				{ id: "progress_drop", at: "2026-10-03T00:00:00.000Z", content: "drop me", source: "agent" },
			],
		});

		await tool.execute(
			"edit-1",
			{
				action: "edit_progress",
				todo_id: "todo_edit",
				entry_id: "progress_edit",
				content: "fixed",
				percent: 40,
			},
			undefined,
			undefined,
			context(),
		);
		await tool.execute(
			"delete-1",
			{ action: "delete_progress", todo_id: "todo_edit", entry_id: "progress_drop" },
			undefined,
			undefined,
			context(),
		);

		const progress = storedProgress();
		expect(progress).toHaveLength(2);
		expect(progress[0].content).toBe("keep me");
		expect(progress[1]).toMatchObject({ id: "progress_edit", content: "fixed", percent: 40 });
		expect(progress[1].editedAt).toBeTruthy();
	});

	it("converts legacy completionNotes into the first checkpoint", async () => {
		seedStudioTodo({
			id: "todo_legacy",
			completionNotes: "Verified against the studio checklist.",
		});

		const got = await tool.execute(
			"get-legacy",
			{ action: "get", todo_id: "todo_legacy" },
			undefined,
			undefined,
			context(),
		);
		const todo = JSON.parse(resultText(got)).todo;
		expect(todo.progress).toHaveLength(1);
		expect(todo.progress[0].content).toBe("Verified against the studio checklist.");
		expect(todo.progress[0].source).toBe("user");
	});

	it("requires the fields each action depends on", async () => {
		const missingTitle = await tool.execute("bad-4", { action: "create" }, undefined, undefined, context());
		const missingId = await tool.execute(
			"bad-5",
			{ action: "update", status: "completed" },
			undefined,
			undefined,
			context(),
		);
		const unknownId = await tool.execute(
			"bad-6",
			{ action: "update", todo_id: "todo_missing", status: "completed" },
			undefined,
			undefined,
			context(),
		);
		const getMissingId = await tool.execute("bad-8", { action: "get" }, undefined, undefined, context());
		const getUnknownId = await tool.execute(
			"bad-9",
			{ action: "get", todo_id: "todo_missing" },
			undefined,
			undefined,
			context(),
		);
		const appendMissingContent = await tool.execute(
			"bad-10",
			{ action: "append_progress", todo_id: "todo_missing" },
			undefined,
			undefined,
			context(),
		);
		const editMissingEntry = await tool.execute(
			"bad-11",
			{ action: "edit_progress", todo_id: "todo_missing", content: "x" },
			undefined,
			undefined,
			context(),
		);
		const deleteMissingEntry = await tool.execute(
			"bad-12",
			{ action: "delete_progress", todo_id: "todo_missing" },
			undefined,
			undefined,
			context(),
		);

		expect(missingTitle.details.error).toContain("title");
		expect(missingId.details.error).toContain("todo_id");
		expect(unknownId.details.error).toContain("Todo not found");
		expect(getMissingId.details.error).toContain("get requires todo_id");
		expect(getUnknownId.details.error).toContain("Todo not found");
		expect(appendMissingContent.details.error).toContain("content");
		expect(editMissingEntry.details.error).toContain("entry_id");
		expect(deleteMissingEntry.details.error).toContain("entry_id");
	});

	it("fails loudly when the store cannot be parsed", async () => {
		writeFileSync(todoFile(), "{ not json");

		const result = await tool.execute("bad-7", { action: "list" }, undefined, undefined, context());

		expect(result.details.status).toBe("error");
		expect(resultText(result)).toContain("Unable to parse");
		expect(readFileSync(todoFile(), "utf8")).toBe("{ not json");
	});
});
