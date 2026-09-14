import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { stream as streamOpenAICompletions } from "../src/api/openai-completions.ts";
import { stream as streamOpenAIResponses } from "../src/api/openai-responses.ts";
import { getModel, stream } from "../src/compat.ts";
import type { Context, Model } from "../src/types.ts";

class PayloadCaptured extends Error {
	constructor() {
		super("payload captured");
		this.name = "PayloadCaptured";
	}
}

interface OpenAICompletionsCachePayload {
	prompt_cache_key?: string;
	prompt_cache_retention?: string;
}

interface OpenAIResponsesCachePayload extends OpenAICompletionsCachePayload {
	prompt_cache_options?: { mode: "explicit" };
}

function stopAfterPayload<TPayload>(capture: (payload: TPayload) => void): (payload: unknown) => never {
	return (payload: unknown): never => {
		capture(payload as TPayload);
		throw new PayloadCaptured();
	};
}

/** Fixture models are registered dynamically, so pin the api the raw api functions expect. */
function anthropicFixture(id: string): Model<"anthropic-messages"> {
	return getModel("anthropic", id) as Model<"anthropic-messages">;
}

function openaiResponsesFixture(id: string): Model<"openai-responses"> {
	return getModel("openai", id) as Model<"openai-responses">;
}

/** OpenAI Responses model with explicit prompt-cache mode support. */
const RESPONSES_MODELS: Record<string, Model<"openai-responses">> = {
	"openai/gpt-5.6-sol": {
		id: "gpt-5.6-sol",
		name: "GPT-5.6 Sol",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 2, output: 10, cacheRead: 0.25, cacheWrite: 3.125 },
		contextWindow: 272000,
		maxTokens: 128000,
		compat: {
			supportsStrictMode: true,
			supportsOpenAIGrammarTools: true,
			supportsToolSearch: true,
			supportsExplicitPromptCacheMode: true,
		},
	},
};

/** OpenCode models: long cache retention is refused, which is per-model compat. */
const OPENCODE_MODELS: Record<string, Model<"openai-completions">> = {
	"opencode/deepseek-v4-flash": {
		id: "deepseek-v4-flash",
		name: "deepseek-v4-flash",
		api: "openai-completions",
		provider: "opencode",
		baseUrl: "https://opencode.ai/zen/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0.14, output: 0.28, cacheRead: 0.028, cacheWrite: 0 },
		contextWindow: 1000000,
		maxTokens: 384000,
		compat: {
			supportsStore: false,
			supportsDeveloperRole: false,
			maxTokensField: "max_tokens",
			supportsLongCacheRetention: false,
			requiresReasoningContentOnAssistantMessages: true,
		},
	},
	"opencode/deepseek-v4-pro": {
		id: "deepseek-v4-pro",
		name: "deepseek-v4-pro",
		api: "openai-completions",
		provider: "opencode",
		baseUrl: "https://opencode.ai/zen/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 1.74, output: 3.84, cacheRead: 0.145, cacheWrite: 0 },
		contextWindow: 1000000,
		maxTokens: 384000,
		compat: {
			supportsStore: false,
			supportsDeveloperRole: false,
			maxTokensField: "max_tokens",
			supportsLongCacheRetention: false,
			requiresReasoningContentOnAssistantMessages: true,
		},
	},
	"opencode/kimi-k2.5": {
		id: "kimi-k2.5",
		name: "kimi-k2.5",
		api: "openai-completions",
		provider: "opencode",
		baseUrl: "https://opencode.ai/zen/v1",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0.6, output: 3, cacheRead: 0.08, cacheWrite: 0 },
		contextWindow: 262144,
		maxTokens: 65536,
		compat: {
			supportsStore: false,
			supportsDeveloperRole: false,
			maxTokensField: "max_tokens",
			supportsLongCacheRetention: false,
		},
	},
	"opencode/kimi-k2.6": {
		id: "kimi-k2.6",
		name: "kimi-k2.6",
		api: "openai-completions",
		provider: "opencode",
		baseUrl: "https://opencode.ai/zen/v1",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0.95, output: 4, cacheRead: 0.16, cacheWrite: 0 },
		contextWindow: 262144,
		maxTokens: 65536,
		compat: {
			supportsStore: false,
			supportsDeveloperRole: false,
			thinkingFormat: "deepseek",
			supportsReasoningEffort: false,
			maxTokensField: "max_tokens",
			supportsLongCacheRetention: false,
		},
	},
	"opencode/minimax-m2.7": {
		id: "minimax-m2.7",
		name: "minimax-m2.7",
		api: "openai-completions",
		provider: "opencode",
		baseUrl: "https://opencode.ai/zen/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0 },
		contextWindow: 204800,
		maxTokens: 131072,
		compat: {
			supportsStore: false,
			supportsDeveloperRole: false,
			maxTokensField: "max_tokens",
			supportsLongCacheRetention: false,
		},
	},
	"opencode-go/kimi-k2.6": {
		id: "kimi-k2.6",
		name: "kimi-k2.6",
		api: "openai-completions",
		provider: "opencode-go",
		baseUrl: "https://opencode.ai/zen/go/v1",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0.95, output: 4, cacheRead: 0.16, cacheWrite: 0 },
		contextWindow: 262144,
		maxTokens: 65536,
		compat: {
			supportsStore: false,
			supportsDeveloperRole: false,
			thinkingFormat: "deepseek",
			supportsReasoningEffort: false,
			maxTokensField: "max_tokens",
			supportsLongCacheRetention: false,
		},
	},
};

describe("Cache Retention (PI_CACHE_RETENTION)", () => {
	const originalEnv = process.env.PI_CACHE_RETENTION;

	beforeEach(() => {
		delete process.env.PI_CACHE_RETENTION;
	});

	afterEach(() => {
		if (originalEnv !== undefined) {
			process.env.PI_CACHE_RETENTION = originalEnv;
		} else {
			delete process.env.PI_CACHE_RETENTION;
		}
	});

	const context: Context = {
		systemPrompt: "You are a helpful assistant.",
		messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
	};

	describe("Anthropic Provider", () => {
		it.skipIf(!process.env.ANTHROPIC_API_KEY)(
			"should use default cache TTL (no ttl field) when PI_CACHE_RETENTION is not set",
			async () => {
				const model = getModel("anthropic", "claude-haiku-4-5");
				let capturedPayload: any = null;

				const s = stream(model, context, {
					onPayload: stopAfterPayload((payload) => {
						capturedPayload = payload;
					}),
				});

				// Consume the stream to trigger the request
				for await (const _ of s) {
					// Just consume
				}

				expect(capturedPayload).not.toBeNull();
				// System prompt should have cache_control without ttl
				expect(capturedPayload.system).toBeDefined();
				expect(capturedPayload.system[0].cache_control).toEqual({ type: "ephemeral" });
			},
		);

		it.skipIf(!process.env.ANTHROPIC_API_KEY)("should use 1h cache TTL when PI_CACHE_RETENTION=long", async () => {
			process.env.PI_CACHE_RETENTION = "long";
			const model = getModel("anthropic", "claude-haiku-4-5");
			let capturedPayload: any = null;

			const s = stream(model, context, {
				onPayload: stopAfterPayload((payload) => {
					capturedPayload = payload;
				}),
			});

			// Consume the stream to trigger the request
			for await (const _ of s) {
				// Just consume
			}

			expect(capturedPayload).not.toBeNull();
			// System prompt should have cache_control with ttl: "1h"
			expect(capturedPayload.system).toBeDefined();
			expect(capturedPayload.system[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
		});

		it("should add ttl for non-api.anthropic.com baseUrl by default", async () => {
			process.env.PI_CACHE_RETENTION = "long";

			// Create a model with a different baseUrl (simulating a proxy)
			const baseModel = anthropicFixture("claude-haiku-4-5");
			const proxyModel = {
				...baseModel,
				baseUrl: "https://my-proxy.example.com/v1",
			};

			let capturedPayload: any = null;

			// We can't actually make the request (no proxy), but we can verify the payload
			// by using a mock or checking the logic directly
			// For this test, we'll import the helper directly

			// Since we can't easily test this without mocking, we'll skip the actual API call
			// and just verify the helper logic works correctly

			try {
				const s = streamAnthropic(proxyModel, context, {
					apiKey: "fake-key",
					onPayload: stopAfterPayload((payload) => {
						capturedPayload = payload;
					}),
				});

				// This will fail since we're using a fake key and fake proxy, but the payload should be captured
				for await (const event of s) {
					if (event.type === "error") break;
				}
			} catch {
				// Expected to fail
			}

			expect(capturedPayload).not.toBeNull();
			expect(capturedPayload.system[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
		});

		it("should omit ttl when supportsLongCacheRetention is false", async () => {
			const baseModel = anthropicFixture("claude-haiku-4-5");
			const proxyModel = {
				...baseModel,
				baseUrl: "https://my-proxy.example.com/v1",
				compat: { supportsLongCacheRetention: false },
			};
			let capturedPayload: any = null;

			try {
				const s = streamAnthropic(proxyModel, context, {
					apiKey: "fake-key",
					cacheRetention: "long",
					onPayload: stopAfterPayload((payload) => {
						capturedPayload = payload;
					}),
				});

				for await (const event of s) {
					if (event.type === "error") break;
				}
			} catch {
				// Expected to fail
			}

			expect(capturedPayload).not.toBeNull();
			expect(capturedPayload.system[0].cache_control).toEqual({ type: "ephemeral" });
		});

		it("should omit cache_control when cacheRetention is none", async () => {
			const baseModel = anthropicFixture("claude-haiku-4-5");
			let capturedPayload: any = null;

			try {
				const s = streamAnthropic(baseModel, context, {
					apiKey: "fake-key",
					cacheRetention: "none",
					onPayload: stopAfterPayload((payload) => {
						capturedPayload = payload;
					}),
				});

				for await (const event of s) {
					if (event.type === "error") break;
				}
			} catch {
				// Expected to fail
			}

			expect(capturedPayload).not.toBeNull();
			expect(capturedPayload.system[0].cache_control).toBeUndefined();
		});

		it("should add cache_control to string user messages", async () => {
			const baseModel = anthropicFixture("claude-haiku-4-5");
			let capturedPayload: any = null;

			try {
				const s = streamAnthropic(baseModel, context, {
					apiKey: "fake-key",
					onPayload: stopAfterPayload((payload) => {
						capturedPayload = payload;
					}),
				});

				for await (const event of s) {
					if (event.type === "error") break;
				}
			} catch {
				// Expected to fail
			}

			expect(capturedPayload).not.toBeNull();
			const lastMessage = capturedPayload.messages[capturedPayload.messages.length - 1];
			expect(Array.isArray(lastMessage.content)).toBe(true);
			const lastBlock = lastMessage.content[lastMessage.content.length - 1];
			expect(lastBlock.cache_control).toEqual({ type: "ephemeral" });
		});

		it("should set 1h cache TTL when cacheRetention is long", async () => {
			const baseModel = anthropicFixture("claude-haiku-4-5");
			let capturedPayload: any = null;

			try {
				const s = streamAnthropic(baseModel, context, {
					apiKey: "fake-key",
					cacheRetention: "long",
					onPayload: stopAfterPayload((payload) => {
						capturedPayload = payload;
					}),
				});

				for await (const event of s) {
					if (event.type === "error") break;
				}
			} catch {
				// Expected to fail
			}

			expect(capturedPayload).not.toBeNull();
			expect(capturedPayload.system[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
		});
	});

	describe("OpenAI Responses Provider", () => {
		it.skipIf(!process.env.OPENAI_API_KEY)(
			"should not set prompt_cache_retention when PI_CACHE_RETENTION is not set",
			async () => {
				const model = getModel("openai", "gpt-4o-mini");
				let capturedPayload: any = null;

				const s = stream(model, context, {
					onPayload: stopAfterPayload((payload) => {
						capturedPayload = payload;
					}),
				});

				// Consume the stream to trigger the request
				for await (const _ of s) {
					// Just consume
				}

				expect(capturedPayload).not.toBeNull();
				expect(capturedPayload.prompt_cache_retention).toBeUndefined();
			},
		);

		it.skipIf(!process.env.OPENAI_API_KEY)(
			"should set prompt_cache_retention to 24h when PI_CACHE_RETENTION=long",
			async () => {
				process.env.PI_CACHE_RETENTION = "long";
				const model = getModel("openai", "gpt-4o-mini");
				let capturedPayload: any = null;

				const s = stream(model, context, {
					onPayload: stopAfterPayload((payload) => {
						capturedPayload = payload;
					}),
				});

				// Consume the stream to trigger the request
				for await (const _ of s) {
					// Just consume
				}

				expect(capturedPayload).not.toBeNull();
				expect(capturedPayload.prompt_cache_retention).toBe("24h");
			},
		);

		it("should set prompt_cache_retention for non-api.openai.com baseUrl by default", async () => {
			process.env.PI_CACHE_RETENTION = "long";

			// Create a model with a different baseUrl (simulating a proxy)
			const baseModel = openaiResponsesFixture("gpt-4o-mini");
			const proxyModel = {
				...baseModel,
				baseUrl: "https://my-proxy.example.com/v1",
			};

			let capturedPayload: any = null;

			try {
				const s = streamOpenAIResponses(proxyModel, context, {
					apiKey: "fake-key",
					onPayload: stopAfterPayload((payload) => {
						capturedPayload = payload;
					}),
				});

				// This will fail since we're using a fake key and fake proxy, but the payload should be captured
				for await (const event of s) {
					if (event.type === "error") break;
				}
			} catch {
				// Expected to fail
			}

			expect(capturedPayload).not.toBeNull();
			expect(capturedPayload.prompt_cache_retention).toBe("24h");
		});

		it("should omit prompt_cache_retention when supportsLongCacheRetention is false", async () => {
			const model = {
				...openaiResponsesFixture("gpt-4o-mini"),
				compat: { supportsLongCacheRetention: false },
			};
			let capturedPayload: any = null;

			try {
				const s = streamOpenAIResponses(model, context, {
					apiKey: "fake-key",
					cacheRetention: "long",
					sessionId: "session-compat-false",
					onPayload: stopAfterPayload((payload) => {
						capturedPayload = payload;
					}),
				});

				for await (const event of s) {
					if (event.type === "error") break;
				}
			} catch {
				// Expected to fail
			}

			expect(capturedPayload).not.toBeNull();
			expect(capturedPayload.prompt_cache_retention).toBeUndefined();
		});

		it("should omit prompt_cache_key and disable implicit writes when cacheRetention is none", async () => {
			const model = RESPONSES_MODELS["openai/gpt-5.6-sol"];
			let capturedPayload: OpenAIResponsesCachePayload | undefined;

			try {
				const s = streamOpenAIResponses(model, context, {
					apiKey: "fake-key",
					cacheRetention: "none",
					sessionId: "session-1",
					onPayload: stopAfterPayload<OpenAIResponsesCachePayload>((payload) => {
						capturedPayload = payload;
					}),
				});

				for await (const event of s) {
					if (event.type === "error") break;
				}
			} catch {
				// Expected to fail
			}

			expect(capturedPayload).toBeDefined();
			expect(capturedPayload?.prompt_cache_key).toBeUndefined();
			expect(capturedPayload?.prompt_cache_retention).toBeUndefined();
			expect(capturedPayload?.prompt_cache_options).toEqual({ mode: "explicit" });
		});

		it("should omit prompt_cache_options for models that reject it", async () => {
			const model = openaiResponsesFixture("gpt-4o-mini");
			let capturedPayload: OpenAIResponsesCachePayload | undefined;

			try {
				const s = streamOpenAIResponses(model, context, {
					apiKey: "fake-key",
					cacheRetention: "none",
					sessionId: "session-1",
					onPayload: stopAfterPayload<OpenAIResponsesCachePayload>((payload) => {
						capturedPayload = payload;
					}),
				});

				for await (const event of s) {
					if (event.type === "error") break;
				}
			} catch {
				// Expected to fail
			}

			expect(capturedPayload).toBeDefined();
			expect(capturedPayload?.prompt_cache_key).toBeUndefined();
			expect(capturedPayload?.prompt_cache_options).toBeUndefined();
		});

		it("should set prompt_cache_retention when cacheRetention is long", async () => {
			const model = openaiResponsesFixture("gpt-4o-mini");
			let capturedPayload: any = null;

			try {
				const s = streamOpenAIResponses(model, context, {
					apiKey: "fake-key",
					cacheRetention: "long",
					sessionId: "session-2",
					onPayload: stopAfterPayload((payload) => {
						capturedPayload = payload;
					}),
				});

				for await (const event of s) {
					if (event.type === "error") break;
				}
			} catch {
				// Expected to fail
			}

			expect(capturedPayload).not.toBeNull();
			expect(capturedPayload.prompt_cache_key).toBe("session-2");
			expect(capturedPayload.prompt_cache_retention).toBe("24h");
		});
	});

	describe("OpenAI Completions Provider", () => {
		function createCompletionsModel(compat?: Model<"openai-completions">["compat"]): Model<"openai-completions"> {
			return {
				id: "test-model",
				name: "Test Model",
				api: "openai-completions",
				provider: "test-openai-completions",
				baseUrl: "https://my-proxy.example.com/v1",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 4096,
				compat,
			};
		}

		it("should set prompt_cache_retention for non-api.openai.com baseUrl by default", async () => {
			let capturedPayload: any = null;

			try {
				const s = streamOpenAICompletions(createCompletionsModel(), context, {
					apiKey: "fake-key",
					cacheRetention: "long",
					sessionId: "session-completions",
					onPayload: stopAfterPayload((payload) => {
						capturedPayload = payload;
					}),
				});

				for await (const event of s) {
					if (event.type === "error") break;
				}
			} catch {
				// Expected to fail
			}

			expect(capturedPayload).not.toBeNull();
			expect(capturedPayload.prompt_cache_key).toBe("session-completions");
			expect(capturedPayload.prompt_cache_retention).toBe("24h");
		});

		it("should omit prompt_cache_retention when supportsLongCacheRetention is false", async () => {
			let capturedPayload: any = null;

			try {
				const s = streamOpenAICompletions(createCompletionsModel({ supportsLongCacheRetention: false }), context, {
					apiKey: "fake-key",
					cacheRetention: "long",
					sessionId: "session-completions-false",
					onPayload: stopAfterPayload((payload) => {
						capturedPayload = payload;
					}),
				});

				for await (const event of s) {
					if (event.type === "error") break;
				}
			} catch {
				// Expected to fail
			}

			expect(capturedPayload).not.toBeNull();
			expect(capturedPayload.prompt_cache_key).toBeUndefined();
			expect(capturedPayload.prompt_cache_retention).toBeUndefined();
		});

		it.each([
			"opencode/deepseek-v4-flash",
			"opencode/deepseek-v4-pro",
			"opencode/kimi-k2.5",
			"opencode/kimi-k2.6",
			"opencode/minimax-m2.7",
			"opencode-go/kimi-k2.6",
		] as const)("should omit long cache retention for %s", async (fixtureKey) => {
			const model = OPENCODE_MODELS[fixtureKey];
			let capturedPayload: OpenAICompletionsCachePayload | undefined;

			try {
				const s = streamOpenAICompletions(model, context, {
					apiKey: "fake-key",
					cacheRetention: "long",
					sessionId: "session-opencode-long-cache-unsupported",
					onPayload: stopAfterPayload<OpenAICompletionsCachePayload>((payload) => {
						capturedPayload = payload;
					}),
				});

				for await (const event of s) {
					if (event.type === "error") break;
				}
			} catch {
				// Expected to fail
			}

			expect(model.compat?.supportsLongCacheRetention).toBe(false);
			expect(capturedPayload).toBeDefined();
			expect(capturedPayload?.prompt_cache_key).toBeUndefined();
			expect(capturedPayload?.prompt_cache_retention).toBeUndefined();
		});
	});
});
