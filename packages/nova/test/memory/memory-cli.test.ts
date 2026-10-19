import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Fact, FactSource } from "../../src/core/memory/fact-schema.ts";
import { type AddFactResult, type FactDraft, FactStore } from "../../src/core/memory/fact-store.ts";
import { appendExtractionMarker } from "../../src/core/memory/memory-marker.ts";
import { getDefaultSessionDir, SessionManager } from "../../src/core/session-manager.ts";
import { handleMemoryCommand } from "../../src/memory-cli.ts";

const TABS_TEXT = "Team prefers tabs for TypeScript source files";
const RELEASE_TEXT = "Release cadence ships every two weeks on Thursday";
const PUSH_TEXT = "Avoid force pushing to shared branches";
const SETTINGS_ERROR_TEXT = "Facts are disabled in memory settings";

const cleanups: Array<() => void> = [];
let sourceCounter = 0;

afterEach(() => {
	while (cleanups.length > 0) cleanups.pop()?.();
});

interface Workspace {
	root: string;
	agentDir: string;
	cwd: string;
	store: FactStore;
}

function workspace(): Workspace {
	const root = mkdtempSync(join(tmpdir(), "nova-memory-cli-"));
	cleanups.push(() => rmSync(root, { recursive: true, force: true }));
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(cwd, { recursive: true });
	return { root, agentDir, cwd, store: new FactStore(agentDir) };
}

function makeSource(): FactSource {
	sourceCounter += 1;
	return {
		sessionFile: "/sessions/test.jsonl",
		sessionId: `session_${sourceCounter}`,
		entryIds: [`entry_${sourceCounter}`],
		extractedAt: new Date().toISOString(),
		model: "explicit",
	};
}

function addFact(store: FactStore, text: string, overrides: Partial<FactDraft> = {}): Fact {
	const result: AddFactResult = store.add({ text, source: makeSource(), ...overrides });
	if (result.action !== "created") throw new Error(`expected created, got ${result.action}`);
	return result.fact;
}

interface Seed {
	tabs: Fact;
	release: Fact;
	push: Fact;
}

/** 三条互不相似的事实：两条活跃（universal / project），一条 transferable。 */
function seedFacts(ws: Workspace): Seed {
	return {
		tabs: addFact(ws.store, TABS_TEXT, {
			kind: "preference",
			importance: 3,
			applicability: "universal",
			topics: ["style"],
		}),
		release: addFact(ws.store, RELEASE_TEXT, {
			kind: "decision",
			importance: 4,
			applicability: "project",
			projects: ["proj_alpha"],
			topics: ["process"],
		}),
		push: addFact(ws.store, PUSH_TEXT, {
			kind: "constraint",
			importance: 2,
			applicability: "transferable",
			originProject: { key: "proj_alpha", path: "/work/alpha" },
			topics: ["git"],
		}),
	};
}

interface CliResult {
	handled: boolean;
	lines: string[];
	text: string;
}

async function runMemory(ws: Workspace, args: string[]): Promise<CliResult> {
	const lines: string[] = [];
	const handled = await handleMemoryCommand(["memory", ...args], {
		agentDir: ws.agentDir,
		cwd: ws.cwd,
		output: (line) => lines.push(line),
	});
	return { handled, lines, text: lines.join("\n") };
}

/** `--json` 必须是一行，便于脚本消费。 */
function jsonPayload(result: CliResult): Record<string, unknown> {
	expect(result.lines).toHaveLength(1);
	return JSON.parse(result.lines[0]) as Record<string, unknown>;
}

function nestedRows(payload: Record<string, unknown>, key: string): Record<string, unknown>[] {
	const value = payload[key];
	if (!Array.isArray(value)) throw new Error(`payload has no ${key} array`);
	return value as Record<string, unknown>[];
}

function factRows(result: CliResult): Record<string, unknown>[] {
	return nestedRows(jsonPayload(result), "facts");
}

function hitRows(result: CliResult): Record<string, unknown>[] {
	return nestedRows(jsonPayload(result), "hits");
}

function ids(rows: Record<string, unknown>[]): string[] {
	return rows.map((row) => String(row.id)).sort();
}

function writeMemorySettings(ws: Workspace, memory: Record<string, unknown>): void {
	writeFileSync(join(ws.agentDir, "settings.json"), `${JSON.stringify({ memory })}\n`);
}

interface SessionFixture {
	path: string;
	assistantId: string;
}

/** 用 SessionManager 造一个真正落盘的会话，落在缺省的会话目录里。 */
function createSession(ws: Workspace): SessionFixture {
	const manager = SessionManager.create(ws.cwd, getDefaultSessionDir(ws.cwd, ws.agentDir));
	manager.appendMessage({ role: "user", content: "Which indentation should we use?", timestamp: Date.now() });
	const assistantId = manager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "Use tabs." }],
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
	return { path, assistantId };
}

describe("handleMemoryCommand dispatch", () => {
	it("returns false for a non-memory command without printing", async () => {
		const ws = workspace();
		const lines: string[] = [];

		const handled = await handleMemoryCommand(["config"], {
			agentDir: ws.agentDir,
			cwd: ws.cwd,
			output: (line) => lines.push(line),
		});

		expect(handled).toBe(false);
		expect(lines).toEqual([]);
	});

	it("prints usage for --help", async () => {
		const ws = workspace();
		const result = await runMemory(ws, ["--help"]);

		expect(result.handled).toBe(true);
		expect(result.text).toContain("Usage:");
		expect(result.text).toContain("memory list");
		expect(result.text).toContain("--json");
	});

	it("prints usage when a subcommand asks for help", async () => {
		const ws = workspace();
		const result = await runMemory(ws, ["list", "--help"]);

		expect(result.handled).toBe(true);
		expect(result.text).toContain("memory sessions");
	});

	it("reports a missing subcommand", async () => {
		const ws = workspace();
		const result = await runMemory(ws, []);

		expect(result.handled).toBe(true);
		expect(result.text).toContain("Missing memory subcommand");
	});

	it("reports an unknown subcommand", async () => {
		const ws = workspace();
		const result = await runMemory(ws, ["purge"]);

		expect(result.handled).toBe(true);
		expect(result.text).toContain('Unknown memory subcommand "purge"');
	});

	it("reports an unknown option", async () => {
		const ws = workspace();
		const result = await runMemory(ws, ["list", "--all"]);

		expect(result.handled).toBe(true);
		expect(result.text).toContain("Unknown option --all");
	});
});

describe("list", () => {
	it("outputs the seeded facts as one JSON line", async () => {
		const ws = workspace();
		const seed = seedFacts(ws);

		const rows = factRows(await runMemory(ws, ["list", "--json"]));

		expect(rows.map((row) => row.id).sort()).toEqual([seed.tabs.id, seed.release.id, seed.push.id].sort());
		const tabsRow = rows.find((row) => row.id === seed.tabs.id);
		expect(tabsRow).toMatchObject({
			applicability: "universal",
			kind: "preference",
			importance: 3,
			pinned: false,
			text: TABS_TEXT,
		});
	});

	it("renders the human table with id, date, applicability, kind, importance and text", async () => {
		const ws = workspace();
		const seed = seedFacts(ws);

		const result = await runMemory(ws, ["list"]);

		expect(result.text).toContain("ID");
		expect(result.text).toContain("APPLICABILITY");
		expect(result.text).toContain("KIND");
		expect(result.text).toContain(seed.tabs.id);
		expect(result.text).toContain(seed.tabs.createdAt.slice(0, 10));
		expect(result.text).toContain("universal");
		expect(result.text).toContain(TABS_TEXT);
	});

	it("filters by --applicability", async () => {
		const ws = workspace();
		const seed = seedFacts(ws);

		const project = factRows(await runMemory(ws, ["list", "--applicability", "project", "--json"]));
		const transferable = factRows(await runMemory(ws, ["list", "--applicability", "transferable", "--json"]));

		expect(ids(project)).toEqual([seed.release.id]);
		expect(ids(transferable)).toEqual([seed.push.id]);
	});

	it("rejects an invalid --applicability value", async () => {
		const ws = workspace();
		seedFacts(ws);

		const result = await runMemory(ws, ["list", "--applicability", "bogus"]);

		expect(result.handled).toBe(true);
		expect(result.text).toContain("Invalid value bogus for --applicability");
	});

	it("still lists facts when facts are disabled in settings", async () => {
		const ws = workspace();
		seedFacts(ws);
		writeMemorySettings(ws, { facts: { enabled: false } });

		const rows = factRows(await runMemory(ws, ["list", "--json"]));

		expect(rows).toHaveLength(3);
	});

	it("rejects unexpected positionals", async () => {
		const ws = workspace();
		const result = await runMemory(ws, ["list", "extra"]);

		expect(result.text).toContain('Unexpected argument extra for "list"');
	});
});

describe("search", () => {
	it("finds a fact and reports the score as JSON", async () => {
		const ws = workspace();
		const seed = seedFacts(ws);

		const payload = jsonPayload(await runMemory(ws, ["search", "tabs", "--json"]));
		const hits = nestedRows(payload, "hits");

		expect(payload.query).toBe("tabs");
		expect(hits).toHaveLength(1);
		expect(hits[0].id).toBe(seed.tabs.id);
		expect(typeof hits[0].score).toBe("number");
		expect(Number(hits[0].score)).toBeGreaterThan(0);
		expect(hits[0].text).toBe(TABS_TEXT);
	});

	it("renders the human result table", async () => {
		const ws = workspace();
		const seed = seedFacts(ws);

		const result = await runMemory(ws, ["search", "tabs"]);

		expect(result.text).toContain("SCORE");
		expect(result.text).toContain(seed.tabs.id);
		expect(result.text).toContain(TABS_TEXT);
	});

	it("skips archived facts and reports an empty result", async () => {
		const ws = workspace();
		const seed = seedFacts(ws);

		expect(ids(hitRows(await runMemory(ws, ["search", "force", "--json"])))).toEqual([seed.push.id]);
		ws.store.archive(seed.push.id, "manual");

		const after = await runMemory(ws, ["search", "force", "--json"]);
		expect(hitRows(after)).toEqual([]);
		expect((await runMemory(ws, ["search", "force"])).text).toContain('No facts matched "force"');
	});

	it("honors --limit", async () => {
		const ws = workspace();
		seedFacts(ws);
		addFact(ws.store, "Cadence review happens at the start of each quarter", { kind: "decision" });
		addFact(ws.store, "Cadence exceptions need approval from the release manager", { kind: "decision" });

		const hits = hitRows(await runMemory(ws, ["search", "cadence", "--limit", "2", "--json"]));

		expect(hits).toHaveLength(2);
	});

	it("reports a missing query", async () => {
		const ws = workspace();
		const result = await runMemory(ws, ["search"]);

		expect(result.handled).toBe(true);
		expect(result.text).toContain("Missing search query");
	});

	it("rejects an invalid --limit value", async () => {
		const ws = workspace();
		const result = await runMemory(ws, ["search", "tabs", "--limit", "0"]);

		expect(result.text).toContain("Invalid value 0 for --limit");
	});
});

describe("stat", () => {
	it("counts active, archived, hits, importance and recent additions", async () => {
		const ws = workspace();
		const seed = seedFacts(ws);
		ws.store.archive(seed.push.id, "manual");
		ws.store.recordRetrieval([seed.tabs.id, seed.release.id]);

		const payload = jsonPayload(await runMemory(ws, ["stat", "--json"]));

		expect(payload).toEqual({
			active: 2,
			archived: 1,
			hits: 2,
			averageImportance: 3.5,
			recent7Days: 3,
			factsEnabled: true,
		});
	});

	it("renders the human summary", async () => {
		const ws = workspace();
		const seed = seedFacts(ws);
		ws.store.archive(seed.push.id, "manual");

		const result = await runMemory(ws, ["stat"]);

		expect(result.text).toContain("Active facts: 2");
		expect(result.text).toContain("Archived facts: 1");
		expect(result.text).toContain("Retrieval hits: 0");
		expect(result.text).toContain("Added in last 7 days: 3");
		expect(result.text).not.toContain(SETTINGS_ERROR_TEXT);
	});

	it("flags disabled facts in both output modes", async () => {
		const ws = workspace();
		seedFacts(ws);
		writeMemorySettings(ws, { facts: { enabled: false } });

		const payload = jsonPayload(await runMemory(ws, ["stat", "--json"]));
		const human = await runMemory(ws, ["stat"]);

		expect(payload.factsEnabled).toBe(false);
		expect(human.text).toContain(SETTINGS_ERROR_TEXT);
		expect(human.text).toContain("Active facts: 3");
	});
});

describe("pin and unpin", () => {
	it("pins and unpins a fact", async () => {
		const ws = workspace();
		const seed = seedFacts(ws);

		const pinned = await runMemory(ws, ["pin", seed.tabs.id]);
		expect(pinned.handled).toBe(true);
		expect(pinned.text).toContain(`Pinned ${seed.tabs.id}`);
		expect(ws.store.get(seed.tabs.id)?.pinned).toBe(true);

		const unpinned = await runMemory(ws, ["unpin", seed.tabs.id]);
		expect(unpinned.text).toContain(`Unpinned ${seed.tabs.id}`);
		expect(ws.store.get(seed.tabs.id)?.pinned).toBe(false);
	});

	it("lists pinned facts first", async () => {
		const ws = workspace();
		const seed = seedFacts(ws);
		await runMemory(ws, ["pin", seed.push.id]);

		const rows = factRows(await runMemory(ws, ["list", "--json"]));

		expect(rows[0].id).toBe(seed.push.id);
		expect(rows[0].pinned).toBe(true);
	});

	it("reports a missing id", async () => {
		const ws = workspace();
		const result = await runMemory(ws, ["pin"]);

		expect(result.handled).toBe(true);
		expect(result.text).toContain('Missing fact id for "pin"');
	});

	it("reports an unknown id", async () => {
		const ws = workspace();
		const result = await runMemory(ws, ["unpin", "fact_missing"]);

		expect(result.handled).toBe(true);
		expect(result.text).toContain("Fact not found: fact_missing");
	});
});

describe("archive and delete", () => {
	it("archives a fact as manual and drops it from list", async () => {
		const ws = workspace();
		const seed = seedFacts(ws);

		const result = await runMemory(ws, ["archive", seed.tabs.id]);

		expect(result.text).toContain(`Archived ${seed.tabs.id}`);
		const archived = ws.store.get(seed.tabs.id);
		expect(archived?.archivedAt).toBeDefined();
		expect(archived?.archiveReason).toBe("manual");
		expect(ids(factRows(await runMemory(ws, ["list", "--json"])))).toEqual([seed.release.id, seed.push.id].sort());
	});

	it("keeps an already archived fact untouched", async () => {
		const ws = workspace();
		const seed = seedFacts(ws);
		ws.store.archive(seed.tabs.id, "stale");

		const result = await runMemory(ws, ["archive", seed.tabs.id]);

		expect(result.text).toContain("already archived");
		expect(ws.store.get(seed.tabs.id)?.archiveReason).toBe("stale");
	});

	it("treats delete as archive with the manual reason", async () => {
		const ws = workspace();
		const seed = seedFacts(ws);

		const result = await runMemory(ws, ["delete", seed.release.id]);

		expect(result.text).toContain(`Archived ${seed.release.id}`);
		const archived = ws.store.get(seed.release.id);
		expect(archived?.archiveReason).toBe("manual");
		expect(archived?.archivedAt).toBeDefined();
	});

	it("reports a missing id", async () => {
		const ws = workspace();
		const result = await runMemory(ws, ["archive"]);

		expect(result.text).toContain('Missing fact id for "archive"');
	});

	it("reports an unknown id", async () => {
		const ws = workspace();
		const result = await runMemory(ws, ["delete", "fact_missing"]);

		expect(result.text).toContain("Fact not found: fact_missing");
	});
});

describe("sessions", () => {
	it("lists each session file with its pending message count", async () => {
		const ws = workspace();
		const { path } = createSession(ws);
		const sessionDir = getDefaultSessionDir(ws.cwd, ws.agentDir);
		writeFileSync(`${path}.record.json`, "{}\n");
		writeFileSync(join(sessionDir, "notes.txt"), "not a session\n");

		const payload = jsonPayload(await runMemory(ws, ["sessions", "--json"]));
		const sessions = nestedRows(payload, "sessions");

		expect(payload.sessionDir).toBe(sessionDir);
		expect(payload.unreadable).toBe(0);
		expect(sessions).toHaveLength(1);
		expect(sessions[0].sessionFile).toBe(path);
		expect(sessions[0].pendingMessages).toBe(2);
		expect(sessions[0].lastMarkerAt).toBeUndefined();
		expect(Number.isNaN(Date.parse(String(sessions[0].lastActivityAt)))).toBe(false);
	});

	it("reports the last marker time and zero pending after extraction", async () => {
		const ws = workspace();
		const { path, assistantId } = createSession(ws);
		const markerAt = "2026-01-02T03:04:05.000Z";
		appendExtractionMarker(
			{ sessionManager: SessionManager.open(path) },
			{ throughEntryId: assistantId, at: markerAt, factIds: [] },
		);

		const sessions = nestedRows(jsonPayload(await runMemory(ws, ["sessions", "--json"])), "sessions");

		expect(sessions[0].pendingMessages).toBe(0);
		expect(sessions[0].lastMarkerAt).toBe(markerAt);
	});

	it("renders the human table", async () => {
		const ws = workspace();
		const { path } = createSession(ws);

		const result = await runMemory(ws, ["sessions"]);

		expect(result.text).toContain("PENDING");
		expect(result.text).toContain("LAST MARKER");
		expect(result.text).toContain(path);
	});

	it("handles an empty session directory", async () => {
		const ws = workspace();
		const result = await runMemory(ws, ["sessions"]);

		expect(result.handled).toBe(true);
		expect(result.text).toContain("No session files in");
		expect(nestedRows(jsonPayload(await runMemory(ws, ["sessions", "--json"])), "sessions")).toEqual([]);
	});
});
