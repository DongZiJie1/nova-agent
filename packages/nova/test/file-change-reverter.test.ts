import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { revertFileChange } from "../src/core/file-change-reverter.ts";
import { generateUnifiedPatch } from "../src/core/tools/edit-diff.ts";

describe("revertFileChange", () => {
	let cwd: string;

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "nova-revert-file-"));
	});

	afterEach(() => rmSync(cwd, { recursive: true, force: true }));

	it("reverts multiple edits in reverse order", async () => {
		const path = join(cwd, "example.txt");
		const original = "one\ntwo\n";
		const first = "one changed\ntwo\n";
		const second = "one changed\ntwo changed\n";
		writeFileSync(path, second);

		await revertFileChange(cwd, {
			path: "example.txt",
			patches: [
				generateUnifiedPatch("example.txt", original, first),
				generateUnifiedPatch("example.txt", first, second),
			],
		});

		expect(readFileSync(path, "utf8")).toBe(original);
	});

	it("refuses to overwrite later conflicting changes", async () => {
		const path = join(cwd, "example.txt");
		const original = "before\n";
		const changed = "agent\n";
		writeFileSync(path, "user changed it again\n");

		await expect(
			revertFileChange(cwd, {
				path: "example.txt",
				patches: [generateUnifiedPatch("example.txt", original, changed)],
			}),
		).rejects.toThrow("cannot be safely reverted");
		expect(readFileSync(path, "utf8")).toBe("user changed it again\n");
	});

	it("removes a file created by the Agent", async () => {
		const path = join(cwd, "created.txt");
		const content = "created by Agent\n";
		writeFileSync(path, content);

		await revertFileChange(cwd, {
			path: "created.txt",
			patches: [generateUnifiedPatch("created.txt", "", content)],
			created: true,
		});

		expect(existsSync(path)).toBe(false);
	});

	it("rejects paths outside the session workspace", async () => {
		await expect(
			revertFileChange(cwd, {
				path: "../outside.txt",
				patches: [generateUnifiedPatch("outside.txt", "before", "after")],
			}),
		).rejects.toThrow("outside the session workspace");
	});
});
