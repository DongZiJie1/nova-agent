import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtractionCompletion } from "../../src/core/memory/fact-extraction.ts";
import { computeProjectKey, type Fact } from "../../src/core/memory/fact-schema.ts";
import { selectFacts } from "../../src/core/memory/fact-scoring.ts";
import { type FactDraft, FactStore } from "../../src/core/memory/fact-store.ts";
import {
	deriveProjectTopics,
	type FactQuerySelectionOptions,
	type FactQuerySelectionResult,
	QUERY_SELECTION_MAX_FACTS,
	selectFactsForQuery,
} from "../../src/core/memory/memory-selection.ts";
import { type MemorySettings, resolveMemorySettings } from "../../src/core/memory/memory-settings.ts";

const tempDirs: string[] = [];
let sourceCounter = 0;

afterEach(() => {
	for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

interface Workspace {
	agentDir: string;
	cwd: string;
	store: FactStore;
}

function createWorkspace(): Workspace {
	const root = mkdtempSync(join(tmpdir(), "nova-memory-selection-"));
	tempDirs.push(root);
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(cwd, { recursive: true });
	return { agentDir, cwd, store: new FactStore(agentDir) };
}

function addFact(store: FactStore, text: string, overrides: Partial<FactDraft> = {}): Fact {
	sourceCounter += 1;
	const result = store.add({
		text,
		kind: "preference",
		importance: 3,
		confidence: 0.9,
		applicability: "universal",
		topics: ["style"],
		source: {
			sessionFile: "/sessions/test.jsonl",
			sessionId: `session_${sourceCounter}`,
			entryIds: [],
			extractedAt: new Date().toISOString(),
			model: "provider/model",
		},
		...overrides,
	});
	if (result.action !== "created") throw new Error(`expected created, got ${result.action}`);
	return result.fact;
}

/** 所有文本都命中 `alpha`，用于保证 BM25 预筛能拿到足够候选。 */
function addMatchingFacts(store: FactStore, count: number): Fact[] {
	const facts: Fact[] = [];
	for (let index = 1; index <= count; index += 1) {
		facts.push(addFact(store, `alpha topic${index} detail${index}`));
	}
	return facts;
}

/** 当前项目里的近期事实：用来生成项目主题上下文。 */
const PROJECT_HISTORY_TEXTS = [
	"workspace conventions live in the repository root",
	"build cache is shared across sibling packages",
	"editor settings are committed for the whole team",
	"commit messages follow the package scope",
	"release notes are generated from the change log",
];

function addProjectHistory(store: FactStore, cwd: string, topics: string[], count: number): Fact[] {
	const originProject = { key: computeProjectKey(cwd), path: cwd };
	const facts: Fact[] = [];
	for (let index = 1; index <= count; index += 1) {
		const text = PROJECT_HISTORY_TEXTS[(index - 1) % PROJECT_HISTORY_TEXTS.length];
		facts.push(
			addFact(store, `${text} ${index}`, {
				applicability: "transferable",
				originProject,
				topics,
			}),
		);
	}
	return facts;
}

/** 与选择器同一套打分参数下的期望顺序：证明没有主题上下文时排序不变。 */
function baselineIds(workspace: Workspace, facts: Fact[] = workspace.store.list()): string[] {
	return selectFacts(facts, {
		projectKey: computeProjectKey(workspace.cwd),
		maxPromptFacts: QUERY_SELECTION_MAX_FACTS,
	}).map((entry) => entry.fact.id);
}

const TOPIC_DAY_MS = 24 * 60 * 60 * 1000;
const TOPIC_NOW = Date.parse("2026-10-19T12:00:00.000Z");

function isoFromNow(days: number): string {
	return new Date(TOPIC_NOW + days * TOPIC_DAY_MS).toISOString();
}

/** 纯函数 `deriveProjectTopics` 的输入：不落盘，直接构造 Fact。 */
function makeTopicFact(overrides: Partial<Fact> = {}): Fact {
	sourceCounter += 1;
	return {
		id: `fact_topic_${sourceCounter}`,
		text: "项目约定 fact",
		kind: "decision",
		applicability: "universal",
		topics: [],
		importance: 3,
		confidence: 0.8,
		createdAt: isoFromNow(0),
		updatedAt: isoFromNow(0),
		retrievalCount: 0,
		pinned: false,
		reviewState: "unreviewed",
		source: {
			sessionFile: "/sessions/test.jsonl",
			sessionId: `session_${sourceCounter}`,
			entryIds: [],
			extractedAt: isoFromNow(0),
			model: "provider/model",
		},
		...overrides,
	};
}

type Reply = (input: { systemPrompt: string; userPrompt: string; signal?: AbortSignal }) => Promise<string>;

interface Recorder {
	complete: ExtractionCompletion;
	userPrompts: string[];
	systemPrompts: string[];
	signals: (AbortSignal | undefined)[];
}

function recorder(reply: Reply): Recorder {
	const userPrompts: string[] = [];
	const systemPrompts: string[] = [];
	const signals: (AbortSignal | undefined)[] = [];
	return {
		userPrompts,
		systemPrompts,
		signals,
		complete: async (input) => {
			userPrompts.push(input.userPrompt);
			systemPrompts.push(input.systemPrompt);
			signals.push(input.signal);
			return reply(input);
		},
	};
}

function selectionOptions(
	workspace: Workspace,
	rec: Recorder,
	query: string,
	settings: MemorySettings = {},
	overrides: { signal?: AbortSignal; excludeIds?: ReadonlySet<string> } = {},
): FactQuerySelectionOptions {
	return {
		store: workspace.store,
		query,
		cwd: workspace.cwd,
		settings: resolveMemorySettings(settings),
		complete: rec.complete,
		excludeIds: overrides.excludeIds,
		signal: overrides.signal,
	};
}

function expectScoreFallback(result: FactQuerySelectionResult): void {
	expect(result.source).toBe("score");
	expect(result.facts).toHaveLength(QUERY_SELECTION_MAX_FACTS);
}

describe("selectFactsForQuery local paths", () => {
	it("returns an empty result for an empty library without calling the model", async () => {
		const workspace = createWorkspace();
		const rec = recorder(async () => '{"ids":[]}');

		const result = await selectFactsForQuery(selectionOptions(workspace, rec, "anything"));

		expect(result).toEqual({ facts: [], source: "all" });
		expect(rec.userPrompts).toEqual([]);
	});

	it("returns every active fact when the library holds at most 10", async () => {
		const workspace = createWorkspace();
		const added = [
			addFact(workspace.store, "alpha topic one"),
			addFact(workspace.store, "beta topic two"),
			addFact(workspace.store, "gamma topic three"),
		];
		const rec = recorder(async () => '{"ids":[]}');

		const result = await selectFactsForQuery(selectionOptions(workspace, rec, "alpha"));

		expect(result.source).toBe("all");
		expect(result.facts.map((fact) => fact.id).sort()).toEqual(added.map((fact) => fact.id).sort());
		expect(rec.userPrompts).toEqual([]);
	});

	it("skips the model and scores when selection is score", async () => {
		const workspace = createWorkspace();
		addMatchingFacts(workspace.store, QUERY_SELECTION_MAX_FACTS + 2);
		const rec = recorder(async () => '{"ids":[]}');

		const result = await selectFactsForQuery(
			selectionOptions(workspace, rec, "alpha", { facts: { selection: "score" } }),
		);

		expect(result.source).toBe("score");
		expect(result.facts).toHaveLength(QUERY_SELECTION_MAX_FACTS);
		expect(rec.userPrompts).toEqual([]);
	});

	it("returns empty instead of calling the model when the library only holds archived facts", async () => {
		const workspace = createWorkspace();
		const fact = addFact(workspace.store, "alpha archived fact");
		workspace.store.archive(fact.id, "manual");
		const rec = recorder(async () => '{"ids":[]}');

		const result = await selectFactsForQuery(selectionOptions(workspace, rec, "alpha"));

		expect(result).toEqual({ facts: [], source: "all" });
		expect(rec.userPrompts).toEqual([]);
	});
});

describe("selectFactsForQuery model selection", () => {
	it("returns the model subset in model order with source query", async () => {
		const workspace = createWorkspace();
		const facts = addMatchingFacts(workspace.store, QUERY_SELECTION_MAX_FACTS + 2);
		const wanted = [facts[7], facts[2]];
		const rec = recorder(async () => JSON.stringify({ ids: wanted.map((fact) => fact.id) }));

		const result = await selectFactsForQuery(selectionOptions(workspace, rec, "alpha"));

		expect(result.source).toBe("query");
		expect(result.facts.map((fact) => fact.id)).toEqual(wanted.map((fact) => fact.id));
	});

	it("tolerates a fenced reply, drops unknown ids and dedupes", async () => {
		const workspace = createWorkspace();
		const facts = addMatchingFacts(workspace.store, QUERY_SELECTION_MAX_FACTS + 2);
		const reply = JSON.stringify({ ids: ["fact_unknown", facts[3].id, facts[3].id] });
		const rec = recorder(async () => `\`\`\`json\n${reply}\n\`\`\``);

		const result = await selectFactsForQuery(selectionOptions(workspace, rec, "alpha"));

		expect(result.source).toBe("query");
		expect(result.facts.map((fact) => fact.id)).toEqual([facts[3].id]);
	});

	it("caps the model selection at 10 facts", async () => {
		const workspace = createWorkspace();
		const facts = addMatchingFacts(workspace.store, QUERY_SELECTION_MAX_FACTS + 2);
		const rec = recorder(async () => JSON.stringify({ ids: facts.map((fact) => fact.id) }));

		const result = await selectFactsForQuery(selectionOptions(workspace, rec, "alpha"));

		expect(result.source).toBe("query");
		expect(result.facts.map((fact) => fact.id)).toEqual(
			facts.slice(0, QUERY_SELECTION_MAX_FACTS).map((fact) => fact.id),
		);
	});

	it("keeps only candidate ids when the model returns a mix", async () => {
		const workspace = createWorkspace();
		const facts = addMatchingFacts(workspace.store, QUERY_SELECTION_MAX_FACTS + 2);
		const rec = recorder(async () => JSON.stringify({ ids: ["fact_missing", facts[1].id, facts[5].id] }));

		const result = await selectFactsForQuery(selectionOptions(workspace, rec, "alpha"));

		expect(result.facts.map((fact) => fact.id)).toEqual([facts[1].id, facts[5].id]);
	});
});

describe("selectFactsForQuery fallback", () => {
	it("falls back when the model returns invalid JSON", async () => {
		const workspace = createWorkspace();
		addMatchingFacts(workspace.store, QUERY_SELECTION_MAX_FACTS + 2);

		const result = await selectFactsForQuery(
			selectionOptions(
				workspace,
				recorder(async () => "not json at all"),
				"alpha",
			),
		);

		expectScoreFallback(result);
	});

	it("falls back when every returned id is unknown", async () => {
		const workspace = createWorkspace();
		addMatchingFacts(workspace.store, QUERY_SELECTION_MAX_FACTS + 2);

		const result = await selectFactsForQuery(
			selectionOptions(
				workspace,
				recorder(async () => JSON.stringify({ ids: ["fact_unknown"] })),
				"alpha",
			),
		);

		expectScoreFallback(result);
	});

	it("falls back when the model returns no ids", async () => {
		const workspace = createWorkspace();
		addMatchingFacts(workspace.store, QUERY_SELECTION_MAX_FACTS + 2);

		const result = await selectFactsForQuery(
			selectionOptions(
				workspace,
				recorder(async () => '{"ids":[]}'),
				"alpha",
			),
		);

		expectScoreFallback(result);
	});

	it("falls back when the model call throws", async () => {
		const workspace = createWorkspace();
		addMatchingFacts(workspace.store, QUERY_SELECTION_MAX_FACTS + 2);

		const result = await selectFactsForQuery(
			selectionOptions(
				workspace,
				recorder(async () => {
					throw new Error("provider down");
				}),
				"alpha",
			),
		);

		expectScoreFallback(result);
	});

	it("aborts the request and falls back on timeout", async () => {
		const workspace = createWorkspace();
		addMatchingFacts(workspace.store, QUERY_SELECTION_MAX_FACTS + 2);
		const rec = recorder(
			(input) =>
				new Promise<string>((_, reject) => {
					input.signal?.addEventListener("abort", () => reject(new Error("aborted")));
				}),
		);

		const result = await selectFactsForQuery(
			selectionOptions(workspace, rec, "alpha", { facts: { selectionTimeoutMs: 10 } }),
		);

		expectScoreFallback(result);
		expect(rec.signals[0]?.aborted).toBe(true);
	});

	it("falls back on timeout even when the provider ignores the abort signal", async () => {
		const workspace = createWorkspace();
		addMatchingFacts(workspace.store, QUERY_SELECTION_MAX_FACTS + 2);
		const rec = recorder(() => new Promise<string>(() => {}));

		const result = await selectFactsForQuery(
			selectionOptions(workspace, rec, "alpha", { facts: { selectionTimeoutMs: 10 } }),
		);

		expectScoreFallback(result);
		expect(rec.signals[0]?.aborted).toBe(true);
	});

	it("skips the model when the caller signal is already aborted", async () => {
		const workspace = createWorkspace();
		addMatchingFacts(workspace.store, QUERY_SELECTION_MAX_FACTS + 2);
		const rec = recorder(async () => '{"ids":[]}');
		const controller = new AbortController();
		controller.abort();

		const result = await selectFactsForQuery(
			selectionOptions(workspace, rec, "alpha", {}, { signal: controller.signal }),
		);

		expectScoreFallback(result);
		expect(rec.userPrompts).toEqual([]);
	});
});

describe("selectFactsForQuery candidates and prompt", () => {
	it("caps candidates at selectionCandidates and puts the query and candidate text in the prompt", async () => {
		const workspace = createWorkspace();
		const facts = addMatchingFacts(workspace.store, 40);
		const rec = recorder(async () => '{"ids":[]}');

		await selectFactsForQuery(selectionOptions(workspace, rec, "alpha 模型", { facts: { selectionCandidates: 12 } }));

		expect(rec.userPrompts).toHaveLength(1);
		const prompt = rec.userPrompts[0];
		const promptIds = [...prompt.matchAll(/^- \[(fact_[^\]]+)\]/gm)].map((match) => match[1]);
		expect(promptIds).toHaveLength(12);
		expect(new Set(promptIds).size).toBe(promptIds.length);
		expect(prompt).toContain("User request:\nalpha 模型");
		expect(prompt).toContain("(preference, importance 3)");

		const factsById = new Map(facts.map((fact) => [fact.id, fact]));
		const first = factsById.get(promptIds[0]);
		if (first === undefined) throw new Error("expected a candidate fact");
		expect(prompt).toContain(first.text);
		expect(rec.systemPrompts[0]).toContain('"ids"');
	});

	it("sends candidates in the documented line format", async () => {
		const workspace = createWorkspace();
		const facts = addMatchingFacts(workspace.store, QUERY_SELECTION_MAX_FACTS + 2);
		const rec = recorder(async () => '{"ids":[]}');

		await selectFactsForQuery(selectionOptions(workspace, rec, "alpha"));

		const prompt = rec.userPrompts[0];
		expect(prompt).toContain(`- [${facts[0].id}] (preference, importance 3) ${facts[0].text}`);
	});

	it("uses the full selectionCandidates budget above the 20 hit search cap", async () => {
		const workspace = createWorkspace();
		addMatchingFacts(workspace.store, 40);
		const rec = recorder(async () => '{"ids":[]}');

		await selectFactsForQuery(selectionOptions(workspace, rec, "alpha", { facts: { selectionCandidates: 30 } }));

		const promptIds = [...rec.userPrompts[0].matchAll(/^- \[(fact_[^\]]+)\]/gm)];
		expect(promptIds).toHaveLength(30);
	});

	it("does not exceed the default candidate cap", async () => {
		const workspace = createWorkspace();
		addMatchingFacts(workspace.store, 40);
		const rec = recorder(async () => '{"ids":[]}');

		await selectFactsForQuery(selectionOptions(workspace, rec, "alpha"));

		const promptIds = [...rec.userPrompts[0].matchAll(/^- \[(fact_[^\]]+)\]/gm)];
		expect(promptIds.length).toBeLessThanOrEqual(50);
	});
});

describe("selectFactsForQuery eligibility gating", () => {
	it("hides other projects' project facts from candidates and from the selection", async () => {
		const workspace = createWorkspace();
		const facts = addMatchingFacts(workspace.store, QUERY_SELECTION_MAX_FACTS + 2);
		const foreign = addFact(workspace.store, "alpha other project convention", {
			applicability: "project",
			projects: ["proj_other"],
		});
		const rec = recorder(async () => JSON.stringify({ ids: [foreign.id, facts[0].id] }));

		const result = await selectFactsForQuery(selectionOptions(workspace, rec, "alpha"));

		expect(rec.userPrompts[0]).not.toContain(foreign.id);
		expect(result.source).toBe("query");
		expect(result.facts.map((fact) => fact.id)).toEqual([facts[0].id]);
	});

	it("drops expired facts from candidates and from the selection", async () => {
		const workspace = createWorkspace();
		const facts = addMatchingFacts(workspace.store, QUERY_SELECTION_MAX_FACTS + 2);
		const expired = addFact(workspace.store, "alpha expired convention", {
			validUntil: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
		});
		const rec = recorder(async () => JSON.stringify({ ids: [expired.id, facts[1].id] }));

		const result = await selectFactsForQuery(selectionOptions(workspace, rec, "alpha"));

		expect(rec.userPrompts[0]).not.toContain(expired.id);
		expect(result.facts.map((fact) => fact.id)).toEqual([facts[1].id]);
	});

	it("excludes other projects' transferable facts when crossProjectRecall is false", async () => {
		const workspace = createWorkspace();
		addMatchingFacts(workspace.store, QUERY_SELECTION_MAX_FACTS + 2);
		const ownProject = addFact(workspace.store, "alpha transferable here", {
			applicability: "transferable",
			originProject: { key: computeProjectKey(workspace.cwd), path: workspace.cwd },
		});
		const otherProject = addFact(workspace.store, "alpha transferable elsewhere", {
			applicability: "transferable",
			originProject: { key: "proj_other", path: "/elsewhere" },
		});
		const rec = recorder(async () => JSON.stringify({ ids: [otherProject.id, ownProject.id] }));

		const result = await selectFactsForQuery(
			selectionOptions(workspace, rec, "alpha", { facts: { crossProjectRecall: false } }),
		);

		const prompt = rec.userPrompts[0];
		expect(prompt).not.toContain(otherProject.id);
		expect(prompt).toContain(ownProject.id);
		expect(result.facts.map((fact) => fact.id)).toEqual([ownProject.id]);
	});

	it("leaves gated facts out of the all-facts branch", async () => {
		const workspace = createWorkspace();
		const kept = [addFact(workspace.store, "alpha kept one"), addFact(workspace.store, "alpha kept two")];
		addFact(workspace.store, "alpha other project convention", {
			applicability: "project",
			projects: ["proj_other"],
		});
		const rec = recorder(async () => '{"ids":[]}');

		const result = await selectFactsForQuery(selectionOptions(workspace, rec, "alpha"));

		expect(result.source).toBe("all");
		expect(result.facts.map((fact) => fact.id).sort()).toEqual(kept.map((fact) => fact.id).sort());
		expect(rec.userPrompts).toEqual([]);
	});
});

describe("selectFactsForQuery excludeIds", () => {
	it("drops already injected facts from the all-facts branch", async () => {
		const workspace = createWorkspace();
		const first = addFact(workspace.store, "alpha kept one");
		const second = addFact(workspace.store, "alpha kept two");
		const rec = recorder(async () => '{"ids":[]}');

		const result = await selectFactsForQuery(
			selectionOptions(workspace, rec, "alpha", {}, { excludeIds: new Set([first.id]) }),
		);

		expect(result.source).toBe("all");
		expect(result.facts.map((fact) => fact.id)).toEqual([second.id]);
		expect(rec.userPrompts).toEqual([]);
	});

	it("removes excluded facts from the candidate list and lists their ids in the prompt", async () => {
		const workspace = createWorkspace();
		const excluded = [
			addFact(workspace.store, "alpha excluded preference one"),
			addFact(workspace.store, "alpha excluded preference two"),
		];
		addMatchingFacts(workspace.store, QUERY_SELECTION_MAX_FACTS + 4);
		const excludedIds = new Set(excluded.map((fact) => fact.id));
		const rec = recorder(async (input) => {
			const ids = [...input.userPrompt.matchAll(/^- \[(fact_[^\]]+)\]/gm)].map((match) => match[1]!);
			return JSON.stringify({ ids: ids.slice(0, 1) });
		});

		const result = await selectFactsForQuery(
			selectionOptions(workspace, rec, "alpha", {}, { excludeIds: excludedIds }),
		);

		const prompt = rec.userPrompts[0]!;
		expect(prompt).toContain("Already shown earlier in this session");
		for (const fact of excluded) {
			expect(prompt).toContain(fact.id);
			expect(prompt).not.toMatch(new RegExp(`^- \\[${fact.id}\\]`, "m"));
		}
		expect(result.facts).toHaveLength(1);
		expect(excludedIds.has(result.facts[0]!.id)).toBe(false);
	});

	it("keeps excluded facts out of the score fallback", async () => {
		const workspace = createWorkspace();
		const facts = addMatchingFacts(workspace.store, QUERY_SELECTION_MAX_FACTS + 4);
		const excludedIds = new Set([facts[0]!.id, facts[1]!.id]);
		const rec = recorder(async () => {
			throw new Error("selection model unavailable");
		});

		const result = await selectFactsForQuery(
			selectionOptions(workspace, rec, "alpha", {}, { excludeIds: excludedIds }),
		);

		expect(result.source).toBe("score");
		expect(result.facts).toHaveLength(QUERY_SELECTION_MAX_FACTS);
		for (const fact of result.facts) expect(excludedIds.has(fact.id)).toBe(false);
	});
});

describe("deriveProjectTopics", () => {
	it("returns undefined without active, linked, recent facts", () => {
		const projectKey = "proj_current";
		const old = isoFromNow(-20);
		const facts = [
			makeTopicFact({ topics: ["unlinked"] }),
			makeTopicFact({ topics: ["stale"], projects: [projectKey], createdAt: old, updatedAt: old }),
			makeTopicFact({ topics: ["archived"], projects: [projectKey], archivedAt: isoFromNow(0) }),
		];

		expect(deriveProjectTopics(facts, projectKey, TOPIC_NOW)).toBeUndefined();
	});

	it("ranks linked recent topics by frequency and keeps the top five", () => {
		const projectKey = "proj_current";
		const facts = [
			makeTopicFact({ topics: ["zeta"], projects: [projectKey] }),
			makeTopicFact({ topics: ["zeta"], projects: [projectKey] }),
			makeTopicFact({ topics: ["zeta", "alpha"], projects: [projectKey] }),
			makeTopicFact({ topics: ["beta"], projects: [projectKey] }),
			makeTopicFact({ topics: ["beta"], projects: [projectKey] }),
			makeTopicFact({ topics: ["gamma"], projects: [projectKey] }),
			makeTopicFact({ topics: ["delta"], projects: [projectKey] }),
			makeTopicFact({ topics: ["epsilon"], projects: [projectKey] }),
		];

		expect(deriveProjectTopics(facts, projectKey, TOPIC_NOW)).toEqual(["zeta", "beta", "alpha", "delta", "epsilon"]);
	});

	it("follows the origin project and counts a topic once per fact", () => {
		const projectKey = "proj_current";
		const transferable = makeTopicFact({
			applicability: "transferable",
			originProject: { key: projectKey, path: "/repo/current" },
			topics: ["typescript", "typescript"],
		});

		expect(deriveProjectTopics([transferable], projectKey, TOPIC_NOW)).toEqual(["typescript"]);
	});

	it("counts a fact updated recently even when it was created earlier", () => {
		const projectKey = "proj_current";
		const refreshed = makeTopicFact({
			projects: [projectKey],
			topics: ["refreshed"],
			createdAt: isoFromNow(-20),
			updatedAt: isoFromNow(0),
		});

		expect(deriveProjectTopics([refreshed], projectKey, TOPIC_NOW)).toEqual(["refreshed"]);
	});
});

describe("selectFactsForQuery project topics", () => {
	it("ranks a fact overlapping the project topics above an otherwise equal fact in the score fallback", async () => {
		const workspace = createWorkspace();
		const projectKey = computeProjectKey(workspace.cwd);
		addProjectHistory(workspace.store, workspace.cwd, ["typescript"], 2);
		// unrelated 先入库：没有主题加成时它会凭插入顺序排在 related 前面。
		const unrelated = addFact(workspace.store, "alpha unrelated preference", {
			topics: ["database"],
			importance: 4,
		});
		const related = addFact(workspace.store, "alpha related preference", { topics: ["typescript"], importance: 4 });
		addMatchingFacts(workspace.store, QUERY_SELECTION_MAX_FACTS);
		const rec = recorder(async () => '{"ids":[]}');

		const result = await selectFactsForQuery(selectionOptions(workspace, rec, "alpha"));

		expect(deriveProjectTopics(workspace.store.active(), projectKey)).toEqual(["typescript"]);
		expect(result.source).toBe("score");
		const ids = result.facts.map((fact) => fact.id);
		expect(ids).toContain(related.id);
		expect(ids).toContain(unrelated.id);
		expect(ids.indexOf(related.id)).toBeLessThan(ids.indexOf(unrelated.id));
	});

	it("keeps ordering unchanged when the library holds no project topic history", async () => {
		const workspace = createWorkspace();
		addMatchingFacts(workspace.store, QUERY_SELECTION_MAX_FACTS + 2);
		const rec = recorder(async () => '{"ids":[]}');

		const result = await selectFactsForQuery(selectionOptions(workspace, rec, "alpha"));

		expect(result.source).toBe("score");
		expect(result.facts.map((fact) => fact.id)).toEqual(baselineIds(workspace));
	});

	it("keeps ordering unchanged when project topics do not overlap any candidate", async () => {
		const workspace = createWorkspace();
		const projectKey = computeProjectKey(workspace.cwd);
		// 已过期但仍在 active() 里的事实只贡献项目主题，本身不进候选。
		addFact(workspace.store, "project history expired", {
			applicability: "project",
			projects: [projectKey],
			topics: ["typescript"],
			validUntil: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
		});
		addMatchingFacts(workspace.store, QUERY_SELECTION_MAX_FACTS + 2);
		const rec = recorder(async () => '{"ids":[]}');

		const result = await selectFactsForQuery(selectionOptions(workspace, rec, "alpha"));

		expect(deriveProjectTopics(workspace.store.active(), projectKey)).toEqual(["typescript"]);
		expect(result.source).toBe("score");
		expect(result.facts.map((fact) => fact.id)).toEqual(baselineIds(workspace));
	});

	it("keeps BM25 hits ahead of topic-boosted facts in the candidate list", async () => {
		const workspace = createWorkspace();
		const projectKey = computeProjectKey(workspace.cwd);
		addProjectHistory(workspace.store, workspace.cwd, ["typescript"], 2);
		const bm25Hit = addFact(workspace.store, "zzunique build detail", { topics: ["database"], importance: 2 });
		const topicTop = addFact(workspace.store, "alpha filler preference high", {
			topics: ["typescript"],
			importance: 5,
		});
		for (let index = 1; index <= 11; index += 1) {
			addFact(workspace.store, `alpha filler rule${index} detail${index}`);
		}
		const rec = recorder(async () => '{"ids":[]}');

		await selectFactsForQuery(selectionOptions(workspace, rec, "zzunique"));

		const promptIds = [...rec.userPrompts[0]!.matchAll(/^- \[(fact_[^\]]+)\]/gm)].map((match) => match[1]!);
		expect(promptIds[0]).toBe(bm25Hit.id);
		expect(promptIds).toHaveLength(QUERY_SELECTION_MAX_FACTS);
		// 纯打分（含主题加成）的第一名是 topicTop；候选仍以 BM25 命中打头，说明预筛顺序没被改。
		const scored = selectFacts(workspace.store.list(), {
			projectKey,
			topics: ["typescript"],
			maxPromptFacts: QUERY_SELECTION_MAX_FACTS,
		});
		expect(scored[0]!.fact.id).toBe(topicTop.id);
		expect(promptIds.indexOf(topicTop.id)).toBeGreaterThan(0);
	});
});
