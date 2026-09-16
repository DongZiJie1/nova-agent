/**
 * Recovery for providers that reject `max_tokens`.
 *
 * `maxTokens` in a model definition is the output cap of a single reply, but
 * nothing can check it against the endpoint's own limit: the number is written
 * by hand (models.json) or inherited from a catalog, and providers transmit it
 * verbatim. The Anthropic Messages adapter always sends `max_tokens`, so a
 * value the endpoint refuses fails the whole turn before a single token is
 * generated. The most common way to get there is copying `contextWindow` into
 * `maxTokens` (1000000 for a 1M-context model), but a value that merely exceeds
 * a model-specific cap does the same thing.
 *
 * Guessing a cap would be worse than failing, so read the number the provider
 * reports in its own error, retry once with it, and remember it for the rest of
 * the process: one wasted request per process instead of a broken conversation.
 *
 * Provider-specific patterns, with example error messages:
 *
 * - Z.AI (Anthropic-compatible):
 *   `400 {"type":"error","error":{"type":"invalid_request_error","code":"1210",
 *   "message":"[1210][max_tokens参数非法：限制数值范围[1,131072]]"}}`
 * - Anthropic:
 *   `max_tokens: 1000000 > 64000, which is the maximum allowed number of output tokens for claude-sonnet-4-5`
 * - Generic OpenAI-compatible gateways:
 *   `"max_tokens" must be less than or equal to 8192`
 */

/** Only act on errors that actually talk about the output cap. */
const MAX_TOKENS_MENTION = /max[_\s-]?tokens/i;

/**
 * Upper bound stated as a range, e.g. `[1, 131072]`. Requires a mention of
 * `max_tokens` first, so input-length ranges ("Range of input length should be
 * [1, 131072]", which DashScope returns on context overflow) are left alone.
 */
const RANGE_CAP = /\[\s*1\s*,\s*([\d,]{1,10})\s*\]/;

/** Comparison or prose form, e.g. "max_tokens: 1000000 > 64000" or "at most 8192". */
const COMPARISON_CAP =
	/max[_\s-]?tokens[^.\n]{0,40}?(?:>|<=|≤|less than or equal to|at most|no more than|must not exceed|maximum(?: allowed)?(?: value)?(?: is| of|:))\s*([\d,]{1,10})/i;

const CAP_PATTERNS = [RANGE_CAP, COMPARISON_CAP] as const;

/** Error text worth scanning, including the parsed body some SDKs keep separately. */
function providerErrorText(error: unknown): string {
	if (typeof error === "string") return error;
	if (!(error instanceof Error)) return "";
	const parts = [error.message];
	const body = (error as { error?: unknown }).error;
	if (typeof body === "string") parts.push(body);
	else if (body !== undefined && body !== null) {
		try {
			parts.push(JSON.stringify(body));
		} catch {
			// Circular or otherwise unserializable body: the message alone still applies.
		}
	}
	return parts.join(" ");
}

/**
 * The output cap a provider says it accepts, or undefined when the error does
 * not name one (or names one that would not help).
 */
export function extractMaxTokensCap(error: unknown, requestedMaxTokens: number): number | undefined {
	const text = providerErrorText(error);
	if (!MAX_TOKENS_MENTION.test(text)) return undefined;
	for (const pattern of CAP_PATTERNS) {
		const match = pattern.exec(text);
		if (!match?.[1]) continue;
		const cap = Number.parseInt(match[1].replace(/,/g, ""), 10);
		if (!Number.isFinite(cap) || cap <= 0 || cap >= requestedMaxTokens) continue;
		return cap;
	}
	return undefined;
}

/**
 * Learned caps are keyed per endpoint+model, because the same provider id can
 * point at different baseUrls and the same endpoint can cap models differently.
 */
export function maxTokensCapKey(model: { provider: string; id: string; baseUrl?: string }): string {
	return `${model.provider}:${model.baseUrl ?? ""}:${model.id}`;
}

const learnedCaps = new Map<string, number>();

/** Remember a cap the endpoint reported, keeping the smallest one seen. */
export function rememberMaxTokensCap(key: string, cap: number): void {
	const known = learnedCaps.get(key);
	if (known === undefined || cap < known) learnedCaps.set(key, cap);
}

/** Clamp an output cap to whatever this endpoint has already told us it accepts. */
export function clampMaxTokensToLearnedCap(key: string, maxTokens: number): number {
	const learned = learnedCaps.get(key);
	return learned === undefined ? maxTokens : Math.min(maxTokens, learned);
}

/** Test hook: forget every learned cap. */
export function resetMaxTokensCaps(): void {
	learnedCaps.clear();
}
