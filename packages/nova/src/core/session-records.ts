import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SessionStats } from "./agent-session.ts";
import { loadEntriesFromFile, type SessionManager } from "./session-manager.ts";
import { collectSessionStats } from "./session-statistics.ts";

export interface SessionRecord extends SessionStats {
	reason: string;
	abnormalEnd: boolean;
}

const scanned = new Set<string>();
const activePaths = new Set<string>();

export function sessionRecordPath(sessionFile: string): string {
	return `${sessionFile}.record.json`;
}

function writeAtomic(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: "wx" });
		renameSync(temporary, path);
	} finally {
		rmSync(temporary, { force: true });
	}
}

function isActive(path: string): boolean {
	if (activePaths.has(path)) return true;
	if (!existsSync(`${path}.active.json`)) return false;
	const owner = JSON.parse(readFileSync(`${path}.active.json`, "utf8")) as { pid: number };
	if (!Number.isInteger(owner.pid) || owner.pid <= 0) return false;
	try {
		process.kill(owner.pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

/** Synchronous ownership registration prevents a sibling startup scan racing the first response. */
export function beginSessionRecord(manager: SessionManager): void {
	const path = manager.getSessionFile();
	if (!manager.isPersisted() || !path) return;
	try {
		activePaths.add(path);
		writeAtomic(`${path}.active.json`, { pid: process.pid });
	} catch (error) {
		console.error("[session-record:begin]", error);
	}
}

export function finishSessionRecord(manager: SessionManager, reason: string, endedAt: string): void {
	const path = manager.getSessionFile();
	if (!manager.isPersisted() || !path) return;
	try {
		writeAtomic(sessionRecordPath(path), {
			...collectSessionStats(manager, endedAt),
			reason,
			abnormalEnd: false,
		} satisfies SessionRecord);
		rmSync(`${path}.active.json`, { force: true });
		activePaths.delete(path);
	} catch (error) {
		console.error("[session-record:finish]", error);
	}
}

/** Once per process/directory. Recovery never executes session-end hooks. */
export function reconcileSessionRecords(root: string): void {
	if (scanned.has(root)) return;
	scanned.add(root);
	if (!existsSync(root)) return;
	let files: Dirent[];
	try {
		files = readdirSync(root, { withFileTypes: true });
	} catch (error) {
		console.error("[session-record:scan]", error);
		return;
	}
	for (const file of files) {
		const path = join(root, file.name);
		if (file.isDirectory()) {
			reconcileSessionRecords(path);
			continue;
		}
		if (!file.isFile() || !file.name.endsWith(".jsonl")) continue;
		try {
			if (isActive(path)) continue;
			const recordPath = sessionRecordPath(path);
			// A stale ownership file means a resumed session crashed even if an older record exists.
			if (existsSync(recordPath) && !existsSync(`${path}.active.json`)) continue;
			// Read valid entries without migrating or rewriting the source session.
			const entries = loadEntriesFromFile(path);
			const header = entries.find((entry) => entry.type === "session");
			if (!header || !header.id || !Number.isFinite(Date.parse(header.timestamp))) continue;
			const manager = {
				getHeader: () => header,
				getEntries: () => entries.filter((entry) => entry.type !== "session"),
				getSessionFile: () => path,
				getSessionId: () => header.id,
			};
			const snapshot = collectSessionStats(manager);
			writeAtomic(recordPath, {
				...collectSessionStats(manager, snapshot.lastActivityAt),
				reason: "startup_recovery",
				abnormalEnd: true,
			} satisfies SessionRecord);
			rmSync(`${path}.active.json`, { force: true });
		} catch (error) {
			console.error(`[session-record:recover:${file.name}]`, error);
		}
	}
}
