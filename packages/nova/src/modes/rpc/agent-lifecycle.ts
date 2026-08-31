export type AgentSessionStatus = "starting" | "idle" | "streaming" | "error" | "stopped";

export type AgentTaskStatus =
	| "queued"
	| "starting"
	| "running"
	| "waiting"
	| "completed"
	| "error"
	| "stopped"
	| "orphaned";

export interface AgentTokenUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
}

export interface AgentLifecycleSnapshot {
	agentId: string;
	sessionStatus: AgentSessionStatus;
	taskStatus: AgentTaskStatus;
	createdAt: string;
	startedAt?: string;
	completedAt?: string;
	lastActivityAt: string;
	durationMs?: number;
	tokenUsage: AgentTokenUsage;
	errorReason?: string;
	cancelReason?: string;
	timeoutReason?: string;
	retryCount: number;
	archived: boolean;
}

const ZERO_USAGE: AgentTokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

export class AgentLifecycle {
	readonly agentId: string;
	private snapshot: AgentLifecycleSnapshot;

	constructor(agentId: string, now = new Date()) {
		this.agentId = agentId;
		const timestamp = now.toISOString();
		this.snapshot = {
			agentId,
			sessionStatus: "starting",
			taskStatus: "queued",
			createdAt: timestamp,
			lastActivityAt: timestamp,
			tokenUsage: { ...ZERO_USAGE },
			retryCount: 0,
			archived: false,
		};
	}

	get value(): AgentLifecycleSnapshot {
		return structuredClone(this.snapshot);
	}

	ready(now = new Date()): void {
		this.update(now, { sessionStatus: "idle", taskStatus: "waiting" });
	}

	queue(now = new Date()): void {
		this.update(now, {
			sessionStatus: "idle",
			taskStatus: "queued",
			startedAt: undefined,
			completedAt: undefined,
			durationMs: undefined,
			errorReason: undefined,
			cancelReason: undefined,
			timeoutReason: undefined,
		});
	}

	start(now = new Date()): void {
		const timestamp = now.toISOString();
		this.update(now, { sessionStatus: "streaming", taskStatus: "running", startedAt: timestamp });
	}

	wait(now = new Date()): void {
		this.update(now, { sessionStatus: "idle", taskStatus: "waiting" });
	}

	complete(usage?: Partial<AgentTokenUsage>, now = new Date()): void {
		this.finish("completed", "idle", now, { tokenUsage: this.mergeUsage(usage) });
	}

	fail(reason: string, now = new Date()): void {
		this.finish("error", "error", now, { errorReason: reason });
	}

	stop(reason: string, now = new Date()): void {
		this.finish("stopped", "stopped", now, { cancelReason: reason });
	}

	timeout(reason: string, now = new Date()): void {
		this.finish("stopped", "stopped", now, { timeoutReason: reason });
	}

	orphan(reason: string, now = new Date()): void {
		this.finish("orphaned", "stopped", now, { errorReason: reason });
	}

	retry(now = new Date()): void {
		const retryCount = this.snapshot.retryCount + 1;
		this.queue(now);
		this.snapshot.retryCount = retryCount;
	}

	archive(now = new Date()): void {
		if (!this.isTerminal()) throw new Error(`Cannot archive active agent: ${this.agentId}`);
		this.update(now, { archived: true });
	}

	isTerminal(): boolean {
		return ["completed", "error", "stopped", "orphaned"].includes(this.snapshot.taskStatus);
	}

	private finish(
		taskStatus: Extract<AgentTaskStatus, "completed" | "error" | "stopped" | "orphaned">,
		sessionStatus: AgentSessionStatus,
		now: Date,
		extra: Partial<AgentLifecycleSnapshot>,
	): void {
		const completedAt = now.toISOString();
		const startedAt = this.snapshot.startedAt ?? completedAt;
		this.update(now, {
			taskStatus,
			sessionStatus,
			startedAt,
			completedAt,
			durationMs: Math.max(0, now.getTime() - new Date(startedAt).getTime()),
			...extra,
		});
	}

	private mergeUsage(usage?: Partial<AgentTokenUsage>): AgentTokenUsage {
		const merged = { ...this.snapshot.tokenUsage, ...usage };
		merged.total = usage?.total ?? merged.input + merged.output + merged.cacheRead + merged.cacheWrite;
		return merged;
	}

	private update(now: Date, patch: Partial<AgentLifecycleSnapshot>): void {
		this.snapshot = { ...this.snapshot, ...patch, lastActivityAt: now.toISOString() };
	}
}
