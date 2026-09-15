import { afterEach, describe, expect, it } from "vitest";
import {
	clampMaxTokensToLearnedCap,
	extractMaxTokensCap,
	maxTokensCapKey,
	rememberMaxTokensCap,
	resetMaxTokensCaps,
} from "../src/utils/max-tokens-cap.ts";

describe("extractMaxTokensCap", () => {
	it("reads the range Z.AI returns for an oversized max_tokens", () => {
		const message =
			'400 {"type":"error","error":{"type":"invalid_request_error","code":"1210","message":"[1210][max_tokens参数非法：限制数值范围[1,131072]]"},"request_id":"202609151637002ff3d883a05c4734"}';

		expect(extractMaxTokensCap(new Error(message), 1000000)).toBe(131072);
	});

	it("reads the comparison Anthropic puts in its own error", () => {
		const message =
			"400 max_tokens: 1000000 > 64000, which is the maximum allowed number of output tokens for claude-sonnet-4-5";

		expect(extractMaxTokensCap(new Error(message), 1000000)).toBe(64000);
	});

	it("reads prose caps from OpenAI-compatible gateways", () => {
		expect(extractMaxTokensCap(new Error('"max_tokens" must be less than or equal to 8,192'), 1000000)).toBe(8192);
		expect(extractMaxTokensCap(new Error("max_tokens: at most 4096"), 32768)).toBe(4096);
	});

	it("uses the parsed body when the message itself carries no body", () => {
		const error = Object.assign(new Error("400 status code (no body)"), {
			error: { message: "[1210][max_tokens参数非法：限制数值范围[1,131072]]" },
		});

		expect(extractMaxTokensCap(error, 1000000)).toBe(131072);
	});

	it("ignores context-overflow ranges that are not about max_tokens", () => {
		// DashScope answers an oversized prompt with this shape. Clamping the output
		// cap there would hide the real problem (and fix nothing).
		const message = "Range of input length should be [1, 131072]";

		expect(extractMaxTokensCap(new Error(message), 1000000)).toBeUndefined();
	});

	it("ignores errors that do not name a smaller cap", () => {
		expect(extractMaxTokensCap(new Error("max_tokens参数非法"), 1000000)).toBeUndefined();
		expect(extractMaxTokensCap(new Error("max_tokens: 1000 > 1000000"), 1000)).toBeUndefined();
		expect(extractMaxTokensCap(new Error("upstream timeout"), 1000)).toBeUndefined();
		expect(extractMaxTokensCap(undefined, 1000)).toBeUndefined();
	});
});

describe("learned max tokens caps", () => {
	afterEach(() => {
		resetMaxTokensCaps();
	});

	it("keys caps per endpoint and model", () => {
		const model = { provider: "zai", id: "glm-5.3-flash", baseUrl: "https://open.bigmodel.cn/api/anthropic" };

		expect(maxTokensCapKey(model)).toBe("zai:https://open.bigmodel.cn/api/anthropic:glm-5.3-flash");
	});

	it("clamps later requests to the smallest cap reported", () => {
		const key = maxTokensCapKey({ provider: "zai", id: "glm-5.3-flash" });

		expect(clampMaxTokensToLearnedCap(key, 1000000)).toBe(1000000);
		rememberMaxTokensCap(key, 131072);
		expect(clampMaxTokensToLearnedCap(key, 1000000)).toBe(131072);
		// A later, larger report never loosens the cap we already learned.
		rememberMaxTokensCap(key, 200000);
		expect(clampMaxTokensToLearnedCap(key, 1000000)).toBe(131072);
	});
});
