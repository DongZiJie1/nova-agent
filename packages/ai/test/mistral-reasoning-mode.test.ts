import { describe, expect, it } from "vitest";
import { streamSimple } from "../src/compat.ts";
import type { Context, Model, SimpleStreamOptions } from "../src/types.ts";

interface MistralPayload {
	promptMode?: "reasoning";
	reasoningEffort?: "none" | "high";
	promptCacheKey?: string;
}

function makeContext(): Context {
	return {
		messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
	};
}

async function capturePayload(
	model: Model<"mistral-conversations">,
	options?: SimpleStreamOptions,
): Promise<MistralPayload> {
	let capturedPayload: MistralPayload | undefined;
	const payloadCaptureModel: Model<"mistral-conversations"> = {
		...model,
		baseUrl: "http://127.0.0.1:9",
	};

	const stream = streamSimple(payloadCaptureModel, makeContext(), {
		...options,
		apiKey: "fake-key",
		onPayload: (payload) => {
			capturedPayload = payload as MistralPayload;
			return payload;
		},
	});

	await stream.result();

	if (!capturedPayload) {
		throw new Error("Expected payload to be captured before request failure");
	}

	return capturedPayload;
}

function makeMistralModel(id: string): Model<"mistral-conversations"> {
	// Mistral selects its reasoning control from the model id, so tests declare
	// the model a user would have configured.
	return {
		id,
		name: id,
		api: "mistral-conversations",
		provider: "mistral",
		baseUrl: "https://api.mistral.ai",
		reasoning: true,
		input: ["text"],
		cost: { input: 0.4, output: 2, cacheRead: 0.1, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 32000,
	};
}

describe("Mistral reasoning mode selection", () => {
	it("uses reasoning_effort for Mistral Small 4", async () => {
		const payload = await capturePayload(makeMistralModel("mistral-small-2603"), { reasoning: "medium" });

		expect(payload.reasoningEffort).toBe("high");
		expect(payload.promptMode).toBeUndefined();
	});

	it("omits reasoning controls for Mistral Small 4 when thinking is off", async () => {
		const payload = await capturePayload(makeMistralModel("mistral-small-2603"));

		expect(payload.reasoningEffort).toBeUndefined();
		expect(payload.promptMode).toBeUndefined();
	});

	it("uses prompt_mode for Magistral reasoning models", async () => {
		const payload = await capturePayload(makeMistralModel("magistral-medium-latest"), { reasoning: "medium" });

		expect(payload.promptMode).toBe("reasoning");
		expect(payload.reasoningEffort).toBeUndefined();
	});

	it("uses reasoning_effort for Mistral Medium 3.5", async () => {
		const payload = await capturePayload(makeMistralModel("mistral-medium-3.5"), { reasoning: "medium" });

		expect(payload.reasoningEffort).toBe("high");
		expect(payload.promptMode).toBeUndefined();
	});

	it("omits reasoning controls for Mistral Medium 3.5 when thinking is off", async () => {
		const payload = await capturePayload(makeMistralModel("mistral-medium-3.5"));

		expect(payload.reasoningEffort).toBeUndefined();
		expect(payload.promptMode).toBeUndefined();
	});

	it("uses the session id as prompt cache key", async () => {
		const payload = await capturePayload(makeMistralModel("mistral-large-latest"), {
			sessionId: "session-123",
		});

		expect(payload.promptCacheKey).toBe("session-123");
	});

	it("omits prompt cache key when cache retention is disabled", async () => {
		const payload = await capturePayload(makeMistralModel("mistral-large-latest"), {
			sessionId: "session-123",
			cacheRetention: "none",
		});

		expect(payload.promptCacheKey).toBeUndefined();
	});
});
