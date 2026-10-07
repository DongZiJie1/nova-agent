import { describe, expect, it } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { resolveWebSearchConfig, resolveWebSearchTimeoutMs } from "../src/core/search/config.ts";
import { decodeHtmlEntities, extractHtmlTitle, htmlToMarkdown } from "../src/core/search/html.ts";
import { readBodyTextWithLimit } from "../src/core/search/http.ts";
import { runWebSearch } from "../src/core/search/providers.ts";
import { createFetchUrlToolDefinition } from "../src/core/tools/fetch-url.ts";
import { createWebSearchToolDefinition } from "../src/core/tools/web-search.ts";

const ctx = { cwd: "/tmp/project", isProjectTrusted: () => false } as unknown as ExtensionContext;

function stubFetch(responder: (url: string, init?: RequestInit) => Response | Promise<Response>) {
	const calls: Array<{ url: string; init?: RequestInit }> = [];
	const fn = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		calls.push({ url, init });
		return responder(url, init);
	}) as typeof fetch;
	return { fn, calls };
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map((item) => (item.type === "text" ? (item.text ?? "") : "")).join("\n");
}

describe("web search config", () => {
	it("defaults to 360 (so.com) without an API key", () => {
		const config = resolveWebSearchConfig({ env: {}, settings: {} });
		expect(config.provider).toBe("so");
		expect(config.apiKey).toBeUndefined();
		expect(config.maxResults).toBe(5);
		expect(config.timeoutMs).toBe(20_000);
	});

	it("lets environment variables override settings.json", () => {
		const config = resolveWebSearchConfig({
			env: { NOVA_SEARCH_PROVIDER: "brave", BRAVE_API_KEY: "env-key", NOVA_SEARCH_MAX_RESULTS: "3" },
			settings: { provider: "bing", apiKey: "settings-key", maxResults: 9 },
		});
		expect(config.provider).toBe("brave");
		expect(config.apiKey).toBe("env-key");
		expect(config.maxResults).toBe(3);
	});

	it("falls back to provider-specific keys and urls", () => {
		const tavily = resolveWebSearchConfig({
			env: { NOVA_SEARCH_PROVIDER: "tavily", TAVILY_API_KEY: "tv" },
		});
		expect(tavily.apiKey).toBe("tv");
		const searxng = resolveWebSearchConfig({
			env: { NOVA_SEARCH_PROVIDER: "searxng", SEARXNG_URL: "https://searx.example" },
		});
		expect(searxng.baseUrl).toBe("https://searx.example");
	});

	it("rejects invalid providers and missing credentials", () => {
		expect(() => resolveWebSearchConfig({ env: { NOVA_SEARCH_PROVIDER: "nope" } })).toThrow(
			/Unknown search provider/,
		);
		expect(() => resolveWebSearchConfig({ env: { NOVA_SEARCH_PROVIDER: "tavily" } })).toThrow(/API key/);
		expect(() => resolveWebSearchConfig({ env: { NOVA_SEARCH_PROVIDER: "searxng" } })).toThrow(/base URL/);
	});

	it("clamps numeric limits", () => {
		const config = resolveWebSearchConfig({
			env: { NOVA_SEARCH_MAX_RESULTS: "99", NOVA_SEARCH_TIMEOUT_MS: "1" },
		});
		expect(config.maxResults).toBe(10);
		expect(config.timeoutMs).toBe(1_000);
	});

	it("resolves timeout without validating the provider", () => {
		expect(resolveWebSearchTimeoutMs({ env: {} })).toBe(20_000);
		expect(resolveWebSearchTimeoutMs({ env: { NOVA_SEARCH_TIMEOUT_MS: "1500" } })).toBe(1_500);
		// Missing brave key must not throw here — fetch_url depends only on timeout.
		expect(() => resolveWebSearchTimeoutMs({ env: { NOVA_SEARCH_PROVIDER: "brave" } })).not.toThrow();
	});
});

describe("html conversion", () => {
	it("converts structure and entities to markdown", () => {
		const html = `<html><head><title>Hello &amp; World</title><style>p{color:red}</style></head><body>
			<script>alert(1)</script>
			<h1>Article title</h1>
			<p>Some <b>bold</b> text &mdash; ok.</p>
			<ul><li>one</li><li>two</li></ul>
			<a href="/docs/start">Get started</a>
			<pre>const a = 1 &lt; 2;</pre>
		</body></html>`;
		const markdown = htmlToMarkdown(html, "https://example.com/page");
		expect(markdown).toContain("# Article title");
		expect(markdown).toContain("Some bold text — ok.");
		expect(markdown).toContain("- one");
		expect(markdown).toContain("[Get started](https://example.com/docs/start)");
		expect(markdown).toContain("const a = 1 < 2;");
		expect(markdown).not.toContain("alert(1)");
		expect(extractHtmlTitle(html)).toBe("Hello & World");
	});

	it("decodes named and numeric entities", () => {
		expect(decodeHtmlEntities("&amp;&#65;&#x42;&nbsp;done")).toBe("&AB done");
	});
});

describe("search providers", () => {
	it("parses 360 results and resolves so.com redirects", async () => {
		const searchHtml = `<ul class="result">
			<li class="res-list"><h3><a href="https://www.so.com/link?m=abc">招聘 - 智联招聘</a></h3><p class="res-desc">RL 工程师岗位</p></li>
			<li class="res-list"><h3><a href="https://example.com/direct">Direct result</a></h3></li>
		</ul>`;
		const { fn, calls } = stubFetch((url) => {
			if (url.startsWith("https://www.so.com/link")) {
				return new Response(`<script>window.location.replace("https://jobs.example/rl")</script>`, {
					status: 200,
				});
			}
			return new Response(searchHtml, { status: 200 });
		});
		const response = await runWebSearch("rl", { provider: "so", maxResults: 5, timeoutMs: 20_000 }, { fetch: fn });
		expect(calls[0].url).toContain("www.so.com/s");
		expect(calls[0].url).toContain("q=rl");
		expect(response.results).toEqual([
			{ title: "招聘 - 智联招聘", url: "https://jobs.example/rl", snippet: "RL 工程师岗位" },
			{ title: "Direct result", url: "https://example.com/direct", snippet: undefined },
		]);
	});

	it("parses DuckDuckGo HTML results and unwraps redirects", async () => {
		const html = `<div class="result results_links">
			<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fone&amp;rut=abc">First &amp; result</a>
			<a class="result__snippet" href="//duckduckgo.com/l/?uddg=x">Snippet one</a>
		</div>
		<div class="result results_links">
			<a rel="nofollow" class="result__a" href="https://example.org/two">Second result</a>
			<a class="result__snippet" href="#">Snippet two</a>
		</div>`;
		const { fn, calls } = stubFetch(() => new Response(html, { status: 200 }));
		const response = await runWebSearch(
			"rl jobs",
			{ provider: "duckduckgo", maxResults: 5, timeoutMs: 20_000 },
			{ fetch: fn },
		);
		expect(calls[0].url).toContain("html.duckduckgo.com/html/");
		expect(calls[0].url).toContain("q=rl+jobs");
		expect(response.results).toEqual([
			{ title: "First & result", url: "https://example.com/one", snippet: "Snippet one" },
			{ title: "Second result", url: "https://example.org/two", snippet: "Snippet two" },
		]);
	});

	it("parses Bing result blocks", async () => {
		const html = `<ol id="b_results">
			<li class="b_algo"><h2><a href="https://example.com/a">Title A</a></h2><p>Snippet A</p></li>
			<li class="b_algo"><h2><a href="https://example.com/b">Title B</a></h2></li>
		</ol>`;
		const { fn } = stubFetch(() => new Response(html, { status: 200 }));
		const response = await runWebSearch(
			"docs",
			{ provider: "bing", maxResults: 5, timeoutMs: 20_000 },
			{ fetch: fn },
		);
		expect(response.results).toEqual([
			{ title: "Title A", url: "https://example.com/a", snippet: "Snippet A" },
			{ title: "Title B", url: "https://example.com/b", snippet: undefined },
		]);
	});

	it("parses the Brave web search API", async () => {
		const payload = {
			web: {
				results: [
					{ title: "Brave One", url: "https://brave.example/1", description: "Desc one" },
					{ title: "Brave Two", url: "https://brave.example/2" },
				],
			},
		};
		const { fn, calls } = stubFetch(
			() => new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } }),
		);
		const response = await runWebSearch(
			"agent",
			{ provider: "brave", apiKey: "secret", maxResults: 5, timeoutMs: 20_000 },
			{ fetch: fn },
		);
		expect(calls[0].url).toContain("api.search.brave.com/res/v1/web/search");
		expect((calls[0].init?.headers as Record<string, string>)["x-subscription-token"]).toBe("secret");
		expect(response.results[0]).toEqual({
			title: "Brave One",
			url: "https://brave.example/1",
			snippet: "Desc one",
		});
	});

	it("posts to Tavily with the API key", async () => {
		const payload = { results: [{ title: "Tavily One", url: "https://tavily.example/1", content: "Content one" }] };
		const { fn, calls } = stubFetch(
			() => new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } }),
		);
		const response = await runWebSearch(
			"research",
			{ provider: "tavily", apiKey: "tv", maxResults: 5, timeoutMs: 20_000 },
			{ fetch: fn },
		);
		expect(calls[0].url).toBe("https://api.tavily.com/search");
		expect(calls[0].init?.method).toBe("POST");
		expect((calls[0].init?.headers as Record<string, string>).authorization).toBe("Bearer tv");
		expect(JSON.parse(String(calls[0].init?.body))).toMatchObject({ query: "research", max_results: 5 });
		expect(response.results[0].snippet).toBe("Content one");
	});

	it("reads SearXNG JSON results", async () => {
		const payload = { results: [{ title: "Searx One", url: "https://searx.example/1", content: "Searx content" }] };
		const { fn, calls } = stubFetch(
			() => new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } }),
		);
		const response = await runWebSearch(
			"query",
			{ provider: "searxng", baseUrl: "https://searx.example/", maxResults: 5, timeoutMs: 20_000 },
			{ fetch: fn },
		);
		expect(calls[0].url).toContain("https://searx.example/search");
		expect(calls[0].url).toContain("format=json");
		expect(response.results).toHaveLength(1);
	});

	it("surfaces provider HTTP failures", async () => {
		const { fn } = stubFetch(() => new Response("nope", { status: 401, statusText: "Unauthorized" }));
		await expect(
			runWebSearch("x", { provider: "brave", apiKey: "bad", maxResults: 5, timeoutMs: 20_000 }, { fetch: fn }),
		).rejects.toThrow(/HTTP 401.*API key/);
	});
});

describe("web tools", () => {
	it("web_search returns formatted results with provider details", async () => {
		const payload = {
			web: { results: [{ title: "RL Jobs", url: "https://jobs.example/rl", description: "3 new" }] },
		};
		const { fn } = stubFetch(
			() => new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } }),
		);
		const tool = createWebSearchToolDefinition({
			fetch: fn,
			resolveConfig: () => ({ provider: "brave", apiKey: "k", maxResults: 5, timeoutMs: 20_000 }),
		});
		const result = await tool.execute("t1", { query: "rl jobs" }, undefined, undefined, ctx);
		expect(result.details.status).toBe("ok");
		expect(result.details.results).toHaveLength(1);
		expect(textOf(result)).toContain("RL Jobs");
		expect(textOf(result)).toContain("https://jobs.example/rl");
	});

	it("web_search reports configuration errors instead of throwing", async () => {
		const tool = createWebSearchToolDefinition({
			resolveConfig: () => {
				throw new Error("Search provider 'tavily' requires an API key.");
			},
		});
		const result = await tool.execute("t1", { query: "x" }, undefined, undefined, ctx);
		expect(result.details.status).toBe("error");
		expect(textOf(result)).toContain("requires an API key");
	});

	it("fetch_url converts HTML to markdown", async () => {
		const html = `<html><head><title>Post title</title></head><body><h1>Heading</h1><p>Readable body</p></body></html>`;
		const { fn } = stubFetch(
			() => new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }),
		);
		const tool = createFetchUrlToolDefinition({ fetch: fn });
		const result = await tool.execute("t1", { url: "https://example.com/post" }, undefined, undefined, ctx);
		expect(result.details).toMatchObject({ status: "ok", title: "Post title", truncated: false });
		expect(textOf(result)).toContain("# Post title");
		expect(textOf(result)).toContain("Readable body");
	});

	it("fetch_url rejects unsupported protocols", async () => {
		const tool = createFetchUrlToolDefinition({ fetch: stubFetch(() => new Response("")).fn });
		const result = await tool.execute("t1", { url: "file:///etc/passwd" }, undefined, undefined, ctx);
		expect(result.details.status).toBe("error");
		expect(textOf(result)).toContain("http(s)");
	});

	it("fetch_url keeps working when the search provider is misconfigured", async () => {
		const previous = process.env.NOVA_SEARCH_PROVIDER;
		const previousKey = process.env.BRAVE_API_KEY;
		process.env.NOVA_SEARCH_PROVIDER = "brave";
		delete process.env.BRAVE_API_KEY;
		delete process.env.NOVA_SEARCH_API_KEY;
		try {
			const html = `<html><head><title>Still works</title></head><body><p>Body</p></body></html>`;
			const { fn } = stubFetch(() => new Response(html, { status: 200, headers: { "content-type": "text/html" } }));
			const tool = createFetchUrlToolDefinition({ fetch: fn });
			const result = await tool.execute("t1", { url: "https://example.com/post" }, undefined, undefined, ctx);
			expect(result.details.status).toBe("ok");
			expect(textOf(result)).toContain("# Still works");
		} finally {
			if (previous === undefined) delete process.env.NOVA_SEARCH_PROVIDER;
			else process.env.NOVA_SEARCH_PROVIDER = previous;
			if (previousKey !== undefined) process.env.BRAVE_API_KEY = previousKey;
		}
	});

	it("fetch_url rejects responses with a too-large Content-Length", async () => {
		const big = new Uint8Array(6 * 1024 * 1024);
		const { fn } = stubFetch(
			() =>
				new Response(big, {
					status: 200,
					headers: { "content-type": "text/html", "content-length": String(big.byteLength) },
				}),
		);
		const tool = createFetchUrlToolDefinition({ fetch: fn });
		const result = await tool.execute("t1", { url: "https://example.com/big" }, undefined, undefined, ctx);
		expect(result.details.status).toBe("error");
		expect(textOf(result)).toContain("too large");
	});

	it("fetch_url rejects chunked bodies that exceed the limit mid-stream", async () => {
		// No Content-Length: the limit must be enforced while reading, not by the header.
		const chunk = new Uint8Array(1024 * 1024);
		let sent = 0;
		const stream = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (sent >= 8 * 1024 * 1024) {
					controller.close();
					return;
				}
				controller.enqueue(chunk);
				sent += chunk.byteLength;
			},
		});
		const { fn } = stubFetch(() => new Response(stream, { status: 200, headers: { "content-type": "text/html" } }));
		const tool = createFetchUrlToolDefinition({ fetch: fn });
		const result = await tool.execute("t1", { url: "https://example.com/chunked" }, undefined, undefined, ctx);
		expect(result.details.status).toBe("error");
		expect(textOf(result)).toContain("too large");
	});
});

describe("readBodyTextWithLimit", () => {
	it("returns short bodies and preserves utf-8 text", async () => {
		const response = new Response("héllo 世界", { status: 200 });
		await expect(readBodyTextWithLimit(response, 1000)).resolves.toBe("héllo 世界");
	});

	it("aborts as soon as the streamed size crosses the limit", async () => {
		const chunk = new Uint8Array(64 * 1024);
		let reads = 0;
		const stream = new ReadableStream<Uint8Array>({
			pull(controller) {
				reads += 1;
				controller.enqueue(chunk);
			},
		});
		const response = new Response(stream, { status: 200 });
		await expect(readBodyTextWithLimit(response, 100 * 1024)).rejects.toThrow(/too large/);
		// 64KB chunks over a 100KB limit must stop at the second chunk, not drain the stream.
		expect(reads).toBeLessThanOrEqual(3);
	});
});
