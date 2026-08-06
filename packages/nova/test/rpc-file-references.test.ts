import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { formatFileReferenceContext, resolveFileReferences } from "../src/modes/rpc/file-references.ts";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "nova-file-references-"));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("RPC file references", () => {
	it("normalizes, validates, and deduplicates project files", async () => {
		const project = await temporaryDirectory();
		await mkdir(join(project, "src"));
		await writeFile(join(project, "src", "app.ts"), "export {};\n");

		await expect(
			resolveFileReferences(project, [{ path: "src/app.ts" }, { path: "src/../src/app.ts" }]),
		).resolves.toEqual(["src/app.ts"]);
	});

	it("rejects paths and symlinks outside the project", async () => {
		const project = await temporaryDirectory();
		const outside = await temporaryDirectory();
		await writeFile(join(outside, "secret.txt"), "secret\n");
		await symlink(join(outside, "secret.txt"), join(project, "linked-secret.txt"));

		await expect(resolveFileReferences(project, [{ path: "../secret.txt" }])).rejects.toThrow(
			"Referenced file does not exist",
		);
		await expect(resolveFileReferences(project, [{ path: "linked-secret.txt" }])).rejects.toThrow(
			"outside the project",
		);
	});

	it("formats hidden context that instructs the model to use read", () => {
		const context = formatFileReferenceContext(["src/app.ts"]);
		expect(context).toContain('"src/app.ts"');
		expect(context).toContain("Use the read tool");
	});
});
