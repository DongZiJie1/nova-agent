import { openAICodexResponsesApi } from "../api/openai-codex-responses.lazy.ts";
import { lazyOAuth } from "../auth/helpers.ts";
import { loadOpenAICodexOAuth } from "../auth/oauth/load.ts";
import { createProvider, type Provider } from "../models.ts";

export function openaiCodexProvider(): Provider<"openai-codex-responses"> {
	return createProvider<"openai-codex-responses">({
		id: "openai-codex",
		name: "OpenAI Codex",
		baseUrl: "https://chatgpt.com/backend-api",
		auth: {
			oauth: lazyOAuth({ name: "OpenAI (ChatGPT Plus/Pro)", load: loadOpenAICodexOAuth }),
		},
		models: [],
		api: openAICodexResponsesApi(),
	});
}
