import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExtensionContext } from "../../src/core/extensions/types.ts";
import { computeProjectKey, type FactSource } from "../../src/core/memory/fact-schema.ts";
import { type FactDraft, FactStore } from "../../src/core/memory/fact-store.ts";
import { createReadMemoryToolDefinition, type ReadMemoryToolInput } from "../../src/core/memory/tools/read-memory.ts";
import {
	createRememberToolDefinition,
	type RememberToolInput,
	resetMemoryToolRateLimits,
} from "../../src/core/memory/tools/remember.ts";
import {
	createSearchMemoryToolDefinition,
	type SearchMemoryToolInput,
} from "../../src/core/memory/tools/search-memory.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { ToolPermissionManager } from "../../src/core/tool-permission-manager.ts";
import { allToolNames, createDefaultActiveToolNames } from "../../src/core/tools/index.ts";
import { UserMemoryStore } from "../../src/core/user-memory.ts";

const tempDirs: string[] = [];
const OTHER_PROJECT_KEY = "otherproject";

let root: string;
let agentDir: string;
let cwd: string;

beforeEach(() => {
	resetMemoryToolRateLimits();
	root = mkdtempSync(join(tmpdir(), "nova-memory-tools-"));
	tempDirs.push(root);
	agentDir = join(root, "agent");
	cwd = join(root, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(cwd, { recursive: true });
});

afterEach(() => {
	resetMemoryToolRateLimits();
	for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/** 只构造工具实际用到的字段，其余用类型断言补齐，避免拖入整个运行时。 */
function context(sessionManager: SessionManager = SessionManager.inMemory(cwd)): ExtensionContext {
	return { cwd, sessionManager } as unknown as ExtensionContext;
}

function resultText(result: { content: Array<{ type: string; text?: string }> }): string {
	const first = result.content[0];
	return first?.type === "text" ? (first.text ?? "") : "";
}

function makeSource(overrides: Partial<FactSource> = {}): FactSource {
	return {
		sessionFile: "/tmp/seed-session.jsonl",
		sessionId: "seed_session",
		entryIds: ["seed-entry"],
		extractedAt: "2026-01-01T00:00:00.000Z",
		model: "provider/model",
		...overrides,
	};
}

function seedFact(text: string, overrides: Partial<FactDraft> = {}) {
	const result = new FactStore(agentDir).add({ text, source: makeSource(), ...overrides });
	if (result.action !== "created") throw new Error(`seedFact expected created, got ${result.action}`);
	return result.fact;
}

async function runRemember(input: RememberToolInput, ctx: ExtensionContext = context()) {
	return createRememberToolDefinition({ agentDir }).execute("call_remember", input, undefined, undefined, ctx);
}

async function runSearch(input: SearchMemoryToolInput, ctx: ExtensionContext = context()) {
	return createSearchMemoryToolDefinition({ agentDir }).execute("call_search", input, undefined, undefined, ctx);
}

async function runRead(input: ReadMemoryToolInput, ctx: ExtensionContext = context()) {
	return createReadMemoryToolDefinition({ agentDir }).execute("call_read", input, undefined, undefined, ctx);
}

function factIds(details: { facts: Array<{ id: string }> }): string[] {
	return details.facts.map((fact) => fact.id);
}

describe("remember tool", () => {
	it("creates a fact that the next session can read, with explicit source metadata", async () => {
		const sessionManager = SessionManager.inMemory(cwd);
		const entryId = sessionManager.appendMessage({ role: "user", content: "记住我用 tabs", timestamp: Date.now() });
		const result = await runRemember(
			{
				text: "本项目使用 tabs 缩进",
				kind: "preference",
				importance: 4,
				applicability: "project",
				topics: ["缩进"],
			},
			context(sessionManager),
		);

		expect(result.details.action).toBe("created");
		expect(resultText(result)).toContain("已记住（下次会话生效）：");
		expect(resultText(result)).toContain("tabs");
		expect(result.details.factId).toBeDefined();

		// 新开一个 store 读取，等价于「下一次会话」看到的内容。
		const stored = new FactStore(agentDir).get(result.details.factId ?? "");
		expect(stored).toBeDefined();
		expect(stored?.text).toBe("本项目使用 tabs 缩进");
		expect(stored?.kind).toBe("preference");
		expect(stored?.importance).toBe(4);
		expect(stored?.applicability).toBe("project");
		expect(stored?.projects).toEqual([computeProjectKey(cwd)]);
		expect(stored?.topics).toEqual(["缩进"]);
		expect(stored?.source.model).toBe("explicit");
		expect(stored?.source.sessionId).toBe(sessionManager.getSessionId());
		expect(stored?.source.sessionFile).toBe("");
		expect(stored?.source.entryIds).toEqual([entryId]);
	});

	it("reports a duplicate instead of writing it again", async () => {
		const created = seedFact("Use tabs for indentation");
		const result = await runRemember({ text: "Use tabs for indentation" });

		expect(result.details.action).toBe("duplicate");
		expect(resultText(result)).toContain("这条已经记过了，未新增。");
		expect(result.details.factId).toBe(created.id);
		expect(new FactStore(agentDir).list()).toHaveLength(1);
	});

	it("merges a near-duplicate into the existing fact", async () => {
		const created = seedFact("Use tabs for indentation");
		const result = await runRemember({ text: "Use tabs for indentation!", importance: 5 });

		expect(result.details.action).toBe("merged");
		expect(resultText(result)).toContain("已合并更新到已有事实：");
		expect(result.details.factId).toBe(created.id);
		const facts = new FactStore(agentDir).list();
		expect(facts).toHaveLength(1);
		expect(facts[0].importance).toBe(5);
	});

	it("lists conflicting candidates and does not write", async () => {
		const created = seedFact("在本项目中用 tabs 缩进");
		const result = await runRemember({ text: "在本项目中改为用 spaces 缩进" });

		expect(result.details.action).toBe("conflict");
		expect(result.details.candidateIds).toEqual([created.id]);
		expect(resultText(result)).toContain("与以下已有事实冲突，未写入：");
		expect(resultText(result)).toContain(created.id);
		expect(new FactStore(agentDir).list()).toHaveLength(1);
	});

	it("refuses to write when facts are disabled in settings", async () => {
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ memory: { facts: { enabled: false } } }), "utf8");
		const result = await runRemember({ text: "这条不应该被写入" });

		expect(result.details.action).toBe("rejected");
		expect(resultText(result)).toContain("长期记忆已关闭");
		expect(new FactStore(agentDir).list()).toEqual([]);
		expect(existsSync(join(agentDir, "memory", "facts.json"))).toBe(false);
	});

	it("rejects the 21st write in one session and counts again after a reset", async () => {
		const ctx = context();
		const topics = [
			"缩进",
			"导入",
			"测试",
			"构建",
			"日志",
			"缓存",
			"路由",
			"状态",
			"样式",
			"接口",
			"索引",
			"队列",
			"锁",
			"权限",
			"配置",
			"迁移",
			"打包",
			"发布",
			"回滚",
			"监控",
		];
		for (const [index, topic] of topics.entries()) {
			const result = await runRemember({ text: `项目约定使用${topic}方案` }, ctx);
			expect(result.details.action, `write ${index + 1}`).toBe("created");
		}
		expect(new FactStore(agentDir).list()).toHaveLength(20);

		const rejected = await runRemember({ text: "项目约定使用审计方案" }, ctx);
		expect(rejected.details.action).toBe("rejected");
		expect(resultText(rejected)).toContain("上限（20 条）");
		expect(new FactStore(agentDir).list()).toHaveLength(20);

		resetMemoryToolRateLimits();
		const allowed = await runRemember({ text: "Release branch is cut on Fridays" }, ctx);
		expect(allowed.details.action).toBe("created");
	});
});

describe("search_memory tool", () => {
	it("matches a Chinese fact, returns its id, and records a retrieval", async () => {
		const fact = seedFact("用户偏好中文回答并保持简洁", {
			kind: "preference",
			topics: ["中文", "偏好"],
		});
		seedFact("本项目使用 tabs 缩进", { applicability: "project", projects: [computeProjectKey(cwd)] });

		const result = await runSearch({ query: "中文" });

		expect(factIds(result.details)).toEqual([fact.id]);
		expect(result.details.facts[0].score).toBeGreaterThan(0);
		expect(result.details.facts[0].applicability).toBe("universal");
		expect(resultText(result)).toContain(fact.id);
		expect(resultText(result)).toContain("用户偏好中文回答并保持简洁");

		expect(new FactStore(agentDir).get(fact.id)?.retrievalCount).toBe(1);
		expect(new FactStore(agentDir).get(fact.id)?.lastRetrievedAt).toBeDefined();
	});

	it("hides archived facts by default and returns them with includeArchived", async () => {
		const archived = seedFact("旧的中文偏好：回答可以啰嗦", { kind: "preference" });
		new FactStore(agentDir).archive(archived.id, "stale");

		const withoutArchived = await runSearch({ query: "中文" });
		expect(factIds(withoutArchived.details)).not.toContain(archived.id);

		const withArchived = await runSearch({ query: "中文", includeArchived: true });
		expect(factIds(withArchived.details)).toContain(archived.id);
	});

	it("keeps other projects' project facts out unless includeOtherProjects is set", async () => {
		const local = seedFact("本项目使用 tabs 缩进", {
			applicability: "project",
			projects: [computeProjectKey(cwd)],
		});
		const foreign = seedFact("其它项目使用 spaces 缩进", {
			applicability: "project",
			projects: [OTHER_PROJECT_KEY],
		});

		const scoped = await runSearch({ query: "缩进" });
		expect(factIds(scoped.details)).toEqual([local.id]);

		const acrossProjects = await runSearch({ query: "缩进", includeOtherProjects: true });
		expect(factIds(acrossProjects.details).sort()).toEqual([local.id, foreign.id].sort());
	});

	it("matches user profile sections and returns their ids", async () => {
		const section = new UserMemoryStore(agentDir).upsertSection(undefined, "协作偏好", "用户偏好中文回答");

		const result = await runSearch({ query: "中文" });

		expect(result.details.sections).toEqual([{ id: section.id, title: "协作偏好" }]);
		expect(section.id.startsWith("section_")).toBe(true);
		expect(resultText(result)).toContain("画像：");
		expect(resultText(result)).toContain(section.id);
	});

	it("filters by applicability, kinds, and limit", async () => {
		const universal = seedFact("用户偏好中文回答", { kind: "preference" });
		const project = seedFact("本项目中文文档放在 docs 目录", {
			kind: "project",
			applicability: "project",
			projects: [computeProjectKey(cwd)],
		});

		const projectOnly = await runSearch({ query: "中文", applicability: "project" });
		expect(factIds(projectOnly.details)).toEqual([project.id]);

		const kindsFiltered = await runSearch({ query: "中文", kinds: ["preference"] });
		expect(factIds(kindsFiltered.details)).toEqual([universal.id]);

		const limited = await runSearch({ query: "中文", limit: 1 });
		expect(limited.details.facts).toHaveLength(1);
	});

	it("returns an empty result without throwing", async () => {
		const result = await runSearch({ query: "完全不存在的话题" });

		expect(result.details.facts).toEqual([]);
		expect(result.details.sections).toEqual([]);
		expect(resultText(result)).toContain("没有找到匹配的长期记忆。");
	});
});

describe("read_memory tool", () => {
	it("returns the full fact, its source, and related facts", async () => {
		const fact = seedFact("用户偏好中文回答并保持简洁", {
			kind: "preference",
			topics: ["偏好", "中文"],
		});
		const related = seedFact("用户偏好中文回答但更简短", {
			kind: "preference",
			topics: ["偏好", "中文"],
		});

		const result = await runRead({ id: fact.id });

		expect(result.details.kind).toBe("fact");
		expect(result.details.factId).toBe(fact.id);
		expect(result.details.relatedFactIds).toEqual([related.id]);
		const text = resultText(result);
		expect(text).toContain("用户偏好中文回答并保持简洁");
		expect(text).toContain("来源：会话 seed_session");
		expect(text).toContain("来源文件：/tmp/seed-session.jsonl");
		expect(text).toContain("seed-entry");
		expect(text).toContain(related.id);
		expect(new FactStore(agentDir).get(fact.id)?.retrievalCount).toBe(1);
	});

	it("returns a profile section's content and related facts", async () => {
		const section = new UserMemoryStore(agentDir).upsertSection(undefined, "协作偏好", "用户偏好中文回答");
		const related = seedFact("用户偏好中文回答并保持简洁", { kind: "preference" });

		const result = await runRead({ id: section.id });

		expect(result.details.kind).toBe("section");
		expect(result.details.sectionId).toBe(section.id);
		expect(result.details.relatedFactIds).toContain(related.id);
		const text = resultText(result);
		expect(text).toContain("协作偏好");
		expect(text).toContain("用户偏好中文回答");
		expect(text).toContain(related.id);
	});

	it("returns an error text instead of throwing for unknown ids", async () => {
		const missingFact = await runRead({ id: "fact_missing" });
		expect(missingFact.details.kind).toBe("not_found");
		expect(resultText(missingFact)).toContain("未找到事实 fact_missing");

		const missingSection = await runRead({ id: "section_missing" });
		expect(missingSection.details.kind).toBe("not_found");
		expect(resultText(missingSection)).toContain("未找到画像段落 section_missing");

		const unknownPrefix = await runRead({ id: "bogus_id" });
		expect(unknownPrefix.details.kind).toBe("not_found");
		expect(resultText(unknownPrefix)).toContain("无法识别 id");
	});
});

describe("memory tool registration", () => {
	it("auto-approves all three memory tools without a permission prompt", async () => {
		const manager = new ToolPermissionManager({ mode: "ask" });
		for (const toolName of ["remember", "search_memory", "read_memory"]) {
			const result = await manager.check({ toolCallId: "call_1", toolName, args: {}, cwd }, undefined);
			expect(result.allowed, toolName).toBe(true);
			expect(result.reason, toolName).toBe("Tool auto-approved");
		}
		// A gated tool still asks, which proves the assertion above is meaningful.
		const gated = await manager.check({ toolCallId: "call_2", toolName: "bash", args: {}, cwd }, undefined);
		expect(gated.allowed).toBe(false);
	});

	it("registers the tools in the built-in tool list and the default active set", () => {
		const active = createDefaultActiveToolNames();
		for (const toolName of ["remember", "search_memory", "read_memory"] as const) {
			expect(allToolNames.has(toolName)).toBe(true);
			expect(active).toContain(toolName);
		}
	});
});
