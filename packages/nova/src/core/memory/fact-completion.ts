/**
 * 抽取的模型调用适配：把 `fact-extraction` 的 `complete` 注入点接到真实模型。
 *
 * 每次调用都是独立请求：独立 `sessionId`、不写 prompt cache、不重试、不解析 JSON。
 * 成功只返回拼接后的文本；`stopReason` 为 error/aborted、超时或外部取消时抛错，
 * 记录与重试都由上层决定。
 */

import type { StreamFn } from "@dongzijie1/pi-agent-core";
import { contentText, uuidv7 } from "@dongzijie1/pi-ai";
import type { Api, AssistantMessage, Context, Model, SimpleStreamOptions } from "@dongzijie1/pi-ai/compat";
import { completeSimple } from "@dongzijie1/pi-ai/compat";
import type { ExtractionCompletion } from "./fact-extraction.ts";

export interface CompletionAuth {
	apiKey?: string;
	headers?: Record<string, string>;
	env?: Record<string, string>;
}

export interface CreateExtractionCompletionOptions {
	model: Model<Api>;
	streamFn?: StreamFn;
	resolveAuth: () => Promise<CompletionAuth>;
	timeoutMs: number;
}

/** 抽取结果是一段 JSON，1024 输出 token 足够，与主对话预算无关。 */
const EXTRACTION_MAX_TOKENS = 1024;

function abortedError(): Error {
	return new Error("Memory extraction aborted");
}

function timeoutError(): Error {
	return new Error("Memory extraction timed out");
}

function requestContext(systemPrompt: string, userPrompt: string): Context {
	return {
		systemPrompt,
		messages: [{ role: "user", content: [{ type: "text", text: userPrompt }], timestamp: Date.now() }],
	};
}

/** 只把 error/aborted 当失败；stop/length 等交给上层解析文本。 */
function stopReasonError(response: AssistantMessage): Error | undefined {
	if (response.stopReason === "aborted") return abortedError();
	if (response.stopReason === "error") {
		return new Error(`Memory extraction failed: ${response.errorMessage || "Unknown error"}`);
	}
	return undefined;
}

/**
 * 构造 `ExtractionCompletion`：默认走 `completeSimple`，测试可注入 `streamFn`。
 * 鉴权在请求前解析一次；超时与外部取消都不依赖 provider 是否支持 signal。
 */
export function createExtractionCompletion(options: CreateExtractionCompletionOptions): ExtractionCompletion {
	const { model, streamFn, resolveAuth, timeoutMs } = options;

	const send = async (context: Context, auth: CompletionAuth, signal: AbortSignal): Promise<AssistantMessage> => {
		const requestOptions: SimpleStreamOptions = {
			// 抽取请求之间无法复用前缀缓存：隔离路由，并明确关闭缓存写入。
			cacheRetention: "none",
			sessionId: uuidv7(),
			maxTokens: EXTRACTION_MAX_TOKENS,
			signal,
			apiKey: auth.apiKey,
			headers: auth.headers,
			env: auth.env,
		};
		if (!streamFn) return completeSimple(model, context, requestOptions);
		const stream = await streamFn(model, context, requestOptions);
		return stream.result();
	};

	return async (input) => {
		if (input.signal?.aborted) throw abortedError();

		const auth = await resolveAuth();
		// 鉴权期间可能被取消，注册监听前再确认一次。
		if (input.signal?.aborted) throw abortedError();

		const external = input.signal;
		const controller = new AbortController();
		const forwardAbort = () => controller.abort();
		external?.addEventListener("abort", forwardAbort, { once: true });

		const request = send(requestContext(input.systemPrompt, input.userPrompt), auth, controller.signal);

		let timedOut = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(() => {
				timedOut = true;
				controller.abort();
				reject(timeoutError());
			}, timeoutMs);
		});

		// provider 不一定响应 signal，外部取消时让 race 直接结束等待。
		let rejectAbort: (error: Error) => void;
		const aborted = new Promise<never>((_, reject) => {
			rejectAbort = reject;
		});
		const onAbort = () => rejectAbort(abortedError());
		external?.addEventListener("abort", onAbort, { once: true });

		try {
			const response = await Promise.race([request, timeout, aborted]);
			const failure = stopReasonError(response);
			if (failure) throw failure;
			return contentText(response.content);
		} catch (error) {
			// abort 与超时可能同拍到达，统一报超时。
			if (timedOut) throw timeoutError();
			throw error;
		} finally {
			if (timer !== undefined) clearTimeout(timer);
			external?.removeEventListener("abort", forwardAbort);
			external?.removeEventListener("abort", onAbort);
		}
	};
}
