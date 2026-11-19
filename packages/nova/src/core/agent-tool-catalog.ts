import type { AgentSession } from "./agent-session.ts";

/** The live registry is the sole source of selectable tools, including extension tools. */
export function listAgentTools(session: Pick<AgentSession, "getAllTools" | "getActiveToolNames">) {
	const enabled = new Set(session.getActiveToolNames());
	return session.getAllTools().map(({ name, description, sourceInfo }) => ({
		name,
		description,
		sourceInfo,
		defaultEnabled: enabled.has(name),
	}));
}
