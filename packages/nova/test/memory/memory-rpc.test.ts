import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Fact } from "../../src/core/memory/fact-schema.ts";
import { type FactDraft, FactStore } from "../../src/core/memory/fact-store.ts";
import { type MemoryChangedEvent, notifyMemoryChanged, onMemoryChanged } from "../../src/core/memory/memory-events.ts";
import {
	getMemoryFacts,
	getMemorySuggestions,
	isMemoryFactAction,
	isMemorySuggestionResolution,
	resolveMemorySuggestion,
	updateMemoryFact,
} from "../../src/core/memory/memory-rpc.ts";
import { type MemorySuggestion, SuggestionStore } from "../../src/core/memory/suggestion-store.ts";
import { UserMemoryStore } from "../../src/core/user-memory.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
	vi.restoreAllMocks();
});

interface Workspace {
	agentDir: string;
	store: FactStore;
	suggestions: SuggestionStore;
}

function workspace(): Workspace {
	const agentDir = mkdtempSync(join(tmpdir(), "nova-memory-rpc-"));
	tempDirs.push(agentDir);
	return { agentDir, store: new FactStore(agentDir), suggestions: new SuggestionStore(agentDir) };
}

let sourceCounter = 0;

function makeSource(): FactDraft["source"] {
	sourceCounter += 1;
	return {
		sessionFile: "/sessions/test.jsonl",
		sessionId: "session_a",
		entryIds: [`entry_${sourceCounter}`],
		extractedAt: "2026-10-19T00:00:00.000Z",
		model: "explicit",
	};
}

function addFact(ws: Workspace, text: string, overrides: Partial<FactDraft> = {}): Fact {
	const result = ws.store.add({ text, kind: "preference", source: makeSource(), ...overrides });
	if (result.action !== "created") throw new Error(`Expected a created fact, got ${result.action}`);
	return result.fact;
}

function addSuggestion(
	ws: Workspace,
	factIds: string[],
	overrides: { title?: string; proposedContent?: string } = {},
): MemorySuggestion {
	const added = ws.suggestions.add({
		action: "create",
		title: overrides.title ?? "协作偏好",
		proposedContent: overrides.proposedContent ?? "提交信息用英文，代码注释用中文",
		factIds,
	});
	if (added.action !== "created") throw new Error("Expected a created suggestion");
	return added.suggestion;
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("getMemoryFacts", () => {
	it("returns an empty list and zero counters for a fresh agent dir", () => {
		const ws = workspace();

		expect(getMemoryFacts({ agentDir: ws.agentDir })).toEqual({
			facts: [],
			stats: { active: 0, archived: 0, pendingSuggestions: 0 },
		});
		expect(existsSync(join(ws.agentDir, "memory", "facts.json"))).toBe(false);
	});

	it("keeps archived facts in the list and counts them separately", () => {
		const ws = workspace();
		const kept = addFact(ws, "提交信息用英文");
		const archived = addFact(ws, "文档目录放在 docs 下");
		ws.store.archive(archived.id, "stale");

		const result = getMemoryFacts({ agentDir: ws.agentDir });

		expect(result.facts).toHaveLength(2);
		expect(result.stats).toEqual({ active: 1, archived: 1, pendingSuggestions: 0 });
		expect(result.facts.find((fact) => fact.id === kept.id)?.archivedAt).toBeUndefined();
		expect(result.facts.find((fact) => fact.id === archived.id)?.archivedAt).toBeDefined();
	});

	it("filters facts by applicability without changing the stats", () => {
		const ws = workspace();
		addFact(ws, "提交信息用英文", { applicability: "universal" });
		addFact(ws, "本仓库统一使用 npm workspaces", { applicability: "project", projects: ["proj_a"] });

		const universal = getMemoryFacts({ agentDir: ws.agentDir, applicability: "universal" });
		expect(universal.facts.map((fact) => fact.text)).toEqual(["提交信息用英文"]);
		expect(universal.stats).toEqual({ active: 2, archived: 0, pendingSuggestions: 0 });

		const project = getMemoryFacts({ agentDir: ws.agentDir, applicability: "project" });
		expect(project.facts.map((fact) => fact.text)).toEqual(["本仓库统一使用 npm workspaces"]);

		expect(getMemoryFacts({ agentDir: ws.agentDir, applicability: "transferable" }).facts).toEqual([]);
	});

	it("puts pinned facts first and then sorts by creation time descending", async () => {
		const ws = workspace();
		const first = addFact(ws, "提交信息用英文");
		await delay(5);
		const second = addFact(ws, "文档目录放在 docs 下");
		await delay(5);
		const third = addFact(ws, "单元测试统一使用 vitest");
		ws.store.setPinned(first.id, true);

		expect(getMemoryFacts({ agentDir: ws.agentDir }).facts.map((fact) => fact.id)).toEqual([
			first.id,
			third.id,
			second.id,
		]);
	});

	it("counts only pending suggestions", () => {
		const ws = workspace();
		const firstFact = addFact(ws, "提交信息用英文");
		const secondFact = addFact(ws, "文档目录放在 docs 下");
		addSuggestion(ws, [firstFact.id]);
		const rejected = addSuggestion(ws, [secondFact.id], { title: "文档规范" });
		ws.suggestions.resolve(rejected.id, "rejected");

		expect(getMemoryFacts({ agentDir: ws.agentDir }).stats.pendingSuggestions).toBe(1);
	});

	it("degrades the pending count to zero when the suggestion store is unreadable", () => {
		const ws = workspace();
		const memoryDir = join(ws.agentDir, "memory");
		mkdirSync(memoryDir, { recursive: true, mode: 0o700 });
		writeFileSync(join(memoryDir, "suggestions.json"), JSON.stringify({ version: 99, suggestions: [] }), "utf8");
		const diagnose = vi.spyOn(console, "error").mockImplementation(() => {});

		expect(getMemoryFacts({ agentDir: ws.agentDir }).stats.pendingSuggestions).toBe(0);
		expect(diagnose).toHaveBeenCalled();
	});
});

describe("getMemorySuggestions", () => {
	it("returns an empty list without creating a suggestions file", () => {
		const ws = workspace();

		expect(getMemorySuggestions({ agentDir: ws.agentDir })).toEqual({ suggestions: [] });
		expect(existsSync(join(ws.agentDir, "memory", "suggestions.json"))).toBe(false);
	});

	it("returns only pending suggestions by default", () => {
		const ws = workspace();
		const firstFact = addFact(ws, "提交信息用英文");
		const secondFact = addFact(ws, "文档目录放在 docs 下");
		const pending = addSuggestion(ws, [firstFact.id]);
		const rejected = addSuggestion(ws, [secondFact.id], { title: "文档规范" });
		ws.suggestions.resolve(rejected.id, "rejected");

		const result = getMemorySuggestions({ agentDir: ws.agentDir });

		expect(result.suggestions.map((suggestion) => suggestion.id)).toEqual([pending.id]);
	});

	it("filters by an explicit status", () => {
		const ws = workspace();
		const fact = addFact(ws, "提交信息用英文");
		const suggestion = addSuggestion(ws, [fact.id]);
		ws.suggestions.resolve(suggestion.id, "rejected");

		expect(getMemorySuggestions({ agentDir: ws.agentDir, status: "rejected" }).suggestions).toHaveLength(1);
		expect(getMemorySuggestions({ agentDir: ws.agentDir, status: "accepted" }).suggestions).toEqual([]);
		expect(getMemorySuggestions({ agentDir: ws.agentDir, status: "pending" }).suggestions).toEqual([]);
	});

	it("sorts newest first", async () => {
		const ws = workspace();
		const firstFact = addFact(ws, "提交信息用英文");
		const secondFact = addFact(ws, "文档目录放在 docs 下");
		const older = addSuggestion(ws, [firstFact.id]);
		await delay(5);
		const newer = addSuggestion(ws, [secondFact.id], { title: "文档规范" });

		expect(getMemorySuggestions({ agentDir: ws.agentDir }).suggestions.map((entry) => entry.id)).toEqual([
			newer.id,
			older.id,
		]);
	});
});

describe("updateMemoryFact", () => {
	it("pins and unpins a fact", () => {
		const ws = workspace();
		const fact = addFact(ws, "提交信息用英文");

		expect(updateMemoryFact({ agentDir: ws.agentDir, id: fact.id, action: "pin" })).toEqual({ ok: true });
		expect(new FactStore(ws.agentDir).get(fact.id)?.pinned).toBe(true);

		updateMemoryFact({ agentDir: ws.agentDir, id: fact.id, action: "unpin" });
		expect(new FactStore(ws.agentDir).get(fact.id)?.pinned).toBe(false);
	});

	it("archives a fact with reason manual", () => {
		const ws = workspace();
		const fact = addFact(ws, "提交信息用英文");

		expect(updateMemoryFact({ agentDir: ws.agentDir, id: fact.id, action: "archive" })).toEqual({ ok: true });

		const archived = new FactStore(ws.agentDir).get(fact.id);
		expect(archived?.archivedAt).toBeDefined();
		expect(archived?.archiveReason).toBe("manual");
		expect(new FactStore(ws.agentDir).active().some((entry) => entry.id === fact.id)).toBe(false);
	});

	it("treats delete as archive with reason manual", () => {
		const ws = workspace();
		const fact = addFact(ws, "提交信息用英文");

		updateMemoryFact({ agentDir: ws.agentDir, id: fact.id, action: "delete" });

		const archived = new FactStore(ws.agentDir).get(fact.id);
		expect(archived?.archivedAt).toBeDefined();
		expect(archived?.archiveReason).toBe("manual");
	});

	it("is idempotent when the fact is already archived", async () => {
		const ws = workspace();
		const fact = addFact(ws, "提交信息用英文");
		updateMemoryFact({ agentDir: ws.agentDir, id: fact.id, action: "archive" });
		const archivedAt = new FactStore(ws.agentDir).get(fact.id)?.archivedAt;
		await delay(5);

		expect(updateMemoryFact({ agentDir: ws.agentDir, id: fact.id, action: "delete" })).toEqual({ ok: true });
		expect(new FactStore(ws.agentDir).get(fact.id)?.archivedAt).toBe(archivedAt);
	});

	it("throws for an unknown fact id", () => {
		const ws = workspace();

		expect(() => updateMemoryFact({ agentDir: ws.agentDir, id: "fact_missing", action: "pin" })).toThrow(
			/Fact not found: fact_missing/,
		);
		expect(() => updateMemoryFact({ agentDir: ws.agentDir, id: "fact_missing", action: "delete" })).toThrow(
			/Fact not found/,
		);
	});

	it("edits a fact in place and reports the store action", () => {
		const ws = workspace();
		const fact = addFact(ws, "提交信息用英文", { importance: 2 });

		const result = updateMemoryFact({
			agentDir: ws.agentDir,
			id: fact.id,
			action: "edit",
			patch: { text: "提交信息统一用英文", importance: 5 },
		});

		expect(result).toEqual({
			ok: true,
			action: "updated",
			fact: expect.objectContaining({ id: fact.id, text: "提交信息统一用英文", importance: 5 }),
		});
		const reloaded = new FactStore(ws.agentDir).get(fact.id);
		expect(reloaded?.createdAt).toBe(fact.createdAt);
		expect(reloaded?.text).toBe("提交信息统一用英文");
		expect(new FactStore(ws.agentDir).active()).toHaveLength(1);
	});

	it("reports duplicate and conflict results for an edit", () => {
		const ws = workspace();
		const first = addFact(ws, "项目使用 tab 缩进");
		const second = addFact(ws, "文档目录放在 docs 下");

		const duplicate = updateMemoryFact({
			agentDir: ws.agentDir,
			id: second.id,
			action: "edit",
			patch: { text: "项目使用 tab 缩进" },
		});
		expect(duplicate).toEqual({
			ok: true,
			action: "duplicate",
			fact: expect.objectContaining({ id: first.id }),
		});

		const conflict = updateMemoryFact({
			agentDir: ws.agentDir,
			id: second.id,
			action: "edit",
			patch: { text: "项目不再使用 tab 缩进" },
		});
		expect(conflict).toEqual({
			ok: true,
			action: "conflict",
			candidates: [expect.objectContaining({ id: first.id })],
		});
		expect(new FactStore(ws.agentDir).get(second.id)?.text).toBe("文档目录放在 docs 下");
	});

	it("requires a patch for edit and rejects patches on other actions", () => {
		const ws = workspace();
		const fact = addFact(ws, "提交信息用英文");

		expect(() => updateMemoryFact({ agentDir: ws.agentDir, id: fact.id, action: "edit" })).toThrow(
			/requires a patch/,
		);
		expect(() =>
			updateMemoryFact({ agentDir: ws.agentDir, id: fact.id, action: "pin", patch: { text: "提交信息统一用英文" } }),
		).toThrow(/only valid for edit/);
		expect(() =>
			updateMemoryFact({ agentDir: ws.agentDir, id: "fact_missing", action: "edit", patch: { importance: 4 } }),
		).toThrow(/Fact not found: fact_missing/);
	});

	it("validates actions at runtime", () => {
		expect(isMemoryFactAction("pin")).toBe(true);
		expect(isMemoryFactAction("delete")).toBe(true);
		expect(isMemoryFactAction("edit")).toBe(true);
		expect(isMemoryFactAction("promote")).toBe(false);
		expect(isMemoryFactAction(undefined)).toBe(false);
		expect(isMemorySuggestionResolution("accept")).toBe(true);
		expect(isMemorySuggestionResolution("reject")).toBe(true);
		expect(isMemorySuggestionResolution("archive")).toBe(false);
		expect(isMemorySuggestionResolution(null)).toBe(false);
	});
});

describe("resolveMemorySuggestion", () => {
	it("accepts a suggestion, writes the profile section, and promotes its facts", () => {
		const ws = workspace();
		const fact = addFact(ws, "提交信息用英文");
		const suggestion = addSuggestion(ws, [fact.id]);

		const result = resolveMemorySuggestion({ agentDir: ws.agentDir, id: suggestion.id, action: "accept" });

		expect(result.ok).toBe(true);
		expect(result.sectionId).toBeDefined();
		expect(new UserMemoryStore(ws.agentDir).list().map((section) => section.title)).toContain("协作偏好");

		const promoted = new FactStore(ws.agentDir).get(fact.id);
		expect(promoted?.reviewState).toBe("promoted");
		expect(promoted?.archivedAt).toBeDefined();
		expect(promoted?.promotedToSectionId).toBe(result.sectionId);

		const stored = new SuggestionStore(ws.agentDir).get(suggestion.id);
		expect(stored?.status).toBe("accepted");
		expect(stored?.appliedSectionId).toBe(result.sectionId);
	});

	it("returns the original section id when the suggestion is accepted twice", () => {
		const ws = workspace();
		const fact = addFact(ws, "提交信息用英文");
		const suggestion = addSuggestion(ws, [fact.id]);

		const first = resolveMemorySuggestion({ agentDir: ws.agentDir, id: suggestion.id, action: "accept" });
		const second = resolveMemorySuggestion({ agentDir: ws.agentDir, id: suggestion.id, action: "accept" });

		expect(second).toEqual(first);
		expect(new UserMemoryStore(ws.agentDir).list()).toHaveLength(1);
	});

	it("rejects a suggestion and returns its facts to kept", () => {
		const ws = workspace();
		const fact = addFact(ws, "提交信息用英文");
		const suggestion = addSuggestion(ws, [fact.id]);

		expect(resolveMemorySuggestion({ agentDir: ws.agentDir, id: suggestion.id, action: "reject" })).toEqual({
			ok: true,
		});

		const stored = new SuggestionStore(ws.agentDir).get(suggestion.id);
		expect(stored?.status).toBe("rejected");
		const kept = new FactStore(ws.agentDir).get(fact.id);
		expect(kept?.reviewState).toBe("kept");
		expect(kept?.archivedAt).toBeUndefined();
		expect(new UserMemoryStore(ws.agentDir).list()).toEqual([]);
	});

	it("rejects twice without throwing", () => {
		const ws = workspace();
		const fact = addFact(ws, "提交信息用英文");
		const suggestion = addSuggestion(ws, [fact.id]);

		resolveMemorySuggestion({ agentDir: ws.agentDir, id: suggestion.id, action: "reject" });

		expect(() =>
			resolveMemorySuggestion({ agentDir: ws.agentDir, id: suggestion.id, action: "reject" }),
		).not.toThrow();
	});

	it("throws for an unknown suggestion id", () => {
		const ws = workspace();

		expect(() => resolveMemorySuggestion({ agentDir: ws.agentDir, id: "sug_missing", action: "accept" })).toThrow(
			/Suggestion not found: sug_missing/,
		);
	});

	it("throws when rejecting an already accepted suggestion", () => {
		const ws = workspace();
		const fact = addFact(ws, "提交信息用英文");
		const suggestion = addSuggestion(ws, [fact.id]);
		resolveMemorySuggestion({ agentDir: ws.agentDir, id: suggestion.id, action: "accept" });

		expect(() => resolveMemorySuggestion({ agentDir: ws.agentDir, id: suggestion.id, action: "reject" })).toThrow(
			/already accepted/,
		);
	});
});

describe("memory change events", () => {
	it("delivers a change to subscribers", () => {
		const events: MemoryChangedEvent[] = [];
		const unsubscribe = onMemoryChanged((event) => events.push(event));

		try {
			notifyMemoryChanged("fact_added");
			expect(events).toEqual([{ type: "memory_changed", reason: "fact_added" }]);
		} finally {
			unsubscribe();
		}
	});

	it("stops delivery after the unsubscribe function is called", () => {
		const events: MemoryChangedEvent[] = [];
		const unsubscribe = onMemoryChanged((event) => events.push(event));
		unsubscribe();
		unsubscribe();

		notifyMemoryChanged("store");
		expect(events).toEqual([]);
	});

	it("keeps delivering to other listeners when one throws", () => {
		const diagnose = vi.spyOn(console, "error").mockImplementation(() => {});
		const events: MemoryChangedEvent[] = [];
		const failing = onMemoryChanged(() => {
			throw new Error("listener boom");
		});
		const healthy = onMemoryChanged((event) => events.push(event));

		try {
			notifyMemoryChanged("store");
			expect(events).toEqual([{ type: "memory_changed", reason: "store" }]);
			expect(diagnose).toHaveBeenCalled();
		} finally {
			failing();
			healthy();
		}
	});

	it("notifies after a fact write and stays silent for duplicates", () => {
		const ws = workspace();
		const events: MemoryChangedEvent[] = [];
		const unsubscribe = onMemoryChanged((event) => events.push(event));

		try {
			const fact = addFact(ws, "提交信息用英文");
			expect(events).toHaveLength(1);

			const duplicate = ws.store.add({ text: "提交信息用英文", source: makeSource() });
			expect(duplicate.action).toBe("duplicate");
			expect(events).toHaveLength(1);

			ws.store.archive(fact.id, "manual");
			expect(events).toHaveLength(2);
		} finally {
			unsubscribe();
		}
	});

	it("notifies after a successful edit and stays silent for duplicates and conflicts", () => {
		const ws = workspace();
		const first = addFact(ws, "项目使用 tab 缩进");
		const second = addFact(ws, "文档目录放在 docs 下");
		const events: MemoryChangedEvent[] = [];
		const unsubscribe = onMemoryChanged((event) => events.push(event));

		try {
			ws.store.update(second.id, { importance: 5 });
			expect(events).toHaveLength(1);

			const duplicate = ws.store.update(second.id, { text: first.text });
			expect(duplicate.action).toBe("duplicate");
			expect(events).toHaveLength(1);

			const conflict = ws.store.update(second.id, { text: "项目不再使用 tab 缩进" });
			expect(conflict.action).toBe("conflict");
			expect(events).toHaveLength(1);
		} finally {
			unsubscribe();
		}
	});

	it("notifies after suggestion writes and resolutions", () => {
		const ws = workspace();
		const fact = addFact(ws, "提交信息用英文");
		const events: MemoryChangedEvent[] = [];
		const unsubscribe = onMemoryChanged((event) => events.push(event));

		try {
			const suggestion = addSuggestion(ws, [fact.id]);
			ws.suggestions.resolve(suggestion.id, "rejected");
			expect(events).toHaveLength(2);

			// 重复标记同一状态不写文件，也就不发通知。
			ws.suggestions.resolve(suggestion.id, "rejected");
			expect(events).toHaveLength(2);
		} finally {
			unsubscribe();
		}
	});
});
