import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	DEFAULT_MEMORY_SETTINGS,
	type MemorySettings,
	type ResolvedMemorySettings,
	resolveMemorySettings,
} from "../../src/core/memory/memory-settings.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/** 用未收窄的原始配置构造，覆盖 settings.json 里类型写错的情况。 */
function resolveRaw(value: Record<string, unknown>): ResolvedMemorySettings {
	return resolveMemorySettings(value as unknown as MemorySettings);
}

describe("resolveMemorySettings", () => {
	it("returns the complete defaults when no value is given", () => {
		const resolved = resolveMemorySettings(undefined);

		expect(resolved).toEqual({
			enabled: true,
			facts: {
				enabled: true,
				maxPromptTokens: 1000,
				maxPromptFacts: 12,
				halfLifeDays: 21,
				minScore: 0.35,
				maxTextChars: 160,
				crossProjectRecall: true,
				gateProjectFacts: true,
				archiveAfterDays: 90,
				maxActiveFacts: 5000,
				selection: "query",
				selectionTimeoutMs: 1500,
				selectionCandidates: 50,
				promotion: {
					minHits: 6,
					minImportance: 4,
					minAgeDays: 14,
					auto: false,
				},
			},
			extraction: {
				enabled: true,
				idleMinutes: 8,
				checkpointTurns: 20,
				maxInputChars: 24000,
				minImportance: 2,
				maxFactsPerBatch: 8,
				model: undefined,
				timeoutMs: 30000,
				sessionEndFlushMs: 3000,
			},
		});
		expect(resolved).toEqual(DEFAULT_MEMORY_SETTINGS);
		expect("model" in resolved.extraction).toBe(true);
		expect(resolved.extraction.model).toBeUndefined();
	});

	it("treats an empty object like no value", () => {
		expect(resolveMemorySettings({})).toEqual(DEFAULT_MEMORY_SETTINGS);
	});

	it("returns a fresh object that does not alias the defaults", () => {
		const resolved = resolveMemorySettings(undefined);

		expect(resolved).not.toBe(DEFAULT_MEMORY_SETTINGS);
		expect(resolved.facts).not.toBe(DEFAULT_MEMORY_SETTINGS.facts);
		expect(resolved.facts.promotion).not.toBe(DEFAULT_MEMORY_SETTINGS.facts.promotion);
		expect(resolved.extraction).not.toBe(DEFAULT_MEMORY_SETTINGS.extraction);

		resolved.facts.maxPromptTokens = 1;
		resolved.facts.promotion.auto = true;
		resolved.extraction.timeoutMs = 1;
		resolved.extraction.model = "mutated/model";

		expect(DEFAULT_MEMORY_SETTINGS.facts.maxPromptTokens).toBe(1000);
		expect(DEFAULT_MEMORY_SETTINGS.facts.promotion.auto).toBe(false);
		expect(DEFAULT_MEMORY_SETTINGS.extraction.timeoutMs).toBe(30000);
		expect(DEFAULT_MEMORY_SETTINGS.extraction.model).toBeUndefined();
	});

	it("keeps the other facts fields at their defaults when only maxPromptTokens is set", () => {
		const resolved = resolveMemorySettings({ facts: { maxPromptTokens: 250 } });

		expect(resolved.facts.maxPromptTokens).toBe(250);
		expect(resolved.facts.maxPromptFacts).toBe(12);
		expect(resolved.facts.halfLifeDays).toBe(21);
		expect(resolved.facts.enabled).toBe(true);
		expect(resolved.enabled).toBe(true);
		expect(resolved.extraction).toEqual(DEFAULT_MEMORY_SETTINGS.extraction);
	});

	it("merges nested extraction overrides field by field", () => {
		const resolved = resolveMemorySettings({
			extraction: { idleMinutes: 0, model: "provider/model", enabled: false },
		});

		expect(resolved.extraction.idleMinutes).toBe(0);
		expect(resolved.extraction.model).toBe("provider/model");
		expect(resolved.extraction.enabled).toBe(false);
		expect(resolved.extraction.checkpointTurns).toBe(20);
		expect(resolved.extraction.maxInputChars).toBe(24000);
		expect(resolved.extraction.minImportance).toBe(2);
		expect(resolved.extraction.maxFactsPerBatch).toBe(8);
		expect(resolved.extraction.timeoutMs).toBe(30000);
		expect(resolved.extraction.sessionEndFlushMs).toBe(3000);
	});

	it("merges nested promotion overrides field by field", () => {
		const resolved = resolveMemorySettings({ facts: { promotion: { minHits: 3, auto: true } } });

		expect(resolved.facts.promotion.minHits).toBe(3);
		expect(resolved.facts.promotion.auto).toBe(true);
		expect(resolved.facts.promotion.minImportance).toBe(4);
		expect(resolved.facts.promotion.minAgeDays).toBe(14);
		expect(resolved.facts.maxPromptFacts).toBe(12);
	});

	it("keeps explicit false values at every level", () => {
		const resolved = resolveMemorySettings({
			enabled: false,
			facts: { enabled: false, crossProjectRecall: false, gateProjectFacts: false },
			extraction: { enabled: false },
		});

		expect(resolved.enabled).toBe(false);
		expect(resolved.facts.enabled).toBe(false);
		expect(resolved.facts.crossProjectRecall).toBe(false);
		expect(resolved.facts.gateProjectFacts).toBe(false);
		expect(resolved.extraction.enabled).toBe(false);
	});

	it("falls back for negative numbers", () => {
		const resolved = resolveMemorySettings({
			facts: { maxPromptTokens: -5, halfLifeDays: -1, minScore: -0.2, maxTextChars: -10 },
			extraction: { maxFactsPerBatch: -2 },
		});

		expect(resolved.facts.maxPromptTokens).toBe(1000);
		expect(resolved.facts.halfLifeDays).toBe(21);
		expect(resolved.facts.minScore).toBe(0.35);
		expect(resolved.facts.maxTextChars).toBe(160);
		expect(resolved.extraction.maxFactsPerBatch).toBe(8);
	});

	it("falls back for zero on fields that must be positive", () => {
		const resolved = resolveMemorySettings({
			facts: { maxPromptTokens: 0, maxPromptFacts: 0, halfLifeDays: 0, maxTextChars: 0, maxActiveFacts: 0 },
			extraction: { checkpointTurns: 0, maxFactsPerBatch: 0, timeoutMs: 0 },
		});

		expect(resolved.facts.maxPromptTokens).toBe(1000);
		expect(resolved.facts.maxPromptFacts).toBe(12);
		expect(resolved.facts.halfLifeDays).toBe(21);
		expect(resolved.facts.maxTextChars).toBe(160);
		expect(resolved.facts.maxActiveFacts).toBe(5000);
		expect(resolved.extraction.checkpointTurns).toBe(20);
		expect(resolved.extraction.maxFactsPerBatch).toBe(8);
		expect(resolved.extraction.timeoutMs).toBe(30000);
	});

	it("falls back for non-finite numbers", () => {
		const resolved = resolveMemorySettings({
			facts: { maxPromptTokens: Number.NaN },
			extraction: { timeoutMs: Number.POSITIVE_INFINITY, sessionEndFlushMs: Number.NEGATIVE_INFINITY },
		});

		expect(resolved.facts.maxPromptTokens).toBe(1000);
		expect(resolved.extraction.timeoutMs).toBe(30000);
		expect(resolved.extraction.sessionEndFlushMs).toBe(3000);
	});

	it("falls back when settings.json holds the wrong type", () => {
		const resolved = resolveRaw({
			enabled: "false",
			facts: { enabled: 0, maxPromptTokens: "1500", crossProjectRecall: "no" },
			extraction: { idleMinutes: "8", model: 42 },
		});

		expect(resolved.enabled).toBe(true);
		expect(resolved.facts.enabled).toBe(true);
		expect(resolved.facts.maxPromptTokens).toBe(1000);
		expect(resolved.facts.crossProjectRecall).toBe(true);
		expect(resolved.extraction.idleMinutes).toBe(8);
		expect(resolved.extraction.model).toBeUndefined();
	});

	it("accepts zero for minScore, idleMinutes and sessionEndFlushMs", () => {
		const resolved = resolveMemorySettings({
			facts: { minScore: 0 },
			extraction: { idleMinutes: 0, sessionEndFlushMs: 0 },
		});

		expect(resolved.facts.minScore).toBe(0);
		expect(resolved.extraction.idleMinutes).toBe(0);
		expect(resolved.extraction.sessionEndFlushMs).toBe(0);
	});

	it("clamps maxPromptFacts to 1-30", () => {
		expect(resolveMemorySettings({ facts: { maxPromptFacts: 100 } }).facts.maxPromptFacts).toBe(30);
		expect(resolveMemorySettings({ facts: { maxPromptFacts: 31 } }).facts.maxPromptFacts).toBe(30);
		expect(resolveMemorySettings({ facts: { maxPromptFacts: 1 } }).facts.maxPromptFacts).toBe(1);
		expect(resolveMemorySettings({ facts: { maxPromptFacts: 29.9 } }).facts.maxPromptFacts).toBe(29);
		expect(resolveMemorySettings({ facts: { maxPromptFacts: 0 } }).facts.maxPromptFacts).toBe(12);
		expect(resolveMemorySettings({ facts: { maxPromptFacts: -3 } }).facts.maxPromptFacts).toBe(12);
	});

	it("clamps maxInputChars to at least 1000", () => {
		expect(resolveMemorySettings({ extraction: { maxInputChars: 500 } }).extraction.maxInputChars).toBe(1000);
		expect(resolveMemorySettings({ extraction: { maxInputChars: 1000 } }).extraction.maxInputChars).toBe(1000);
		expect(resolveMemorySettings({ extraction: { maxInputChars: 50000 } }).extraction.maxInputChars).toBe(50000);
	});

	it("clamps timeoutMs to at least 1000", () => {
		expect(resolveMemorySettings({ extraction: { timeoutMs: 500 } }).extraction.timeoutMs).toBe(1000);
		expect(resolveMemorySettings({ extraction: { timeoutMs: 999 } }).extraction.timeoutMs).toBe(1000);
		expect(resolveMemorySettings({ extraction: { timeoutMs: 1001 } }).extraction.timeoutMs).toBe(1001);
	});

	it("clamps sessionEndFlushMs to 0-15000", () => {
		expect(resolveMemorySettings({ extraction: { sessionEndFlushMs: 99999 } }).extraction.sessionEndFlushMs).toBe(
			15000,
		);
		expect(resolveMemorySettings({ extraction: { sessionEndFlushMs: 15000 } }).extraction.sessionEndFlushMs).toBe(
			15000,
		);
		expect(resolveMemorySettings({ extraction: { sessionEndFlushMs: -1 } }).extraction.sessionEndFlushMs).toBe(3000);
	});

	it("defaults fact selection to the query mode", () => {
		const resolved = resolveMemorySettings({ facts: { maxPromptTokens: 250 } });

		expect(resolved.facts.selection).toBe("query");
		expect(resolved.facts.selectionTimeoutMs).toBe(1500);
		expect(resolved.facts.selectionCandidates).toBe(50);
	});

	it("keeps a valid selection mode and rejects unknown values", () => {
		expect(resolveMemorySettings({ facts: { selection: "score" } }).facts.selection).toBe("score");
		expect(resolveMemorySettings({ facts: { selection: "query" } }).facts.selection).toBe("query");
		expect(resolveRaw({ facts: { selection: "QUERY" } }).facts.selection).toBe("query");
		expect(resolveRaw({ facts: { selection: true } }).facts.selection).toBe("query");
	});

	it("clamps selectionTimeoutMs to 100-10000", () => {
		expect(resolveMemorySettings({ facts: { selectionTimeoutMs: 50 } }).facts.selectionTimeoutMs).toBe(100);
		expect(resolveMemorySettings({ facts: { selectionTimeoutMs: 100 } }).facts.selectionTimeoutMs).toBe(100);
		expect(resolveMemorySettings({ facts: { selectionTimeoutMs: 20000 } }).facts.selectionTimeoutMs).toBe(10000);
		expect(resolveMemorySettings({ facts: { selectionTimeoutMs: 0 } }).facts.selectionTimeoutMs).toBe(1500);
		expect(resolveMemorySettings({ facts: { selectionTimeoutMs: -1 } }).facts.selectionTimeoutMs).toBe(1500);
		expect(resolveMemorySettings({ facts: { selectionTimeoutMs: Number.NaN } }).facts.selectionTimeoutMs).toBe(1500);
	});

	it("clamps selectionCandidates to 10-200", () => {
		expect(resolveMemorySettings({ facts: { selectionCandidates: 5 } }).facts.selectionCandidates).toBe(10);
		expect(resolveMemorySettings({ facts: { selectionCandidates: 10 } }).facts.selectionCandidates).toBe(10);
		expect(resolveMemorySettings({ facts: { selectionCandidates: 500 } }).facts.selectionCandidates).toBe(200);
		expect(resolveMemorySettings({ facts: { selectionCandidates: 0 } }).facts.selectionCandidates).toBe(50);
		expect(resolveRaw({ facts: { selectionCandidates: "80" } }).facts.selectionCandidates).toBe(50);
	});

	it("trims the extraction model and treats blank values as unset", () => {
		expect(resolveMemorySettings({ extraction: { model: "  provider/model  " } }).extraction.model).toBe(
			"provider/model",
		);
		expect(resolveMemorySettings({ extraction: { model: "" } }).extraction.model).toBeUndefined();
		expect(resolveMemorySettings({ extraction: { model: "   " } }).extraction.model).toBeUndefined();
	});
});

describe("SettingsManager.getMemorySettings", () => {
	let testDir: string;
	let agentDir: string;
	let projectDir: string;

	beforeEach(() => {
		testDir = mkdtempSync(join(tmpdir(), "nova-memory-settings-"));
		tempDirs.push(testDir);
		agentDir = join(testDir, "agent");
		projectDir = join(testDir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(projectDir, { recursive: true });
	});

	it("returns the defaults when settings.json has no memory section", () => {
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ theme: "dark" }));

		const manager = SettingsManager.create(projectDir, agentDir);

		expect(manager.getMemorySettings()).toEqual(DEFAULT_MEMORY_SETTINGS);
	});

	it("reads memory overrides from settings.json", () => {
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({
				memory: {
					facts: { maxPromptFacts: 20, halfLifeDays: 7 },
					extraction: { idleMinutes: 0, model: "provider/model" },
				},
			}),
		);

		const manager = SettingsManager.create(projectDir, agentDir);
		const resolved = manager.getMemorySettings();

		expect(resolved.facts.maxPromptFacts).toBe(20);
		expect(resolved.facts.halfLifeDays).toBe(7);
		expect(resolved.facts.maxPromptTokens).toBe(1000);
		expect(resolved.extraction.idleMinutes).toBe(0);
		expect(resolved.extraction.model).toBe("provider/model");
		expect(resolved.extraction.timeoutMs).toBe(30000);
	});

	it("reads the fact selection settings from settings.json", () => {
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({
				memory: {
					facts: { selection: "score", selectionTimeoutMs: 500, selectionCandidates: 20 },
				},
			}),
		);

		const resolved = SettingsManager.create(projectDir, agentDir).getMemorySettings();

		expect(resolved.facts.selection).toBe("score");
		expect(resolved.facts.selectionTimeoutMs).toBe(500);
		expect(resolved.facts.selectionCandidates).toBe(20);
	});

	it("applies fallback and clamping rules to values from settings.json", () => {
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({
				memory: {
					facts: { maxPromptFacts: 100, maxPromptTokens: -1 },
					extraction: { sessionEndFlushMs: 99999 },
				},
			}),
		);

		const resolved = SettingsManager.create(projectDir, agentDir).getMemorySettings();

		expect(resolved.facts.maxPromptFacts).toBe(30);
		expect(resolved.facts.maxPromptTokens).toBe(1000);
		expect(resolved.extraction.sessionEndFlushMs).toBe(15000);
	});

	it("does not write memory defaults back to settings.json", async () => {
		const settingsPath = join(agentDir, "settings.json");
		writeFileSync(settingsPath, JSON.stringify({ theme: "dark" }, null, 2));

		const manager = SettingsManager.create(projectDir, agentDir);
		manager.getMemorySettings();
		await manager.flush();

		const saved = JSON.parse(readFileSync(settingsPath, "utf-8"));
		expect(saved).toEqual({ theme: "dark" });
		expect(saved.memory).toBeUndefined();
	});

	it("returns an independent object on each call", () => {
		const manager = SettingsManager.create(projectDir, agentDir);

		const first = manager.getMemorySettings();
		first.facts.maxPromptTokens = 1;
		first.facts.promotion.auto = true;
		first.extraction.timeoutMs = 1;

		const second = manager.getMemorySettings();
		expect(second.facts.maxPromptTokens).toBe(1000);
		expect(second.facts.promotion.auto).toBe(false);
		expect(second.extraction.timeoutMs).toBe(30000);
		expect(second).not.toBe(first);
	});
});
