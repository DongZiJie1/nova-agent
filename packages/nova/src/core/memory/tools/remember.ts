/**
 * `remember` 工具：模型侧唯一的长期记忆写入入口。
 *
 * 写入的是一条事实（`FactStore`），在下一次会话构建 system prompt 时才会被注入，
 * 当前会话的上下文不会改变——工具的返回文本必须把这一点讲清楚。
 *
 * 单会话写入上限 20 条：模块级 Map 以 sessionId 为 key，只在真正写入（created/merged）
 * 后计数；duplicate / conflict 不消耗配额。测试通过 `resetMemoryToolRateLimits` 重置。
 */

import { type Static, Type } from "typebox";
import { getAgentDir } from "../../../config.ts";
import type { ToolDefinition } from "../../extensions/types.ts";
import { SettingsManager } from "../../settings-manager.ts";
import { computeProjectKey, type FactApplicability } from "../fact-schema.ts";
import { type FactDraft, FactStore, SensitiveFactError } from "../fact-store.ts";
import { lastMessageEntryId } from "../memory-marker.ts";

const MAX_WRITES_PER_SESSION = 20;

/** sessionId -> 已写入条数。 */
const writeCounts = new Map<string, number>();

/** 测试用：清空单会话写入计数。 */
export function resetMemoryToolRateLimits(): void {
	writeCounts.clear();
}

const rememberSchema = Type.Object({
	text: Type.String({
		minLength: 1,
		description:
			"One self-contained declarative sentence, at most 200 characters. Write it so it still makes sense in a future session: name the project or object instead of saying “this” or “it”",
	}),
	kind: Type.Optional(
		Type.Union(
			[
				Type.Literal("decision"),
				Type.Literal("preference"),
				Type.Literal("constraint"),
				Type.Literal("project"),
				Type.Literal("commitment"),
				Type.Literal("event"),
			],
			{ description: "Fact type; defaults to event" },
		),
	),
	importance: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: 5,
			description: "1-5, defaults to 3. 5 means the user must never have it violated; 1 means nice to know",
		}),
	),
	applicability: Type.Optional(
		Type.Union([Type.Literal("universal"), Type.Literal("transferable"), Type.Literal("project")], {
			description:
				"universal: true in any project; transferable: learned in this project, useful elsewhere; project: only this project. Defaults to universal",
		}),
	),
	topics: Type.Optional(
		Type.Array(Type.String(), {
			maxItems: 3,
			description: '1-3 short concept tags used to match this fact later, e.g. ["testing", "style"]',
		}),
	),
	validUntil: Type.Optional(
		Type.String({ description: "Optional ISO 8601 timestamp for a fact that stops being true, such as a deadline" }),
	),
	supersedes: Type.Optional(
		Type.Array(Type.String(), {
			description:
				"Fact ids from an earlier search_memory/read_memory call that this statement replaces; those facts are archived automatically",
		}),
	),
});

export type RememberToolInput = Static<typeof rememberSchema>;

export interface RememberToolDetails {
	action: "created" | "duplicate" | "merged" | "conflict" | "rejected" | "error";
	factId?: string;
	candidateIds?: string[];
	error?: string;
}

function textResult(text: string, details: RememberToolDetails) {
	return { content: [{ type: "text" as const, text }], details };
}

/**
 * 只在用户明确要求记住、纠正事实、或陈述长期偏好/约束时写入。
 * 描述里写明「写入下次会话生效」，避免模型以为写完当前会话就能看到。
 */
export function createRememberToolDefinition(
	options: { agentDir?: string } = {},
): ToolDefinition<typeof rememberSchema, RememberToolDetails> {
	const agentDir = options.agentDir ?? getAgentDir();
	return {
		name: "remember",
		label: "remember",
		description:
			"Store one durable fact in the user's long-term memory. The fact is injected into the system prompt of the next session (写入下次会话生效), so it does not change this conversation. Use it only when the user explicitly asks to remember something, corrects an earlier fact, or states a long-term preference or constraint. One fact per call; pass the ids of facts this statement replaces in supersedes. Duplicate, near-duplicate and conflicting statements are reported instead of silently overwritten.",
		promptSnippet: "Remember one durable fact for future sessions.",
		promptGuidelines: [
			"Use remember only when the user explicitly asks you to remember something, corrects a fact you stored or just stated, or states a durable preference, decision, or constraint. Never infer facts from context.",
			"Write facts that take effect from the next session (写入下次会话生效); do not expect this conversation to change after calling remember.",
			"Do not record greetings, temporary task details, anything already written in the repository's docs or code, guesses about the user, or secrets such as credentials, tokens, and personal identifiers.",
			"Store one fact per call: a single self-contained sentence that names the project or object it talks about, at most 200 characters.",
			"Search or read first when you suspect a related fact exists, then pass its id in supersedes so the obsolete statement is archived instead of contradicting the new one.",
			"Choose applicability deliberately: universal for user-wide preferences, transferable for practices learned in this project that help elsewhere, project for facts that only hold in the current working directory.",
		],
		parameters: rememberSchema,
		executionMode: "sequential",
		async execute(_toolCallId, input, _signal, _onUpdate, ctx) {
			const store = new FactStore(agentDir);
			const settings = SettingsManager.create(ctx.cwd, agentDir).getMemorySettings();
			if (!settings.facts.enabled) {
				return textResult("长期记忆已关闭（settings.memory.facts.enabled = false），未写入。", {
					action: "rejected",
					error: "facts disabled",
				});
			}

			const sessionId = ctx.sessionManager.getSessionId();
			if ((writeCounts.get(sessionId) ?? 0) >= MAX_WRITES_PER_SESSION) {
				return textResult(
					`本次会话的记忆写入已达上限（${MAX_WRITES_PER_SESSION} 条），未写入。请先与用户确认哪些值得保留，或留到下一次会话。`,
					{ action: "rejected", error: "session write limit reached" },
				);
			}

			const applicability: FactApplicability = input.applicability ?? "universal";
			const lastEntryId = lastMessageEntryId(ctx.sessionManager.getBranch());
			const draft: FactDraft = {
				text: input.text,
				applicability,
				source: {
					sessionFile: ctx.sessionManager.getSessionFile() ?? "",
					sessionId,
					entryIds: lastEntryId === undefined ? [] : [lastEntryId],
					extractedAt: new Date().toISOString(),
					model: "explicit",
				},
			};
			if (input.kind !== undefined) draft.kind = input.kind;
			if (input.importance !== undefined) draft.importance = input.importance;
			if (input.topics !== undefined) draft.topics = input.topics;
			if (input.validUntil !== undefined) draft.validUntil = input.validUntil;
			if (input.supersedes !== undefined) draft.supersedes = input.supersedes;
			// project 事实必须带上当前项目 key，否则检索时会被项目门控挡掉。
			if (applicability === "project") draft.projects = [computeProjectKey(ctx.cwd)];

			try {
				const result = store.add(draft);
				if (result.action === "duplicate") {
					return textResult(`这条已经记过了，未新增。\nid: ${result.fact.id}`, {
						action: "duplicate",
						factId: result.fact.id,
					});
				}
				writeCounts.set(sessionId, (writeCounts.get(sessionId) ?? 0) + 1);
				if (result.action === "merged") {
					return textResult(`已合并更新到已有事实：${result.fact.text}\nid: ${result.fact.id}`, {
						action: "merged",
						factId: result.fact.id,
					});
				}
				if (result.action === "conflict") {
					const lines = result.candidates.map((candidate) => `- [${candidate.id}] ${candidate.text}`);
					return textResult(
						[
							"与以下已有事实冲突，未写入：",
							...lines,
							"如果新说法确实要覆盖旧事实，请带上 supersedes 重新调用 remember。",
						].join("\n"),
						{ action: "conflict", candidateIds: result.candidates.map((candidate) => candidate.id) },
					);
				}
				return textResult(`已记住（下次会话生效）：${result.fact.text}\nid: ${result.fact.id}`, {
					action: "created",
					factId: result.fact.id,
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				const text =
					error instanceof SensitiveFactError
						? "无法写入记忆：内容疑似敏感信息，未写入。"
						: `无法写入记忆：${message}`;
				return textResult(text, { action: "error", error: message });
			}
		},
	};
}
