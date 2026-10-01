/**
 * Dependency-free HTML → Markdown conversion for the built-in web tools.
 *
 * The model only needs readable text plus links, so this intentionally stays
 * small instead of pulling in a full DOM implementation. It handles the
 * structures that matter for articles and search results: headings, links,
 * lists, code blocks, line breaks, and HTML entities.
 */

const ENTITY_MAP: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
	mdash: "—",
	ndash: "–",
	hellip: "…",
	lsquo: "‘",
	rsquo: "’",
	ldquo: "“",
	rdquo: "”",
	middot: "·",
	laquo: "«",
	raquo: "»",
	copy: "©",
	reg: "®",
	trade: "™",
	times: "×",
	divide: "÷",
	plusmn: "±",
	deg: "°",
	euro: "€",
	pound: "£",
	yen: "¥",
	cent: "¢",
	sect: "§",
	para: "¶",
	bull: "•",
	minus: "−",
	frac12: "½",
};

const BLOCK_END_TAGS =
	"p|div|section|article|blockquote|tr|ul|ol|table|thead|tbody|h[1-6]|pre|dd|dt|dl|figure|figcaption|header|footer|main|nav|aside|form|fieldset";

/** Decode the common named entities plus numeric character references. */
export function decodeHtmlEntities(value: string): string {
	return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, entity: string) => {
		if (entity.startsWith("#")) {
			const hex = entity[1] === "x" || entity[1] === "X";
			const code = Number.parseInt(hex ? entity.slice(2) : entity.slice(1), hex ? 16 : 10);
			if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return match;
			try {
				return String.fromCodePoint(code);
			} catch {
				return match;
			}
		}
		return ENTITY_MAP[entity.toLowerCase()] ?? match;
	});
}

function stripTags(value: string): string {
	// Only strip real tags: a bare "< 2" comparison inside text or code must
	// survive (it must not swallow everything up to the next ">").
	return value.replace(/<\/?[a-zA-Z!][^>]*>/g, "");
}

function inlineText(value: string): string {
	return decodeHtmlEntities(stripTags(value)).replace(/\s+/g, " ").trim();
}

function resolveHref(href: string, baseUrl: string | undefined): string | undefined {
	const trimmed = decodeHtmlEntities(href).trim();
	if (!trimmed) return undefined;
	if (/^(?:javascript|mailto|tel|data):/i.test(trimmed)) return undefined;
	if (trimmed.startsWith("#")) return undefined;
	if (/^https?:/i.test(trimmed)) return trimmed;
	if (!baseUrl) return undefined;
	try {
		return new URL(trimmed, baseUrl).toString();
	} catch {
		return undefined;
	}
}

/** Extract the `<title>` of an HTML document, when present. */
export function extractHtmlTitle(html: string): string | undefined {
	const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
	const title = match ? inlineText(match[1]) : "";
	return title.length > 0 ? title : undefined;
}

/**
 * Convert an HTML document to Markdown-ish plain text.
 *
 * `baseUrl` (usually the final response URL) resolves relative links so the
 * model can cite absolute sources.
 */
export function htmlToMarkdown(html: string, baseUrl?: string): string {
	let text = html;
	text = text.replace(/<!--[\s\S]*?-->/g, "");
	text = text.replace(/<(script|style|noscript|template|svg|head)\b[^>]*>[\s\S]*?<\/\1>/gi, "");
	// Keep fenced code blocks before the generic block/tag stripping runs.
	text = text.replace(
		/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi,
		(_match, inner: string) => `\n\n\`\`\`\n${decodeHtmlEntities(stripTags(inner)).trim()}\n\`\`\`\n\n`,
	);
	text = text.replace(
		/<a\b[^>]*href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi,
		(_match, doubleQuoted: string, singleQuoted: string, bare: string, inner: string) => {
			const href = resolveHref(doubleQuoted ?? singleQuoted ?? bare ?? "", baseUrl);
			const label = inlineText(inner);
			if (!href) return label;
			if (!label) return href;
			return `[${label}](${href})`;
		},
	);
	for (let level = 1; level <= 6; level += 1) {
		const headingPattern = new RegExp(`<h${level}\\b[^>]*>([\\s\\S]*?)<\\/h${level}>`, "gi");
		text = text.replace(
			headingPattern,
			(_match, inner: string) => `\n\n${"#".repeat(level)} ${inlineText(inner)}\n\n`,
		);
	}
	text = text.replace(/<li\b[^>]*>/gi, "\n- ");
	text = text.replace(/<br\s*\/?>/gi, "\n");
	text = text.replace(/<hr\s*\/?>/gi, "\n\n---\n\n");
	text = text.replace(/<(td|th)\b[^>]*>/gi, " | ");
	const blockPattern = new RegExp(`</(?:${BLOCK_END_TAGS})\\s*>|</li\\s*>`, "gi");
	text = text.replace(blockPattern, "\n\n");
	text = stripTags(text);
	text = decodeHtmlEntities(text);
	text = text.replace(/\r\n?/g, "\n");
	text = text.replace(/[ \t\f\v]+/g, " ");
	text = text.replace(/ *\n */g, "\n");
	text = text.replace(/\n{3,}/g, "\n\n");
	return text.trim();
}
