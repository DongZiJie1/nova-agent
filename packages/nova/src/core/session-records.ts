import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { SessionStats } from "./agent-session.ts";
import { loadEntriesFromFile, type SessionManager } from "./session-manager.ts";
import { collectSessionStats } from "./session-statistics.ts";

export interface SessionRecord extends SessionStats {
	reason: string;
	abnormalEnd: boolean;
}

const scanned = new Set<string>();
const ownedMarkers = new Map<string, string>();

export function sessionRecordPath(sessionFile: string): string {
	return `${sessionFile}.record.json`;
}

/** One ownership marker per process, so two windows on the same session cannot delete each other's. */
export function activeMarkerPath(sessionFile: string): string {
	return `${sessionFile}.active.${process.pid}.json`;
}

function activeMarkerFiles(sessionFile: string): string[] {
	const directory = dirname(sessionFile);
	const prefix = `${basename(sessionFile)}.active.`;
	try {
		return readdirSync(directory)
			.filter((name) => name.startsWith(prefix) && name.endsWith(".json"))
			.map((name) => join(directory, name));
	} catch {
		return [];
	}
}

function readMarkerPid(path: string): number | undefined {
	try {
		const value = JSON.parse(readFileSync(path, "utf8")) as { pid?: unknown };
		return typeof value.pid === "number" && Number.isInteger(value.pid) && value.pid > 0 ? value.pid : undefined;
	} catch {
		return undefined;
	}
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
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

function hasLiveOwner(sessionFile: string): boolean {
	if (ownedMarkers.has(sessionFile)) return true;
	for (const marker of activeMarkerFiles(sessionFile)) {
		const pid = readMarkerPid(marker);
		if (pid !== undefined && isProcessAlive(pid)) return true;
	}
	return false;
}

/** Whether another process (or this one) currently owns the session file. */
export function hasLiveSessionOwner(sessionFile: string): boolean {
	return hasLiveOwner(sessionFile);
}

function removeStaleMarkers(sessionFile: string): void {
	for (const marker of activeMarkerFiles(sessionFile)) {
		const pid = readMarkerPid(marker);
		if (pid === undefined || !isProcessAlive(pid)) rmSync(marker, { force: true });
	}
}

/** Synchronous ownership registration prevents a sibling startup scan racing the first response. */
export function beginSessionRecord(manager: SessionManager): void {
	const path = manager.getSessionFile();
	if (!manager.isPersisted() || !path) return;
	const marker = activeMarkerPath(path);
	try {
		writeAtomic(marker, { pid: process.pid, startedAt: new Date().toISOString() });
		ownedMarkers.set(path, marker);
	} catch (error) {
		console.error("[session-record:begin]", error);
	}
}

export function finishSessionRecord(manager: SessionManager, reason: string, endedAt: string): void {
	const path = manager.getSessionFile();
	if (!manager.isPersisted() || !path) return;
	try {
		const stats = collectSessionStats(manager, endedAt);
		// Sessions that never had a message are not worth a record and must not look crashed later.
		if (stats.totalMessages > 0) {
			writeAtomic(sessionRecordPath(path), { ...stats, reason, abnormalEnd: false } satisfies SessionRecord);
		}
		rmSync(ownedMarkers.get(path) ?? activeMarkerPath(path), { force: true });
		ownedMarkers.delete(path);
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
			if (hasLiveOwner(path)) continue;
			const recordPath = sessionRecordPath(path);
			// A stale ownership file means a resumed session crashed even if an older record exists.
			if (existsSync(recordPath) && activeMarkerFiles(path).length === 0) continue;
			// Read valid entries without migrating or rewriting the source session.
			const entries = loadEntriesFromFile(path);
			const header = entries.find((entry) => entry.type === "session");
			if (!header || !header.id || !Number.isFinite(Date.parse(header.timestamp))) {
				removeStaleMarkers(path);
				continue;
			}
			const manager = {
				getHeader: () => header,
				getEntries: () => entries.filter((entry) => entry.type !== "session"),
				getSessionFile: () => path,
				getSessionId: () => header.id,
			};
			const snapshot = collectSessionStats(manager);
			if (snapshot.totalMessages === 0) {
				removeStaleMarkers(path);
				continue;
			}
			writeAtomic(recordPath, {
				...collectSessionStats(manager, snapshot.lastActivityAt),
				reason: "startup_recovery",
				abnormalEnd: true,
			} satisfies SessionRecord);
			removeStaleMarkers(path);
		} catch (error) {
			console.error(`[session-record:recover:${file.name}]`, error);
		}
	}
}
