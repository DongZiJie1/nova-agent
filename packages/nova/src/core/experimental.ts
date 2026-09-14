import { getNovaEnv } from "../utils/env-compat.ts";

export function areExperimentalFeaturesEnabled(): boolean {
	return getNovaEnv("EXPERIMENTAL") === "1";
}
