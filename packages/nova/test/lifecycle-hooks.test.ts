import { describe, expect, it } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import { LifecycleHooks } from "../src/core/lifecycle-hooks.ts";

const session = {} as AgentSession;

describe("LifecycleHooks before_prompt", () => {
	it("collects messages from every handler in registration order", async () => {
		const hooks = new LifecycleHooks(() => {});
		hooks.register("before_prompt", {
			name: "first",
			timeoutMs: 100,
			handler: () => ({ messages: [{ customType: "first", content: [{ type: "text", text: "A" }] }] }),
		});
		hooks.register("before_prompt", {
			name: "second",
			timeoutMs: 100,
			handler: async () => ({ messages: [{ customType: "second", content: [{ type: "text", text: "B" }] }] }),
		});

		const messages = await hooks.emitBeforePrompt(session, "hi");

		expect(messages.map((message) => message.customType)).toEqual(["first", "second"]);
		expect(messages[0]?.content[0]?.text).toBe("A");
	});

	it("passes the prompt text and isolates a throwing handler", async () => {
		const errors: string[] = [];
		const hooks = new LifecycleHooks((message) => errors.push(message));
		let seen = "";
		hooks.register("before_prompt", {
			name: "broken",
			timeoutMs: 100,
			handler: () => {
				throw new Error("boom");
			},
		});
		hooks.register("before_prompt", {
			name: "working",
			timeoutMs: 100,
			handler: (context) => {
				seen = context.promptText ?? "";
				return { messages: [{ customType: "working", content: [{ type: "text", text: "ok" }] }] };
			},
		});

		const messages = await hooks.emitBeforePrompt(session, "first message");

		expect(seen).toBe("first message");
		expect(messages).toHaveLength(1);
		expect(messages[0]?.customType).toBe("working");
		expect(errors.some((message) => message.includes("broken"))).toBe(true);
	});

	it("times out one handler without blocking the others", async () => {
		const errors: string[] = [];
		const hooks = new LifecycleHooks((message) => errors.push(message));
		hooks.register("before_prompt", {
			name: "slow",
			timeoutMs: 20,
			handler: () => new Promise<void>(() => {}),
		});
		hooks.register("before_prompt", {
			name: "fast",
			timeoutMs: 100,
			handler: () => ({ messages: [{ customType: "fast", content: [{ type: "text", text: "fast" }] }] }),
		});

		const messages = await hooks.emitBeforePrompt(session, "hi");

		expect(messages.map((message) => message.customType)).toEqual(["fast"]);
		expect(errors.some((message) => message.includes("slow"))).toBe(true);
	});

	it("does not run before_prompt handlers for other events", async () => {
		const hooks = new LifecycleHooks(() => {});
		let called = 0;
		hooks.register("before_prompt", {
			name: "prompt",
			timeoutMs: 100,
			handler: () => {
				called += 1;
				return undefined;
			},
		});

		await hooks.emit("turn_end", session);
		expect(called).toBe(0);

		await hooks.emitBeforePrompt(session, "hi");
		expect(called).toBe(1);
	});
});
