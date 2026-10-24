/**
 * 事实记忆端到端用例：对话 → 抽取 → 落库 → 下一次注入 → 预算 → fork → 强杀补偿 → remember 工具。
 *
 * 全程只用假 complete（固定 JSON）与 faux provider，不触碰真实模型、网络或 API Key。
 * 每个用例一套独立临时目录，覆盖 "每个 sessionDir 每进程只补抽一次" 的模块级登记互不干扰。
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@dongzijie1/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionContext } from "../../src/core/extensions/types.ts";
import { lifecycleHooks } from "../../src/core/lifecycle-hooks.ts";
import type { ExtractionCompletion } from "../../src/core/memory/fact-extraction.ts";
import { loadFactsBlock } from "../../src/core/memory/fact-prompt.ts";
import { FactStore } from "../../src/core/memory/fact-store.ts";
import { estimateMemoryTokens } from "../../src/core/memory/fact-text.ts";
import { findSessionsNeedingExtraction, runStartupCompensation } from "../../src/core/memory/memory-compensation.ts";
import { readExtractionMarker } from "../../src/core/memory/memory-marker.ts";
import { runExtraction } from "../../src/core/memory/memory-service.ts";
import { resolveMemorySettings } from "../../src/core/memory/memory-settings.ts";
import { createRememberToolDefinition } from "../../src/core/memory/tools/remember.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createHarness, type Harness } from "./harness.ts";

/** 两轮对话：一句寒暄（必须被过滤）+ 一句真正常驻的构建约定（必须落库）。 */
const GREETING_TURN = "你好";
const BUILD_TURN = "以后构建用 npm run build:offline";
const BUILD_FACT = "本项目构建统一用 npm run build:offline";
const REMEMBERED_FACT = "本项目发布名词必须走离线构建脚本";

/** 预算用例的 5 x 10 组合：文本互不相似，也不含数字与矛盾标记，避免被合并或判为冲突。 */
const BUDGET_PROCESSES = [
	"部署脚本",
	"日志轮转",
	"缓存失效",
	"索引重建",
	"鉴权回退",
	"数据迁移",
	"灰度发布",
	"告警分级",
	"监控面板",
	"压测基线",
];
const BUDGET_ASPECTS = ["沿用至本季度结束", "由平台团队维护", "纳入默认工具箱", "随发布批次更新", "需要每周复核"];

const tempDirs: string[] = [];
const harnesses: Harness[] = [];

afterEach(() => {
	while (harnesses.length > 0) harnesses.pop()?.cleanup();
	for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

interface Workspace {
	root: string;
	agentDir: string;
	cwd: string;
	sessionDir: string;
	store: FactStore;
}

function workspace(): Workspace {
	const root = mkdtempSync(join(tmpdir(), "nova-memory-e2e-"));
	tempDirs.push(root);
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	const sessionDir = join(root, "sessions");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(cwd, { recursive: true });
	mkdirSync(sessionDir, { recursive: true });
	return { root, agentDir, cwd, sessionDir, store: new FactStore(agentDir) };
}

function settings() {
	return resolveMemorySettings(undefined);
}

/** 假 complete 的返回体：字段名与 CONTRACTS 第 9 节的提取结果一致。 */
function extractedFactJson(text: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		text,
		kind: "constraint",
		importance: 4,
		confidence: 0.9,
		applicability: "transferable",
		topics: ["build"],
		...overrides,
	};
}

/** 固定 JSON：寒暄那条会被抽取器在落库前过滤掉。 */
const EXTRACTION_REPLY = JSON.stringify({
	facts: [
		extractedFactJson(GREETING_TURN, { kind: "event", importance: 2, topics: ["greeting"] }),
		extractedFactJson(BUILD_FACT),
	],
});
const BUILD_ONLY_REPLY = JSON.stringify({ facts: [extractedFactJson(BUILD_FACT)] });

function fixedCompletion(reply: string): ExtractionCompletion {
	return async () => reply;
}

function extractionOptions(
	manager: SessionManager,
	ws: Workspace,
	complete: ExtractionCompletion,
): Parameters<typeof runExtraction>[0] {
	return {
		manager,
		settings: settings(),
		store: ws.store,
		complete,
		cwd: ws.cwd,
		modelLabel: "faux/model",
	};
}

/** 用 faux provider 跑完两轮对话：消息进内存会话，不触发任何记忆服务。 */
async function conversationHarness(): Promise<Harness> {
	const harness = await createHarness();
	harnesses.push(harness);
	harness.setResponses([fauxAssistantMessage("你好，需要我做什么"), fauxAssistantMessage("好的，记住了")]);
	await harness.session.prompt(GREETING_TURN);
	await harness.session.prompt(BUILD_TURN);
	return harness;
}

function assistantEntry(text: string): Parameters<SessionManager["appendMessage"]>[0] {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "faux",
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
	};
}

/** 同一批对话消息：用于造持久化会话（场景 E）与 fork 的同源会话（场景 D）。 */
function appendConversation(manager: SessionManager): void {
	manager.appendMessage({ role: "user", content: GREETING_TURN, timestamp: Date.now() });
	manager.appendMessage(assistantEntry("你好，需要我做什么"));
	manager.appendMessage({ role: "user", content: BUILD_TURN, timestamp: Date.now() });
	manager.appendMessage(assistantEntry("好的，记住了"));
}

function persistentSession(ws: Workspace): SessionManager {
	const manager = SessionManager.create(ws.cwd, ws.sessionDir);
	appendConversation(manager);
	return manager;
}

describe("memory end-to-end", () => {
	it("A. 一轮抽取只落一条事实，寒暄被过滤且区间不被重复抽取", async () => {
		const ws = workspace();
		const harness = await conversationHarness();

		const result = await runExtraction(
			extractionOptions(harness.sessionManager, ws, fixedCompletion(EXTRACTION_REPLY)),
		);

		expect(result.ran).toBe(true);
		expect(result.created).toBe(1);
		expect(result.duplicates).toBe(0);
		const facts = ws.store.active();
		expect(facts.map((fact) => fact.text)).toEqual([BUILD_FACT]);
		expect(facts[0].text).not.toContain(GREETING_TURN);
		expect(facts[0].source.model).toBe("faux/model");
		expect(result.factIds).toEqual([facts[0].id]);

		// 标记已覆盖这两轮消息：再跑一次没有待处理区间，也不会调用模型。
		const again = await runExtraction(
			extractionOptions(harness.sessionManager, ws, fixedCompletion(EXTRACTION_REPLY)),
		);
		expect(again.ran).toBe(false);
		expect(ws.store.list()).toHaveLength(1);
	});

	it("B. 同一 agentDir 的新会话能看到该事实，空 agentDir 不注入", async () => {
		const ws = workspace();
		const harness = await conversationHarness();
		await runExtraction(extractionOptions(harness.sessionManager, ws, fixedCompletion(BUILD_ONLY_REPLY)));

		// 新会话：换一个 SessionManager，模拟下一次启动时构建 system prompt。
		const next = SessionManager.create(ws.cwd, ws.sessionDir);
		next.appendMessage({ role: "user", content: "接下来做什么", timestamp: Date.now() });

		const block = loadFactsBlock({ agentDir: ws.agentDir, cwd: ws.cwd, settings: settings() });

		expect(block).toBeDefined();
		expect(block).toContain(BUILD_FACT);
		expect(block?.startsWith("<user_facts>")).toBe(true);
		expect(
			loadFactsBlock({ agentDir: join(ws.root, "empty-agent"), cwd: ws.cwd, settings: settings() }),
		).toBeUndefined();
	});

	it("C. 50 条事实的注入块受 1000 token 与 12 条上限约束", async () => {
		const ws = workspace();
		for (const process of BUDGET_PROCESSES) {
			for (const aspect of BUDGET_ASPECTS) {
				const added = ws.store.add({
					text: `${process}这条约定${aspect}`,
					kind: "decision",
					importance: 3,
					source: {
						sessionFile: "",
						sessionId: "seed_session",
						entryIds: [],
						extractedAt: new Date().toISOString(),
						model: "explicit",
					},
				});
				if (added.action !== "created") throw new Error(`fact was not created: ${added.action}`);
			}
		}
		expect(ws.store.active()).toHaveLength(50);

		const block = loadFactsBlock({ agentDir: ws.agentDir, cwd: ws.cwd, settings: settings() }) ?? "";
		const lines = block.split("\n").filter((line) => line.startsWith("- ["));

		expect(estimateMemoryTokens(block)).toBeLessThanOrEqual(1000);
		expect(lines.length).toBeLessThanOrEqual(12);
		expect(block).toContain("Showing 12 of 50 active facts");
	});

	it("D. fork 出的会话重复抽取同一批消息时不新增事实", async () => {
		const ws = workspace();
		const original = SessionManager.inMemory(ws.cwd);
		appendConversation(original);
		const forked = SessionManager.inMemory(ws.cwd);
		appendConversation(forked);

		const first = await runExtraction(extractionOptions(original, ws, fixedCompletion(BUILD_ONLY_REPLY)));
		const second = await runExtraction(extractionOptions(forked, ws, fixedCompletion(BUILD_ONLY_REPLY)));

		expect(first.created).toBe(1);
		expect(second.ran).toBe(true);
		expect(second.created).toBe(0);
		expect(second.duplicates).toBe(1);
		expect(second.factIds).toEqual([]);
		expect(ws.store.list()).toHaveLength(1);
	});

	it("E. 强杀后启动补偿只补抽标记之后的尾巴，再跑一次不重复", async () => {
		const ws = workspace();
		const manager = persistentSession(ws);
		const sessionFile = manager.getSessionFile();
		if (sessionFile === undefined) throw new Error("session file was not created");
		// 第一次抽取正常完成：标记覆盖到第二轮回复。
		const first = await runExtraction(extractionOptions(manager, ws, fixedCompletion(BUILD_ONLY_REPLY)));
		expect(first.created).toBe(1);

		// 强杀之前又追加了一轮对话，没来得及抽取。
		const TAIL_FACT = "发布一律使用离线构建产物";
		manager.appendMessage({ role: "user", content: "那就这样发布", timestamp: Date.now() });
		const tailAssistantId = manager.appendMessage(assistantEntry("已记录"));
		expect(readExtractionMarker(SessionManager.open(sessionFile)).marker?.throughEntryId).not.toBe(tailAssistantId);
		expect(findSessionsNeedingExtraction({ sessionDir: ws.sessionDir })).toHaveLength(1);

		const options = {
			agentDir: ws.agentDir,
			sessionDir: ws.sessionDir,
			settings: settings(),
			store: ws.store,
			complete: fixedCompletion(JSON.stringify({ facts: [extractedFactJson(TAIL_FACT)] })),
		};
		const compensated = await runStartupCompensation(options);

		expect(compensated).toEqual({ processed: 1, created: 1, failed: 0 });
		const facts = ws.store.active();
		expect(facts.map((fact) => fact.text).sort()).toEqual([BUILD_FACT, TAIL_FACT].sort());
		const marker = readExtractionMarker(SessionManager.open(sessionFile)).marker;
		expect(marker?.model).toBe("startup");
		expect(marker?.throughEntryId).toBe(tailAssistantId);

		// 标记覆盖全部消息：扫描不再有候选，再跑一次补偿也不会新增事实。
		expect(findSessionsNeedingExtraction({ sessionDir: ws.sessionDir })).toEqual([]);
		const again = await runStartupCompensation(options);
		expect(again).toEqual({ processed: 0, created: 0, failed: 0 });
		expect(ws.store.list()).toHaveLength(2);
	});

	it("G. 从未抽取过的历史会话不会被启动补偿重新抽成事实", async () => {
		const ws = workspace();
		const manager = persistentSession(ws);
		const sessionFile = manager.getSessionFile();
		if (sessionFile === undefined) throw new Error("session file was not created");
		// 记忆功能上线前的会话：消息齐全，但没有抽取标记。
		expect(readExtractionMarker(SessionManager.open(sessionFile)).marker).toBeUndefined();

		let calls = 0;
		const complete: ExtractionCompletion = async () => {
			calls += 1;
			return BUILD_ONLY_REPLY;
		};

		const result = await runStartupCompensation({
			agentDir: ws.agentDir,
			sessionDir: ws.sessionDir,
			settings: settings(),
			store: ws.store,
			complete,
		});

		expect(result).toEqual({ processed: 0, created: 0, failed: 0 });
		expect(calls).toBe(0);
		expect(ws.store.list()).toHaveLength(0);
	});

	it("F. remember 工具写入的事实出现在同一 agentDir 的注入块里", async () => {
		const ws = workspace();
		const manager = SessionManager.inMemory(ws.cwd);
		const entryId = manager.appendMessage({ role: "user", content: "记住发布前要跑离线构建", timestamp: Date.now() });
		const context = { cwd: ws.cwd, sessionManager: manager } as unknown as ExtensionContext;

		const result = await createRememberToolDefinition({ agentDir: ws.agentDir }).execute(
			"call_remember",
			{ text: REMEMBERED_FACT, kind: "constraint", importance: 4, applicability: "transferable", topics: ["build"] },
			undefined,
			undefined,
			context,
		);

		expect(result.details.action).toBe("created");
		const factId = result.details.factId;
		if (factId === undefined) throw new Error("remember did not return a fact id");

		const block = loadFactsBlock({ agentDir: ws.agentDir, cwd: ws.cwd, settings: settings() }) ?? "";
		expect(block).toContain(REMEMBERED_FACT);
		expect(block).toContain(factId);
		const stored = new FactStore(ws.agentDir).get(factId);
		expect(stored?.source.model).toBe("explicit");
		expect(stored?.source.entryIds).toEqual([entryId]);
	});

	it("H. 首条消息的记忆注入排在用户消息之前", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("好的")]);
		const unregister = lifecycleHooks.register("before_prompt", {
			name: "e2e-memory-injection",
			timeoutMs: 1000,
			handler: () => ({
				messages: [
					{
						customType: "test.memory_retrieval",
						content: [
							{ type: "text", text: "<retrieved_user_memory>\n- [fact_x] demo\n</retrieved_user_memory>" },
						],
						display: false,
					},
				],
			}),
		});
		try {
			await harness.session.prompt("请按记忆里的约定来");
		} finally {
			unregister();
		}

		const messages = harness.session.messages;
		const memoryIndex = messages.findIndex(
			(message) => message.role === "custom" && message.customType === "test.memory_retrieval",
		);
		const userIndex = messages.findIndex((message) => message.role === "user");
		expect(memoryIndex).toBeGreaterThanOrEqual(0);
		expect(userIndex).toBeGreaterThan(memoryIndex);
	});
});
