import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { listModels } from "../src/cli/list-models.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { InMemoryCodingAgentModelsStore } from "../src/core/models-store.ts";

describe("ModelRuntime.getModelCatalog", () => {
	let tempDir: string;
	let modelsJsonPath: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-test-model-catalog-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		modelsJsonPath = join(tempDir, "models.json");
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true });
		vi.restoreAllMocks();
	});

	function writeModelsJson(providers: Record<string, unknown>) {
		writeFileSync(modelsJsonPath, JSON.stringify({ providers }));
	}

	async function createRuntime(path: string | null) {
		return ModelRuntime.create({ modelsPath: path, modelsStore: new InMemoryCodingAgentModelsStore() });
	}

	test("lists only providers and models declared in models.json", async () => {
		writeModelsJson({
			deepseek: {
				api: "openai-completions",
				baseUrl: "https://api.deepseek.com",
				apiKey: "test-key",
				models: [
					{
						id: "deepseek-flash",
						name: "DeepSeek Flash",
						reasoning: true,
						input: ["text", "image"],
						contextWindow: 1_048_576,
						maxTokens: 384_000,
					},
				],
			},
		});

		const runtime = await createRuntime(modelsJsonPath);
		const catalog = runtime.getModelCatalog();

		expect(catalog.providers.map((provider) => provider.provider)).toEqual(["deepseek"]);
		expect(catalog.providers[0].models).toHaveLength(1);
		// Exact values survive: no "1M"/"384K" text round-trip.
		expect(catalog.providers[0].models[0]).toMatchObject({
			id: "deepseek-flash",
			name: "DeepSeek Flash",
			contextWindow: 1_048_576,
			maxTokens: 384_000,
			reasoning: true,
			input: ["text", "image"],
		});
	});

	test("excludes built-in providers the user never configured", async () => {
		writeModelsJson({
			deepseek: {
				api: "openai-completions",
				baseUrl: "https://api.deepseek.com",
				apiKey: "test-key",
				models: [{ id: "deepseek-flash" }],
			},
		});

		const runtime = await createRuntime(modelsJsonPath);
		const providerIds = runtime.getModelCatalog().providers.map((provider) => provider.provider);

		expect(providerIds).toEqual(["deepseek"]);
		expect(providerIds).not.toContain("anthropic");
		expect(providerIds).not.toContain("openai");
	});

	test("keeps a configured provider with no models so the UI can add some", async () => {
		writeModelsJson({
			"my-proxy": { api: "openai-completions", baseUrl: "https://proxy.test/v1", apiKey: "test-key" },
		});

		const runtime = await createRuntime(modelsJsonPath);
		const catalog = runtime.getModelCatalog();

		expect(catalog.providers).toHaveLength(1);
		expect(catalog.providers[0]).toMatchObject({ provider: "my-proxy", models: [] });
	});

	test("a models.json entry replacing a built-in model keeps the fields it omits", async () => {
		const builtinRuntime = await createRuntime(null);
		const builtin = builtinRuntime.getModels("anthropic")[0];
		expect(builtin).toBeDefined();

		writeModelsJson({ anthropic: { models: [{ id: builtin.id }] } });

		const runtime = await createRuntime(modelsJsonPath);
		const replaced = runtime.getModels("anthropic").find((model) => model.id === builtin.id);

		expect(replaced).toBeDefined();
		expect(replaced?.contextWindow).toBe(builtin.contextWindow);
		expect(replaced?.maxTokens).toBe(builtin.maxTokens);
		expect(replaced?.name).toBe(builtin.name);
		expect(replaced?.input).toEqual(builtin.input);
	});
});

describe("listModels --json", () => {
	test("prints the catalog as JSON without any table formatting", async () => {
		const tempDir = join(tmpdir(), `pi-test-list-models-json-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		const modelsJsonPath = join(tempDir, "models.json");
		writeFileSync(
			modelsJsonPath,
			JSON.stringify({
				providers: {
					deepseek: {
						api: "openai-completions",
						baseUrl: "https://api.deepseek.com",
						apiKey: "test-key",
						models: [{ id: "deepseek-flash", contextWindow: 1_048_576, maxTokens: 384_000 }],
					},
				},
			}),
		);

		const runtime = await ModelRuntime.create({
			modelsPath: modelsJsonPath,
			modelsStore: new InMemoryCodingAgentModelsStore(),
		});
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		try {
			await listModels(runtime, undefined, { json: true });

			expect(log).toHaveBeenCalledTimes(1);
			const output = String(log.mock.calls[0][0]);
			expect(output).not.toContain("max-out");
			const parsed = JSON.parse(output);
			expect(parsed).toEqual(runtime.getModelCatalog());
			expect(parsed.providers[0].models[0].contextWindow).toBe(1_048_576);
		} finally {
			rmSync(tempDir, { recursive: true });
		}
	});
});
