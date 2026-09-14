/**
 * Installs the shared model fixtures. agent tests import pi-ai through the
 * package specifier (resolved to dist), so the registry must be imported the
 * same way to land in the instance the tests read from.
 */
import { registerFixtureModels, setFixtureFallback } from "@dongzijie1/pi-ai/compat";
import { installFixtureRegistry } from "../../../test-fixtures/model-fixtures.ts";

installFixtureRegistry({ registerFixtureModels, setFixtureFallback });
