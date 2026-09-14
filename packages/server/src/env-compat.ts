/**
 * Server environment variable lookup.
 *
 * Reads `NOVA_<NAME>`, falling back to the pre-rebrand `PI_<NAME>` name.
 */
export function getNovaEnv(name: string): string | undefined {
	const value = process.env[`NOVA_${name}`];
	if (value !== undefined) return value;
	return process.env[`PI_${name}`];
}
