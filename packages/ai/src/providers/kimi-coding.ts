import { anthropicMessagesApi } from "../api/anthropic-messages.lazy.ts";
import { envApiKeyAuth, lazyOAuth } from "../auth/helpers.ts";
import { loadKimiCodingOAuth } from "../auth/oauth/load.ts";
import { createProvider, type Provider } from "../models.ts";

export function kimiCodingProvider(): Provider<"anthropic-messages"> {
	return createProvider<"anthropic-messages">({
		id: "kimi-coding",
		name: "Kimi For Coding",
		baseUrl: "https://api.kimi.com/coding",
		auth: {
			apiKey: envApiKeyAuth("Kimi API key", ["KIMI_API_KEY"]),
			oauth: lazyOAuth({
				name: "Kimi Code (subscription)",
				loginLabel: "Sign in with Kimi Code",
				load: loadKimiCodingOAuth,
			}),
		},
		models: [],
		api: anthropicMessagesApi(),
	});
}
