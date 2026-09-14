import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const bedrockMock = vi.hoisted(() => ({
	constructorCalls: [] as Array<Record<string, unknown>>,
}));

vi.mock("@aws-sdk/client-bedrock-runtime", () => {
	class BedrockRuntimeServiceException extends Error {}

	class BedrockRuntimeClient {
		constructor(config: Record<string, unknown>) {
			bedrockMock.constructorCalls.push(config);
		}

		send(): Promise<never> {
			return Promise.reject(new Error("mock send"));
		}
	}

	class ConverseStreamCommand {
		readonly input: unknown;

		constructor(input: unknown) {
			this.input = input;
		}
	}

	return {
		BedrockRuntimeClient,
		BedrockRuntimeServiceException,
		ConverseStreamCommand,
		StopReason: {
			END_TURN: "end_turn",
			STOP_SEQUENCE: "stop_sequence",
			MAX_TOKENS: "max_tokens",
			MODEL_CONTEXT_WINDOW_EXCEEDED: "model_context_window_exceeded",
			TOOL_USE: "tool_use",
		},
		CachePointType: { DEFAULT: "default" },
		CacheTTL: { ONE_HOUR: "ONE_HOUR" },
		ConversationRole: { ASSISTANT: "assistant", USER: "user" },
		ImageFormat: { JPEG: "jpeg", PNG: "png", GIF: "gif", WEBP: "webp" },
		ToolResultStatus: { ERROR: "error", SUCCESS: "success" },
	};
});

import type { BedrockOptions } from "../src/api/bedrock-converse-stream.ts";
import { stream as streamBedrock } from "../src/compat.ts";
import type { Context, Model } from "../src/types.ts";

const context: Context = {
	messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
};

const originalAwsRegion = process.env.AWS_REGION;
const originalAwsDefaultRegion = process.env.AWS_DEFAULT_REGION;
const originalAwsProfile = process.env.AWS_PROFILE;

beforeEach(() => {
	bedrockMock.constructorCalls.length = 0;
	delete process.env.AWS_REGION;
	delete process.env.AWS_DEFAULT_REGION;
	delete process.env.AWS_PROFILE;
});

afterEach(() => {
	if (originalAwsRegion === undefined) {
		delete process.env.AWS_REGION;
	} else {
		process.env.AWS_REGION = originalAwsRegion;
	}

	if (originalAwsDefaultRegion === undefined) {
		delete process.env.AWS_DEFAULT_REGION;
	} else {
		process.env.AWS_DEFAULT_REGION = originalAwsDefaultRegion;
	}

	if (originalAwsProfile === undefined) {
		delete process.env.AWS_PROFILE;
	} else {
		process.env.AWS_PROFILE = originalAwsProfile;
	}
});

async function captureClientConfig(
	model: Model<"bedrock-converse-stream">,
	options: BedrockOptions = {},
): Promise<Record<string, unknown>> {
	bedrockMock.constructorCalls.length = 0;
	await streamBedrock(model, context, { cacheRetention: "none", ...options }).result();
	expect(bedrockMock.constructorCalls).toHaveLength(1);
	return bedrockMock.constructorCalls[0];
}

function makeBedrockModel(
	id = "us.anthropic.claude-opus-4-8",
	overrides: Partial<Model<"bedrock-converse-stream">> = {},
): Model<"bedrock-converse-stream"> {
	// Bedrock regional endpoints are per-model configuration, so tests declare
	// the endpoint a user would have configured for that profile.
	const region = id.startsWith("eu.") ? "eu-central-1" : id.startsWith("us-gov.") ? "us-gov-west-1" : "us-east-1";
	return {
		id,
		name: id,
		api: "bedrock-converse-stream",
		provider: "amazon-bedrock",
		baseUrl: `https://bedrock-runtime.${region}.amazonaws.com`,
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		contextWindow: 200000,
		maxTokens: 32000,
		...overrides,
	};
}

describe("bedrock endpoint resolution", () => {
	it("does not pin standard AWS endpoints when AWS_REGION is configured", async () => {
		process.env.AWS_REGION = "us-east-2";
		const model = makeBedrockModel("us.anthropic.claude-opus-4-8");

		const config = await captureClientConfig(model);

		expect(config.region).toBe("us-east-2");
		expect(config.endpoint).toBeUndefined();
	});

	it("derives region from a built-in EU endpoint when no region or profile is configured", async () => {
		const model = makeBedrockModel("eu.anthropic.claude-sonnet-4-5-20250929-v1:0");

		const config = await captureClientConfig(model);

		expect(config.endpoint).toBe("https://bedrock-runtime.eu-central-1.amazonaws.com");
		expect(config.region).toBe("eu-central-1");
	});

	it("handles missing regions for explicit, scoped, and ambient profiles", async () => {
		const model = makeBedrockModel("eu.anthropic.claude-sonnet-4-5-20250929-v1:0");

		let config = await captureClientConfig(model, { profile: "bedrock-profile" });

		expect(config.profile).toBe("bedrock-profile");
		expect(config.endpoint).toBe("https://bedrock-runtime.eu-central-1.amazonaws.com");
		expect(config.region).toBe("eu-central-1");

		config = await captureClientConfig(model, { env: { AWS_PROFILE: "scoped-bedrock-profile" } });

		expect(config.profile).toBe("scoped-bedrock-profile");
		expect(config.endpoint).toBe("https://bedrock-runtime.eu-central-1.amazonaws.com");
		expect(config.region).toBe("eu-central-1");

		process.env.AWS_PROFILE = "ambient-bedrock-profile";
		config = await captureClientConfig(model);

		expect(config.profile).toBe("ambient-bedrock-profile");
		expect(config.endpoint).toBeUndefined();
		expect(config.region).toBeUndefined();
	});

	it("still passes custom Bedrock endpoints through to the SDK client", async () => {
		process.env.AWS_REGION = "us-west-2";
		const baseModel = makeBedrockModel("us.anthropic.claude-opus-4-8");
		const model = makeBedrockModel(baseModel.id, { baseUrl: "https://bedrock-vpc.example.com" });

		const config = await captureClientConfig(model);

		expect(config.endpoint).toBe("https://bedrock-vpc.example.com");
		expect(config.region).toBe("us-west-2");
	});

	it("extracts region from inference profile ARN regardless of AWS_REGION", async () => {
		process.env.AWS_REGION = "us-east-1";
		const baseModel = makeBedrockModel("us.anthropic.claude-opus-4-8");
		const model: Model<"bedrock-converse-stream"> = {
			...baseModel,
			id: "arn:aws:bedrock:us-west-2:123456789012:application-inference-profile/abc123",
		};

		const config = await captureClientConfig(model);

		expect(config.region).toBe("us-west-2");
	});

	it("extracts region from GovCloud inference profile ARN", async () => {
		process.env.AWS_REGION = "us-east-1";
		const baseModel = makeBedrockModel("us.anthropic.claude-opus-4-8");
		const model: Model<"bedrock-converse-stream"> = {
			...baseModel,
			id: "arn:aws-us-gov:bedrock:us-gov-west-1:123456789012:application-inference-profile/abc123",
		};

		const config = await captureClientConfig(model);

		expect(config.region).toBe("us-gov-west-1");
	});

	it("preserves ambient AWS auth for custom model IDs through compat dispatch", async () => {
		process.env.AWS_PROFILE = "bedrock-profile";
		const baseModel = makeBedrockModel("us.anthropic.claude-opus-4-8");
		const model: Model<"bedrock-converse-stream"> = {
			...baseModel,
			id: "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/example",
		};

		const config = await captureClientConfig(model);

		expect(config.profile).toBe("bedrock-profile");
		expect(config.token).toBeUndefined();
		expect(config.authSchemePreference).toBeUndefined();
	});

	it("uses the generic API key option as a Bedrock bearer token", async () => {
		const model = makeBedrockModel("us.anthropic.claude-opus-4-8");

		const config = await captureClientConfig(model, { apiKey: "bedrock-api-key" });

		expect(config.token).toEqual({ token: "bedrock-api-key" });
		expect(config.authSchemePreference).toEqual(["httpBearerAuth"]);
	});
});
