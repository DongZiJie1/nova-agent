import { describe, expect, it, vi } from "vitest";
import type { ExtensionUIContext } from "../src/core/extensions/types.ts";
import { ToolPermissionManager } from "../src/core/tool-permission-manager.ts";

const request = {
	toolCallId: "call-1",
	toolName: "write",
	args: { path: "/tmp/example.txt", content: "hello" },
	cwd: "/tmp/project",
};

function uiWithConfirm(confirm: ExtensionUIContext["confirm"]): ExtensionUIContext {
	return { confirm } as ExtensionUIContext;
}

describe("ToolPermissionManager", () => {
	it("asks by default", async () => {
		const confirm = vi.fn<ExtensionUIContext["confirm"]>().mockResolvedValue(true);

		await expect(new ToolPermissionManager().check(request, uiWithConfirm(confirm))).resolves.toEqual({
			allowed: true,
			prompted: true,
		});
		expect(confirm).toHaveBeenCalledOnce();
	});

	it("allows execution without prompting in allow mode", async () => {
		const confirm = vi.fn<ExtensionUIContext["confirm"]>();
		const result = await new ToolPermissionManager({ mode: "allow" }).check(request, uiWithConfirm(confirm));

		expect(result).toEqual({ allowed: true });
		expect(confirm).not.toHaveBeenCalled();
	});

	it.each(["read", "grep", "find", "ls", "ask_user_question", "hub_list_agents", "hub_wait_tasks"])(
		"auto-approves the read-only %s tool",
		async (toolName) => {
			const confirm = vi.fn<ExtensionUIContext["confirm"]>();
			const result = await new ToolPermissionManager().check({ ...request, toolName }, uiWithConfirm(confirm));

			expect(result).toEqual({ allowed: true, reason: "Tool auto-approved" });
			expect(confirm).not.toHaveBeenCalled();
		},
	);

	it.each(["list_projects", "list_sessions", "read_session"])(
		"auto-approves the read-only nova_data action %s",
		async (action) => {
			const confirm = vi.fn<ExtensionUIContext["confirm"]>();
			const result = await new ToolPermissionManager().check(
				{ ...request, toolName: "nova_data", args: { action } },
				uiWithConfirm(confirm),
			);

			expect(result.allowed).toBe(true);
			expect(confirm).not.toHaveBeenCalled();
		},
	);

	// delete_session must not be gated here: the tool runs its own confirmation in
	// every mode, so a prompt at this layer would ask the user twice.
	it.each(["ask", "edits", "allow"] as const)(
		"auto-approves delete_session in %s mode so only the tool's own confirm is shown",
		async (mode) => {
			const confirm = vi.fn<ExtensionUIContext["confirm"]>().mockResolvedValue(false);
			const result = await new ToolPermissionManager({ mode }).check(
				{ ...request, toolName: "nova_data", args: { action: "delete_session", session_id: "session-1" } },
				uiWithConfirm(confirm),
			);

			expect(result.allowed).toBe(true);
			expect(confirm).not.toHaveBeenCalled();
		},
	);

	it.each(["ask", "edits"] as const)("auto-approves reading via nova_data in %s mode without a UI", async (mode) => {
		const confirm = vi.fn<ExtensionUIContext["confirm"]>();
		const result = await new ToolPermissionManager({ mode }).check(
			{ ...request, toolName: "nova_data", args: { action: "list_sessions" } },
			undefined,
		);

		expect(result).toEqual({ allowed: true, reason: "Tool auto-approved" });
		expect(confirm).not.toHaveBeenCalled();
	});

	// The todo tool writes only Nova's own todo list, which the 待办 page lets the
	// user edit or delete, so it never needs a permission prompt of its own.
	it.each(["ask", "edits", "allow"] as const)("auto-approves todo writes in %s mode without a UI", async (mode) => {
		const confirm = vi.fn<ExtensionUIContext["confirm"]>();
		const result = await new ToolPermissionManager({ mode }).check(
			{ ...request, toolName: "todo", args: { action: "create", title: "Ship the todo tool" } },
			undefined,
		);

		expect(result.allowed).toBe(true);
		if (mode !== "allow") expect(result.reason).toBe("Tool auto-approved");
		expect(confirm).not.toHaveBeenCalled();
	});

	it("prompts with the tool details and allows an approved call", async () => {
		const confirm = vi.fn<ExtensionUIContext["confirm"]>().mockResolvedValue(true);
		const result = await new ToolPermissionManager({ mode: "ask", timeoutMs: 500 }).check(
			request,
			uiWithConfirm(confirm),
		);

		expect(result).toEqual({ allowed: true, prompted: true });
		expect(confirm).toHaveBeenCalledWith(
			"允许执行工具？",
			expect.stringContaining("工具：write"),
			expect.objectContaining({ timeout: 500 }),
		);
		expect(confirm.mock.calls[0]?.[1]).toContain('"path": "/tmp/example.txt"');
	});

	it("blocks a denied call", async () => {
		const confirm = vi.fn<ExtensionUIContext["confirm"]>().mockResolvedValue(false);
		await expect(new ToolPermissionManager({ mode: "ask" }).check(request, uiWithConfirm(confirm))).resolves.toEqual({
			allowed: false,
			prompted: true,
			reason: "User denied tool execution",
		});
	});

	it("fails closed when no interactive UI is attached", async () => {
		await expect(new ToolPermissionManager({ mode: "ask" }).check(request, undefined)).resolves.toEqual({
			allowed: false,
			reason: "Tool permission requires an interactive user interface",
		});
	});

	it("fails closed when the UI request throws", async () => {
		const confirm = vi.fn<ExtensionUIContext["confirm"]>().mockRejectedValue(new Error("transport closed"));
		await expect(new ToolPermissionManager({ mode: "ask" }).check(request, uiWithConfirm(confirm))).resolves.toEqual({
			allowed: false,
			prompted: true,
			reason: "Tool permission check failed: transport closed",
		});
	});

	it("blocks an aborted request", async () => {
		const controller = new AbortController();
		controller.abort();
		const confirm = vi.fn<ExtensionUIContext["confirm"]>();

		await expect(
			new ToolPermissionManager({ mode: "ask" }).check(request, uiWithConfirm(confirm), controller.signal),
		).resolves.toEqual({ allowed: false, reason: "Tool permission request was aborted" });
		expect(confirm).not.toHaveBeenCalled();
	});

	it("checks parallel calls independently", async () => {
		const resolvers: Array<(value: boolean) => void> = [];
		const confirm = vi
			.fn<ExtensionUIContext["confirm"]>()
			.mockImplementation(() => new Promise<boolean>((resolve) => resolvers.push(resolve)));
		const manager = new ToolPermissionManager({ mode: "ask" });

		const first = manager.check(request, uiWithConfirm(confirm));
		const second = manager.check({ ...request, toolCallId: "call-2", toolName: "bash" }, uiWithConfirm(confirm));
		expect(confirm).toHaveBeenCalledTimes(2);

		resolvers[0]?.(true);
		resolvers[1]?.(false);
		await expect(first).resolves.toEqual({ allowed: true, prompted: true });
		await expect(second).resolves.toEqual({ allowed: false, prompted: true, reason: "User denied tool execution" });
	});

	it.each(["edit", "write"])("auto-approves the %s tool in edits mode", async (toolName) => {
		const confirm = vi.fn<ExtensionUIContext["confirm"]>();
		const result = await new ToolPermissionManager({ mode: "edits" }).check({ ...request, toolName }, undefined);

		expect(result).toEqual({ allowed: true, reason: "Edit tool auto-approved in edits mode" });
		expect(confirm).not.toHaveBeenCalled();
	});

	it("still asks before bash in edits mode", async () => {
		const confirm = vi.fn<ExtensionUIContext["confirm"]>().mockResolvedValue(true);
		const result = await new ToolPermissionManager({ mode: "edits" }).check(
			{ ...request, toolName: "bash" },
			uiWithConfirm(confirm),
		);

		expect(result).toEqual({ allowed: true, prompted: true });
		expect(confirm).toHaveBeenCalledOnce();
	});

	it("switches modes at runtime via setMode", async () => {
		const confirm = vi.fn<ExtensionUIContext["confirm"]>().mockResolvedValue(true);
		const manager = new ToolPermissionManager({ mode: "ask" });

		await expect(manager.check({ ...request, toolName: "edit" }, undefined)).resolves.toEqual({
			allowed: false,
			reason: "Tool permission requires an interactive user interface",
		});

		manager.setMode("edits");
		expect(manager.mode).toBe("edits");
		await expect(manager.check({ ...request, toolName: "edit" }, undefined)).resolves.toEqual({
			allowed: true,
			reason: "Edit tool auto-approved in edits mode",
		});

		manager.setMode("allow");
		await expect(manager.check({ ...request, toolCallId: "call-2", toolName: "bash" }, undefined)).resolves.toEqual({
			allowed: true,
		});
		expect(confirm).not.toHaveBeenCalled();
	});
});
