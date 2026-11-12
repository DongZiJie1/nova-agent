import { describe, expect, it } from "vitest";
import type { Fact, FactSource } from "../../src/core/memory/fact-schema.ts";
import { type FactSelectionContext, scoreFact, selectFacts } from "../../src/core/memory/fact-scoring.ts";
import { estimateMemoryTokens, renderFactLine } from "../../src/core/memory/fact-text.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-10-19T12:00:00.000Z");

let factCounter = 0;

function makeSource(): FactSource {
	factCounter += 1;
	return {
		sessionFile: "/sessions/test.jsonl",
		sessionId: `session_${factCounter}`,
		entryIds: [],
		extractedAt: new Date(NOW).toISOString(),
		model: "provider/model",
	};
}

function isoDaysAgo(days: number): string {
	return new Date(NOW - days * DAY_MS).toISOString();
}

function makeFact(overrides: Partial<Fact> = {}): Fact {
	factCounter += 1;
	const createdAt = new Date(NOW).toISOString();
	return {
		id: `fact_score_${factCounter}`,
		text: `事实 ${factCounter} 使用 tab 缩进`,
		kind: "decision",
		applicability: "universal",
		topics: [],
		importance: 3,
		confidence: 0.8,
		createdAt,
		updatedAt: createdAt,
		retrievalCount: 0,
		pinned: false,
		reviewState: "unreviewed",
		source: makeSource(),
		...overrides,
	};
}

function score(fact: Fact, context: FactSelectionContext = {}): number {
	return scoreFact(fact, { ...context, now: NOW });
}

describe("scoreFact", () => {
	it("scores a fresh fact above a 60 day old fact of the same importance", () => {
		const fresh = makeFact();
		const old = makeFact({ createdAt: isoDaysAgo(60), updatedAt: isoDaysAgo(60) });

		expect(score(fresh)).toBeGreaterThan(score(old));
	});

	it("scores importance 5 above importance 1", () => {
		const high = makeFact({ importance: 5 });
		const low = makeFact({ importance: 1 });

		expect(score(high)).toBeGreaterThan(score(low));
	});

	it("caps usage at 20 retrievals", () => {
		const at20 = makeFact({ retrievalCount: 20 });
		const at100 = makeFact({ retrievalCount: 100 });

		expect(score(at20)).toBe(score(at100));
	});

	it("prefers the current project over universal over another project", () => {
		const sameProject = makeFact({ applicability: "project", projects: ["proj-a"] });
		const universal = makeFact();
		const otherProject = makeFact({ applicability: "project", projects: ["proj-b"] });

		const context: FactSelectionContext = { projectKey: "proj-a" };

		expect(score(sameProject, context)).toBeGreaterThan(score(universal, context));
		expect(score(universal, context)).toBeGreaterThan(score(otherProject, context));
	});

	it("raises the score when topics overlap the current topics", () => {
		const withTopics = makeFact({ topics: ["typescript", "风格"] });
		const related = score(withTopics, { topics: ["typescript"] });
		const unrelated = score(withTopics, { topics: ["数据库"] });
		const noTopics = score(withTopics);

		expect(related).toBeGreaterThan(unrelated);
		expect(related).toBeGreaterThan(noTopics);
	});
});

describe("selectFacts eligibility", () => {
	it("returns an empty array for an empty library", () => {
		expect(selectFacts([], { now: NOW })).toEqual([]);
	});

	it("drops archived, superseded and expired facts", () => {
		const facts = [
			makeFact({ archivedAt: isoDaysAgo(1) }),
			makeFact({ supersededBy: "fact_newer" }),
			makeFact({ validUntil: isoDaysAgo(1) }),
		];

		expect(selectFacts(facts, { now: NOW })).toEqual([]);
	});

	it("gates project facts by the current project by default", () => {
		const ownProject = makeFact({ applicability: "project", projects: ["proj-a"] });
		const otherProject = makeFact({ applicability: "project", projects: ["proj-b"] });

		const gated = selectFacts([ownProject, otherProject], { now: NOW, projectKey: "proj-a" });
		expect(gated.map((entry) => entry.fact.id)).toEqual([ownProject.id]);

		const open = selectFacts([ownProject, otherProject], {
			now: NOW,
			projectKey: "proj-a",
			gateProjectFacts: false,
		});
		expect(open.map((entry) => entry.fact.id)).toContain(otherProject.id);
	});

	it("keeps only universal and same-project facts when crossProjectRecall is false", () => {
		const universal = makeFact();
		const sameOrigin = makeFact({ applicability: "transferable", originProject: { key: "proj-a", path: "/a" } });
		const otherOrigin = makeFact({ applicability: "transferable", originProject: { key: "proj-b", path: "/b" } });

		const selected = selectFacts([universal, sameOrigin, otherOrigin], {
			now: NOW,
			projectKey: "proj-a",
			crossProjectRecall: false,
		});
		const selectedIds = selected.map((entry) => entry.fact.id);

		expect(selectedIds).toContain(universal.id);
		expect(selectedIds).toContain(sameOrigin.id);
		expect(selectedIds).not.toContain(otherOrigin.id);
	});
});

describe("selectFacts ordering and budget", () => {
	it("selects pinned facts first and prioritizes at most 3 of them", () => {
		const pinned = Array.from({ length: 4 }, (_, position) =>
			makeFact({ pinned: true, importance: position === 3 ? 1 : 3, createdAt: isoDaysAgo(120) }),
		);
		const unpinned = makeFact({ importance: 5 });

		const selected = selectFacts([...pinned, unpinned], { now: NOW, maxPromptFacts: 5 });
		const pinnedSelected = selected.filter((entry) => entry.fact.pinned);

		expect(selected.length).toBeGreaterThan(0);
		expect(selected.slice(0, 3).every((entry) => entry.fact.pinned)).toBe(true);
		expect(pinnedSelected.map((entry) => entry.fact.id)).not.toContain(pinned[3].id);

		const limited = selectFacts([...pinned, unpinned], { now: NOW, maxPromptFacts: 3 });
		expect(limited).toHaveLength(3);
		expect(limited.every((entry) => entry.fact.pinned)).toBe(true);
	});

	it("keeps the selected token total within maxPromptTokens", () => {
		const facts = Array.from({ length: 50 }, (_, position) =>
			makeFact({ text: `项目事实 ${position} ${"一".repeat(140)}`, importance: 4 }),
		);

		const selected = selectFacts(facts, { now: NOW, maxPromptTokens: 1000 });
		const totalTokens = selected.reduce((sum, entry) => sum + estimateMemoryTokens(entry.text), 0);

		expect(selected.length).toBeGreaterThan(0);
		expect(selected.length).toBeLessThanOrEqual(12);
		expect(totalTokens).toBeLessThanOrEqual(1000);
	});

	it("caps the number of selected facts at maxPromptFacts", () => {
		const facts = Array.from({ length: 50 }, (_, position) => makeFact({ text: `简短事实 ${position}` }));

		const selected = selectFacts(facts, { now: NOW, maxPromptTokens: 1000 });

		expect(selected).toHaveLength(12);
	});

	it("drops candidates below minScore", () => {
		const stale = makeFact({ importance: 1, createdAt: isoDaysAgo(365), updatedAt: isoDaysAgo(365) });

		expect(selectFacts([stale], { now: NOW })).toEqual([]);
		expect(selectFacts([stale], { now: NOW, minScore: 0.05 })).toHaveLength(1);
	});

	it("counts the budget with the same line renderFactLine produces", () => {
		const fact = makeFact({
			applicability: "transferable",
			originProject: { key: "proj-a", path: "/Users/dev/novas" },
			text: "用户偏好离线可复现的构建方式",
			importance: 4,
		});
		const lineTokens = estimateMemoryTokens(renderFactLine(fact, fact.text));
		const legacyLineTokens = estimateMemoryTokens(
			`- [${fact.id}] ${fact.createdAt.slice(0, 10)} · ${fact.applicability} · ${fact.kind} · imp ${fact.importance} · ${fact.text}`,
		);

		expect(lineTokens).toBeGreaterThan(legacyLineTokens);
		expect(selectFacts([fact], { now: NOW, maxPromptTokens: lineTokens })).toHaveLength(1);
		expect(selectFacts([fact], { now: NOW, maxPromptTokens: lineTokens - 1 })).toEqual([]);
	});

	it("truncates rendered text to maxTextChars", () => {
		const long = makeFact({ text: "甲".repeat(200) });

		const selected = selectFacts([long], { now: NOW, maxTextChars: 20 });

		expect(selected).toHaveLength(1);
		expect(Array.from(selected[0].text).length).toBeLessThanOrEqual(20);
		expect(selected[0].text.endsWith("…")).toBe(true);
		expect(selected[0].fact.text).toHaveLength(200);
	});
});
