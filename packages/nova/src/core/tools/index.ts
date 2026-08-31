export {
	type AskUserQuestionDetails,
	type AskUserQuestionOption,
	type AskUserQuestionToolInput,
	createAskUserQuestionToolDefinition,
} from "./ask-user-question.ts";
export {
	type BashOperations,
	type BashSpawnContext,
	type BashSpawnHook,
	type BashToolDetails,
	type BashToolInput,
	type BashToolOptions,
	createBashTool,
	createBashToolDefinition,
	createLocalBashOperations,
} from "./bash.ts";
export {
	createEditTool,
	createEditToolDefinition,
	type EditOperations,
	type EditToolDetails,
	type EditToolInput,
	type EditToolOptions,
} from "./edit.ts";
export { withFileMutationQueue } from "./file-mutation-queue.ts";
export {
	createFindTool,
	createFindToolDefinition,
	type FindOperations,
	type FindToolDetails,
	type FindToolInput,
	type FindToolOptions,
} from "./find.ts";
export {
	createGrepTool,
	createGrepToolDefinition,
	type GrepOperations,
	type GrepToolDetails,
	type GrepToolInput,
	type GrepToolOptions,
} from "./grep.ts";
export {
	createHubAskAgentToolDefinition,
	createHubDelegateTaskToolDefinition,
	createHubListAgentsToolDefinition,
	createHubSpawnAgentToolDefinition,
	createHubWaitTasksToolDefinition,
	type HubAskAgentDetails,
	type HubAskAgentToolInput,
	type HubDelegateTaskDetails,
	type HubDelegateTaskInput,
	type HubListAgentsDetails,
	type HubSpawnAgentDetails,
	type HubSpawnAgentToolInput,
	type HubWaitTasksDetails,
	type HubWaitTasksInput,
	hubRequest,
} from "./hub.ts";
export {
	createLsTool,
	createLsToolDefinition,
	type LsOperations,
	type LsToolDetails,
	type LsToolInput,
	type LsToolOptions,
} from "./ls.ts";
export {
	createNovaDataToolDefinition,
	type NovaDataToolDetails,
	type NovaDataToolInput,
} from "./nova-data.ts";
export {
	createReadTool,
	createReadToolDefinition,
	type ReadOperations,
	type ReadToolDetails,
	type ReadToolInput,
	type ReadToolOptions,
} from "./read.ts";
export {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type TruncationOptions,
	type TruncationResult,
	truncateHead,
	truncateLine,
	truncateTail,
} from "./truncate.ts";
export {
	createWriteTool,
	createWriteToolDefinition,
	type WriteOperations,
	type WriteToolInput,
	type WriteToolOptions,
} from "./write.ts";

import type { AgentTool } from "@dongzijie1/pi-agent-core";
import type { ToolDefinition } from "../extensions/types.ts";
import { createAskUserQuestionToolDefinition } from "./ask-user-question.ts";
import { type BashToolOptions, createBashTool, createBashToolDefinition } from "./bash.ts";
import { createEditTool, createEditToolDefinition, type EditToolOptions } from "./edit.ts";
import { createFindTool, createFindToolDefinition, type FindToolOptions } from "./find.ts";
import { createGrepTool, createGrepToolDefinition, type GrepToolOptions } from "./grep.ts";
import { createHubDelegateTaskToolDefinition, createHubListAgentsToolDefinition } from "./hub.ts";
import { createLsTool, createLsToolDefinition, type LsToolOptions } from "./ls.ts";
import { createNovaDataToolDefinition } from "./nova-data.ts";
import { createReadTool, createReadToolDefinition, type ReadToolOptions } from "./read.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { createWriteTool, createWriteToolDefinition, type WriteToolOptions } from "./write.ts";

export type Tool = AgentTool<any>;
export type ToolDef = ToolDefinition<any, any>;
export type ToolName =
	| "read"
	| "bash"
	| "edit"
	| "write"
	| "grep"
	| "find"
	| "ls"
	| "nova_data"
	| "ask_user_question"
	| "hub_list_agents"
	| "hub_delegate_task";
export const allToolNames: Set<ToolName> = new Set([
	"read",
	"bash",
	"edit",
	"write",
	"grep",
	"find",
	"ls",
	"nova_data",
	"ask_user_question",
	"hub_list_agents",
	"hub_delegate_task",
]);

export interface ToolsOptions {
	read?: ReadToolOptions;
	bash?: BashToolOptions;
	write?: WriteToolOptions;
	edit?: EditToolOptions;
	grep?: GrepToolOptions;
	find?: FindToolOptions;
	ls?: LsToolOptions;
}

export function createToolDefinition(toolName: ToolName, cwd: string, options?: ToolsOptions): ToolDef {
	switch (toolName) {
		case "read":
			return createReadToolDefinition(cwd, options?.read);
		case "bash":
			return createBashToolDefinition(cwd, options?.bash);
		case "edit":
			return createEditToolDefinition(cwd, options?.edit);
		case "write":
			return createWriteToolDefinition(cwd, options?.write);
		case "grep":
			return createGrepToolDefinition(cwd, options?.grep);
		case "find":
			return createFindToolDefinition(cwd, options?.find);
		case "ls":
			return createLsToolDefinition(cwd, options?.ls);
		case "nova_data":
			return createNovaDataToolDefinition();
		case "ask_user_question":
			return createAskUserQuestionToolDefinition();
		case "hub_list_agents":
			return createHubListAgentsToolDefinition();
		case "hub_delegate_task":
			return createHubDelegateTaskToolDefinition();
		default:
			throw new Error(`Unknown tool name: ${toolName}`);
	}
}

export function createTool(toolName: ToolName, cwd: string, options?: ToolsOptions): Tool {
	switch (toolName) {
		case "read":
			return createReadTool(cwd, options?.read);
		case "bash":
			return createBashTool(cwd, options?.bash);
		case "edit":
			return createEditTool(cwd, options?.edit);
		case "write":
			return createWriteTool(cwd, options?.write);
		case "grep":
			return createGrepTool(cwd, options?.grep);
		case "find":
			return createFindTool(cwd, options?.find);
		case "ls":
			return createLsTool(cwd, options?.ls);
		case "nova_data":
			return wrapToolDefinition(createNovaDataToolDefinition());
		case "ask_user_question":
			return wrapToolDefinition(createAskUserQuestionToolDefinition());
		case "hub_list_agents":
			return wrapToolDefinition(createHubListAgentsToolDefinition());
		case "hub_delegate_task":
			return wrapToolDefinition(createHubDelegateTaskToolDefinition());
		default:
			throw new Error(`Unknown tool name: ${toolName}`);
	}
}

export function createCodingToolDefinitions(cwd: string, options?: ToolsOptions): ToolDef[] {
	return [
		createReadToolDefinition(cwd, options?.read),
		createBashToolDefinition(cwd, options?.bash),
		createEditToolDefinition(cwd, options?.edit),
		createWriteToolDefinition(cwd, options?.write),
	];
}

export function createReadOnlyToolDefinitions(cwd: string, options?: ToolsOptions): ToolDef[] {
	return [
		createReadToolDefinition(cwd, options?.read),
		createGrepToolDefinition(cwd, options?.grep),
		createFindToolDefinition(cwd, options?.find),
		createLsToolDefinition(cwd, options?.ls),
	];
}

export function createAllToolDefinitions(cwd: string, options?: ToolsOptions): Record<ToolName, ToolDef> {
	return {
		read: createReadToolDefinition(cwd, options?.read),
		bash: createBashToolDefinition(cwd, options?.bash),
		edit: createEditToolDefinition(cwd, options?.edit),
		write: createWriteToolDefinition(cwd, options?.write),
		grep: createGrepToolDefinition(cwd, options?.grep),
		find: createFindToolDefinition(cwd, options?.find),
		ls: createLsToolDefinition(cwd, options?.ls),
		nova_data: createNovaDataToolDefinition(),
		ask_user_question: createAskUserQuestionToolDefinition(),
		hub_list_agents: createHubListAgentsToolDefinition(),
		hub_delegate_task: createHubDelegateTaskToolDefinition(),
	};
}

export function createCodingTools(cwd: string, options?: ToolsOptions): Tool[] {
	return [
		createReadTool(cwd, options?.read),
		createBashTool(cwd, options?.bash),
		createEditTool(cwd, options?.edit),
		createWriteTool(cwd, options?.write),
	];
}

export function createReadOnlyTools(cwd: string, options?: ToolsOptions): Tool[] {
	return [
		createReadTool(cwd, options?.read),
		createGrepTool(cwd, options?.grep),
		createFindTool(cwd, options?.find),
		createLsTool(cwd, options?.ls),
	];
}

export function createAllTools(cwd: string, options?: ToolsOptions): Record<ToolName, Tool> {
	return {
		read: createReadTool(cwd, options?.read),
		bash: createBashTool(cwd, options?.bash),
		edit: createEditTool(cwd, options?.edit),
		write: createWriteTool(cwd, options?.write),
		grep: createGrepTool(cwd, options?.grep),
		find: createFindTool(cwd, options?.find),
		ls: createLsTool(cwd, options?.ls),
		nova_data: wrapToolDefinition(createNovaDataToolDefinition()),
		ask_user_question: wrapToolDefinition(createAskUserQuestionToolDefinition()),
		hub_list_agents: wrapToolDefinition(createHubListAgentsToolDefinition()),
		hub_delegate_task: wrapToolDefinition(createHubDelegateTaskToolDefinition()),
	};
}

/**
 * Tools active by default in a new session. Hub collaboration tools are
 * included only when the agent runs under Nova Studio (NOVA_HUB_URL is
 * injected by the host); a standalone CLI never sees them.
 */
export function createDefaultActiveToolNames(): ToolName[] {
	const names: ToolName[] = ["read", "bash", "edit", "write", "ask_user_question", "nova_data"];
	if (process.env.NOVA_HUB_URL) {
		names.push("hub_list_agents", "hub_delegate_task");
	}
	return names;
}
