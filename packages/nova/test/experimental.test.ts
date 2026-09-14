import { afterEach, describe, expect, it } from "vitest";
import { areExperimentalFeaturesEnabled } from "../src/core/experimental.ts";

describe("areExperimentalFeaturesEnabled", () => {
	const originalPiExperimental = process.env.NOVA_EXPERIMENTAL;

	afterEach(() => {
		if (originalPiExperimental === undefined) {
			delete process.env.NOVA_EXPERIMENTAL;
		} else {
			process.env.NOVA_EXPERIMENTAL = originalPiExperimental;
		}
	});

	it("returns false when NOVA_EXPERIMENTAL is unset", () => {
		delete process.env.NOVA_EXPERIMENTAL;

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});

	it("returns false when NOVA_EXPERIMENTAL is empty", () => {
		process.env.NOVA_EXPERIMENTAL = "";

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});

	it("returns true when NOVA_EXPERIMENTAL is set to 1", () => {
		process.env.NOVA_EXPERIMENTAL = "1";

		expect(areExperimentalFeaturesEnabled()).toBe(true);
	});

	it("returns false when NOVA_EXPERIMENTAL is set to 0", () => {
		process.env.NOVA_EXPERIMENTAL = "0";

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});

	it("returns false when NOVA_EXPERIMENTAL is set to a non-1 value", () => {
		process.env.NOVA_EXPERIMENTAL = "true";

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});
});
