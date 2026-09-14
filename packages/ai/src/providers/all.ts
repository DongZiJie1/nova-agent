import { createImagesModels, type ImagesProvider, type MutableImagesModels } from "../images-models.ts";
import { type CreateModelsOptions, createModels, type MutableModels, type Provider } from "../models.ts";
import type { KnownProvider } from "../types.ts";
import { amazonBedrockProvider } from "./amazon-bedrock.ts";
import { antLingProvider } from "./ant-ling.ts";
import { anthropicProvider } from "./anthropic.ts";
import { azureOpenAIResponsesProvider } from "./azure-openai-responses.ts";
import { cerebrasProvider } from "./cerebras.ts";
import { cloudflareAIGatewayProvider } from "./cloudflare-ai-gateway.ts";
import { cloudflareWorkersAIProvider } from "./cloudflare-workers-ai.ts";
import { deepseekProvider } from "./deepseek.ts";
import { fireworksProvider } from "./fireworks.ts";
import { githubCopilotProvider } from "./github-copilot.ts";
import { googleProvider } from "./google.ts";
import { googleVertexProvider } from "./google-vertex.ts";
import { groqProvider } from "./groq.ts";
import { huggingfaceProvider } from "./huggingface.ts";
import { kimiCodingProvider } from "./kimi-coding.ts";
import { minimaxProvider } from "./minimax.ts";
import { minimaxCnProvider } from "./minimax-cn.ts";
import { mistralProvider } from "./mistral.ts";
import { moonshotaiProvider } from "./moonshotai.ts";
import { moonshotaiCnProvider } from "./moonshotai-cn.ts";
import { nvidiaProvider } from "./nvidia.ts";
import { openaiProvider } from "./openai.ts";
import { openaiCodexProvider } from "./openai-codex.ts";
import { opencodeProvider } from "./opencode.ts";
import { opencodeGoProvider } from "./opencode-go.ts";
import { openrouterProvider } from "./openrouter.ts";
import { qwenTokenPlanProvider } from "./qwen-token-plan.ts";
import { qwenTokenPlanCnProvider } from "./qwen-token-plan-cn.ts";
import { radiusProvider } from "./radius.ts";
import { togetherProvider } from "./together.ts";
import { vercelAIGatewayProvider } from "./vercel-ai-gateway.ts";
import { xaiProvider } from "./xai.ts";
import { xiaomiProvider } from "./xiaomi.ts";
import { xiaomiTokenPlanAmsProvider } from "./xiaomi-token-plan-ams.ts";
import { xiaomiTokenPlanCnProvider } from "./xiaomi-token-plan-cn.ts";
import { xiaomiTokenPlanSgpProvider } from "./xiaomi-token-plan-sgp.ts";
import { zaiProvider } from "./zai.ts";
import { zaiCodingCnProvider } from "./zai-coding-cn.ts";

export { radiusProvider };

/**
 * Providers shipped with this build — the list a maintainer edits when adding
 * or dropping an official provider.
 *
 * No model entries are bundled: every provider starts with an empty model list
 * and everything a user can pick comes from their own configuration
 * (models.json). `KnownProvider` additionally includes purely dynamic providers
 * (e.g. "radius") that are not part of the shipped set.
 */
export type BuiltinProvider = Exclude<KnownProvider, "radius">;

/** All built-in providers, freshly constructed, each with an empty model list. */
export function builtinProviders(): Provider[] {
	return [
		amazonBedrockProvider(),
		antLingProvider(),
		anthropicProvider(),
		azureOpenAIResponsesProvider(),
		cerebrasProvider(),
		cloudflareAIGatewayProvider(),
		cloudflareWorkersAIProvider(),
		deepseekProvider(),
		fireworksProvider(),
		githubCopilotProvider(),
		googleProvider(),
		googleVertexProvider(),
		groqProvider(),
		huggingfaceProvider(),
		kimiCodingProvider(),
		minimaxProvider(),
		minimaxCnProvider(),
		mistralProvider(),
		moonshotaiProvider(),
		moonshotaiCnProvider(),
		nvidiaProvider(),
		openaiProvider(),
		openaiCodexProvider(),
		opencodeProvider(),
		opencodeGoProvider(),
		openrouterProvider(),
		qwenTokenPlanProvider(),
		qwenTokenPlanCnProvider(),
		radiusProvider(),
		togetherProvider(),
		vercelAIGatewayProvider(),
		xaiProvider(),
		xiaomiProvider(),
		xiaomiTokenPlanAmsProvider(),
		xiaomiTokenPlanCnProvider(),
		xiaomiTokenPlanSgpProvider(),
		zaiProvider(),
		zaiCodingCnProvider(),
	];
}

/** A `Models` collection with every built-in provider registered. */
export function builtinModels(options?: CreateModelsOptions): MutableModels {
	const models = createModels(options);
	for (const provider of builtinProviders()) {
		models.setProvider(provider);
	}
	return models;
}

/** All built-in image-generation providers, freshly constructed. */
export function builtinImagesProviders(): ImagesProvider[] {
	// Image generation ships no catalog either: providers come from models.json,
	// so nothing is registered here.
	return [];
}

/** An `ImagesModels` collection with every built-in image-generation provider registered. */
export function builtinImagesModels(options?: CreateModelsOptions): MutableImagesModels {
	const models = createImagesModels(options);
	for (const provider of builtinImagesProviders()) {
		models.setProvider(provider);
	}
	return models;
}
