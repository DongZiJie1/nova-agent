import { fauxAssistantMessage } from "@dongzijie1/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

describe("agent display name generation", () => {
	let harness: Harness | undefined;

	afterEach(() => {
		harness?.cleanup();
	});

	it("uses the configured session model on the first prompt and emits one cleaned name", async () => {
		harness = await createHarness();
		await harness.session.bindExtensions({ mode: "rpc" });
		harness.setResponses([
			fauxAssistantMessage('"修复会话命名"\nignored'),
			fauxAssistantMessage("main response"),
			fauxAssistantMessage("second response"),
		]);

		await harness.session.prompt("修复 Studio 中的 agent 会话名称");
		await harness.session.prompt("继续检查事件转发");

		expect(harness.eventsOfType("agent_name_update")).toEqual([{ type: "agent_name_update", name: "修复会话命名" }]);
		expect(harness.session.sessionName).toBe("修复会话命名");
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("limits sentence-like model output to a short label", async () => {
		harness = await createHarness();
		await harness.session.bindExtensions({ mode: "rpc" });
		harness.setResponses([
			fauxAssistantMessage("这是一个用于查询天气的智能助手，可以帮助你获取天气信息。"),
			fauxAssistantMessage("main response"),
		]);

		await harness.session.prompt("查询今天的天气");

		expect(harness.eventsOfType("agent_name_update")).toEqual([
			{ type: "agent_name_update", name: "这是一个用于查询天气的智" },
		]);
	});
});
