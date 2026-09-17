import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { UserMemoryStore } from "../src/core/user-memory.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function createStore(): UserMemoryStore {
	const directory = mkdtempSync(join(tmpdir(), "nova-user-memory-"));
	tempDirs.push(directory);
	return new UserMemoryStore(directory);
}

describe("UserMemoryStore", () => {
	it("stores durable identity and preference memories for prompt injection", () => {
		const store = createStore();
		store.upsertSection(undefined, "关于我", "I am a TypeScript engineer");
		store.upsertSection(undefined, "沟通习惯", "Reply in Chinese");

		expect(store.list()).toHaveLength(2);
		expect(store.toPrompt()).toMatch(/## 关于我\n<section_id>section_.+<\/section_id>\nI am a TypeScript engineer/);
		expect(store.toPrompt()).toMatch(/## 沟通习惯\n<section_id>section_.+<\/section_id>\nReply in Chinese/);
	});

	it("deduplicates an identical memory and respects the enabled setting", () => {
		const store = createStore();
		const section = store.upsertSection(undefined, "代码风格", "Use tabs for indentation");
		store.upsertSection(section.id, "工程偏好", " use tabs for indentation ");
		expect(store.list()).toHaveLength(1);
		store.setEnabled(false);
		expect(store.toPrompt()).toBeUndefined();
		expect(() => store.upsertSection(undefined, "回复偏好", "Use concise answers")).toThrow("disabled");
	});

	it("rejects likely credentials and supports deletion", () => {
		const store = createStore();
		expect(() => store.upsertSection(undefined, "Secrets", "My API key is sk_abcdefghijklmnopqrstuvwx")).toThrow(
			"Sensitive",
		);
		const section = store.upsertSection(undefined, "职业", "I work in product design");

		expect(store.deleteSection(section.id)).toBe(true);
		expect(store.list()).toEqual([]);
	});

	it("migrates legacy entry memories into profile sections", () => {
		const store = createStore();
		writeFileSync(
			store.path,
			JSON.stringify({
				version: 1,
				enabled: true,
				memories: [
					{ category: "identity", content: "I am an engineer" },
					{ category: "preference", content: "Reply in Chinese" },
				],
			}),
		);
		expect(store.list()).toEqual([
			expect.objectContaining({ title: "概览", content: "I am an engineer" }),
			expect.objectContaining({ title: "协作偏好", content: "Reply in Chinese" }),
		]);
	});
});
