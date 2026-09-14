import { describe, expect, test } from "vitest";
import { buildSystemPrompt } from "../src/core/system-prompt.ts";

describe("buildSystemPrompt", () => {
	test("shows file paths guideline even with no tools", () => {
		const prompt = buildSystemPrompt({
			selectedTools: [],
			contextFiles: [],
			skills: [],
			cwd: process.cwd(),
		});

		expect(prompt).toContain("Show file paths clearly");
	});

	test("omits the Available tools section (tools are passed via the API tools parameter)", () => {
		const prompt = buildSystemPrompt({
			toolSnippets: {
				read: "Read file contents",
				bash: "Execute bash commands",
				edit: "Make surgical edits",
				write: "Create or overwrite files",
			},
			contextFiles: [],
			skills: [],
			cwd: process.cwd(),
		});

		expect(prompt).not.toContain("Available tools:");
		expect(prompt).not.toContain("- read:");
		expect(prompt).not.toContain("- bash:");
		expect(prompt).not.toContain("- edit:");
		expect(prompt).not.toContain("- write:");
	});

	test("omits tool promptGuidelines from the Guidelines section", () => {
		const prompt = buildSystemPrompt({
			promptGuidelines: ["Use dynamic_tool for project summaries."],
			contextFiles: [],
			skills: [],
			cwd: process.cwd(),
		});

		expect(prompt).not.toContain("Use dynamic_tool for project summaries.");
		expect(prompt).toContain("Be concise in your responses");
		expect(prompt).toContain("Show file paths clearly when working with files");
	});

	test("instructs models to resolve nova docs and examples under absolute base paths", () => {
		const prompt = buildSystemPrompt({
			contextFiles: [],
			skills: [],
			cwd: process.cwd(),
		});

		expect(prompt).toContain("Nova documentation (consult only for questions or changes about Nova itself):");
		// The doc roots are rendered as absolute paths, not as paths relative to the project.
		expect(prompt).toMatch(/- Reference docs: [/\\]/);
		expect(prompt).toMatch(/- Examples: [/\\]/);
		expect(prompt).toContain(
			"- Resolve docs/... under Reference docs and examples/... under Examples, not relative to the current project",
		);
		expect(prompt).toContain("models/providers (docs/models.md, docs/custom-provider.md)");
	});
});
