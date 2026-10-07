import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getSettingsPath } from "../../config.ts";

/** Providers supported by the built-in web_search tool. */
export type WebSearchProvider = "so" | "duckduckgo" | "bing" | "brave" | "tavily" | "searxng";

export const WEB_SEARCH_PROVIDERS: readonly WebSearchProvider[] = [
	"so",
	"duckduckgo",
	"bing",
	"brave",
	"tavily",
	"searxng",
];

/**
 * 360 (so.com) needs no key and stays reachable on Chinese networks where
 * DuckDuckGo/Bing results are blocked or degraded. Switch with
 * NOVA_SEARCH_PROVIDER when another provider fits better.
 */
export const DEFAULT_SEARCH_PROVIDER: WebSearchProvider = "so";
export const DEFAULT_SEARCH_MAX_RESULTS = 5;
export const DEFAULT_SEARCH_TIMEOUT_MS = 20_000;

const MAX_RESULTS_LIMIT = 10;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 60_000;

/** `search` section of settings.json (global or trusted project settings). */
export interface WebSearchSettings {
	provider?: string;
	apiKey?: string;
	baseUrl?: string;
	maxResults?: number;
	timeoutMs?: number;
}

export interface WebSearchConfig {
	provider: WebSearchProvider;
	apiKey?: string;
	baseUrl?: string;
	maxResults: number;
	timeoutMs: number;
}

function isWebSearchProvider(value: string): value is WebSearchProvider {
	return (WEB_SEARCH_PROVIDERS as readonly string[]).includes(value);
}

function firstString(...values: Array<string | undefined>): string | undefined {
	for (const value of values) {
		const trimmed = value?.trim();
		if (trimmed) return trimmed;
	}
	return undefined;
}

function parseInteger(value: unknown, fallback: number, min: number, max: number): number {
	const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : Number.NaN;
	if (!Number.isFinite(parsed)) return fallback;
	return Math.min(Math.max(Math.floor(parsed), min), max);
}

/**
 * Resolve the per-request timeout only. Unlike {@link resolveWebSearchConfig}
 * this never validates the provider — `fetch_url` needs a timeout but must keep
 * working when the search provider is misconfigured (missing API key, etc.).
 */
export function resolveWebSearchTimeoutMs(
	options: { env?: Record<string, string | undefined>; settings?: WebSearchSettings } = {},
): number {
	const env = options.env ?? process.env;
	const settings = options.settings ?? {};
	return parseInteger(
		env.NOVA_SEARCH_TIMEOUT_MS ?? settings.timeoutMs,
		DEFAULT_SEARCH_TIMEOUT_MS,
		MIN_TIMEOUT_MS,
		MAX_TIMEOUT_MS,
	);
}

/**
 * Resolve the effective search configuration.
 *
 * Precedence: environment variables > settings.json values > defaults. The
 * loader merges global settings with trusted project settings, so project
 * values win over the global file.
 */
export function resolveWebSearchConfig(
	options: { env?: Record<string, string | undefined>; settings?: WebSearchSettings } = {},
): WebSearchConfig {
	const env = options.env ?? process.env;
	const settings = options.settings ?? {};

	const rawProvider = (
		firstString(env.NOVA_SEARCH_PROVIDER, settings.provider) ?? DEFAULT_SEARCH_PROVIDER
	).toLowerCase();
	if (!isWebSearchProvider(rawProvider)) {
		throw new Error(
			`Unknown search provider '${rawProvider}'. Supported providers: ${WEB_SEARCH_PROVIDERS.join(", ")}.`,
		);
	}
	const provider = rawProvider;

	// Provider-specific env vars keep single-provider setups zero-config.
	const providerApiKeyEnv =
		provider === "brave" ? env.BRAVE_API_KEY : provider === "tavily" ? env.TAVILY_API_KEY : undefined;
	const apiKey = firstString(env.NOVA_SEARCH_API_KEY, providerApiKeyEnv, settings.apiKey);
	const providerBaseUrlEnv = provider === "searxng" ? env.SEARXNG_URL : undefined;
	const baseUrl = firstString(env.NOVA_SEARCH_BASE_URL, providerBaseUrlEnv, settings.baseUrl);

	if ((provider === "brave" || provider === "tavily") && !apiKey) {
		const keyEnv = provider === "brave" ? "BRAVE_API_KEY" : "TAVILY_API_KEY";
		throw new Error(
			`Search provider '${provider}' requires an API key. Set ${keyEnv} (or NOVA_SEARCH_API_KEY), ` +
				`or add "search": { "apiKey": "..." } to settings.json.`,
		);
	}
	if (provider === "searxng" && !baseUrl) {
		throw new Error(
			"Search provider 'searxng' requires a base URL. Set SEARXNG_URL (or NOVA_SEARCH_BASE_URL), " +
				'or add "search": { "baseUrl": "https://..." } to settings.json.',
		);
	}

	return {
		provider,
		apiKey,
		baseUrl,
		maxResults: parseInteger(
			env.NOVA_SEARCH_MAX_RESULTS ?? settings.maxResults,
			DEFAULT_SEARCH_MAX_RESULTS,
			1,
			MAX_RESULTS_LIMIT,
		),
		timeoutMs: resolveWebSearchTimeoutMs({ env, settings }),
	};
}

function readJsonObject(path: string): Record<string, unknown> | undefined {
	try {
		if (!existsSync(path)) return undefined;
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
		return parsed as Record<string, unknown>;
	} catch {
		// Malformed settings are reported by SettingsManager; search falls back
		// to defaults instead of blocking tool use.
		return undefined;
	}
}

/**
 * Read the `search` section from global settings, then trusted project
 * settings (project values override global ones).
 */
export function loadWebSearchSettings(options: { cwd?: string; projectTrusted?: boolean } = {}): WebSearchSettings {
	const candidates = [getSettingsPath()];
	if (options.cwd && options.projectTrusted) {
		candidates.push(join(options.cwd, CONFIG_DIR_NAME, "settings.json"));
	}

	const merged: WebSearchSettings = {};
	for (const path of candidates) {
		const parsed = readJsonObject(path);
		const search = parsed?.search;
		if (search && typeof search === "object" && !Array.isArray(search)) {
			Object.assign(merged, search);
		}
	}
	return merged;
}
