import { describe, expect, it } from "vitest";
import { EXECUTION_TRACE_CUSTOM_TYPE, mergeExecutionTraces } from "../src/core/execution-traces.ts";
import type { CustomEntry, SessionEntry } from "../src/core/session-manager.ts";

function traceEntry(id: string, timestamp: string, data: CustomEntry["data"]): SessionEntry {
	return {
		type: "custom",
		customType: EXECUTION_TRACE_CUSTOM_TYPE,
		id,
		parentId: null,
		timestamp,
		data,
	};
}

describe("execution traces", () => {
	it("merges start and end entries into a completed trace", () => {
		const traces = mergeExecutionTraces([
			traceEntry("entry-1", "2026-08-23T10:00:00.000Z", {
				traceId: "trace-1",
				category: "tool",
				phase: "start",
				turnId: "turn-1",
				toolCallId: "tool-1",
				toolName: "read",
			}),
			traceEntry("entry-2", "2026-08-23T10:00:01.250Z", {
				traceId: "trace-1",
				category: "tool",
				phase: "end",
				status: "success",
				durationMs: 1250,
			}),
		]);

		expect(traces).toEqual([
			expect.objectContaining({
				traceId: "trace-1",
				category: "tool",
				turnId: "turn-1",
				toolCallId: "tool-1",
				toolName: "read",
				status: "success",
				startedAt: Date.parse("2026-08-23T10:00:00.000Z"),
				endedAt: Date.parse("2026-08-23T10:00:01.250Z"),
				durationMs: 1250,
			}),
		]);
	});

	it("distinguishes active and interrupted start-only traces", () => {
		const entries = [
			traceEntry("entry-1", "2026-08-23T10:00:00.000Z", {
				traceId: "trace-active",
				category: "model",
				phase: "start",
			}),
			traceEntry("entry-2", "2026-08-23T10:00:01.000Z", {
				traceId: "trace-old",
				category: "tool",
				phase: "start",
			}),
		];

		const traces = mergeExecutionTraces(entries, new Set(["trace-active"]));
		expect(traces.map((trace) => [trace.traceId, trace.status])).toEqual([
			["trace-active", "running"],
			["trace-old", "interrupted"],
		]);
	});

	it("preserves the parent model relationship for thinking traces", () => {
		const traces = mergeExecutionTraces([
			traceEntry("entry-1", "2026-08-23T10:00:00.000Z", {
				traceId: "thinking-1",
				category: "thinking",
				phase: "start",
				parentTraceId: "model-1",
			}),
			traceEntry("entry-2", "2026-08-23T10:00:00.800Z", {
				traceId: "thinking-1",
				category: "thinking",
				phase: "end",
				status: "success",
				durationMs: 800,
			}),
		]);

		expect(traces[0]).toEqual(expect.objectContaining({ parentTraceId: "model-1", durationMs: 800 }));
	});

	it("filters traces by category and limit", () => {
		const entries = [
			traceEntry("entry-1", "2026-08-23T10:00:00.000Z", {
				traceId: "trace-model",
				category: "model",
				phase: "start",
			}),
			traceEntry("entry-2", "2026-08-23T10:00:01.000Z", {
				traceId: "trace-tool-1",
				category: "tool",
				phase: "start",
			}),
			traceEntry("entry-3", "2026-08-23T10:00:02.000Z", {
				traceId: "trace-tool-2",
				category: "tool",
				phase: "start",
			}),
		];

		expect(
			mergeExecutionTraces(entries, new Set(), { category: "tool", limit: 1 }).map((trace) => trace.traceId),
		).toEqual(["trace-tool-2"]);
	});
});
