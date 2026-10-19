import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

export type FactKind = "decision" | "preference" | "constraint" | "project" | "commitment" | "event";
export type FactApplicability = "universal" | "transferable" | "project";
export type FactArchiveReason = "expired" | "stale" | "superseded" | "manual" | "promoted" | "capped";
export type FactReviewState = "unreviewed" | "kept" | "suggested" | "promoted";

export interface FactProjectRef {
	key: string; // sha1(realpath(cwd)).slice(0, 12)
	path: string;
}

export interface FactSource {
	sessionFile: string;
	sessionId: string;
	entryIds: string[]; // 来源会话条目 id，可跳回
	extractedAt: string; // ISO
	model: string; // "provider/model" 或 "explicit"
}

export interface Fact {
	id: string; // fact_<uuidv7>
	text: string; // 单句，<= 200 字符
	kind: FactKind;
	applicability: FactApplicability;
	projects?: string[]; // applicability=project 时必填且非空
	originProject?: FactProjectRef; // transferable 的来源项目
	topics: string[]; // 1-3 个概念标签
	importance: number; // 1-5
	confidence: number; // 0-1
	createdAt: string;
	updatedAt: string;
	lastRetrievedAt?: string;
	retrievalCount: number;
	pinned: boolean;
	archivedAt?: string;
	archiveReason?: FactArchiveReason;
	validUntil?: string;
	supersededBy?: string;
	supersedes?: string[];
	promotionSuggestedAt?: string;
	promotedToSectionId?: string;
	reviewState: FactReviewState;
	reviewedAt?: string;
	source: FactSource;
}

export interface FactState {
	version: 1;
	facts: Fact[];
}

export const FACT_STATE_VERSION = 1;
export const MAX_FACT_TEXT_CHARS = 200;
export const MAX_TOPICS = 3;

const FACT_KINDS: readonly FactKind[] = ["decision", "preference", "constraint", "project", "commitment", "event"];
const FACT_APPLICABILITIES: readonly FactApplicability[] = ["universal", "transferable", "project"];
const FACT_ARCHIVE_REASONS: readonly FactArchiveReason[] = [
	"expired",
	"stale",
	"superseded",
	"manual",
	"promoted",
	"capped",
];
const FACT_REVIEW_STATES: readonly FactReviewState[] = ["unreviewed", "kept", "suggested", "promoted"];

const DEFAULT_IMPORTANCE = 3;
const DEFAULT_CONFIDENCE = 0.5;

export class FactStateVersionError extends Error {
	constructor(message = "Unsupported fact state version") {
		super(message);
		this.name = "FactStateVersionError";
	}
}

export function isFactApplicability(value: unknown): value is FactApplicability {
	return typeof value === "string" && (FACT_APPLICABILITIES as readonly string[]).includes(value);
}

function isFactKind(value: unknown): value is FactKind {
	return typeof value === "string" && (FACT_KINDS as readonly string[]).includes(value);
}

function isFactReviewState(value: unknown): value is FactReviewState {
	return typeof value === "string" && (FACT_REVIEW_STATES as readonly string[]).includes(value);
}

function isFactArchiveReason(value: unknown): value is FactArchiveReason {
	return typeof value === "string" && (FACT_ARCHIVE_REASONS as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalProjectPath(cwd: string): string {
	try {
		return realpathSync.native(cwd);
	} catch {
		return resolve(cwd);
	}
}

export function computeProjectKey(cwd: string): string {
	return projectRefForCwd(cwd).key;
}

export function projectRefForCwd(cwd: string): FactProjectRef {
	const path = canonicalProjectPath(cwd);
	return { key: createHash("sha1").update(path).digest("hex").slice(0, 12), path };
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	if (value < min) return min;
	if (value > max) return max;
	return value;
}

function clampCount(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return 0;
	return Math.floor(value);
}

function stringList(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const result: string[] = [];
	for (const item of value as unknown[]) {
		if (typeof item !== "string") continue;
		const trimmed = item.trim();
		if (trimmed.length === 0 || result.includes(trimmed)) continue;
		result.push(trimmed);
	}
	return result;
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalStringList(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const result = stringList(value);
	return result.length > 0 ? result : undefined;
}

function parseProjectRef(value: unknown): FactProjectRef | undefined {
	if (!isRecord(value)) return undefined;
	const { key, path } = value;
	if (typeof key !== "string" || key.length === 0) return undefined;
	if (typeof path !== "string" || path.length === 0) return undefined;
	return { key, path };
}

function parseSource(value: unknown): FactSource | undefined {
	if (!isRecord(value)) return undefined;
	const { sessionFile, sessionId, entryIds, extractedAt, model } = value;
	if (typeof sessionFile !== "string" || typeof sessionId !== "string") return undefined;
	if (typeof extractedAt !== "string" || typeof model !== "string") return undefined;
	if (!Array.isArray(entryIds)) return undefined;
	const ids: string[] = [];
	for (const entryId of entryIds as unknown[]) {
		if (typeof entryId !== "string") return undefined;
		ids.push(entryId);
	}
	return { sessionFile, sessionId, entryIds: ids, extractedAt, model };
}

function parseFact(value: unknown): Fact | undefined {
	if (!isRecord(value)) return undefined;
	const { id, text, createdAt, updatedAt } = value;
	if (typeof id !== "string" || id.trim().length === 0) return undefined;
	if (typeof text !== "string" || text.trim().length === 0) return undefined;
	if (typeof createdAt !== "string" || createdAt.length === 0) return undefined;
	if (typeof updatedAt !== "string" || updatedAt.length === 0) return undefined;
	const source = parseSource(value.source);
	if (!source) return undefined;
	const applicability = value.applicability;
	if (!isFactApplicability(applicability)) return undefined;
	const projects = stringList(value.projects);
	if (applicability === "project" && projects.length === 0) return undefined;

	const fact: Fact = {
		id,
		text,
		kind: isFactKind(value.kind) ? value.kind : "event",
		applicability,
		topics: stringList(value.topics).slice(0, MAX_TOPICS),
		importance: clampNumber(value.importance, 1, 5, DEFAULT_IMPORTANCE),
		confidence: clampNumber(value.confidence, 0, 1, DEFAULT_CONFIDENCE),
		createdAt,
		updatedAt,
		retrievalCount: clampCount(value.retrievalCount),
		pinned: value.pinned === true,
		reviewState: isFactReviewState(value.reviewState) ? value.reviewState : "unreviewed",
		source,
	};
	if (projects.length > 0) fact.projects = projects;
	const originProject = parseProjectRef(value.originProject);
	if (originProject) fact.originProject = originProject;
	const supersedes = optionalStringList(value.supersedes);
	if (supersedes) fact.supersedes = supersedes;
	const lastRetrievedAt = optionalString(value.lastRetrievedAt);
	if (lastRetrievedAt) fact.lastRetrievedAt = lastRetrievedAt;
	const archivedAt = optionalString(value.archivedAt);
	if (archivedAt) fact.archivedAt = archivedAt;
	const archiveReason = value.archiveReason;
	if (isFactArchiveReason(archiveReason)) fact.archiveReason = archiveReason;
	const validUntil = optionalString(value.validUntil);
	if (validUntil) fact.validUntil = validUntil;
	const supersededBy = optionalString(value.supersededBy);
	if (supersededBy) fact.supersededBy = supersededBy;
	const promotionSuggestedAt = optionalString(value.promotionSuggestedAt);
	if (promotionSuggestedAt) fact.promotionSuggestedAt = promotionSuggestedAt;
	const promotedToSectionId = optionalString(value.promotedToSectionId);
	if (promotedToSectionId) fact.promotedToSectionId = promotedToSectionId;
	const reviewedAt = optionalString(value.reviewedAt);
	if (reviewedAt) fact.reviewedAt = reviewedAt;
	return fact;
}

export function parseFactState(value: unknown): FactState {
	if (!isRecord(value) || value.version !== FACT_STATE_VERSION)
		throw new FactStateVersionError(`Expected fact state version ${FACT_STATE_VERSION}`);
	const rawFacts = Array.isArray(value.facts) ? value.facts : [];
	const facts: Fact[] = [];
	for (const entry of rawFacts as unknown[]) {
		const fact = parseFact(entry);
		if (fact) facts.push(fact);
	}
	return { version: FACT_STATE_VERSION, facts };
}
