import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Fact, FactKind, FactSource } from "../../src/core/memory/fact-schema.ts";
import {
	type AddFactResult,
	type FactDraft,
	FactStore,
	FactStoreVersionError,
	SensitiveFactError,
	type UpdateFactResult,
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

function updatedFact(result: UpdateFactResult): Fact {
	if (result.action !== "updated") throw new Error(`expected updated, got ${result.action}`);
	return result.fact;
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
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

describe("FactStore update", () => {
	it("rewrites the text in place, advances updatedAt, and keeps the original identity", async () => {
		const agentDir = createAgentDir();
		const store = createStore(agentDir);
		const before = createdFact(
			store.add(makeDraft("项目使用 pnpm 管理依赖", { kind: "decision", importance: 2, topics: ["tooling"] })),
		);
		store.setPinned(before.id, true);
		store.recordRetrieval([before.id]);
		await delay(5);

		const result = store.update(before.id, { text: "  项目统一使用   pnpm 管理依赖  " });

		const after = updatedFact(result);
		expect(after.text).toBe("项目统一使用 pnpm 管理依赖");
		expect(after.id).toBe(before.id);
		expect(after.createdAt).toBe(before.createdAt);
		expect(after.updatedAt > before.updatedAt).toBe(true);
		expect(after.source).toEqual(before.source);
		expect(after.pinned).toBe(true);
		expect(after.retrievalCount).toBe(1);
		expect(after.kind).toBe("decision");
		expect(after.importance).toBe(2);
		expect(after.topics).toEqual(["tooling"]);

		const reloaded = createStore(agentDir).read().facts;
		expect(reloaded).toHaveLength(1);
		expect(reloaded[0]?.text).toBe("项目统一使用 pnpm 管理依赖");
		expect(reloaded[0]?.text).not.toBe("项目使用 pnpm 管理依赖");
	});

	it("hashes the new text so the old text no longer dedupes but the new one does", () => {
		const store = createStore();
		const fact = createdFact(store.add(makeDraft("项目使用 pnpm 管理依赖")));

		store.update(fact.id, { text: "项目统一使用 pnpm 管理依赖" });

		// 旧文本已不在库里，重新加入会创建新事实而不是命中旧条目。
		const oldText = store.add(makeDraft("项目使用 pnpm 管理依赖"));
		expect(oldText.action).toBe("created");

		const newText = store.add(makeDraft("项目统一使用 pnpm 管理依赖"));
		expect(newText.action).toBe("duplicate");
		expect(resultFact(newText).id).toBe(fact.id);
	});

	it("reports a duplicate when the new text already exists on another active fact", () => {
		const store = createStore();
		const first = createdFact(store.add(makeDraft("提交信息用英文")));
		const second = createdFact(store.add(makeDraft("文档目录放在 docs 下")));

		const result = store.update(second.id, { text: "  提交信息用英文 " });

		expect(result.action).toBe("duplicate");
		if (result.action !== "duplicate") throw new Error("expected duplicate");
		expect(result.fact.id).toBe(first.id);
		expect(store.get(second.id)?.text).toBe("文档目录放在 docs 下");
	});

	it("ignores the edited fact itself when the text is unchanged", () => {
		const store = createStore();
		const fact = createdFact(store.add(makeDraft("提交信息用英文")));

		const result = store.update(fact.id, { text: "提交信息用英文" });

		expect(result.action).toBe("updated");
		expect(updatedFact(result).id).toBe(fact.id);
		expect(store.active()).toHaveLength(1);
	});

	it("reports a conflict for contradicting text instead of overwriting", () => {
		const store = createStore();
		const first = createdFact(store.add(makeDraft("项目使用 tab 缩进")));
		const second = createdFact(store.add(makeDraft("文档目录放在 docs 下")));

		const result = store.update(second.id, { text: "项目不再使用 tab 缩进" });

		expect(result.action).toBe("conflict");
		if (result.action !== "conflict") throw new Error("expected conflict");
		expect(result.candidates.map((candidate) => candidate.id)).toEqual([first.id]);
		expect(store.get(second.id)?.text).toBe("文档目录放在 docs 下");
		expect(store.get(first.id)?.text).toBe("项目使用 tab 缩进");
	});

	it("reports a conflict for near-identical text instead of merging into the other fact", () => {
		const store = createStore();
		const first = createdFact(store.add(makeDraft("项目使用 tab 缩进并且行宽为 120")));
		const second = createdFact(store.add(makeDraft("提交信息用英文")));

		const result = store.update(second.id, { text: "项目使用 tab 缩进并且行宽为 120 字符" });

		expect(result.action).toBe("conflict");
		if (result.action !== "conflict") throw new Error("expected conflict");
		expect(result.candidates.map((candidate) => candidate.id)).toEqual([first.id]);
		expect(store.get(first.id)?.text).toBe("项目使用 tab 缩进并且行宽为 120");
		expect(store.get(second.id)?.text).toBe("提交信息用英文");
	});

	it("rejects sensitive, empty, and overlong replacement text", () => {
		const store = createStore();
		const fact = createdFact(store.add(makeDraft("提交信息用英文")));

		expect(() => store.update(fact.id, { text: "My api key is sk_abcdefghijklmnopqrstuvwx" })).toThrow(
			SensitiveFactError,
		);
		expect(() => store.update(fact.id, { text: "   " })).toThrow(/must not be empty/);
		expect(() => store.update(fact.id, { text: "a".repeat(201) })).toThrow(/at most 200/);
		expect(store.get(fact.id)?.text).toBe("提交信息用英文");
	});

	it("validates kind and importance", () => {
		const store = createStore();
		const fact = createdFact(store.add(makeDraft("提交信息用英文")));

		expect(() => store.update(fact.id, { kind: "bogus" as unknown as FactKind })).toThrow(/Unknown fact kind/);
		expect(() => store.update(fact.id, { importance: 0 })).toThrow(/between 1 and 5/);
		expect(() => store.update(fact.id, { importance: 6 })).toThrow(/between 1 and 5/);
		expect(store.get(fact.id)?.importance).toBe(3);
	});

	it("deduplicates topics and keeps at most three", () => {
		const store = createStore();
		const fact = createdFact(store.add(makeDraft("提交信息用英文")));

		const result = store.update(fact.id, { topics: ["style", "style", " ", "docs", "git", "ci"] });

		expect(updatedFact(result).topics).toEqual(["style", "docs", "git"]);
	});

	it("keeps the review state on non-text edits and resets it on text edits", () => {
		const store = createStore();
		const fact = createdFact(store.add(makeDraft("提交信息用英文")));
		store.setReviewState(fact.id, "kept");

		store.update(fact.id, { importance: 5 });
		expect(store.get(fact.id)?.reviewState).toBe("kept");

		store.update(fact.id, { text: "提交信息统一用英文" });
		expect(store.get(fact.id)?.reviewState).toBe("unreviewed");
	});

	it("requires project links before switching applicability to project", () => {
		const store = createStore();
		const universal = createdFact(store.add(makeDraft("部署到 staging 环境")));
		const scoped = createdFact(
			store.add(makeDraft("部署到 production 环境", { applicability: "project", projects: ["proj-a"] })),
		);

		expect(() => store.update(universal.id, { applicability: "project" })).toThrow(/project key/);
		expect(store.get(universal.id)?.applicability).toBe("universal");

		const switched = updatedFact(store.update(scoped.id, { applicability: "universal" }));
		expect(switched.applicability).toBe("universal");
		// 项目关联保留，门控只看 applicability。
		expect(switched.projects).toEqual(["proj-a"]);
	});

	it("preserves supersedes links and can set an expiry", () => {
		const store = createStore();
		const previous = createdFact(store.add(makeDraft("项目使用 yarn 管理依赖")));
		const replacement = createdFact(store.add(makeDraft("项目使用 pnpm 管理依赖", { supersedes: [previous.id] })));
		const validUntil = "2026-12-31T00:00:00.000Z";

		const result = store.update(replacement.id, { text: "项目统一使用 pnpm 管理依赖", validUntil });

		const updated = updatedFact(result);
		expect(updated.supersedes).toEqual([previous.id]);
		expect(updated.validUntil).toBe(validUntil);
		expect(store.get(previous.id)?.supersededBy).toBe(replacement.id);
	});

	it("rejects an unknown id and an invalid expiry", () => {
		const store = createStore();
		const fact = createdFact(store.add(makeDraft("提交信息用英文")));

		expect(() => store.update("fact_missing", { importance: 4 })).toThrow(/Fact not found: fact_missing/);
		expect(() => store.update(fact.id, { validUntil: "not-a-date" })).toThrow(/Invalid validUntil/);
	});
});
