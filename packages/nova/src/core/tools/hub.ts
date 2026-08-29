import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";

/**
 * Hub collaboration tools.
 *
 * When an agent runs under Nova Studio, the host injects:
 *   NOVA_HUB_URL    — base URL of the hub HTTP API (e.g. http://127.0.0.1:9528)
 *   NOVA_HUB_TOKEN  — bearer token required by the hub (x-nova-token header)
 *   NOVA_AGENT_ID   — this agent's own id
 *   NOVA_ASK_DEPTH  — collaboration hop depth ("0" for user-spawned agents)
 *
 * The tools are only activated when NOVA_HUB_URL is present (see
 * defaultActiveToolNames in agent-session.ts / sdk.ts); a standalone CLI
 * never sees them.
 */

/** Maximum characters of an ask reply returned to the model — keeps
 * cross-agent context cheap. */
const MAX_REPLY_CHARS = 4000;

/** Ask chains deeper than this are refused; the agent must do the work
 * itself instead of delegating further. */
const MAX_ASK_DEPTH = 2;

interface HubEnv {
	url: string;
	token: string;
	agentId: string;
	depth: number;
}

interface HubAgentContext {
	agentId: string;
	depth: number;
	batchId?: string;
	requestId?: string;
	requestDepth?: number;
	visitedAgentIds?: string[];
}

const hubAgentContext = new AsyncLocalStorage<HubAgentContext>();

/** Scope process-shared hub credentials to the AgentSession handling this run. */
export function runWithHubAgentContext<T>(context: HubAgentContext, callback: () => T): T {
	return hubAgentContext.run(context, callback);
}

function readHubEnv(): HubEnv | null {
	const url = process.env.NOVA_HUB_URL;
	if (!url) return null;
	const scoped = hubAgentContext.getStore();
	return {
		url: url.replace(/\/$/, ""),
		token: process.env.NOVA_HUB_TOKEN ?? "",
		agentId: scoped?.agentId ?? process.env.NOVA_AGENT_ID ?? "",
		depth: scoped?.depth ?? (Number.parseInt(process.env.NOVA_ASK_DEPTH ?? "0", 10) || 0),
	};
}

function noHubResult() {
	return {
		content: [
			{
				type: "text" as const,
				text: "Hub collaboration is not available: this agent is not running under Nova Studio (NOVA_HUB_URL is not set).",
			},
		],
		details: { error: "no_hub" },
	};
}

/** Minimal hub HTTP client. Exported for tests. */
export async function hubRequest(
	method: string,
	path: string,
	body?: unknown,
): Promise<{ ok: boolean; status: number; data: unknown }> {
	const hub = readHubEnv();
	if (!hub) return { ok: false, status: 0, data: { error: "no_hub" } };
	const res = await fetch(`${hub.url}${path}`, {
		method,
		headers: {
			"content-type": "application/json",
			"x-nova-token": hub.token,
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const text = await res.text();
	let data: unknown;
	try {
		data = JSON.parse(text);
	} catch {
		data = { error: text };
	}
	return { ok: res.ok, status: res.status, data };
}

/** Mark the current delegation batch closed once the owning Agent turn settles. */
export async function sealHubTaskBatch(batchId: string, sourceAgentId: string): Promise<void> {
	const hub = readHubEnv();
	if (!hub) return;
	const response = await hubRequest("POST", `/tasks/batches/${encodeURIComponent(batchId)}/seal`, {
		source_agent_id: sourceAgentId,
	});
	if (!response.ok) {
		throw new Error(`Could not seal Agent task batch ${batchId}: hub returned status ${response.status}`);
	}
}

function truncateReply(text: string): { text: string; truncated: boolean } {
	if (text.length <= MAX_REPLY_CHARS) return { text, truncated: false };
	return {
		text: `${text.slice(0, MAX_REPLY_CHARS)}\n\n[... reply truncated to ${MAX_REPLY_CHARS} characters — ask for specifics if you need more]`,
		truncated: true,
	};
}

// ─── hub_list_agents ───

const hubListAgentsSchema = Type.Object({});

export type HubListAgentsToolInput = Static<typeof hubListAgentsSchema>;

export interface HubListAgentsDetails {
	agents?: Array<{
		id: string;
		parentAgentId: string | null;
		name: string | null;
		status: string;
		cwd: string;
		model: string | null;
	}>;
	error?: string;
}

export function createHubListAgentsToolDefinition(): ToolDefinition<typeof hubListAgentsSchema, HubListAgentsDetails> {
	return {
		name: "hub_list_agents",
		label: "hub_list_agents",
		description:
			"List only the child agents created under this Agent's conversation, including deeper descendants. Returns their id, parent, name, status, working directory, and model. Use for discovery, not for polling task completion; completed task results arrive automatically.",
		promptSnippet: "List the child agents belonging to this Agent's conversation.",
		parameters: hubListAgentsSchema,
		async execute() {
			const hub = readHubEnv();
			if (!hub) return noHubResult();

			try {
				const res = await hubRequest("GET", `/agents/${encodeURIComponent(hub.agentId)}/children`);
				if (!res.ok || !Array.isArray(res.data)) {
					const msg = (res.data as { error?: string })?.error ?? `hub returned status ${res.status}`;
					return {
						content: [{ type: "text" as const, text: `Failed to list agents: ${msg}` }],
						details: { error: msg },
					};
				}

				const others = res.data as Array<{
					id: string;
					status: string;
					cwd: string;
					model: string | null;
					name?: string | null;
					parent_agent_id?: string | null;
					message_count?: number;
				}>;
				const lines = others.map(
					(a) =>
						`- ${a.id}: parent=${a.parent_agent_id ?? "unknown"}, name=${a.name ?? "Agent"}, status=${a.status}, model=${a.model ?? "default"}, cwd=${a.cwd}`,
				);
				const text =
					lines.length === 0
						? "This Agent has no child agents."
						: `${others.length} child agent(s):\n${lines.join("\n")}`;
				return {
					content: [{ type: "text" as const, text }],
					details: {
						agents: others.map((a) => ({
							id: a.id,
							parentAgentId: a.parent_agent_id ?? null,
							name: a.name ?? null,
							status: a.status,
							cwd: a.cwd,
							model: a.model,
						})),
					},
				};
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text" as const, text: `Failed to reach the hub: ${msg}` }],
					details: { error: msg },
				};
			}
		},
	};
}

// ─── hub_spawn_agent ───

const hubSpawnAgentSchema = Type.Object({
	cwd: Type.String({
		description: "Working directory for the new agent — usually the current project root",
	}),
	model: Type.Optional(Type.String({ description: "Model override for the new agent" })),
});

export type HubSpawnAgentToolInput = Static<typeof hubSpawnAgentSchema>;

export interface HubSpawnAgentDetails {
	agentId?: string;
	error?: string;
}

export function createHubSpawnAgentToolDefinition(): ToolDefinition<typeof hubSpawnAgentSchema, HubSpawnAgentDetails> {
	return {
		name: "hub_spawn_agent",
		label: "hub_spawn_agent",
		description:
			"Spawn a new agent under Nova Studio to delegate a self-contained subtask to. Returns the new agent's id, which you then pass to hub_ask_agent to give it instructions. The new agent starts with an empty conversation — it cannot see this one.",
		promptSnippet: "Spawn a new agent to delegate a subtask to.",
		parameters: hubSpawnAgentSchema,
		async execute(_toolCallId, { cwd, model }) {
			const hub = readHubEnv();
			if (!hub) return noHubResult();
			const activeRequestDepth = hubAgentContext.getStore()?.requestDepth ?? hub.depth;

			if (activeRequestDepth >= MAX_ASK_DEPTH) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Delegation depth limit reached (depth ${activeRequestDepth}/${MAX_ASK_DEPTH}). Do this work yourself instead of spawning another agent.`,
						},
					],
					details: { error: "depth_limit" },
				};
			}

			try {
				// The new agent is one hop deeper in the delegation chain, so the
				// hub injects depth+1 into its NOVA_ASK_DEPTH env var. At the
				// limit this is already refused above, so depth stays < MAX_ASK_DEPTH.
				const res = await hubRequest("POST", "/agents", {
					cwd,
					model,
					depth: hub.depth + 1,
					parent_agent_id: hub.agentId,
				});
				const data = res.data as { agent_id?: string; info?: { status?: string }; error?: string };
				if (!res.ok || !data.agent_id) {
					const msg = data.error ?? `hub returned status ${res.status}`;
					return {
						content: [{ type: "text" as const, text: `Failed to spawn an agent: ${msg}` }],
						details: { error: msg },
					};
				}
				return {
					content: [
						{
							type: "text" as const,
							text: `Spawned agent ${data.agent_id} (cwd: ${cwd}). It is ready — use hub_ask_agent with this id to give it its task. Remember: it cannot see this conversation, so include full context in your instructions.`,
						},
					],
					details: { agentId: data.agent_id },
				};
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text" as const, text: `Failed to reach the hub: ${msg}` }],
					details: { error: msg },
				};
			}
		},
	};
}

// ─── hub_ask_agent ───

const hubAskAgentSchema = Type.Object({
	agent_id: Type.String({ description: "Id of the agent to ask (from hub_list_agents or hub_spawn_agent)" }),
	question: Type.String({
		description:
			"The question or task for the other agent. It cannot see this conversation — include all necessary context, and ask for a concise conclusion rather than raw output.",
	}),
	timeout_secs: Type.Optional(Type.Number({ description: "How long to wait for the reply in seconds (default 300)" })),
});

export type HubAskAgentToolInput = Static<typeof hubAskAgentSchema>;

export interface HubAskAgentDetails {
	agentId?: string;
	reply?: string;
	truncated?: boolean;
	error?: string;
	errorCode?: string;
	requestId?: string;
	requestDepth?: number;
	visitedAgentIds?: string[];
}

export function createHubAskAgentToolDefinition(): ToolDefinition<typeof hubAskAgentSchema, HubAskAgentDetails> {
	return {
		name: "hub_ask_agent",
		label: "hub_ask_agent",
		description:
			"Ask another agent a question and wait for its full reply. Use for collaboration: delegating a subtask to an agent you spawned, or consulting another running agent. Replies are truncated to 4000 characters.",
		promptSnippet: "Ask another agent a question and wait for its reply.",
		promptGuidelines: [
			"You can collaborate with other agents running under Nova Studio: discover them with hub_list_agents, delegate subtasks with hub_spawn_agent, and collect results with hub_ask_agent.",
			"Other agents cannot see this conversation — always include full context in your questions, and ask for concise conclusions rather than raw output.",
			"Summarize what you learned from other agents instead of pasting their raw replies into your own answer.",
		],
		parameters: hubAskAgentSchema,
		async execute(_toolCallId, { agent_id, question, timeout_secs }) {
			const hub = readHubEnv();
			if (!hub) return noHubResult();
			const scoped = hubAgentContext.getStore();
			const visitedAgentIds = Array.from(new Set([...(scoped?.visitedAgentIds ?? []), hub.agentId]));
			const requestDepth = (scoped?.requestDepth ?? hub.depth) + 1;
			const requestId = scoped?.requestId ?? randomUUID();

			if (agent_id === hub.agentId) {
				return {
					content: [
						{
							type: "text" as const,
							text: "That agent_id is yourself. Do the work directly instead of delegating.",
						},
					],
					details: { error: "self_ask", errorCode: "self_ask", requestId, requestDepth, visitedAgentIds },
				};
			}

			if (visitedAgentIds.includes(agent_id)) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Agent request cycle blocked: ${[...visitedAgentIds, agent_id].join(" → ")}.`,
						},
					],
					details: {
						agentId: agent_id,
						error: "cycle_detected",
						errorCode: "cycle_detected",
						requestId,
						requestDepth,
						visitedAgentIds,
					},
				};
			}

			if (requestDepth > MAX_ASK_DEPTH) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Delegation depth limit reached (depth ${requestDepth - 1}/${MAX_ASK_DEPTH}). Do this work yourself instead of asking another agent.`,
						},
					],
					details: {
						agentId: agent_id,
						error: "depth_limit",
						errorCode: "depth_limit",
						requestId,
						requestDepth,
						visitedAgentIds,
					},
				};
			}

			try {
				const res = await hubRequest("POST", `/agents/${encodeURIComponent(agent_id)}/ask`, {
					question,
					timeout_secs: timeout_secs ?? 300,
					source_agent_id: hub.agentId,
					request_id: requestId,
					request_depth: requestDepth,
					visited_agent_ids: visitedAgentIds,
				});
				const data = res.data as { reply?: string; error?: string; code?: string; request_id?: string };
				if (!res.ok || typeof data.reply !== "string") {
					const msg = data.error ?? `hub returned status ${res.status}`;
					return {
						content: [{ type: "text" as const, text: `Agent ${agent_id} could not answer: ${msg}` }],
						details: {
							agentId: agent_id,
							error: msg,
							errorCode: data.code,
							requestId: data.request_id ?? requestId,
							requestDepth,
							visitedAgentIds,
						},
					};
				}
				const { text, truncated } = truncateReply(data.reply);
				return {
					content: [{ type: "text" as const, text: `Reply from ${agent_id}:\n${text}` }],
					details: {
						agentId: agent_id,
						reply: text,
						truncated,
						requestId,
						requestDepth,
						visitedAgentIds: [...visitedAgentIds, agent_id],
					},
				};
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text" as const, text: `Failed to reach the hub: ${msg}` }],
					details: { agentId: agent_id, error: msg },
				};
			}
		},
	};
}

// ─── hub_delegate_task / hub_wait_tasks ───

const hubDelegateTaskSchema = Type.Object({
	task: Type.String({ description: "A self-contained task with all context the target agent needs." }),
	agent_id: Type.Optional(
		Type.String({
			description: "Existing agent id to reuse. Omit this field to create a new child agent automatically.",
		}),
	),
	cwd: Type.Optional(
		Type.String({ description: "Working directory for a newly created agent. Defaults to the current directory." }),
	),
	model: Type.Optional(Type.String({ description: "Optional model id for a newly created agent." })),
	timeout_secs: Type.Optional(Type.Number({ description: "Maximum task runtime in seconds (default 300)." })),
});

export type HubDelegateTaskInput = Static<typeof hubDelegateTaskSchema>;

export interface HubDelegateTaskDetails {
	taskId?: string;
	batchId?: string;
	agentId?: string;
	createdAgent?: boolean;
	status?: string;
	error?: string;
	errorCode?: string;
	requestId?: string;
}

export function createHubDelegateTaskToolDefinition(): ToolDefinition<
	typeof hubDelegateTaskSchema,
	HubDelegateTaskDetails
> {
	return {
		name: "hub_delegate_task",
		label: "hub_delegate_task",
		description:
			"Delegate a self-contained task and return immediately. Provide agent_id to reuse an existing agent, or omit it to create a child agent automatically. The completed structured result is automatically added to the delegating Agent's conversation.",
		promptSnippet: "Delegate work to an existing or automatically created agent without blocking.",
		promptGuidelines: [
			"Use hub_delegate_task to start independent work. Include all necessary context because the target agent cannot see this conversation.",
			"After delegating, continue the current conversation or other useful work. Completed results are automatically added to this conversation.",
			"Never wait for delegated work by running bash sleep, timers, retry loops, or repeated hub_list_agents calls. End the current turn or help the user with something else; the result will arrive as a SUB_AGENT message.",
		],
		parameters: hubDelegateTaskSchema,
		async execute(_toolCallId, { task, agent_id, cwd, model, timeout_secs }) {
			const hub = readHubEnv();
			if (!hub) return noHubResult();
			const scoped = hubAgentContext.getStore();
			const visitedAgentIds = Array.from(new Set([...(scoped?.visitedAgentIds ?? []), hub.agentId]));
			const requestDepth = (scoped?.requestDepth ?? hub.depth) + 1;
			const requestId = scoped?.requestId ?? randomUUID();
			const batchId = scoped?.batchId ?? randomUUID();

			if (agent_id === hub.agentId || (agent_id && visitedAgentIds.includes(agent_id))) {
				return {
					content: [{ type: "text" as const, text: "Agent request cycle blocked." }],
					details: { agentId: agent_id, error: "cycle_detected", errorCode: "cycle_detected", requestId },
				};
			}
			if (requestDepth > MAX_ASK_DEPTH) {
				return {
					content: [{ type: "text" as const, text: "Agent delegation depth limit reached." }],
					details: { agentId: agent_id, error: "depth_limit", errorCode: "depth_limit", requestId },
				};
			}

			try {
				const res = await hubRequest("POST", "/tasks/delegate", {
					task,
					agent_id,
					cwd: cwd ?? process.cwd(),
					model,
					timeout_secs: timeout_secs ?? 300,
					source_agent_id: hub.agentId,
					request_id: requestId,
					batch_id: batchId,
					request_depth: requestDepth,
					visited_agent_ids: visitedAgentIds,
					depth: hub.depth + 1,
				});
				const data = res.data as {
					task_id?: string;
					agent_id?: string;
					created_agent?: boolean;
					status?: string;
					error?: string;
					code?: string;
				};
				if (!res.ok || !data.task_id || !data.agent_id) {
					const message = data.error ?? `hub returned status ${res.status}`;
					return {
						content: [{ type: "text" as const, text: `Could not delegate task: ${message}` }],
						details: { error: message, errorCode: data.code, requestId },
					};
				}
				return {
					content: [
						{
							type: "text" as const,
							text: `Task ${data.task_id} is ${data.status ?? "running"} on agent ${data.agent_id}.`,
						},
					],
					details: {
						taskId: data.task_id,
						batchId,
						agentId: data.agent_id,
						createdAgent: data.created_agent,
						status: data.status,
						requestId,
					},
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					content: [{ type: "text" as const, text: `Failed to reach the hub: ${message}` }],
					details: { error: message, errorCode: "hub_unreachable", requestId },
				};
			}
		},
	};
}

const hubWaitTasksSchema = Type.Object({
	task_ids: Type.Array(Type.String(), { minItems: 1, description: "Task ids returned by hub_delegate_task." }),
	wait_for: Type.Optional(
		Type.Union([Type.Literal("any"), Type.Literal("all")], {
			description: "Return when any task finishes or when all tasks finish (default all).",
		}),
	),
	timeout_secs: Type.Optional(Type.Number({ description: "How long to wait, from 0 to 300 seconds (default 30)." })),
});

export type HubWaitTasksInput = Static<typeof hubWaitTasksSchema>;

export interface HubWaitTasksDetails {
	tasks?: Array<{
		taskId: string;
		agentId: string;
		status: string;
		summary?: string;
		changedFiles: string[];
		verification: string[];
		remainingRisks: string[];
		finalText?: string;
		error?: string;
	}>;
	timedOut?: boolean;
	error?: string;
	errorCode?: string;
}

export function createHubWaitTasksToolDefinition(): ToolDefinition<typeof hubWaitTasksSchema, HubWaitTasksDetails> {
	return {
		name: "hub_wait_tasks",
		label: "hub_wait_tasks",
		description:
			"Explicitly check or wait for delegated Agent tasks when their result is required before continuing. Completed results are also delivered automatically, so this tool is usually unnecessary after delegation. Use timeout_secs=0 for a non-blocking status check.",
		promptSnippet: "Explicitly wait for or check a delegated task only when its result is needed now.",
		parameters: hubWaitTasksSchema,
		async execute(_toolCallId, { task_ids, wait_for, timeout_secs }) {
			const hub = readHubEnv();
			if (!hub) return noHubResult();
			try {
				const res = await hubRequest("POST", "/tasks/wait", {
					task_ids,
					wait_for: wait_for ?? "all",
					timeout_secs: timeout_secs ?? 30,
				});
				const data = res.data as {
					tasks?: HubWaitTasksDetails["tasks"];
					timed_out?: boolean;
					error?: string;
					code?: string;
				};
				if (!res.ok || !Array.isArray(data.tasks)) {
					const message = data.error ?? `hub returned status ${res.status}`;
					return {
						content: [{ type: "text" as const, text: `Could not wait for tasks: ${message}` }],
						details: { error: message, errorCode: data.code },
					};
				}
				const lines = data.tasks.map((task) => JSON.stringify(task));
				return {
					content: [{ type: "text" as const, text: lines.join("\n") }],
					details: { tasks: data.tasks, timedOut: data.timed_out },
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					content: [{ type: "text" as const, text: `Failed to reach the hub: ${message}` }],
					details: { error: message, errorCode: "hub_unreachable" },
				};
			}
		},
	};
}
