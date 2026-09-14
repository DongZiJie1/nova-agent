import type { ProviderEnv } from "../types.ts";
import { getProviderEnvValue } from "./provider-env.ts";

/**
 * Resolve a Nova env value, preferring `NOVA_<name>` and falling back to the
 * pre-rebrand `PI_<name>` name. Scoped `env` overrides take precedence over
 * `process.env`, matching {@link getProviderEnvValue}.
 */
export function getNovaEnv(name: string, env?: ProviderEnv): string | undefined {
	return getProviderEnvValue(`NOVA_${name}`, env) ?? getProviderEnvValue(`PI_${name}`, env);
}
