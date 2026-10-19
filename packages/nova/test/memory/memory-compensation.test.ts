import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtractionCompletion } from "../../src/core/memory/fact-extraction.ts";
import { FactStore } from "../../src/core/memory/fact-store.ts";
import { findSessionsNeedingExtraction, runStartupCompensation } from "../../src/core/memory/memory-compensation.ts";
import {
	appendExtractionMarker,
	MEMORY_EXTRACTION_CUSTOM_TYPE,
	readExtractionMarker,
} from "../../src/core/memory/memory-marker.ts";
import { resolveMemorySettings } from "../../src/core/memory/memory-settings.ts";
import { SessionManager } from "../../src/core/session-manager.ts";

type CompensationOptions = Parameters<typeof runStartupCompensation>[0];

const FACT_TEXT = "Team prefers tabs for TypeScript source files";

const cleanups: Array<() => void> = [];

afterEach(() => {
	while (cleanups.length > 0) cleanups.pop()?.();
});

interface Workspace {
	root: string;
	agentDir: string;
	cwd: string;
	sessionDir: string;
	store: FactStore;
}

/** 每个用例一套独立目录，避免模块级 "每个 sessionDir 只跑一次" 的登记互相干扰。 */
function workspace(): Workspace {
	const root = mkdtempSync(join(tmpdir(), "nova-memory-compensation-"));
	cleanups.push(() => rmSync(root, { recursive: true, force: true }));
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	const sessionDir = join(root, "sessions");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(cwd, { recursive: true });
	mkdirSync(sessionDir, { recursive: true });
	return { root, agentDir, cwd, sessionDir, store: new FactStore(agentDir) };
}

function factPayload(text: string): Record<string, unknown> {
	return {
		text,
		kind: "preference",
		importance: 3,
		confidence: 0.9,
		applicability: "universal",
		topics: ["style"],
	};
}

/** 假 complete：不调真实模型，固定返回一条合法事实。 */
function completionReturning(text: string): ExtractionCompletion {
	return async () => JSON.stringify({ facts: [factPayload(text)] });
}

interface SessionFixture {
	path: string;
	userId: string;
	assistantId: string;
}

/** 用 SessionManager 造一个真正落盘的会话；只有 user + assistant 两条消息。 */
function createSession(
	ws: Workspace,
	options: { sessionDir?: string; user?: string; assistant?: string } = {},
): SessionFixture {
	const manager = SessionManager.create(ws.cwd, options.sessionDir ?? ws.sessionDir);
	const userId = manager.appendMessage({
		role: "user",
		content: options.user ?? "Which indentation should we use?",
		timestamp: Date.now(),
	});
	const assistantId = manager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: options.assistant ?? "Use tabs." }],
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
	const path = manager.getSessionFile();
	if (path === undefined) throw new Error("session file was not created");
	return { path, userId, assistantId };
}

function compensationOptions(ws: Workspace, complete: ExtractionCompletion): CompensationOptions {
	return {
		agentDir: ws.agentDir,
		sessionDir: ws.sessionDir,
		settings: resolveMemorySettings(undefined),
		store: ws.store,
		complete,
	};
}

function markerThrough(sessionFile: string): string | undefined {
	return readExtractionMarker(SessionManager.open(sessionFile)).marker?.throughEntryId;
}

describe("findSessionsNeedingExtraction", () => {
	it("reports sessions that still have unextracted messages", () => {
		const ws = workspace();
		const { path } = createSession(ws);

		const candidates = findSessionsNeedingExtraction({ sessionDir: ws.sessionDir });

		expect(candidates).toHaveLength(1);
		expect(candidates[0].sessionFile).toBe(path);
		expect(candidates[0].pendingMessages).toBe(2);
		expect(Number.isNaN(Date.parse(candidates[0].lastActivityAt))).toBe(false);
	});

	it("skips a session whose marker already covers the last message", () => {
		const ws = workspace();
		const { path, assistantId } = createSession(ws);
		appendExtractionMarker(
			{ sessionManager: SessionManager.open(path) },
			{ throughEntryId: assistantId, at: new Date().toISOString(), factIds: [] },
		);

		expect(findSessionsNeedingExtraction({ sessionDir: ws.sessionDir })).toEqual([]);
	});

	it("skips a session owned by a live process", () => {
		const ws = workspace();
		const { path } = createSession(ws);
		writeFileSync(`${path}.active.${process.pid}.json`, JSON.stringify({ pid: process.pid }));

		expect(findSessionsNeedingExtraction({ sessionDir: ws.sessionDir })).toEqual([]);
	});

	it("ignores record files, ownership markers and non-jsonl files", () => {
		const ws = workspace();
		const { path } = createSession(ws);
		const content = readFileSync(path, "utf8");
		writeFileSync(join(ws.sessionDir, "old.jsonl.record.json"), content);
		writeFileSync(join(ws.sessionDir, "other.jsonl.active.424242.json"), content);
		writeFileSync(join(ws.sessionDir, "notes.txt"), content);

		const candidates = findSessionsNeedingExtraction({ sessionDir: ws.sessionDir });

		expect(candidates.map((candidate) => candidate.sessionFile)).toEqual([path]);
	});

	it("scans nested directories and tolerates a missing directory", () => {
		const ws = workspace();
		const nested = join(ws.sessionDir, "nested", "deeper");
		const { path } = createSession(ws, { sessionDir: nested });

		expect(findSessionsNeedingExtraction({ sessionDir: ws.sessionDir }).map((item) => item.sessionFile)).toEqual([
			path,
		]);
		expect(findSessionsNeedingExtraction({ sessionDir: join(ws.root, "missing") })).toEqual([]);
	});

	it("returns nothing for an empty session directory (`--no-session`)", () => {
		const ws = workspace();
		createSession(ws);

		expect(findSessionsNeedingExtraction({ sessionDir: "" })).toEqual([]);
		expect(findSessionsNeedingExtraction({ sessionDir: ws.sessionDir, maxSessions: 0 })).toEqual([]);
	});

	it("keeps only the newest sessions up to maxSessions", () => {
		const ws = workspace();
		const oldest = createSession(ws);
		const middle = createSession(ws);
		const newest = createSession(ws);
		const base = Math.floor(Date.now() / 1000) - 1000;
		utimesSync(oldest.path, base - 300, base - 300);
		utimesSync(middle.path, base - 200, base - 200);
		utimesSync(newest.path, base - 100, base - 100);

		const candidates = findSessionsNeedingExtraction({ sessionDir: ws.sessionDir, maxSessions: 2 });

		expect(candidates.map((candidate) => candidate.sessionFile)).toEqual([newest.path, middle.path]);
		const [first, second] = candidates;
		expect(Date.parse(first.lastActivityAt)).toBeGreaterThanOrEqual(Date.parse(second.lastActivityAt));
	});
});

describe("runStartupCompensation", () => {
	it("extracts a killed session and appends only the marker entry", async () => {
		const ws = workspace();
		const { path, assistantId } = createSession(ws);
		const before = readFileSync(path, "utf8");

		const result = await runStartupCompensation(compensationOptions(ws, completionReturning(FACT_TEXT)));

		expect(result).toEqual({ processed: 1, created: 1, failed: 0 });
		const facts = ws.store.active();
		expect(facts).toHaveLength(1);
		expect(facts[0].text).toBe(FACT_TEXT);
		expect(facts[0].source.model).toBe("startup");
		expect(facts[0].source.sessionFile).toBe(path);
		expect(facts[0].source.entryIds).toEqual([assistantId]);

		// 已有消息条目逐字节保留，只多出一行自定义标记。
		const after = readFileSync(path, "utf8");
		expect(after.startsWith(before)).toBe(true);
		const added = after.slice(before.length).trim().split("\n");
		expect(added).toHaveLength(1);
		expect(JSON.parse(added[0])).toMatchObject({ type: "custom", customType: MEMORY_EXTRACTION_CUSTOM_TYPE });
		expect(markerThrough(path)).toBe(assistantId);
	});

	it("does not touch a session whose marker is already up to date", async () => {
		const ws = workspace();
		const { path, assistantId } = createSession(ws);
		appendExtractionMarker(
			{ sessionManager: SessionManager.open(path) },
			{ throughEntryId: assistantId, at: new Date().toISOString(), factIds: [] },
		);
		let calls = 0;
		const complete: ExtractionCompletion = async () => {
			calls += 1;
			return JSON.stringify({ facts: [factPayload(FACT_TEXT)] });
		};

		const result = await runStartupCompensation(compensationOptions(ws, complete));

		expect(result).toEqual({ processed: 0, created: 0, failed: 0 });
		expect(calls).toBe(0);
		expect(ws.store.active()).toHaveLength(0);
	});

	it("skips sessions with a live ownership marker", async () => {
		const ws = workspace();
		const { path } = createSession(ws);
		writeFileSync(`${path}.active.${process.pid}.json`, JSON.stringify({ pid: process.pid }));
		let calls = 0;
		const complete: ExtractionCompletion = async () => {
			calls += 1;
			return JSON.stringify({ facts: [factPayload(FACT_TEXT)] });
		};

		const result = await runStartupCompensation(compensationOptions(ws, complete));

		expect(result).toEqual({ processed: 0, created: 0, failed: 0 });
		expect(calls).toBe(0);
		expect(markerThrough(path)).toBeUndefined();
	});

	it("counts a corrupt session as failed and keeps processing the rest", async () => {
		const ws = workspace();
		const { path, assistantId } = createSession(ws);
		const broken = join(ws.sessionDir, "broken.jsonl");
		writeFileSync(broken, '{"type":"session","version":3,"id":');
		const diagnostics: string[] = [];

		const result = await runStartupCompensation({
			...compensationOptions(ws, completionReturning(FACT_TEXT)),
			onDiagnostic: (message: string) => diagnostics.push(message),
		});

		expect(result).toEqual({ processed: 1, created: 1, failed: 1 });
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0]).toContain("broken.jsonl");
		// 有效会话不受损坏文件影响。
		expect(markerThrough(path)).toBe(assistantId);
		expect(ws.store.active()).toHaveLength(1);
	});

	it("processes only the newest sessions when maxSessions is set", async () => {
		const ws = workspace();
		const oldest = createSession(ws);
		const middle = createSession(ws);
		const newest = createSession(ws);
		const base = Math.floor(Date.now() / 1000) - 1000;
		utimesSync(oldest.path, base - 300, base - 300);
		utimesSync(middle.path, base - 200, base - 200);
		utimesSync(newest.path, base - 100, base - 100);

		const result = await runStartupCompensation({
			...compensationOptions(ws, completionReturning(FACT_TEXT)),
			maxSessions: 2,
		});

		expect(result.processed).toBe(2);
		expect(result.failed).toBe(0);
		expect(markerThrough(middle.path)).toBe(middle.assistantId);
		expect(markerThrough(newest.path)).toBe(newest.assistantId);
		expect(markerThrough(oldest.path)).toBeUndefined();
	});

	it("scans each session directory only once per process", async () => {
		const ws = workspace();
		createSession(ws);
		let calls = 0;
		const complete: ExtractionCompletion = async () => {
			calls += 1;
			return JSON.stringify({ facts: [factPayload(FACT_TEXT)] });
		};
		const options = compensationOptions(ws, complete);

		const first = await runStartupCompensation(options);
		const second = await runStartupCompensation(options);

		expect(first).toEqual({ processed: 1, created: 1, failed: 0 });
		expect(second).toEqual({ processed: 0, created: 0, failed: 0 });
		expect(calls).toBe(1);
	});

	it("stops without counting failures once the signal is aborted", async () => {
		const ws = workspace();
		const { path } = createSession(ws);
		const controller = new AbortController();
		controller.abort();

		const result = await runStartupCompensation({
			...compensationOptions(ws, completionReturning(FACT_TEXT)),
			signal: controller.signal,
		});

		expect(result).toEqual({ processed: 0, created: 0, failed: 0 });
		expect(markerThrough(path)).toBeUndefined();
	});
});
