import type { StreamFn } from "@dongzijie1/pi-agent-core";
import type {
	Api,
	AssistantMessage,
	AssistantMessageEventStream,
	Context,
	FauxProviderRegistration,
	Model,
	SimpleStreamOptions,
	StreamOptions,
} from "@dongzijie1/pi-ai/compat";
import { fauxAssistantMessage, fauxText, registerFauxProvider } from "@dongzijie1/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import {
	type CompletionAuth,
	type CreateExtractionCompletionOptions,
	createExtractionCompletion,
} from "../../src/core/memory/fact-completion.ts";
import type { ExtractionCompletion } from "../../src/core/memory/fact-extraction.ts";

const unregisterCallbacks: Array<() => void> = [];

const AUTH: CompletionAuth = {
	apiKey: "test-key",
	headers: { "x-nova-test": "1" },
	env: { NOVA_TEST_ENV: "1" },
};

const SYSTEM_PROMPT = "system prompt";
const USER_PROMPT = "user prompt";

afterEach(() => {
	for (const unregister of unregisterCallbacks.splice(0)) unregister();
});

function registerFaux(): FauxProviderRegistration {
	const faux = registerFauxProvider({ models: [{ id: "faux-extraction", reasoning: false }] });
	unregisterCallbacks.push(() => faux.unregister());
	return faux;
}

function fakeStream(result: Promise<AssistantMessage>): AssistantMessageEventStream {
	return { result: () => result } as unknown as AssistantMessageEventStream;
}

function neverSettles(): Promise<AssistantMessage> {
	return new Promise<AssistantMessage>(() => undefined);
}

function createCompletion(
	model: Model<Api>,
	overrides: Partial<Pick<CreateExtractionCompletionOptions, "streamFn" | "resolveAuth" | "timeoutMs">> = {},
): ExtractionCompletion {
	return createExtractionCompletion({
		model,
		resolveAuth: async () => AUTH,
		timeoutMs: 1000,
		...overrides,
	});
}

function requestInput(signal?: AbortSignal): { systemPrompt: string; userPrompt: string; signal?: AbortSignal } {
	return { systemPrompt: SYSTEM_PROMPT, userPrompt: USER_PROMPT, signal };
}

describe("createExtractionCompletion", () => {
	it("returns the model text and sends an isolated request", async () => {
		const faux = registerFaux();
		let capturedContext: Context | undefined;
		let capturedOptions: StreamOptions | undefined;
		faux.setResponses([
			(context, options) => {
				capturedContext = context;
				capturedOptions = options;
				return fauxAssistantMessage('{"facts":[]}');
			},
		]);

		await expect(createCompletion(faux.getModel())(requestInput())).resolves.toBe('{"facts":[]}');

		expect(capturedContext?.systemPrompt).toBe(SYSTEM_PROMPT);
		expect(capturedContext?.messages).toHaveLength(1);
		expect(capturedContext?.messages[0]?.content).toEqual([{ type: "text", text: USER_PROMPT }]);
		expect(capturedOptions).toMatchObject({
			cacheRetention: "none",
			maxTokens: 1024,
			apiKey: AUTH.apiKey,
			headers: AUTH.headers,
			env: AUTH.env,
		});
		expect(typeof capturedOptions?.sessionId).toBe("string");
		expect(capturedOptions?.sessionId).not.toBe("");
		expect(capturedOptions).not.toHaveProperty("temperature");
	});

	it("uses a fresh session id for every request", async () => {
		const faux = registerFaux();
		const sessionIds: Array<string | undefined> = [];
		faux.setResponses([
			(_context, options) => {
				sessionIds.push(options?.sessionId);
				return fauxAssistantMessage("first");
			},
			(_context, options) => {
				sessionIds.push(options?.sessionId);
				return fauxAssistantMessage("second");
			},
		]);

		const complete = createCompletion(faux.getModel());
		await complete(requestInput());
		await complete(requestInput());

		expect(sessionIds).toHaveLength(2);
		expect(sessionIds[0]).toBeTruthy();
		expect(sessionIds[0]).not.toBe(sessionIds[1]);
	});

	it("uses the injected stream function and forwards the prompts", async () => {
		const calls: Array<{ context: Context; options?: SimpleStreamOptions }> = [];
		const streamFn: StreamFn = (_model, context, options) => {
			calls.push({ context, options });
			return fakeStream(Promise.resolve(fauxAssistantMessage([fauxText("first"), fauxText("second")])));
		};

		await expect(createCompletion(registerFaux().getModel(), { streamFn })(requestInput())).resolves.toBe(
			"first\nsecond",
		);

		expect(calls).toHaveLength(1);
		expect(calls[0]?.context.systemPrompt).toBe(SYSTEM_PROMPT);
		expect(calls[0]?.context.messages[0]?.content).toEqual([{ type: "text", text: USER_PROMPT }]);
		expect(calls[0]?.options).toMatchObject({ cacheRetention: "none", maxTokens: 1024 });
		expect(typeof calls[0]?.options?.sessionId).toBe("string");
	});

	it("returns an empty string when the response has no text", async () => {
		const streamFn: StreamFn = () => fakeStream(Promise.resolve(fauxAssistantMessage([])));

		await expect(createCompletion(registerFaux().getModel(), { streamFn })(requestInput())).resolves.toBe("");
	});

	it("times out when the stream never settles", async () => {
		let requestSignal: AbortSignal | undefined;
		const streamFn: StreamFn = (_model, _context, options) => {
			requestSignal = options?.signal;
			return fakeStream(neverSettles());
		};

		const completion = createCompletion(registerFaux().getModel(), { streamFn, timeoutMs: 10 });

		await expect(completion(requestInput())).rejects.toThrow(/timed out/);
		expect(requestSignal?.aborted).toBe(true);
	});

	it("throws the provider error message when the model reports an error", async () => {
		const streamFn: StreamFn = () =>
			fakeStream(
				Promise.resolve(
					fauxAssistantMessage("partial", { stopReason: "error", errorMessage: "provider exploded" }),
				),
			);

		await expect(createCompletion(registerFaux().getModel(), { streamFn })(requestInput())).rejects.toThrow(
			"Memory extraction failed: provider exploded",
		);
	});

	it("throws when the model reports an aborted completion", async () => {
		const streamFn: StreamFn = () => fakeStream(Promise.resolve(fauxAssistantMessage("", { stopReason: "aborted" })));

		await expect(createCompletion(registerFaux().getModel(), { streamFn })(requestInput())).rejects.toThrow(
			"Memory extraction aborted",
		);
	});

	it("rejects without calling the provider when the signal is already aborted", async () => {
		let resolveAuthCalls = 0;
		let streamCalls = 0;
		const streamFn: StreamFn = () => {
			streamCalls += 1;
			return fakeStream(Promise.resolve(fauxAssistantMessage("unused")));
		};
		const resolveAuth = async (): Promise<CompletionAuth> => {
			resolveAuthCalls += 1;
			return AUTH;
		};
		const controller = new AbortController();
		controller.abort();

		const completion = createCompletion(registerFaux().getModel(), { streamFn, resolveAuth });

		await expect(completion(requestInput(controller.signal))).rejects.toThrow("Memory extraction aborted");
		expect(resolveAuthCalls).toBe(0);
		expect(streamCalls).toBe(0);
	});

	it("rejects when the external signal aborts while the request is in flight", async () => {
		const streamFn: StreamFn = () => fakeStream(neverSettles());
		const controller = new AbortController();

		const completion = createCompletion(registerFaux().getModel(), { streamFn });
		const pending = completion(requestInput(controller.signal));
		await Promise.resolve();
		controller.abort();

		await expect(pending).rejects.toThrow("Memory extraction aborted");
	});
});
