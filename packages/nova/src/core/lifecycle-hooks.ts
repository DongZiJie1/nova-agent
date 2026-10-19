import type { AgentSession } from "./agent-session.ts";

export type LifecycleEvent = "session_start" | "turn_end" | "agent_idle" | "before_compaction" | "session_end";

export interface LifecycleContext {
	event: LifecycleEvent;
	session: AgentSession;
	reason?: string;
	signal: AbortSignal;
}

/** Internal, process-local subscriptions. Never loaded from user configuration. */
export class LifecycleHooks {
	private handlers: Array<{
		event: LifecycleEvent;
		name: string;
		timeoutMs: number;
		handler: (context: LifecycleContext) => void | Promise<void>;
	}> = [];
	private log: (message: string, error: unknown) => void;

	constructor(log = (message: string, error: unknown) => console.error(message, error)) {
		this.log = log;
	}

	register(
		event: LifecycleEvent,
		options: {
			name: string;
			timeoutMs: number;
			handler: (context: LifecycleContext) => void | Promise<void>;
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
			const controller = new AbortController();
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				await Promise.race([
					Promise.resolve().then(() =>
						subscription.handler({ event, session, reason, signal: controller.signal }),
					),
					new Promise<never>((_, reject) => {
						timer = setTimeout(() => {
							controller.abort();
							reject(new Error(`Hook timed out after ${subscription.timeoutMs}ms`));
						}, subscription.timeoutMs);
					}),
				]);
			} catch (error) {
				try {
					this.log(`[lifecycle:${event}:${subscription.name}]`, error);
				} catch {
					/* Logging cannot block a session. */
				}
			} finally {
				clearTimeout(timer);
			}
		}
	}
}

export const lifecycleHooks = new LifecycleHooks();
