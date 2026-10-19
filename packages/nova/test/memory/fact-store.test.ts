import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Fact, FactSource } from "../../src/core/memory/fact-schema.ts";
import {
	type AddFactResult,
	type FactDraft,
	FactStore,
	FactStoreVersionError,
	SensitiveFactError,
} from "../../src/core/memory/fact-store.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const tempDirs: string[] = [];
let factCounter = 0;

afterEach(() => {
	for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function createAgentDir(): string {
	const directory = mkdtempSync(join(tmpdir(), "nova-fact-store-"));
	tempDirs.push(directory);
	return directory;
}

function createStore(agentDir: string = createAgentDir()): FactStore {
	return new FactStore(agentDir);
}

function makeSource(): FactSource {
	factCounter += 1;
	return {
		sessionFile: "/sessions/test.jsonl",
		sessionId: `session_${factCounter}`,
		entryIds: ["entry-1", "entry-2"],
		extractedAt: new Date().toISOString(),
		model: "provider/model",
	};
}

function makeDraft(text: string, overrides: Partial<FactDraft> = {}): FactDraft {
	return { text, source: makeSource(), ...overrides };
}

function createdFact(result: AddFactResult): Fact {
	if (result.action !== "created") throw new Error(`expected created, got ${result.action}`);
	return result.fact;
}

function resultFact(result: AddFactResult): Fact {
	if (result.action === "conflict") throw new Error("expected a fact result, got conflict");
	return result.fact;
}

function isoFrom(base: number, days: number): string {
	return new Date(base - days * DAY_MS).toISOString();
}

function storedFact(overrides: Partial<Fact> = {}): Fact {
	factCounter += 1;
	const now = new Date().toISOString();
	return {
		id: `fact_stored_${factCounter}`,
		text: `stored fact ${factCounter}`,
		kind: "decision",
		applicability: "universal",
		topics: ["stored"],
		importance: 3,
		confidence: 0.8,
		createdAt: now,
		updatedAt: now,
		retrievalCount: 0,
		pinned: false,
		reviewState: "unreviewed",
		source: makeSource(),
		...overrides,
	};
}

function writeState(store: FactStore, facts: Fact[]): void {
	mkdirSync(dirname(store.path), { recursive: true, mode: 0o700 });
	writeFileSync(store.path, `${JSON.stringify({ version: 1, facts }, null, "\t")}\n`, "utf8");
}

function fileMode(path: string): number {
	return statSync(path).mode & 0o777;
}

describe("FactStore persistence", () => {
	it("creates a fact, reloads it from disk, and keeps restrictive permissions", () => {
		const agentDir = createAgentDir();
		const store = createStore(agentDir);
		expect(store.path).toBe(join(agentDir, "memory", "facts.json"));

		const fact = createdFact(store.add(makeDraft("项目使用 pnpm 管理依赖", { topics: ["tooling"], importance: 4 })));

		const reloaded = createStore(agentDir).read();
		expect(reloaded.version).toBe(1);
		expect(reloaded.facts).toHaveLength(1);
		expect(reloaded.facts[0]).toEqual(fact);
		expect(fileMode(store.path)).toBe(0o600);
		expect(fileMode(dirname(store.path))).toBe(0o700);
	});

	it("does not create the state file for an empty store", () => {
		const store = createStore();

		expect(store.read()).toEqual({ version: 1, facts: [] });
		expect(store.list()).toEqual([]);
		expect(store.active()).toEqual([]);
		expect(store.get("fact_missing")).toBeUndefined();
		expect(existsSync(store.path)).toBe(false);
	});

	it("throws FactStoreVersionError when the stored version is not 1", () => {
		const store = createStore();
		mkdirSync(dirname(store.path), { recursive: true, mode: 0o700 });
		writeFileSync(store.path, JSON.stringify({ version: 2, facts: [] }), "utf8");

		expect(() => store.read()).toThrow(FactStoreVersionError);
		expect(() => store.add(makeDraft("项目使用 pnpm 管理依赖"))).toThrow(FactStoreVersionError);
	});

	it("drops invalid entries while keeping valid ones", () => {
		const store = createStore();
		writeState(store, [storedFact(), { ...storedFact(), id: "" } as Fact, { nope: true } as unknown as Fact]);

		expect(store.list()).toHaveLength(1);
	});
});

describe("FactStore dedupe, merge, and conflict", () => {
	it("treats normalized duplicates as duplicates without growing the store", () => {
		const store = createStore();
		const first = createdFact(store.add(makeDraft("Use PNPM for dependencies")));

		const result = store.add(makeDraft("  use   pnpm for dependencies  "));

		expect(result.action).toBe("duplicate");
		expect(resultFact(result).id).toBe(first.id);
		expect(store.active()).toHaveLength(1);
	});

	it("merges near-identical facts, preferring the longer text and widening topics", () => {
		const store = createStore();
		const first = createdFact(
			store.add(makeDraft("项目使用 tab 缩进并且行宽为 120", { topics: ["style"], importance: 2 })),
		);

		const result = store.add(
			makeDraft("项目使用 tab 缩进并且行宽为 120 字符", { topics: ["conventions", "style"], importance: 5 }),
		);

		expect(result.action).toBe("merged");
		const merged = resultFact(result);
		expect(merged.id).toBe(first.id);
		expect(merged.text).toBe("项目使用 tab 缩进并且行宽为 120 字符");
		expect(merged.topics).toEqual(["style", "conventions"]);
		expect(merged.importance).toBe(5);
		expect(merged.updatedAt >= first.updatedAt).toBe(true);
		expect(store.active()).toHaveLength(1);
	});

	it("reports a conflict for similar facts containing a contradiction marker", () => {
		const store = createStore();
		const first = createdFact(store.add(makeDraft("项目使用 tab 缩进")));

		const result = store.add(makeDraft("项目不再使用 tab 缩进"));

		expect(result.action).toBe("conflict");
		if (result.action !== "conflict") throw new Error("expected conflict");
		expect(result.candidates.map((candidate) => candidate.id)).toEqual([first.id]);
		expect(store.active()).toHaveLength(1);
	});

	it("reports a conflict when only the stored fact carries the negation", () => {
		const store = createStore();
		const first = createdFact(store.add(makeDraft("项目不再使用 tab 缩进")));

		const result = store.add(makeDraft("项目使用 tab 缩进"));

		expect(result.action).toBe("conflict");
		if (result.action !== "conflict") throw new Error("expected conflict");
		expect(result.candidates.map((candidate) => candidate.id)).toEqual([first.id]);
		expect(store.active()).toHaveLength(1);
	});

	it("reports a conflict for similar facts whose numbers differ", () => {
		const store = createStore();
		const first = createdFact(store.add(makeDraft("行宽设置为 120")));

		const result = store.add(makeDraft("行宽设置为 100"));

		expect(result.action).toBe("conflict");
		if (result.action !== "conflict") throw new Error("expected conflict");
		expect(result.candidates.map((candidate) => candidate.id)).toEqual([first.id]);
		expect(store.list()).toHaveLength(1);
	});

	it("creates a separate fact when texts are unrelated", () => {
		const store = createStore();
		store.add(makeDraft("项目使用 pnpm 管理依赖"));

		const result = store.add(makeDraft("周末喜欢徒步旅行"));

		expect(result.action).toBe("created");
		expect(store.active()).toHaveLength(2);
	});
});

describe("FactStore supersedes and validation", () => {
	it("archives superseded facts and links them to the replacement", () => {
		const store = createStore();
		const previous = createdFact(store.add(makeDraft("项目使用 yarn 管理依赖")));

		const replacement = createdFact(store.add(makeDraft("项目使用 pnpm 管理依赖", { supersedes: [previous.id] })));

		expect(replacement.supersedes).toEqual([previous.id]);
		const archived = store.get(previous.id);
		expect(archived?.archivedAt).toBeDefined();
		expect(archived?.archiveReason).toBe("superseded");
		expect(archived?.supersededBy).toBe(replacement.id);
		expect(store.active().map((fact) => fact.id)).toEqual([replacement.id]);
	});

	it("rejects supersedes targets that do not exist", () => {
		const store = createStore();
		expect(() => store.add(makeDraft("项目使用 pnpm 管理依赖", { supersedes: ["fact_missing"] }))).toThrow(
			/unknown fact/,
		);
		expect(existsSync(store.path)).toBe(false);
	});

	it("rejects sensitive text", () => {
		const store = createStore();
		expect(() => store.add(makeDraft("My api key is sk_abcdefghijklmnopqrstuvwx"))).toThrow(SensitiveFactError);
		expect(existsSync(store.path)).toBe(false);
	});

	it("rejects empty and overlong text", () => {
		const store = createStore();
		expect(() => store.add(makeDraft("   "))).toThrow(/must not be empty/);
		expect(() => store.add(makeDraft("a".repeat(201)))).toThrow(/at most 200/);
		expect(store.add(makeDraft("a".repeat(200))).action).toBe("created");
	});

	it("requires project keys for project-scoped facts", () => {
		const store = createStore();
		expect(() => store.add(makeDraft("部署到 staging 环境", { applicability: "project" }))).toThrow(/project key/);

		const scoped = createdFact(
			store.add(makeDraft("部署到 staging 环境", { applicability: "project", projects: ["proj-a"] })),
		);
		expect(scoped.applicability).toBe("project");
		expect(scoped.projects).toEqual(["proj-a"]);
	});
});

describe("FactStore lifecycle", () => {
	it("persists pinned, review state, and archive changes", () => {
		const store = createStore();
		const fact = createdFact(store.add(makeDraft("项目使用 pnpm 管理依赖")));

		expect(store.setPinned(fact.id, true).pinned).toBe(true);
		expect(store.get(fact.id)?.pinned).toBe(true);

		const reviewed = store.setReviewState(fact.id, "promoted", { promotedToSectionId: "section_style" });
		expect(reviewed.reviewState).toBe("promoted");
		expect(reviewed.promotedToSectionId).toBe("section_style");
		expect(reviewed.reviewedAt).toBeDefined();

		expect(store.archive(fact.id, "manual")).toBe(true);
		const archived = store.get(fact.id);
		expect(archived?.archiveReason).toBe("manual");
		expect(archived?.archivedAt).toBeDefined();
		expect(store.active()).toEqual([]);
		expect(store.archive(fact.id, "manual")).toBe(false);
	});

	it("counts retrievals and records the last retrieval time in one write", () => {
		const agentDir = createAgentDir();
		const store = createStore(agentDir);
		const first = createdFact(store.add(makeDraft("项目使用 pnpm 管理依赖")));
		const second = createdFact(store.add(makeDraft("周末喜欢徒步旅行")));

		store.recordRetrieval([first.id, second.id]);
		store.recordRetrieval([first.id, first.id]);

		const reloaded = createStore(agentDir).list();
		const firstAfter = reloaded.find((fact) => fact.id === first.id);
		const secondAfter = reloaded.find((fact) => fact.id === second.id);
		expect(firstAfter?.retrievalCount).toBe(2);
		expect(secondAfter?.retrievalCount).toBe(1);
		expect(firstAfter?.lastRetrievedAt).toBeDefined();
		expect(secondAfter?.lastRetrievedAt).toBeDefined();
	});

	it("honors a custom stale threshold", () => {
		const store = createStore();
		const nowMs = Date.parse("2026-06-01T00:00:00.000Z");
		const now = new Date(nowMs);
		const old = isoFrom(nowMs, 100);
		const stale = storedFact({ id: "fact_stale", createdAt: old, updatedAt: old, importance: 2 });
		writeState(store, [stale]);

		expect(store.prune({ now, staleAfterDays: 120 })).toEqual({ archived: 0 });
		expect(store.prune({ now, staleAfterDays: 30 })).toEqual({ archived: 1 });
	});

	it("prunes expired, stale, and superseded facts while keeping protected ones", () => {
		const store = createStore();
		const nowMs = Date.parse("2026-06-01T00:00:00.000Z");
		const now = new Date(nowMs);
		const old = isoFrom(nowMs, 100);

		const expired = storedFact({ id: "fact_expired", validUntil: isoFrom(nowMs, 8), createdAt: old, updatedAt: old });
		const inGrace = storedFact({
			id: "fact_in_grace",
			validUntil: isoFrom(nowMs, 3),
			createdAt: old,
			updatedAt: old,
		});
		const stale = storedFact({
			id: "fact_stale",
			createdAt: old,
			updatedAt: old,
			importance: 2,
			lastRetrievedAt: old,
		});
		const pinned = storedFact({ id: "fact_pinned", createdAt: old, updatedAt: old, importance: 1, pinned: true });
		const important = storedFact({ id: "fact_important", createdAt: old, updatedAt: old, importance: 4 });
		const superseded = storedFact({
			id: "fact_superseded",
			createdAt: old,
			updatedAt: isoFrom(nowMs, 40),
			supersededBy: "fact_other",
		});
		const recent = storedFact({ id: "fact_recent", createdAt: isoFrom(nowMs, 1), updatedAt: isoFrom(nowMs, 1) });
		const archived = storedFact({
			id: "fact_archived",
			createdAt: old,
			updatedAt: old,
			archivedAt: isoFrom(nowMs, 1),
			archiveReason: "manual",
		});
		writeState(store, [expired, inGrace, stale, pinned, important, superseded, recent, archived]);

		expect(store.prune({ now })).toEqual({ archived: 3 });

		expect(store.get("fact_expired")?.archiveReason).toBe("expired");
		expect(store.get("fact_stale")?.archiveReason).toBe("stale");
		expect(store.get("fact_superseded")?.archiveReason).toBe("superseded");
		expect(store.get("fact_in_grace")?.archivedAt).toBeUndefined();
		expect(store.get("fact_pinned")?.archivedAt).toBeUndefined();
		expect(store.get("fact_important")?.archivedAt).toBeUndefined();
		expect(store.get("fact_recent")?.archivedAt).toBeUndefined();
		expect(store.get("fact_archived")?.archiveReason).toBe("manual");
	});

	it("keeps updates from concurrent store instances and releases the lock", () => {
		const agentDir = createAgentDir();
		const first = createStore(agentDir);
		const second = createStore(agentDir);

		first.add(makeDraft("项目使用 pnpm 管理依赖"));
		second.add(makeDraft("周末喜欢徒步旅行"));
		first.add(makeDraft("提交信息使用英文"));

		const facts = createStore(agentDir).read().facts;
		expect(facts.map((fact) => fact.text).sort()).toEqual([
			"周末喜欢徒步旅行",
			"提交信息使用英文",
			"项目使用 pnpm 管理依赖",
		]);
		expect(existsSync(`${first.path}.lock`)).toBe(false);
	});
});
