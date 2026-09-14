import { describe, expect, it } from "vitest";
import { streamSimple as streamSimpleOpenAICodexResponses } from "../src/api/openai-codex-responses.ts";
import { clampThinkingLevel, getSupportedThinkingLevels } from "../src/compat.ts";
import type { Context, Model } from "../src/types.ts";

function mockToken(): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
		"utf8",
	).toString("base64");
	return `aaa.${payload}.bbb`;
}

function makeCodexModel(id: string): Model<"openai-codex-responses"> {
	// Codex Responses models that expose xhigh/max declare it through
	// thinkingLevelMap, which the user configures per model.
	return {
		id,
		name: id,
		api: "openai-codex-responses",
		provider: "openai-codex",
		baseUrl: "https://chatgpt.com/backend-api/codex",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
		contextWindow: 400000,
		maxTokens: 128000,
		thinkingLevelMap: { xhigh: "xhigh", max: "max" },
	};
}

describe("max thinking level", () => {
	it("is opt-in for ordinary reasoning models", () => {
		const model: Model<"openai-completions"> = {
			id: "ordinary-reasoning",
			name: "Ordinary Reasoning",
			api: "openai-completions",
			provider: "test",
			baseUrl: "https://example.com/v1",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 4096,
		};

		expect(getSupportedThinkingLevels(model)).toEqual(["off", "minimal", "low", "medium", "high"]);
		expect(clampThinkingLevel(model, "max")).toBe("high");
	});

	it.each(["gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra"] as const)(
		"exposes xhigh and max for openai-codex/%s",
		(modelId) => {
			const model = makeCodexModel(modelId);
			expect(model.thinkingLevelMap).toMatchObject({ xhigh: "xhigh", max: "max" });
			expect(getSupportedThinkingLevels(model!)).toEqual([
				"off",
				"minimal",
				"low",
				"medium",
				"high",
				"xhigh",
				"max",
			]);
		},
	);

	it("supports a hole between high and max", () => {
		const model: Model<"openai-completions"> = {
			id: "high-and-max",
			name: "High and Max",
			api: "openai-completions",
			provider: "test",
			baseUrl: "https://example.com/v1",
			reasoning: true,
			thinkingLevelMap: { xhigh: null, max: "max" },
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 4096,
		};

		expect(getSupportedThinkingLevels(model)).toEqual(["off", "minimal", "low", "medium", "high", "max"]);
		expect(clampThinkingLevel(model, "xhigh")).toBe("max");
	});

	it("sends max to the Codex Responses API", async () => {
		const model = makeCodexModel("gpt-5.6-sol");
		const context: Context = {
			systemPrompt: "You are a helpful assistant.",
			messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
		};
		let payload: unknown;

		await streamSimpleOpenAICodexResponses(model, context, {
			apiKey: mockToken(),
			reasoning: "max",
			onPayload: (request) => {
				payload = request;
				throw new Error("payload captured");
			},
		}).result();

		expect(payload).toMatchObject({ reasoning: { effort: "max", summary: "auto" } });
	});
});
