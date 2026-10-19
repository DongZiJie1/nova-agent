import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	type MemorySuggestion,
	parseSuggestionState,
	SUGGESTION_STATE_VERSION,
	SuggestionStore,
	SuggestionStoreVersionError,
} from "../../src/core/memory/suggestion-store.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function createAgentDir(): string {
	const directory = mkdtempSync(join(tmpdir(), "nova-suggestion-store-"));
	tempDirs.push(directory);
	return directory;
}

function createStore(agentDir: string = createAgentDir()): SuggestionStore {
	return new SuggestionStore(agentDir);
}

function fileMode(path: string): number {
	return statSync(path).mode & 0o777;
}

function createInput(overrides: Partial<Omit<MemorySuggestion, "id" | "createdAt" | "status">> = {}) {
	return {
		action: "create" as const,
		title: "协作偏好",
		proposedContent: "提交信息用英文，代码注释用中文",
		factIds: ["fact_a"],
		...overrides,
	};
}

function validSuggestion(id: string): MemorySuggestion {
	return {
		id,
		factIds: ["fact_a"],
		action: "create",
		title: "协作偏好",
		proposedContent: "提交信息用英文",
		createdAt: "2026-10-19T00:00:00.000Z",
		status: "pending",
	};
}

function writeState(store: SuggestionStore, value: unknown): void {
	mkdirSync(dirname(store.path), { recursive: true, mode: 0o700 });
	writeFileSync(store.path, `${JSON.stringify(value, null, "\t")}\n`, "utf8");
}

describe("SuggestionStore persistence", () => {
	it("creates a suggestion, reloads it from disk, and keeps restrictive permissions", () => {
		const agentDir = createAgentDir();
		const store = createStore(agentDir);
		expect(store.path).toBe(join(agentDir, "memory", "suggestions.json"));

		const added = store.add(createInput({ reason: "多次出现的偏好" }));

		expect(added.action).toBe("created");
		expect(added.suggestion.id).toMatch(/^sug_/);
		expect(added.suggestion.status).toBe("pending");
		expect(added.suggestion.reason).toBe("多次出现的偏好");

		const reloaded = createStore(agentDir).read();
		expect(reloaded.version).toBe(SUGGESTION_STATE_VERSION);
		expect(reloaded.suggestions).toEqual([added.suggestion]);
		expect(fileMode(store.path)).toBe(0o600);
		expect(fileMode(dirname(store.path))).toBe(0o700);
	});

	it("does not create the state file for an empty store", () => {
		const store = createStore();

		expect(store.read()).toEqual({ version: 1, suggestions: [] });
		expect(store.list()).toEqual([]);
		expect(store.list("pending")).toEqual([]);
		expect(store.get("sug_missing")).toBeUndefined();
		expect(existsSync(store.path)).toBe(false);
	});

	it("treats the same action, target, and fact set as a duplicate", () => {
		const store = createStore();
		const first = store.add(createInput({ factIds: ["fact_a", "fact_b"] }));

		const duplicate = store.add(createInput({ factIds: ["fact_b", "fact_a"] }));

		expect(duplicate.action).toBe("duplicate");
		expect(duplicate.suggestion.id).toBe(first.suggestion.id);
		expect(store.list()).toHaveLength(1);
	});

	it("keeps suggestions with a different action or target section", () => {
		const store = createStore();
		store.add(createInput());
		store.add(
			createInput({
				action: "append",
				targetSectionId: "section_a",
				title: "协作偏好",
				proposedContent: "追加内容",
			}),
		);
		store.add(createInput({ factIds: ["fact_b"] }));

		expect(store.list()).toHaveLength(3);
		expect(store.list().map((suggestion) => suggestion.action)).toEqual(["create", "append", "create"]);
	});

	it("rejects invalid input before touching the file", () => {
		const store = createStore();

		expect(() => store.add(createInput({ factIds: [] }))).toThrow(/at least one fact id/);
		expect(() =>
			store.add(createInput({ action: "append", title: "偏好", proposedContent: "内容", factIds: ["fact_a"] })),
		).toThrow(/target section id/);
		expect(() => store.add(createInput({ title: "   " }))).toThrow(/title must not be empty/);
		expect(() => store.add(createInput({ proposedContent: "  " }))).toThrow(/content must not be empty/);
		expect(existsSync(store.path)).toBe(false);
	});
});

describe("SuggestionStore resolve", () => {
	it("marks a suggestion accepted and records the applied section", () => {
		const agentDir = createAgentDir();
		const store = createStore(agentDir);
		const added = store.add(createInput());

		const resolved = store.resolve(added.suggestion.id, "accepted", { appliedSectionId: "section_style" });

		expect(resolved.status).toBe("accepted");
		expect(resolved.appliedSectionId).toBe("section_style");
		expect(resolved.resolvedAt).toBeDefined();
		expect(createStore(agentDir).get(added.suggestion.id)?.status).toBe("accepted");
		expect(createStore(agentDir).list("pending")).toEqual([]);
	});

	it("marks a suggestion rejected without an applied section", () => {
		const store = createStore();
		const added = store.add(createInput());

		const resolved = store.resolve(added.suggestion.id, "rejected");

		expect(resolved.status).toBe("rejected");
		expect(resolved.appliedSectionId).toBeUndefined();
		expect(resolved.resolvedAt).toBeDefined();
	});

	it("is idempotent for the same status and refuses to change a resolved status", () => {
		const store = createStore();
		const added = store.add(createInput());
		const first = store.resolve(added.suggestion.id, "accepted");

		const second = store.resolve(added.suggestion.id, "accepted", { appliedSectionId: "section_style" });

		expect(second.status).toBe("accepted");
		expect(second.resolvedAt).toBe(first.resolvedAt);
		expect(second.appliedSectionId).toBe("section_style");
		expect(() => store.resolve(added.suggestion.id, "rejected")).toThrow(/already accepted/);
	});

	it("throws for an unknown suggestion id", () => {
		const store = createStore();
		expect(() => store.resolve("sug_missing", "accepted")).toThrow(/Suggestion not found/);
	});
});

describe("SuggestionStore parsing", () => {
	it("throws SuggestionStoreVersionError when the stored version is not 1", () => {
		const store = createStore();
		writeState(store, { version: 2, suggestions: [] });

		expect(() => store.read()).toThrow(SuggestionStoreVersionError);
		expect(() => store.add(createInput())).toThrow(SuggestionStoreVersionError);
	});

	it("throws SuggestionStoreVersionError for a file that is not JSON", () => {
		const store = createStore();
		mkdirSync(dirname(store.path), { recursive: true, mode: 0o700 });
		writeFileSync(store.path, "{not json", "utf8");

		expect(() => store.read()).toThrow(SuggestionStoreVersionError);
	});

	it("drops invalid entries while keeping valid ones", () => {
		const store = createStore();
		writeState(store, {
			version: 1,
			suggestions: [
				validSuggestion("sug_valid"),
				{ ...validSuggestion("sug_bad_action"), action: "delete" },
				{ ...validSuggestion("sug_no_target"), action: "update" },
				{ ...validSuggestion("sug_empty_facts"), factIds: [] },
				{ nope: true },
			],
		});

		const state = store.read();

		expect(state.suggestions).toHaveLength(1);
		expect(state.suggestions[0].id).toBe("sug_valid");
	});

	it("parses a suggestion with the optional diff and resolution fields", () => {
		const state = parseSuggestionState({
			version: 1,
			suggestions: [
				{
					...validSuggestion("sug_update"),
					action: "update",
					targetSectionId: "section_style",
					previousContent: "旧内容",
					reason: "偏好已更新",
					status: "accepted",
					resolvedAt: "2026-10-19T01:00:00.000Z",
					appliedSectionId: "section_style",
				},
			],
		});

		expect(state.suggestions[0].previousContent).toBe("旧内容");
		expect(state.suggestions[0].status).toBe("accepted");
		expect(state.suggestions[0].appliedSectionId).toBe("section_style");
	});

	it("writes a state file that can be read back verbatim", () => {
		const store = createStore();
		store.add(createInput({ action: "update", targetSectionId: "section_a", previousContent: "旧内容" }));

		const payload = JSON.parse(readFileSync(store.path, "utf8")) as { version: number; suggestions: unknown[] };

		expect(payload.version).toBe(1);
		expect(payload.suggestions).toHaveLength(1);
	});
});
