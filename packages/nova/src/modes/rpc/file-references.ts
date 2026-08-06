import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export interface RpcFileReference {
	path: string;
}

const MAX_FILE_REFERENCES = 50;

export async function resolveFileReferences(cwd: string, references: RpcFileReference[]): Promise<string[]> {
	if (references.length > MAX_FILE_REFERENCES) {
		throw new Error(`Too many file references (maximum ${MAX_FILE_REFERENCES})`);
	}

	const projectRoot = await realpath(cwd);
	const resolved = new Set<string>();
	for (const reference of references) {
		if (!reference.path || isAbsolute(reference.path)) {
			throw new Error(`File reference must be a relative project path: ${reference.path}`);
		}

		let target: string;
		try {
			target = await realpath(resolve(projectRoot, reference.path));
		} catch {
			throw new Error(`Referenced file does not exist: ${reference.path}`);
		}
		const projectRelativePath = relative(projectRoot, target);
		if (
			projectRelativePath === ".." ||
			projectRelativePath.startsWith(`..${sep}`) ||
			isAbsolute(projectRelativePath)
		) {
			throw new Error(`Referenced file is outside the project: ${reference.path}`);
		}
		if (!(await stat(target)).isFile()) {
			throw new Error(`File reference is not a regular file: ${reference.path}`);
		}
		resolved.add(projectRelativePath.split(sep).join("/"));
	}
	return [...resolved];
}

export function formatFileReferenceContext(paths: string[]): string {
	return [
		"<referenced_files>",
		"The user explicitly referenced these files in the current project.",
		"Use the read tool when their contents are needed; do not assume their contents from the path alone.",
		...paths.map((path) => `- ${JSON.stringify(path)}`),
		"</referenced_files>",
	].join("\n");
}
