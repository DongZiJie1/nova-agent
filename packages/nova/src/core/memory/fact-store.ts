import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { uuidv7 } from "@dongzijie1/pi-ai";
import lockfile from "proper-lockfile";
import { getAgentDir } from "../../config.ts";
import { isSensitiveText } from "../sensitive.ts";
import {
	FACT_STATE_VERSION,
	type Fact,
	type FactApplicability,
	type FactArchiveReason,
	type FactKind,
	type FactProjectRef,
	type FactReviewState,
	type FactSource,
	type FactState,
	FactStateVersionError,
	MAX_FACT_TEXT_CHARS,
	MAX_TOPICS,
	parseFactState,
} from "./fact-schema.ts";
import { factSimilarity, factTextHash, normalizeFactText } from "./fact-text.ts";
import { notifyMemoryChanged } from "./memory-events.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
/** 归一化文本相似度上限：达到即视为同一条事实。 */
const MERGE_SIMILARITY = 0.85;
/** 低于此相似度的事实互不干扰。 */
const CONFLICT_SIMILARITY = 0.5;
const MAX_CONFLICT_CANDIDATES = 3;
const DEFAULT_IMPORTANCE = 3;
const DEFAULT_CONFIDENCE = 0.5;
/** 过期后仍保留的宽限天数。 */
const EXPIRY_GRACE_DAYS = 7;
/** 未被命中且不重要的陈旧天数。 */
const STALE_AFTER_DAYS = 90;
const STALE_MAX_IMPORTANCE = 2;
/** 被替代后到归档的保留天数。 */
const SUPERSEDED_RETENTION_DAYS = 30;
const CONTRADICTION_PATTERN = /改为|不再|取消|代替|作废|不是/;

export class FactStoreVersionError extends Error {
	constructor(message = "Unsupported fact store version") {
		super(message);
		this.name = "FactStoreVersionError";
	}
}

export class SensitiveFactError extends Error {
	constructor(message = "Sensitive information must not be saved as a fact") {
		super(message);
		this.name = "SensitiveFactError";
	}
}

export interface FactDraft {
	text: string;
	kind?: FactKind;
	importance?: number;
	confidence?: number;
	applicability?: FactApplicability;
	projects?: string[];
	originProject?: FactProjectRef;
	topics?: string[];
	validUntil?: string;
	supersedes?: string[];
	source: FactSource;
}

export interface PruneOptions {
	now?: Date;
	/** Days without a retrieval before a low-importance fact is archived; defaults to 90. */
	staleAfterDays?: number;
}

export type AddFactResult =
	| { action: "created"; fact: Fact }
	| { action: "duplicate"; fact: Fact }
	| { action: "merged"; fact: Fact }
	| { action: "conflict"; candidates: Fact[] };

interface LockedOutcome<T> {
	changed: boolean;
	result: T;
}

function charCount(text: string): number {
	return Array.from(text).length;
}

function clampImportance(value: number | undefined): number {
	if (value === undefined || !Number.isFinite(value)) return DEFAULT_IMPORTANCE;
	return Math.min(5, Math.max(1, Math.round(value)));
}

function clampConfidence(value: number | undefined): number {
	if (value === undefined || !Number.isFinite(value)) return DEFAULT_CONFIDENCE;
	return Math.min(1, Math.max(0, value));
}

function normalizeTopics(topics: string[] | undefined): string[] {
	const result: string[] = [];
	for (const topic of topics ?? []) {
		const trimmed = topic.trim();
		if (trimmed.length === 0 || result.includes(trimmed)) continue;
		result.push(trimmed);
		if (result.length === MAX_TOPICS) break;
	}
	return result;
}

function normalizeProjects(projects: string[] | undefined): string[] {
	const result: string[] = [];
	for (const project of projects ?? []) {
		const trimmed = project.trim();
		if (trimmed.length === 0 || result.includes(trimmed)) continue;
		result.push(trimmed);
	}
	return result;
}

function hasContradictionMarker(text: string): boolean {
	return CONTRADICTION_PATTERN.test(text);
}

function numericTokens(text: string): string[] {
	return (normalizeFactText(text).match(/\d+(?:\.\d+)?/g) ?? []).sort();
}

function numbersDiffer(left: string, right: string): boolean {
	return numericTokens(left).join(",") !== numericTokens(right).join(",");
}

function isActiveFact(fact: Fact): boolean {
	return fact.archivedAt === undefined && fact.supersededBy === undefined;
}

function daysAfter(iso: string, days: number): number {
	const parsed = Date.parse(iso);
	return Number.isNaN(parsed) ? Number.NaN : parsed + days * DAY_MS;
}

function archiveReasonFor(fact: Fact, nowMs: number, staleAfterDays: number): FactArchiveReason | undefined {
	if (fact.validUntil !== undefined) {
		const expiredAt = daysAfter(fact.validUntil, EXPIRY_GRACE_DAYS);
		if (!Number.isNaN(expiredAt) && expiredAt <= nowMs) return "expired";
	}
	if (fact.supersededBy !== undefined) {
		// 被替代时 updatedAt 记录替代发生的时间，30 天后归档。
		const supersededAt = daysAfter(fact.updatedAt, SUPERSEDED_RETENTION_DAYS);
		if (!Number.isNaN(supersededAt) && supersededAt <= nowMs) return "superseded";
	}
	if (!fact.pinned && fact.importance <= STALE_MAX_IMPORTANCE) {
		const staleAt = daysAfter(fact.lastRetrievedAt ?? fact.createdAt, staleAfterDays);
		if (!Number.isNaN(staleAt) && staleAt <= nowMs) return "stale";
	}
	return undefined;
}

export class FactStore {
	readonly path: string;

	constructor(agentDir: string = getAgentDir()) {
		this.path = join(agentDir, "memory", "facts.json");
	}

	read(): FactState {
		if (!existsSync(this.path)) return { version: FACT_STATE_VERSION, facts: [] };
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(this.path, "utf8"));
		} catch {
			throw new FactStoreVersionError(`Failed to parse fact state at ${this.path}`);
		}
		try {
			return parseFactState(parsed);
		} catch (error) {
			if (error instanceof FactStateVersionError) throw new FactStoreVersionError(`${this.path}: ${error.message}`);
			throw error;
		}
	}

	list(): Fact[] {
		return this.read().facts;
	}

	active(): Fact[] {
		return this.list().filter(isActiveFact);
	}

	get(id: string): Fact | undefined {
		return this.read().facts.find((fact) => fact.id === id);
	}

	add(draft: FactDraft): AddFactResult {
		const text = draft.text.trim().replace(/\s+/g, " ");
		if (text.length === 0) throw new Error("Fact text must not be empty");
		if (charCount(text) > MAX_FACT_TEXT_CHARS)
			throw new Error(`Fact text must be at most ${MAX_FACT_TEXT_CHARS} characters`);
		if (isSensitiveText(text)) throw new SensitiveFactError();
		const applicability = draft.applicability ?? "universal";
		const projects = normalizeProjects(draft.projects);
		if (applicability === "project" && projects.length === 0)
			throw new Error("Project-scoped facts require at least one project key");
		const supersedes = [...new Set(draft.supersedes ?? [])].filter((id) => id.trim().length > 0);

		return this.withLockedState<AddFactResult>((state) => {
			for (const id of supersedes) {
				if (!state.facts.some((fact) => fact.id === id)) throw new Error(`Cannot supersede unknown fact: ${id}`);
			}
			const candidates = state.facts.filter((fact) => isActiveFact(fact) && !supersedes.includes(fact.id));
			const hash = factTextHash(text);
			const duplicate = candidates.find((fact) => factTextHash(fact.text) === hash);
			if (duplicate) return { changed: false, result: { action: "duplicate", fact: duplicate } };

			const scored = candidates
				.map((fact) => ({ fact, similarity: factSimilarity(fact.text, text) }))
				.filter((entry) => entry.similarity >= CONFLICT_SIMILARITY)
				.sort((left, right) => right.similarity - left.similarity);
			const best = scored[0];
			const conflicting =
				best !== undefined &&
				(hasContradictionMarker(text) ||
					hasContradictionMarker(best.fact.text) ||
					numbersDiffer(best.fact.text, text));
			if (best !== undefined && conflicting) {
				const conflictCandidates = scored.slice(0, MAX_CONFLICT_CANDIDATES).map((entry) => entry.fact);
				return { changed: false, result: { action: "conflict", candidates: conflictCandidates } };
			}

			const now = new Date().toISOString();
			if (best !== undefined && best.similarity >= MERGE_SIMILARITY) {
				const merged = best.fact;
				if (charCount(text) > charCount(merged.text)) merged.text = text;
				merged.topics = normalizeTopics([...merged.topics, ...normalizeTopics(draft.topics)]);
				merged.importance = Math.max(merged.importance, clampImportance(draft.importance));
				merged.updatedAt = now;
				return { changed: true, result: { action: "merged", fact: merged } };
			}

			const fact: Fact = {
				id: `fact_${uuidv7()}`,
				text,
				kind: draft.kind ?? "event",
				applicability,
				topics: normalizeTopics(draft.topics),
				importance: clampImportance(draft.importance),
				confidence: clampConfidence(draft.confidence),
				createdAt: now,
				updatedAt: now,
				retrievalCount: 0,
				pinned: false,
				reviewState: "unreviewed",
				source: { ...draft.source, entryIds: [...draft.source.entryIds] },
			};
			if (projects.length > 0) fact.projects = projects;
			if (draft.originProject !== undefined) fact.originProject = { ...draft.originProject };
			if (draft.validUntil !== undefined) fact.validUntil = draft.validUntil;
			if (supersedes.length > 0) fact.supersedes = supersedes;
			state.facts.push(fact);
			for (const id of supersedes) {
				const previous = state.facts.find((entry) => entry.id === id);
				if (!previous) continue;
				previous.archivedAt = now;
				previous.archiveReason = "superseded";
				previous.supersededBy = fact.id;
				previous.updatedAt = now;
			}
			return { changed: true, result: { action: "created", fact } };
		});
	}

	setPinned(id: string, pinned: boolean): Fact {
		return this.mutateFact(id, (fact, now) => {
			fact.pinned = pinned;
			fact.updatedAt = now;
			return fact;
		});
	}

	setReviewState(id: string, state: FactReviewState, patch?: { promotedToSectionId?: string }): Fact {
		return this.mutateFact(id, (fact, now) => {
			fact.reviewState = state;
			fact.reviewedAt = now;
			fact.updatedAt = now;
			if (patch?.promotedToSectionId !== undefined) fact.promotedToSectionId = patch.promotedToSectionId;
			return fact;
		});
	}

	archive(id: string, reason: FactArchiveReason): boolean {
		return this.withLockedState((state) => {
			const fact = state.facts.find((entry) => entry.id === id);
			if (!fact || fact.archivedAt !== undefined) return { changed: false, result: false };
			const now = new Date().toISOString();
			fact.archivedAt = now;
			fact.archiveReason = reason;
			fact.updatedAt = now;
			return { changed: true, result: true };
		});
	}

	recordRetrieval(ids: string[]): void {
		const wanted = new Set(ids);
		if (wanted.size === 0) return;
		this.withLockedState((state) => {
			const now = new Date().toISOString();
			let changed = false;
			for (const fact of state.facts) {
				if (!wanted.has(fact.id)) continue;
				fact.retrievalCount += 1;
				fact.lastRetrievedAt = now;
				changed = true;
			}
			return { changed, result: undefined };
		});
	}

	prune(options: PruneOptions = {}): { archived: number } {
		const now = options.now ?? new Date();
		const staleAfterDays =
			options.staleAfterDays !== undefined && Number.isFinite(options.staleAfterDays) && options.staleAfterDays > 0
				? options.staleAfterDays
				: STALE_AFTER_DAYS;
		const nowMs = now.getTime();
		return this.withLockedState((state) => {
			const at = now.toISOString();
			let archived = 0;
			for (const fact of state.facts) {
				if (fact.archivedAt !== undefined) continue;
				const reason = archiveReasonFor(fact, nowMs, staleAfterDays);
				if (reason === undefined) continue;
				fact.archivedAt = at;
				fact.archiveReason = reason;
				fact.updatedAt = at;
				archived += 1;
			}
			return { changed: archived > 0, result: { archived } };
		});
	}

	private mutateFact(id: string, update: (fact: Fact, now: string) => Fact): Fact {
		return this.withLockedState((state) => {
			const fact = state.facts.find((entry) => entry.id === id);
			if (!fact) throw new Error(`Fact not found: ${id}`);
			const result = update(fact, new Date().toISOString());
			return { changed: true, result };
		});
	}

	private withLockedState<T>(fn: (state: FactState) => LockedOutcome<T>): T {
		this.ensureDirectory();
		const release = this.acquireLockSyncWithRetry(this.path);
		try {
			const state = this.read();
			const outcome = fn(state);
			if (outcome.changed) this.write(state);
			return outcome.result;
		} finally {
			release();
		}
	}

	private acquireLockSyncWithRetry(path: string): () => void {
		const maxAttempts = 10;
		const delayMs = 20;
		let lastError: unknown;

		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			try {
				return lockfile.lockSync(path, { realpath: false });
			} catch (error) {
				const code =
					typeof error === "object" && error !== null && "code" in error
						? String((error as { code?: unknown }).code)
						: undefined;
				if (code !== "ELOCKED" || attempt === maxAttempts) {
					throw error;
				}
				lastError = error;
				const start = Date.now();
				while (Date.now() - start < delayMs) {
					// Sleep synchronously to keep the store API synchronous for callers.
				}
			}
		}

		throw (lastError as Error) ?? new Error("Failed to acquire fact store lock");
	}

	private ensureDirectory(): void {
		const directory = dirname(this.path);
		if (!existsSync(directory)) mkdirSync(directory, { recursive: true, mode: 0o700 });
	}

	private write(state: FactState): void {
		this.ensureDirectory();
		const temporaryPath = `${this.path}.${process.pid}.tmp`;
		writeFileSync(temporaryPath, `${JSON.stringify(state, null, "\t")}\n`, { encoding: "utf8", mode: 0o600 });
		chmodSync(temporaryPath, 0o600);
		renameSync(temporaryPath, this.path);
		chmodSync(this.path, 0o600);
		// 落盘成功才广播，读失败或没变化（如重复事实）不通知。
		notifyMemoryChanged("store");
	}
}
