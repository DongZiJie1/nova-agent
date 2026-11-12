import { describe, expect, it } from "vitest";
import {
	estimateMemoryTokens,
	factSimilarity,
	factTextHash,
	factTokens,
	normalizeFactText,
	truncateFactText,
} from "../../src/core/memory/fact-text.ts";

describe("normalizeFactText", () => {
	it("converts full-width characters to half-width", () => {
		expect(normalizeFactText("ＡＢＣ１２３")).toBe("abc123");
	});

	it("collapses whitespace and trims the ends", () => {
		expect(normalizeFactText("  tab\t缩进   and\n\n行宽 ")).toBe("tab 缩进 and 行宽");
	});

	it("keeps already normalized text stable", () => {
		const normalized = normalizeFactText("使用 tab 缩进");
		expect(normalizeFactText(normalized)).toBe(normalized);
	});
});

describe("factTokens", () => {
	it("emits both single characters and adjacent bigrams for CJK text", () => {
		const tokens = factTokens("换车");
		expect(tokens).toContain("换");
		expect(tokens).toContain("车");
		expect(tokens).toContain("换车");
	});

	it("splits mixed Chinese and ASCII text and normalizes case", () => {
		const tokens = factTokens("把 MODEL 换成 gpt-4");
		expect(tokens).toContain("model");
		expect(tokens).toContain("gpt-4");
		expect(tokens).toContain("换");
		expect(tokens).toContain("换成");
		expect(tokens).not.toContain("MODEL");
	});

	it("deduplicates tokens while keeping first-seen order", () => {
		const tokens = factTokens("换车换车");
		expect(new Set(tokens).size).toBe(tokens.length);
		expect(tokens[0]).toBe("换");
		expect(tokens).toContain("车换");
	});

	it("returns an empty list for blank text", () => {
		expect(factTokens("   ")).toEqual([]);
	});

	it("does not produce bigrams across a non-CJK boundary", () => {
		const tokens = factTokens("换 tab 车");
		expect(tokens).toContain("换");
		expect(tokens).toContain("车");
		expect(tokens).not.toContain("换车");
	});
});

describe("factSimilarity", () => {
	it("returns 1 for identical text", () => {
		expect(factSimilarity("使用 tab 缩进", "使用   TAB 缩进")).toBe(1);
	});

	it("returns 0 when token sets do not intersect", () => {
		expect(factSimilarity("换车", "database migration")).toBe(0);
	});

	it("returns 0 when one side is empty", () => {
		expect(factSimilarity("", "")).toBe(0);
		expect(factSimilarity("换车", "   ")).toBe(0);
	});

	it("returns a fraction between 0 and 1 for near-duplicate text", () => {
		const score = factSimilarity("项目使用 tab 缩进，行宽 120", "项目使用 tab 缩进，行宽 100");
		expect(score).toBeGreaterThan(0);
		expect(score).toBeLessThan(1);
	});
});

describe("factTextHash", () => {
	it("hashes normalized text so casing and whitespace do not matter", () => {
		expect(factTextHash(" 使用 TAB 缩进 ")).toBe(factTextHash("使用 tab   缩进"));
	});

	it("differs for different text and yields a sha1 hex digest", () => {
		const digest = factTextHash("使用 tab 缩进");
		expect(digest).toMatch(/^[0-9a-f]{40}$/);
		expect(digest).not.toBe(factTextHash("使用空格缩进"));
	});
});

describe("estimateMemoryTokens", () => {
	it("counts one token per CJK character", () => {
		expect(estimateMemoryTokens("一二三四五六七八九十")).toBe(10);
	});

	it("counts four non-CJK characters per token, rounding up", () => {
		expect(estimateMemoryTokens("hello world!")).toBe(3);
		expect(estimateMemoryTokens("abc")).toBe(1);
	});

	it("adds both parts for mixed text", () => {
		expect(estimateMemoryTokens("中文abc")).toBe(3);
	});

	it("returns 0 for empty text", () => {
		expect(estimateMemoryTokens("")).toBe(0);
	});
});

describe("truncateFactText", () => {
	it("returns text unchanged when it fits exactly", () => {
		const text = "一二三四五";
		expect(truncateFactText(text, 5)).toBe(text);
		expect(truncateFactText(text, 6)).toBe(text);
	});

	it("truncates with an ellipsis without exceeding the limit", () => {
		const truncated = truncateFactText("一二三四五六七八九十", 5);
		expect(truncated).toBe("一二三四…");
		expect(Array.from(truncated).length).toBeLessThanOrEqual(5);
	});

	it("handles degenerate limits", () => {
		expect(truncateFactText("一二三", 0)).toBe("");
		expect(truncateFactText("一二三", 1)).toBe("…");
	});

	it("does not split surrogate pairs", () => {
		const truncated = truncateFactText("😀😀😀😀", 3);
		expect(truncated).toBe("😀😀…");
		expect(Array.from(truncated).length).toBe(3);
	});
});
