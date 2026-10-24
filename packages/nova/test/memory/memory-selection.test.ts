import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtractionCompletion } from "../../src/core/memory/fact-extraction.ts";
import { computeProjectKey, type Fact } from "../../src/core/memory/fact-schema.ts";
import { type FactDraft, FactStore } from "../../src/core/memory/fact-store.ts";
import {
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
	overrides: { signal?: AbortSignal } = {},
): FactQuerySelectionOptions {
	return {
		store: workspace.store,
		query,
		cwd: workspace.cwd,
		settings: resolveMemorySettings(settings),
		complete: rec.complete,
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
