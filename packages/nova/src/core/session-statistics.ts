import type { SessionStats } from "./agent-session.ts";
import type { SessionManager } from "./session-manager.ts";
import { addUsageToTotals, createUsageTotals } from "./usage-totals.ts";

export const MEMORY_WRITE_CUSTOM_TYPE = "nova.memory_write";

type SessionStatisticsSource = Pick<SessionManager, "getHeader" | "getEntries" | "getSessionFile" | "getSessionId">;

export function getSessionTiming(manager: SessionStatisticsSource, endedAt?: string) {
	const startedAt = manager.getHeader()!.timestamp;
	let lastActivityAt = startedAt;
	let assistantMessages = 0;
	let memoryWrites = 0;
	const toolCallDistribution: Record<string, number> = Object.create(null);
	for (const entry of manager.getEntries()) {
		if (entry.timestamp > lastActivityAt) lastActivityAt = entry.timestamp;
		if (entry.type === "custom" && entry.customType === MEMORY_WRITE_CUSTOM_TYPE) memoryWrites++;
		if (entry.type === "message" && entry.message.role === "assistant") {
			assistantMessages++;
			for (const block of entry.message.content) {
				if (block.type === "toolCall")
					toolCallDistribution[block.name] = (toolCallDistribution[block.name] ?? 0) + 1;
			}
		}
	}
	return {
		startedAt,
		endedAt,
		lastActivityAt,
		durationMs: Math.max(0, Date.parse(endedAt ?? new Date().toISOString()) - Date.parse(startedAt)),
		// One model/tool round per persisted assistant response, including aborted rounds.
		turns: assistantMessages,
		toolCallDistribution,
		memoryWrites,
	};
}

/** Aggregate all branches and compacted history, shared by live snapshots and recovery. */
export function collectSessionStats(manager: SessionStatisticsSource, endedAt?: string): SessionStats {
	let userMessages = 0;
	let assistantMessages = 0;
	let toolResults = 0;
	let totalMessages = 0;
	let toolCalls = 0;
	const usageTotals = createUsageTotals();

	for (const entry of manager.getEntries()) {
		if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
			addUsageToTotals(usageTotals, entry.usage);
		}
		if (entry.type !== "message") continue;
		totalMessages++;
		const message = entry.message;
		if (message.role === "user") {
			userMessages++;
		} else if (message.role === "toolResult") {
			toolResults++;
			if (message.usage) {
				addUsageToTotals(usageTotals, message.usage);
			}
		} else if (message.role === "assistant") {
			assistantMessages++;
			const assistantMsg = message;
			if (Array.isArray(assistantMsg.content)) {
				toolCalls += assistantMsg.content.filter((c) => c.type === "toolCall").length;
			}
			addUsageToTotals(usageTotals, assistantMsg.usage);
		}
	}

	return {
		sessionFile: manager.getSessionFile(),
		sessionId: manager.getSessionId(),
		userMessages,
		assistantMessages,
		toolCalls,
		toolResults,
		totalMessages,
		tokens: {
			input: usageTotals.input,
			output: usageTotals.output,
			cacheRead: usageTotals.cacheRead,
			cacheWrite: usageTotals.cacheWrite,
			total: usageTotals.input + usageTotals.output + usageTotals.cacheRead + usageTotals.cacheWrite,
		},
		cost: usageTotals.cost,
		...getSessionTiming(manager, endedAt),
	};
}
