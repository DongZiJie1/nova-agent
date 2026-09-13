import { rmSync } from "node:fs";
import type { AgentTool } from "@dongzijie1/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@dongzijie1/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

describe("AgentSession tool permission bridge", () => {
	const harnesses: Harness[] = [];
	const tempDirs: string[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
		while (tempDirs.length > 0) {
			const tempDir = tempDirs.pop();
			if (tempDir) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		}
	});

	function createEchoTool(toolRuns: string[]): AgentTool {
		return {
			name: "echo",
			label: "Echo",
			description: "Echo text back",
			parameters: Type.Object({ text: Type.String() }),
			execute: async (_toolCallId, params) => {
				const text = typeof params === "object" && params !== null && "text" in params ? String(params.text) : "";
				toolRuns.push(text);
				return {
					content: [{ type: "text", text: `echo:${text}` }],
					details: { text },
				};
			},
		};
	}

	it("suspends a non-read-only tool call until the RPC bridge approves it", async () => {
		const toolRuns: string[] = [];
		const harness = await createHarness({ tools: [createEchoTool(toolRuns)] });
		harnesses.push(harness);
		harness.session.setRpcPermissionBridgeEnabled(true);

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("echo", { text: "hello" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		const promptPromise = harness.session.prompt("start");

		await vi.waitFor(() => {
			expect(harness.eventsOfType("tool_permission_requested")).toHaveLength(1);
		});
		expect(toolRuns).toEqual([]);

		const requested = harness.eventsOfType("tool_permission_requested")[0]!;
		expect(requested.toolName).toBe("echo");

		expect(harness.session.respondToToolPermission(requested.toolCallId, true)).toBe(true);

		await promptPromise;
		expect(toolRuns).toEqual(["hello"]);

		const resolved = harness.eventsOfType("tool_permission_resolved")[0]!;
		expect(resolved.allowed).toBe(true);
	});

	it("blocks the tool call when the RPC bridge denies it", async () => {
		const toolRuns: string[] = [];
		const harness = await createHarness({ tools: [createEchoTool(toolRuns)] });
		harnesses.push(harness);
		harness.session.setRpcPermissionBridgeEnabled(true);

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("echo", { text: "hello" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		const promptPromise = harness.session.prompt("start");

		await vi.waitFor(() => {
			expect(harness.eventsOfType("tool_permission_requested")).toHaveLength(1);
		});

		const requested = harness.eventsOfType("tool_permission_requested")[0]!;
		expect(harness.session.respondToToolPermission(requested.toolCallId, false)).toBe(true);

		await promptPromise;
		expect(toolRuns).toEqual([]);

		const resolved = harness.eventsOfType("tool_permission_resolved")[0]!;
		expect(resolved.allowed).toBe(false);
	});

	it("fails closed immediately when the bridge is disabled", async () => {
		const toolRuns: string[] = [];
		const harness = await createHarness({ tools: [createEchoTool(toolRuns)] });
		harnesses.push(harness);

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("echo", { text: "hello" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("start");
		expect(toolRuns).toEqual([]);

		const resolved = harness.eventsOfType("tool_permission_resolved")[0]!;
		expect(resolved.allowed).toBe(false);
	});

	it("returns false when responding to an unknown toolCallId", async () => {
		const toolRuns: string[] = [];
		const harness = await createHarness({ tools: [createEchoTool(toolRuns)] });
		harnesses.push(harness);
		harness.session.setRpcPermissionBridgeEnabled(true);

		expect(harness.session.respondToToolPermission("nonexistent-call", true)).toBe(false);
	});

	it("switches permission mode at runtime and emits the change event", async () => {
		const toolRuns: string[] = [];
		const harness = await createHarness({ tools: [createEchoTool(toolRuns)] });
		harnesses.push(harness);
		harness.session.setRpcPermissionBridgeEnabled(true);

		expect(harness.session.getToolPermissionMode()).toBe("ask");
		harness.session.setToolPermissionMode("edits");
		expect(harness.session.getToolPermissionMode()).toBe("edits");

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("echo", { text: "hello" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		const promptPromise = harness.session.prompt("start");

		await vi.waitFor(() => {
			expect(harness.eventsOfType("tool_permission_requested")).toHaveLength(1);
		});
		expect(toolRuns).toEqual([]);

		const requested = harness.eventsOfType("tool_permission_requested")[0]!;
		expect(harness.session.respondToToolPermission(requested.toolCallId, true)).toBe(true);

		await promptPromise;
		expect(toolRuns).toEqual(["hello"]);

		const modeEvents = harness.eventsOfType("tool_permission_mode_changed");
		expect(modeEvents).toHaveLength(1);
		expect(modeEvents[0]!.mode).toBe("edits");
		expect(modeEvents[0]!.previousMode).toBe("ask");
	});

	it("does not emit tool_permission_requested for read-only tools in bridge mode", async () => {
		const toolRuns: string[] = [];
		const readTool: AgentTool = {
			name: "read",
			label: "Read",
			description: "Read a file",
			parameters: Type.Object({ path: Type.String() }),
			execute: async (_toolCallId, params) => {
				toolRuns.push(String((params as { path?: string }).path ?? ""));
				return { content: [{ type: "text", text: "file" }], details: {} };
			},
		};
		const harness = await createHarness({ tools: [readTool] });
		harnesses.push(harness);
		harness.session.setRpcPermissionBridgeEnabled(true);

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("read", { path: "/tmp/a.txt" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("start");
		expect(toolRuns).toEqual(["/tmp/a.txt"]);
		expect(harness.eventsOfType("tool_permission_requested")).toHaveLength(0);
	});

	it("fails closed when the permission request times out unanswered", async () => {
		const toolRuns: string[] = [];
		const harness = await createHarness({ tools: [createEchoTool(toolRuns)], toolPermissionTimeoutMs: 30 });
		harnesses.push(harness);
		harness.session.setRpcPermissionBridgeEnabled(true);

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("echo", { text: "hello" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		const requested = vi.fn();
		harness.session.subscribe((event) => {
			if (event.type === "tool_permission_requested") requested(event.timeoutMs);
		});

		await harness.session.prompt("start");

		expect(requested).toHaveBeenCalledWith(30);
		expect(toolRuns).toEqual([]);
		expect(harness.eventsOfType("tool_permission_resolved")[0]!.allowed).toBe(false);
	});

	it("denies a pending request when the run is aborted", async () => {
		const toolRuns: string[] = [];
		const harness = await createHarness({ tools: [createEchoTool(toolRuns)] });
		harnesses.push(harness);
		harness.session.setRpcPermissionBridgeEnabled(true);

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("echo", { text: "hello" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		const promptPromise = harness.session.prompt("start");

		await vi.waitFor(() => {
			expect(harness.eventsOfType("tool_permission_requested")).toHaveLength(1);
		});

		await harness.session.abort();
		await expect(promptPromise).resolves.toBeUndefined();

		expect(toolRuns).toEqual([]);
		expect(harness.eventsOfType("tool_permission_resolved")[0]!.allowed).toBe(false);
	});

	it("records the permission request and decision in the execution trace", async () => {
		const toolRuns: string[] = [];
		const harness = await createHarness({ tools: [createEchoTool(toolRuns)] });
		harnesses.push(harness);
		harness.session.setRpcPermissionBridgeEnabled(true);

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("echo", { text: "hello" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		const promptPromise = harness.session.prompt("start");

		await vi.waitFor(() => {
			expect(harness.eventsOfType("tool_permission_requested")).toHaveLength(1);
		});

		const requested = harness.eventsOfType("tool_permission_requested")[0]!;
		harness.session.respondToToolPermission(requested.toolCallId, false);
		await promptPromise;

		const trace = harness.session
			.getExecutionTraces({ category: "tool" })
			.find((candidate) => candidate.toolCallId === requested.toolCallId);
		expect(trace?.permissionPrompted).toBe(true);
		expect(trace?.permissionMode).toBe("ask");
		expect(trace?.permissionDecision).toBe("denied");
	});

	it("marks auto-approved read-only tools as not prompted in the trace", async () => {
		const toolRuns: string[] = [];
		const readTool: AgentTool = {
			name: "read",
			label: "Read",
			description: "Read a file",
			parameters: Type.Object({ path: Type.String() }),
			execute: async (_toolCallId, params) => {
				toolRuns.push(String((params as { path?: string }).path ?? ""));
				return { content: [{ type: "text", text: "file" }], details: {} };
			},
		};
		const harness = await createHarness({ tools: [readTool] });
		harnesses.push(harness);
		harness.session.setRpcPermissionBridgeEnabled(true);

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("read", { path: "/tmp/a.txt" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("start");

		const trace = harness.session.getExecutionTraces({ category: "tool" })[0]!;
		expect(trace.permissionPrompted).toBe(false);
		expect(trace.permissionDecision).toBe("allowed");
	});

	it("denies pending requests on dispose", async () => {
		const toolRuns: string[] = [];
		const harness = await createHarness({ tools: [createEchoTool(toolRuns)] });
		harnesses.push(harness);
		harness.session.setRpcPermissionBridgeEnabled(true);

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("echo", { text: "hello" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		const promptPromise = harness.session.prompt("start");

		await vi.waitFor(() => {
			expect(harness.eventsOfType("tool_permission_requested")).toHaveLength(1);
		});

		harness.session.dispose();
		await expect(promptPromise).resolves.toBeUndefined();
		expect(toolRuns).toEqual([]);
	});
});
