import { describe, expect, it } from "vitest";
import { FactIndex, type FactSearchHit } from "../../src/core/memory/fact-index.ts";
import type { Fact, FactSource } from "../../src/core/memory/fact-schema.ts";

let factCounter = 0;

function makeSource(): FactSource {
	factCounter += 1;
	return {
		sessionFile: "/sessions/test.jsonl",
		sessionId: `session_${factCounter}`,
		entryIds: [],
		extractedAt: "2026-10-19T00:00:00.000Z",
		model: "provider/model",
	};
}

function makeFact(overrides: Partial<Fact> = {}): Fact {
	factCounter += 1;
	const now = "2026-10-19T00:00:00.000Z";
	return {
		id: `fact_index_${factCounter}`,
		text: `事实 ${factCounter}`,
		kind: "decision",
		applicability: "universal",
		topics: [],
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

function ids(hits: FactSearchHit[]): string[] {
	return hits.map((hit) => hit.fact.id);
}

describe("FactIndex search", () => {
	it("matches a Chinese bigram query", () => {
		const target = makeFact({ text: "决定明年换车，预算 30 万" });
		const other = makeFact({ text: "项目使用 tab 缩进，行宽 120" });
		const index = new FactIndex([target, other]);

		const hits = index.search("换车");

		expect(ids(hits)).toEqual([target.id]);
		expect(hits[0].score).toBeGreaterThan(0);
	});

	it("matches a mixed Chinese and ASCII query", () => {
		const target = makeFact({ text: "把默认模型换成 gpt-4" });
		const other = makeFact({ text: "提交前运行 biome 格式化" });
		const index = new FactIndex([target, other]);

		const hits = index.search("gpt-4 模型");

		expect(ids(hits)).toEqual([target.id]);
	});

	it("returns an empty array for an empty or blank query", () => {
		const index = new FactIndex([makeFact({ text: "决定明年换车" })]);

		expect(index.search("")).toEqual([]);
		expect(index.search("   ")).toEqual([]);
		expect(index.search("\n\t ")).toEqual([]);
	});

	it("excludes archived and superseded facts unless includeArchived is set", () => {
		const active = makeFact({ text: "换车预算 30 万" });
		const archived = makeFact({ text: "换车预算 20 万", archivedAt: "2026-10-18T00:00:00.000Z" });
		const superseded = makeFact({ text: "换车预算 25 万", supersededBy: "fact_newer" });
		const index = new FactIndex([active, archived, superseded]);

		const visible = ids(index.search("换车"));
		expect(visible).toContain(active.id);
		expect(visible).not.toContain(archived.id);
		expect(visible).not.toContain(superseded.id);

		const all = ids(index.search("换车", { includeArchived: true }));
		expect(all).toContain(active.id);
		expect(all).toContain(archived.id);
		expect(all).toContain(superseded.id);
	});

	it("orders equal scores by updatedAt descending", () => {
		const older = makeFact({ text: "使用 tab 缩进", updatedAt: "2026-10-01T00:00:00.000Z" });
		const newer = makeFact({ text: "使用 tab 缩进", updatedAt: "2026-10-10T00:00:00.000Z" });
		const index = new FactIndex([older, newer]);

		const hits = index.search("tab");

		expect(hits).toHaveLength(2);
		expect(hits[0].score).toBe(hits[1].score);
		expect(hits.map((hit) => hit.fact.id)).toEqual([newer.id, older.id]);
	});

	it("caps the limit at 20 and defaults to 8", () => {
		const facts = Array.from({ length: 25 }, (_, position) => makeFact({ text: `索引压力测试 ${position}` }));
		const index = new FactIndex(facts);

		expect(index.search("索引")).toHaveLength(8);
		expect(index.search("索引", { limit: 50 })).toHaveLength(20);
		expect(index.search("索引", { limit: 3 })).toHaveLength(3);
	});

	it("filters by kind", () => {
		const decision = makeFact({ text: "决定换车", kind: "decision" });
		const preference = makeFact({ text: "偏好换车", kind: "preference" });
		const index = new FactIndex([decision, preference]);

		expect(ids(index.search("换车", { kinds: ["preference"] }))).toEqual([preference.id]);
		expect(ids(index.search("换车", { kinds: [] }))).toHaveLength(2);
	});

	it("filters by creation date", () => {
		const older = makeFact({ text: "旧换车计划", createdAt: "2026-01-01T00:00:00.000Z" });
		const newer = makeFact({ text: "新换车计划", createdAt: "2026-06-01T00:00:00.000Z" });
		const index = new FactIndex([older, newer]);

		const hits = ids(index.search("换车", { since: "2026-03-01T00:00:00.000Z" }));

		expect(hits).toEqual([newer.id]);
	});

	it("ignores facts that share no tokens with the query", () => {
		const target = makeFact({ text: "决定明年换车" });
		const unrelated = makeFact({ text: "数据库迁移窗口" });
		const index = new FactIndex([target, unrelated]);

		expect(ids(index.search("换车"))).toEqual([target.id]);
	});
});
