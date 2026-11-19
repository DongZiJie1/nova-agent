import { DefaultResourceLoader } from "./resource-loader.ts";

/** Discover the same global/configured resources used at execution, without loading extension code. */
export async function listInstalledAgentSkills(agentDir: string) {
	const loader = new DefaultResourceLoader({
		cwd: agentDir,
		agentDir,
		noExtensions: true,
		noContextFiles: true,
		noPromptTemplates: true,
		noThemes: true,
	});
	await loader.reload();
	return loader
		.getSkills()
		.skills.filter((skill) => skill.sourceInfo.scope !== "project")
		.map(({ name, description, filePath }) => ({ name, description, filePath }))
		.sort((a, b) => a.name.localeCompare(b.name));
}
