export function getNovaUserAgent(version: string): string {
	const runtime = process.versions.bun ? `bun/${process.versions.bun}` : `node/${process.version}`;
	return `nova/${version} (${process.platform}; ${runtime}; ${process.arch})`;
}
