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
		});
		expect(confirm).toHaveBeenCalledOnce();
	});

	it("allows execution without prompting in allow mode", async () => {
		const confirm = vi.fn<ExtensionUIContext["confirm"]>();
		const result = await new ToolPermissionManager({ mode: "allow" }).check(request, uiWithConfirm(confirm));

		expect(result).toEqual({ allowed: true });
		expect(confirm).not.toHaveBeenCalled();
	});

	it("prompts with the tool details and allows an approved call", async () => {
		const confirm = vi.fn<ExtensionUIContext["confirm"]>().mockResolvedValue(true);
		const result = await new ToolPermissionManager({ mode: "ask", timeoutMs: 500 }).check(
			request,
			uiWithConfirm(confirm),
		);

		expect(result).toEqual({ allowed: true });
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
		await expect(first).resolves.toEqual({ allowed: true });
		await expect(second).resolves.toEqual({ allowed: false, reason: "User denied tool execution" });
	});
});
