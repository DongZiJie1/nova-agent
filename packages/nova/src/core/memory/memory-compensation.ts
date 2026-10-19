/**
 * 启动补偿：补抽被强杀、断电或应急退出会话的尾巴。
 *
 * 进程启动时扫一遍会话目录，找出"有消息但没有抽取标记，或标记之后还有消息"的非活跃会话，
 * 用 `SessionManager.open` 打开后复用 `runExtraction` 补抽；当前版本不改写已有条目，
 * 版本过旧时会走既有的会话迁移逻辑（与恢复旧会话一致）。
 *
 * 三条不变量：
 * - 只追加自定义标记条目，已有消息条目原样保留。
 * - 单个会话失败只通过 `onDiagnostic` 记录并继续，绝不向启动路径抛错。
 * - 同一 `sessionDir` 每进程只扫一次，避免每次新建会话都重复付出扫描与模型调用。
 */

import { type Dirent, readdirSync, type Stats, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { SessionEntry } from "../session-manager.ts";
import { loadEntriesFromFile, SessionManager } from "../session-manager.ts";
import { hasLiveSessionOwner } from "../session-records.ts";
import type { ExtractionCompletion } from "./fact-extraction.ts";
import type { FactStore } from "./fact-store.ts";
import { readExtractionMarker, selectPendingEntries } from "./memory-marker.ts";
import { reviewFacts } from "./memory-review.ts";
import { runExtraction } from "./memory-service.ts";
import type { ResolvedMemorySettings } from "./memory-settings.ts";
import { SuggestionStore } from "./suggestion-store.ts";

/** 每次启动单目录默认最多补抽的会话数。 */
const DEFAULT_MAX_SESSIONS = 20;
/** 补偿写入事实的 model 标签，便于事后区分事实是启动补偿产生的。 */
const STARTUP_MODEL_LABEL = "startup";
/** 已跑过补偿的会话目录；同一进程内每个目录只扫一次。 */
const compensatedDirs = new Set<string>();
/** 启动全量评审每进程只跑一次：它扫的是全库，与具体会话目录无关。 */
let startupReviewDone = false;

export interface CompensationCandidate {
	sessionFile: string;
	lastActivityAt: string;
	pendingMessages: number;
}

export interface StartupCompensationResult {
	processed: number;
	created: number;
	failed: number;
}

interface ScannedSession {
	candidate: CompensationCandidate;
	mtimeMs: number;
}

/** 递归收集 `.jsonl` 会话文件；`.record.json` 与 `.active.<pid>.json` 后缀不同，天然被排除。 */
function collectSessionFiles(directory: string, files: string[]): void {
	let entries: Dirent[];
	try {
		entries = readdirSync(directory, { withFileTypes: true });
	} catch {
		// 目录不存在或不可读；补偿是可选的，静默跳过。
		return;
	}
	for (const entry of entries) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			collectSessionFiles(path, files);
			continue;
		}
		if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path);
	}
}

/**
 * 判断单个会话是否需要补抽。
 * 非空却解析不出任何条目 → 视为损坏文件并保留为候选，让 `runStartupCompensation` 把它记成失败；
 * `SessionManager.open` 会拒绝打开这类文件。只有头部、没有消息的会话照常跳过。
 */
function scanSession(sessionFile: string): ScannedSession | undefined {
	let stats: Stats;
	try {
		stats = statSync(sessionFile);
	} catch {
		return undefined;
	}
	const loaded = loadEntriesFromFile(sessionFile);
	const entries: SessionEntry[] = loaded.filter((entry) => entry.type !== "session");
	const pending = selectPendingEntries(entries, readExtractionMarker({ getEntries: () => entries }));
	const unreadable = loaded.length === 0 && stats.size > 0;
	if (pending.length === 0 && !unreadable) return undefined;
	return {
		candidate: {
			sessionFile,
			lastActivityAt: new Date(stats.mtimeMs).toISOString(),
			pendingMessages: pending.length,
		},
		mtimeMs: stats.mtimeMs,
	};
}

/**
 * 列出需要补抽的会话，按文件修改时间倒序，最多 `maxSessions` 个（默认 20）。
 * 有活跃归属标记（还有别的进程开着）的会话跳过。
 */
export function findSessionsNeedingExtraction(options: {
	sessionDir: string;
	maxSessions?: number;
}): CompensationCandidate[] {
	const limit = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
	if (!(limit > 0)) return [];
	// 没有会话目录（`--no-session` 的内存会话）时无从扫描：空字符串会被解析成工作目录，
	// 把普通 .jsonl 文件当会话读，只会得到一堆假失败。
	if (options.sessionDir === "") return [];

	const files: string[] = [];
	collectSessionFiles(options.sessionDir, files);

	const scanned: ScannedSession[] = [];
	for (const sessionFile of files) {
		if (hasLiveSessionOwner(sessionFile)) continue;
		try {
			const result = scanSession(sessionFile);
			if (result !== undefined) scanned.push(result);
		} catch {
			// 单个文件读失败不影响其余会话；下次启动会重新尝试。
		}
	}

	// 最近的会话优先：一次启动的预算不该花在很久没动的历史文件上。
	scanned.sort((left, right) => right.mtimeMs - left.mtimeMs);
	return scanned.slice(0, limit).map((item) => item.candidate);
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * 对候选会话逐个补抽，返回处理数、新建事实数、失败数。
 *
 * `agentDir` 与 `store` 指向同一目录（`FactStore` 的路径固定为 `<agentDir>/memory/facts.json`），
 * 保留该参数是为了与共享契约的签名一致。
 *
 * `signal` 取消后立即停止处理后续会话（进行中的抽取由 `runExtraction` 透传给模型调用）；
 * 取消不算失败，也不写诊断，用于会话结束时不让一次性命令为后台请求等待。
 */
export async function runStartupCompensation(options: {
	agentDir: string;
	sessionDir: string;
	settings: ResolvedMemorySettings;
	store: FactStore;
	complete: ExtractionCompletion;
	maxSessions?: number;
	onDiagnostic?: (message: string) => void;
	signal?: AbortSignal;
}): Promise<StartupCompensationResult> {
	const result: StartupCompensationResult = { processed: 0, created: 0, failed: 0 };
	const key = resolve(options.sessionDir);
	if (compensatedDirs.has(key)) return result;
	// 先登记再扫描：即使中途失败，也不该在同一个进程里重复付出一次启动开销。
	compensatedDirs.add(key);

	const diagnose = options.onDiagnostic ?? ((message: string) => console.error("[memory:startup]", message));

	let candidates: CompensationCandidate[];
	try {
		candidates = findSessionsNeedingExtraction({
			sessionDir: options.sessionDir,
			maxSessions: options.maxSessions,
		});
	} catch (error) {
		result.failed += 1;
		diagnose(`scan failed: ${describeError(error)}`);
		return result;
	}

	for (const candidate of candidates) {
		// 会话已经结束就不该再开新任务，否则一次性命令会为后台请求继续等待。
		if (options.signal?.aborted) break;
		try {
			const manager = SessionManager.open(candidate.sessionFile);
			const extraction = await runExtraction({
				manager,
				settings: options.settings,
				store: options.store,
				complete: options.complete,
				cwd: manager.getCwd(),
				modelLabel: STARTUP_MODEL_LABEL,
				signal: options.signal,
			});
			result.processed += 1;
			result.created += extraction.created;
		} catch (error) {
			// 主动取消不算失败，也不再继续后面的会话。
			if (options.signal?.aborted) break;
			result.failed += 1;
			diagnose(`${candidate.sessionFile}: ${describeError(error)}`);
		}
	}

	return result;
}

export interface StartupReviewOptions {
	agentDir: string;
	settings: ResolvedMemorySettings;
	store: FactStore;
	complete: ExtractionCompletion;
	signal?: AbortSignal;
	onDiagnostic?: (message: string) => void;
}

/**
 * 启动补偿之后的全量评审：把历史会话留下、尚未评审的事实补评审一遍，
 * 被强杀的会话产生的未评审事实由这条路径兜住。
 *
 * 与补偿一样永远不抛错、不阻塞启动：每进程只跑一次；
 * 取消（会话已结束）或失败只记诊断，状态不写，留给下次启动重试。
 */
export async function runStartupReview(options: StartupReviewOptions): Promise<void> {
	if (startupReviewDone || options.signal?.aborted) return;
	startupReviewDone = true;
	const diagnose = options.onDiagnostic ?? ((message: string) => console.error("[memory:startup]", message));
	try {
		const result = await reviewFacts({
			agentDir: options.agentDir,
			// 评审只读事实库与画像，不依赖当前项目目录；保留该字段与共享签名一致。
			cwd: options.agentDir,
			settings: options.settings,
			store: options.store,
			suggestions: new SuggestionStore(options.agentDir),
			complete: options.complete,
			scope: { type: "all" },
			signal: options.signal,
		});
		if (result.failed > 0) diagnose(`review failed for ${result.failed} candidate(s)`);
	} catch (error) {
		diagnose(`review failed: ${describeError(error)}`);
	}
}
