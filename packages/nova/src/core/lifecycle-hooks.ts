import type { AgentSession } from "./agent-session.ts";

export type LifecycleEvent =
	| "session_start"
	| "before_prompt"
	| "turn_end"
	| "agent_idle"
	| "before_compaction"
	| "session_end";

export interface LifecycleContext {
	event: LifecycleEvent;
	session: AgentSession;
	reason?: string;
	/** Expanded user prompt. Only set for `before_prompt`. */
	promptText?: string;
	signal: AbortSignal;
}

/** A custom message a `before_prompt` handler wants inserted before the user message. */
export interface PromptContextMessage {
	customType: string;
	content: Array<{ type: "text"; text: string }>;
	display?: boolean;
	details?: unknown;
}

/**
 * Return value of a lifecycle handler. Only `before_prompt` consumes it;
 * every other event ignores it, so existing handlers keep working unchanged.
 */
export interface LifecycleHookResult {
	messages?: PromptContextMessage[];
}

/** Handlers return their context messages through an untyped result; `invoke` narrows it. */
export type LifecycleHookHandler = (context: LifecycleContext) => unknown;

function isLifecycleHookResult(value: unknown): value is LifecycleHookResult {
	if (typeof value !== "object" || value === null) return false;
	const messages = (value as { messages?: unknown }).messages;
	return messages === undefined || Array.isArray(messages);
}

interface LifecycleSubscription {
	event: LifecycleEvent;
	name: string;
	timeoutMs: number;
	handler: LifecycleHookHandler;
}

/** Internal, process-local subscriptions. Never loaded from user configuration. */
export class LifecycleHooks {
	private handlers: LifecycleSubscription[] = [];
	private log: (message: string, error: unknown) => void;

	constructor(log = (message: string, error: unknown) => console.error(message, error)) {
		this.log = log;
	}

	register(
		event: LifecycleEvent,
		options: {
			name: string;
			timeoutMs: number;
			handler: LifecycleHookHandler;
		},
	): () => void {
		if (!options.name.trim() || !Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
			throw new Error("Lifecycle hooks require a name and a positive finite timeout");
		}
		const subscription = { event, ...options };
		this.handlers.push(subscription);
		return () => {
			this.handlers = this.handlers.filter((item) => item !== subscription);
		};
	}

	async emit(event: LifecycleEvent, session: AgentSession, reason?: string): Promise<void> {
		for (const subscription of this.handlers.slice()) {
			if (subscription.event !== event) continue;
			// Return values are only meaningful for `before_prompt`, which has its own emitter.
			await this.invoke(subscription, { event, session, reason });
		}
	}

	/**
	 * Runs the `before_prompt` handlers and flattens the messages they return.
	 * Each handler gets an independent timeout; a failure or timeout is logged and skipped,
	 * so a broken handler can never block or fail the prompt.
	 */
	async emitBeforePrompt(session: AgentSession, promptText: string): Promise<PromptContextMessage[]> {
		const messages: PromptContextMessage[] = [];
		for (const subscription of this.handlers.slice()) {
			if (subscription.event !== "before_prompt") continue;
			const result = await this.invoke(subscription, {
				event: "before_prompt",
				session,
				promptText,
			});
			if (result?.messages) messages.push(...result.messages);
		}
		return messages;
	}

	private async invoke(
		subscription: LifecycleSubscription,
		context: Omit<LifecycleContext, "signal">,
	): Promise<LifecycleHookResult | undefined> {
		const controller = new AbortController();
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const result = await Promise.race([
				Promise.resolve().then(() => subscription.handler({ ...context, signal: controller.signal })),
				new Promise<never>((_, reject) => {
					timer = setTimeout(() => {
						controller.abort();
						reject(new Error(`Hook timed out after ${subscription.timeoutMs}ms`));
					}, subscription.timeoutMs);
				}),
			]);
			return isLifecycleHookResult(result) ? result : undefined;
		} catch (error) {
			try {
				this.log(`[lifecycle:${context.event}:${subscription.name}]`, error);
			} catch {
				/* Logging cannot block a session. */
			}
			return undefined;
		} finally {
			clearTimeout(timer);
		}
	}
}

export const lifecycleHooks = new LifecycleHooks();
