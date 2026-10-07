/** Shared HTTP helpers for the built-in web tools. */

export const DESKTOP_USER_AGENT =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/** Combine the caller's abort signal with a per-request timeout. */
export function requestSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
	const timeout = AbortSignal.timeout(timeoutMs);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function tooLargeError(sizeKb: number): Error {
	return new Error(`Response is too large (${sizeKb} KB); fetch a more specific URL instead.`);
}

/**
 * Read a response body as text, refusing to buffer more than `maxBytes`.
 *
 * `response.text()` loads the entire body first, so a chunked response with no
 * `Content-Length` would bypass a header-only size check. This walks the stream
 * and aborts as soon as the limit is crossed. Decoding is UTF-8 to match
 * `Response.text()`.
 */
export async function readBodyTextWithLimit(response: Response, maxBytes: number): Promise<string> {
	const declaredLength = Number(response.headers.get("content-length") ?? Number.NaN);
	if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
		throw tooLargeError(Math.round(declaredLength / 1000));
	}

	if (!response.body) return "";

	const reader = response.body.getReader();
	const decoder = new TextDecoder("utf-8");
	const parts: string[] = [];
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > maxBytes) {
				throw tooLargeError(Math.round(total / 1000));
			}
			parts.push(decoder.decode(value, { stream: true }));
		}
		parts.push(decoder.decode());
		return parts.join("");
	} catch (error) {
		await reader.cancel().catch(() => undefined);
		throw error;
	}
}
