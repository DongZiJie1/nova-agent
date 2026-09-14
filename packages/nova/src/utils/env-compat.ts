/**
 * Environment variable lookup for the Nova CLI.
 *
 * Nova reads `NOVA_<NAME>`. The pre-rebrand `PI_<NAME>` name is still accepted as a
 * fallback so existing environments and docs keep working; `NOVA_<NAME>` always wins.
 */
export function getNovaEnv(name: string): string | undefined {
	const value = process.env[`NOVA_${name}`];
	if (value !== undefined) return value;
	return process.env[`PI_${name}`];
}

/** Env var name shown in help text and error messages (`NOVA_<NAME>`). */
export function novaEnvName(name: string): string {
	return `NOVA_${name}`;
}
