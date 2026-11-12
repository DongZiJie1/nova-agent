/**
 * 会话内抽取区间标记。
 *
 * 标记写成会话文件里的自定义条目（`customType = "nova.memory_extraction"`），
 * 由 `buildSessionContext` 忽略，不进入模型上下文；只用于增量抽取、强杀恢复与 fork 复用。
 *
 * 读取时只认最后一条 data 合法（对象且 `throughEntryId` 为字符串）的标记；
 * 更早的非法标记被跳过，继续向前找。
 */

import type { SessionEntry, SessionManager } from "../session-manager.ts";

export const MEMORY_EXTRACTION_CUSTOM_TYPE = "nova.memory_extraction";

export interface ExtractionMarker {
	fromEntryId?: string; // 本次区间的起点（上一条消息 id），便于排查
	throughEntryId: string; // 已总结到的最后一条消息条目 id
	at: string; // ISO
	model?: string;
	factIds: string[]; // 本次产生的事实 id
}

export interface ExtractionMarkerState {
	marker?: ExtractionMarker;
	markerEntryId?: string;
}

/**
 * 把自定义条目的 data 解析成标记。
 * `throughEntryId` 不是字符串时视为非法；其余字段缺省或类型不对时用保守值补齐，
 * `at` 回落到条目自身的时间戳，保证返回的标记始终可用。
 */
function parseMarkerData(data: unknown, fallbackAt: string): ExtractionMarker | undefined {
	if (typeof data !== "object" || data === null || Array.isArray(data)) return undefined;
	const record = data as Record<string, unknown>;
	const throughEntryId = record.throughEntryId;
	if (typeof throughEntryId !== "string") return undefined;

	const factIds: string[] = [];
	if (Array.isArray(record.factIds)) {
		for (const factId of record.factIds) {
			if (typeof factId === "string") factIds.push(factId);
		}
	}

	const marker: ExtractionMarker = {
		throughEntryId,
		at: typeof record.at === "string" ? record.at : fallbackAt,
		factIds,
	};
	if (typeof record.fromEntryId === "string") marker.fromEntryId = record.fromEntryId;
	if (typeof record.model === "string") marker.model = record.model;
	return marker;
}

/** 收集消息条目，保持会话顺序并丢弃 custom / custom_message / compaction 等非消息条目。 */
function messageEntries(entries: SessionEntry[]): SessionEntry[] {
	const messages: SessionEntry[] = [];
	for (const entry of entries) {
		if (entry.type === "message") messages.push(entry);
	}
	return messages;
}

/** 读最后一条合法标记；没有则返回空状态。 */
export function readExtractionMarker(manager: { getEntries(): SessionEntry[] }): ExtractionMarkerState {
	const entries = manager.getEntries();
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry.type !== "custom" || entry.customType !== MEMORY_EXTRACTION_CUSTOM_TYPE) continue;
		const marker = parseMarkerData(entry.data, entry.timestamp);
		if (marker) return { marker, markerEntryId: entry.id };
	}
	return {};
}

/** 把标记追加为会话自定义条目。调用方负责只在抽取成功后调用。 */
export function appendExtractionMarker(session: { sessionManager: SessionManager }, marker: ExtractionMarker): void {
	session.sessionManager.appendCustomEntry(MEMORY_EXTRACTION_CUSTOM_TYPE, marker);
}

/**
 * 返回标记之后待抽取的消息条目。
 * 无标记，或标记指向的条目已不存在（分支被裁剪、fork 后的孤儿标记）时保守地从头开始。
 */
export function selectPendingEntries(entries: SessionEntry[], state: ExtractionMarkerState): SessionEntry[] {
	const throughEntryId = state.marker?.throughEntryId;
	if (throughEntryId === undefined) return messageEntries(entries);

	const throughIndex = entries.findIndex((entry) => entry.id === throughEntryId);
	if (throughIndex < 0) return messageEntries(entries);
	return messageEntries(entries.slice(throughIndex + 1));
}

/** 最后一条消息条目的 id；没有消息时返回 undefined。 */
export function lastMessageEntryId(entries: SessionEntry[]): string | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		if (entries[index].type === "message") return entries[index].id;
	}
	return undefined;
}
