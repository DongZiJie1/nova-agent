import { mistralConversationsApi } from "../api/mistral-conversations.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";

export function mistralProvider(): Provider<"mistral-conversations"> {
	return createProvider<"mistral-conversations">({
		id: "mistral",
		name: "Mistral",
		baseUrl: "https://api.mistral.ai",
		auth: { apiKey: envApiKeyAuth("Mistral API key", ["MISTRAL_API_KEY"]) },
		models: [],
		api: mistralConversationsApi(),
	});
}
