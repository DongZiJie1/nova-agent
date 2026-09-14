import { describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import type { BashOperations } from "../src/core/tools/bash.ts";
import { createBashToolDefinition } from "../src/core/tools/bash.ts";
import { TOOL_RESULT_BACKSTOP_MAX_LINES } from "../src/core/tools/limits.ts";
import { wrapToolDefinition } from "../src/core/tools/tool-definition-wrapper.ts";

/** ToolDefinition.execute requires a context argument; these tests never use it. */
const ctx = {} as ExtensionContext;

/** Bash operations that record how many commands run at the same time. */
function createTrackingOperations(): { operations: BashOperations; peak: () => number; started: () => number } {
	let running = 0;
	let peak = 0;
	let started = 0;
	return {
		operations: {
			exec: async () => {
				running += 1;
				started += 1;
				peak = Math.max(peak, running);
				await new Promise((resolve) => setTimeout(resolve, 20));
				running -= 1;
				return { exitCode: 0 };
			},
		},
		peak: () => peak,
		started: () => started,
	};
}

describe("bash resource limits", () => {
	it("kills a command that outlives the default timeout", async () => {
		// Mirrors the real executor: the timeout it receives is what ends the command.
		const operations: BashOperations = {
			exec: (_command, _cwd, options) =>
				new Promise((_resolve, reject) => {
					const timer = setTimeout(
						() => reject(new Error(`timeout:${options.timeout ?? 0}`)),
						(options.timeout ?? 60) * 1000,
					);
					options.signal?.addEventListener(
						"abort",
						() => {
							clearTimeout(timer);
							reject(new Error("aborted"));
						},
						{ once: true },
					);
				}),
		};
		const tool = createBashToolDefinition("/tmp", {
			operations,
			defaultTimeoutMs: 30,
			exposeSessionEnvironment: false,
		});

		await expect(tool.execute("call-1", { command: "sleep 999" }, undefined, undefined, ctx)).rejects.toThrow(
			/timed out after 0\.03 seconds/,
		);
	});

	it("passes the configured default timeout to the executor", async () => {
		const exec = vi.fn(async (_command: string, _cwd: string, _options: { timeout?: number }) => ({ exitCode: 0 }));
		const tool = createBashToolDefinition("/tmp", {
			operations: { exec },
			defaultTimeoutMs: 12_000,
			exposeSessionEnvironment: false,
		});

		await tool.execute("call-1", { command: "echo hi" }, undefined, undefined, ctx);

		// BashOperations takes seconds.
		expect(exec.mock.calls[0]?.[2]).toMatchObject({ timeout: 12 });
	});

	it("lets an explicit timeout override the default", async () => {
		const exec = vi.fn(async (_command: string, _cwd: string, _options: { timeout?: number }) => ({ exitCode: 0 }));
		const tool = createBashToolDefinition("/tmp", {
			operations: { exec },
			defaultTimeoutMs: 12_000,
			exposeSessionEnvironment: false,
		});

		await tool.execute("call-1", { command: "echo hi", timeout: 5 }, undefined, undefined, ctx);

		expect(exec.mock.calls[0]?.[2]).toMatchObject({ timeout: 5 });
	});

	it("caps how many commands run at once", async () => {
		const tracking = createTrackingOperations();
		const tool = createBashToolDefinition("/tmp", {
			operations: tracking.operations,
			maxConcurrent: 2,
			exposeSessionEnvironment: false,
		});

		await Promise.all([
			tool.execute("call-1", { command: "echo 1" }, undefined, undefined, ctx),
			tool.execute("call-2", { command: "echo 2" }, undefined, undefined, ctx),
			tool.execute("call-3", { command: "echo 3" }, undefined, undefined, ctx),
			tool.execute("call-4", { command: "echo 4" }, undefined, undefined, ctx),
		]);

		expect(tracking.started()).toBe(4);
		expect(tracking.peak()).toBeLessThanOrEqual(2);
	});
});

describe("tool result output cap", () => {
	it("truncates huge text from tools that do not truncate themselves", async () => {
		const definition = {
			name: "custom",
			label: "Custom",
			description: "Returns far too much text",
			parameters: { type: "object", properties: {} } as never,
			execute: async () => ({
				content: [
					{ type: "text" as const, text: Array.from({ length: 20_000 }, (_, i) => `line ${i}`).join("\n") },
				],
				details: { kept: true },
			}),
		};
		const tool = wrapToolDefinition(definition);

		const result = await tool.execute("call-1", {});

		const text = (result.content?.[0] as { text: string }).text;
		expect(text).toContain("[Tool output truncated");
		expect(text.split("\n").length).toBeLessThanOrEqual(TOOL_RESULT_BACKSTOP_MAX_LINES + 3);
		expect(result.details).toEqual({ kept: true });
	});

	it("leaves small results untouched", async () => {
		const definition = {
			name: "custom",
			label: "Custom",
			description: "Small result",
			parameters: { type: "object", properties: {} } as never,
			execute: async () => ({ content: [{ type: "text" as const, text: "short" }], details: {} }),
		};
		const tool = wrapToolDefinition(definition);

		const result = await tool.execute("call-1", {});

		expect((result.content?.[0] as { text: string }).text).toBe("short");
	});
});
