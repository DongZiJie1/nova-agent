# Web search

Nova ships two built-in tools for working with the live web:

- `web_search` — search the web and return titles, URLs, and snippets.
- `fetch_url` — fetch one http(s) URL and return it as Markdown (HTML is converted, JSON is pretty-printed, output is capped).

Together they let Nova answer with current information instead of guessing: search first, fetch the pages that matter, then cite the source URLs.

## Quick start

Just ask in a session:

```
搜索一下 2026 年上海的强化学习工程师岗位，总结招聘要求和公司
```

Nova calls `web_search`, reads the top results, and (when needed) follows up with `fetch_url` on the most promising links.

## Providers

| Provider | Key required | Notes |
|----------|--------------|-------|
| `so` (default) | no | 360 搜索 (so.com). Reaches Chinese networks where DuckDuckGo is blocked; redirect links are resolved to the real result URLs. |
| `bing` | no | Bing HTML results. |
| `duckduckgo` | no | DuckDuckGo HTML results; blocked on some networks. |
| `brave` | yes | Brave Search API (`X-Subscription-Token`). |
| `tavily` | yes | Tavily Search API; snippets include page text. |
| `searxng` | self-hosted | Any SearXNG instance with the JSON output format enabled. |

The scraping providers (`so`, `bing`, `duckduckgo`) can rate-limit or change markup; the API providers are more stable when you search a lot.

## Configuration

Configuration lives in the `search` section of `settings.json` — global `~/.nova/agent/settings.json`, or a trusted project's `.nova/settings.json`:

```json
{
  "search": {
    "provider": "brave",
    "apiKey": "BSA...",
    "baseUrl": "https://searx.example",
    "maxResults": 5,
    "timeoutMs": 20000
  }
}
```

Environment variables override `settings.json`:

| Variable | Description |
|----------|-------------|
| `NOVA_SEARCH_PROVIDER` | `so` \| `duckduckgo` \| `bing` \| `brave` \| `tavily` \| `searxng` |
| `NOVA_SEARCH_API_KEY` | API key for `brave` / `tavily` |
| `NOVA_SEARCH_BASE_URL` | Base URL for `searxng` |
| `NOVA_SEARCH_MAX_RESULTS` | Results to request, 1–10 (default 5) |
| `NOVA_SEARCH_TIMEOUT_MS` | Per-request timeout, 1000–60000 ms (default 20000) |
| `BRAVE_API_KEY` / `TAVILY_API_KEY` / `SEARXNG_URL` | Provider-specific fallbacks |

## Permissions and safety

- `web_search` is read-only and auto-approved like `read`/`grep`: only the query leaves the machine.
- `fetch_url` follows the normal permission mode — it prompts in `ask` / `edits` mode and runs freely in `allow` mode. Unattended automations that need to read pages should run with permission mode `allow`.
- Fetched pages are untrusted data. The tool guidelines tell the model to ignore instructions found inside pages and to cite sources instead of inventing them.
- Downloads are capped (5 MB) and returned text is capped (20 000 characters by default, configurable per call with `maxChars`) so one page cannot flood the context.

## Limitations

- JavaScript-rendered SPAs may return little readable text; fetch the underlying API or choose another source.
- Long pages end with a `[... truncated to N characters]` marker; fetch a more specific URL for the rest.
- On networks where the scraping providers are blocked or rate-limited, configure `brave`/`tavily` or a self-hosted `searxng` instance.
