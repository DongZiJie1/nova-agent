import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stream as streamOpenAIResponses } from "../src/api/openai-responses.ts";
import { getModel } from "../src/compat.ts";
import type { Model } from "../src/types.ts";

type CapturedHeaders = Headers | string[][] | Record<string, string | readonly string[]> | undefined;

interface CapturedResponsesPayload {
	prompt_cache_key?: string;
	session_id?: string;
}

/** Fixture models are registered dynamically, so pin the api the raw Responses api expects. */
function openaiResponsesFixture(provider: string, id: string): Model<"openai-responses"> {
	return getModel(provider, id) as Model<"openai-responses">;
}

function getHeader(headers: CapturedHeaders, name: string): string | null {
	if (!headers) return null;
	if (headers instanceof Headers) return headers.get(name);

	const lowerName = name.toLowerCase();
	if (Array.isArray(headers)) {
		const match = headers.find(([key]) => key?.toLowerCase() === lowerName);
		return match?.[1] ?? null;
	}

	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === lowerName) return typeof value === "string" ? value : value.join(", ");
	}
	return null;
}

async function captureOpenAIResponseHeaders(
	options: Parameters<typeof streamOpenAIResponses>[2],
	model: Model<"openai-responses"> = openaiResponsesFixture("openai", "gpt-5.4"),
): Promise<{
	sessionId: string | null;
	clientRequestId: string | null;
	xSessionId: string | null;
}> {
	const captured = {
		sessionId: null as string | null,
		clientRequestId: null as string | null,
		xSessionId: null as string | null,
	};
	vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
		captured.sessionId = getHeader(init?.headers, "session_id");
		captured.clientRequestId = getHeader(init?.headers, "x-client-request-id");
		captured.xSessionId = getHeader(init?.headers, "x-session-id");
		return new Response("data: [DONE]\n\n", {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	});

	const stream = streamOpenAIResponses(
		model,
		{
			systemPrompt: "sys",
			messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
		},
		{ apiKey: "test-key", ...options },
	);

	for await (const event of stream) {
		if (event.type === "done" || event.type === "error") break;
	}

	return captured;
}

function makeOpenAIResponsesModel(
	id: string,
	overrides: Partial<Model<"openai-responses">> = {},
): Model<"openai-responses"> {
	// OpenAI Responses models are user-configured; tests declare the model they
	// exercise, including reasoning support and provider-specific compat flags.
	return {
		id,
		name: id,
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
		contextWindow: 400000,
		maxTokens: 128000,
		...overrides,
	};
}

describe("openai-responses provider defaults", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("omits reasoning when no reasoning is requested", async () => {
		const model = openaiResponsesFixture("github-copilot", "gpt-5-mini");
		let capturedPayload: unknown;

		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("data: [DONE]\n\n", {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			}),
		);

		const stream = streamOpenAIResponses(
			model,
			{
				systemPrompt: "sys",
				messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
			},
			{
				apiKey: "test-key",
				onPayload: (payload) => {
					capturedPayload = payload;
				},
			},
		);

		for await (const event of stream) {
			if (event.type === "done" || event.type === "error") break;
		}

		expect(capturedPayload).not.toBeNull();
		expect(capturedPayload).not.toMatchObject({
			reasoning: expect.anything(),
		});
	});

	it("forwards required tool choice", async () => {
		let capturedPayload: unknown;

		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("data: [DONE]\n\n", {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			}),
		);

		const stream = streamOpenAIResponses(
			openaiResponsesFixture("openai", "gpt-5.4"),
			{
				messages: [
					{
						role: "user",
						content: "Do not call ping. Respond with text instead.",
						timestamp: Date.now(),
					},
				],
				tools: [
					{
						name: "ping",
						description: "Ping",
						parameters: Type.Object({ value: Type.String() }),
					},
				],
			},
			{
				apiKey: "test-key",
				toolChoice: "required",
				onPayload: (payload) => {
					capturedPayload = payload;
				},
			},
		);

		for await (const event of stream) {
			if (event.type === "done" || event.type === "error") break;
		}

		expect(capturedPayload).toMatchObject({
			tool_choice: "required",
			tools: [expect.objectContaining({ name: "ping" })],
		});
	});

	it.each([
		"gpt-5.1",
		"gpt-5.2",
		"gpt-5.3-codex",
		"gpt-5.4",
		"gpt-5.4-mini",
		"gpt-5.4-nano",
		"gpt-5.5",
		"gpt-5.6-sol",
		"gpt-5.6-terra",
		"gpt-5.6-luna",
	] as const)("sends none reasoning effort for OpenAI %s when no reasoning is requested", async (modelId) => {
		const model = makeOpenAIResponsesModel(modelId);
		let capturedPayload: unknown;

		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("data: [DONE]\n\n", {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			}),
		);

		const stream = streamOpenAIResponses(
			model,
			{
				systemPrompt: "sys",
				messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
			},
			{
				apiKey: "test-key",
				onPayload: (payload) => {
					capturedPayload = payload;
				},
			},
		);

		for await (const event of stream) {
			if (event.type === "done" || event.type === "error") break;
		}

		expect(capturedPayload).toMatchObject({
			reasoning: { effort: "none" },
		});
	});

	it.each(["gpt-5", "gpt-5-mini", "gpt-5-nano", "gpt-5-pro", "gpt-5.2-pro", "gpt-5.4-pro", "gpt-5.5-pro"] as const)(
		"omits reasoning effort for OpenAI %s when off is unsupported",
		async (modelId) => {
			// These models cannot turn reasoning off, so no effort is sent.
			const model = makeOpenAIResponsesModel(modelId, { thinkingLevelMap: { off: null } });
			let capturedPayload: unknown;

			vi.spyOn(globalThis, "fetch").mockResolvedValue(
				new Response("data: [DONE]\n\n", {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				}),
			);

			const stream = streamOpenAIResponses(
				model,
				{
					systemPrompt: "sys",
					messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
				},
				{
					apiKey: "test-key",
					onPayload: (payload) => {
						capturedPayload = payload;
					},
				},
			);

			for await (const event of stream) {
				if (event.type === "done" || event.type === "error") break;
			}

			expect(capturedPayload).not.toMatchObject({
				reasoning: expect.anything(),
			});
		},
	);

	it("sets cache-affinity headers for official OpenAI Responses requests with a sessionId", async () => {
		const captured = await captureOpenAIResponseHeaders({ sessionId: "session-123" });

		expect(captured.sessionId).toBe("session-123");
		expect(captured.clientRequestId).toBe("session-123");
	});

	it("clamps prompt_cache_key to OpenAI's 64-character limit", async () => {
		const sessionId = "x".repeat(67);
		let capturedPayload: Pick<CapturedResponsesPayload, "prompt_cache_key"> | undefined;
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("data: [DONE]\n\n", {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			}),
		);

		const stream = streamOpenAIResponses(
			openaiResponsesFixture("openai", "gpt-5.4"),
			{
				systemPrompt: "sys",
				messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
			},
			{
				apiKey: "test-key",
				sessionId,
				onPayload: (payload) => {
					capturedPayload = payload as Pick<CapturedResponsesPayload, "prompt_cache_key">;
				},
			},
		);

		for await (const event of stream) {
			if (event.type === "done" || event.type === "error") break;
		}

		expect(capturedPayload?.prompt_cache_key).toBe("x".repeat(64));
	});

	it("sets cache-affinity headers for proxy OpenAI Responses requests with a sessionId", async () => {
		const proxyModel: Model<"openai-responses"> = {
			...openaiResponsesFixture("openai", "gpt-5.4"),
			provider: "opencode",
			baseUrl: "https://proxy.example.com/v1",
		};
		const captured = await captureOpenAIResponseHeaders({ sessionId: "session-123" }, proxyModel);

		expect(captured.sessionId).toBe("session-123");
		expect(captured.clientRequestId).toBe("session-123");
	});

	it("uses OpenRouter session-affinity header when configured", async () => {
		const proxyModel: Model<"openai-responses"> = {
			...openaiResponsesFixture("openai", "gpt-5.4"),
			provider: "proxy",
			baseUrl: "https://proxy.example.com/v1",
			compat: { sessionAffinityFormat: "openrouter" },
		};
		let capturedPayload: CapturedResponsesPayload | undefined;
		const captured = await captureOpenAIResponseHeaders(
			{
				sessionId: "session-proxy",
				onPayload: (payload) => {
					capturedPayload = payload as CapturedResponsesPayload;
				},
			},
			proxyModel,
		);

		expect(captured.sessionId).toBeNull();
		expect(captured.clientRequestId).toBeNull();
		expect(captured.xSessionId).toBe("session-proxy");
		expect(capturedPayload?.session_id).toBeUndefined();
		expect(capturedPayload?.prompt_cache_key).toBe("session-proxy");
	});

	it("auto-detects OpenRouter session-affinity header for OpenRouter Responses endpoints", async () => {
		const openRouterModel: Model<"openai-responses"> = {
			...openaiResponsesFixture("openai", "gpt-5.4"),
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
		};
		let capturedPayload: CapturedResponsesPayload | undefined;
		const captured = await captureOpenAIResponseHeaders(
			{
				sessionId: "session-openrouter",
				onPayload: (payload) => {
					capturedPayload = payload as CapturedResponsesPayload;
				},
			},
			openRouterModel,
		);

		expect(captured.sessionId).toBeNull();
		expect(captured.clientRequestId).toBeNull();
		expect(captured.xSessionId).toBe("session-openrouter");
		expect(capturedPayload?.session_id).toBeUndefined();
		expect(capturedPayload?.prompt_cache_key).toBe("session-openrouter");
	});

	it("uses OpenAI no-session format when configured", async () => {
		const proxyModel: Model<"openai-responses"> = {
			...openaiResponsesFixture("openai", "gpt-5.4"),
			provider: "proxy",
			baseUrl: "https://proxy.example.com/v1",
			compat: { sessionAffinityFormat: "openai-nosession" },
		};
		let capturedPayload: CapturedResponsesPayload | undefined;
		const captured = await captureOpenAIResponseHeaders(
			{
				sessionId: "session-proxy",
				onPayload: (payload) => {
					capturedPayload = payload as CapturedResponsesPayload;
				},
			},
			proxyModel,
		);

		expect(captured.sessionId).toBeNull();
		expect(captured.clientRequestId).toBe("session-proxy");
		expect(captured.xSessionId).toBeNull();
		expect(capturedPayload?.session_id).toBeUndefined();
		expect(capturedPayload?.prompt_cache_key).toBe("session-proxy");
	});

	it("uses OpenAI no-session format for OpenCode Responses models", async () => {
		const model = makeOpenAIResponsesModel("gpt-5.4", {
			provider: "opencode",
			baseUrl: "https://opencode.ai/v1",
			compat: { sessionAffinityFormat: "openai-nosession" },
		});
		let capturedPayload: CapturedResponsesPayload | undefined;
		const captured = await captureOpenAIResponseHeaders(
			{
				sessionId: "session-opencode",
				onPayload: (payload) => {
					capturedPayload = payload as CapturedResponsesPayload;
				},
			},
			model,
		);

		expect(captured.sessionId).toBeNull();
		expect(captured.clientRequestId).toBe("session-opencode");
		expect(captured.xSessionId).toBeNull();
		expect(capturedPayload?.prompt_cache_key).toBe("session-opencode");
	});

	it("can omit OpenAI session_id header while preserving other affinity data", async () => {
		const proxyModel: Model<"openai-responses"> = {
			...openaiResponsesFixture("openai", "gpt-5.4"),
			provider: "opencode",
			baseUrl: "https://proxy.example.com/v1",
			compat: { sessionAffinityFormat: "openai-nosession" },
		};
		let capturedPayload: CapturedResponsesPayload | undefined;
		const captured = await captureOpenAIResponseHeaders(
			{
				sessionId: "session-123",
				onPayload: (payload) => {
					capturedPayload = payload as CapturedResponsesPayload;
				},
			},
			proxyModel,
		);

		expect(captured.sessionId).toBeNull();
		expect(captured.clientRequestId).toBe("session-123");
		expect(capturedPayload?.prompt_cache_key).toBe("session-123");
	});

	it("lets explicit headers override the default OpenAI cache-affinity headers", async () => {
		const captured = await captureOpenAIResponseHeaders({
			sessionId: "session-123",
			headers: {
				session_id: "override-session",
				"x-client-request-id": "override-request",
			},
		});

		expect(captured.sessionId).toBe("override-session");
		expect(captured.clientRequestId).toBe("override-request");
	});

	it("omits OpenAI cache-affinity headers when cacheRetention is none", async () => {
		const captured = await captureOpenAIResponseHeaders({ cacheRetention: "none", sessionId: "session-123" });

		expect(captured.sessionId).toBeNull();
		expect(captured.clientRequestId).toBeNull();
	});

	it.each([
		["gpt-5.4", "priority", 2],
		["gpt-5.5", "priority", 2.5],
		["gpt-5.5", "flex", 0.5],
	] as const)("applies %s %s service-tier cost multiplier", async (modelId, serviceTier, multiplier) => {
		const model = makeOpenAIResponsesModel(modelId);
		const tokenCount = 100_000;
		const tokenScale = tokenCount / 1_000_000;
		const sse = `${[
			`data: ${JSON.stringify({
				type: "response.completed",
				response: {
					status: "completed",
					service_tier: serviceTier,
					usage: {
						input_tokens: tokenCount,
						output_tokens: tokenCount,
						total_tokens: tokenCount * 2,
						input_tokens_details: { cached_tokens: 0 },
					},
				},
			})}`,
		].join("\n\n")}\n\n`;

		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(sse, {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			}),
		);

		const stream = streamOpenAIResponses(
			model,
			{
				systemPrompt: "sys",
				messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
			},
			{ apiKey: "test-key", serviceTier },
		);

		const result = await stream.result();

		expect(result.usage.cost.input).toBe(model.cost.input * multiplier * tokenScale);
		expect(result.usage.cost.output).toBe(model.cost.output * multiplier * tokenScale);
		expect(result.usage.cost.total).toBe((model.cost.input + model.cost.output) * multiplier * tokenScale);
	});
});
