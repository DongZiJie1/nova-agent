import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createNovaDataToolDefinition } from "../src/core/tools/nova-data.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function createSessionFile(
	sessionDir: string,
	id: string,
	cwd: string,
	userText: string,
	assistantText: string,
): string {
	const path = join(sessionDir, `${id}.jsonl`);
	const timestamp = "2026-01-01T00:00:00.000Z";
	const entries = [
		{ type: "session", version: 3, id, timestamp, cwd },
		{
			type: "message",
			id: `${id}-user`,
			parentId: null,
			timestamp,
			message: { role: "user", content: [{ type: "text", text: userText }], timestamp: 1 },
		},
		{
			type: "message",
			id: `${id}-assistant`,
			parentId: `${id}-user`,
			timestamp,
			message: {
				role: "assistant",
				content: [{ type: "text", text: assistantText }],
				api: "openai-responses",
				provider: "openai",
				model: "test",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: 2,
			},
		},
	];
	writeFileSync(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
	return path;
}

function createContext(sessionManager: SessionManager, hasUI = false): ExtensionContext {
	return {
		hasUI,
		sessionManager,
		ui: {
			confirm: async () => false,
		},
	} as unknown as ExtensionContext;
}

function resultText(result: { content: Array<{ type: string; text?: string }> }): string {
	const first = result.content[0];
	return first?.type === "text" ? (first.text ?? "") : "";
}

describe("nova_data tool", () => {
	it("uses an object-shaped top-level JSON schema", () => {
		expect(createNovaDataToolDefinition().parameters.type).toBe("object");
	});

	it("lists projects and reads another session without tool-result data", async () => {
		const sessionDir = mkdtempSync(join(tmpdir(), "nova-data-"));
		tempDirs.push(sessionDir);
		const currentPath = createSessionFile(sessionDir, "current", "/project/a", "current question", "current answer");
		createSessionFile(sessionDir, "other", "/project/b", "other question", "other answer");
		const context = createContext(SessionManager.open(currentPath, sessionDir));
		const tool = createNovaDataToolDefinition();

		const projects = await tool.execute("projects", { action: "list_projects" }, undefined, undefined, context);
		expect(JSON.parse(resultText(projects)).projects).toEqual([
			expect.objectContaining({ path: "/project/a", sessionCount: 1 }),
			expect.objectContaining({ path: "/project/b", sessionCount: 1 }),
		]);

		const read = await tool.execute(
			"read",
			{ action: "read_session", session_id: "other" },
			undefined,
			undefined,
			context,
		);
		const data = JSON.parse(resultText(read));
		expect(data.projectPath).toBe("/project/b");
		expect(data.messages).toEqual([
			expect.objectContaining({ role: "user", text: "other question" }),
			expect.objectContaining({ role: "assistant", text: "other answer" }),
		]);
	});

	it("refuses to delete the active session", async () => {
		const sessionDir = mkdtempSync(join(tmpdir(), "nova-data-"));
		tempDirs.push(sessionDir);
		const currentPath = createSessionFile(sessionDir, "current", "/project/a", "question", "answer");
		const context = createContext(SessionManager.open(currentPath, sessionDir), true);

		const deletion = await createNovaDataToolDefinition().execute(
			"delete",
			{ action: "delete_session", session_id: "current" },
			undefined,
			undefined,
			context,
		);
		expect(resultText(deletion)).toContain("Cannot delete the currently active session");
		expect(deletion.details?.status).toBe("error");
	});

	it("requires an interactive UI before deleting another session", async () => {
		const sessionDir = mkdtempSync(join(tmpdir(), "nova-data-"));
		tempDirs.push(sessionDir);
		const currentPath = createSessionFile(sessionDir, "current", "/project/a", "question", "answer");
		createSessionFile(sessionDir, "other", "/project/a", "other", "answer");
		const context = createContext(SessionManager.open(currentPath, sessionDir));

		const deletion = await createNovaDataToolDefinition().execute(
			"delete",
			{ action: "delete_session", session_id: "other" },
			undefined,
			undefined,
			context,
		);
		expect(resultText(deletion)).toContain("requires interactive user confirmation");
		expect(deletion.details?.status).toBe("error");
	});
});
