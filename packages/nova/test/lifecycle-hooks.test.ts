import { describe, expect, it } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import { LifecycleHooks } from "../src/core/lifecycle-hooks.ts";

const session = {} as AgentSession;

describe("LifecycleHooks after_user_message", () => {
	it("collects messages from every handler in registration order", async () => {
		const hooks = new LifecycleHooks(() => {});
		hooks.register("after_user_message", {
			name: "first",
			timeoutMs: 100,
			handler: () => ({ messages: [{ customType: "first", content: [{ type: "text", text: "A" }] }] }),
		});
		hooks.register("after_user_message", {
			name: "second",
			timeoutMs: 100,
			handler: async () => ({ messages: [{ customType: "second", content: [{ type: "text", text: "B" }] }] }),
		});

		const messages = await hooks.emitAfterUserMessage(session, "hi");

		expect(messages.map((message) => message.customType)).toEqual(["first", "second"]);
		expect(messages[0]?.content[0]?.text).toBe("A");
	});

	it("passes the prompt text and isolates a throwing handler", async () => {
		const errors: string[] = [];
		const hooks = new LifecycleHooks((message) => errors.push(message));
		let seen = "";
		hooks.register("after_user_message", {
			name: "broken",
			timeoutMs: 100,
			handler: () => {
				throw new Error("boom");
			},
		});
		hooks.register("after_user_message", {
			name: "working",
			timeoutMs: 100,
			handler: (context) => {
				seen = context.promptText ?? "";
				return { messages: [{ customType: "working", content: [{ type: "text", text: "ok" }] }] };
			},
		});

		const messages = await hooks.emitAfterUserMessage(session, "first message");

		expect(seen).toBe("first message");
		expect(messages).toHaveLength(1);
		expect(messages[0]?.customType).toBe("working");
		expect(errors.some((message) => message.includes("broken"))).toBe(true);
	});

	it("times out one handler without blocking the others", async () => {
		const errors: string[] = [];
		const hooks = new LifecycleHooks((message) => errors.push(message));
		hooks.register("after_user_message", {
			name: "slow",
			timeoutMs: 20,
			handler: () => new Promise<void>(() => {}),
		});
		hooks.register("after_user_message", {
			name: "fast",
			timeoutMs: 100,
			handler: () => ({ messages: [{ customType: "fast", content: [{ type: "text", text: "fast" }] }] }),
		});

		const messages = await hooks.emitAfterUserMessage(session, "hi");

		expect(messages.map((message) => message.customType)).toEqual(["fast"]);
		expect(errors.some((message) => message.includes("slow"))).toBe(true);
	});

	it("does not run after_user_message handlers for other events", async () => {
		const hooks = new LifecycleHooks(() => {});
		let called = 0;
		hooks.register("after_user_message", {
			name: "prompt",
			timeoutMs: 100,
			handler: () => {
				called += 1;
				return undefined;
			},
		});

		await hooks.emit("turn_end", session);
		expect(called).toBe(0);

		await hooks.emitAfterUserMessage(session, "hi");
		expect(called).toBe(1);
	});
});
