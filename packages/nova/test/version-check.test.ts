import { afterEach, describe, expect, it, vi } from "vitest";
import {
	checkForNewNovaVersion,
	comparePackageVersions,
	getLatestNovaRelease,
	getLatestNovaVersion,
	isNewerPackageVersion,
} from "../src/utils/version-check.ts";

const LATEST_VERSION_URL = "https://registry.npmjs.org/@dongzijie1%2Fnova/latest";
const VERSION_CHECK_ENV_NAMES = ["NOVA_SKIP_VERSION_CHECK", "PI_SKIP_VERSION_CHECK", "NOVA_OFFLINE", "PI_OFFLINE"];
const originalEnv = new Map(VERSION_CHECK_ENV_NAMES.map((name) => [name, process.env[name]]));

afterEach(() => {
	vi.unstubAllGlobals();
	for (const [name, value] of originalEnv) {
		if (value === undefined) {
			delete process.env[name];
		} else {
			process.env[name] = value;
		}
	}
});

describe("version checks", () => {
	it("compares package versions", () => {
		expect(comparePackageVersions("0.70.6", "0.70.5")).toBeGreaterThan(0);
		expect(comparePackageVersions("0.70.5", "0.70.5")).toBe(0);
		expect(comparePackageVersions("0.70.4", "0.70.5")).toBeLessThan(0);
		expect(comparePackageVersions("5.0.0-beta.20", "5.0.0-beta.9")).toBeGreaterThan(0);
		expect(isNewerPackageVersion("0.70.5", "0.70.5")).toBe(false);
		expect(isNewerPackageVersion("0.70.6", "0.70.5")).toBe(true);
	});

	it("returns only newer versions", async () => {
		const fetchMock = vi.fn(async () => Response.json({ version: "1.2.3" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(checkForNewNovaVersion("1.2.3")).resolves.toBeUndefined();
		await expect(checkForNewNovaVersion("1.2.2")).resolves.toEqual({ version: "1.2.3" });
	});

	it("uses the npm registry endpoint with a nova user agent", async () => {
		const fetchMock = vi.fn(async () => Response.json({ version: "1.2.4" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestNovaVersion("1.2.3")).resolves.toBe("1.2.4");
		expect(fetchMock).toHaveBeenCalledWith(
			LATEST_VERSION_URL,
			expect.objectContaining({
				headers: expect.objectContaining({
					"User-Agent": expect.stringMatching(/^nova\/1\.2\.3 /),
					accept: "application/json",
				}),
			}),
		);
	});

	it("reads the version from a GitHub-style release tag name", async () => {
		const fetchMock = vi.fn(async () => Response.json({ tag_name: "v1.2.4" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestNovaRelease("1.2.3")).resolves.toEqual({ packageName: undefined, version: "1.2.4" });
	});

	it("returns the active package metadata from the version check api", async () => {
		const fetchMock = vi.fn(async () =>
			Response.json({
				packageName: "@new-scope/nova",
				version: "1.2.4",
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestNovaRelease("1.2.3")).resolves.toEqual({
			packageName: "@new-scope/nova",
			version: "1.2.4",
		});
	});

	it("returns update notes from the version check api", async () => {
		const fetchMock = vi.fn(async () => Response.json({ note: " **Read this** ", version: "1.2.4" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestNovaRelease("1.2.3")).resolves.toEqual({ note: "**Read this**", version: "1.2.4" });
	});

	it("skips automatic api calls when version checks are disabled", async () => {
		process.env.NOVA_SKIP_VERSION_CHECK = "1";
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		await expect(checkForNewNovaVersion("1.2.3")).resolves.toBeUndefined();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("still honors the legacy PI_SKIP_VERSION_CHECK name", async () => {
		process.env.PI_SKIP_VERSION_CHECK = "1";
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		await expect(checkForNewNovaVersion("1.2.3")).resolves.toBeUndefined();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("still honors the legacy PI_OFFLINE name", async () => {
		process.env.PI_OFFLINE = "1";
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestNovaVersion("1.2.3")).resolves.toBeUndefined();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("allows direct api calls when automatic version checks are disabled", async () => {
		process.env.NOVA_SKIP_VERSION_CHECK = "1";
		const fetchMock = vi.fn(async () => Response.json({ version: "1.2.4" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestNovaVersion("1.2.3")).resolves.toBe("1.2.4");
		expect(fetchMock).toHaveBeenCalledOnce();
	});
});
