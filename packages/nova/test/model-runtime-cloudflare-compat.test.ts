import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";

// The gateway's /anthropic and /openai endpoints. The account and gateway ids stay
// as placeholders in the model and are filled in from the resolved credential env
// when a request is dispatched (see packages/ai/src/providers/cloudflare-stream.ts).
const GATEWAY_ANTHROPIC_BASE_URL =
	"https://gateway.ai.cloudflare.com/v1/{CLOUDFLARE_ACCOUNT_ID}/{CLOUDFLARE_GATEWAY_ID}/anthropic";

describe("Cloudflare AI Gateway model materialization", () => {
	let tempDir: string;
	let modelsJsonPath: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `nova-test-cloudflare-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		modelsJsonPath = join(tempDir, "models.json");
		// cloudflare-ai-gateway ships no model list of its own, so the gateway model
		// comes from user configuration and carries the templated endpoint itself.
		writeFileSync(
			modelsJsonPath,
			JSON.stringify({
				providers: {
					"cloudflare-ai-gateway": {
						models: [
							{
								id: "claude-sonnet-5",
								api: "anthropic-messages",
								baseUrl: GATEWAY_ANTHROPIC_BASE_URL,
								contextWindow: 200_000,
								maxTokens: 64_000,
								input: ["text", "image"],
							},
						],
					},
				},
			}),
		);
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	});

	async function createCloudflareRuntime(): Promise<{ modelRuntime: ModelRuntime; modelRegistry: ModelRegistry }> {
		const authStorage = AuthStorage.inMemory();
		await authStorage.modify("cloudflare-ai-gateway", async () => ({
			type: "api_key",
			key: "test-token",
			env: {
				CLOUDFLARE_ACCOUNT_ID: "test-account",
				CLOUDFLARE_GATEWAY_ID: "test-gateway",
			},
		}));
		const modelRuntime = await ModelRuntime.create({ credentials: authStorage, modelsPath: modelsJsonPath });
		return { modelRuntime, modelRegistry: new ModelRegistry(modelRuntime) };
	}

	it("resolves a configured gateway model and keeps its templated endpoint", async () => {
		const { modelRuntime } = await createCloudflareRuntime();
		const model = modelRuntime.getModel("cloudflare-ai-gateway", "claude-sonnet-5");

		expect(model).toBeDefined();
		expect(model?.api).toBe("anthropic-messages");
		expect(model?.baseUrl).toBe(GATEWAY_ANTHROPIC_BASE_URL);
	});

	it("resolves credential env and the gateway auth header after extension-style auth resolution", async () => {
		const { modelRegistry } = await createCloudflareRuntime();
		const model = modelRegistry.find("cloudflare-ai-gateway", "claude-sonnet-5");
		expect(model).toBeDefined();

		const auth = await modelRegistry.getApiKeyAndHeaders(model!);
		expect(auth.ok).toBe(true);
		if (!auth.ok) throw new Error(auth.error);

		expect(auth.headers?.["cf-aig-authorization"]).toBe("Bearer test-token");
		expect(auth.env).toMatchObject({
			CLOUDFLARE_ACCOUNT_ID: "test-account",
			CLOUDFLARE_GATEWAY_ID: "test-gateway",
		});
	});
});
