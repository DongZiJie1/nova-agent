import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	appendExtractionMarker,
	type ExtractionMarker,
	lastMessageEntryId,
	MEMORY_EXTRACTION_CUSTOM_TYPE,
	readExtractionMarker,
	selectPendingEntries,
} from "../../src/core/memory/memory-marker.ts";
import { SessionManager } from "../../src/core/session-manager.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function createSession(): SessionManager {
	return SessionManager.inMemory("/tmp/nova-memory-marker");
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

function markerFor(throughEntryId: string, overrides: Partial<ExtractionMarker> = {}): ExtractionMarker {
	return { throughEntryId, at: new Date().toISOString(), factIds: [], ...overrides };
}

function writeMarker(manager: SessionManager, marker: ExtractionMarker): string {
	return manager.appendCustomEntry(MEMORY_EXTRACTION_CUSTOM_TYPE, marker);
}

describe("readExtractionMarker", () => {
	it("returns an empty state for an empty session", () => {
		const state = readExtractionMarker(createSession());

		expect(state).toEqual({});
		expect(state.marker).toBeUndefined();
		expect(state.markerEntryId).toBeUndefined();
	});

	it("reads the marker together with its entry id", () => {
		const manager = createSession();
		const firstId = appendUser(manager, "first");
		const marker = markerFor(firstId, { model: "provider/model", factIds: ["fact_1", "fact_2"] });
		const markerEntryId = writeMarker(manager, marker);

		const state = readExtractionMarker(manager);

		expect(state.marker).toEqual(marker);
		expect(state.markerEntryId).toBe(markerEntryId);
	});

	it("keeps only the last marker", () => {
		const manager = createSession();
		const firstId = appendUser(manager, "first");
		const secondId = appendUser(manager, "second");
		writeMarker(manager, markerFor(firstId));
		const latestEntryId = writeMarker(manager, markerFor(secondId));

		const state = readExtractionMarker(manager);

		expect(state.marker?.throughEntryId).toBe(secondId);
		expect(state.markerEntryId).toBe(latestEntryId);
	});

	it("falls back to the previous valid marker when the last data is not an object", () => {
		const manager = createSession();
		const firstId = appendUser(manager, "first");
		const validEntryId = writeMarker(manager, markerFor(firstId));
		manager.appendCustomEntry(MEMORY_EXTRACTION_CUSTOM_TYPE, "not-an-object");

		const state = readExtractionMarker(manager);

		expect(state.marker?.throughEntryId).toBe(firstId);
		expect(state.markerEntryId).toBe(validEntryId);
	});

	it("falls back when throughEntryId is not a string", () => {
		const manager = createSession();
		const firstId = appendUser(manager, "first");
		const validEntryId = writeMarker(manager, markerFor(firstId));
		manager.appendCustomEntry(MEMORY_EXTRACTION_CUSTOM_TYPE, { throughEntryId: 42 });

		const state = readExtractionMarker(manager);

		expect(state.marker?.throughEntryId).toBe(firstId);
		expect(state.markerEntryId).toBe(validEntryId);
	});

	it("ignores markers without throughEntryId", () => {
		const manager = createSession();
		appendUser(manager, "first");
		writeMarker(manager, markerFor("entry-a"));
		manager.appendCustomEntry(MEMORY_EXTRACTION_CUSTOM_TYPE, { at: new Date().toISOString(), factIds: [] });

		expect(readExtractionMarker(manager).marker?.throughEntryId).toBe("entry-a");
	});

	it("ignores custom entries with another customType", () => {
		const manager = createSession();
		const firstId = appendUser(manager, "first");
		writeMarker(manager, markerFor(firstId));
		manager.appendCustomEntry("nova.other", { throughEntryId: "entry-b" });

		const state = readExtractionMarker(manager);

		expect(state.marker?.throughEntryId).toBe(firstId);
	});

	it("still finds the marker after later message entries", () => {
		const manager = createSession();
		const firstId = appendUser(manager, "first");
		const markerEntryId = writeMarker(manager, markerFor(firstId));
		appendAssistant(manager, "second");

		const state = readExtractionMarker(manager);

		expect(state.markerEntryId).toBe(markerEntryId);
	});

	it("tolerates missing at/model/factIds and filters non-string factIds", () => {
		const manager = createSession();
		appendUser(manager, "first");
		manager.appendCustomEntry(MEMORY_EXTRACTION_CUSTOM_TYPE, {
			throughEntryId: "entry-a",
			factIds: ["fact_1", 7, null, "fact_2"],
		});

		const state = readExtractionMarker(manager);
		const markerEntry = manager.getEntries().at(-1);

		expect(markerEntry?.type).toBe("custom");
		expect(state.marker?.throughEntryId).toBe("entry-a");
		expect(state.marker?.factIds).toEqual(["fact_1", "fact_2"]);
		expect(state.marker?.at).toBe(markerEntry?.timestamp);
		expect(state.marker?.model).toBeUndefined();
		expect(state.marker?.fromEntryId).toBeUndefined();
	});
});

describe("appendExtractionMarker", () => {
	it("writes a custom entry with the memory extraction customType", () => {
		const manager = createSession();
		const firstId = appendUser(manager, "first");
		const marker = markerFor(firstId, { fromEntryId: "entry-from", model: "provider/model", factIds: ["fact_1"] });

		appendExtractionMarker({ sessionManager: manager }, marker);

		const entry = manager.getEntries().at(-1);
		expect(entry?.type).toBe("custom");
		if (entry?.type !== "custom") throw new Error("expected a custom entry");
		expect(entry.customType).toBe(MEMORY_EXTRACTION_CUSTOM_TYPE);
		expect(entry.customType).toBe("nova.memory_extraction");
		expect(entry.data).toEqual(marker);
	});

	it("does not add the marker to the model context", () => {
		const manager = createSession();
		appendUser(manager, "first");
		appendAssistant(manager, "reply");
		const contextBefore = manager.buildSessionContext().messages.length;

		appendExtractionMarker({ sessionManager: manager }, markerFor(manager.getEntries()[0].id));

		expect(manager.buildSessionContext().messages).toHaveLength(contextBefore);
		expect(manager.getEntries()).toHaveLength(3);
	});
});

describe("selectPendingEntries", () => {
	it("returns nothing for an empty session", () => {
		const manager = createSession();

		expect(selectPendingEntries(manager.getEntries(), readExtractionMarker(manager))).toEqual([]);
	});

	it("returns all message entries when there is no marker", () => {
		const manager = createSession();
		const firstId = appendUser(manager, "first");
		const secondId = appendUser(manager, "second");
		const thirdId = appendAssistant(manager, "reply");

		const pending = selectPendingEntries(manager.getEntries(), readExtractionMarker(manager));

		expect(pending.map((entry) => entry.id)).toEqual([firstId, secondId, thirdId]);
	});

	it("returns only the entries after the marker target", () => {
		const manager = createSession();
		appendUser(manager, "first");
		const secondId = appendUser(manager, "second");
		const thirdId = appendAssistant(manager, "reply");
		writeMarker(manager, markerFor(secondId));

		const pending = selectPendingEntries(manager.getEntries(), readExtractionMarker(manager));

		expect(pending.map((entry) => entry.id)).toEqual([thirdId]);
	});

	it("starts from the beginning when the marker target is missing", () => {
		const manager = createSession();
		const firstId = appendUser(manager, "first");
		const secondId = appendAssistant(manager, "reply");
		writeMarker(manager, markerFor("missing-entry-id"));

		const pending = selectPendingEntries(manager.getEntries(), readExtractionMarker(manager));

		expect(pending.map((entry) => entry.id)).toEqual([firstId, secondId]);
	});

	it("returns only new messages appended after the marker", () => {
		const manager = createSession();
		const firstId = appendUser(manager, "first");
		writeMarker(manager, markerFor(firstId));
		const secondId = appendUser(manager, "second");
		const thirdId = appendAssistant(manager, "reply");

		const pending = selectPendingEntries(manager.getEntries(), readExtractionMarker(manager));

		expect(pending.map((entry) => entry.id)).toEqual([secondId, thirdId]);
	});

	it("returns nothing when the marker is already at the last message", () => {
		const manager = createSession();
		appendUser(manager, "first");
		const secondId = appendAssistant(manager, "reply");
		writeMarker(manager, markerFor(secondId));

		expect(selectPendingEntries(manager.getEntries(), readExtractionMarker(manager))).toEqual([]);
	});

	it("honors only the last of several markers", () => {
		const manager = createSession();
		const firstId = appendUser(manager, "first");
		appendUser(manager, "second");
		const thirdId = appendAssistant(manager, "reply");
		writeMarker(manager, markerFor(firstId));
		writeMarker(manager, markerFor(thirdId));

		const pending = selectPendingEntries(manager.getEntries(), readExtractionMarker(manager));

		expect(pending).toEqual([]);
	});

	it("skips custom, custom_message and compaction entries but keeps order", () => {
		const manager = createSession();
		const firstId = appendUser(manager, "first");
		const secondId = appendAssistant(manager, "reply");
		manager.appendCompaction("summary", firstId, 100);
		manager.appendCustomMessageEntry("nova.note", "injected", false);
		const thirdId = appendUser(manager, "second");

		const pending = selectPendingEntries(manager.getEntries(), readExtractionMarker(manager));

		expect(pending.map((entry) => entry.id)).toEqual([firstId, secondId, thirdId]);
		for (const entry of pending) expect(entry.type).toBe("message");
	});

	it("excludes marker entries themselves from the pending set", () => {
		const manager = createSession();
		const firstId = appendUser(manager, "first");
		writeMarker(manager, markerFor(firstId));
		appendAssistant(manager, "reply");
		writeMarker(manager, markerFor(firstId));

		const pending = selectPendingEntries(manager.getEntries(), readExtractionMarker(manager));

		for (const entry of pending) expect(entry.type).toBe("message");
		expect(pending).toHaveLength(1);
	});
});

describe("lastMessageEntryId", () => {
	it("returns undefined for an empty session", () => {
		expect(lastMessageEntryId(createSession().getEntries())).toBeUndefined();
	});

	it("returns undefined when only custom entries exist", () => {
		const manager = createSession();
		writeMarker(manager, markerFor("entry-a"));

		expect(lastMessageEntryId(manager.getEntries())).toBeUndefined();
	});

	it("returns the last message id, skipping later non-message entries", () => {
		const manager = createSession();
		appendUser(manager, "first");
		const lastId = appendAssistant(manager, "reply");
		writeMarker(manager, markerFor(lastId));

		expect(lastMessageEntryId(manager.getEntries())).toBe(lastId);
	});

	it("moves forward after appending a new message", () => {
		const manager = createSession();
		const firstId = appendUser(manager, "first");
		expect(lastMessageEntryId(manager.getEntries())).toBe(firstId);
		const secondId = appendAssistant(manager, "reply");
		expect(lastMessageEntryId(manager.getEntries())).toBe(secondId);
	});
});

describe("session file round trip", () => {
	it("restores the marker and the pending range after reopening the session", () => {
		const cwd = mkdtempSync(join(tmpdir(), "nova-memory-marker-"));
		tempDirs.push(cwd);
		const manager = SessionManager.create(cwd, join(cwd, "sessions"));
		appendUser(manager, "first");
		const secondId = appendAssistant(manager, "reply");
		appendExtractionMarker({ sessionManager: manager }, markerFor(secondId, { model: "provider/model" }));
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("expected a persisted session file");

		const reopened = SessionManager.open(sessionFile);
		const state = readExtractionMarker(reopened);

		expect(state.marker?.throughEntryId).toBe(secondId);
		expect(state.marker?.model).toBe("provider/model");
		expect(selectPendingEntries(reopened.getEntries(), state)).toEqual([]);
		expect(lastMessageEntryId(reopened.getEntries())).toBe(secondId);
	});
});
