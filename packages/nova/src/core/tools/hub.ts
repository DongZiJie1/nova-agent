import { AsyncLocalStorage } from "node:async_hooks";
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
	agents?: Array<{ id: string; status: string; cwd: string; model: string | null }>;
	error?: string;
}

export function createHubListAgentsToolDefinition(): ToolDefinition<typeof hubListAgentsSchema, HubListAgentsDetails> {
	return {
		name: "hub_list_agents",
		label: "hub_list_agents",
		description:
			"List all agents currently running under Nova Studio, with their id, status, working directory, and model. Use to discover collaborators before delegating work.",
		promptSnippet: "List the other agents running under Nova Studio.",
		parameters: hubListAgentsSchema,
		async execute() {
			const hub = readHubEnv();
			if (!hub) return noHubResult();

			try {
				const res = await hubRequest("GET", "/agents");
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
					message_count?: number;
				}>;
				const lines = others.map(
					(a) =>
						`- ${a.id}${a.id === hub.agentId ? " (you)" : ""}: status=${a.status}, model=${a.model ?? "default"}, cwd=${a.cwd}`,
				);
				const text =
					lines.length === 0
						? "No other agents are running."
						: `${others.length} agent(s) running:\n${lines.join("\n")}`;
				return {
					content: [{ type: "text" as const, text }],
					details: {
						agents: others.map((a) => ({ id: a.id, status: a.status, cwd: a.cwd, model: a.model })),
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

			if (hub.depth >= MAX_ASK_DEPTH) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Delegation depth limit reached (depth ${hub.depth}/${MAX_ASK_DEPTH}). Do this work yourself instead of spawning another agent.`,
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

			if (agent_id === hub.agentId) {
				return {
					content: [
						{
							type: "text" as const,
							text: "That agent_id is yourself. Do the work directly instead of delegating.",
						},
					],
					details: { error: "self_ask" },
				};
			}

			if (hub.depth >= MAX_ASK_DEPTH) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Delegation depth limit reached (depth ${hub.depth}/${MAX_ASK_DEPTH}). Do this work yourself instead of asking another agent.`,
						},
					],
					details: { agentId: agent_id, error: "depth_limit" },
				};
			}

			try {
				const res = await hubRequest("POST", `/agents/${encodeURIComponent(agent_id)}/ask`, {
					question,
					timeout_secs: timeout_secs ?? 300,
				});
				const data = res.data as { reply?: string; error?: string };
				if (!res.ok || typeof data.reply !== "string") {
					const msg = data.error ?? `hub returned status ${res.status}`;
					return {
						content: [{ type: "text" as const, text: `Agent ${agent_id} could not answer: ${msg}` }],
						details: { agentId: agent_id, error: msg },
					};
				}
				const { text, truncated } = truncateReply(data.reply);
				return {
					content: [{ type: "text" as const, text: `Reply from ${agent_id}:\n${text}` }],
					details: { agentId: agent_id, reply: text, truncated },
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
