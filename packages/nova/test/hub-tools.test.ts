import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import {
	createHubAskAgentToolDefinition,
	createHubDelegateTaskToolDefinition,
	createHubListAgentsToolDefinition,
	createHubSpawnAgentToolDefinition,
	createHubWaitTasksToolDefinition,
	runWithHubAgentContext,
} from "../src/core/tools/hub.ts";

const ctx = {} as ExtensionContext;

const HUB_ENV = {
	NOVA_HUB_URL: "http://127.0.0.1:9528",
	NOVA_HUB_TOKEN: "test-token",
	NOVA_AGENT_ID: "agent-self1",
	NOVA_ASK_DEPTH: "0",
};

const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
	for (const key of Object.keys(HUB_ENV)) {
		savedEnv[key] = process.env[key];
		process.env[key] = HUB_ENV[key as keyof typeof HUB_ENV];
	}
});

describe("asynchronous Agent tasks", () => {
	it("delegates to a newly created agent and returns immediately", async () => {
		const fetchMock = stubFetch({
			task_id: "task-123",
			agent_id: "agent-new2",
			created_agent: true,
			status: "running",
		});

		const result = await createHubDelegateTaskToolDefinition().execute(
			"t1",
			{ task: "inspect the parser", cwd: "/tmp/project" },
			undefined,
			undefined,
			ctx,
		);

		expect(result.details).toMatchObject({ taskId: "task-123", agentId: "agent-new2", createdAgent: true });
		const [url, init] = fetchCallArgs(fetchMock, 0);
		expect(url).toBe("http://127.0.0.1:9528/tasks/delegate");
		expect(JSON.parse(init.body as string)).toMatchObject({
			task: "inspect the parser",
			cwd: "/tmp/project",
			source_agent_id: "agent-self1",
			request_depth: 1,
			visited_agent_ids: ["agent-self1"],
			depth: 1,
		});
	});

	it("waits for any delegated task and returns structured results", async () => {
		const fetchMock = stubFetch({
			tasks: [
				{ task_id: "task-1", agent_id: "agent-a", status: "completed", result: "done" },
				{ task_id: "task-2", agent_id: "agent-b", status: "running" },
			],
			timed_out: false,
		});

		const result = await createHubWaitTasksToolDefinition().execute(
			"t2",
			{ task_ids: ["task-1", "task-2"], wait_for: "any" },
			undefined,
			undefined,
			ctx,
		);

		expect(resultText(result)).toContain("task-1 (agent-a) [completed]: done");
		expect(result.details?.tasks).toHaveLength(2);
		const [url, init] = fetchCallArgs(fetchMock, 0);
		expect(url).toBe("http://127.0.0.1:9528/tasks/wait");
		expect(JSON.parse(init.body as string)).toEqual({
			task_ids: ["task-1", "task-2"],
			wait_for: "any",
			timeout_secs: 30,
		});
	});
});

afterEach(() => {
	for (const key of Object.keys(HUB_ENV)) {
		if (savedEnv[key] === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = savedEnv[key];
		}
	}
	vi.unstubAllGlobals();
});

function stubFetch(payload: unknown, status = 200) {
	const fn = vi.fn(
		async () =>
			new Response(JSON.stringify(payload), {
				status,
				headers: { "content-type": "application/json" },
			}),
	);
	vi.stubGlobal("fetch", fn);
	return fn;
}

/** Extract the first text content part of a tool result (all hub tools return one). */
function resultText(result: { content: Array<{ type: string; text?: string }> }): string {
	const first = result.content[0];
	return first && first.type === "text" ? (first.text ?? "") : "";
}

function fetchCallArgs(fn: ReturnType<typeof stubFetch>, i: number): [string, RequestInit] {
	return fn.mock.calls[i] as unknown as [string, RequestInit];
}

describe("hub tools without hub env", () => {
	it("report collaboration as unavailable", async () => {
		delete process.env.NOVA_HUB_URL;

		const list = await createHubListAgentsToolDefinition().execute("t1", {}, undefined, undefined, ctx);
		expect(resultText(list)).toContain("not available");

		const spawn = await createHubSpawnAgentToolDefinition().execute("t2", { cwd: "/tmp" }, undefined, undefined, ctx);
		expect(resultText(spawn)).toContain("not available");

		const ask = await createHubAskAgentToolDefinition().execute(
			"t3",
			{ agent_id: "agent-x", question: "hi" },
			undefined,
			undefined,
			ctx,
		);
		expect(resultText(ask)).toContain("not available");
	});
});

describe("hub_list_agents", () => {
	it("lists agents and marks the caller", async () => {
		const fetchMock = stubFetch([
			{ id: "agent-self1", status: "idle", cwd: "/a", model: "m1" },
			{ id: "agent-other2", status: "streaming", cwd: "/b", model: null },
		]);

		const result = await createHubListAgentsToolDefinition().execute("t1", {}, undefined, undefined, ctx);

		expect(resultText(result)).toContain("agent-self1 (you)");
		expect(resultText(result)).toContain("agent-other2");
		expect(result.details?.agents).toHaveLength(2);

		const [url, init] = fetchCallArgs(fetchMock, 0);
		expect(url).toBe("http://127.0.0.1:9528/agents");
		expect((init.headers as Record<string, string>)["x-nova-token"]).toBe("test-token");
	});
});

describe("hub_spawn_agent", () => {
	it("uses the AgentSession-scoped identity in a shared process", async () => {
		const fetchMock = stubFetch({ agent_id: "agent-child", info: {} });

		await runWithHubAgentContext({ agentId: "agent-scoped", depth: 1 }, () =>
			createHubSpawnAgentToolDefinition().execute("t1", { cwd: "/tmp" }, undefined, undefined, ctx),
		);

		const [, init] = fetchCallArgs(fetchMock, 0);
		expect(JSON.parse(init.body as string)).toMatchObject({
			depth: 2,
			parent_agent_id: "agent-scoped",
		});
	});

	it("spawns and returns the new agent id", async () => {
		const fetchMock = stubFetch({ agent_id: "agent-new99", info: {} });

		const result = await createHubSpawnAgentToolDefinition().execute(
			"t1",
			{ cwd: "/tmp/proj", model: "mimo" },
			undefined,
			undefined,
			ctx,
		);

		expect(resultText(result)).toContain("agent-new99");
		expect(result.details?.agentId).toBe("agent-new99");

		const [url, init] = fetchCallArgs(fetchMock, 0);
		expect(url).toBe("http://127.0.0.1:9528/agents");
		expect(JSON.parse(init.body as string)).toEqual({
			cwd: "/tmp/proj",
			model: "mimo",
			depth: 1,
			parent_agent_id: "agent-self1",
		});
	});

	it("propagates depth+1 when the caller is itself an agent", async () => {
		process.env.NOVA_ASK_DEPTH = "1";
		const fetchMock = stubFetch({ agent_id: "agent-deep", info: {} });

		await createHubSpawnAgentToolDefinition().execute("t1", { cwd: "/tmp" }, undefined, undefined, ctx);

		const [url, init] = fetchCallArgs(fetchMock, 0);
		expect(url).toBe("http://127.0.0.1:9528/agents");
		expect(JSON.parse(init.body as string)).toEqual({
			cwd: "/tmp",
			depth: 2,
			parent_agent_id: "agent-self1",
		});
	});

	it("refuses to spawn at the depth limit", async () => {
		process.env.NOVA_ASK_DEPTH = "2";
		const fetchMock = stubFetch({});

		const result = await createHubSpawnAgentToolDefinition().execute(
			"t1",
			{ cwd: "/tmp" },
			undefined,
			undefined,
			ctx,
		);

		expect(resultText(result)).toContain("depth limit");
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe("hub_ask_agent", () => {
	it("asks and returns the reply", async () => {
		const fetchMock = stubFetch({ reply: "the answer is 42" });

		const result = await createHubAskAgentToolDefinition().execute(
			"t1",
			{ agent_id: "agent-other2", question: "what is the answer?" },
			undefined,
			undefined,
			ctx,
		);

		expect(resultText(result)).toContain("the answer is 42");
		expect(result.details?.truncated).toBe(false);

		const [url, init] = fetchCallArgs(fetchMock, 0);
		expect(url).toBe("http://127.0.0.1:9528/agents/agent-other2/ask");
		expect(JSON.parse(init.body as string)).toMatchObject({
			question: "what is the answer?",
			timeout_secs: 300,
			source_agent_id: "agent-self1",
			request_depth: 1,
			visited_agent_ids: ["agent-self1"],
			request_id: expect.any(String),
		});
	});

	it("preserves the request id while advancing a forwarded request chain", async () => {
		const fetchMock = stubFetch({ reply: "forwarded answer" });

		await runWithHubAgentContext(
			{
				agentId: "agent-self1",
				depth: 0,
				requestId: "request-root",
				requestDepth: 0,
				visitedAgentIds: ["agent-root0"],
			},
			() =>
				createHubAskAgentToolDefinition().execute(
					"t1",
					{ agent_id: "agent-other2", question: "forward this" },
					undefined,
					undefined,
					ctx,
				),
		);

		const [, init] = fetchCallArgs(fetchMock, 0);
		expect(JSON.parse(init.body as string)).toMatchObject({
			request_id: "request-root",
			request_depth: 1,
			visited_agent_ids: ["agent-root0", "agent-self1"],
		});
	});

	it("truncates long replies", async () => {
		stubFetch({ reply: "x".repeat(6000) });

		const result = await createHubAskAgentToolDefinition().execute(
			"t1",
			{ agent_id: "agent-other2", question: "q" },
			undefined,
			undefined,
			ctx,
		);

		expect(result.details?.truncated).toBe(true);
		expect(result.details?.reply?.length).toBeLessThan(4300);
	});

	it("refuses to ask itself", async () => {
		const fetchMock = stubFetch({});

		const result = await createHubAskAgentToolDefinition().execute(
			"t1",
			{ agent_id: "agent-self1", question: "q" },
			undefined,
			undefined,
			ctx,
		);

		expect(resultText(result)).toContain("yourself");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("blocks a request that revisits an agent in the active chain", async () => {
		const fetchMock = stubFetch({ reply: "should not happen" });

		const result = await runWithHubAgentContext(
			{
				agentId: "agent-other2",
				depth: 1,
				requestId: "request-a-b",
				requestDepth: 1,
				visitedAgentIds: ["agent-self1", "agent-other2"],
			},
			() =>
				createHubAskAgentToolDefinition().execute(
					"t1",
					{ agent_id: "agent-self1", question: "loop back" },
					undefined,
					undefined,
					ctx,
				),
		);

		expect(result.details?.errorCode).toBe("cycle_detected");
		expect(resultText(result)).toContain("cycle blocked");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("refuses to ask at the depth limit", async () => {
		process.env.NOVA_ASK_DEPTH = "2";
		const fetchMock = stubFetch({});

		const result = await createHubAskAgentToolDefinition().execute(
			"t1",
			{ agent_id: "agent-other2", question: "q" },
			undefined,
			undefined,
			ctx,
		);

		expect(resultText(result)).toContain("depth limit");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("uses request depth rather than process depth for forwarded asks", async () => {
		const fetchMock = stubFetch({});

		const result = await runWithHubAgentContext(
			{
				agentId: "agent-other2",
				depth: 0,
				requestDepth: 2,
				visitedAgentIds: ["agent-self1", "agent-other2"],
			},
			() =>
				createHubAskAgentToolDefinition().execute(
					"t1",
					{ agent_id: "agent-third3", question: "go deeper" },
					undefined,
					undefined,
					ctx,
				),
		);

		expect(result.details?.errorCode).toBe("depth_limit");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("surfaces hub errors", async () => {
		stubFetch({ error: "Agent not found" }, 404);

		const result = await createHubAskAgentToolDefinition().execute(
			"t1",
			{ agent_id: "agent-nope", question: "q" },
			undefined,
			undefined,
			ctx,
		);

		expect(resultText(result)).toContain("Agent not found");
	});
});
