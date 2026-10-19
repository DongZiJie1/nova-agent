import type { Fact } from "./fact-schema.ts";
import { estimateMemoryTokens, factTokens, renderFactLine, truncateFactText } from "./fact-text.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

const WEIGHT_RECENCY = 0.4;
const WEIGHT_IMPORTANCE = 0.28;
const WEIGHT_USAGE = 0.14;
const WEIGHT_PROJECT = 0.1;
const WEIGHT_TOPIC = 0.08;

const DEFAULT_HALF_LIFE_DAYS = 21;
const DEFAULT_MIN_SCORE = 0.35;
const DEFAULT_MAX_PROMPT_TOKENS = 1000;
const DEFAULT_MAX_PROMPT_FACTS = 12;
const DEFAULT_MAX_TEXT_CHARS = 160;
/** 置顶事实优先入选的条数上限。 */
const MAX_PINNED_FACTS = 3;
/** usage 达到封顶值对应的命中次数。 */
const USAGE_SATURATION_COUNT = 20;

export interface FactSelectionContext {
	now?: number;
	projectKey?: string;
	gateProjectFacts?: boolean; // 默认 true
	crossProjectRecall?: boolean; // 默认 true
	halfLifeDays?: number; // 默认 21
	minScore?: number; // 默认 0.35
	maxPromptTokens?: number; // 默认 1000
	maxPromptFacts?: number; // 默认 12
	maxTextChars?: number; // 默认 160
	topics?: string[]; // 当前线索主题
}

export interface SelectedFact {
	fact: Fact;
	text: string;
	score: number;
}

interface ScoredFact {
	fact: Fact;
	score: number;
}

function clamp(value: number, min: number, max: number): number {
	if (value < min) return min;
	if (value > max) return max;
	return value;
}

function resolvePositive(value: number | undefined, fallback: number): number {
	if (value === undefined || !Number.isFinite(value) || value <= 0) return fallback;
	return value;
}

function resolveCount(value: number | undefined, fallback: number): number {
	if (value === undefined || !Number.isFinite(value)) return fallback;
	return Math.max(0, Math.floor(value));
}

/** 时间衰减：半衰期越短衰减越快，未来时间按最新处理。 */
function recencyScore(fact: Fact, nowMs: number, halfLifeDays: number): number {
	const reference = Date.parse(fact.lastRetrievedAt ?? fact.createdAt);
	if (Number.isNaN(reference)) return 0;
	const ageDays = Math.max(0, (nowMs - reference) / DAY_MS);
	return 0.5 ** (ageDays / halfLifeDays);
}

/** 命中次数取对数并封顶到 1。 */
function usageScore(retrievalCount: number): number {
	if (!Number.isFinite(retrievalCount) || retrievalCount <= 0) return 0;
	return Math.min(1, Math.log1p(retrievalCount) / Math.log1p(USAGE_SATURATION_COUNT));
}

/** 同项目 1；project 适用性但不同项目 0；其它 0.5。 */
function projectScore(fact: Fact, projectKey: string | undefined): number {
	const inProject = projectKey !== undefined && (fact.projects ?? []).includes(projectKey);
	if (fact.applicability === "project") return inProject ? 1 : 0;
	return inProject ? 1 : 0.5;
}

function topicScore(fact: Fact, topics: string[] | undefined): number {
	if (topics === undefined || topics.length === 0) return 0;
	const factTopics = new Set(factTokens(fact.topics.join(" ")));
	const contextTopics = new Set(factTokens(topics.join(" ")));
	if (factTopics.size === 0 || contextTopics.size === 0) return 0;
	let intersection = 0;
	for (const token of factTopics) {
		if (contextTopics.has(token)) intersection += 1;
	}
	const union = factTopics.size + contextTopics.size - intersection;
	return union === 0 ? 0 : intersection / union;
}

function isExpired(fact: Fact, nowMs: number): boolean {
	if (fact.validUntil === undefined) return false;
	const expiry = Date.parse(fact.validUntil);
	return !Number.isNaN(expiry) && expiry <= nowMs;
}

function isSameProject(fact: Fact, projectKey: string | undefined): boolean {
	if (projectKey === undefined) return false;
	if ((fact.projects ?? []).includes(projectKey)) return true;
	return fact.originProject?.key === projectKey;
}

/** 资格：未归档、未被替代、未过期，并通过项目作用域门控。 */
function isEligible(fact: Fact, context: FactSelectionContext, nowMs: number): boolean {
	if (fact.archivedAt !== undefined || fact.supersededBy !== undefined) return false;
	if (isExpired(fact, nowMs)) return false;
	const scopedToProject = context.projectKey !== undefined && (fact.projects ?? []).includes(context.projectKey);
	if (context.gateProjectFacts !== false && fact.applicability === "project" && !scopedToProject) return false;
	if (context.crossProjectRecall === false) {
		if (fact.applicability !== "universal" && !isSameProject(fact, context.projectKey)) return false;
	}
	return true;
}

export function scoreFact(fact: Fact, context: FactSelectionContext = {}, now?: number): number {
	const nowMs = now ?? context.now ?? Date.now();
	const halfLifeDays = resolvePositive(context.halfLifeDays, DEFAULT_HALF_LIFE_DAYS);
	return (
		WEIGHT_RECENCY * recencyScore(fact, nowMs, halfLifeDays) +
		WEIGHT_IMPORTANCE * (clamp(fact.importance, 1, 5) / 5) +
		WEIGHT_USAGE * usageScore(fact.retrievalCount) +
		WEIGHT_PROJECT * projectScore(fact, context.projectKey) +
		WEIGHT_TOPIC * topicScore(fact, context.topics)
	);
}

function compareScored(left: ScoredFact, right: ScoredFact): number {
	return right.score - left.score;
}

export function selectFacts(facts: Fact[], context: FactSelectionContext = {}): SelectedFact[] {
	const nowMs = context.now ?? Date.now();
	const minScore =
		context.minScore !== undefined && Number.isFinite(context.minScore) ? context.minScore : DEFAULT_MIN_SCORE;
	const maxPromptTokens = resolveCount(context.maxPromptTokens, DEFAULT_MAX_PROMPT_TOKENS);
	const maxPromptFacts = resolveCount(context.maxPromptFacts, DEFAULT_MAX_PROMPT_FACTS);
	const maxTextChars = resolveCount(context.maxTextChars, DEFAULT_MAX_TEXT_CHARS);
	if (maxPromptFacts === 0 || maxPromptTokens === 0) return [];

	const eligible: ScoredFact[] = [];
	for (const fact of facts) {
		if (!isEligible(fact, context, nowMs)) continue;
		eligible.push({ fact, score: scoreFact(fact, context, nowMs) });
	}

	const pinned = eligible
		.filter((entry) => entry.fact.pinned)
		.sort(compareScored)
		.slice(0, MAX_PINNED_FACTS);
	const pinnedIds = new Set(pinned.map((entry) => entry.fact.id));
	const candidates = eligible
		.filter((entry) => !pinnedIds.has(entry.fact.id) && entry.score >= minScore)
		.sort(compareScored);

	const selected: SelectedFact[] = [];
	let usedTokens = 0;
	for (const entry of [...pinned, ...candidates]) {
		if (selected.length >= maxPromptFacts) break;
		const text = truncateFactText(entry.fact.text, maxTextChars);
		/** 预算按注入渲染的那一行估算，避免预算与实际注入不一致。 */
		const cost = estimateMemoryTokens(renderFactLine(entry.fact, text));
		if (usedTokens + cost > maxPromptTokens) break;
		usedTokens += cost;
		selected.push({ fact: entry.fact, text, score: entry.score });
	}
	return selected;
}
