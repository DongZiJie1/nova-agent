import type { WebSearchConfig, WebSearchProvider } from "./config.ts";
import { decodeHtmlEntities } from "./html.ts";
import { DESKTOP_USER_AGENT, requestSignal } from "./http.ts";

/** One web search hit. */
export interface WebSearchResult {
	title: string;
	url: string;
	snippet?: string;
}

export interface WebSearchResponse {
	provider: WebSearchProvider;
	query: string;
	results: WebSearchResult[];
}

export interface WebSearchRunOptions {
	/** Override fetch (tests). Defaults to global fetch, which honors proxy settings. */
	fetch?: typeof fetch;
	signal?: AbortSignal;
}

function collapseText(value: string): string {
	// Highlights arrive as inline tags (<em>/<strong>); drop them without
	// inserting spaces so CJK words stay intact.
	return decodeHtmlEntities(value.replace(/<[^>]*>/g, ""))
		.replace(/\s+/g, " ")
		.trim();
}

function statusHint(status: number): string {
	if (status === 401 || status === 403) return " (check the API key)";
	if (status === 429) return " (rate limited; retry later)";
	return "";
}

async function resolveSo360Target(
	url: string,
	fetchImpl: typeof fetch,
	signal: AbortSignal,
): Promise<string | undefined> {
	try {
		const response = await fetchImpl(url, {
			headers: { "user-agent": DESKTOP_USER_AGENT },
			redirect: "follow",
			signal,
		});
		if (!response.ok) return undefined;
		const body = await response.text();
		const scriptTarget = /window\.location\.replace\(\s*["']([^"']+)["']\s*\)/i.exec(body);
		if (scriptTarget) return scriptTarget[1];
		const meta = /<meta[^>]*http-equiv=["']?refresh["']?[^>]*>/i.exec(body);
		if (meta) {
			const target = /url=([^"'\s>]+)/i.exec(meta[0]);
			if (target) return decodeHtmlEntities(target[1]);
		}
		return undefined;
	} catch {
		return undefined;
	}
}

async function searchSo360(
	query: string,
	config: WebSearchConfig,
	fetchImpl: typeof fetch,
	signal: AbortSignal,
): Promise<WebSearchResult[]> {
	const url = new URL("https://www.so.com/s");
	url.searchParams.set("q", query);
	const response = await fetchImpl(url, {
		headers: {
			"user-agent": DESKTOP_USER_AGENT,
			accept: "text/html,application/xhtml+xml",
			"accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
		},
		redirect: "follow",
		signal,
	});
	if (!response.ok) {
		throw new Error(`360 search failed: HTTP ${response.status}${statusHint(response.status)}`);
	}
	const html = (await response.text())
		.replace(/<style[\s\S]*?<\/style>/gi, "")
		.replace(/<script[\s\S]*?<\/script>/gi, "");
	const parsed: WebSearchResult[] = [];
	const blockPattern = /<li[^>]*class="([^"]*\bres-list\b[^"]*)"[^>]*>([\s\S]*?)<\/li>/gi;
	for (const match of html.matchAll(blockPattern)) {
		if (/res-list-ad|(^|\s)ad(\s|$)/i.test(match[1])) continue;
		const block = match[2];
		const heading = /<h3[^>]*>([\s\S]*?)<\/h3>/i.exec(block);
		if (!heading) continue;
		const link = /<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(heading[1]);
		if (!link) continue;
		const href = decodeHtmlEntities(link[1]).trim();
		const title = collapseText(link[2]);
		if (!title || !/^https?:/i.test(href)) continue;
		const snippetMatch =
			/<p[^>]*class="[^"]*res-desc[^"]*"[^>]*>([\s\S]*?)<\/p>/i.exec(block) ??
			/<p[^>]*>([\s\S]*?)<\/p>/i.exec(block);
		parsed.push({
			title,
			url: href,
			snippet: snippetMatch ? collapseText(snippetMatch[1]) || undefined : undefined,
		});
		if (parsed.length >= config.maxResults) break;
	}
	if (parsed.length === 0) {
		throw new Error("360 search returned no parseable results; try a different provider or retry later.");
	}
	// 360 wraps outbound results in so.com/link redirects that resolve through a
	// tiny JavaScript page; resolve them so citations point at the real source.
	return await Promise.all(
		parsed.map(async (result) => {
			if (!/^https?:\/\/(?:www\.)?so\.com\/link\?/i.test(result.url)) return result;
			const target = await resolveSo360Target(result.url, fetchImpl, signal);
			return target ? { ...result, url: target } : result;
		}),
	);
}

function normalizeDuckDuckGoUrl(href: string): string | undefined {
	const decoded = decodeHtmlEntities(href);
	const isRedirect = decoded.startsWith("//duckduckgo.com/l/") || decoded.startsWith("https://duckduckgo.com/l/");
	if (!isRedirect) {
		return /^https?:/i.test(decoded) ? decoded : undefined;
	}
	try {
		const url = new URL(decoded.startsWith("//") ? `https:${decoded}` : decoded);
		return url.searchParams.get("uddg") ?? undefined;
	} catch {
		return undefined;
	}
}

async function searchDuckDuckGo(
	query: string,
	config: WebSearchConfig,
	fetchImpl: typeof fetch,
	signal: AbortSignal,
): Promise<WebSearchResult[]> {
	const url = new URL("https://html.duckduckgo.com/html/");
	url.searchParams.set("q", query);
	const response = await fetchImpl(url, {
		headers: {
			"user-agent": DESKTOP_USER_AGENT,
			accept: "text/html,application/xhtml+xml",
			"accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
		},
		redirect: "follow",
		signal,
	});
	if (!response.ok) {
		throw new Error(`DuckDuckGo search failed: HTTP ${response.status}${statusHint(response.status)}`);
	}
	const html = await response.text();
	// Each result carries its own snippet in the markup after the title link.
	const blockPattern =
		/<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>([\s\S]*?)(?=<a[^>]*class="[^"]*result__a|$)/gi;
	const results: WebSearchResult[] = [];
	for (const match of html.matchAll(blockPattern)) {
		const target = normalizeDuckDuckGoUrl(match[1]);
		const title = collapseText(match[2]);
		if (!target || !title) continue;
		const snippetMatch = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i.exec(match[3]);
		results.push({
			title,
			url: target,
			snippet: snippetMatch ? collapseText(snippetMatch[1]) || undefined : undefined,
		});
		if (results.length >= config.maxResults) break;
	}
	if (results.length === 0) {
		throw new Error(
			"DuckDuckGo returned no parseable results (it may be rate limiting or blocked on this network). " +
				"Retry later, or switch providers with NOVA_SEARCH_PROVIDER=so|bing|brave|tavily|searxng.",
		);
	}
	return results;
}

async function searchBing(
	query: string,
	config: WebSearchConfig,
	fetchImpl: typeof fetch,
	signal: AbortSignal,
): Promise<WebSearchResult[]> {
	const url = new URL("https://www.bing.com/search");
	url.searchParams.set("q", query);
	url.searchParams.set("count", String(config.maxResults));
	const response = await fetchImpl(url, {
		headers: {
			"user-agent": DESKTOP_USER_AGENT,
			accept: "text/html,application/xhtml+xml",
			"accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
		},
		redirect: "follow",
		signal,
	});
	if (!response.ok) {
		throw new Error(`Bing search failed: HTTP ${response.status}${statusHint(response.status)}`);
	}
	const html = await response.text();
	const results: WebSearchResult[] = [];
	const blockPattern = /<li[^>]*class="[^"]*\bb_algo\b[^"]*"[^>]*>([\s\S]*?)<\/li>/gi;
	for (const match of html.matchAll(blockPattern)) {
		const block = match[1];
		const linkMatch = /<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
		if (!linkMatch) continue;
		const href = decodeHtmlEntities(linkMatch[1]).trim();
		const title = collapseText(linkMatch[2]);
		if (!/^https?:/i.test(href) || !title) continue;
		const snippetMatch = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(block);
		results.push({
			title,
			url: href,
			snippet: snippetMatch ? collapseText(snippetMatch[1]) || undefined : undefined,
		});
		if (results.length >= config.maxResults) break;
	}
	if (results.length === 0) {
		throw new Error("Bing returned no parseable results; try a different provider or retry later.");
	}
	return results;
}

async function searchBrave(
	query: string,
	config: WebSearchConfig,
	fetchImpl: typeof fetch,
	signal: AbortSignal,
): Promise<WebSearchResult[]> {
	const url = new URL("https://api.search.brave.com/res/v1/web/search");
	url.searchParams.set("q", query);
	url.searchParams.set("count", String(config.maxResults));
	const response = await fetchImpl(url, {
		headers: {
			accept: "application/json",
			"x-subscription-token": config.apiKey ?? "",
		},
		signal,
	});
	if (!response.ok) {
		throw new Error(`Brave search failed: HTTP ${response.status}${statusHint(response.status)}`);
	}
	const payload = (await response.json()) as {
		web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
	};
	const results: WebSearchResult[] = [];
	for (const item of payload.web?.results ?? []) {
		const title = collapseText(item.title ?? "");
		const target = (item.url ?? "").trim();
		if (!title || !/^https?:/i.test(target)) continue;
		results.push({ title, url: target, snippet: collapseText(item.description ?? "") || undefined });
		if (results.length >= config.maxResults) break;
	}
	if (results.length === 0) {
		throw new Error("Brave returned no results for this query.");
	}
	return results;
}

async function searchTavily(
	query: string,
	config: WebSearchConfig,
	fetchImpl: typeof fetch,
	signal: AbortSignal,
): Promise<WebSearchResult[]> {
	const response = await fetchImpl("https://api.tavily.com/search", {
		method: "POST",
		headers: {
			accept: "application/json",
			"content-type": "application/json",
			authorization: `Bearer ${config.apiKey ?? ""}`,
		},
		body: JSON.stringify({
			query,
			max_results: config.maxResults,
			search_depth: "basic",
			include_answer: false,
			include_raw_content: false,
		}),
		signal,
	});
	if (!response.ok) {
		throw new Error(`Tavily search failed: HTTP ${response.status}${statusHint(response.status)}`);
	}
	const payload = (await response.json()) as {
		results?: Array<{ title?: string; url?: string; content?: string }>;
	};
	const results: WebSearchResult[] = [];
	for (const item of payload.results ?? []) {
		const title = collapseText(item.title ?? "");
		const target = (item.url ?? "").trim();
		if (!title || !/^https?:/i.test(target)) continue;
		results.push({ title, url: target, snippet: collapseText(item.content ?? "") || undefined });
		if (results.length >= config.maxResults) break;
	}
	if (results.length === 0) {
		throw new Error("Tavily returned no results for this query.");
	}
	return results;
}

async function searchSearxng(
	query: string,
	config: WebSearchConfig,
	fetchImpl: typeof fetch,
	signal: AbortSignal,
): Promise<WebSearchResult[]> {
	const base = (config.baseUrl ?? "").replace(/\/+$/, "");
	const url = new URL(`${base}/search`);
	url.searchParams.set("q", query);
	url.searchParams.set("format", "json");
	const response = await fetchImpl(url, {
		headers: { accept: "application/json" },
		signal,
	});
	if (!response.ok) {
		throw new Error(
			`SearXNG search failed: HTTP ${response.status}${statusHint(response.status)} (the instance must allow the JSON output format)`,
		);
	}
	const payload = (await response.json()) as {
		results?: Array<{ title?: string; url?: string; content?: string }>;
	};
	const results: WebSearchResult[] = [];
	for (const item of payload.results ?? []) {
		const title = collapseText(item.title ?? "");
		const target = (item.url ?? "").trim();
		if (!title || !/^https?:/i.test(target)) continue;
		results.push({ title, url: target, snippet: collapseText(item.content ?? "") || undefined });
		if (results.length >= config.maxResults) break;
	}
	if (results.length === 0) {
		throw new Error("SearXNG returned no results for this query.");
	}
	return results;
}

/** Run a web search with the configured provider. */
export async function runWebSearch(
	query: string,
	config: WebSearchConfig,
	options: WebSearchRunOptions = {},
): Promise<WebSearchResponse> {
	const trimmed = query.trim();
	if (!trimmed) throw new Error("web_search requires a non-empty query");
	const fetchImpl = options.fetch ?? fetch;
	const signal = requestSignal(options.signal, config.timeoutMs);

	const results = await (() => {
		switch (config.provider) {
			case "so":
				return searchSo360(trimmed, config, fetchImpl, signal);
			case "duckduckgo":
				return searchDuckDuckGo(trimmed, config, fetchImpl, signal);
			case "bing":
				return searchBing(trimmed, config, fetchImpl, signal);
			case "brave":
				return searchBrave(trimmed, config, fetchImpl, signal);
			case "tavily":
				return searchTavily(trimmed, config, fetchImpl, signal);
			case "searxng":
				return searchSearxng(trimmed, config, fetchImpl, signal);
		}
	})();

	return { provider: config.provider, query: trimmed, results };
}
