import { createHash } from "node:crypto";
import { basename } from "node:path";
import type { Fact } from "./fact-schema.ts";

const CJK_CHAR = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/;
const ASCII_TOKEN_CHAR = /[a-z0-9_.-]/;

function isCjkChar(char: string): boolean {
	return CJK_CHAR.test(char);
}

export function normalizeFactText(text: string): string {
	return text.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

export function factTokens(text: string): string[] {
	const tokens: string[] = [];
	const seen = new Set<string>();
	const push = (token: string): void => {
		if (token.length === 0 || seen.has(token)) return;
		seen.add(token);
		tokens.push(token);
	};
	let ascii = "";
	let cjk: string[] = [];
	const flushAscii = (): void => {
		if (ascii.length > 0) push(ascii);
		ascii = "";
	};
	const flushCjk = (): void => {
		for (let index = 0; index < cjk.length; index += 1) {
			push(cjk[index]);
			if (index + 1 < cjk.length) push(cjk[index] + cjk[index + 1]);
		}
		cjk = [];
	};
	for (const char of normalizeFactText(text)) {
		if (isCjkChar(char)) {
			flushAscii();
			cjk.push(char);
			continue;
		}
		if (ASCII_TOKEN_CHAR.test(char)) {
			flushCjk();
			ascii += char;
			continue;
		}
		flushAscii();
		flushCjk();
	}
	flushAscii();
	flushCjk();
	return tokens;
}

export function factSimilarity(a: string, b: string): number {
	const left = new Set(factTokens(a));
	const right = new Set(factTokens(b));
	if (left.size === 0 || right.size === 0) return 0;
	if (normalizeFactText(a) === normalizeFactText(b)) return 1;
	let intersection = 0;
	for (const token of left) {
		if (right.has(token)) intersection += 1;
	}
	const union = left.size + right.size - intersection;
	return union === 0 ? 0 : intersection / union;
}

export function factTextHash(text: string): string {
	return createHash("sha1").update(normalizeFactText(text)).digest("hex");
}

export function estimateMemoryTokens(text: string): number {
	if (text.length === 0) return 0;
	let cjkCount = 0;
	let otherCount = 0;
	for (const char of text) {
		if (isCjkChar(char)) cjkCount += 1;
		else otherCount += 1;
	}
	return cjkCount + Math.ceil(otherCount / 4);
}

export function truncateFactText(text: string, maxChars: number): string {
	if (maxChars <= 0) return "";
	const chars = Array.from(text);
	if (chars.length <= maxChars) return text;
	if (maxChars === 1) return "…";
	return `${chars
		.slice(0, maxChars - 1)
		.join("")
		.trimEnd()}…`;
}

/**
 * 单条事实的注入行。预算估算与最终注入都走这里，保证两者逐字符一致。
 * 调用方负责截断 `text`，这里不做二次截断。
 */
export function renderFactLine(fact: Fact, text?: string): string {
	let scope: string = fact.applicability;
	if (fact.applicability === "transferable" && fact.originProject !== undefined) {
		scope = `transferable(from ${basename(fact.originProject.path)})`;
	} else if (fact.applicability === "project" && fact.projects !== undefined && fact.projects.length > 0) {
		scope = `project:${fact.projects[0]}`;
	}
	return `- [${fact.id}] ${fact.createdAt.slice(0, 10)} · ${scope} · ${fact.kind} · imp ${fact.importance} · ${text ?? fact.text}`;
}
