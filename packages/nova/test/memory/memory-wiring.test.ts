import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@dongzijie1/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import { lifecycleHooks } from "../../src/core/lifecycle-hooks.ts";
import { FactStore } from "../../src/core/memory/fact-store.ts";
import { MemoryService } from "../../src/core/memory/memory-service.ts";
import {
	createMemoryCompletion,
	createMemoryServiceForSession,
	startMemoryForSession,
} from "../../src/core/memory/memory-wiring.ts";
import type { Settings } from "../../src/core/settings-manager.ts";
import { createHarness, type Harness } from "../suite/harness.ts";

const FACT_TEXT = "Team prefers tabs for TypeScript source files";

const tempDirs: string[] = [];
const services: MemoryService[] = [];
const harnesses: Harness[] = [];

afterEach(async () => {
	for (const service of services.splice(0)) await service.dispose();
	for (const harness of harnesses.splice(0)) harness.cleanup();
	for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
	vi.restoreAllMocks();
});

interface WiringHarness {
	harness: Harness;
	agentDir: string;
	cwd: string;
}

/** 每个用例一个临时 agentDir，绝不落到真实的 ~/.nova。 */
async function createWiringHarness(options: { settings?: Partial<Settings> } = {}): Promise<WiringHarness> {
	const root = mkdtempSync(join(tmpdir(), "nova-memory-wiring-"));
	tempDirs.push(root);
	const agentDir = join(root, "agent");
	mkdirSync(agentDir, { recursive: true });
	const harness = await createHarness(options.settings === undefined ? {} : { settings: options.settings });
	harnesses.push(harness);
	return { harness, agentDir, cwd: harness.tempDir };
}

function appendUser(harness: Harness, text: string): string {
	return harness.sessionManager.appendMessage({ role: "user", content: text, timestamp: Date.now() });
}

function appendAssistant(harness: Harness, text: string): string {
	return harness.sessionManager.appendMessage({
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

function extractionResponse(text: string): ReturnType<typeof fauxAssistantMessage> {
	return fauxAssistantMessage(
		JSON.stringify({
			facts: [
				{
					text,
					kind: "preference",
					importance: 3,
					confidence: 0.9,
					applicability: "universal",
					topics: ["style"],
				},
			],
		}),
	);
}

function track(service: MemoryService | undefined): MemoryService {
	expect(service).toBeInstanceOf(MemoryService);
	services.push(service!);
	return service!;
}

describe("createMemoryServiceForSession", () => {
	it("returns a service for the default settings and accepts enqueues after start", async () => {
		const { harness, agentDir, cwd } = await createWiringHarness();

		expect(createMemoryCompletion(harness.session, harness.settingsManager.getMemorySettings())).toBeTypeOf(
			"function",
		);

		const service = track(
			createMemoryServiceForSession({
				session: harness.session,
				agentDir,
				cwd,
				settingsManager: harness.settingsManager,
			}),
		);
		service.start();
		service.enqueue("manual");
		await service.flush();

		// 会话里没有待抽取的消息，任务不调用模型也要把队列清空。
		expect(service.pending()).toBe(0);
	});

	it("returns undefined when facts are disabled", async () => {
		const { harness, agentDir, cwd } = await createWiringHarness({
			settings: { memory: { facts: { enabled: false } } },
		});

		const service = createMemoryServiceForSession({
			session: harness.session,
			agentDir,
			cwd,
			settingsManager: harness.settingsManager,
		});

		expect(service).toBeUndefined();
		expect(
			startMemoryForSession({ session: harness.session, agentDir, cwd, settingsManager: harness.settingsManager }),
		).toBeUndefined();
	});

	it("keeps injection when extraction is disabled", async () => {
		const { harness, agentDir, cwd } = await createWiringHarness({
			settings: { memory: { extraction: { enabled: false } } },
		});
		const registerSpy = vi.spyOn(lifecycleHooks, "register");

		track(
			startMemoryForSession({ session: harness.session, agentDir, cwd, settingsManager: harness.settingsManager }),
		);

		// 关闭抽取只停掉四个抽取钩子，首条消息的注入钩子仍然注册。
		expect(registerSpy.mock.calls.map(([event]) => event)).toEqual(["after_user_message"]);
	});

	it("returns undefined when the session has no model", async () => {
		const { harness, agentDir, cwd } = await createWiringHarness();
		harness.session.agent.state.model = undefined as unknown as NonNullable<Harness["session"]["model"]>;

		expect(createMemoryCompletion(harness.session, harness.settingsManager.getMemorySettings())).toBeUndefined();
		expect(
			createMemoryServiceForSession({
				session: harness.session,
				agentDir,
				cwd,
				settingsManager: harness.settingsManager,
			}),
		).toBeUndefined();
		expect(
			startMemoryForSession({ session: harness.session, agentDir, cwd, settingsManager: harness.settingsManager }),
		).toBeUndefined();
	});
});

describe("startMemoryForSession", () => {
	it("runs a full extraction through the real model call and stores the fact", async () => {
		const { harness, agentDir, cwd } = await createWiringHarness();
		harness.setResponses([extractionResponse(FACT_TEXT)]);
		appendUser(harness, "Which indentation should we use?");
		appendAssistant(harness, "Use tabs.");

		const service = track(
			startMemoryForSession({ session: harness.session, agentDir, cwd, settingsManager: harness.settingsManager }),
		);
		service.enqueue("manual");
		await service.flush();

		const facts = new FactStore(agentDir).active();
		expect(facts).toHaveLength(1);
		expect(facts[0].text).toBe(FACT_TEXT);
		expect(facts[0].kind).toBe("preference");
		expect(facts[0].source.model).toBe("extraction");
		expect(harness.session.getSessionStats().memoryWrites).toBe(1);
		expect(service.pending()).toBe(0);
	});

	it("creates only one service, and one set of hooks, per session", async () => {
		const { harness, agentDir, cwd } = await createWiringHarness();
		const registerSpy = vi.spyOn(lifecycleHooks, "register");

		const first = track(
			startMemoryForSession({ session: harness.session, agentDir, cwd, settingsManager: harness.settingsManager }),
		);
		const second = startMemoryForSession({
			session: harness.session,
			agentDir,
			cwd,
			settingsManager: harness.settingsManager,
		});

		expect(second).toBe(first);
		// after_user_message / turn_end / agent_idle / before_compaction / session_end，各一次。
		expect(registerSpy).toHaveBeenCalledTimes(5);
	});
});
