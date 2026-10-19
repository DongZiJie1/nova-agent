/**
 * 运行时接入：把记忆服务挂到真实会话上。
 *
 * `main.ts` 的 `createRuntime` 在会话建好后调用 `startMemoryForSession`，因此 CLI / TUI / print / RPC
 * 走同一条装配路径。装配本身只做三件事：解析设置、用会话模型构造抽取调用、创建服务；
 * 服务是否真正注册钩子仍由 `MemoryService.start()` 决定（关闭记忆时它自己跳过）。
 *
 * 抽取请求沿用当前会话的模型与鉴权：`session.model` 为空（还没选模型）时无法抽取，直接返回 undefined，
 * 让调用方按"功能不可用"处理，而不是等到第一次空闲才发现。
 *
 * `startMemoryCompensation` 是同一批装配的启动侧入口，给 `main.ts` 留一个不阻塞启动的调用点。
 */

import type { Api, Model } from "@dongzijie1/pi-ai/compat";
import type { AgentSession } from "../agent-session.ts";
import { lifecycleHooks } from "../lifecycle-hooks.ts";
import type { SettingsManager } from "../settings-manager.ts";
import { type CompletionAuth, createExtractionCompletion } from "./fact-completion.ts";
import type { ExtractionCompletion } from "./fact-extraction.ts";
import { FactStore } from "./fact-store.ts";
import { runStartupCompensation, runStartupReview } from "./memory-compensation.ts";
import { MemoryService } from "./memory-service.ts";
import type { ResolvedMemorySettings } from "./memory-settings.ts";

/**
 * 已装配过的会话 → 服务。同一会话重复装配返回首次创建的服务实例。
 * 用弱引用是因为 runtime 重建会换新的会话对象，旧会话应可被回收。
 */
const startedServices = new WeakMap<AgentSession, MemoryService>();

/**
 * `getAuth` 的 headers 允许 null（表示去掉该头），抽取请求只保留有值的项。
 * 就地过滤而不是断言，避免把 null 传给 provider 的 header 合并逻辑。
 */
function stringHeaders(headers: Record<string, string | null> | undefined): Record<string, string> | undefined {
	if (headers === undefined) return undefined;
	const result: Record<string, string> = {};
	for (const [name, value] of Object.entries(headers)) {
		if (typeof value === "string") result[name] = value;
	}
	return result;
}

/** 解析会话当前的模型鉴权，形状与 `CompletionAuth` 对齐。 */
async function resolveCompletionAuth(session: AgentSession, model: Model<Api>): Promise<CompletionAuth> {
	const resolved = await session.modelRuntime.getAuth(model);
	return {
		apiKey: resolved?.auth.apiKey,
		headers: stringHeaders(resolved?.auth.headers),
		env: resolved?.env,
	};
}

/**
 * 用会话模型构造抽取调用；`session.model` 为空时返回 undefined。
 * 模型在创建时固定：一次抽取的提示词与鉴权都指向同一模型，不会因为会话中途切换模型而错配。
 */
export function createMemoryCompletion(
	session: AgentSession,
	settings: ResolvedMemorySettings,
): ExtractionCompletion | undefined {
	const model = session.model;
	if (model === undefined) return undefined;
	return createExtractionCompletion({
		model,
		timeoutMs: settings.extraction.timeoutMs,
		resolveAuth: () => resolveCompletionAuth(session, model),
	});
}

/**
 * 为会话构造记忆服务，调用方负责 `start()`。
 * 记忆关闭、事实关闭、抽取关闭或没有可用模型时返回 undefined。
 */
export function createMemoryServiceForSession(options: {
	session: AgentSession;
	agentDir: string;
	cwd: string;
	settingsManager: SettingsManager;
	store?: FactStore;
	settings?: ResolvedMemorySettings;
}): MemoryService | undefined {
	const settings = options.settings ?? options.settingsManager.getMemorySettings();
	// 与 MemoryService.start() 的守卫保持一致：关闭的记忆不该留下一个永远不工作的服务对象。
	if (!settings.enabled || !settings.facts.enabled || !settings.extraction.enabled) return undefined;
	const complete = createMemoryCompletion(options.session, settings);
	if (complete === undefined) return undefined;
	return new MemoryService({
		agentDir: options.agentDir,
		cwd: options.cwd,
		session: options.session,
		settings,
		store: options.store ?? new FactStore(options.agentDir),
		complete,
	});
}

/**
 * 为会话创建并启动记忆服务；同一会话只创建一次，重复调用返回首次创建的服务。
 * 返回 undefined 表示这次会话不该启用记忆抽取。
 */
export function startMemoryForSession(
	options: Parameters<typeof createMemoryServiceForSession>[0],
): MemoryService | undefined {
	const existing = startedServices.get(options.session);
	if (existing !== undefined) return existing;
	const service = createMemoryServiceForSession(options);
	if (service === undefined) return undefined;
	startedServices.set(options.session, service);
	service.start();
	return service;
}

export interface MemoryCompensationWiringOptions {
	session: AgentSession;
	agentDir: string;
	sessionDir: string;
	settingsManager: SettingsManager;
	store?: FactStore;
	settings?: ResolvedMemorySettings;
	maxSessions?: number;
	onDiagnostic?: (message: string) => void;
}

/**
 * 启动补偿入口：扫一遍历史会话并补抽被强杀会话的尾巴。
 *
 * 包装掉"解析设置 → 用当前会话模型构造抽取调用 → 建事实库"这三步，调用方只需一行。
 * 永远不抛错，也永远不阻塞启动：拿不到设置或模型就直接返回，扫描与抽取失败只记日志。
 * 扫描本身每个 `sessionDir` 每进程只做一次（见 `runStartupCompensation`）；
 * 会话结束时取消还在跑的补偿，避免一次性命令为后台请求等待退出。
 */
export async function startMemoryCompensation(options: MemoryCompensationWiringOptions): Promise<void> {
	const settings = options.settings ?? options.settingsManager.getMemorySettings();
	// 关闭记忆时不必扫描：即使扫出候选，runExtraction 也只会被同一批开关挡住。
	if (!settings.enabled || !settings.facts.enabled || !settings.extraction.enabled) return;
	const complete = createMemoryCompletion(options.session, settings);
	if (complete === undefined) return;
	// 让出同步栈：扫描是同步文件 I/O，不能卡在 createRuntime 的返回路径上。
	await new Promise<void>((resolve) => setImmediate(resolve));

	const controller = new AbortController();
	const unsubscribe = lifecycleHooks.register("session_end", {
		name: "memory-compensation",
		timeoutMs: 1000,
		handler: (context) => {
			if (context.session === options.session) controller.abort();
		},
	});
	const store = options.store ?? new FactStore(options.agentDir);
	try {
		await runStartupCompensation({
			agentDir: options.agentDir,
			sessionDir: options.sessionDir,
			settings,
			store,
			complete,
			maxSessions: options.maxSessions,
			onDiagnostic: options.onDiagnostic,
			signal: controller.signal,
		});
		// 补偿完成后补一次全量评审：没有候选时不调用模型，每进程只跑一次。
		await runStartupReview({
			agentDir: options.agentDir,
			settings,
			store,
			complete,
			signal: controller.signal,
			onDiagnostic: options.onDiagnostic,
		});
	} catch (error) {
		console.error("[memory:startup]", error);
	} finally {
		unsubscribe();
	}
}
