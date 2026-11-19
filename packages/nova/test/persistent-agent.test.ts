import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { FactStore } from "../src/core/memory/fact-store.ts";
import { loadPersistentAgent, persistentAgentDirectory } from "../src/core/persistent-agent.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createAllToolDefinitions } from "../src/core/tools/index.ts";

const temporary: string[] = [];
afterEach(() => {
	for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function root() {
	const dir = mkdtempSync(join(tmpdir(), "nova-persistent-agent-"));
	temporary.push(dir);
	return dir;
}
function profile(config: string, name: string) {
	const id = randomUUID();
	const dir = persistentAgentDirectory(config, id);
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "profile.json"),
		JSON.stringify({ id, name, tools: ["read", "search_memory"], skills: ["review"] }),
	);
	writeFileSync(join(dir, "AGENTS.md"), `You are ${name}`);
	return dir;
}

describe("persistent Agent identity", () => {
	it("reloads identity and config from disk", () => {
		const config = root();
		const reviewer = profile(config, "Reviewer");
		profile(config, "Writer");
		expect(loadPersistentAgent(config)).toBeUndefined();
		expect(loadPersistentAgent(reviewer)).toMatchObject({
			name: "Reviewer",
			instructions: "You are Reviewer",
			configDir: config,
			tools: ["read", "search_memory"],
			skills: ["review"],
		});
		writeFileSync(join(reviewer, "AGENTS.md"), "Updated reviewer identity");
		expect(loadPersistentAgent(reviewer)?.instructions).toBe("Updated reviewer identity");
	});
	it("rejects path escapes, mismatched ids and deleted identities", () => {
		const config = root();
		for (const id of ["../escape", "/tmp/other", "", randomUUID().toUpperCase()])
			expect(() => persistentAgentDirectory(config, id)).toThrow();
		const reviewer = profile(config, "Reviewer");
		writeFileSync(
			join(reviewer, "profile.json"),
			JSON.stringify({ id: randomUUID(), name: "Reviewer", tools: [], skills: [] }),
		);
		expect(() => loadPersistentAgent(reviewer)).toThrow("Invalid Agent profile");
		rmSync(reviewer, { recursive: true });
		expect(() => loadPersistentAgent(reviewer)).toThrow();
	});
	it("isolates built-in memory tools between identities and reuses memory across projects", async () => {
		const config = root();
		const reviewer = profile(config, "Reviewer");
		const writer = profile(config, "Writer");
		const ctx = (cwd: string) =>
			({ cwd, sessionManager: SessionManager.inMemory(cwd) }) as unknown as ExtensionContext;
		const first = ctx(join(config, "project-a"));

		await createAllToolDefinitions(config, { agentDir: reviewer }).remember.execute(
			"remember-1",
			{ text: "Review error handling first", applicability: "universal" },
			undefined,
			undefined,
			first,
		);
		const fact = new FactStore(reviewer).list()[0];
		expect(fact?.text).toBe("Review error handling first");
		expect(new FactStore(writer).list()).toEqual([]);
		expect(new FactStore(config).list()).toEqual([]);
		const second = ctx(join(config, "project-b"));
		const result = await createAllToolDefinitions(config, { agentDir: reviewer }).read_memory.execute(
			"read-1",
			{ id: fact.id },
			undefined,
			undefined,
			second,
		);
		expect(JSON.stringify(result)).toContain("Review error handling first");
		const other = await createAllToolDefinitions(config, { agentDir: writer }).read_memory.execute(
			"read-2",
			{ id: fact.id },
			undefined,
			undefined,
			second,
		);
		expect(JSON.stringify(other)).not.toContain("Review error handling first");
	});
});
