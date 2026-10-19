import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtractionCompletion } from "../../src/core/memory/fact-extraction.ts";
import type { Fact } from "../../src/core/memory/fact-schema.ts";
import { type FactDraft, FactStore } from "../../src/core/memory/fact-store.ts";
import { type ReviewOptions, resolveSuggestion, reviewFacts } from "../../src/core/memory/memory-review.ts";
import { runExtraction } from "../../src/core/memory/memory-service.ts";
import { type MemorySettings, resolveMemorySettings } from "../../src/core/memory/memory-settings.ts";
import { SuggestionStore } from "../../src/core/memory/suggestion-store.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { UserMemoryStore } from "../../src/core/user-memory.ts";
import { handleMemoryCommand } from "../../src/memory-cli.ts";

const PROFILE_TEXT = "提交信息用英文，代码注释用中文";

const tempDirs: string[] = [];

afterEach(() => {
	for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
	vi.restoreAllMocks();
});

interface Workspace {
	root: string;
	agentDir: string;
	cwd: string;
	store: FactStore;
	suggestions: SuggestionStore;
}

function workspace(): Workspace {
	const root = mkdtempSync(join(tmpdir(), "nova-memory-review-"));
	tempDirs.push(root);
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(cwd, { recursive: true });
	return { root, agentDir, cwd, store: new FactStore(agentDir), suggestions: new SuggestionStore(agentDir) };
}

let sourceCounter = 0;

function makeSource(overrides: Partial<FactDraft["source"]> = {}): FactDraft["source"] {
	sourceCounter += 1;
	return {
		sessionFile: "/sessions/test.jsonl",
		sessionId: "session_a",
		entryIds: [`entry_${sourceCounter}`],
		extractedAt: new Date().toISOString(),
		model: "provider/model",
		...overrides,
	};
}

function addFact(ws: Workspace, text: string, overrides: Partial<FactDraft> = {}): Fact {
	const result = ws.store.add({
		text,
		kind: "preference",
		importance: 4,
		confidence: 0.9,
		applicability: "universal",
		topics: ["style"],
		source: makeSource(),
		...overrides,
	});
	if (result.action !== "created") throw new Error(`expected created, got ${result.action}`);
	return result.fact;
}

interface Recorder {
	complete: ExtractionCompletion;
	prompts: string[];
	systemPrompts: string[];
}

function completionReturning(reply: string): Recorder {
	const prompts: string[] = [];
	const systemPrompts: string[] = [];
	return {
		prompts,
		systemPrompts,
		complete: async (input) => {
			prompts.push(input.userPrompt);
			systemPrompts.push(input.systemPrompt);
			return reply;
		},
	};
}

function suggestionReply(suggestions: unknown[]): string {
	return JSON.stringify({ suggestions });
}

function createSuggestion(factIds: string[], overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		action: "create",
		title: "协作偏好",
		proposedContent: PROFILE_TEXT,
		reason: "多次出现的稳定偏好",
		factIds,
		...overrides,
	};
}

function reviewOptions(
	ws: Workspace,
	complete: ExtractionCompletion,
	overrides: {
		settings?: MemorySettings;
		scope?: ReviewOptions["scope"];
		skipExplicitExemption?: boolean;
		signal?: AbortSignal;
	} = {},
): ReviewOptions {
	return {
		agentDir: ws.agentDir,
		cwd: ws.cwd,
		settings: resolveMemorySettings(overrides.settings),
		store: ws.store,
		suggestions: ws.suggestions,
		complete,
		scope: overrides.scope ?? { type: "session", sessionId: "session_a" },
		skipExplicitExemption: overrides.skipExplicitExemption,
		signal: overrides.signal,
	};
}

function appendUser(manager: SessionManager, text: string): string {
	return manager.appendMessage({ role: "user", content: text, timestamp: Date.now() });
}

function appendAssistant(manager: SessionManager, text: string): string {
	return manager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	});
}

const DISTINCT_TEXTS = [
	"Team prefers tabs for indentation in source files",
	"Release cadence ships every two weeks on Thursday",
	"Avoid force pushing to shared branches",
	"Commit messages use English across all projects",
	"Tests run with the vitest runner from the package root",
	"Dependencies stay pinned to exact versions",
	"Documentation lives under the package docs directory",
	"Biome enforces tabs and a line width of one hundred twenty",
	"Lockfile changes require explicit review",
	"Every store write is atomic through a temporary file",
	"Session files append markers and never rewrite old entries",
	"Facts dedupe by a normalized text hash before insert",
];

describe("reviewFacts candidate selection", () => {
	it("does not call the model when no fact is a candidate", async () => {
		const ws = workspace();
		const fact = addFact(ws, "Team prefers tabs for indentation", { importance: 3 });
		const recorder = completionReturning(suggestionReply([]));

		const result = await reviewFacts(reviewOptions(ws, recorder.complete));

		expect(result).toEqual({ candidates: 0, created: 0, kept: 0, failed: 0 });
		expect(recorder.prompts).toHaveLength(0);
		expect(ws.store.get(fact.id)?.reviewState).toBe("unreviewed");
	});

	it("limits a session-scope review to facts from that session", async () => {
		const ws = workspace();
		addFact(ws, "Team prefers tabs for indentation");
		addFact(ws, "Release notes must list breaking changes", {
			source: makeSource({ sessionId: "session_b" }),
		});
		const recorder = completionReturning(suggestionReply([]));

		const result = await reviewFacts(reviewOptions(ws, recorder.complete));

		expect(result.candidates).toBe(1);
		expect(recorder.prompts).toHaveLength(1);
		expect(recorder.prompts[0]).toContain("Team prefers tabs for indentation");
		expect(recorder.prompts[0]).not.toContain("Release notes must list breaking changes");
	});

	it("reviews explicit low-importance facts unless the caller skips the exemption", async () => {
		const ws = workspace();
		const fact = addFact(ws, "User explicitly asked to remember the release checklist", {
			importance: 3,
			source: makeSource({ model: "explicit" }),
		});
		const recorder = completionReturning(suggestionReply([]));

		const reviewed = await reviewFacts(reviewOptions(ws, recorder.complete));

		expect(reviewed.candidates).toBe(1);
		expect(recorder.prompts[0]).toContain("release checklist");
		expect(ws.store.get(fact.id)?.reviewState).toBe("kept");
	});

	it("skips explicit low-importance facts for background extraction", async () => {
		const ws = workspace();
		addFact(ws, "User explicitly asked to remember the release checklist", {
			importance: 3,
			source: makeSource({ model: "explicit" }),
		});
		const recorder = completionReturning(suggestionReply([]));

		const result = await reviewFacts(reviewOptions(ws, recorder.complete, { skipExplicitExemption: true }));

		expect(result.candidates).toBe(0);
		expect(recorder.prompts).toHaveLength(0);
	});

	it("sends at most ten candidates, highest importance first", async () => {
		const ws = workspace();
		for (let index = 0; index < DISTINCT_TEXTS.length; index++) {
			addFact(ws, DISTINCT_TEXTS[index], { importance: index < 2 ? 5 : 4 });
		}
		const recorder = completionReturning(suggestionReply([]));

		const result = await reviewFacts(reviewOptions(ws, recorder.complete));

		expect(result.candidates).toBe(10);
		expect(recorder.prompts).toHaveLength(1);
		expect(recorder.prompts[0].match(/- \[fact_/g)).toHaveLength(10);
	});
});

describe("reviewFacts suggestions", () => {
	it("stores a create suggestion, marks referenced facts suggested, and keeps the rest", async () => {
		const ws = workspace();
		const first = addFact(ws, "Team prefers tabs for indentation");
		const second = addFact(ws, "Release notes must list breaking changes");
		const recorder = completionReturning(suggestionReply([createSuggestion([first.id])]));

		const result = await reviewFacts(reviewOptions(ws, recorder.complete));

		expect(result).toEqual({ candidates: 2, created: 1, kept: 1, failed: 0 });
		const pending = ws.suggestions.list("pending");
		expect(pending).toHaveLength(1);
		expect(pending[0].action).toBe("create");
		expect(pending[0].factIds).toEqual([first.id]);
		expect(ws.store.get(first.id)?.reviewState).toBe("suggested");
		expect(ws.store.get(second.id)?.reviewState).toBe("kept");
		expect(recorder.systemPrompts[0]).toContain("JSON");

		// 事实已经评审过，下一次不会再送模型，也不会重复建议。
		const again = completionReturning(suggestionReply([createSuggestion([first.id])]));
		const secondReview = await reviewFacts(reviewOptions(ws, again.complete));
		expect(secondReview.candidates).toBe(0);
		expect(again.prompts).toHaveLength(0);
		expect(ws.suggestions.list()).toHaveLength(1);
	});

	it("stores append and update suggestions with the previous content", async () => {
		const ws = workspace();
		const memory = new UserMemoryStore(ws.agentDir);
		const style = memory.upsertSection(undefined, "代码风格", "项目使用 Tab 缩进");
		const workflow = memory.upsertSection(undefined, "协作流程", "提交流程：先跑测试再提交");
		const first = addFact(ws, "Team prefers tabs for indentation");
		const second = addFact(ws, "Release notes must list breaking changes");
		const recorder = completionReturning(
			suggestionReply([
				{
					action: "append",
					targetSectionId: style.id,
					title: "代码风格",
					proposedContent: "行宽 120",
					factIds: [first.id],
				},
				{
					action: "update",
					targetSectionId: workflow.id,
					title: "协作流程",
					proposedContent: "提交前必须跑全量测试",
					factIds: [second.id],
				},
			]),
		);

		const result = await reviewFacts(reviewOptions(ws, recorder.complete));

		expect(result.created).toBe(2);
		const suggestions = ws.suggestions.list("pending");
		expect(suggestions.map((suggestion) => suggestion.action)).toEqual(["append", "update"]);
		expect(suggestions[0].targetSectionId).toBe(style.id);
		expect(suggestions[0].previousContent).toBe(style.content);
		expect(suggestions[1].targetSectionId).toBe(workflow.id);
		expect(suggestions[1].previousContent).toBe(workflow.content);
		expect(recorder.prompts[0]).toContain(style.id);
		expect(recorder.prompts[0]).toContain(workflow.id);
	});

	it("drops invalid suggestions and keeps the candidates for a later review", async () => {
		const ws = workspace();
		const first = addFact(ws, "Team prefers tabs for indentation");
		const second = addFact(ws, "Release notes must list breaking changes");
		const recorder = completionReturning(
			suggestionReply([
				createSuggestion(["fact_unknown"]),
				createSuggestion([first.id], { targetSectionId: undefined, action: "append" }),
				createSuggestion([first.id], { action: "update", targetSectionId: "section_missing" }),
				createSuggestion([first.id], { title: "   " }),
				createSuggestion([first.id], { title: "长".repeat(81) }),
				createSuggestion([first.id], { proposedContent: "内".repeat(4001) }),
				createSuggestion([]),
				createSuggestion([first.id], { action: "delete" }),
			]),
		);

		const result = await reviewFacts(reviewOptions(ws, recorder.complete));

		expect(result).toEqual({ candidates: 2, created: 0, kept: 2, failed: 0 });
		expect(ws.suggestions.list()).toHaveLength(0);
		expect(ws.store.get(first.id)?.reviewState).toBe("kept");
		expect(ws.store.get(second.id)?.reviewState).toBe("kept");
	});

	it("applies suggestions immediately when promotion.auto is true", async () => {
		const ws = workspace();
		const fact = addFact(ws, "Team prefers tabs for indentation");
		const recorder = completionReturning(suggestionReply([createSuggestion([fact.id])]));

		const result = await reviewFacts(
			reviewOptions(ws, recorder.complete, { settings: { facts: { promotion: { auto: true } } } }),
		);

		expect(result.created).toBe(1);
		const sections = new UserMemoryStore(ws.agentDir).list();
		expect(sections).toHaveLength(1);
		expect(sections[0].content).toContain(PROFILE_TEXT);
		const stored = ws.store.get(fact.id);
		expect(stored?.reviewState).toBe("promoted");
		expect(stored?.archivedAt).toBeDefined();
		expect(stored?.archiveReason).toBe("promoted");
		expect(stored?.promotedToSectionId).toBe(sections[0].id);
		const suggestion = ws.suggestions.list()[0];
		expect(suggestion.status).toBe("accepted");
		expect(suggestion.appliedSectionId).toBe(sections[0].id);
	});
});

describe("resolveSuggestion", () => {
	async function pendingSuggestion(ws: Workspace): Promise<{ fact: Fact; suggestionId: string }> {
		const fact = addFact(ws, "Team prefers tabs for indentation");
		await reviewFacts(
			reviewOptions(ws, completionReturning(suggestionReply([createSuggestion([fact.id])])).complete),
		);
		return { fact, suggestionId: ws.suggestions.list("pending")[0].id };
	}

	it("writes the profile, archives the facts, and is idempotent", async () => {
		const ws = workspace();
		const { fact, suggestionId } = await pendingSuggestion(ws);

		const first = resolveSuggestion({ agentDir: ws.agentDir, suggestionId, action: "accept" });
		const second = resolveSuggestion({ agentDir: ws.agentDir, suggestionId, action: "accept" });

		expect(first.sectionId).toBeDefined();
		expect(second.sectionId).toBe(first.sectionId);
		const sections = new UserMemoryStore(ws.agentDir).list();
		expect(sections).toHaveLength(1);
		expect(sections[0].content).toContain(PROFILE_TEXT);
		expect(ws.store.get(fact.id)?.archivedAt).toBeDefined();
		expect(ws.store.get(fact.id)?.archiveReason).toBe("promoted");
		expect(ws.suggestions.get(suggestionId)?.status).toBe("accepted");
		expect(ws.suggestions.get(suggestionId)?.appliedSectionId).toBe(first.sectionId);
	});

	it("keeps the facts and is idempotent when rejecting", async () => {
		const ws = workspace();
		const { fact, suggestionId } = await pendingSuggestion(ws);

		expect(() => resolveSuggestion({ agentDir: ws.agentDir, suggestionId, action: "reject" })).not.toThrow();
		expect(() => resolveSuggestion({ agentDir: ws.agentDir, suggestionId, action: "reject" })).not.toThrow();

		expect(ws.store.get(fact.id)?.archivedAt).toBeUndefined();
		expect(ws.store.get(fact.id)?.reviewState).toBe("kept");
		expect(ws.suggestions.get(suggestionId)?.status).toBe("rejected");
		expect(new UserMemoryStore(ws.agentDir).list()).toHaveLength(0);
	});

	it("refuses to accept an already rejected suggestion", async () => {
		const ws = workspace();
		const { suggestionId } = await pendingSuggestion(ws);
		resolveSuggestion({ agentDir: ws.agentDir, suggestionId, action: "reject" });

		expect(() => resolveSuggestion({ agentDir: ws.agentDir, suggestionId, action: "accept" })).toThrow(
			/already rejected/,
		);
	});
});

describe("nova memory suggestion commands", () => {
	async function runMemory(ws: Workspace, args: string[]): Promise<{ lines: string[]; text: string }> {
		const lines: string[] = [];
		const handled = await handleMemoryCommand(["memory", ...args], {
			agentDir: ws.agentDir,
			cwd: ws.cwd,
			output: (line) => lines.push(line),
		});
		expect(handled).toBe(true);
		return { lines, text: lines.join("\n") };
	}

	it("lists pending suggestions as JSON and promotes one", async () => {
		const ws = workspace();
		const fact = addFact(ws, "Team prefers tabs for indentation");
		await reviewFacts(
			reviewOptions(ws, completionReturning(suggestionReply([createSuggestion([fact.id])])).complete),
		);
		const suggestion = ws.suggestions.list("pending")[0];

		const listed = await runMemory(ws, ["suggestions", "--json"]);
		expect(listed.lines).toHaveLength(1);
		const payload = JSON.parse(listed.lines[0]) as { suggestions: Array<Record<string, unknown>> };
		expect(payload.suggestions).toHaveLength(1);
		expect(payload.suggestions[0].id).toBe(suggestion.id);
		expect(payload.suggestions[0].action).toBe("create");
		expect(payload.suggestions[0].factIds).toEqual([fact.id]);

		const promoted = await runMemory(ws, ["promote", suggestion.id]);
		expect(promoted.text).toContain("Promoted");
		expect(promoted.text).toContain(suggestion.id);
		expect(new UserMemoryStore(ws.agentDir).list()[0].content).toContain(PROFILE_TEXT);
		expect(ws.store.get(fact.id)?.archiveReason).toBe("promoted");
		expect((await runMemory(ws, ["suggestions"])).text).toContain("No pending suggestions.");
	});

	it("rejects a suggestion and reports unknown ids", async () => {
		const ws = workspace();
		const fact = addFact(ws, "Team prefers tabs for indentation");
		await reviewFacts(
			reviewOptions(ws, completionReturning(suggestionReply([createSuggestion([fact.id])])).complete),
		);
		const suggestion = ws.suggestions.list("pending")[0];

		expect((await runMemory(ws, ["reject", suggestion.id])).text).toContain(`Rejected ${suggestion.id}`);
		expect(ws.suggestions.get(suggestion.id)?.status).toBe("rejected");
		expect(ws.store.get(fact.id)?.reviewState).toBe("kept");
		expect((await runMemory(ws, ["promote", "sug_missing"])).text).toContain("Suggestion not found");
	});
});

describe("reviewFacts failure handling", () => {
	it("leaves facts unreviewed when the model fails", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const ws = workspace();
		const fact = addFact(ws, "Team prefers tabs for indentation");
		const complete: ExtractionCompletion = async () => {
			throw new Error("model unavailable");
		};

		const result = await reviewFacts(reviewOptions(ws, complete));

		expect(result).toEqual({ candidates: 1, created: 0, kept: 0, failed: 1 });
		expect(ws.store.get(fact.id)?.reviewState).toBe("unreviewed");
		expect(ws.suggestions.list()).toHaveLength(0);
		expect(errorSpy).toHaveBeenCalledWith("[memory:review]", expect.any(Error));
	});

	it("leaves facts unreviewed when the response has no suggestion payload", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const ws = workspace();
		const fact = addFact(ws, "Team prefers tabs for indentation");

		const result = await reviewFacts(reviewOptions(ws, completionReturning('{"facts":[]}').complete));

		expect(result.failed).toBe(1);
		expect(result.created).toBe(0);
		expect(ws.store.get(fact.id)?.reviewState).toBe("unreviewed");
		expect(errorSpy).toHaveBeenCalled();
	});

	it("does not call the model when the signal is already aborted", async () => {
		const ws = workspace();
		const fact = addFact(ws, "Team prefers tabs for indentation");
		const recorder = completionReturning(suggestionReply([]));
		const controller = new AbortController();
		controller.abort();

		const result = await reviewFacts(reviewOptions(ws, recorder.complete, { signal: controller.signal }));

		expect(result.candidates).toBe(1);
		expect(result.failed).toBe(1);
		expect(recorder.prompts).toHaveLength(0);
		expect(ws.store.get(fact.id)?.reviewState).toBe("unreviewed");
	});

	it("degrades to no suggestions when the suggestion store version is unsupported", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const ws = workspace();
		const fact = addFact(ws, "Team prefers tabs for indentation");
		mkdirSync(join(ws.agentDir, "memory"), { recursive: true, mode: 0o700 });
		writeFileSync(ws.suggestions.path, JSON.stringify({ version: 2, suggestions: [] }), "utf8");

		const result = await reviewFacts(
			reviewOptions(ws, completionReturning(suggestionReply([createSuggestion([fact.id])])).complete),
		);

		expect(result.created).toBe(0);
		expect(result.failed).toBe(1);
		expect(result.kept).toBe(0);
		expect(ws.store.get(fact.id)?.reviewState).toBe("unreviewed");
		expect(errorSpy).toHaveBeenCalled();
	});
});

describe("extraction to promotion", () => {
	it("extracts, reviews, promotes, and does not suggest the same fact again", async () => {
		const ws = workspace();
		const manager = SessionManager.inMemory(ws.cwd);
		appendUser(manager, "Which indentation should we use?");
		appendAssistant(manager, "Use tabs.");
		const extraction: ExtractionCompletion = async () =>
			JSON.stringify({
				facts: [
					{
						text: "Team prefers tabs for indentation",
						kind: "preference",
						importance: 4,
						confidence: 0.9,
						applicability: "universal",
						topics: ["style"],
					},
				],
			});
		const extracted = await runExtraction({
			manager,
			settings: resolveMemorySettings(undefined),
			store: ws.store,
			complete: extraction,
			cwd: ws.cwd,
			modelLabel: "provider/model",
		});
		expect(extracted.created).toBe(1);
		const fact = ws.store.active()[0];

		const firstReview = await reviewFacts(
			reviewOptions(ws, completionReturning(suggestionReply([createSuggestion([fact.id])])).complete, {
				scope: { type: "session", sessionId: manager.getSessionId() },
			}),
		);
		expect(firstReview.created).toBe(1);
		const suggestion = ws.suggestions.list("pending")[0];
		const promoted = resolveSuggestion({ agentDir: ws.agentDir, suggestionId: suggestion.id, action: "accept" });

		expect(promoted.sectionId).toBeDefined();
		expect(new UserMemoryStore(ws.agentDir).list()[0].content).toContain(PROFILE_TEXT);
		const archived = ws.store.get(fact.id);
		expect(archived?.reviewState).toBe("promoted");
		expect(archived?.archivedAt).toBeDefined();
		expect(archived?.archiveReason).toBe("promoted");

		// 已晋升的事实不再进入候选，也不会再产生建议。
		const again = completionReturning(suggestionReply([createSuggestion([fact.id])]));
		const secondReview = await reviewFacts(
			reviewOptions(ws, again.complete, { scope: { type: "session", sessionId: manager.getSessionId() } }),
		);
		expect(secondReview.candidates).toBe(0);
		expect(again.prompts).toHaveLength(0);
	});
});
