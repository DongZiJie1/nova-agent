import type { ExtensionUIContext } from "./extensions/types.ts";

export type ToolPermissionMode = "allow" | "ask";

export interface ToolPermissionRequest {
	toolCallId: string;
	toolName: string;
	args: unknown;
	cwd: string;
}

export interface ToolPermissionResult {
	allowed: boolean;
	reason?: string;
}

export interface ToolPermissionManagerOptions {
	mode?: ToolPermissionMode;
	timeoutMs?: number;
}

function formatPermissionMessage(request: ToolPermissionRequest): string {
	let serializedArgs: string;
	try {
		serializedArgs = JSON.stringify(request.args, null, 2) ?? String(request.args);
	} catch {
		serializedArgs = String(request.args);
	}
	const maxLength = 8_000;
	const args = serializedArgs.length > maxLength ? `${serializedArgs.slice(0, maxLength)}\n…` : serializedArgs;
	return `工具：${request.toolName}\n工作目录：${request.cwd}\n\n参数：\n${args}`;
}

export class ToolPermissionManager {
	readonly mode: ToolPermissionMode;
	readonly timeoutMs: number;

	constructor(options: ToolPermissionManagerOptions = {}) {
		this.mode = options.mode ?? "ask";
		this.timeoutMs = options.timeoutMs ?? 120_000;
	}

	async check(
		request: ToolPermissionRequest,
		uiContext: ExtensionUIContext | undefined,
		signal?: AbortSignal,
	): Promise<ToolPermissionResult> {
		if (this.mode === "allow") return { allowed: true };
		if (signal?.aborted) return { allowed: false, reason: "Tool permission request was aborted" };
		if (!uiContext) return { allowed: false, reason: "Tool permission requires an interactive user interface" };

		try {
			const allowed = await uiContext.confirm("允许执行工具？", formatPermissionMessage(request), {
				signal,
				timeout: this.timeoutMs,
			});
			return allowed
				? { allowed: true }
				: {
						allowed: false,
						reason: signal?.aborted ? "Tool permission request was aborted" : "User denied tool execution",
					};
		} catch (error) {
			return {
				allowed: false,
				reason: `Tool permission check failed: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
	}
}
