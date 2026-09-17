import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "../config.ts";

export interface UserMemorySection {
	id: string;
	title: string;
	content: string;
	updatedAt: string;
}
export interface UserMemoryProfile {
	version: 3;
	enabled: boolean;
	sections: UserMemorySection[];
}

const SENSITIVE_PATTERNS = [
	/\b(?:api[ _-]?key|access[ _-]?token|secret|password|passwd|private[ _-]?key)\b/i,
	/\b(?:sk|pk)_[a-z0-9_-]{16,}\b/i,
	/\b\d{13,19}\b/,
];
const emptyProfile = (): UserMemoryProfile => ({ version: 3, enabled: true, sections: [] });

function migrate(value: unknown): UserMemoryProfile {
	if (!value || typeof value !== "object") return emptyProfile();
	const source = value as Record<string, unknown>;
	if (
		(source.version === 2 || source.version === 3) &&
		typeof source.enabled === "boolean" &&
		Array.isArray(source.sections)
	) {
		const sections = source.sections.filter((section): section is UserMemorySection => {
			if (!section || typeof section !== "object") return false;
			const item = section as Partial<UserMemorySection>;
			return (
				typeof item.id === "string" &&
				typeof item.title === "string" &&
				typeof item.content === "string" &&
				typeof item.updatedAt === "string"
			);
		});
		return { version: 3, enabled: source.enabled, sections };
	}
	const legacy = source as { enabled?: unknown; memories?: Array<{ category?: string; content?: string }> };
	if (!Array.isArray(legacy.memories)) return emptyProfile();
	const now = new Date().toISOString();
	const identity = legacy.memories
		.filter((item) => item.category === "identity" && item.content)
		.map((item) => item.content)
		.join("；");
	const preferences = legacy.memories
		.filter((item) => item.category === "preference" && item.content)
		.map((item) => item.content)
		.join("；");
	const sections: UserMemorySection[] = [];
	if (identity) sections.push({ id: "legacy-overview", title: "概览", content: identity, updatedAt: now });
	if (preferences)
		sections.push({ id: "legacy-preferences", title: "协作偏好", content: preferences, updatedAt: now });
	return { version: 3, enabled: legacy.enabled !== false, sections };
}

export class UserMemoryStore {
	readonly path: string;
	constructor(agentDir: string = getAgentDir()) {
		this.path = join(agentDir, "user-memory.json");
	}
	read(): UserMemoryProfile {
		if (!existsSync(this.path)) return emptyProfile();
		try {
			return migrate(JSON.parse(readFileSync(this.path, "utf8")));
		} catch {
			return emptyProfile();
		}
	}
	list(): UserMemorySection[] {
		return this.read().sections;
	}
	isEnabled(): boolean {
		return this.read().enabled;
	}
	setEnabled(enabled: boolean): void {
		const profile = this.read();
		profile.enabled = enabled;
		this.write(profile);
	}
	upsertSection(id: string | undefined, title: string, content: string): UserMemorySection {
		const profile = this.read();
		if (!profile.enabled) throw new Error("User memory is disabled");
		const normalizedTitle = title.trim();
		const normalized = content.trim().replace(/\s+/g, " ");
		if (!normalizedTitle) throw new Error("Memory section title must not be empty");
		if (!normalized) throw new Error("Memory section content must not be empty");
		if (SENSITIVE_PATTERNS.some((pattern) => pattern.test(normalized)))
			throw new Error("Sensitive information must not be saved to user memory");
		const updatedAt = new Date().toISOString();
		const existing = id ? profile.sections.find((section) => section.id === id) : undefined;
		if (id && !existing) throw new Error(`Memory section not found: ${id}`);
		if (existing) {
			existing.title = normalizedTitle;
			existing.content = normalized;
			existing.updatedAt = updatedAt;
		} else
			profile.sections.push({
				id: `section_${randomUUID()}`,
				title: normalizedTitle,
				content: normalized,
				updatedAt,
			});
		this.write(profile);
		return existing ?? profile.sections[profile.sections.length - 1];
	}
	deleteSection(id: string): boolean {
		const profile = this.read();
		const next = profile.sections.filter((section) => section.id !== id);
		if (next.length === profile.sections.length) return false;
		profile.sections = next;
		this.write(profile);
		return true;
	}
	toPrompt(): string | undefined {
		const profile = this.read();
		if (!profile.enabled || profile.sections.length === 0) return undefined;
		const sections = profile.sections
			.map((section) => `## ${section.title}\n<section_id>${section.id}</section_id>\n${section.content}`)
			.join("\n\n");
		return `<user_memory>\nThis is the user's durable profile. Use it to personalize responses, but do not claim it was stated in this conversation.\n\n${sections}\n</user_memory>`;
	}
	private write(profile: UserMemoryProfile): void {
		const directory = dirname(this.path);
		if (!existsSync(directory)) mkdirSync(directory, { recursive: true, mode: 0o700 });
		const temporaryPath = `${this.path}.${process.pid}.tmp`;
		writeFileSync(temporaryPath, `${JSON.stringify(profile, null, "\t")}\n`, { encoding: "utf8", mode: 0o600 });
		chmodSync(temporaryPath, 0o600);
		renameSync(temporaryPath, this.path);
		chmodSync(this.path, 0o600);
	}
}
