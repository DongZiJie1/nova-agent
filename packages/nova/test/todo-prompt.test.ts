import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { todoPrompt } from "../src/core/todo-prompt.ts";

const directories: string[] = [];

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("todoPrompt", () => {
	it("loads only the first 50 in list order and truncates descriptions like todo list", () => {
		const directory = mkdtempSync(join(tmpdir(), "nova-todo-prompt-"));
		directories.push(directory);
		const items = Array.from({ length: 51 }, (_, index) => ({
			id: `todo_${index}`,
			title: `Task ${index}`,
			description: "x".repeat(700),
			progress: [
				{
					id: `progress_${index}_a`,
					at: "2026-09-01T00:00:00.000Z",
					content: "private full checkpoint",
					source: "user",
				},
				{
					id: `progress_${index}_b`,
					at: "2026-09-02T00:00:00.000Z",
					content: `latest checkpoint ${index} ${"y".repeat(300)}`,
					source: "agent",
					percent: 50,
				},
			],
			status: "pending",
			priority: "medium",
			source: "user",
			createdAt: "2026-09-01T00:00:00.000Z",
			updatedAt: "2026-09-01T00:00:00.000Z",
			order: 50 - index,
		}));
		writeFileSync(join(directory, "todos.json"), JSON.stringify({ version: 1, items }));
		const prompt = todoPrompt(directory);
		expect(prompt).toContain("first 50 of 51 todos");
		expect(prompt).toContain("todo_50");
		expect(prompt).not.toContain('"id":"todo_0"');
		expect(prompt).toContain(`${"x".repeat(600)}…`);
		// Only the latest checkpoint snippet is preloaded; the full timeline needs todo get.
		expect(prompt).not.toContain("private full checkpoint");
		expect(prompt).toContain("latest checkpoint");
		expect(prompt).toContain("progressCount");
	});

	it("omits an empty todo list", () => {
		const directory = mkdtempSync(join(tmpdir(), "nova-todo-prompt-"));
		directories.push(directory);
		expect(todoPrompt(directory)).toBeUndefined();
	});
});
