import { describe, expect, it } from "vitest";
import { getNovaUserAgent } from "../src/utils/nova-user-agent.ts";

describe("getNovaUserAgent", () => {
	it("identifies the client as nova with platform and runtime details", () => {
		const runtime = process.versions.bun ? `bun/${process.versions.bun}` : `node/${process.version}`;
		const userAgent = getNovaUserAgent("1.2.3");

		expect(userAgent).toBe(`nova/1.2.3 (${process.platform}; ${runtime}; ${process.arch})`);
		expect(userAgent).toMatch(/^nova\/[^\s()]+ \([^;()]+;\s*[^;()]+;\s*[^()]+\)$/);
	});
});
