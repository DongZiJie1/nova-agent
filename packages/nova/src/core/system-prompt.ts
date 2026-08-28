/**
 * System prompt construction and project context loading
 */

import { getDocsPath, getExamplesPath, getReadmePath } from "../config.ts";
import { formatSkillsForPrompt, type Skill } from "./skills.ts";

export interface BuildSystemPromptOptions {
	/** Custom system prompt (replaces default). */
	customPrompt?: string;
	/** Tools to include in prompt. Default: [read, bash, edit, write] */
	selectedTools?: string[];
	/** Optional one-line tool snippets keyed by tool name. */
	toolSnippets?: Record<string, string>;
	/** Additional guideline bullets appended to the default system prompt guidelines. */
	promptGuidelines?: string[];
	/** Text to append to system prompt. */
	appendSystemPrompt?: string;
	/** Working directory. */
	cwd: string;
	/** Pre-loaded context files. */
	contextFiles?: Array<{ path: string; content: string }>;
	/** Pre-loaded skills. */
	skills?: Skill[];
}

/** Build the system prompt with tools, guidelines, and context */
export function buildSystemPrompt(options: BuildSystemPromptOptions): string {
	const {
		customPrompt,
		selectedTools,
		appendSystemPrompt,
		cwd,
		contextFiles: providedContextFiles,
		skills: providedSkills,
	} = options;
	const promptCwd = cwd.replace(/\\/g, "/");

	const appendSection = appendSystemPrompt ? `\n\n${appendSystemPrompt}` : "";

	const contextFiles = providedContextFiles ?? [];
	const skills = providedSkills ?? [];

	if (customPrompt) {
		let prompt = customPrompt;

		if (appendSection) {
			prompt += appendSection;
		}

		// Append project context files
		if (contextFiles.length > 0) {
			prompt += "\n\n<project_context>\n\n";
			prompt += "Project-specific instructions and guidelines:\n\n";
			for (const { path: filePath, content } of contextFiles) {
				prompt += `<project_instructions path="${filePath}">\n${content}\n</project_instructions>\n\n`;
			}
			prompt += "</project_context>\n";
		}

		// Append skills section (only if read tool is available)
		const customPromptHasRead = !selectedTools || selectedTools.includes("read");
		if (customPromptHasRead && skills.length > 0) {
			prompt += formatSkillsForPrompt(skills);
		}

		prompt += `\nCurrent working directory: ${promptCwd}`;

		return prompt;
	}

	// Get absolute paths to documentation and examples
	const readmePath = getReadmePath();
	const docsPath = getDocsPath();
	const examplesPath = getExamplesPath();

	// Guidelines are hardcoded only. Tool descriptions/snippets are omitted from the
	// system prompt — they are passed to the model via the LLM API `tools` parameter.
	const guidelinesList: string[] = [];
	const guidelinesSet = new Set<string>();
	const addGuideline = (guideline: string): void => {
		if (guidelinesSet.has(guideline)) {
			return;
		}
		guidelinesSet.add(guideline);
		guidelinesList.push(guideline);
	};

	// Always include these
	addGuideline("Be concise in your responses");
	addGuideline("Show file paths clearly when working with files");

	const guidelines = guidelinesList.map((g) => `- ${g}`).join("\n");
	const hasRead = (selectedTools ?? ["read", "bash", "edit", "write"]).includes("read");

	let prompt = `You are Nova, a coding agent that works with the user inside their project. Use the available tools to inspect, modify, and verify the workspace, and carry the user's request through to a concrete result.

Working principles:
- Follow the user's intent and the project's instructions. If they conflict or a choice would materially change the result, explain the conflict and ask before proceeding.
- Inspect relevant files and existing behavior before editing. Do not guess APIs, file contents, or project conventions that can be checked locally.
- Preserve unrelated work, including uncommitted changes. Keep edits focused and never discard or overwrite user changes without explicit permission.
- Prefer safe, reversible actions. Confirm the exact target before destructive or externally visible operations.
- After changing code, run the most relevant available checks. Fix issues caused by your changes and report any validation you could not perform.
- Continue independently when the next step is clear; ask a concise question only when missing information would materially affect the outcome.

Communication:
${guidelines}
- Lead with the result or current blocker, then provide only the details needed to understand or verify it
- Distinguish observed facts from assumptions

Nova documentation (consult only for questions or changes about Nova itself):
- Overview: ${readmePath}
- Reference docs: ${docsPath}
- Examples: ${examplesPath}
- Choose only the documentation relevant to the task, read each selected file completely, and follow directly relevant cross-references before implementing
- Common references: extensions (docs/extensions.md, examples/extensions/), skills (docs/skills.md), themes (docs/themes.md), TUI (docs/tui.md), SDK (docs/sdk.md), models/providers (docs/models.md, docs/custom-provider.md), packages (docs/packages.md)
- Resolve docs/... under Reference docs and examples/... under Examples, not relative to the current project`;

	if (appendSection) {
		prompt += appendSection;
	}

	// Append project context files
	if (contextFiles.length > 0) {
		prompt += "\n\n<project_context>\n\n";
		prompt += "Project-specific instructions and guidelines:\n\n";
		for (const { path: filePath, content } of contextFiles) {
			prompt += `<project_instructions path="${filePath}">\n${content}\n</project_instructions>\n\n`;
		}
		prompt += "</project_context>\n";
	}

	// Append skills section (only if read tool is available)
	if (hasRead && skills.length > 0) {
		prompt += formatSkillsForPrompt(skills);
	}

	prompt += `\nCurrent working directory: ${promptCwd}`;

	return prompt;
}
