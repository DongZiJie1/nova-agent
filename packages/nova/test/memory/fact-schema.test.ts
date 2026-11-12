import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	computeProjectKey,
	FACT_STATE_VERSION,
	FactStateVersionError,
	isFactApplicability,
	parseFactState,
	projectRefForCwd,
} from "../../src/core/memory/fact-schema.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function createTempDir(): string {
	const directory = mkdtempSync(join(tmpdir(), "nova-fact-schema-"));
	tempDirs.push(directory);
	return directory;
}

function validFact(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: "fact_0192f0c4-0000-7000-8000-000000000000",
		text: "项目使用 tab 缩进，行宽 120",
		kind: "decision",
		applicability: "universal",
		topics: ["indent", "line-width"],
		importance: 4,
		confidence: 0.9,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-02T00:00:00.000Z",
		retrievalCount: 2,
		pinned: false,
		reviewState: "unreviewed",
		source: {
			sessionFile: "/sessions/a.jsonl",
			sessionId: "session-a",
			entryIds: ["entry-1"],
			extractedAt: "2026-01-02T00:00:00.000Z",
			model: "provider/model",
		},
		...overrides,
	};
}

function stateWith(...facts: unknown[]): unknown {
	return { version: FACT_STATE_VERSION, facts };
}

describe("parseFactState", () => {
	it("parses a valid state unchanged", () => {
		const state = parseFactState(stateWith(validFact()));
		expect(state.version).toBe(1);
		expect(state.facts).toHaveLength(1);
		expect(state.facts[0]).toEqual(validFact());
	});

	it("accepts an empty fact list", () => {
		expect(parseFactState(stateWith())).toEqual({ version: 1, facts: [] });
	});

	it("drops invalid entries but keeps valid ones", () => {
		const state = parseFactState(
			stateWith(
				validFact({ id: "fact_keep" }),
				validFact({ id: 42 }),
				validFact({ text: "" }),
				validFact({ createdAt: undefined }),
				validFact({ source: undefined }),
				validFact({ applicability: "sometimes" }),
				validFact({ id: "fact_keep_too", importance: 2 }),
			),
		);
		expect(state.facts.map((fact) => fact.id)).toEqual(["fact_keep", "fact_keep_too"]);
	});

	it("drops non-object entries and tolerates a missing facts array", () => {
		expect(parseFactState(stateWith(null, "fact", [])).facts).toEqual([]);
		expect(parseFactState({ version: FACT_STATE_VERSION }).facts).toEqual([]);
	});

	it("throws for a wrong version or a non-object state", () => {
		expect(() => parseFactState({ version: 2, facts: [] })).toThrow(FactStateVersionError);
		expect(() => parseFactState(null)).toThrow(FactStateVersionError);
		expect(() => parseFactState("state")).toThrow(FactStateVersionError);
	});

	it("clamps importance and confidence into range", () => {
		const [low, high, missing] = parseFactState(
			stateWith(
				validFact({ id: "fact_low", importance: -5, confidence: -0.4 }),
				validFact({ id: "fact_high", importance: 99, confidence: 7 }),
				validFact({ id: "fact_missing", importance: undefined, confidence: undefined }),
			),
		).facts;
		expect([low.importance, low.confidence]).toEqual([1, 0]);
		expect([high.importance, high.confidence]).toEqual([5, 1]);
		expect([missing.importance, missing.confidence]).toEqual([3, 0.5]);
	});

	it("dedupes topics and caps them at three", () => {
		const [fact] = parseFactState(stateWith(validFact({ topics: ["a", "a", " b ", "c", "d"] }))).facts;
		expect(fact.topics).toEqual(["a", "b", "c"]);
	});

	it("drops project-scoped facts without projects", () => {
		const state = parseFactState(
			stateWith(
				validFact({ id: "fact_no_projects", applicability: "project" }),
				validFact({ id: "fact_empty_projects", applicability: "project", projects: [] }),
				validFact({ id: "fact_with_projects", applicability: "project", projects: ["nova"] }),
				validFact({ id: "fact_transferable", applicability: "transferable" }),
			),
		);
		expect(state.facts.map((fact) => fact.id)).toEqual(["fact_with_projects", "fact_transferable"]);
	});

	it("fills defaults for optional fields", () => {
		const [fact] = parseFactState(
			stateWith(validFact({ retrievalCount: undefined, pinned: undefined, reviewState: undefined })),
		).facts;
		expect(fact.retrievalCount).toBe(0);
		expect(fact.pinned).toBe(false);
		expect(fact.reviewState).toBe("unreviewed");
		expect(fact.archivedAt).toBeUndefined();
	});

	it("keeps lifecycle fields that are present and well typed", () => {
		const [fact] = parseFactState(
			stateWith(
				validFact({
					pinned: true,
					archivedAt: "2026-02-01T00:00:00.000Z",
					archiveReason: "superseded",
					supersededBy: "fact_new",
					supersedes: ["fact_old"],
					validUntil: "2026-03-01T00:00:00.000Z",
					originProject: { key: "abcdef123456", path: "/work/nova" },
					reviewState: "promoted",
					promotedToSectionId: "section-1",
				}),
			),
		).facts;
		expect(fact.archivedAt).toBe("2026-02-01T00:00:00.000Z");
		expect(fact.archiveReason).toBe("superseded");
		expect(fact.supersededBy).toBe("fact_new");
		expect(fact.supersedes).toEqual(["fact_old"]);
		expect(fact.originProject).toEqual({ key: "abcdef123456", path: "/work/nova" });
		expect(fact.reviewState).toBe("promoted");
		expect(fact.promotedToSectionId).toBe("section-1");
	});

	it("drops invalid archive reasons and review states instead of failing", () => {
		const [fact] = parseFactState(stateWith(validFact({ archiveReason: "because", reviewState: "unknown" }))).facts;
		expect(fact.archiveReason).toBeUndefined();
		expect(fact.reviewState).toBe("unreviewed");
	});
});

describe("isFactApplicability", () => {
	it("accepts only the three applicability values", () => {
		expect(isFactApplicability("universal")).toBe(true);
		expect(isFactApplicability("transferable")).toBe(true);
		expect(isFactApplicability("project")).toBe(true);
		expect(isFactApplicability("global")).toBe(false);
		expect(isFactApplicability(undefined)).toBe(false);
		expect(isFactApplicability(1)).toBe(false);
	});
});

describe("computeProjectKey", () => {
	it("is stable for the same path and 12 hex characters long", () => {
		const directory = createTempDir();
		const key = computeProjectKey(directory);
		expect(key).toBe(computeProjectKey(directory));
		expect(key).toMatch(/^[0-9a-f]{12}$/);
	});

	it("differs for different paths", () => {
		expect(computeProjectKey(createTempDir())).not.toBe(computeProjectKey(createTempDir()));
	});

	it("falls back to a resolved path when the directory does not exist", () => {
		const missing = join(tmpdir(), "nova-fact-schema-missing-directory");
		expect(computeProjectKey(missing)).toMatch(/^[0-9a-f]{12}$/);
	});
});

describe("projectRefForCwd", () => {
	it("returns a key and the canonical path", () => {
		const directory = createTempDir();
		const ref = projectRefForCwd(directory);
		expect(ref.key).toBe(computeProjectKey(directory));
		expect(ref.path.endsWith(directory.replace(/^.*\//, ""))).toBe(true);
	});
});
