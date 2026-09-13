import type { ExtensionUIContext } from "./extensions/types.ts";

export type ToolPermissionMode = "allow" | "ask" | "edits";

export interface ToolPermissionRequest {
	toolCallId: string;
	toolName: string;
	args: unknown;
	cwd: string;
}

export interface ToolPermissionResult {
	allowed: boolean;
	reason?: string;
	/** True when the user was actually prompted (auto-approved calls are never prompted). */
	prompted?: boolean;
}

export interface ToolPermissionManagerOptions {
	mode?: ToolPermissionMode;
	timeoutMs?: number;
}

const READ_ONLY_TOOLS = new Set([
	"read",
	"grep",
	"find",
	"ls",
	"ask_user_question",
	"hub_list_agents",
	"hub_wait_tasks",
]);

const EDIT_TOOLS = new Set(["edit", "write"]);

export const TOOL_PERMISSION_MODES = ["ask", "edits", "allow"] as const;

export function isValidToolPermissionMode(mode: string): mode is ToolPermissionMode {
	return (TOOL_PERMISSION_MODES as readonly string[]).includes(mode);
}

function isReadOnlyRequest(request: ToolPermissionRequest): boolean {
	if (READ_ONLY_TOOLS.has(request.toolName)) return true;
	if (request.toolName !== "nova_data" || !request.args || typeof request.args !== "object") return false;
	const action = (request.args as { action?: unknown }).action;
	return action === "list_projects" || action === "list_sessions" || action === "read_session";
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
	private _mode: ToolPermissionMode;
	readonly timeoutMs: number;

	constructor(options: ToolPermissionManagerOptions = {}) {
		this._mode = options.mode ?? "ask";
		this.timeoutMs = options.timeoutMs ?? 120_000;
	}

	get mode(): ToolPermissionMode {
		return this._mode;
	}

	setMode(mode: ToolPermissionMode): void {
		this._mode = mode;
	}

	async check(
		request: ToolPermissionRequest,
		uiContext: ExtensionUIContext | undefined,
		signal?: AbortSignal,
	): Promise<ToolPermissionResult> {
		if (this._mode === "allow") return { allowed: true };
		if (isReadOnlyRequest(request)) return { allowed: true, reason: "Read-only tool auto-approved" };
		if (this._mode === "edits" && EDIT_TOOLS.has(request.toolName)) {
			return { allowed: true, reason: "Edit tool auto-approved in edits mode" };
		}
		if (signal?.aborted) return { allowed: false, reason: "Tool permission request was aborted" };
		if (!uiContext) return { allowed: false, reason: "Tool permission requires an interactive user interface" };

		try {
			const allowed = await uiContext.confirm("允许执行工具？", formatPermissionMessage(request), {
				signal,
				timeout: this.timeoutMs,
			});
			return allowed
				? { allowed: true, prompted: true }
				: {
						allowed: false,
						prompted: true,
						reason: signal?.aborted ? "Tool permission request was aborted" : "User denied tool execution",
					};
		} catch (error) {
			return {
				allowed: false,
				prompted: true,
				reason: `Tool permission check failed: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
	}
}
