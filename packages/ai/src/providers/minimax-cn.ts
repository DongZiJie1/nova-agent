import { anthropicMessagesApi } from "../api/anthropic-messages.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";

export function minimaxCnProvider(): Provider<"anthropic-messages"> {
	return createProvider<"anthropic-messages">({
		id: "minimax-cn",
		name: "MiniMax CN",
		baseUrl: "https://api.minimaxi.com/anthropic",
		auth: { apiKey: envApiKeyAuth("MiniMax CN API key", ["MINIMAX_CN_API_KEY"]) },
		models: [],
		api: anthropicMessagesApi(),
	});
}
