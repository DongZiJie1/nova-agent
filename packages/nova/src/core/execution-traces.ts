import type { Usage } from "@dongzijie1/pi-ai/compat";
import type { SessionEntry } from "./session-manager.ts";

export const EXECUTION_TRACE_CUSTOM_TYPE = "nova.execution_trace";

export type ExecutionTraceCategory = "turn" | "model" | "thinking" | "tool";
export type ExecutionTracePhase = "start" | "end";
export type ExecutionTraceStatus = "running" | "success" | "error" | "cancelled" | "interrupted";

export interface ExecutionTraceEntryData {
	traceId: string;
	category: ExecutionTraceCategory;
	phase: ExecutionTracePhase;
	turnId?: string;
	parentTraceId?: string;
	messageEntryId?: string;
	toolCallId?: string;
	provider?: string;
	model?: string;
	toolName?: string;
	status?: Exclude<ExecutionTraceStatus, "running" | "interrupted">;
	durationMs?: number;
	stopReason?: string;
	errorMessage?: string;
	usage?: ExecutionTraceUsage;
}

export interface ExecutionTraceUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
}

export interface ExecutionTrace {
	traceId: string;
	category: ExecutionTraceCategory;
	turnId?: string;
	parentTraceId?: string;
	messageEntryId?: string;
	toolCallId?: string;
	provider?: string;
	model?: string;
	toolName?: string;
	status: ExecutionTraceStatus;
	startedAt?: number;
	endedAt?: number;
	durationMs?: number;
	stopReason?: string;
	errorMessage?: string;
	usage?: ExecutionTraceUsage;
}

export interface ExecutionTraceFilters {
	turnId?: string;
	category?: ExecutionTraceCategory;
	after?: string;
	limit?: number;
}

export interface ActiveExecutionTrace {
	traceId: string;
	startedAtMonotonic: number;
	data: Omit<ExecutionTraceEntryData, "traceId" | "phase">;
}

export function usageToExecutionTraceUsage(usage: Usage): ExecutionTraceUsage {
	return {
		input: usage.input,
		output: usage.output,
		cacheRead: usage.cacheRead,
		cacheWrite: usage.cacheWrite,
		total: usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
	};
}

function isExecutionTraceEntryData(value: unknown): value is ExecutionTraceEntryData {
	if (!value || typeof value !== "object") return false;
	const data = value as Partial<ExecutionTraceEntryData>;
	return (
		typeof data.traceId === "string" &&
		(data.category === "turn" ||
			data.category === "model" ||
			data.category === "thinking" ||
			data.category === "tool") &&
		(data.phase === "start" || data.phase === "end")
	);
}

export function mergeExecutionTraces(
	entries: readonly SessionEntry[],
	activeTraceIds: ReadonlySet<string> = new Set(),
	filters: ExecutionTraceFilters = {},
): ExecutionTrace[] {
	const traces = new Map<string, ExecutionTrace>();
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== EXECUTION_TRACE_CUSTOM_TYPE) continue;
		if (!isExecutionTraceEntryData(entry.data)) continue;
		const data = entry.data;
		const timestamp = Date.parse(entry.timestamp);
		const existing = traces.get(data.traceId);
		const trace: ExecutionTrace = existing ?? {
			traceId: data.traceId,
			category: data.category,
			status: activeTraceIds.has(data.traceId) ? "running" : "interrupted",
		};
		Object.assign(trace, {
			turnId: data.turnId ?? trace.turnId,
			parentTraceId: data.parentTraceId ?? trace.parentTraceId,
			messageEntryId: data.messageEntryId ?? trace.messageEntryId,
			toolCallId: data.toolCallId ?? trace.toolCallId,
			provider: data.provider ?? trace.provider,
			model: data.model ?? trace.model,
			toolName: data.toolName ?? trace.toolName,
		});
		if (data.phase === "start") {
			if (Number.isFinite(timestamp)) trace.startedAt = timestamp;
		} else {
			if (Number.isFinite(timestamp)) trace.endedAt = timestamp;
			trace.status = data.status ?? "success";
			trace.durationMs = data.durationMs;
			trace.stopReason = data.stopReason;
			trace.errorMessage = data.errorMessage;
			trace.usage = data.usage;
		}
		traces.set(data.traceId, trace);
	}

	let result = Array.from(traces.values()).filter(
		(trace) =>
			(filters.turnId === undefined || trace.turnId === filters.turnId) &&
			(filters.category === undefined || trace.category === filters.category) &&
			(filters.after === undefined || (trace.startedAt ?? trace.endedAt ?? 0) > Date.parse(filters.after)),
	);
	result.sort((a, b) => (a.startedAt ?? a.endedAt ?? 0) - (b.startedAt ?? b.endedAt ?? 0));
	if (filters.limit !== undefined) result = result.slice(-Math.max(0, filters.limit));
	return result;
}
