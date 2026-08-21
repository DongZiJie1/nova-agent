import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { AgentMessage } from "@dongzijie1/pi-agent-core";
import type { Message, TextContent } from "@dongzijie1/pi-ai";
import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import { type SessionInfo, SessionManager } from "../session-manager.ts";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const DEFAULT_MESSAGE_LIMIT = 40;
const MAX_MESSAGE_LIMIT = 100;
const MAX_MESSAGE_CHARS = 8_000;

const novaDataSchema = Type.Object({
	action: Type.Union(
		[
			Type.Literal("list_projects"),
			Type.Literal("list_sessions"),
			Type.Literal("read_session"),
			Type.Literal("delete_session"),
		],
		{ description: "Nova conversation-data operation to perform" },
	),
	session_id: Type.Optional(
		Type.String({ description: "Required for read_session and delete_session; use an exact id from list_sessions" }),
	),
	project_path: Type.Optional(Type.String({ description: "Filter a project or disambiguate duplicate session ids" })),
	limit: Type.Optional(Type.Number({ minimum: 1, maximum: MAX_LIMIT, description: "Maximum sessions to list" })),
	message_limit: Type.Optional(
		Type.Number({ minimum: 1, maximum: MAX_MESSAGE_LIMIT, description: "Maximum recent messages to read" }),
	),
});

export type NovaDataToolInput = Static<typeof novaDataSchema>;

export interface NovaDataToolDetails {
	action: NovaDataToolInput["action"];
	status: "ok" | "cancelled" | "error";
	data?: unknown;
	error?: string;
}

function normalizeProjectPath(projectPath: string): string {
	return resolve(projectPath);
}

function sessionSummary(session: SessionInfo) {
	return {
		id: session.id,
		name: session.name,
		projectPath: session.cwd,
		created: session.created.toISOString(),
		modified: session.modified.toISOString(),
		messageCount: session.messageCount,
		firstMessage: session.firstMessage.slice(0, 500),
	};
}

function textFromMessage(message: AgentMessage): string | undefined {
	if (message.role !== "user" && message.role !== "assistant") return undefined;
	const content = (message as Message).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return undefined;
	const text = content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
	return text || undefined;
}

function findSession(sessions: SessionInfo[], sessionId: string, projectPath?: string): SessionInfo {
	const normalizedProjectPath = projectPath ? normalizeProjectPath(projectPath) : undefined;
	const matches = sessions.filter(
		(session) =>
			session.id === sessionId &&
			(normalizedProjectPath === undefined || normalizeProjectPath(session.cwd) === normalizedProjectPath),
	);
	if (matches.length === 0) throw new Error(`Session not found: ${sessionId}`);
	if (matches.length > 1) {
		throw new Error(`Session id ${sessionId} exists in multiple projects; provide project_path`);
	}
	return matches[0];
}

function moveSessionToTrash(sessionPath: string): void {
	const trashResult = spawnSync("trash", sessionPath.startsWith("-") ? ["--", sessionPath] : [sessionPath], {
		encoding: "utf8",
	});
	if (trashResult.status === 0 && !existsSync(sessionPath)) return;
	const detail =
		trashResult.error?.message ?? trashResult.stderr?.trim() ?? `trash exited with status ${trashResult.status}`;
	throw new Error(`Could not move session to trash: ${detail}`);
}

function successfulResult(action: NovaDataToolInput["action"], data: unknown) {
	return {
		content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
		details: { action, status: "ok" as const, data },
	};
}

export function createNovaDataToolDefinition(): ToolDefinition<typeof novaDataSchema, NovaDataToolDetails> {
	return {
		name: "nova_data",
		label: "nova_data",
		description:
			"Manage Nova's own conversation data. List projects and sessions, read another session's user/assistant messages, or delete a session after direct user confirmation. This never deletes project source directories.",
		promptSnippet: "Inspect and manage Nova conversation history across projects.",
		promptGuidelines: [
			"Use nova_data instead of filesystem commands when inspecting or deleting Nova sessions.",
			"Deleting a session requires direct user confirmation inside the tool and never deletes project source files.",
		],
		parameters: novaDataSchema,
		executionMode: "sequential",
		async execute(_toolCallId, input, _signal, _onUpdate, ctx) {
			try {
				const customSessionDir = ctx.sessionManager.usesDefaultSessionDir()
					? undefined
					: ctx.sessionManager.getSessionDir();
				const sessions = await SessionManager.listAll(customSessionDir);

				if (input.action === "list_projects") {
					const projects = new Map<string, { path: string; sessionCount: number; lastModified: string }>();
					for (const session of sessions) {
						const path = session.cwd || "(unknown)";
						const existing = projects.get(path);
						if (existing) {
							existing.sessionCount++;
							if (session.modified.toISOString() > existing.lastModified) {
								existing.lastModified = session.modified.toISOString();
							}
						} else {
							projects.set(path, {
								path,
								sessionCount: 1,
								lastModified: session.modified.toISOString(),
							});
						}
					}
					return successfulResult(input.action, {
						projects: [...projects.values()].sort((a, b) => b.lastModified.localeCompare(a.lastModified)),
					});
				}

				if (input.action === "list_sessions") {
					const projectPath = input.project_path ? normalizeProjectPath(input.project_path) : undefined;
					const filtered = projectPath
						? sessions.filter((session) => session.cwd && normalizeProjectPath(session.cwd) === projectPath)
						: sessions;
					const limit = Math.min(input.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
					return successfulResult(input.action, {
						total: filtered.length,
						sessions: filtered.slice(0, limit).map(sessionSummary),
						truncated: filtered.length > limit,
					});
				}

				if (!input.session_id) throw new Error(`${input.action} requires session_id`);
				const session = findSession(sessions, input.session_id, input.project_path);
				if (input.action === "read_session") {
					const manager = SessionManager.open(session.path);
					const messages = manager
						.getEntries()
						.filter((entry) => entry.type === "message")
						.map((entry) => ({
							role: entry.message.role,
							text: textFromMessage(entry.message),
							timestamp: entry.timestamp,
						}))
						.filter(
							(message): message is { role: "user" | "assistant"; text: string; timestamp: string } =>
								(message.role === "user" || message.role === "assistant") && message.text !== undefined,
						);
					const messageLimit = Math.min(input.message_limit ?? DEFAULT_MESSAGE_LIMIT, MAX_MESSAGE_LIMIT);
					const selectedMessages = messages.slice(-messageLimit).map((message) => ({
						...message,
						text:
							message.text.length > MAX_MESSAGE_CHARS
								? `${message.text.slice(0, MAX_MESSAGE_CHARS)}\n[message truncated]`
								: message.text,
					}));
					return successfulResult(input.action, {
						...sessionSummary(session),
						messages: selectedMessages,
						truncated: messages.length > selectedMessages.length,
					});
				}

				const activeSessionPath = ctx.sessionManager.getSessionFile();
				if (activeSessionPath && resolve(activeSessionPath) === resolve(session.path)) {
					throw new Error("Cannot delete the currently active session");
				}
				if (!ctx.hasUI) throw new Error("Deleting a session requires interactive user confirmation");
				const confirmed = await ctx.ui.confirm(
					"Delete Nova session?",
					[
						`Project: ${session.cwd || "(unknown)"}`,
						`Session: ${session.name ?? session.id}`,
						`Messages: ${session.messageCount}`,
						"The session will be moved to the system trash. Project files will not be touched.",
					].join("\n"),
				);
				if (!confirmed) {
					return {
						content: [{ type: "text" as const, text: "Session deletion cancelled by the user." }],
						details: { action: input.action, status: "cancelled" },
					};
				}
				moveSessionToTrash(session.path);
				return successfulResult(input.action, { deleted: sessionSummary(session), method: "trash" });
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					content: [{ type: "text" as const, text: `Error: ${message}` }],
					details: { action: input.action, status: "error", error: message },
				};
			}
		},
	};
}
