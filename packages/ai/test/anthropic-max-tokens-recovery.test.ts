import { beforeEach, describe, expect, it, vi } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import type { Context, Model } from "../src/types.ts";
import { resetMaxTokensCaps } from "../src/utils/max-tokens-cap.ts";

const mockState = vi.hoisted(() => ({
	calls: [] as Record<string, unknown>[],
}));

vi.mock("@anthropic-ai/sdk", () => {
	// Z.AI's Anthropic-compatible endpoint answers this for an output cap above
	// 131072; the SDK surfaces it as a `<status> <body>` error.
	const rejectedBody =
		'{"type":"error","error":{"type":"invalid_request_error","code":"1210","message":"[1210][max_tokens参数非法：限制数值范围[1,131072]]"}}';

	function successResponse(): Response {
		const body = [
			`event: message_start\ndata: ${JSON.stringify({
				type: "message_start",
				message: { id: "msg_test", usage: { input_tokens: 10, output_tokens: 0 } },
			})}\n`,
			`event: message_delta\ndata: ${JSON.stringify({
				type: "message_delta",
				delta: { stop_reason: "end_turn" },
				usage: { output_tokens: 5 },
			})}\n`,
			`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n`,
		].join("\n");

		return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
	}

	class FakeAnthropic {
		messages = {
			create: (params: Record<string, unknown>) => {
				mockState.calls.push(params);
				return {
					asResponse: async () => {
						const maxTokens = params.max_tokens;
						if (typeof maxTokens === "number" && maxTokens > 131072) {
							const error = new Error(`400 ${rejectedBody}`);
							Object.assign(error, { status: 400, error: JSON.parse(rejectedBody) });
							throw error;
						}
						return successResponse();
					},
				};
			},
		};
	}

	return { default: FakeAnthropic };
});

describe("Anthropic Messages output cap recovery", () => {
	const context: Context = {
		messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
	};

	function makeModel(maxTokens: number): Model<"anthropic-messages"> {
		return {
			id: "glm-5.3-flash",
			name: "GLM 5.3 Flash",
			api: "anthropic-messages",
			provider: "zai",
			baseUrl: "https://open.bigmodel.cn/api/anthropic",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1000000,
			maxTokens,
		};
	}

	function sentMaxTokens(): unknown[] {
		return mockState.calls.map((call) => call.max_tokens);
	}

	beforeEach(() => {
		mockState.calls.length = 0;
		resetMaxTokensCaps();
	});

	it("retries once with the cap the endpoint reported", async () => {
		const result = await streamAnthropic(makeModel(1000000), context, { apiKey: "test-key" }).result();

		expect(result.stopReason).toBe("stop");
		expect(sentMaxTokens()).toEqual([1000000, 131072]);
	});

	it("reuses the learned cap for later turns instead of failing again", async () => {
		await streamAnthropic(makeModel(1000000), context, { apiKey: "test-key" }).result();
		await streamAnthropic(makeModel(1000000), context, { apiKey: "test-key" }).result();

		expect(sentMaxTokens()).toEqual([1000000, 131072, 131072]);
	});

	it("leaves an accepted cap alone", async () => {
		const result = await streamAnthropic(makeModel(64000), context, { apiKey: "test-key" }).result();

		expect(result.stopReason).toBe("stop");
		expect(sentMaxTokens()).toEqual([64000]);
	});
});
