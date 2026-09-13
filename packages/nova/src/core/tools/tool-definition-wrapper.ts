import type { AgentTool } from "@dongzijie1/pi-agent-core";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import { TOOL_RESULT_BACKSTOP_MAX_BYTES, TOOL_RESULT_BACKSTOP_MAX_LINES } from "./limits.ts";
import { formatSize, truncateHead } from "./truncate.ts";

type ToolResultContentPart = { type: string; text?: string; [key: string]: unknown };

/**
 * Apply the built-in tools' output cap to every tool result.
 *
 * Built-ins truncate themselves, but extension and SDK tools do not: without this a single
 * verbose custom tool can push an unbounded amount of text into the context window.
 */
function capToolResultContent<TResult extends { content?: unknown }>(result: TResult): TResult {
	if (!Array.isArray(result.content)) return result;
	let truncatedAny = false;
	const content = (result.content as ToolResultContentPart[]).map((part) => {
		if (part?.type !== "text" || typeof part.text !== "string") return part;
		const truncation = truncateHead(part.text, {
			maxLines: TOOL_RESULT_BACKSTOP_MAX_LINES,
			maxBytes: TOOL_RESULT_BACKSTOP_MAX_BYTES,
		});
		if (!truncation.truncated) return part;
		truncatedAny = true;
		const shown =
			truncation.truncatedBy === "lines"
				? `${truncation.outputLines} of ${truncation.totalLines} lines`
				: `${formatSize(TOOL_RESULT_BACKSTOP_MAX_BYTES)} limit`;
		return { ...part, text: `${truncation.content}\n\n[Tool output truncated: showing ${shown}]` };
	});
	return truncatedAny ? ({ ...result, content } as TResult) : result;
}

/** Wrap a ToolDefinition into an AgentTool for the core runtime. */
export function wrapToolDefinition<TDetails = unknown>(
	definition: ToolDefinition<any, TDetails>,
	ctxFactory?: () => ExtensionContext,
): AgentTool<any, TDetails> {
	return {
		name: definition.name,
		label: definition.label,
		description: definition.description,
		parameters: definition.parameters,
		constrainedSampling: definition.constrainedSampling,
		prepareArguments: definition.prepareArguments,
		executionMode: definition.executionMode,
		execute: async (toolCallId, params, signal, onUpdate, ctx?: ExtensionContext) =>
			capToolResultContent(
				await definition.execute(toolCallId, params, signal, onUpdate, ctx ?? (ctxFactory?.() as ExtensionContext)),
			),
	};
}

/** Wrap multiple ToolDefinitions into AgentTools for the core runtime. */
export function wrapToolDefinitions(
	definitions: ToolDefinition<any, any>[],
	ctxFactory?: () => ExtensionContext,
): AgentTool<any>[] {
	return definitions.map((definition) => wrapToolDefinition(definition, ctxFactory));
}

/**
 * Synthesize a minimal ToolDefinition from an AgentTool.
 *
 * This keeps AgentSession's internal registry definition-first even when a caller
 * provides plain AgentTool overrides that do not include prompt metadata or renderers.
 */
export function createToolDefinitionFromAgentTool(tool: AgentTool<any>): ToolDefinition<any, unknown> {
	return {
		name: tool.name,
		label: tool.label,
		description: tool.description,
		parameters: tool.parameters as any,
		constrainedSampling: tool.constrainedSampling,
		prepareArguments: tool.prepareArguments,
		executionMode: tool.executionMode,
		execute: async (toolCallId, params, signal, onUpdate) => tool.execute(toolCallId, params, signal, onUpdate),
	};
}
