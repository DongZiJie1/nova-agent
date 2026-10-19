import { spawn } from "node:child_process";
import { once } from "node:events";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@dongzijie1/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LifecycleHooks, lifecycleHooks } from "../../src/core/lifecycle-hooks.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import {
	beginSessionRecord,
	finishSessionRecord,
	reconcileSessionRecords,
	type SessionRecord,
	sessionRecordPath,
} from "../../src/core/session-records.ts";
import { collectSessionStats } from "../../src/core/session-statistics.ts";
import { createHarness } from "./harness.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
	while (cleanups.length) cleanups.pop()?.();
	vi.useRealTimers();
});

function directory() {
	const root = mkdtempSync(join(tmpdir(), "nova-foundation-"));
	cleanups.push(() => rmSync(root, { recursive: true, force: true }));
	return root;
}

function readRecord(path: string): SessionRecord {
	return JSON.parse(readFileSync(sessionRecordPath(path), "utf8"));
}

describe("internal lifecycle hooks", () => {
	it("runs before manual and automatic compaction and preserves accounting", async () => {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", (event) => ({
						compaction: {
							summary: "summary",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
						},
					}));
				},
			],
		});
		cleanups.push(harness.cleanup);
		const reasons: Array<string | undefined> = [];
		cleanups.push(
			lifecycleHooks.register("before_compaction", {
				name: "memory",
				timeoutMs: 100,
				handler: ({ session, reason }) => {
					if (session !== harness.session) return;
					reasons.push(reason);
					session.recordMemoryWrite();
				},
			}),
		);
		harness.setResponses([
			fauxAssistantMessage("one"),
			fauxAssistantMessage("two"),
			fauxAssistantMessage("three"),
			fauxAssistantMessage("four"),
		]);
		await harness.session.prompt("one");
		await harness.session.prompt("two");
		await harness.session.compact();
		await harness.session.prompt("three");
		await harness.session.prompt("four");
		const internal = harness.session as unknown as {
			_runAutoCompaction: (reason: "threshold", willRetry: boolean) => Promise<boolean>;
		};
		await internal._runAutoCompaction("threshold", false);
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(2);
		expect(reasons).toEqual(["manual", "threshold"]);
		expect(harness.session.getSessionStats()).toMatchObject({ turns: 4, memoryWrites: 2 });
	});

	it("counts calls by tool across branches and compaction without counting results twice", async () => {
		const harness = await createHarness();
		cleanups.push(harness.cleanup);
		const model = harness.getModel();
		const message = { ...fauxAssistantMessage(""), api: model.api, provider: model.provider, model: model.id };
		const root = harness.sessionManager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
		harness.sessionManager.appendMessage({
			...message,
			content: [
				{ type: "toolCall", id: "one", name: "read", arguments: {} },
				{ type: "toolCall", id: "two", name: "read", arguments: {} },
				{ type: "toolCall", id: "three", name: "bash", arguments: {} },
			],
		});
		harness.sessionManager.appendCompaction("summary", root, 10);
		harness.sessionManager.branch(root);
		harness.sessionManager.appendMessage(message);
		expect(harness.session.getSessionStats()).toMatchObject({
			turns: 2,
			toolCalls: 3,
			toolCallDistribution: { read: 2, bash: 1 },
		});
	});

	it("awaits registration order, isolates synchronous/asynchronous errors and supports unsubscribe", async () => {
		const harness = await createHarness();
		cleanups.push(harness.cleanup);
		const log = vi.fn();
		const hooks = new LifecycleHooks(log);
		const order: number[] = [];
		hooks.register("turn_end", {
			name: "first",
			timeoutMs: 100,
			handler: async () => {
				await Promise.resolve();
				order.push(1);
				throw new Error("async");
			},
		});
		hooks.register("turn_end", {
			name: "second",
			timeoutMs: 100,
			handler: () => {
				order.push(2);
				throw new Error("sync");
			},
		});
		const unsubscribe = hooks.register("turn_end", {
			name: "removed",
			timeoutMs: 100,
			handler: () => {
				order.push(3);
			},
		});
		unsubscribe();
		hooks.register("turn_end", {
			name: "last",
			timeoutMs: 100,
			handler: () => {
				order.push(4);
			},
		});
		await hooks.emit("turn_end", harness.session);
		expect(order).toEqual([1, 2, 4]);
		expect(log).toHaveBeenCalledTimes(2);
	});

	it("aborts a timed-out handler and continues even when logging throws", async () => {
		const harness = await createHarness();
		cleanups.push(harness.cleanup);
		vi.useFakeTimers();
		const hooks = new LifecycleHooks(() => {
			throw new Error("logger");
		});
		let signal: AbortSignal | undefined;
		const next = vi.fn();
		hooks.register("agent_idle", {
			name: "hung",
			timeoutMs: 25,
			handler: (context) => {
				signal = context.signal;
				return new Promise(() => {});
			},
		});
		hooks.register("agent_idle", { name: "next", timeoutMs: 100, handler: next });
		const emission = hooks.emit("agent_idle", harness.session);
		await vi.advanceTimersByTimeAsync(25);
		await emission;
		expect(signal?.aborted).toBe(true);
		expect(next).toHaveBeenCalledOnce();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("emits start once, round completion, idle, and end once with final memory accounting", async () => {
		const harness = await createHarness();
		cleanups.push(harness.cleanup);
		const seen: string[] = [];
		for (const event of ["session_start", "turn_end", "agent_idle", "session_end"] as const) {
			cleanups.push(
				lifecycleHooks.register(event, {
					name: "test",
					timeoutMs: 100,
					handler: ({ session }) => {
						if (session !== harness.session) return;
						seen.push(event);
						if (event === "session_end") session.recordMemoryWrite();
					},
				}),
			);
		}
		harness.setResponses([fauxAssistantMessage("ok")]);
		await harness.session.prompt("hello");
		await harness.session.startLifecycle();
		await Promise.all([harness.session.endLifecycle("quit"), harness.session.endLifecycle("quit")]);
		expect(seen).toEqual(["session_start", "turn_end", "agent_idle", "session_end"]);
		const snapshot = harness.session.getSessionStats();
		expect(snapshot.turns).toBe(1);
		expect(snapshot.memoryWrites).toBe(1);
		expect(snapshot.startedAt).toBe(harness.sessionManager.getHeader()!.timestamp);
		expect(snapshot.endedAt).toBeDefined();
		expect(snapshot.lastActivityAt).toBe(harness.sessionManager.getEntries().at(-1)!.timestamp);
	});
});

describe("local session records", () => {
	async function persisted() {
		const harness = await createHarness();
		cleanups.push(harness.cleanup);
		harness.setResponses([fauxAssistantMessage("ok")]);
		await harness.session.prompt("hello");
		const root = directory();
		const manager = SessionManager.create(root, root);
		for (const entry of harness.sessionManager.getEntries()) {
			if (
				entry.type === "message" &&
				(entry.message.role === "user" || entry.message.role === "assistant" || entry.message.role === "toolResult")
			)
				manager.appendMessage(entry.message);
		}
		return { root, manager, path: manager.getSessionFile()! };
	}

	it("writes one stable normal record matching entries and preserves it across reconciliation", async () => {
		const { root, manager, path } = await persisted();
		beginSessionRecord(manager);
		const endedAt = new Date().toISOString();
		finishSessionRecord(manager, "quit", endedAt);
		const expected = { ...collectSessionStats(manager, endedAt), reason: "quit", abnormalEnd: false };
		expect(readRecord(path)).toEqual(expected);
		expect(statSync(sessionRecordPath(path)).mode & 0o777).toBe(0o600);
		reconcileSessionRecords(root);
		expect(readRecord(path)).toEqual(expected);
		expect(existsSync(`${path}.active.json`)).toBe(false);
	});

	it("recovers a truncated final entry without rewriting the session or accepting empty files", async () => {
		const { root, path } = await persisted();
		appendFileSync(path, '{"type":"message"');
		const original = readFileSync(path, "utf8");
		const emptyPath = join(root, "empty.jsonl");
		writeFileSync(emptyPath, "");
		reconcileSessionRecords(root);
		expect(readRecord(path)).toMatchObject({ abnormalEnd: true, userMessages: 1, assistantMessages: 1 });
		expect(readFileSync(path, "utf8")).toBe(original);
		expect(existsSync(sessionRecordPath(emptyPath))).toBe(false);
	});

	it("recovers legacy sessions without an owner or end record exactly once", async () => {
		const { root, manager, path } = await persisted();
		reconcileSessionRecords(root);
		const record = readRecord(path);
		expect(record).toEqual({
			...collectSessionStats(manager, record.lastActivityAt),
			reason: "startup_recovery",
			abnormalEnd: true,
		});
		reconcileSessionRecords(root);
		expect(readRecord(path)).toEqual(record);
	});

	it("skips a live process and recovers a SIGKILLed resumed session over its previous end record", async () => {
		const { manager, path } = await persisted();
		finishSessionRecord(manager, "quit", new Date().toISOString());
		const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
		cleanups.push(() => {
			child.kill("SIGKILL");
		});
		await once(child, "spawn");
		writeFileSync(`${path}.active.json`, JSON.stringify({ pid: child.pid }));
		// Fresh roots model separate startups while keeping once-per-directory scan semantics.
		const liveRoot = directory();
		const livePath = join(liveRoot, "live.jsonl");
		writeFileSync(livePath, readFileSync(path));
		writeFileSync(`${livePath}.active.json`, JSON.stringify({ pid: child.pid }));
		reconcileSessionRecords(liveRoot);
		expect(existsSync(sessionRecordPath(livePath))).toBe(false);
		const exit = once(child, "exit");
		child.kill("SIGKILL");
		await exit;
		reconcileSessionRecords(manager.getSessionDir());
		expect(readRecord(path).abnormalEnd).toBe(true);
		expect(existsSync(`${path}.active.json`)).toBe(false);
	});
});
