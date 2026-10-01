import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
	computeNextRun,
	normalizeScheduleRule,
	ScheduledTaskStore,
	scheduledTaskSummary,
} from "../src/core/scheduled-task-store.ts";

const dirs: string[] = [];

function store() {
	const dir = mkdtempSync(join(tmpdir(), "nova-schedule-"));
	dirs.push(dir);
	return new ScheduledTaskStore(dir);
}

afterEach(() => {
	while (dirs.length) {
		const dir = dirs.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

describe("scheduled-task-store", () => {
	test("creates and lists tasks with camelCase fields shared with Studio", () => {
		const s = store();
		const task = s.create({
			title: "  每日   行业调研  ",
			prompt: "调研 AI Agent 行业动态并输出摘要",
			projectPath: "/tmp/project",
			schedule: {
				kind: "recurring",
				recurrence: "daily",
				timeOfDay: "09:30",
			},
			permissionMode: "edits",
		});
		expect(task.title).toBe("每日 行业调研");
		expect(task.id.startsWith("sch_")).toBe(true);
		expect(task.nextRunAt).toBeTruthy();
		expect(task.permissionMode).toBe("edits");

		const raw = JSON.parse(readFileSync(s.path, "utf8"));
		expect(raw.version).toBe(1);
		expect(raw.items[0].projectPath).toBe("/tmp/project");
		expect(raw.items[0].permissionMode).toBe("edits");
		expect(raw.items[0].nextRunAt).toBeTruthy();
		expect(raw.items[0].worktreeEnabled).toBe(false);
		expect(raw.items[0].sessionMode).toBe("reuse");
		// Atomic write leaves 0600 on unix.
		if (process.platform !== "win32") {
			expect(statSync(s.path).mode & 0o777).toBe(0o600);
		}
	});

	test("update merges schedule and set_enabled pauses nextRunAt", () => {
		const s = store();
		const created = s.create({
			title: "once",
			prompt: "run once",
			projectPath: "/tmp/p",
			schedule: {
				kind: "once",
				runAt: new Date(Date.now() + 3600_000).toISOString(),
			},
		});
		expect(created.nextRunAt).toBeTruthy();

		const paused = s.update(created.id, { enabled: false });
		expect(paused.enabled).toBe(false);
		expect(paused.nextRunAt).toBeUndefined();

		const resumed = s.update(created.id, { enabled: true });
		expect(resumed.enabled).toBe(true);
		expect(resumed.nextRunAt).toBeTruthy();
	});

	test("delete removes the task", () => {
		const s = store();
		const task = s.create({
			title: "t",
			prompt: "p",
			projectPath: "/tmp/p",
			schedule: { kind: "recurring", recurrence: "daily", timeOfDay: "08:00" },
		});
		s.delete(task.id);
		expect(s.list()).toHaveLength(0);
		expect(() => s.get(task.id)).toThrow(/not found/i);
	});

	test("sessionMode defaults to reuse for new tasks and fresh for legacy records", () => {
		const s = store();
		const created = s.create({
			title: "调研",
			prompt: "调研 RL 岗位",
			projectPath: "/tmp/p",
			schedule: { kind: "recurring", recurrence: "daily", timeOfDay: "09:00" },
		});
		expect(created.sessionMode).toBe("reuse");
		expect(created.sessionFile).toBeUndefined();

		expect(s.update(created.id, { sessionMode: "fresh" }).sessionMode).toBe("fresh");
		expect(() => s.update(created.id, { sessionMode: "nope" as never })).toThrow(/session mode/i);

		const raw = JSON.parse(readFileSync(s.path, "utf8"));
		delete raw.items[0].sessionMode;
		writeFileSync(s.path, JSON.stringify(raw));
		expect(s.get(created.id).sessionMode).toBe("fresh");
	});

	test("validates rules like the Studio Rust writer", () => {
		expect(() => normalizeScheduleRule({ kind: "once" })).toThrow(/runAt/);
		expect(() =>
			normalizeScheduleRule({
				kind: "recurring",
				recurrence: "monthly",
				timeOfDay: "10:00",
				monthDays: [31],
			}),
		).toThrow(/month day/i);
		expect(() =>
			normalizeScheduleRule({
				kind: "recurring",
				recurrence: "cron",
				cron: "nope",
			}),
		).toThrow(/cron/i);
	});

	test("computeNextRun advances from the scheduled slot", () => {
		const after = new Date("2026-09-23T10:00:00");
		const daily = computeNextRun({ kind: "recurring", recurrence: "daily", timeOfDay: "09:30" }, after);
		expect(daily).toBeTruthy();
		expect(daily!.getHours()).toBe(9);
		expect(daily!.getMinutes()).toBe(30);
		expect(daily!.getDate()).toBe(24);
	});

	test("summary keeps prompt previews short for the model", () => {
		const s = store();
		const task = s.create({
			title: "t",
			prompt: "x".repeat(500),
			projectPath: "/tmp/p",
			schedule: { kind: "recurring", recurrence: "daily", timeOfDay: "08:00" },
		});
		const summary = scheduledTaskSummary(task);
		expect(summary.promptPreview.length).toBeLessThanOrEqual(401);
		expect(summary.promptPreview.endsWith("…")).toBe(true);
	});
});
