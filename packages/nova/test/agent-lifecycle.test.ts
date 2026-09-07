import { describe, expect, it } from "vitest";
import { AgentLifecycle } from "../src/modes/rpc/agent-lifecycle.ts";

describe("AgentLifecycle", () => {
	it("tracks task and session states independently", () => {
		const lifecycle = new AgentLifecycle("child", new Date("2026-01-01T00:00:00.000Z"));
		lifecycle.ready(new Date("2026-01-01T00:00:01.000Z"));
		lifecycle.queue(new Date("2026-01-01T00:00:02.000Z"));
		lifecycle.start(new Date("2026-01-01T00:00:03.000Z"));
		lifecycle.complete({ input: 10, output: 5 }, new Date("2026-01-01T00:00:08.000Z"));

		expect(lifecycle.value).toMatchObject({
			sessionStatus: "idle",
			taskStatus: "completed",
			startedAt: "2026-01-01T00:00:03.000Z",
			completedAt: "2026-01-01T00:00:08.000Z",
			durationMs: 5000,
			tokenUsage: { input: 10, output: 5, total: 15 },
		});
	});

	it("records timeout, retry, cancellation and archive metadata", () => {
		const lifecycle = new AgentLifecycle("child");
		lifecycle.ready();
		lifecycle.start();
		lifecycle.timeout("deadline exceeded");
		expect(lifecycle.value).toMatchObject({ taskStatus: "stopped", timeoutReason: "deadline exceeded" });

		lifecycle.retry();
		expect(lifecycle.value).toMatchObject({ taskStatus: "queued", retryCount: 1, timeoutReason: undefined });
		lifecycle.start();
		lifecycle.stop("cancelled by user");
		lifecycle.archive();
		expect(lifecycle.value).toMatchObject({
			taskStatus: "stopped",
			cancelReason: "cancelled by user",
			archived: true,
		});
	});

	it("rejects archiving active work", () => {
		const lifecycle = new AgentLifecycle("child");
		lifecycle.ready();
		expect(() => lifecycle.archive()).toThrow("Cannot archive active agent");
	});

	it("marks interrupted work as orphaned", () => {
		const lifecycle = new AgentLifecycle("child");
		lifecycle.start();
		lifecycle.orphan("host restarted during task");
		expect(lifecycle.value).toMatchObject({
			sessionStatus: "stopped",
			taskStatus: "orphaned",
			errorReason: "host restarted during task",
		});
	});
});
