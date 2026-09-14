/**
 * In-memory model catalog for tests.
 *
 * Production ships no bundled models: every model a user can pick comes from
 * their own configuration (models.json) through `Models` / `ModelRuntime`. The
 * deprecated static-read helpers in compat read this registry instead, so tests
 * can install the few models they need without catalog data in the package.
 *
 * A fallback factory may synthesize a model for any (provider, id) so suites
 * that only need a model object as input do not have to enumerate fixtures.
 */
import { createModels, type MutableModels, type Provider } from "./models.ts";
import type { Api, Model } from "./types.ts";

export type FixtureModelFactory = (provider: string, id: string) => Model<Api> | undefined;

const models = new Map<string, Map<string, Model<Api>>>();
const providers = new Map<string, Provider>();
const providerModels: MutableModels = createModels();
let fallbackFactory: FixtureModelFactory | undefined;

/** Install a synthesizer used when a (provider, id) pair has no explicit fixture. */
export function setFixtureFallback(factory: FixtureModelFactory | undefined): void {
	fallbackFactory = factory;
}

/** Register explicit fixture models. */
export function registerFixtureModels(list: readonly Model<Api>[]): void {
	for (const model of list) {
		const bucket = models.get(model.provider) ?? new Map<string, Model<Api>>();
		bucket.set(model.id, model);
		models.set(model.provider, bucket);
	}
}

/** Register a fixture provider; used by tests that exercise compat routing. */
export function registerFixtureProvider(provider: Provider): void {
	providers.set(provider.id, provider);
	providerModels.setProvider(provider);
}

/** Drop every registered fixture model, provider, and the fallback factory. */
export function resetModelFixtures(): void {
	models.clear();
	providers.clear();
	providerModels.clearProviders();
	fallbackFactory = undefined;
}

/**
 * Look up a fixture model. Synthesizes one through the fallback factory when
 * available, and throws otherwise so a missing fixture fails loudly instead of
 * silently changing what a test exercises.
 */
export function getFixtureModel(provider: string, id: string): Model<Api> {
	const found = models.get(provider)?.get(id);
	if (found) return found;
	const synthesized = fallbackFactory?.(provider, id);
	if (synthesized) {
		registerFixtureModels([synthesized]);
		return synthesized;
	}
	throw new Error(
		`No fixture model for ${provider}/${id}. Register fixtures in the test setup (see test-fixtures/model-fixtures.ts).`,
	);
}

export function getFixtureModels(provider?: string): readonly Model<Api>[] {
	if (provider) return [...(models.get(provider)?.values() ?? [])];
	return [...models.values()].flatMap((bucket) => [...bucket.values()]);
}

export function getFixtureProviderIds(): string[] {
	return [...new Set([...providers.keys(), ...models.keys()])];
}

/** Registered fixture providers, for compat routing. */
export function getFixtureModelsCollection(): MutableModels {
	return providerModels;
}
