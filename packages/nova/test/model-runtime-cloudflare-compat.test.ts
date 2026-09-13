import { describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";

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
	const modelRuntime = await ModelRuntime.create({ credentials: authStorage, modelsPath: null });
	return { modelRuntime, modelRegistry: new ModelRegistry(modelRuntime) };
}

// The bundled catalog exposes the gateway's /anthropic and /openai endpoints.
// The account and gateway ids stay as placeholders in the model and are filled
// in from the resolved credential env when a request is dispatched.
const GATEWAY_ANTHROPIC_BASE_URL =
	"https://gateway.ai.cloudflare.com/v1/{CLOUDFLARE_ACCOUNT_ID}/{CLOUDFLARE_GATEWAY_ID}/anthropic";

describe("Cloudflare AI Gateway model materialization", () => {
	it("resolves a gateway model from the bundled catalog", async () => {
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
