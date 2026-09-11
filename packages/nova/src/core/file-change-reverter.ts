import { readFile, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { applyPatch, parsePatch, reversePatch } from "diff";
import { withFileMutationQueue } from "./tools/file-mutation-queue.ts";

export interface RevertFileChangeOptions {
	path: string;
	patches: string[];
	created?: boolean;
}

function resolveWorkspaceFile(cwd: string, inputPath: string): string {
	const workspace = resolve(cwd);
	const filePath = resolve(workspace, inputPath);
	const relativePath = relative(workspace, filePath);
	if (relativePath === "" || relativePath.startsWith("..") || isAbsolute(relativePath)) {
		throw new Error(`Cannot revert a path outside the session workspace: ${inputPath}`);
	}
	return filePath;
}

function reverseFilePatch(content: string, patchText: string): string {
	const parsed = parsePatch(patchText);
	if (parsed.length !== 1) throw new Error("Expected exactly one file patch");
	const reverted = applyPatch(content, reversePatch(parsed[0]), { fuzzFactor: 0 });
	if (reverted === false) {
		throw new Error("The file changed after this Agent edit; the change cannot be safely reverted");
	}
	return reverted;
}

export async function revertFileChange(cwd: string, options: RevertFileChangeOptions): Promise<void> {
	if (options.patches.length === 0) throw new Error("No reversible patch is available for this file");
	const filePath = resolveWorkspaceFile(cwd, options.path);
	await withFileMutationQueue(filePath, async () => {
		let content = await readFile(filePath, "utf8");
		for (const patch of [...options.patches].reverse()) content = reverseFilePatch(content, patch);
		if (options.created) {
			if (content !== "") throw new Error("Created file did not revert to an empty state");
			await unlink(filePath);
			return;
		}
		await writeFile(filePath, content, "utf8");
	});
}
