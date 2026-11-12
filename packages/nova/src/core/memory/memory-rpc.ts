/**
 * 记忆的 RPC 侧纯函数。
 *
 * RPC 模式只做参数校验与结果包装，存储读写全部走 `core/memory` 既有 API，
 * 保证 CLI、模型工具、桌面端三条入口共用同一套语义：
 *
 * - 读：事实返回全部条目（含已归档），按“置顶优先 + 创建时间倒序”排序，
 *   `archivedAt`/`archiveReason` 交给调用方区分活跃与归档，统计值始终针对整个事实库，
 *   不受 `applicability` 过滤影响。
 * - 写：`pin`/`unpin` 改置顶；`archive` 与 `delete` 都是软删除，等价于
 *   `archive(id, "manual")`（不改动 `delete` 的物理删除语义，因为事实库本身不支持硬删除）；
 *   `edit` 只改 patch 里的字段，不新建事实也不合并近重复，重复/冲突作为结果返回。
 * - 错误：不存在的 id、缺失或多余的 patch、非法字段值直接抛错，由 RPC 命令循环统一转成
 *   error 响应；这里不返回错误对象。
 */

import type { Fact, FactApplicability } from "./fact-schema.ts";
import { FactStore, type FactUpdatePatch } from "./fact-store.ts";
import { resolveSuggestion } from "./memory-review.ts";
import { type MemorySuggestion, type SuggestionStatus, SuggestionStore } from "./suggestion-store.ts";

export type MemoryFactAction = "pin" | "unpin" | "archive" | "delete" | "edit";
export type MemorySuggestionResolution = "accept" | "reject";

const MEMORY_FACT_ACTIONS: readonly MemoryFactAction[] = ["pin", "unpin", "archive", "delete", "edit"];
const MEMORY_SUGGESTION_RESOLUTIONS: readonly MemorySuggestionResolution[] = ["accept", "reject"];

/** 命令入参来自 JSON，运行时必须重新校验联合类型。 */
export function isMemoryFactAction(value: unknown): value is MemoryFactAction {
	return typeof value === "string" && (MEMORY_FACT_ACTIONS as readonly string[]).includes(value);
}

export function isMemorySuggestionResolution(value: unknown): value is MemorySuggestionResolution {
	return typeof value === "string" && (MEMORY_SUGGESTION_RESOLUTIONS as readonly string[]).includes(value);
}

export interface MemoryFactsStats {
	active: number;
	archived: number;
	pendingSuggestions: number;
}

export interface MemoryFactsResult {
	facts: Fact[];
	stats: MemoryFactsStats;
}

export interface MemorySuggestionsResult {
	suggestions: MemorySuggestion[];
}

/** `edit` 的响应会带回 `FactStore.update` 的判定结果，其余 action 只有 `{ ok: true }`。 */
export type MemoryFactUpdateResult =
	| { ok: true }
	| { ok: true; action: "updated"; fact: Fact }
	| { ok: true; action: "duplicate"; fact: Fact }
	| { ok: true; action: "conflict"; candidates: Fact[] };

function isActiveFact(fact: Fact): boolean {
	return fact.archivedAt === undefined && fact.supersededBy === undefined;
}

function timeValue(iso: string): number {
	const parsed = Date.parse(iso);
	return Number.isNaN(parsed) ? 0 : parsed;
}

/** 置顶优先，其余按创建时间倒序，再按 id 保证顺序稳定（与 `nova memory list` 一致）。 */
function compareFacts(left: Fact, right: Fact): number {
	if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
	const created = timeValue(right.createdAt) - timeValue(left.createdAt);
	if (created !== 0) return created;
	if (left.id === right.id) return 0;
	return left.id < right.id ? -1 : 1;
}

/** 最新的建议优先，再按 id 保证顺序稳定。 */
function compareSuggestions(left: MemorySuggestion, right: MemorySuggestion): number {
	const created = timeValue(right.createdAt) - timeValue(left.createdAt);
	if (created !== 0) return created;
	if (left.id === right.id) return 0;
	return left.id < right.id ? -1 : 1;
}

/**
 * 待确认建议数。建议库读不出来（版本不认识或文件损坏）时按 0 计，
 * 并落一条诊断：事实页不应因为建议库损坏而整个打不开。
 */
function countPendingSuggestions(agentDir: string): number {
	try {
		return new SuggestionStore(agentDir).list("pending").length;
	} catch (error) {
		console.error("[memory:rpc]", error);
		return 0;
	}
}

/**
 * 读取事实列表与统计。
 * `applicability` 只过滤 `facts`；`stats` 描述整个事实库，便于前端展示总览。
 */
export function getMemoryFacts(options: { agentDir: string; applicability?: FactApplicability }): MemoryFactsResult {
	const all = new FactStore(options.agentDir).list();
	const active = all.filter(isActiveFact).length;
	const facts = (
		options.applicability === undefined ? all : all.filter((fact) => fact.applicability === options.applicability)
	).sort(compareFacts);
	return {
		facts,
		stats: {
			active,
			archived: all.length - active,
			pendingSuggestions: countPendingSuggestions(options.agentDir),
		},
	};
}

/** 读取建议列表，默认只返回待确认的建议。 */
export function getMemorySuggestions(options: {
	agentDir: string;
	status?: SuggestionStatus;
}): MemorySuggestionsResult {
	const status = options.status ?? "pending";
	const suggestions = new SuggestionStore(options.agentDir).list(status).sort(compareSuggestions);
	return { suggestions };
}

/**
 * 置顶/取消置顶/归档/删除/编辑一条事实。
 * 不存在 id 抛错；已经归档的事实再次归档是幂等的（不再推进更新时间）。
 * `edit` 必须带 patch，其它 action 不允许带 patch；重复/冲突以成功响应携带 action 返回，
 * 由调用方决定如何展示（与 `FactStore.update` 的返回值一一对应）。
 */
export function updateMemoryFact(options: {
	agentDir: string;
	id: string;
	action: MemoryFactAction;
	patch?: FactUpdatePatch;
}): MemoryFactUpdateResult {
	const store = new FactStore(options.agentDir);
	if (options.action === "edit") {
		if (options.patch === undefined) throw new Error("Edit requires a patch");
		const result = store.update(options.id, options.patch);
		if (result.action === "updated") return { ok: true, action: "updated", fact: result.fact };
		if (result.action === "duplicate") return { ok: true, action: "duplicate", fact: result.fact };
		return { ok: true, action: "conflict", candidates: result.candidates };
	}
	if (options.patch !== undefined) throw new Error("Patch is only valid for edit");
	const fact = store.get(options.id);
	if (fact === undefined) throw new Error(`Fact not found: ${options.id}`);
	if (options.action === "pin" || options.action === "unpin") {
		store.setPinned(options.id, options.action === "pin");
		return { ok: true };
	}
	if (fact.archivedAt !== undefined) return { ok: true };
	store.archive(options.id, "manual");
	return { ok: true };
}

/**
 * 接受或拒绝一条晋升建议。
 * 接受会把建议写进画像并归档相关事实，返回新段落 id；拒绝把事实退回 kept。
 * 不存在 id 或状态冲突（如已接受再拒绝）由 `resolveSuggestion` 抛错。
 */
export function resolveMemorySuggestion(options: {
	agentDir: string;
	id: string;
	action: MemorySuggestionResolution;
}): { ok: true; sectionId?: string } {
	const result = resolveSuggestion({ agentDir: options.agentDir, suggestionId: options.id, action: options.action });
	if (result.sectionId === undefined) return { ok: true };
	return { ok: true, sectionId: result.sectionId };
}
