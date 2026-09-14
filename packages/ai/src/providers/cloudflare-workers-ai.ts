import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { createProvider, type Provider } from "../models.ts";
import { cloudflareWorkersAIAuth } from "./cloudflare-auth.ts";
import { cloudflareStreams } from "./cloudflare-stream.ts";

export function cloudflareWorkersAIProvider(): Provider<"openai-completions"> {
	return createProvider<"openai-completions">({
		id: "cloudflare-workers-ai",
		name: "Cloudflare Workers AI",
		auth: { apiKey: cloudflareWorkersAIAuth() },
		models: [],
		api: cloudflareStreams(openAICompletionsApi()),
	});
}
