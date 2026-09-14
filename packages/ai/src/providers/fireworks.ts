import { anthropicMessagesApi } from "../api/anthropic-messages.lazy.ts";
import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";

export function fireworksProvider(): Provider<"anthropic-messages" | "openai-completions"> {
	return createProvider<"anthropic-messages" | "openai-completions">({
		id: "fireworks",
		name: "Fireworks",
		baseUrl: "https://api.fireworks.ai/inference",
		auth: { apiKey: envApiKeyAuth("Fireworks API key", ["FIREWORKS_API_KEY"]) },
		models: [],
		api: {
			"anthropic-messages": anthropicMessagesApi(),
			"openai-completions": openAICompletionsApi(),
		},
	});
}
