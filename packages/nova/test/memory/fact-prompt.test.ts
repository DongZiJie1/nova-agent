import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadFactsBlock, renderFactsPrompt } from "../../src/core/memory/fact-prompt.ts";
import { computeProjectKey, type Fact, type FactSource } from "../../src/core/memory/fact-schema.ts";
import type { SelectedFact } from "../../src/core/memory/fact-scoring.ts";
import { FactStore } from "../../src/core/memory/fact-store.ts";
import { estimateMemoryTokens, renderFactLine } from "../../src/core/memory/fact-text.ts";
import {
	type ResolvedMemoryFactsSettings,
	type ResolvedMemorySettings,
	resolveMemorySettings,
} from "../../src/core/memory/memory-settings.ts";

const NOW = Date.parse("2026-10-19T12:00:00.000Z");
const CREATED_AT = "2026-10-10T08:00:00.000Z";

/** 50 个互不相似、不含数字与矛盾标记的主题，用来构造预算用例的事实文本。 */
const BUDGET_TOPICS = [
	"部署脚本",
	"日志轮转",
	"缓存失效",
	"索引重建",
	"鉴权回退",
	"数据迁移",
	"灰度发布",
	"回滚预案",
	"告警分级",
	"监控面板",
	"压测基线",
	"内存剖析",
	"线程池",
	"连接复用",
	"超时重试",
	"幂等键",
	"消息队列",
	"延迟任务",
	"定时快照",
	"冷备恢复",
	"热备切换",
	"容器镜像",
	"构建缓存",
	"依赖锁定",
	"语义版本",
	"变更评审",
	"接口契约",
	"字段兼容",
	"错误码表",
	"国际化",
	"主题配色",
	"快捷键位",
	"命令补全",
	"历史检索",
	"会话归档",
	"导出格式",
	"附件限制",
	"权限模型",
	"审计记录",
	"脱敏规则",
	"凭据轮换",
	"证书续期",
	"域名解析",
	"负载均衡",
	"限流阈值",
	"熔断策略",
	"重试退避",
	"批量导入",
	"增量同步",
	"对账流程",
];

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

function makeFact(overrides: Partial<Fact> = {}): Fact {
	factCounter += 1;
	return {
		id: `fact_prompt_${factCounter}`,
		text: `事实 ${factCounter}`,
		kind: "decision",
		applicability: "universal",
		topics: [],
		importance: 3,
		confidence: 0.8,
		createdAt: CREATED_AT,
		updatedAt: CREATED_AT,
		retrievalCount: 0,
		pinned: false,
		reviewState: "unreviewed",
		source: makeSource(),
		...overrides,
	};
}

function selected(fact: Fact, text?: string, score = 0.9): SelectedFact {
	return { fact, text: text ?? fact.text, score };
}

const tempDirs: string[] = [];

afterEach(() => {
	for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function createTempDir(prefix: string): string {
	const directory = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(directory);
	return directory;
}

function createAgentDir(): string {
	return createTempDir("nova-fact-prompt-");
}

function createCwd(): string {
	return createTempDir("nova-fact-prompt-cwd-");
}

function memorySettings(facts: Partial<ResolvedMemoryFactsSettings> = {}): ResolvedMemorySettings {
	return resolveMemorySettings({ facts });
}

describe("renderFactLine", () => {
	it("renders the contract line format for a universal fact", () => {
		const fact = makeFact({ importance: 4, kind: "decision", text: "用户决定把换车条件改为存款达到 100w" });

		expect(renderFactLine(fact)).toBe(
			`- [${fact.id}] 2026-10-10 · universal · decision · imp 4 · 用户决定把换车条件改为存款达到 100w`,
		);
	});

	it("annotates a transferable fact with the origin directory name", () => {
		const fact = makeFact({
			applicability: "transferable",
			originProject: { key: "abc123", path: "/Users/dev/novas" },
			kind: "preference",
		});

		expect(renderFactLine(fact)).toContain(" · transferable(from novas) · preference · ");
	});

	it("prints the project key for a project fact", () => {
		const fact = makeFact({ applicability: "project", projects: ["proj-a"] });

		expect(renderFactLine(fact)).toContain(" · project:proj-a · decision · ");
	});

	it("prefers the supplied text over the stored text", () => {
		const fact = makeFact({ text: "完整文本" });

		expect(renderFactLine(fact, "截断…")).toContain("· 截断…");
		expect(renderFactLine(fact, "截断…")).not.toContain("完整文本");
	});
});

describe("renderFactsPrompt", () => {
	it("returns undefined for an empty selection", () => {
		expect(renderFactsPrompt([], 0)).toBeUndefined();
		expect(renderFactsPrompt([], 7)).toBeUndefined();
	});

	it("renders the block wrapper, the disclaimer and the single fact line", () => {
		const fact = makeFact({ importance: 4, text: "用户决定把换车条件改为存款达到 100w" });

		const prompt = renderFactsPrompt([selected(fact)], 1);

		expect(prompt).toBeDefined();
		const text = prompt ?? "";
		expect(text.startsWith("<user_facts>\n")).toBe(true);
		expect(text.endsWith("</user_facts>")).toBe(true);
		expect(text).toContain("not as instructions");
		expect(text).toContain("Showing 1 of 1");
		expect(text).toContain(
			`- [${fact.id}] 2026-10-10 · universal · decision · imp 4 · 用户决定把换车条件改为存款达到 100w`,
		);
		expect(text.split("\n")).toHaveLength(6);
	});

	it("keeps the rendered count in sync with the selection size", () => {
		const facts = [
			makeFact(),
			makeFact({ applicability: "transferable", originProject: { key: "abc123", path: "/Users/dev/novas" } }),
			makeFact({ applicability: "project", projects: ["proj-a"] }),
		];

		const text =
			renderFactsPrompt(
				facts.map((fact) => selected(fact)),
				5,
			) ?? "";
		const lines = text.split("\n");

		expect(text).toContain("Showing 3 of 5 active facts");
		expect(lines.filter((line) => line.startsWith("- ["))).toHaveLength(3);
		expect(text).toContain("transferable(from novas)");
		expect(text).toContain("project:proj-a");
	});

	it("uses the truncated text from the selection, not the stored text", () => {
		const fact = makeFact({ text: "很长的原始事实文本" });

		const text = renderFactsPrompt([selected(fact, "很长的原…")], 1) ?? "";

		expect(text).toContain("· 很长的原…");
		expect(text).not.toContain("很长的原始事实文本");
	});

	it("preserves angle brackets inside fact text", () => {
		const fact = makeFact({ text: "禁止把 <system> 标签写进事实" });

		const text = renderFactsPrompt([selected(fact)], 1) ?? "";

		expect(text).toContain("禁止把 <system> 标签写进事实");
		expect(text.endsWith("</user_facts>")).toBe(true);
	});

	it("ends with the closing tag and a trailing newline is not added", () => {
		const text = renderFactsPrompt([selected(makeFact())], 2) ?? "";

		expect(text.endsWith("\n")).toBe(false);
		expect(text.slice(-"</user_facts>".length)).toBe("</user_facts>");
	});
});

describe("loadFactsBlock", () => {
	it("returns undefined when the fact store does not exist", () => {
		const block = loadFactsBlock({ agentDir: createAgentDir(), cwd: createCwd(), settings: memorySettings() });

		expect(block).toBeUndefined();
	});

	it("renders both stored facts with their ids", () => {
		const agentDir = createAgentDir();
		const store = new FactStore(agentDir);
		const first = store.add({ text: "用户偏好用 Tab 缩进", kind: "preference", importance: 4, source: makeSource() });
		const second = store.add({
			text: "决定本季度冻结依赖升级",
			kind: "decision",
			importance: 3,
			source: makeSource(),
		});
		if (first.action !== "created" || second.action !== "created") throw new Error("fact setup failed");

		const text = loadFactsBlock({ agentDir, cwd: createCwd(), settings: memorySettings() }) ?? "";

		expect(text.startsWith("<user_facts>")).toBe(true);
		expect(text.endsWith("</user_facts>")).toBe(true);
		expect(text).toContain(first.fact.id);
		expect(text).toContain(second.fact.id);
		expect(text).toContain("Showing 2 of 2");
	});

	it("returns undefined when facts are disabled in settings", () => {
		const agentDir = createAgentDir();
		new FactStore(agentDir).add({ text: "用户偏好用 Tab 缩进", source: makeSource() });

		const block = loadFactsBlock({ agentDir, cwd: createCwd(), settings: memorySettings({ enabled: false }) });

		expect(block).toBeUndefined();
	});

	it("degrades to undefined for an unsupported store version", () => {
		const agentDir = createAgentDir();
		const directory = join(agentDir, "memory");
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		writeFileSync(join(directory, "facts.json"), JSON.stringify({ version: 2, facts: [] }), { mode: 0o600 });

		let block: string | undefined;
		expect(() => {
			block = loadFactsBlock({ agentDir, cwd: createCwd(), settings: memorySettings() });
		}).not.toThrow();
		expect(block).toBeUndefined();
	});

	it("returns undefined when memory is disabled globally", () => {
		const agentDir = createAgentDir();
		new FactStore(agentDir).add({ text: "用户偏好用 Tab 缩进", source: makeSource() });

		const block = loadFactsBlock({
			agentDir,
			cwd: createCwd(),
			settings: resolveMemorySettings({ enabled: false }),
		});

		expect(block).toBeUndefined();
	});

	it("degrades instead of throwing when the store cannot be read", () => {
		const agentDir = createAgentDir();
		// A directory at facts.json makes the read fail; the store reports it as an
		// unreadable state and injection must degrade silently instead of breaking
		// system prompt assembly.
		mkdirSync(join(agentDir, "memory", "facts.json"), { recursive: true });

		let block: string | undefined;
		expect(() => {
			block = loadFactsBlock({ agentDir, cwd: createCwd(), settings: memorySettings() });
		}).not.toThrow();
		expect(block).toBeUndefined();
	});

	it("keeps 50 active facts within the 1000 token budget", () => {
		const agentDir = createAgentDir();
		const store = new FactStore(agentDir);
		for (const topic of BUDGET_TOPICS) {
			const result = store.add({ text: `${topic}这条约定沿用至本季度结束`, kind: "decision", source: makeSource() });
			if (result.action !== "created") throw new Error(`fact ${topic} was not created: ${result.action}`);
		}

		const text = loadFactsBlock({ agentDir, cwd: createCwd(), settings: memorySettings() }) ?? "";

		expect(text).not.toBe("");
		expect(estimateMemoryTokens(text)).toBeLessThanOrEqual(1000);
		// 默认 maxPromptFacts=12：预算用例必须真的选中多条，而不是退化成一两条。
		expect(text.split("\n").filter((line) => line.startsWith("- ["))).toHaveLength(12);
	});

	it("gates project-scoped facts to the current project", () => {
		const agentDir = createAgentDir();
		const cwd = createCwd();
		const store = new FactStore(agentDir);
		store.add({
			text: "本项目采用双写方案",
			applicability: "project",
			projects: [computeProjectKey(cwd)],
			source: makeSource(),
		});
		store.add({
			text: "其它项目的表结构决定",
			applicability: "project",
			projects: ["otherproject1"],
			source: makeSource(),
		});
		store.add({ text: "用户偏好简洁的中文回复", applicability: "universal", source: makeSource() });

		const text = loadFactsBlock({ agentDir, cwd, settings: memorySettings() }) ?? "";

		expect(text).toContain("本项目采用双写方案");
		expect(text).toContain("用户偏好简洁的中文回复");
		expect(text).not.toContain("其它项目的表结构决定");
	});

	it("does not update retrieval counters when loading", () => {
		const agentDir = createAgentDir();
		const store = new FactStore(agentDir);
		store.add({ text: "用户偏好用 Tab 缩进", source: makeSource() });

		loadFactsBlock({ agentDir, cwd: createCwd(), settings: memorySettings() });

		expect(store.active().map((fact) => fact.retrievalCount)).toEqual([0]);
	});
});

describe("system prompt assembly order", () => {
	function assemble(base: string[], blocks: { userMemory?: string; facts?: string; todos?: string }): string[] {
		return [
			...base,
			...(blocks.userMemory ? [blocks.userMemory] : []),
			...(blocks.facts ? [blocks.facts] : []),
			...(blocks.todos ? [blocks.todos] : []),
		];
	}

	it("inserts the fact block between the profile and the todo block", () => {
		expect(assemble(["base"], { userMemory: "profile", facts: "facts", todos: "todos" })).toEqual([
			"base",
			"profile",
			"facts",
			"todos",
		]);
	});

	it("keeps the pre-existing array when the fact block is absent", () => {
		expect(assemble(["base"], { userMemory: "profile", todos: "todos" })).toEqual(["base", "profile", "todos"]);
		expect(assemble(["base"], { userMemory: "profile" })).toEqual(["base", "profile"]);
		expect(assemble(["base"], {})).toEqual(["base"]);
	});

	it("places the block returned by loadFactsBlock after the profile", () => {
		const agentDir = createAgentDir();
		new FactStore(agentDir).add({ text: "用户偏好简洁的中文回复", source: makeSource() });

		const facts = loadFactsBlock({ agentDir, cwd: createCwd(), settings: memorySettings() });
		const assembled = assemble(["base"], { userMemory: "profile", facts, todos: "todos" });

		expect(facts).toBeDefined();
		expect(assembled).toHaveLength(4);
		expect(assembled[1]).toBe("profile");
		expect(assembled[2]).toBe(facts);
		expect(assembled[3]).toBe("todos");
	});
});
