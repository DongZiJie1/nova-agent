/**
 * Shared test fixtures for model catalogs.
 *
 * The package ships no bundled models, so tests install the models they need
 * through the fixture registry. This module holds the fixture data only; each
 * package's setup file injects its own registry functions so the fixtures land
 * in the same module instance the tests import from.
 */
import type { Api, Model } from "../packages/ai/src/types.ts";

export interface FixtureRegistry {
	registerFixtureModels(list: readonly Model<Api>[]): void;
	setFixtureFallback(factory: ((provider: string, id: string) => Model<Api> | undefined) | undefined): void;
}

/** Wire API per shipped provider, used to synthesize fixture models. */
const PROVIDER_API: Record<string, Api> = {
	"amazon-bedrock": "bedrock-converse-stream",
	"ant-ling": "openai-completions",
	anthropic: "anthropic-messages",
	"azure-openai-responses": "azure-openai-responses",
	cerebras: "openai-completions",
	"cloudflare-ai-gateway": "anthropic-messages",
	"cloudflare-workers-ai": "openai-completions",
	deepseek: "openai-completions",
	fireworks: "anthropic-messages",
	"github-copilot": "anthropic-messages",
	google: "google-generative-ai",
	"google-vertex": "google-vertex",
	groq: "openai-completions",
	huggingface: "openai-completions",
	"kimi-coding": "anthropic-messages",
	minimax: "anthropic-messages",
	"minimax-cn": "anthropic-messages",
	mistral: "mistral-conversations",
	moonshotai: "openai-completions",
	"moonshotai-cn": "openai-completions",
	nvidia: "openai-completions",
	openai: "openai-responses",
	"openai-codex": "openai-codex-responses",
	opencode: "openai-completions",
	"opencode-go": "openai-completions",
	openrouter: "openai-completions",
	"qwen-token-plan": "openai-completions",
	"qwen-token-plan-cn": "openai-completions",
	radius: "pi-messages",
	together: "openai-completions",
	"vercel-ai-gateway": "anthropic-messages",
	xai: "openai-responses",
	xiaomi: "openai-completions",
	"xiaomi-token-plan-ams": "openai-completions",
	"xiaomi-token-plan-cn": "openai-completions",
	"xiaomi-token-plan-sgp": "openai-completions",
	zai: "openai-completions",
	"zai-coding-cn": "openai-completions",
};

const BASE_URL: Record<string, string> = {
	"ant-ling": "https://api.ant-ling.com/v1",
	anthropic: "https://api.anthropic.com",
	cerebras: "https://api.cerebras.ai/v1",
	deepseek: "https://api.deepseek.com",
	fireworks: "https://api.fireworks.ai/inference",
	"github-copilot": "https://api.individual.githubcopilot.com",
	google: "https://generativelanguage.googleapis.com/v1beta",
	"google-vertex": "https://us-central1-aiplatform.googleapis.com",
	groq: "https://api.groq.com/openai/v1",
	huggingface: "https://router.huggingface.co/v1",
	"kimi-coding": "https://api.kimi.com/coding",
	minimax: "https://api.minimax.io/anthropic",
	"minimax-cn": "https://api.minimaxi.com/anthropic",
	mistral: "https://api.mistral.ai",
	moonshotai: "https://api.moonshot.ai/v1",
	"moonshotai-cn": "https://api.moonshot.cn/v1",
	nvidia: "https://integrate.api.nvidia.com/v1",
	openai: "https://api.openai.com/v1",
	"openai-codex": "https://chatgpt.com/backend-api/codex",
	openrouter: "https://openrouter.ai/api/v1",
	radius: "https://radius.pi.dev",
	together: "https://api.together.ai/v1",
	"vercel-ai-gateway": "https://ai-gateway.vercel.sh",
	xai: "https://api.x.ai/v1",
	xiaomi: "https://api.xiaomimimo.com/v1",
	"xiaomi-token-plan-ams": "https://token-plan-ams.xiaomimimo.com/v1",
	"xiaomi-token-plan-cn": "https://token-plan-cn.xiaomimimo.com/v1",
	"xiaomi-token-plan-sgp": "https://token-plan-sgp.xiaomimimo.com/v1",
	zai: "https://api.z.ai/api/coding/paas/v4",
	"zai-coding-cn": "https://open.bigmodel.cn/api/coding/paas/v4",
};

export function fixtureModel(provider: string, id: string, overrides: Partial<Model<Api>> = {}): Model<Api> {
	const api = (overrides.api ?? PROVIDER_API[provider] ?? "openai-completions") as Api;
	return {
		id,
		name: id,
		api,
		provider,
		baseUrl: BASE_URL[provider] ?? `https://${provider}.test/v1`,
		reasoning: false,
		input: ["text"],
		cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
		contextWindow: 200_000,
		maxTokens: 16_384,
		...overrides,
	} as Model<Api>;
}

/** Models with metadata a number of tests depend on. */
export function defaultFixtureModels(): Model<Api>[] {
	return [
		fixtureModel("anthropic", "claude-sonnet-4-5", {
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 200_000,
		}),
		fixtureModel("anthropic", "claude-haiku-4-5", { reasoning: true }),
		fixtureModel("anthropic", "claude-opus-4-6", { reasoning: true }),
		fixtureModel("anthropic", "claude-opus-4-8", { reasoning: true }),
		fixtureModel("openai", "gpt-4o-mini"),
		fixtureModel("openai", "gpt-5.4", { reasoning: true }),
		fixtureModel("openai-codex", "gpt-5.5", { reasoning: true }),
		fixtureModel("github-copilot", "claude-sonnet-4.6", { reasoning: true }),
		fixtureModel("google", "gemini-2.5-flash", { reasoning: true, input: ["text", "image"] }),
		// Tests assert this compat flag survives request shaping.
		fixtureModel("zai", "glm-4.7", { compat: { zaiToolStream: true } as Model<Api>["compat"] }),
		// Tests assert the Responses API effort mapping for Grok 4.5.
		fixtureModel("xai", "grok-4.5", {
			reasoning: true,
			thinkingLevelMap: { off: null, low: "low", medium: "medium", high: "high", xhigh: null, max: null },
		}),
	];
}

export function installFixtureRegistry(registry: FixtureRegistry): void {
	registry.registerFixtureModels(defaultFixtureModels());
	// Synthesize anything else: most suites only need a model object as input,
	// so an unlisted (provider, id) pair should still resolve.
	registry.setFixtureFallback((provider, id) => fixtureModel(provider, id));
}
