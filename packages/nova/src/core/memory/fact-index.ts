import type { Fact, FactKind } from "./fact-schema.ts";
import { factTokens } from "./fact-text.ts";

/** BM25 词频饱和参数。 */
const BM25_K1 = 1.2;
/** BM25 文档长度归一化参数。 */
const BM25_B = 0.75;
const DEFAULT_SEARCH_LIMIT = 8;
const MAX_SEARCH_LIMIT = 20;

export interface FactSearchHit {
	fact: Fact;
	score: number;
}

export interface FactSearchOptions {
	limit?: number;
	kinds?: FactKind[];
	since?: string;
	includeArchived?: boolean;
}

export interface FactIndexOptions {
	/** 单次 `search` 允许的最大 limit，默认 `MAX_SEARCH_LIMIT`；选择器据此放宽到候选上限。 */
	maxLimit?: number;
}

interface IndexedDocument {
	fact: Fact;
	/** 文档 token 数，用于 BM25 长度归一化。 */
	length: number;
}

function resolveMaxLimit(value: number | undefined): number {
	if (value === undefined || !Number.isFinite(value)) return MAX_SEARCH_LIMIT;
	return Math.max(1, Math.floor(value));
}

function clampLimit(value: number | undefined, maxLimit: number): number {
	if (value === undefined || !Number.isFinite(value)) return Math.min(DEFAULT_SEARCH_LIMIT, maxLimit);
	return Math.min(maxLimit, Math.max(0, Math.floor(value)));
}

function parseOptionalTime(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const parsed = Date.parse(value);
	return Number.isNaN(parsed) ? undefined : parsed;
}

function timeValue(iso: string): number {
	const parsed = Date.parse(iso);
	return Number.isNaN(parsed) ? 0 : parsed;
}

function matchesFilters(
	fact: Fact,
	kinds: Set<FactKind> | undefined,
	since: number | undefined,
	includeArchived: boolean,
): boolean {
	if (!includeArchived && (fact.archivedAt !== undefined || fact.supersededBy !== undefined)) return false;
	if (kinds !== undefined && !kinds.has(fact.kind)) return false;
	if (since !== undefined) {
		const createdAt = Date.parse(fact.createdAt);
		if (Number.isNaN(createdAt) || createdAt < since) return false;
	}
	return true;
}

/** 分数降序；同分时更新时间新的在前，再按创建时间与 id 保证顺序稳定。 */
function compareHits(left: FactSearchHit, right: FactSearchHit): number {
	if (right.score !== left.score) return right.score - left.score;
	const updated = timeValue(right.fact.updatedAt) - timeValue(left.fact.updatedAt);
	if (updated !== 0) return updated;
	const created = timeValue(right.fact.createdAt) - timeValue(left.fact.createdAt);
	if (created !== 0) return created;
	if (left.fact.id === right.fact.id) return 0;
	return left.fact.id < right.fact.id ? -1 : 1;
}

export class FactIndex {
	private readonly postings: Map<string, Map<number, number>>;
	private readonly documents: IndexedDocument[];
	private readonly averageLength: number;
	private readonly maxLimit: number;

	constructor(facts: Fact[], options: FactIndexOptions = {}) {
		this.postings = new Map();
		this.documents = [];
		this.maxLimit = resolveMaxLimit(options.maxLimit);
		let totalLength = 0;
		for (const fact of facts) {
			const tokens = factTokens(fact.text);
			const termFrequency = new Map<string, number>();
			for (const token of tokens) termFrequency.set(token, (termFrequency.get(token) ?? 0) + 1);
			const documentId = this.documents.length;
			this.documents.push({ fact, length: tokens.length });
			totalLength += tokens.length;
			for (const [token, frequency] of termFrequency) {
				let posting = this.postings.get(token);
				if (posting === undefined) {
					posting = new Map();
					this.postings.set(token, posting);
				}
				posting.set(documentId, frequency);
			}
		}
		this.averageLength = this.documents.length === 0 ? 0 : totalLength / this.documents.length;
	}

	search(query: string, options: FactSearchOptions = {}): FactSearchHit[] {
		const queryTokens = factTokens(query);
		const limit = clampLimit(options.limit, this.maxLimit);
		if (queryTokens.length === 0 || limit === 0) return [];

		const kinds =
			options.kinds !== undefined && options.kinds.length > 0 ? new Set<FactKind>(options.kinds) : undefined;
		const since = parseOptionalTime(options.since);
		const includeArchived = options.includeArchived === true;
		const averageLength = this.averageLength === 0 ? 1 : this.averageLength;
		const scores = new Map<number, number>();

		for (const token of queryTokens) {
			const posting = this.postings.get(token);
			if (posting === undefined) continue;
			const idf = Math.log(1 + (this.documents.length - posting.size + 0.5) / (posting.size + 0.5));
			for (const [documentId, frequency] of posting) {
				const document = this.documents[documentId];
				if (!matchesFilters(document.fact, kinds, since, includeArchived)) continue;
				const denominator = frequency + BM25_K1 * (1 - BM25_B + (BM25_B * document.length) / averageLength);
				const contribution = idf * ((frequency * (BM25_K1 + 1)) / denominator);
				scores.set(documentId, (scores.get(documentId) ?? 0) + contribution);
			}
		}

		const hits: FactSearchHit[] = [];
		for (const [documentId, score] of scores) hits.push({ fact: this.documents[documentId].fact, score });
		hits.sort(compareHits);
		return hits.slice(0, limit);
	}
}
