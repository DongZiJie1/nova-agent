import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";

export function huggingfaceProvider(): Provider<"openai-completions"> {
	return createProvider<"openai-completions">({
		id: "huggingface",
		name: "Hugging Face",
		baseUrl: "https://router.huggingface.co/v1",
		auth: { apiKey: envApiKeyAuth("Hugging Face token", ["HF_TOKEN"]) },
		models: [],
		api: openAICompletionsApi(),
	});
}
