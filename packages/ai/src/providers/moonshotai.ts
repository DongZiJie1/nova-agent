import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";

export function moonshotaiProvider(): Provider<"openai-completions"> {
	return createProvider<"openai-completions">({
		id: "moonshotai",
		name: "Moonshot AI",
		baseUrl: "https://api.moonshot.ai/v1",
		auth: { apiKey: envApiKeyAuth("Moonshot AI API key", ["MOONSHOT_API_KEY"]) },
		models: [],
		api: openAICompletionsApi(),
	});
}
