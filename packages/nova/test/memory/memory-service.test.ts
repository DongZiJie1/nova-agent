import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../../src/core/agent-session.ts";
import { type LifecycleEvent, LifecycleHooks } from "../../src/core/lifecycle-hooks.ts";
import type { ExtractionCompletion } from "../../src/core/memory/fact-extraction.ts";
import { projectRefForCwd } from "../../src/core/memory/fact-schema.ts";
import { FactStore } from "../../src/core/memory/fact-store.ts";
import { MEMORY_EXTRACTION_CUSTOM_TYPE, readExtractionMarker } from "../../src/core/memory/memory-marker.ts";
import { MemoryService, type MemorySessionRef } from "../../src/core/memory/memory-service.ts";
import { type MemorySettings, resolveMemorySettings } from "../../src/core/memory/memory-settings.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { UserMemoryStore } from "../../src/core/user-memory.ts";

const F1 = "Team prefers tabs for TypeScript source files";
const F2 = "Release notes must list breaking changes explicitly";
const F3 = "Prefer conventional commits across all projects";
const PROFILE_TEXT = "Team writes commit messages in English";

const tempDirs: string[] = [];
const services: MemoryService[] = [];

afterEach(async () => {
	for (const service of services.splice(0)) await service.dispose();
	for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
	vi.useRealTimers();
	vi.restoreAllMocks();
});

class FakeMemorySession implements MemorySessionRef {
	readonly sessionManager: SessionManager;
	writes = 0;

	constructor(cwd: string) {
		this.sessionManager = SessionManager.inMemory(cwd);
	}

	recordMemoryWrite(): void {
		this.writes += 1;
	}
}

interface Harness {
	service: MemoryService;
	hooks: LifecycleHooks;
	session: FakeMemorySession;
	store: FactStore;
	manager: SessionManager;
	agentDir: string;
	cwd: string;
	hookErrors: Array<{ message: string; error: unknown }>;
}

interface HarnessOptions {
	complete: ExtractionCompletion;
	settings?: MemorySettings;
}

function createHarness(options: HarnessOptions): Harness {
	const root = mkdtempSync(join(tmpdir(), "nova-memory-service-"));
	tempDirs.push(root);
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(cwd, { recursive: true });
	const session = new FakeMemorySession(cwd);
	const store = new FactStore(agentDir);
	const hookErrors: Array<{ message: string; error: unknown }> = [];
	const hooks = new LifecycleHooks((message, error) => {
		hookErrors.push({ message, error });
	});
	const service = new MemoryService({
		agentDir,
		cwd,
		session,
		settings: resolveMemorySettings(options.settings),
		store,
		complete: options.complete,
		hooks,
	});
	services.push(service);
	return { service, hooks, session, store, manager: session.sessionManager, agentDir, cwd, hookErrors };
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

function emit(
	hooks: LifecycleHooks,
	event: LifecycleEvent,
	session: FakeMemorySession,
	reason?: string,
): Promise<void> {
	return hooks.emit(event, session as unknown as AgentSession, reason);
}

function markerCount(manager: SessionManager): number {
	return manager
		.getEntries()
		.filter((entry) => entry.type === "custom" && entry.customType === MEMORY_EXTRACTION_CUSTOM_TYPE).length;
}

function factPayload(text: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		text,
		kind: "preference",
		importance: 3,
		confidence: 0.9,
		applicability: "universal",
		topics: ["style"],
		...overrides,
	};
}

function completionReturning(
	texts: string[],
	prompts?: string[],
	overrides: Record<string, unknown> = {},
): ExtractionCompletion {
	let index = 0;
	return async (input) => {
		prompts?.push(input.userPrompt);
		const text = texts[Math.min(index, texts.length - 1)];
		index += 1;
		return JSON.stringify({ facts: [factPayload(text, overrides)] });
	};
}

/** 延迟到测试手动释放的 complete；支持 abort，避免 afterEach 卡死。 */
function deferredCompletion(): { complete: ExtractionCompletion; release(value: string): void; calls(): number } {
	let release: (value: string) => void = () => {};
	let calls = 0;
	const gate = new Promise<string>((resolve) => {
		release = resolve;
	});
	const complete: ExtractionCompletion = (input) =>
		new Promise<string>((resolve, reject) => {
			calls += 1;
			if (input.signal?.aborted) {
				reject(new Error("aborted"));
				return;
			}
			input.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
			void gate.then(resolve);
		});
	return { complete, release: (value) => release(value), calls: () => calls };
}

/** 永不自行完成、只在 abort 时拒绝的 complete，用于取消测试。 */
function abortableCompletion(): { complete: ExtractionCompletion; calls(): number } {
	let calls = 0;
	const complete: ExtractionCompletion = (input) =>
		new Promise<string>((_resolve, reject) => {
			calls += 1;
			if (input.signal?.aborted) {
				reject(new Error("aborted"));
				return;
			}
			input.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
		});
	return { complete, calls: () => calls };
}

describe("MemoryService extraction", () => {
	it("extracts pending messages, writes facts and the marker, and records the memory write", async () => {
		const harness = createHarness({ complete: completionReturning([F1]) });
		const firstId = appendUser(harness.manager, "Which indentation should we use?");
		const lastId = appendAssistant(harness.manager, "Use tabs.");

		harness.service.start();
		harness.service.enqueue("manual");
		await harness.service.flush();

		const facts = harness.store.active();
		expect(facts).toHaveLength(1);
		expect(facts[0].text).toBe(F1);
		expect(facts[0].source.entryIds).toEqual([lastId]);
		expect(facts[0].source.sessionId).toBe(harness.manager.getSessionId());
		expect(facts[0].source.sessionFile).toBe("");
		expect(facts[0].source.model).toBe("extraction");
		expect(harness.session.writes).toBe(1);
		expect(harness.service.pending()).toBe(0);

		const marker = readExtractionMarker(harness.manager).marker;
		expect(marker?.fromEntryId).toBe(firstId);
		expect(marker?.throughEntryId).toBe(lastId);
		expect(marker?.model).toBe("extraction");
		expect(marker?.factIds).toEqual(facts.map((fact) => fact.id));
		expect(harness.hookErrors).toEqual([]);
	});

	it("does not extract again when there are no new messages", async () => {
		const harness = createHarness({ complete: completionReturning([F1]) });
		appendUser(harness.manager, "Which indentation should we use?");
		appendAssistant(harness.manager, "Use tabs.");

		harness.service.start();
		harness.service.enqueue("manual");
		await harness.service.flush();
		harness.service.enqueue("idle");
		await harness.service.flush();

		expect(harness.store.active()).toHaveLength(1);
		expect(markerCount(harness.manager)).toBe(1);
		expect(harness.session.writes).toBe(1);
		expect(harness.service.pending()).toBe(0);
	});

	it("only processes the interval after the marker", async () => {
		const prompts: string[] = [];
		const harness = createHarness({ complete: completionReturning([F1, F2], prompts) });
		appendUser(harness.manager, "first question about indentation");
		appendAssistant(harness.manager, "first answer");

		harness.service.start();
		harness.service.enqueue("manual");
		await harness.service.flush();

		const secondUserId = appendUser(harness.manager, "second question about release notes");
		const secondAssistantId = appendAssistant(harness.manager, "second answer");
		harness.service.enqueue("idle");
		await harness.service.flush();

		expect(prompts).toHaveLength(2);
		expect(prompts[1]).toContain("second question about release notes");
		expect(prompts[1]).not.toContain("first question about indentation");
		expect(harness.store.active()).toHaveLength(2);

		const marker = readExtractionMarker(harness.manager).marker;
		expect(marker?.fromEntryId).toBe(secondUserId);
		expect(marker?.throughEntryId).toBe(secondAssistantId);
	});

	it("fills originProject from the current cwd for transferable facts", async () => {
		const harness = createHarness({
			settings: { extraction: { model: "test/extraction-model" } },
			complete: completionReturning([F3], undefined, { applicability: "transferable" }),
		});
		appendUser(harness.manager, "Should we standardize commit messages?");
		appendAssistant(harness.manager, "Yes, conventional commits.");

		harness.service.start();
		harness.service.enqueue("manual");
		await harness.service.flush();

		const [fact] = harness.store.active();
		expect(fact.applicability).toBe("transferable");
		expect(fact.originProject).toEqual(projectRefForCwd(harness.cwd));
		expect(fact.originProject?.path).toBe(realpathSync.native(harness.cwd));
		expect(fact.source.model).toBe("test/extraction-model");
		expect(readExtractionMarker(harness.manager).marker?.model).toBe("test/extraction-model");
	});

	it("skips facts that duplicate the profile and still writes the marker with zero facts", async () => {
		const prompts: string[] = [];
		const harness = createHarness({
			complete: async (input) => {
				prompts.push(input.userPrompt);
				return JSON.stringify({ facts: [factPayload(PROFILE_TEXT)] });
			},
		});
		new UserMemoryStore(harness.agentDir).upsertSection(undefined, "Collaboration", PROFILE_TEXT);
		appendUser(harness.manager, "Do we write commit messages in English?");
		appendAssistant(harness.manager, "Yes, always English.");

		harness.service.start();
		harness.service.enqueue("manual");
		await harness.service.flush();

		expect(prompts[0]).toContain(PROFILE_TEXT);
		expect(harness.store.active()).toHaveLength(0);
		expect(harness.session.writes).toBe(0);
		const marker = readExtractionMarker(harness.manager).marker;
		expect(marker).toBeDefined();
		expect(marker?.factIds).toEqual([]);
	});

	it("archives expired facts as part of a successful extraction", async () => {
		const harness = createHarness({ complete: completionReturning([F1]) });
		const expired = new Date(Date.now() - 8 * 86_400_000).toISOString();
		const seeded = harness.store.add({
			text: "本季度内冻结依赖升级",
			kind: "constraint",
			validUntil: expired,
			source: {
				sessionFile: "",
				sessionId: "seed",
				entryIds: [],
				extractedAt: expired,
				model: "seed",
			},
		});
		if (seeded.action !== "created") throw new Error("seed fact was not created");
		appendUser(harness.manager, "Which indentation should we use?");
		appendAssistant(harness.manager, "Use tabs.");

		harness.service.start();
		harness.service.enqueue("manual");
		await harness.service.flush();

		const archived = harness.store.get(seeded.fact.id);
		expect(archived?.archivedAt).toBeDefined();
		expect(archived?.archiveReason).toBe("expired");
	});
});

describe("MemoryService queue", () => {
	it("merges repeated enqueues into a single extraction", async () => {
		const deferred = deferredCompletion();
		const harness = createHarness({ complete: deferred.complete });
		appendUser(harness.manager, "Which indentation should we use?");
		appendAssistant(harness.manager, "Use tabs.");

		harness.service.start();
		harness.service.enqueue("idle");
		harness.service.enqueue("compaction");
		harness.service.enqueue("manual");
		await Promise.resolve();
		expect(deferred.calls()).toBe(1);

		deferred.release(JSON.stringify({ facts: [factPayload(F1)] }));
		await harness.service.flush();

		expect(deferred.calls()).toBe(1);
		expect(harness.store.active()).toHaveLength(1);
		expect(markerCount(harness.manager)).toBe(1);
		expect(harness.service.pending()).toBe(0);
	});

	it("logs model failures without a marker and clears pending", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const harness = createHarness({
			complete: async () => {
				throw new Error("model unavailable");
			},
		});
		appendUser(harness.manager, "Which indentation should we use?");
		appendAssistant(harness.manager, "Use tabs.");

		harness.service.start();
		harness.service.enqueue("idle");
		await harness.service.flush();

		expect(harness.store.active()).toHaveLength(0);
		expect(readExtractionMarker(harness.manager).marker).toBeUndefined();
		expect(harness.session.writes).toBe(0);
		expect(harness.service.pending()).toBe(0);
		expect(errorSpy).toHaveBeenCalledTimes(1);
		const [message, error] = errorSpy.mock.calls[0];
		expect(message).toBe("[memory:extract]");
		expect(error).toBeInstanceOf(Error);
		expect(harness.hookErrors).toEqual([]);
	});

	it("session_end waits for the in-progress extraction before disposing", async () => {
		const deferred = deferredCompletion();
		const harness = createHarness({ complete: deferred.complete });
		appendUser(harness.manager, "Which indentation should we use?");
		const lastId = appendAssistant(harness.manager, "Use tabs.");

		harness.service.start();
		harness.service.enqueue("manual");
		await Promise.resolve();
		expect(deferred.calls()).toBe(1);

		const ended = emit(harness.hooks, "session_end", harness.session);
		await Promise.resolve();
		expect(harness.store.active()).toHaveLength(0);

		deferred.release(JSON.stringify({ facts: [factPayload(F1)] }));
		await ended;

		expect(harness.store.active()).toHaveLength(1);
		expect(readExtractionMarker(harness.manager).marker?.throughEntryId).toBe(lastId);
		expect(harness.service.pending()).toBe(0);

		harness.service.enqueue("manual");
		await harness.service.flush();
		expect(deferred.calls()).toBe(1);
	});

	it("dispose aborts the running extraction, unsubscribes and ignores later enqueues", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const abortable = abortableCompletion();
		const harness = createHarness({ complete: abortable.complete });
		appendUser(harness.manager, "Which indentation should we use?");
		appendAssistant(harness.manager, "Use tabs.");

		harness.service.start();
		harness.service.enqueue("manual");
		await Promise.resolve();
		expect(abortable.calls()).toBe(1);

		await harness.service.dispose();
		expect(harness.service.pending()).toBe(0);

		harness.service.enqueue("manual");
		await harness.service.flush();
		await emit(harness.hooks, "agent_idle", harness.session);
		await harness.service.flush();

		expect(abortable.calls()).toBe(1);
		expect(harness.store.active()).toHaveLength(0);
		expect(readExtractionMarker(harness.manager).marker).toBeUndefined();
		// 主动取消不算失败，不应写错误日志。
		expect(errorSpy).not.toHaveBeenCalled();
	});
});

describe("MemoryService hooks", () => {
	it("triggers extraction after the idle delay and on before_compaction", async () => {
		vi.useFakeTimers();
		const harness = createHarness({ complete: completionReturning([F1, F2]) });
		appendUser(harness.manager, "Which indentation should we use?");
		appendAssistant(harness.manager, "Use tabs.");

		harness.service.start();
		await emit(harness.hooks, "agent_idle", harness.session);
		// agent_idle only schedules; the model must not run yet.
		expect(harness.service.pending()).toBe(0);
		expect(harness.store.active()).toHaveLength(0);

		await vi.advanceTimersByTimeAsync(8 * 60_000);
		await harness.service.flush();
		expect(harness.store.active()).toHaveLength(1);

		appendUser(harness.manager, "What belongs in the release notes?");
		appendAssistant(harness.manager, "List breaking changes.");
		await emit(harness.hooks, "before_compaction", harness.session, "auto");
		await harness.service.flush();

		expect(harness.store.active()).toHaveLength(2);
		expect(markerCount(harness.manager)).toBe(2);
	});

	it("cancels a pending idle extraction when a new turn starts", async () => {
		vi.useFakeTimers();
		const harness = createHarness({ complete: completionReturning([F1]) });
		appendUser(harness.manager, "Which indentation should we use?");
		appendAssistant(harness.manager, "Use tabs.");

		harness.service.start();
		await emit(harness.hooks, "agent_idle", harness.session);
		await vi.advanceTimersByTimeAsync(7 * 60_000);
		// A new turn means the user is still active; the scheduled idle work is dropped.
		await emit(harness.hooks, "turn_end", harness.session);
		await vi.advanceTimersByTimeAsync(5 * 60_000);
		await harness.service.flush();

		expect(harness.store.active()).toHaveLength(0);
	});

	it("triggers extraction every checkpointTurns turns and registers once", async () => {
		let calls = 0;
		const harness = createHarness({
			settings: { extraction: { checkpointTurns: 2 } },
			complete: async () => {
				calls += 1;
				return JSON.stringify({ facts: [factPayload(F1)] });
			},
		});
		appendUser(harness.manager, "Which indentation should we use?");
		appendAssistant(harness.manager, "Use tabs.");

		harness.service.start();
		// 重复 start 不应重复注册：否则一次 turn_end 会把计数加两次。
		harness.service.start();
		await emit(harness.hooks, "turn_end", harness.session);
		await harness.service.flush();
		expect(calls).toBe(0);

		await emit(harness.hooks, "turn_end", harness.session);
		await harness.service.flush();
		expect(calls).toBe(1);
		expect(harness.store.active()).toHaveLength(1);
	});

	it("ignores lifecycle events from another session", async () => {
		let calls = 0;
		const harness = createHarness({
			complete: async () => {
				calls += 1;
				return JSON.stringify({ facts: [factPayload(F1)] });
			},
		});
		appendUser(harness.manager, "Which indentation should we use?");
		appendAssistant(harness.manager, "Use tabs.");

		harness.service.start();
		const other = new FakeMemorySession(harness.cwd);
		await emit(harness.hooks, "agent_idle", other);
		await emit(harness.hooks, "turn_end", other);
		await emit(harness.hooks, "before_compaction", other);
		await harness.service.flush();

		expect(calls).toBe(0);
		expect(harness.store.active()).toHaveLength(0);
		expect(harness.service.pending()).toBe(0);
	});

	it("does not register hooks when extraction is disabled", async () => {
		let calls = 0;
		const harness = createHarness({
			settings: { extraction: { enabled: false } },
			complete: async () => {
				calls += 1;
				return JSON.stringify({ facts: [factPayload(F1)] });
			},
		});
		appendUser(harness.manager, "Which indentation should we use?");
		appendAssistant(harness.manager, "Use tabs.");

		harness.service.start();
		await emit(harness.hooks, "agent_idle", harness.session);
		await emit(harness.hooks, "turn_end", harness.session);
		await emit(harness.hooks, "before_compaction", harness.session);
		await emit(harness.hooks, "session_end", harness.session);
		await harness.service.flush();

		expect(calls).toBe(0);
		expect(harness.store.active()).toHaveLength(0);
	});

	it("does not register hooks when facts are disabled", async () => {
		let calls = 0;
		const harness = createHarness({
			settings: { facts: { enabled: false } },
			complete: async () => {
				calls += 1;
				return JSON.stringify({ facts: [factPayload(F1)] });
			},
		});
		appendUser(harness.manager, "Which indentation should we use?");
		appendAssistant(harness.manager, "Use tabs.");

		harness.service.start();
		await emit(harness.hooks, "agent_idle", harness.session);
		await harness.service.flush();

		expect(calls).toBe(0);
		expect(harness.store.active()).toHaveLength(0);
	});
});
