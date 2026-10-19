/**
 * 会话结束评审与画像晋升。
 *
 * 抽取只产出事实；评审再把“稳定、跨会话仍有价值”的候选事实送给一次模型调用，
 * 换回画像变更建议（新建段落 / 追加 / 更新）。建议默认只落 `suggestions.json`，
 * 用户执行 `nova memory promote` 后才写 `user-memory.json` 并归档事实。
 *
 * 三条不变量：
 * - 没有候选就不调用模型；候选最多 10 条，评审最多产出一批建议。
 * - 模型失败、取消或输出不可解析时不写任何评审状态，留到下次评审重试。
 * - 建议里的 `factIds` 必须来自本批候选，`append`/`update` 必须指向已存在的画像段落。
 */

import { isSensitiveText } from "../sensitive.ts";
import { type UserMemorySection, UserMemoryStore } from "../user-memory.ts";
import type { ExtractionCompletion } from "./fact-extraction.ts";
import type { Fact } from "./fact-schema.ts";
import { FactStore } from "./fact-store.ts";
import { renderFactLine } from "./fact-text.ts";
import type { ResolvedMemorySettings } from "./memory-settings.ts";
import { isSuggestionAction, type MemorySuggestion, SuggestionStore } from "./suggestion-store.ts";

/** 一次评审最多送给模型的事实条数。 */
const MAX_REVIEW_CANDIDATES = 10;
/** 一次评审最多落库的建议条数，避免模型一次改动太多段落。 */
const MAX_SUGGESTIONS = 5;
const MAX_TITLE_CHARS = 80;
const MAX_CONTENT_CHARS = 4000;

const REVIEW_SYSTEM_PROMPT = `You review a coding assistant's long-term memory and propose changes to the user's durable profile.
Reply with a single JSON object and nothing else: no prose, no markdown fences, no comments, no trailing text.
Propose only stable, durable, cross-project information about the user: identity, working style, standing preferences, and conventions they set that should apply in every future session. Keep the profile about the user, not about what the assistant did in past sessions.
Never propose secrets, credentials, file contents, transient debugging details, or guesses. Never mention this review or the fact ids in the proposed content itself.`;

export interface ReviewOptions {
	agentDir: string;
	cwd: string;
	settings: ResolvedMemorySettings;
	store: FactStore;
	suggestions: SuggestionStore;
	complete: ExtractionCompletion;
	scope: { type: "session"; sessionId: string } | { type: "all" };
	/**
	 * 后台抽取未配置 `extraction.model` 时会把来源记为 `"explicit"`，与 `remember` 工具无法区分。
	 * 抽取后的会话内评审把它置为 true，只看重要性，避免每次抽取成功后再多一次模型调用；
	 * 启动全量评审保持 false，兜住显式写入的低重要性事实。
	 */
	skipExplicitExemption?: boolean;
	signal?: AbortSignal;
}

export interface ReviewResult {
	candidates: number;
	created: number;
	kept: number;
	failed: number;
}

interface ValidSuggestion {
	action: MemorySuggestion["action"];
	targetSectionId?: string;
	title: string;
	proposedContent: string;
	previousContent?: string;
	reason?: string;
	factIds: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function charLength(text: string): number {
	return Array.from(text).length;
}

function updatedAtMs(fact: Fact): number {
	const parsed = Date.parse(fact.updatedAt);
	return Number.isNaN(parsed) ? 0 : parsed;
}

function isActiveFact(fact: Fact): boolean {
	return fact.archivedAt === undefined && fact.supersededBy === undefined;
}

/**
 * 候选事实：未评审、未归档、未被替代、universal、无有效期，
 * 且重要性达到晋升门槛，或由 `remember` 工具显式写入（`source.model === "explicit"`）。
 */
function isReviewCandidate(fact: Fact, options: ReviewOptions): boolean {
	if (fact.reviewState !== "unreviewed" || !isActiveFact(fact)) return false;
	if (fact.applicability !== "universal" || fact.validUntil !== undefined) return false;
	if (options.scope.type === "session" && fact.source.sessionId !== options.scope.sessionId) return false;
	if (fact.importance >= options.settings.facts.promotion.minImportance) return true;
	if (options.skipExplicitExemption === true) return false;
	return fact.source.model === "explicit";
}

/** 高重要性优先；同分按更新时间倒序，再按 id 保证顺序稳定。 */
function selectReviewCandidates(options: ReviewOptions): Fact[] {
	return options.store
		.list()
		.filter((fact) => isReviewCandidate(fact, options))
		.sort((left, right) => {
			if (right.importance !== left.importance) return right.importance - left.importance;
			const byUpdated = updatedAtMs(right) - updatedAtMs(left);
			if (byUpdated !== 0) return byUpdated;
			if (left.id === right.id) return 0;
			return left.id < right.id ? -1 : 1;
		})
		.slice(0, MAX_REVIEW_CANDIDATES);
}

function renderExistingSections(sections: UserMemorySection[]): string {
	if (sections.length === 0) return "(none)";
	return sections
		.map((section) => `## ${section.title}\n<section_id>${section.id}</section_id>\n${section.content}`)
		.join("\n\n");
}

function buildReviewPrompts(
	candidates: Fact[],
	sections: UserMemorySection[],
): { systemPrompt: string; userPrompt: string } {
	const candidateLines = candidates.map((fact) => renderFactLine(fact)).join("\n");
	const rules = [
		"Rules:",
		'- "action": "create" adds a new section; "append" adds to an existing section; "update" rewrites an existing section.',
		'- "append" and "update" must include "targetSectionId" copied from an existing section above.',
		'- "factIds" must use only ids from the candidate facts. A suggestion without a supporting candidate is invalid.',
		`- "title" is 1-${MAX_TITLE_CHARS} characters. "proposedContent" is 1-${MAX_CONTENT_CHARS} characters.`,
		"- Write the title and content in the language the user writes in.",
		"- Prefer fewer, well-supported suggestions; return an empty list when nothing belongs in a durable profile.",
		`- Return at most ${MAX_SUGGESTIONS} suggestions.`,
		'Respond with JSON only using this shape: {"suggestions":[{"action":"create","title":"...","proposedContent":"...","reason":"...","factIds":["fact_..."]}]}',
	].join("\n");
	return {
		systemPrompt: REVIEW_SYSTEM_PROMPT,
		userPrompt: [
			"Review the candidate facts below and propose updates to the user's durable profile.",
			`Existing profile sections (reference their ids in "targetSectionId"):\n${renderExistingSections(sections)}`,
			`Candidate facts:\n${candidateLines}`,
			rules,
		].join("\n\n"),
	};
}

/** 去掉 ```json 围栏，容忍前后杂质。解析失败返回 undefined。 */
function parseJsonPayload(raw: string): unknown {
	const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
	const text = fenced && fenced[1].trim().length > 0 ? fenced[1].trim() : raw.trim();
	try {
		return JSON.parse(text);
	} catch {
		const start = text.indexOf("{");
		const end = text.lastIndexOf("}");
		if (start < 0 || end <= start) return undefined;
		try {
			return JSON.parse(text.slice(start, end + 1));
		} catch {
			return undefined;
		}
	}
}

function suggestionCandidates(payload: unknown): unknown[] | undefined {
	if (Array.isArray(payload)) return payload as unknown[];
	if (!isRecord(payload)) return undefined;
	if (!Array.isArray(payload.suggestions)) return undefined;
	return payload.suggestions as unknown[];
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

/**
 * 校验一条模型建议；任何字段不合法都整条丢弃（返回 undefined）。
 * `factIds` 必须全部来自本批候选，`append`/`update` 必须指向已存在的段落。
 */
function validateSuggestion(
	value: unknown,
	candidateIds: Set<string>,
	sectionsById: Map<string, UserMemorySection>,
): ValidSuggestion | undefined {
	if (!isRecord(value) || !isSuggestionAction(value.action)) return undefined;
	const action = value.action;
	const factIds = stringList(value.factIds);
	if (factIds.length === 0) return undefined;
	for (const id of factIds) {
		if (!candidateIds.has(id)) return undefined;
	}

	const title = typeof value.title === "string" ? value.title.trim() : "";
	if (title.length === 0 || charLength(title) > MAX_TITLE_CHARS) return undefined;
	const proposedContent = typeof value.proposedContent === "string" ? value.proposedContent.trim() : "";
	if (proposedContent.length === 0 || charLength(proposedContent) > MAX_CONTENT_CHARS) return undefined;
	if (isSensitiveText(proposedContent)) return undefined;

	const suggestion: ValidSuggestion = { action, title, proposedContent, factIds };
	if (action !== "create") {
		const targetSectionId = typeof value.targetSectionId === "string" ? value.targetSectionId.trim() : "";
		const section = sectionsById.get(targetSectionId);
		if (targetSectionId.length === 0 || section === undefined) return undefined;
		suggestion.targetSectionId = targetSectionId;
		suggestion.previousContent = section.content;
	}
	if (typeof value.reason === "string" && value.reason.trim().length > 0) suggestion.reason = value.reason.trim();
	return suggestion;
}

/**
 * 评审候选事实并写入建议库。
 * 没有候选、被取消或模型失败时不写任何评审状态；模型失败只记录，不向调用方抛错。
 */
export async function reviewFacts(options: ReviewOptions): Promise<ReviewResult> {
	const result: ReviewResult = { candidates: 0, created: 0, kept: 0, failed: 0 };
	let candidates: Fact[];
	try {
		candidates = selectReviewCandidates(options);
	} catch (error) {
		console.error("[memory:review]", error);
		result.failed = 1;
		return result;
	}
	result.candidates = candidates.length;
	if (candidates.length === 0) return result;
	if (options.signal?.aborted) {
		result.failed = candidates.length;
		return result;
	}

	let sections: UserMemorySection[] = [];
	try {
		sections = new UserMemoryStore(options.agentDir).list();
	} catch (error) {
		// 画像读不出来时按“没有段落”评审：仍可产出 create 建议，不阻断候选处理。
		console.error("[memory:review]", error);
	}
	const prompts = buildReviewPrompts(candidates, sections);

	let raw: string;
	try {
		raw = await options.complete({ ...prompts, signal: options.signal });
	} catch (error) {
		if (options.signal?.aborted) {
			result.failed = candidates.length;
			return result;
		}
		console.error("[memory:review]", error);
		result.failed = candidates.length;
		return result;
	}
	if (options.signal?.aborted) {
		result.failed = candidates.length;
		return result;
	}

	const payloadCandidates = suggestionCandidates(parseJsonPayload(raw));
	if (payloadCandidates === undefined) {
		console.error("[memory:review]", new Error("Review response did not contain a suggestions array"));
		result.failed = candidates.length;
		return result;
	}

	const candidateIds = new Set(candidates.map((fact) => fact.id));
	const sectionsById = new Map(sections.map((section) => [section.id, section]));
	const valid: ValidSuggestion[] = [];
	for (const entry of payloadCandidates.slice(0, MAX_SUGGESTIONS)) {
		const suggestion = validateSuggestion(entry, candidateIds, sectionsById);
		if (suggestion !== undefined) valid.push(suggestion);
	}

	const referenced = new Set<string>();
	const persisted: MemorySuggestion[] = [];
	let persistFailed = false;
	for (const suggestion of valid) {
		try {
			const added = options.suggestions.add(suggestion);
			if (added.action === "created") result.created += 1;
			persisted.push(added.suggestion);
			for (const id of suggestion.factIds) referenced.add(id);
		} catch (error) {
			// 建议库版本不认识或写入失败时整批按失败处理：不标记事实，下次评审重试。
			console.error("[memory:review]", error);
			persistFailed = true;
		}
	}
	if (persistFailed) {
		result.failed += 1;
		return result;
	}

	for (const candidate of candidates) {
		const state = referenced.has(candidate.id) ? "suggested" : "kept";
		try {
			options.store.setReviewState(candidate.id, state);
			if (state === "kept") result.kept += 1;
		} catch (error) {
			console.error("[memory:review]", error);
			result.failed += 1;
		}
	}

	if (options.settings.facts.promotion.auto) {
		for (const suggestion of persisted) {
			try {
				resolveSuggestion({ agentDir: options.agentDir, suggestionId: suggestion.id, action: "accept" });
			} catch (error) {
				console.error("[memory:review]", error);
				result.failed += 1;
			}
		}
	}

	return result;
}

/** 把建议写进画像；返回新段落或更新后的段落。 */
function applySuggestionToProfile(store: UserMemoryStore, suggestion: MemorySuggestion): UserMemorySection {
	if (suggestion.action === "create") {
		return store.upsertSection(undefined, suggestion.title, suggestion.proposedContent);
	}
	const targetSectionId = suggestion.targetSectionId;
	if (targetSectionId === undefined) throw new Error(`Suggestion ${suggestion.id} has no target section`);
	const existing = store.list().find((section) => section.id === targetSectionId);
	if (existing === undefined) throw new Error(`Memory section not found: ${targetSectionId}`);
	if (suggestion.action === "append") {
		return store.upsertSection(existing.id, suggestion.title, `${existing.content}\n${suggestion.proposedContent}`);
	}
	return store.upsertSection(existing.id, suggestion.title, suggestion.proposedContent);
}

/**
 * 接受或拒绝一条建议。
 * 接受：写画像、事实标记 promoted 并归档、建议标记 accepted（记录新段落 id）。
 * 拒绝：事实回到 kept，建议标记 rejected。
 * 同一动作重复调用是幂等的；已以另一种动作结束的建议会抛错。
 */
export function resolveSuggestion(options: { agentDir: string; suggestionId: string; action: "accept" | "reject" }): {
	sectionId?: string;
} {
	const suggestions = new SuggestionStore(options.agentDir);
	const suggestion = suggestions.get(options.suggestionId);
	if (suggestion === undefined) throw new Error(`Suggestion not found: ${options.suggestionId}`);

	if (options.action === "reject") {
		if (suggestion.status === "rejected") return {};
		if (suggestion.status === "accepted") throw new Error(`Suggestion already accepted: ${options.suggestionId}`);
		markFacts(options.agentDir, suggestion.factIds, "kept");
		suggestions.resolve(suggestion.id, "rejected");
		return {};
	}

	if (suggestion.status === "accepted") {
		return suggestion.appliedSectionId === undefined ? {} : { sectionId: suggestion.appliedSectionId };
	}
	if (suggestion.status === "rejected") throw new Error(`Suggestion already rejected: ${options.suggestionId}`);
	const section = applySuggestionToProfile(new UserMemoryStore(options.agentDir), suggestion);
	markFacts(options.agentDir, suggestion.factIds, "promoted", section.id);
	suggestions.resolve(suggestion.id, "accepted", { appliedSectionId: section.id });
	return { sectionId: section.id };
}

function markFacts(agentDir: string, factIds: string[], state: "kept" | "promoted", sectionId?: string): void {
	const store = new FactStore(agentDir);
	for (const id of factIds) {
		if (store.get(id) === undefined) continue;
		if (state === "promoted") {
			store.setReviewState(id, "promoted", sectionId === undefined ? undefined : { promotedToSectionId: sectionId });
			store.archive(id, "promoted");
			continue;
		}
		store.setReviewState(id, "kept");
	}
}
