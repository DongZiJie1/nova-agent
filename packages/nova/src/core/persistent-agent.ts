import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export interface PersistentAgent {
	id: string;
	name: string;
	tools: string[];
	skills: string[];
	instructions: string;
	configDir: string;
}

/** Resolve only canonical UUID profile identifiers; never accept arbitrary paths. */
export function persistentAgentDirectory(configDir: string, id: string): string {
	if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) {
		throw new Error("Invalid persistent Agent id");
	}
	return join(configDir, "agents", id);
}

export function loadPersistentAgent(agentDir: string): PersistentAgent | undefined {
	if (basename(dirname(agentDir)) !== "agents") return undefined;
	const id = basename(agentDir);
	const configDir = dirname(dirname(agentDir));
	persistentAgentDirectory(configDir, id);
	const raw: unknown = JSON.parse(readFileSync(join(agentDir, "profile.json"), "utf8"));
	if (typeof raw !== "object" || raw === null) throw new Error("Invalid Agent profile");
	const value = raw as Record<string, unknown>;
	if (
		value.id !== id ||
		typeof value.name !== "string" ||
		!Array.isArray(value.tools) ||
		!value.tools.every((item) => typeof item === "string") ||
		!Array.isArray(value.skills) ||
		!value.skills.every((item) => typeof item === "string")
	) {
		throw new Error("Invalid Agent profile");
	}
	return {
		id,
		name: value.name,
		tools: value.tools,
		skills: value.skills,
		instructions: readFileSync(join(agentDir, "AGENTS.md"), "utf8"),
		configDir,
	};
}
