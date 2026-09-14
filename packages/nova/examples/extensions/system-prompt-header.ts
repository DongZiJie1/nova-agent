/**
 * Displays a status widget showing the system prompt length.
 *
 * Demonstrates ctx.getSystemPrompt() for accessing the effective system prompt.
 */
import type { ExtensionAPI } from "@dongzijie1/nova";

export default function (nova: ExtensionAPI) {
	nova.on("agent_start", (_event, ctx) => {
		const prompt = ctx.getSystemPrompt();
		ctx.ui.setStatus("system-prompt", `System: ${prompt.length} chars`);
	});

	nova.on("session_shutdown", (_event, ctx) => {
		ctx.ui.setStatus("system-prompt", undefined);
	});
}
