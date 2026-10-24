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
	isFactKind,
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

export interface FactUpdatePatch {
	text?: string;
	kind?: FactKind;
	importance?: number;
	applicability?: FactApplicability;
	topics?: string[];
	validUntil?: string;
}

export type AddFactResult =
	| { action: "created"; fact: Fact }
	| { action: "duplicate"; fact: Fact }
	| { action: "merged"; fact: Fact }
	| { action: "conflict"; candidates: Fact[] };

/** 编辑不新建事实也不合并；只返回被编辑的条目，或挡下它的条目。 */
export type UpdateFactResult =
	| { action: "updated"; fact: Fact }
	| { action: "duplicate"; fact: Fact }
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

/** 新增与编辑共用的文本清洗与校验，保证两条入口落盘的是同一种形状。 */
function cleanFactText(raw: string): string {
	const text = raw.trim().replace(/\s+/g, " ");
	if (text.length === 0) throw new Error("Fact text must not be empty");
	if (charCount(text) > MAX_FACT_TEXT_CHARS)
		throw new Error(`Fact text must be at most ${MAX_FACT_TEXT_CHARS} characters`);
	if (isSensitiveText(text)) throw new SensitiveFactError();
	return text;
}

/** 编辑是显式操作，非法的 importance 直接拒绝，不像 add 那样静默 clamp。 */
function requireImportance(value: number): number {
	const rounded = Math.round(value);
	if (!Number.isFinite(value) || rounded < 1 || rounded > 5)
		throw new Error("Fact importance must be an integer between 1 and 5");
	return rounded;
}

function requireValidUntil(value: string): string {
	const trimmed = value.trim();
	if (trimmed.length === 0 || Number.isNaN(Date.parse(trimmed)))
		throw new Error(`Invalid validUntil timestamp: ${value}`);
	return trimmed;
}

interface SimilarityHit {
	fact: Fact;
	similarity: number;
}

function findDuplicateFact(candidates: Fact[], text: string): Fact | undefined {
	const hash = factTextHash(text);
	return candidates.find((fact) => factTextHash(fact.text) === hash);
}

/** 相似度达到冲突门槛的候选，按相似度倒序。 */
function rankSimilarFacts(candidates: Fact[], text: string): SimilarityHit[] {
	return candidates
		.map((fact) => ({ fact, similarity: factSimilarity(fact.text, text) }))
		.filter((entry) => entry.similarity >= CONFLICT_SIMILARITY)
		.sort((left, right) => right.similarity - left.similarity);
}

/** 新增与编辑共用：最相似的一条若带否定词或数字差异，整批候选都算冲突。 */
function contradictoryCandidates(hits: SimilarityHit[], text: string): Fact[] | undefined {
	const best = hits[0];
	if (best === undefined) return undefined;
	const conflicting =
		hasContradictionMarker(text) || hasContradictionMarker(best.fact.text) || numbersDiffer(best.fact.text, text);
	if (!conflicting) return undefined;
	return hits.slice(0, MAX_CONFLICT_CANDIDATES).map((entry) => entry.fact);
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
		const text = cleanFactText(draft.text);
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
			const duplicate = findDuplicateFact(candidates, text);
			if (duplicate) return { changed: false, result: { action: "duplicate", fact: duplicate } };

			const scored = rankSimilarFacts(candidates, text);
			const best = scored[0];
			const conflictCandidates = contradictoryCandidates(scored, text);
			if (conflictCandidates) {
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

	/**
	 * 编辑一条已存在的事实。
	 *
	 * 只改 `FactUpdatePatch` 里的字段；`id`/`createdAt`/`source`/`pinned`/`retrievalCount`/
	 * `projects`/`originProject`/`supersedes` 一律保留。文本变化时重算去重哈希，
	 * 与其它活跃事实走和 `add` 相同的重复/冲突判定，但**不合并**：只要归一化文本不完全相同
	 * 又足够相似，就返回冲突让调用方显式处理。重复与冲突都不写盘、不广播。
	 */
	update(id: string, patch: FactUpdatePatch): UpdateFactResult {
		const text = patch.text === undefined ? undefined : cleanFactText(patch.text);
		if (patch.kind !== undefined && !isFactKind(patch.kind)) throw new Error(`Unknown fact kind: ${patch.kind}`);
		const importance = patch.importance === undefined ? undefined : requireImportance(patch.importance);
		const topics = patch.topics === undefined ? undefined : normalizeTopics(patch.topics);
		const validUntil = patch.validUntil === undefined ? undefined : requireValidUntil(patch.validUntil);

		return this.withLockedState<UpdateFactResult>((state) => {
			const fact = state.facts.find((entry) => entry.id === id);
			if (!fact) throw new Error(`Fact not found: ${id}`);
			if (patch.applicability === "project" && (fact.projects === undefined || fact.projects.length === 0)) {
				throw new Error("Project-scoped facts require at least one project key");
			}

			const textChanged = text !== undefined && text !== fact.text;
			if (text !== undefined && textChanged) {
				const candidates = state.facts.filter((entry) => isActiveFact(entry) && entry.id !== fact.id);
				const duplicate = findDuplicateFact(candidates, text);
				if (duplicate) return { changed: false, result: { action: "duplicate", fact: duplicate } };

				const scored = rankSimilarFacts(candidates, text);
				const conflictCandidates = contradictoryCandidates(scored, text);
				if (conflictCandidates)
					return { changed: false, result: { action: "conflict", candidates: conflictCandidates } };

				// 近重复在 add 里会被合并；编辑不静默改另一条事实，所以同样报冲突。
				const nearDuplicates = scored
					.filter((entry) => entry.similarity >= MERGE_SIMILARITY)
					.slice(0, MAX_CONFLICT_CANDIDATES)
					.map((entry) => entry.fact);
				if (nearDuplicates.length > 0) {
					return { changed: false, result: { action: "conflict", candidates: nearDuplicates } };
				}
			}

			const now = new Date().toISOString();
			if (text !== undefined) fact.text = text;
			if (patch.kind !== undefined) fact.kind = patch.kind;
			if (importance !== undefined) fact.importance = importance;
			if (patch.applicability !== undefined) fact.applicability = patch.applicability;
			if (topics !== undefined) fact.topics = topics;
			if (validUntil !== undefined) fact.validUntil = validUntil;
			if (textChanged) fact.reviewState = "unreviewed";
			fact.updatedAt = now;
			return { changed: true, result: { action: "updated", fact } };
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
