import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listInstalledAgentSkills } from "../src/core/persistent-agent-skills.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function skill(directory: string, name: string, description: string) {
	mkdirSync(directory, { recursive: true });
	writeFileSync(
		join(directory, "SKILL.md"),
		`---\nname: ${name}\ndescription: ${description}\n---\n# Instructions\nOnly read this skill when selected.\n`,
	);
}

describe("persistent Agent installed skill catalog", () => {
	it("discovers global and configured skills using the runtime loader, excluding project-local skills", async () => {
		const root = mkdtempSync(join(tmpdir(), "nova-agent-skills-"));
		roots.push(root);
		const agentDir = join(root, "agent");
		skill(join(agentDir, "skills", "code-review"), "code-review", "Review code for correctness");
		const configured = join(root, "research");
		skill(configured, "research", "Research source documents");
		skill(join(agentDir, ".nova", "skills", "project-only"), "project-only", "This project only");
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ skills: [configured] }));
		const catalog = await listInstalledAgentSkills(agentDir);
		expect(catalog.filter((item) => item.filePath.startsWith(root)).map((item) => item.name)).toEqual([
			"code-review",
			"research",
		]);
		expect(catalog.some((item) => item.name === "project-only")).toBe(false);
		expect(catalog.find((item) => item.name === "code-review")).toMatchObject({
			description: "Review code for correctness",
			filePath: join(agentDir, "skills", "code-review", "SKILL.md"),
		});
	});

	it("does not execute extension code when discovering selectable skills", async () => {
		const root = mkdtempSync(join(tmpdir(), "nova-agent-skills-metadata-"));
		roots.push(root);
		const marker = join(root, "extension-executed");
		mkdirSync(join(root, "extensions"));
		writeFileSync(
			join(root, "extensions", "side-effect.ts"),
			`import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "executed"); export default function () {}`,
		);
		skill(join(root, "skills", "safe-skill"), "safe-skill", "Read installed metadata");
		expect((await listInstalledAgentSkills(root)).some((item) => item.name === "safe-skill")).toBe(true);
		expect(existsSync(marker)).toBe(false);
	});
});
