import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	applyExtractedFacts,
	type ExtractedFact,
	type ExtractionCompletion,
	type ExtractionContext,
	extractFacts,
} from "../../src/core/memory/fact-extraction.ts";
import type { Fact, FactSource } from "../../src/core/memory/fact-schema.ts";
import { type FactDraft, FactStore } from "../../src/core/memory/fact-store.ts";
import {
	type ResolvedMemoryExtractionSettings,
	type ResolvedMemorySettings,
	resolveMemorySettings,
} from "../../src/core/memory/memory-settings.ts";
import type { SessionEntry } from "../../src/core/session-manager.ts";

const PROJECT_KEY = "a1b2c3d4e5f6";
const PROJECT_PATH = "/work/project";
const tempDirs: string[] = [];
let counter = 0;

afterEach(() => {
	for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function createStore(): FactStore {
	const directory = mkdtempSync(join(tmpdir(), "nova-fact-extraction-"));
	tempDirs.push(directory);
	return new FactStore(directory);
}

function makeSource(): FactSource {
	counter += 1;
	return {
		sessionFile: "/sessions/test.jsonl",
		sessionId: `session_${counter}`,
		entryIds: ["entry-1", "entry-2"],
		extractedAt: new Date().toISOString(),
		model: "provider/model",
	};
}

function makeContext(overrides: Partial<ExtractionContext> = {}): ExtractionContext {
	return { projectPath: PROJECT_PATH, projectKey: PROJECT_KEY, sections: [], recentFacts: [], ...overrides };
}

function makeSettings(extraction: Partial<ResolvedMemoryExtractionSettings> = {}): ResolvedMemorySettings {
	const base = resolveMemorySettings(undefined);
	return { ...base, extraction: { ...base.extraction, ...extraction } };
}

function nextId(): string {
	counter += 1;
	return `entry_${counter}`;
}

function time(): string {
	return new Date().toISOString();
}

function userEntry(text: string): SessionEntry {
	return {
		type: "message",
		id: nextId(),
		parentId: null,
		timestamp: time(),
		message: { role: "user", content: text, timestamp: Date.now() },
	};
}

function assistantEntry(text: string): SessionEntry {
	return {
		type: "message",
		id: nextId(),
		parentId: null,
		timestamp: time(),
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "test-model",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		},
	};
}

function thinkingEntry(thinking: string, text: string): SessionEntry {
	return {
		type: "message",
		id: nextId(),
		parentId: null,
		timestamp: time(),
		message: {
			role: "assistant",
			content: [
				{ type: "thinking", thinking },
				{ type: "text", text },
			],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "test-model",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		},
	};
}

function toolResultEntry(text: string): SessionEntry {
	return {
		type: "message",
		id: nextId(),
		parentId: null,
		timestamp: time(),
		message: {
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "bash",
			content: [{ type: "text", text }],
			isError: false,
			timestamp: Date.now(),
		},
	};
}

function extractedFact(text: string, overrides: Partial<ExtractedFact> = {}): ExtractedFact {
	return {
		text,
		kind: "preference",
		importance: 3,
		confidence: 0.8,
		applicability: "universal",
		topics: ["tooling"],
		...overrides,
	};
}

function factJson(facts: ExtractedFact[]): string {
	return JSON.stringify({ facts });
}

interface CapturedPrompt {
	systemPrompt: string;
	userPrompt: string;
}

function makeComplete(response: string): { complete: ExtractionCompletion; prompts: CapturedPrompt[] } {
	const prompts: CapturedPrompt[] = [];
	const complete: ExtractionCompletion = async (input) => {
		prompts.push({ systemPrompt: input.systemPrompt, userPrompt: input.userPrompt });
		return response;
	};
	return { complete, prompts };
}

function seedFact(store: FactStore, text: string, overrides: Partial<FactDraft> = {}): Fact {
	const result = store.add({ text, kind: "decision", importance: 3, source: makeSource(), ...overrides });
	if (result.action !== "created") throw new Error(`expected created, got ${result.action}`);
	return result.fact;
}

describe("extractFacts", () => {
	it("extracts facts from a normal model response", async () => {
		const { complete } = makeComplete(
			factJson([
				extractedFact("项目统一使用 pnpm 管理依赖", {
					kind: "decision",
					importance: 4,
					applicability: "project",
					projects: [PROJECT_KEY],
				}),
				extractedFact("所有提交信息使用中文短句描述", { kind: "preference", importance: 3 }),
			]),
		);
		const facts = await extractFacts({
			entries: [userEntry("以后都用 pnpm，提交信息写中文"), assistantEntry("明白，已按这个约定处理")],
			context: makeContext(),
			settings: makeSettings(),
			complete,
		});
		expect(facts).toHaveLength(2);
		expect(facts[0]?.applicability).toBe("project");
	});

	it("applies extracted facts to a real store", async () => {
		const { complete } = makeComplete(
			factJson([
				extractedFact("项目统一使用 pnpm 管理依赖", {
					kind: "decision",
					importance: 4,
					applicability: "project",
					projects: [PROJECT_KEY],
				}),
				extractedFact("所有提交信息使用中文短句描述", { kind: "preference", importance: 3 }),
			]),
		);
		const facts = await extractFacts({
			entries: [userEntry("以后都用 pnpm，提交信息写中文")],
			context: makeContext(),
			settings: makeSettings(),
			complete,
		});
		const store = createStore();
		const result = applyExtractedFacts({
			store,
			facts,
			source: makeSource(),
			projectKey: PROJECT_KEY,
		});
		expect(result.created).toBe(2);
		expect(result.merged).toBe(0);
		expect(result.duplicates).toBe(0);
		expect(result.conflicts).toBe(0);
		expect(result.facts).toHaveLength(2);
		expect(store.list()).toHaveLength(2);
		const projectFact = store.list().find((fact) => fact.applicability === "project");
		expect(projectFact?.projects).toEqual([PROJECT_KEY]);
	});

	it("parses a fenced JSON response with surrounding noise", async () => {
		const payload = factJson([extractedFact("项目统一使用 pnpm 管理依赖", { importance: 3 })]);
		const { complete } = makeComplete(`Here is what I found:\n\`\`\`json\n${payload}\n\`\`\`\nDone.`);
		const facts = await extractFacts({
			entries: [userEntry("统一用 pnpm")],
			context: makeContext(),
			settings: makeSettings(),
			complete,
		});
		expect(facts).toHaveLength(1);
		expect(facts[0]?.text).toBe("项目统一使用 pnpm 管理依赖");
	});

	it("recovers JSON embedded in prose", async () => {
		const payload = factJson([extractedFact("项目统一使用 pnpm 管理依赖", { importance: 3 })]);
		const { complete } = makeComplete(`Sure. ${payload} Let me know if you need more.`);
		const facts = await extractFacts({
			entries: [userEntry("统一用 pnpm")],
			context: makeContext(),
			settings: makeSettings(),
			complete,
		});
		expect(facts).toHaveLength(1);
	});

	it("returns no facts for invalid JSON without throwing", async () => {
		const { complete } = makeComplete("I could not find anything useful in this conversation.");
		const facts = await extractFacts({
			entries: [userEntry("随便聊聊")],
			context: makeContext(),
			settings: makeSettings(),
			complete,
		});
		expect(facts).toEqual([]);
		const store = createStore();
		const result = applyExtractedFacts({
			store,
			facts,
			source: makeSource(),
			projectKey: PROJECT_KEY,
		});
		expect(result).toEqual({ created: 0, merged: 0, duplicates: 0, conflicts: 0, facts: [] });
	});

	it("drops invalid fact entries without throwing", async () => {
		const payload = JSON.stringify({
			facts: [
				{ text: "", kind: "preference", importance: 3, confidence: 0.8, applicability: "universal", topics: ["a"] },
				{
					text: "项目统一使用 pnpm 管理依赖",
					kind: "unknown",
					importance: 3,
					confidence: 0.8,
					applicability: "universal",
					topics: ["a"],
				},
				{
					text: "项目统一使用 pnpm 管理依赖",
					kind: "preference",
					importance: 9,
					confidence: 0.8,
					applicability: "universal",
					topics: ["a"],
				},
				{
					text: "项目统一使用 pnpm 管理依赖",
					kind: "preference",
					importance: 3,
					confidence: 0.8,
					applicability: "project",
					topics: ["a"],
				},
				extractedFact("所有提交信息使用中文短句描述", { importance: 3 }),
			],
		});
		const { complete } = makeComplete(payload);
		const facts = await extractFacts({
			entries: [userEntry("统一用 pnpm")],
			context: makeContext(),
			settings: makeSettings(),
			complete,
		});
		expect(facts).toHaveLength(1);
		expect(facts[0]?.text).toBe("所有提交信息使用中文短句描述");
	});

	it("filters greetings", async () => {
		const { complete, prompts } = makeComplete(
			factJson([extractedFact("谢谢你，我明白了"), extractedFact("项目统一使用 pnpm 管理依赖", { importance: 3 })]),
		);
		const diagnostics: string[] = [];
		const facts = await extractFacts({
			entries: [userEntry("谢谢你，我明白了"), userEntry("以后统一用 pnpm")],
			context: makeContext(),
			settings: makeSettings(),
			complete,
			onDiagnostic: (message) => diagnostics.push(message),
		});
		expect(prompts).toHaveLength(1);
		expect(facts).toHaveLength(1);
		expect(facts[0]?.text).toBe("项目统一使用 pnpm 管理依赖");
		expect(diagnostics.some((message) => message.includes("greeting"))).toBe(true);
	});

	it("filters short, sensitive and low-importance facts", async () => {
		const { complete } = makeComplete(
			factJson([
				extractedFact("用 pnpm"),
				extractedFact("api key 是 sk_abcdefghijklmnop123456"),
				extractedFact("项目使用 pnpm 管理所有依赖", { importance: 1 }),
				extractedFact("项目统一使用 pnpm 管理依赖", { importance: 3 }),
			]),
		);
		const facts = await extractFacts({
			entries: [userEntry("以后统一用 pnpm")],
			context: makeContext(),
			settings: makeSettings({ minImportance: 2 }),
			complete,
		});
		expect(facts).toHaveLength(1);
		expect(facts[0]?.text).toBe("项目统一使用 pnpm 管理依赖");
	});

	it("filters facts already covered by the user profile", async () => {
		const { complete } = makeComplete(
			factJson([
				extractedFact("用户偏好使用 pnpm 管理依赖"),
				extractedFact("项目使用 vitest 运行单元测试", { importance: 3 }),
			]),
		);
		const facts = await extractFacts({
			entries: [userEntry("以后统一用 pnpm")],
			context: makeContext({
				sections: [{ id: "s1", title: "协作偏好", content: "用户偏好使用 pnpm 管理依赖" }],
			}),
			settings: makeSettings(),
			complete,
		});
		expect(facts).toHaveLength(1);
		expect(facts[0]?.text).toBe("项目使用 vitest 运行单元测试");
	});

	it("keeps the most important facts when exceeding maxFactsPerBatch", async () => {
		const importances = [2, 3, 4, 5, 2, 3, 4, 5, 2, 3];
		const facts = importances.map((importance, index) =>
			extractedFact(`项目规则第 ${index} 条：统一使用工具 ${index} 管理构建`, { importance }),
		);
		const { complete } = makeComplete(factJson(facts));
		const extracted = await extractFacts({
			entries: [userEntry("以后统一按这些规则来")],
			context: makeContext(),
			settings: makeSettings({ maxFactsPerBatch: 8, minImportance: 2 }),
			complete,
		});
		expect(extracted).toHaveLength(8);
		expect(extracted.map((fact) => fact.importance)).toEqual([5, 5, 4, 4, 3, 3, 3, 2]);
	});

	it("serializes only user and assistant text, keeping the tail when truncating", async () => {
		const { complete, prompts } = makeComplete('{"facts":[]}');
		const entries = [
			userEntry(`EARLY_MARKER ${"很早之前说过的话。".repeat(60)}`),
			toolResultEntry(`TOOL_RESULT_MARKER ${"命令输出内容。".repeat(20)}`),
			thinkingEntry(`THINKING_MARKER ${"内部推理内容。".repeat(20)}`, "我在检查构建配置"),
			assistantEntry(`TAIL_MARKER ${"最新的结论内容。".repeat(20)}`),
		];
		await extractFacts({
			entries,
			context: makeContext(),
			settings: makeSettings({ maxInputChars: 260 }),
			complete,
		});
		const prompt = prompts[0]?.userPrompt ?? "";
		expect(prompt).toContain("[earlier messages omitted]");
		expect(prompt).toContain("TAIL_MARKER");
		expect(prompt).not.toContain("EARLY_MARKER");
		expect(prompt).not.toContain("TOOL_RESULT_MARKER");
		expect(prompt).not.toContain("THINKING_MARKER");
		const start = prompt.indexOf("Conversation:\n") + "Conversation:\n".length;
		const end = prompt.indexOf("\n\nRules:", start);
		expect(prompt.slice(start, end).length).toBeLessThanOrEqual(260);
	});

	it("does not call the model when there are no messages", async () => {
		let calls = 0;
		const complete: ExtractionCompletion = async () => {
			calls += 1;
			return '{"facts":[]}';
		};
		const facts = await extractFacts({
			entries: [],
			context: makeContext(),
			settings: makeSettings(),
			complete,
		});
		expect(facts).toEqual([]);
		expect(calls).toBe(0);
	});
});

describe("applyExtractedFacts", () => {
	it("merges near-duplicate facts", () => {
		const store = createStore();
		const seeded = seedFact(store, "项目统一使用 pnpm 管理依赖");
		const result = applyExtractedFacts({
			store,
			facts: [extractedFact("项目统一使用 pnpm 管理依赖。", { importance: 3 })],
			source: makeSource(),
			projectKey: PROJECT_KEY,
		});
		expect(result.created).toBe(0);
		expect(result.merged).toBe(1);
		expect(result.facts[0]?.id).toBe(seeded.id);
		expect(store.list()).toHaveLength(1);
	});

	it("counts conflicts without writing", () => {
		const store = createStore();
		seedFact(store, "项目依赖管理统一使用 pnpm 安装依赖");
		const result = applyExtractedFacts({
			store,
			facts: [extractedFact("项目依赖管理改为使用 yarn 安装依赖")],
			source: makeSource(),
			projectKey: PROJECT_KEY,
		});
		expect(result.created).toBe(0);
		expect(result.merged).toBe(0);
		expect(result.conflicts).toBe(1);
		expect(store.list()).toHaveLength(1);
	});

	it("supersedes the referenced fact", () => {
		const store = createStore();
		const previous = seedFact(store, "旧构建使用 tsc 编译源码");
		const result = applyExtractedFacts({
			store,
			facts: [
				extractedFact("新构建统一改用 tsup 编译源码", {
					kind: "decision",
					importance: 4,
					applicability: "project",
					projects: [PROJECT_KEY],
					supersedes: [previous.id],
				}),
			],
			source: makeSource(),
			projectKey: PROJECT_KEY,
		});
		expect(result.created).toBe(1);
		const replacement = result.facts[0];
		expect(replacement).toBeDefined();
		const archived = store.get(previous.id);
		expect(archived?.archiveReason).toBe("superseded");
		expect(archived?.supersededBy).toBe(replacement?.id);
		expect(replacement?.supersedes).toEqual([previous.id]);
	});

	it("counts sensitive facts as duplicates without throwing", () => {
		const store = createStore();
		const result = applyExtractedFacts({
			store,
			facts: [extractedFact("api key 是 sk_abcdefghijklmnop123456")],
			source: makeSource(),
			projectKey: PROJECT_KEY,
		});
		expect(result.duplicates).toBe(1);
		expect(result.created).toBe(0);
		expect(store.list()).toHaveLength(0);
	});

	it("ignores supersedes ids that are not in the store", () => {
		const store = createStore();
		const result = applyExtractedFacts({
			store,
			facts: [
				extractedFact("项目统一使用 pnpm 管理依赖", {
					supersedes: ["fact_does_not_exist"],
				}),
			],
			source: makeSource(),
			projectKey: PROJECT_KEY,
		});
		expect(result.created).toBe(1);
		expect(result.facts[0]?.supersedes).toBeUndefined();
	});
});
