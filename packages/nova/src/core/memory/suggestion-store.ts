/**
 * 晋升建议库：评审产出的画像变更建议，默认等待用户确认后才应用。
 *
 * 持久化规则与事实库一致：`<agentDir>/memory/suggestions.json`，目录 0700、文件 0600，
 * `proper-lockfile` 锁 + 临时文件 + rename，空库不创建文件。
 * 版本不是 1 或无法解析时抛 `SuggestionStoreVersionError`，调用方据此降级为“没有建议”。
 *
 * 模型只写建议，从不直接改画像：`create`/`append`/`update` 三种动作都要经过
 * `memory-review.resolveSuggestion` 才会落到 `user-memory.json`。
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { uuidv7 } from "@dongzijie1/pi-ai";
import lockfile from "proper-lockfile";
import { getAgentDir } from "../../config.ts";
import { notifyMemoryChanged } from "./memory-events.ts";

export type SuggestionAction = "create" | "append" | "update";
export type SuggestionStatus = "pending" | "accepted" | "rejected";

export interface MemorySuggestion {
	id: string; // sug_<uuidv7>
	factIds: string[];
	action: SuggestionAction;
	targetSectionId?: string;
	title: string;
	proposedContent: string;
	previousContent?: string; // update/append 时保存旧内容用于 diff
	reason?: string;
	createdAt: string;
	status: SuggestionStatus;
	resolvedAt?: string;
	appliedSectionId?: string;
}

export interface SuggestionState {
	version: 1;
	suggestions: MemorySuggestion[];
}

export const SUGGESTION_STATE_VERSION = 1;

export class SuggestionStoreVersionError extends Error {
	constructor(message = "Unsupported suggestion store version") {
		super(message);
		this.name = "SuggestionStoreVersionError";
	}
}

const SUGGESTION_ACTIONS: readonly SuggestionAction[] = ["create", "append", "update"];
const SUGGESTION_STATUSES: readonly SuggestionStatus[] = ["pending", "accepted", "rejected"];

interface LockedOutcome<T> {
	changed: boolean;
	result: T;
}

export function isSuggestionAction(value: unknown): value is SuggestionAction {
	return typeof value === "string" && (SUGGESTION_ACTIONS as readonly string[]).includes(value);
}

/** 命令入参来自 JSON，RPC 层用它在运行时校验状态过滤值。 */
export function isSuggestionStatus(value: unknown): value is SuggestionStatus {
	return typeof value === "string" && (SUGGESTION_STATUSES as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** 去重并去掉空白 id；顺序保留，方便调用方按模型给出的顺序展示。 */
function uniqueIds(value: unknown): string[] {
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

function parseSuggestion(value: unknown): MemorySuggestion | undefined {
	if (!isRecord(value)) return undefined;
	const { id, title, proposedContent, createdAt, action, status } = value;
	if (typeof id !== "string" || id.length === 0) return undefined;
	if (typeof title !== "string" || title.trim().length === 0) return undefined;
	if (typeof proposedContent !== "string" || proposedContent.trim().length === 0) return undefined;
	if (typeof createdAt !== "string" || createdAt.length === 0) return undefined;
	if (!isSuggestionAction(action) || !isSuggestionStatus(status)) return undefined;
	const factIds = uniqueIds(value.factIds);
	if (factIds.length === 0) return undefined;

	const suggestion: MemorySuggestion = {
		id,
		factIds,
		action,
		title,
		proposedContent,
		createdAt,
		status,
	};
	const targetSectionId = optionalString(value.targetSectionId);
	if (targetSectionId !== undefined) suggestion.targetSectionId = targetSectionId;
	const previousContent = optionalString(value.previousContent);
	if (previousContent !== undefined) suggestion.previousContent = previousContent;
	const reason = optionalString(value.reason);
	if (reason !== undefined) suggestion.reason = reason;
	const resolvedAt = optionalString(value.resolvedAt);
	if (resolvedAt !== undefined) suggestion.resolvedAt = resolvedAt;
	const appliedSectionId = optionalString(value.appliedSectionId);
	if (appliedSectionId !== undefined) suggestion.appliedSectionId = appliedSectionId;
	// append/update 没有目标段落就无法应用，按非法条目丢弃。
	if (suggestion.action !== "create" && suggestion.targetSectionId === undefined) return undefined;
	return suggestion;
}

/**
 * 容错解析：丢弃非法条目，保留合法条目。
 * 版本不认识时抛错，让调用方明确降级，而不是把旧格式误读成空库。
 */
export function parseSuggestionState(value: unknown): SuggestionState {
	if (!isRecord(value) || value.version !== SUGGESTION_STATE_VERSION)
		throw new SuggestionStoreVersionError(`Expected suggestion state version ${SUGGESTION_STATE_VERSION}`);
	const raw = Array.isArray(value.suggestions) ? value.suggestions : [];
	const suggestions: MemorySuggestion[] = [];
	for (const entry of raw as unknown[]) {
		const suggestion = parseSuggestion(entry);
		if (suggestion !== undefined) suggestions.push(suggestion);
	}
	return { version: SUGGESTION_STATE_VERSION, suggestions };
}

/**
 * 去重键：动作 + 目标段落 + 排序后的事实 id。
 * 同一条建议被二次评审重复产出时返回已有记录，不新增。
 */
function suggestionKey(input: { action: SuggestionAction; targetSectionId?: string; factIds: string[] }): string {
	return [input.action, input.targetSectionId ?? "", [...input.factIds].sort().join(",")].join("\u0000");
}

export class SuggestionStore {
	readonly path: string;

	constructor(agentDir: string = getAgentDir()) {
		this.path = join(agentDir, "memory", "suggestions.json");
	}

	read(): SuggestionState {
		if (!existsSync(this.path)) return { version: SUGGESTION_STATE_VERSION, suggestions: [] };
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(this.path, "utf8"));
		} catch {
			throw new SuggestionStoreVersionError(`Failed to parse suggestion state at ${this.path}`);
		}
		try {
			return parseSuggestionState(parsed);
		} catch (error) {
			if (error instanceof SuggestionStoreVersionError) {
				throw new SuggestionStoreVersionError(`${this.path}: ${error.message}`);
			}
			throw error;
		}
	}

	list(status?: SuggestionStatus): MemorySuggestion[] {
		const suggestions = this.read().suggestions;
		return status === undefined ? suggestions : suggestions.filter((suggestion) => suggestion.status === status);
	}

	get(id: string): MemorySuggestion | undefined {
		return this.read().suggestions.find((suggestion) => suggestion.id === id);
	}

	/**
	 * 新增一条待确认建议。重复（同动作、同目标段落、同事实集合）时不写入，
	 * 返回已有记录，便于调用方继续标记事实状态。
	 */
	add(input: Omit<MemorySuggestion, "id" | "createdAt" | "status">): {
		action: "created" | "duplicate";
		suggestion: MemorySuggestion;
	} {
		if (!isSuggestionAction(input.action)) throw new Error(`Invalid suggestion action: ${input.action}`);
		const factIds = uniqueIds(input.factIds);
		if (factIds.length === 0) throw new Error("Suggestion requires at least one fact id");
		const targetSectionId = input.targetSectionId?.trim();
		if (input.action !== "create" && (targetSectionId === undefined || targetSectionId.length === 0)) {
			throw new Error(`Suggestion action "${input.action}" requires a target section id`);
		}
		const title = input.title.trim();
		const proposedContent = input.proposedContent.trim();
		if (title.length === 0) throw new Error("Suggestion title must not be empty");
		if (proposedContent.length === 0) throw new Error("Suggestion content must not be empty");

		const key = suggestionKey({ action: input.action, targetSectionId, factIds });
		return this.withLockedState<{ action: "created" | "duplicate"; suggestion: MemorySuggestion }>((state) => {
			const duplicate = state.suggestions.find(
				(existing) =>
					suggestionKey({
						action: existing.action,
						targetSectionId: existing.targetSectionId,
						factIds: existing.factIds,
					}) === key,
			);
			if (duplicate !== undefined) return { changed: false, result: { action: "duplicate", suggestion: duplicate } };

			const suggestion: MemorySuggestion = {
				id: `sug_${uuidv7()}`,
				factIds,
				action: input.action,
				title,
				proposedContent,
				createdAt: new Date().toISOString(),
				status: "pending",
			};
			if (targetSectionId !== undefined && targetSectionId.length > 0) suggestion.targetSectionId = targetSectionId;
			const previousContent = input.previousContent?.trim();
			if (previousContent !== undefined && previousContent.length > 0) {
				suggestion.previousContent = previousContent;
			}
			const reason = input.reason?.trim();
			if (reason !== undefined && reason.length > 0) suggestion.reason = reason;
			state.suggestions.push(suggestion);
			return { changed: true, result: { action: "created", suggestion } };
		});
	}

	/**
	 * 标记建议已接受或已拒绝。同一状态重复调用是幂等的；
	 * 已经以另一种状态结束的建议不允许改写，避免事实状态与建议状态错位。
	 */
	resolve(id: string, status: "accepted" | "rejected", patch?: { appliedSectionId?: string }): MemorySuggestion {
		return this.withLockedState((state) => {
			const suggestion = state.suggestions.find((entry) => entry.id === id);
			if (suggestion === undefined) throw new Error(`Suggestion not found: ${id}`);
			if (suggestion.status === status) {
				const applied = patch?.appliedSectionId;
				if (status === "accepted" && applied !== undefined && suggestion.appliedSectionId === undefined) {
					suggestion.appliedSectionId = applied;
					return { changed: true, result: suggestion };
				}
				return { changed: false, result: suggestion };
			}
			if (suggestion.status !== "pending") {
				throw new Error(`Suggestion already ${suggestion.status}: ${id}`);
			}
			const now = new Date().toISOString();
			suggestion.status = status;
			suggestion.resolvedAt = now;
			if (status === "accepted" && patch?.appliedSectionId !== undefined) {
				suggestion.appliedSectionId = patch.appliedSectionId;
			}
			return { changed: true, result: suggestion };
		});
	}

	private withLockedState<T>(fn: (state: SuggestionState) => LockedOutcome<T>): T {
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
				if (code !== "ELOCKED" || attempt === maxAttempts) throw error;
				lastError = error;
				const start = Date.now();
				while (Date.now() - start < delayMs) {
					// Sleep synchronously to keep the store API synchronous for callers.
				}
			}
		}

		throw (lastError as Error) ?? new Error("Failed to acquire suggestion store lock");
	}

	private ensureDirectory(): void {
		const directory = dirname(this.path);
		if (!existsSync(directory)) mkdirSync(directory, { recursive: true, mode: 0o700 });
	}

	private write(state: SuggestionState): void {
		this.ensureDirectory();
		const temporaryPath = `${this.path}.${process.pid}.tmp`;
		writeFileSync(temporaryPath, `${JSON.stringify(state, null, "\t")}\n`, { encoding: "utf8", mode: 0o600 });
		chmodSync(temporaryPath, 0o600);
		renameSync(temporaryPath, this.path);
		chmodSync(this.path, 0o600);
		// 落盘成功才广播，读失败或没变化（如重复建议）不通知。
		notifyMemoryChanged("store");
	}
}
