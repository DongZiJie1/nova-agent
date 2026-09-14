/**
 * Installs the shared model fixtures. ai tests import pi-ai by relative path,
 * so this must register into the same source module instance (../src), not the
 * package specifier.
 */
import { installFixtureRegistry } from "../../../test-fixtures/model-fixtures.ts";
import { registerFixtureModels, setFixtureFallback } from "../src/model-fixtures.ts";

installFixtureRegistry({ registerFixtureModels, setFixtureFallback });
