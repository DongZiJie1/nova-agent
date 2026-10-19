/**
 * 抽取：消息序列化、提示词构造、模型输出解析、噪声过滤与落库。
 *
 * 模型调用通过注入的 `complete` 完成，本模块不做网络请求，便于测试与替换。
 * 解析与过滤都不抛错：非法 JSON、非法条目、噪声事实一律丢弃，仅在提供 `onDiagnostic`
 * 回调时报告原因，默认静默（调用方可用它写日志）。
 */

import type { AgentMessage } from "@dongzijie1/pi-agent-core";
import { isSensitiveText } from "../sensitive.ts";
import type { SessionEntry } from "../session-manager.ts";
import {
	type Fact,
	type FactApplicability,
	type FactKind,
	type FactProjectRef,
	type FactSource,
	isFactApplicability,
	MAX_FACT_TEXT_CHARS,
	MAX_TOPICS,
} from "./fact-schema.ts";
import { type FactDraft, type FactStore, SensitiveFactError } from "./fact-store.ts";
import { factSimilarity, normalizeFactText, renderFactLine } from "./fact-text.ts";
import type { ResolvedMemorySettings } from "./memory-settings.ts";

export interface ExtractionSection {
	id: string;
	title: string;
	content: string;
}

export interface ExtractionContext {
	projectPath: string;
	projectKey: string;
	sections: ExtractionSection[];
	recentFacts: Fact[]; // 最近 20 条，供去重与替代引用
}

export interface ExtractedFact {
	text: string;
	kind: FactKind;
	importance: number;
	confidence: number;
	applicability: FactApplicability;
	projects?: string[];
	originProject?: FactProjectRef;
	topics: string[];
	validUntil?: string;
	supersedes?: string[];
}

export type ExtractionCompletion = (input: {
	systemPrompt: string;
	userPrompt: string;
	signal?: AbortSignal;
}) => Promise<string>;

export interface ApplyExtractionResult {
	created: number;
	merged: number;
	duplicates: number;
	conflicts: number;
	facts: Fact[];
}

export type ExtractionDiagnostic = (message: string) => void;

/** 截断输入时放在最前面的提示，告诉模型更早的消息已被丢弃。 */
const OMITTED_INPUT_NOTICE = "[earlier messages omitted]";
/** 交给模型的最近事实条数上限（`ExtractionContext.recentFacts` 的约定）。 */
const RECENT_FACT_LIMIT = 20;
/** CJK 文本的最小有效长度（字符）。 */
const MIN_CJK_CHARS = 8;
/** 纯英文文本的最小有效词数。 */
const MIN_ENGLISH_WORDS = 4;
/** 寒暄只在这种长度的文本里被判定为噪声。 */
const GREETING_MAX_CHARS = 12;
/** 与画像段落达到此相似度的事实视为画像重复。 */
const PROFILE_DUPLICATE_SIMILARITY = 0.85;

const CJK_CHAR = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/;
const GREETING_PATTERN = /^(?:你好|您好|hi\b|hello\b|在吗|谢谢|好的|ok\b|嗯|收到|明白)/i;

const FACT_KINDS: readonly FactKind[] = ["decision", "preference", "constraint", "project", "commitment", "event"];

const EXTRACTION_SYSTEM_PROMPT = `You extract durable, reusable facts from conversations with a coding assistant.
Reply with a single JSON object and nothing else: no prose, no markdown fences, no comments, no trailing text.
Extract only facts that stay useful after this session ends. Never extract secrets (API keys, tokens, passwords, private keys, credentials) and never guess or invent facts.
Each fact must be one self-contained sentence of at most ${MAX_FACT_TEXT_CHARS} characters.
"kind" must be one of: decision, preference, constraint, project, commitment, event.
"importance" is an integer from 1 (trivia) to 5 (critical).
"confidence" is a number from 0 to 1.
"applicability" must be one of: universal, transferable, project.
"topics" holds 1-3 short concept labels.`;

interface ParsedJsonSuccess {
	ok: true;
	value: unknown;
}

interface ParsedJsonFailure {
	ok: false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFactKind(value: unknown): value is FactKind {
	return typeof value === "string" && (FACT_KINDS as readonly string[]).includes(value);
}

function charLength(text: string): number {
	return Array.from(text).length;
}

function clampConfidence(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return 0.5;
	return Math.min(1, Math.max(0, value));
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

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

interface TextBlockLike {
	type: "text";
	text: string;
}

function isTextBlock(value: unknown): value is TextBlockLike {
	return (
		typeof value === "object" &&
		value !== null &&
		(value as { type?: unknown }).type === "text" &&
		typeof (value as { text?: unknown }).text === "string"
	);
}

/** 取消息里的文本内容：字符串直接用，块数组只拼 `text` 块（忽略 thinking 与 toolCall）。 */
function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content as unknown[]) {
		if (!isTextBlock(block)) continue;
		const text = block.text.trim();
		if (text.length === 0) continue;
		parts.push(text);
	}
	return parts.join("\n");
}

/** 把消息条目序列化成 `[user] ...` / `[assistant] ...`，跳过非消息条目、toolResult 与空文本。 */
function serializeEntries(entries: SessionEntry[]): string {
	const lines: string[] = [];
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const message: AgentMessage = entry.message;
		if (message.role !== "user" && message.role !== "assistant") continue;
		const text = contentText(message.content).trim();
		if (text.length === 0) continue;
		lines.push(`[${message.role}] ${text}`);
	}
	return lines.join("\n\n");
}

/** 超长时保留尾部并加 `[earlier messages omitted]`，总长不超过 `maxChars`。 */
function truncateInputTail(text: string, maxChars: number): string {
	const chars = Array.from(text);
	if (chars.length <= maxChars) return text;
	const noticeLength = charLength(OMITTED_INPUT_NOTICE);
	// 预算小到放不下提示时只返回提示的前缀，保证结果不超过 maxChars。
	if (maxChars <= noticeLength) return Array.from(OMITTED_INPUT_NOTICE).slice(0, maxChars).join("");
	const budget = maxChars - noticeLength - 1;
	const tail = chars
		.slice(chars.length - budget)
		.join("")
		.trimStart();
	return `${OMITTED_INPUT_NOTICE}\n${tail}`;
}

function buildExtractionUserPrompt(
	conversation: string,
	context: ExtractionContext,
	settings: ResolvedMemorySettings,
): string {
	const profile =
		context.sections.length === 0
			? "(none)"
			: context.sections.map((section) => `## ${section.title}\n${section.content}`).join("\n\n");
	const recentFacts = context.recentFacts.slice(0, RECENT_FACT_LIMIT);
	const recent = recentFacts.length === 0 ? "(none)" : recentFacts.map((fact) => renderFactLine(fact)).join("\n");
	const maxFacts = settings.extraction.maxFactsPerBatch;
	const rules = [
		"Rules:",
		"- Keep: durable decisions, user preferences, hard constraints, project conventions, commitments, and notable events that affect future work.",
		"- Drop: greetings, small talk, acknowledgements, questions, transient debugging output, tool output, restatements of this conversation, and anything only true for a moment.",
		"- Write each fact as one self-contained sentence with concrete names instead of pronouns.",
		"- importance: 5 = must never be forgotten, 4 = important convention, 3 = useful context, 2 = minor but durable, 1 = trivia (do not emit).",
		'- applicability: "universal" applies in every project; "transferable" was learned here but applies elsewhere; "project" applies only to the project key above.',
		'- For "project" facts set "projects": ["<project key above>"].',
		"- topics: 1-3 short lowercase concept labels.",
		"- supersedes: only ids from the recent stored facts that the new fact replaces.",
		`- Return at most ${maxFacts} facts. If nothing qualifies, return {"facts":[]}.`,
		"- Never include secrets, credentials, file contents, or guesses.",
		'Respond with JSON only using this shape: {"facts":[{"text":"...","kind":"preference","importance":3,"confidence":0.8,"applicability":"project","projects":["..."],"topics":["..."],"validUntil":"2025-01-31","supersedes":["fact_..."]}]}',
	].join("\n");
	return [
		"Extract durable facts from the conversation slice below.",
		`Project path: ${context.projectPath}`,
		`Project key: ${context.projectKey}`,
		`Existing user profile (already stored; do not duplicate it):\n${profile}`,
		`Recent stored facts (reference their ids in "supersedes"; do not duplicate them):\n${recent}`,
		`Conversation:\n${conversation}`,
		rules,
	].join("\n\n");
}

function tryParseJson(text: string): ParsedJsonSuccess | ParsedJsonFailure {
	try {
		return { ok: true, value: JSON.parse(text) };
	} catch {
		return { ok: false };
	}
}

/** 去掉 ```json 围栏；没有围栏时返回原文。 */
function stripCodeFence(raw: string): string {
	const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
	if (fenced && fenced[1].trim().length > 0) return fenced[1].trim();
	return raw.trim();
}

/** 容忍前后杂质：解析失败时截取第一个 `{` 到最后一个 `}` 再试一次。 */
function parseJsonPayload(raw: string): unknown {
	const text = stripCodeFence(raw);
	const direct = tryParseJson(text);
	if (direct.ok) return direct.value;
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start >= 0 && end > start) {
		const sliced = tryParseJson(text.slice(start, end + 1));
		if (sliced.ok) return sliced.value;
	}
	return undefined;
}

function factCandidates(payload: unknown): unknown[] {
	if (Array.isArray(payload)) return payload as unknown[];
	if (isRecord(payload) && Array.isArray(payload.facts)) return payload.facts as unknown[];
	return [];
}

/** 校验单条模型输出；字段不合法返回 undefined（由调用方丢弃）。 */
function parseExtractedFact(value: unknown): ExtractedFact | undefined {
	if (!isRecord(value)) return undefined;
	const text = typeof value.text === "string" ? value.text.trim().replace(/\s+/g, " ") : "";
	if (text.length === 0 || charLength(text) > MAX_FACT_TEXT_CHARS) return undefined;
	if (!isFactKind(value.kind)) return undefined;
	const importance = value.importance;
	if (typeof importance !== "number" || !Number.isFinite(importance) || importance < 1 || importance > 5) {
		return undefined;
	}
	const applicability = value.applicability === undefined ? "universal" : value.applicability;
	if (!isFactApplicability(applicability)) return undefined;
	const projects = stringList(value.projects);
	if (applicability === "project" && projects.length === 0) return undefined;

	const fact: ExtractedFact = {
		text,
		kind: value.kind,
		importance: Math.round(importance),
		confidence: clampConfidence(value.confidence),
		applicability,
		topics: stringList(value.topics).slice(0, MAX_TOPICS),
	};
	if (projects.length > 0) fact.projects = projects;
	if (typeof value.validUntil === "string" && value.validUntil.trim().length > 0) {
		fact.validUntil = value.validUntil.trim();
	}
	const supersedes = stringList(value.supersedes);
	if (supersedes.length > 0) fact.supersedes = supersedes;
	return fact;
}

function parseExtractedFacts(raw: string): ExtractedFact[] {
	const payload = parseJsonPayload(raw);
	const facts: ExtractedFact[] = [];
	for (const candidate of factCandidates(payload)) {
		const fact = parseExtractedFact(candidate);
		if (fact !== undefined) facts.push(fact);
	}
	return facts;
}

function hasCjkChar(text: string): boolean {
	return CJK_CHAR.test(text);
}

function countEnglishWords(normalized: string): number {
	let count = 0;
	for (const word of normalized.split(/\s+/)) {
		if (/[a-z0-9]/.test(word)) count += 1;
	}
	return count;
}

function isTooShort(text: string): boolean {
	const normalized = normalizeFactText(text);
	if (normalized.length === 0) return true;
	if (hasCjkChar(normalized)) return charLength(normalized) < MIN_CJK_CHARS;
	return countEnglishWords(normalized) < MIN_ENGLISH_WORDS;
}

function isGreeting(text: string): boolean {
	const normalized = normalizeFactText(text);
	if (charLength(normalized) >= GREETING_MAX_CHARS) return false;
	return GREETING_PATTERN.test(normalized);
}

function duplicatesProfile(text: string, sections: ExtractionSection[]): boolean {
	return sections.some((section) => factSimilarity(text, section.content) >= PROFILE_DUPLICATE_SIMILARITY);
}

function dropReason(
	fact: ExtractedFact,
	context: ExtractionContext,
	settings: ResolvedMemorySettings,
): string | undefined {
	if (isTooShort(fact.text)) return "too_short";
	if (isGreeting(fact.text)) return "greeting";
	if (isSensitiveText(fact.text)) return "sensitive";
	if (duplicatesProfile(fact.text, context.sections)) return "profile_duplicate";
	if (fact.importance < settings.extraction.minImportance) return "low_importance";
	return undefined;
}

interface FilterOutcome {
	kept: ExtractedFact[];
	dropped: Map<string, number>;
}

/** 过滤噪声后按重要性降序截断到 `maxFactsPerBatch`。 */
function filterExtractedFacts(
	facts: ExtractedFact[],
	context: ExtractionContext,
	settings: ResolvedMemorySettings,
): FilterOutcome {
	const dropped = new Map<string, number>();
	const kept: ExtractedFact[] = [];
	for (const fact of facts) {
		const reason = dropReason(fact, context, settings);
		if (reason !== undefined) {
			dropped.set(reason, (dropped.get(reason) ?? 0) + 1);
			continue;
		}
		kept.push(fact);
	}
	kept.sort((left, right) => right.importance - left.importance);
	const limited = kept.slice(0, settings.extraction.maxFactsPerBatch);
	if (kept.length > limited.length) dropped.set("batch_limit", kept.length - limited.length);
	return { kept: limited, dropped };
}

/**
 * 会话消息 → 提示词 → 模型输出 → 事实。
 * 空对话返回空数组且不调用模型；模型抛错原样向上抛（由调用方决定重试与记录）。
 */
export async function extractFacts(input: {
	entries: SessionEntry[];
	context: ExtractionContext;
	settings: ResolvedMemorySettings;
	complete: ExtractionCompletion;
	signal?: AbortSignal;
	onDiagnostic?: ExtractionDiagnostic;
}): Promise<ExtractedFact[]> {
	const conversation = serializeEntries(input.entries);
	if (conversation.length === 0) return [];
	const maxInputChars = input.settings.extraction.maxInputChars;
	const truncated = truncateInputTail(conversation, maxInputChars);
	if (truncated !== conversation) {
		input.onDiagnostic?.(`[memory] extraction input truncated to ${maxInputChars} characters`);
	}
	const raw = await input.complete({
		systemPrompt: EXTRACTION_SYSTEM_PROMPT,
		userPrompt: buildExtractionUserPrompt(truncated, input.context, input.settings),
		signal: input.signal,
	});
	const outcome = filterExtractedFacts(parseExtractedFacts(raw), input.context, input.settings);
	for (const [reason, count] of outcome.dropped) {
		input.onDiagnostic?.(`[memory] dropped ${count} extracted fact(s): ${reason}`);
	}
	return outcome.kept;
}

/** 把抽取结果落库：逐条 `store.add`，统计四种结果，敏感事实计入 duplicates 且不抛出。 */
export function applyExtractedFacts(input: {
	store: FactStore;
	facts: ExtractedFact[];
	source: FactSource;
	projectKey: string;
	onDiagnostic?: ExtractionDiagnostic;
}): ApplyExtractionResult {
	const result: ApplyExtractionResult = { created: 0, merged: 0, duplicates: 0, conflicts: 0, facts: [] };
	for (const extracted of input.facts) {
		const draft = buildFactDraft(extracted, input.source, input.projectKey, input.store);
		try {
			const outcome = input.store.add(draft);
			if (outcome.action === "created") {
				result.created += 1;
				result.facts.push(outcome.fact);
			} else if (outcome.action === "merged") {
				result.merged += 1;
				result.facts.push(outcome.fact);
			} else if (outcome.action === "duplicate") {
				result.duplicates += 1;
			} else {
				result.conflicts += 1;
			}
		} catch (error) {
			if (error instanceof SensitiveFactError) {
				result.duplicates += 1;
				input.onDiagnostic?.(`[memory] skipped sensitive fact: ${extracted.text}`);
				continue;
			}
			// 其余错误（长度、未知替代 id 等）说明模型输出不可落库，跳过并记录，不中断整批。
			result.duplicates += 1;
			input.onDiagnostic?.(`[memory] skipped fact "${extracted.text}": ${errorMessage(error)}`);
		}
	}
	return result;
}

function buildFactDraft(extracted: ExtractedFact, source: FactSource, projectKey: string, store: FactStore): FactDraft {
	// 未知 id 会让 store.add 抛错，这里先过滤成已知事实，避免一条坏引用毁掉整批。
	const supersedes = stringList(extracted.supersedes).filter((id) => store.get(id) !== undefined);
	const draft: FactDraft = {
		text: extracted.text,
		kind: isFactKind(extracted.kind) ? extracted.kind : "preference",
		importance: extracted.importance,
		confidence: extracted.confidence,
		applicability: isFactApplicability(extracted.applicability) ? extracted.applicability : "universal",
		topics: stringList(extracted.topics).slice(0, MAX_TOPICS),
		source,
	};
	if (draft.applicability === "project") {
		const projects = stringList(extracted.projects);
		draft.projects = projects.length > 0 ? projects : [projectKey];
	}
	if (extracted.originProject !== undefined) draft.originProject = extracted.originProject;
	if (extracted.validUntil !== undefined) draft.validUntil = extracted.validUntil;
	if (supersedes.length > 0) draft.supersedes = supersedes;
	return draft;
}
