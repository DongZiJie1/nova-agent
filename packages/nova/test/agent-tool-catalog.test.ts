import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { listAgentTools } from "../src/core/agent-tool-catalog.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

async function fixture(allowedToolNames?: string[]) {
	const harness = await createHarness({
		allowedToolNames,
		extensionFactories: [
			(pi) => {
				pi.registerTool({
					name: "fixture_external_search",
					label: "Fixture external search",
					description: "Search through an installed extension",
					parameters: Type.Object({}),
					execute: async () => ({ content: [{ type: "text", text: "unused" }], details: {} }),
				});
			},
		],
	});
	harnesses.push(harness);
	await harness.session.bindExtensions({});
	return harness;
}

describe("live Agent tool catalog", () => {
	it("includes extension tools and previously omitted builtin tools from the actual session", async () => {
		const { session } = await fixture();
		const catalog = listAgentTools(session);
		expect(catalog.find((tool) => tool.name === "fixture_external_search")).toMatchObject({
			description: "Search through an installed extension",
		});
		expect(catalog.map((tool) => tool.name)).toEqual(
			expect.arrayContaining(["todo", "nova_data", "write_scheduled_task", "hub_delegate_task"]),
		);
		expect(catalog.find((tool) => tool.name === "read")?.sourceInfo.source).toBe("builtin");
	});
	it("takes defaults from current active tools and preserves registered tools when disabled", async () => {
		const { session } = await fixture();
		session.setActiveToolsByName(["fixture_external_search"]);
		expect(
			listAgentTools(session)
				.filter((tool) => tool.defaultEnabled)
				.map((tool) => tool.name),
		).toEqual(["fixture_external_search"]);
		session.setActiveToolsByName([]);
		expect(listAgentTools(session).some((tool) => tool.defaultEnabled)).toBe(false);
		expect(listAgentTools(session).some((tool) => tool.name === "fixture_external_search")).toBe(true);
	});
	it("respects the runtime tool policy instead of inventing additional tools", async () => {
		const { session } = await fixture(["read"]);
		expect(listAgentTools(session).map((tool) => tool.name)).toEqual(["read"]);
	});
});
