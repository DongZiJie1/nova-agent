import { type Static, Type } from "typebox";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import { loadWebSearchSettings, resolveWebSearchConfig, type WebSearchConfig } from "../search/config.ts";
import { runWebSearch, type WebSearchResult } from "../search/providers.ts";

const webSearchSchema = Type.Object({
	query: Type.String({
		minLength: 1,
		description: "Search query; normal search operators like site: and quoted phrases work",
	}),
	count: Type.Optional(
		Type.Integer({ minimum: 1, maximum: 10, description: "Number of results to return (default from settings)" }),
	),
});

export type WebSearchInput = Static<typeof webSearchSchema>;

export interface WebSearchDetails {
	status: "ok" | "error";
	provider?: string;
	query?: string;
	results?: WebSearchResult[];
	error?: string;
}

export interface WebSearchToolOptions {
	/** Override fetch (tests). Defaults to global fetch, which honors proxy settings. */
	fetch?: typeof fetch;
	/** Override configuration resolution (tests). */
	resolveConfig?: (ctx: ExtensionContext) => WebSearchConfig;
}

function resolveConfig(ctx: ExtensionContext, options: WebSearchToolOptions): WebSearchConfig {
	return (
		options.resolveConfig?.(ctx) ??
		resolveWebSearchConfig({
			settings: loadWebSearchSettings({ cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted() }),
		})
	);
}

/**
 * Search the web with the configured provider and return titles, URLs, and
 * snippets. Read-only: the model can use it freely, then follow up with
 * fetch_url to read a promising page.
 */
export function createWebSearchToolDefinition(
	options: WebSearchToolOptions = {},
): ToolDefinition<typeof webSearchSchema, WebSearchDetails> {
	return {
		name: "web_search",
		label: "web_search",
		description:
			"Search the web for current information: news, releases, docs, prices, jobs, anything past the model's training data. Returns titles, URLs, and snippets — follow up with fetch_url to read a promising result, and cite the source URLs you used. 360 (so.com) is the default provider and needs no API key; duckduckgo/bing/brave/tavily/searxng can be configured in settings.",
		promptSnippet: "Search the web and return titles, URLs, and snippets.",
		promptGuidelines: [
			"Use web_search when the answer depends on information newer than your training data, or when you are unsure about current facts.",
			"Cite the source URLs behind web-sourced claims instead of presenting them without attribution.",
			"Follow up with fetch_url when a snippet is not enough; do not invent page contents that no tool returned.",
			"No need to ask before a read-only search; just use it when the task needs current information.",
		],
		parameters: webSearchSchema,
		executionMode: "parallel",
		async execute(_toolCallId, input, signal, _onUpdate, ctx) {
			try {
				const config = resolveConfig(ctx, options);
				const count = Math.min(Math.max(input.count ?? config.maxResults, 1), 10);
				const response = await runWebSearch(
					input.query,
					{ ...config, maxResults: count },
					{
						fetch: options.fetch,
						signal,
					},
				);
				const lines = response.results.map((result, index) => {
					const parts = [`${index + 1}. ${result.title}`, `   URL: ${result.url}`];
					if (result.snippet) parts.push(`   ${result.snippet}`);
					return parts.join("\n");
				});
				const text = [
					`Web search for "${response.query}" (provider: ${response.provider}, ${response.results.length} results):`,
					"",
					...lines,
				].join("\n");
				return {
					content: [{ type: "text" as const, text }],
					details: {
						status: "ok" as const,
						provider: response.provider,
						query: response.query,
						results: response.results,
					},
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					content: [{ type: "text" as const, text: `Error: ${message}` }],
					details: { status: "error" as const, error: message },
				};
			}
		},
	};
}
