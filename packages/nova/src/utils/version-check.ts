import { compare, valid } from "semver";
import { getNovaEnv } from "./env-compat.ts";
import { getNovaUserAgent } from "./nova-user-agent.ts";

const DEFAULT_LATEST_VERSION_URL = "https://registry.npmjs.org/@dongzijie1%2Fnova/latest";
const DEFAULT_VERSION_CHECK_TIMEOUT_MS = 10000;

export interface LatestNovaRelease {
	version: string;
	packageName?: string;
	note?: string;
}

export function comparePackageVersions(leftVersion: string, rightVersion: string): number | undefined {
	const left = valid(leftVersion.trim());
	const right = valid(rightVersion.trim());
	if (!left || !right) {
		return undefined;
	}
	return compare(left, right);
}

export function isNewerPackageVersion(candidateVersion: string, currentVersion: string): boolean {
	const comparison = comparePackageVersions(candidateVersion, currentVersion);
	if (comparison !== undefined) {
		return comparison > 0;
	}
	return candidateVersion.trim() !== currentVersion.trim();
}

/** Release tag names may carry a `v` prefix; semver parsing does not accept one. */
function normalizeReleaseVersion(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const version = value.trim().replace(/^v/, "");
	return version ? version : undefined;
}

export async function getLatestNovaRelease(
	currentVersion: string,
	options: { timeoutMs?: number } = {},
): Promise<LatestNovaRelease | undefined> {
	if (getNovaEnv("OFFLINE")) return undefined;

	const url = getNovaEnv("LATEST_VERSION_URL") || DEFAULT_LATEST_VERSION_URL;
	const response = await fetch(url, {
		headers: {
			"User-Agent": getNovaUserAgent(currentVersion),
			accept: "application/json",
		},
		signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_VERSION_CHECK_TIMEOUT_MS),
	});
	if (!response.ok) return undefined;

	const data = (await response.json()) as {
		packageName?: unknown;
		version?: unknown;
		tag_name?: unknown;
		note?: unknown;
	};
	const version = normalizeReleaseVersion(data.version) ?? normalizeReleaseVersion(data.tag_name);
	if (!version) {
		return undefined;
	}
	const packageName =
		typeof data.packageName === "string" && data.packageName.trim() ? data.packageName.trim() : undefined;
	const note = typeof data.note === "string" && data.note.trim() ? data.note.trim() : undefined;
	return {
		version,
		packageName,
		...(note ? { note } : {}),
	};
}

export async function getLatestNovaVersion(
	currentVersion: string,
	options: { timeoutMs?: number } = {},
): Promise<string | undefined> {
	return (await getLatestNovaRelease(currentVersion, options))?.version;
}

export async function checkForNewNovaVersion(currentVersion: string): Promise<LatestNovaRelease | undefined> {
	if (getNovaEnv("SKIP_VERSION_CHECK")) return undefined;

	try {
		const latestRelease = await getLatestNovaRelease(currentVersion);
		if (latestRelease && isNewerPackageVersion(latestRelease.version, currentVersion)) {
			return latestRelease;
		}
		return undefined;
	} catch {
		return undefined;
	}
}
