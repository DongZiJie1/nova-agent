/**
 * 记忆功能设置：接口、默认值与解析。
 *
 * 默认值只在解析时生效，不写入 settings.json。非法值（非有限、负数、要求为正时的 0）
 * 回落到默认值；需要夹取的字段（maxPromptFacts、maxInputChars、timeoutMs、sessionEndFlushMs）
 * 按 CONTRACTS 第 7 节与 STEP-05 的边界处理。
 */

export interface MemoryPromotionSettings {
	minHits?: number; // 默认 6
	minImportance?: number; // 默认 4
	minAgeDays?: number; // 默认 14
	auto?: boolean; // 默认 false
}

export interface MemoryFactsSettings {
	enabled?: boolean; // 默认 true
	maxPromptTokens?: number; // 默认 1000
	maxPromptFacts?: number; // 默认 12，夹取到 1-30
	halfLifeDays?: number; // 默认 21
	minScore?: number; // 默认 0.35，0 合法
	maxTextChars?: number; // 默认 160
	crossProjectRecall?: boolean; // 默认 true
	gateProjectFacts?: boolean; // 默认 true
	archiveAfterDays?: number; // 默认 90
	maxActiveFacts?: number; // 默认 5000
	promotion?: MemoryPromotionSettings;
}

export interface MemoryExtractionSettings {
	enabled?: boolean; // 默认 true
	idleMinutes?: number; // 默认 8，0 表示关闭空闲触发
	checkpointTurns?: number; // 默认 20
	maxInputChars?: number; // 默认 24000，最小 1000
	minImportance?: number; // 默认 2
	maxFactsPerBatch?: number; // 默认 8
	model?: string; // 默认 undefined（沿用当前会话模型）
	timeoutMs?: number; // 默认 30000，最小 1000
	sessionEndFlushMs?: number; // 默认 3000，夹取到 0-15000
}

export interface MemorySettings {
	enabled?: boolean; // 默认 true
	facts?: MemoryFactsSettings;
	extraction?: MemoryExtractionSettings;
}

export interface ResolvedMemoryPromotionSettings {
	minHits: number;
	minImportance: number;
	minAgeDays: number;
	auto: boolean;
}

export interface ResolvedMemoryFactsSettings {
	enabled: boolean;
	maxPromptTokens: number;
	maxPromptFacts: number;
	halfLifeDays: number;
	minScore: number;
	maxTextChars: number;
	crossProjectRecall: boolean;
	gateProjectFacts: boolean;
	archiveAfterDays: number;
	maxActiveFacts: number;
	promotion: ResolvedMemoryPromotionSettings;
}

export interface ResolvedMemoryExtractionSettings {
	enabled: boolean;
	idleMinutes: number;
	checkpointTurns: number;
	maxInputChars: number;
	minImportance: number;
	maxFactsPerBatch: number;
	model: string | undefined;
	timeoutMs: number;
	sessionEndFlushMs: number;
}

export interface ResolvedMemorySettings {
	enabled: boolean;
	facts: ResolvedMemoryFactsSettings;
	extraction: ResolvedMemoryExtractionSettings;
}

export const DEFAULT_MEMORY_SETTINGS: ResolvedMemorySettings = {
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
};

function resolveBoolean(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

/** 有限且 > 0 的数值；其余情况回落默认值。 */
function resolvePositiveNumber(value: unknown, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback;
	return value;
}

/** 有限且 >= 0 的数值；其余情况回落默认值。 */
function resolveNonNegativeNumber(value: unknown, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return fallback;
	return value;
}

/** 正整数：取整后夹取到 [min, max]；非法值回落默认值。 */
function resolvePositiveInteger(value: unknown, fallback: number, min = 1, max = Number.MAX_SAFE_INTEGER): number {
	return Math.min(max, Math.max(min, Math.floor(resolvePositiveNumber(value, fallback))));
}

/** 非负整数：取整后夹取到 [min, max]；非法值回落默认值。 */
function resolveNonNegativeInteger(value: unknown, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER): number {
	return Math.min(max, Math.max(min, Math.floor(resolveNonNegativeNumber(value, fallback))));
}

/** 模型标识：去掉首尾空白，空串或非字符串视为未配置。 */
function resolveModel(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * 把用户配置解析成完整设置。输入 undefined 时返回默认值的深拷贝。
 * 每次调用都构造新对象，修改返回值不会影响 DEFAULT_MEMORY_SETTINGS。
 */
export function resolveMemorySettings(value: MemorySettings | undefined): ResolvedMemorySettings {
	const facts = value?.facts;
	const extraction = value?.extraction;
	const promotion = facts?.promotion;
	const defaults = DEFAULT_MEMORY_SETTINGS;

	return {
		enabled: resolveBoolean(value?.enabled, defaults.enabled),
		facts: {
			enabled: resolveBoolean(facts?.enabled, defaults.facts.enabled),
			maxPromptTokens: resolvePositiveInteger(facts?.maxPromptTokens, defaults.facts.maxPromptTokens),
			maxPromptFacts: resolvePositiveInteger(facts?.maxPromptFacts, defaults.facts.maxPromptFacts, 1, 30),
			halfLifeDays: resolvePositiveNumber(facts?.halfLifeDays, defaults.facts.halfLifeDays),
			minScore: resolveNonNegativeNumber(facts?.minScore, defaults.facts.minScore),
			maxTextChars: resolvePositiveInteger(facts?.maxTextChars, defaults.facts.maxTextChars),
			crossProjectRecall: resolveBoolean(facts?.crossProjectRecall, defaults.facts.crossProjectRecall),
			gateProjectFacts: resolveBoolean(facts?.gateProjectFacts, defaults.facts.gateProjectFacts),
			archiveAfterDays: resolvePositiveInteger(facts?.archiveAfterDays, defaults.facts.archiveAfterDays),
			maxActiveFacts: resolvePositiveInteger(facts?.maxActiveFacts, defaults.facts.maxActiveFacts),
			promotion: {
				minHits: resolvePositiveInteger(promotion?.minHits, defaults.facts.promotion.minHits),
				minImportance: resolvePositiveInteger(promotion?.minImportance, defaults.facts.promotion.minImportance),
				minAgeDays: resolveNonNegativeInteger(promotion?.minAgeDays, defaults.facts.promotion.minAgeDays),
				auto: resolveBoolean(promotion?.auto, defaults.facts.promotion.auto),
			},
		},
		extraction: {
			enabled: resolveBoolean(extraction?.enabled, defaults.extraction.enabled),
			idleMinutes: resolveNonNegativeInteger(extraction?.idleMinutes, defaults.extraction.idleMinutes),
			checkpointTurns: resolvePositiveInteger(extraction?.checkpointTurns, defaults.extraction.checkpointTurns),
			maxInputChars: resolvePositiveInteger(extraction?.maxInputChars, defaults.extraction.maxInputChars, 1000),
			minImportance: resolvePositiveInteger(extraction?.minImportance, defaults.extraction.minImportance),
			maxFactsPerBatch: resolvePositiveInteger(extraction?.maxFactsPerBatch, defaults.extraction.maxFactsPerBatch),
			model: resolveModel(extraction?.model),
			timeoutMs: resolvePositiveInteger(extraction?.timeoutMs, defaults.extraction.timeoutMs, 1000),
			sessionEndFlushMs: resolveNonNegativeInteger(
				extraction?.sessionEndFlushMs,
				defaults.extraction.sessionEndFlushMs,
				0,
				15000,
			),
		},
	};
}
