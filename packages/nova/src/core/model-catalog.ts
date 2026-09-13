/**
 * Structured provider/model directory derived from models.json.
 *
 * This is the payload the desktop app renders in both its settings page and its
 * model picker, so the two surfaces share one source of truth. It intentionally
 * excludes built-in catalog entries: the directory lists only providers and
 * models the user configured.
 */

export interface ModelCatalogModel {
	id: string;
	name: string;
	api: string;
	baseUrl: string;
	contextWindow: number;
	maxTokens: number;
	reasoning: boolean;
	input: ("text" | "image")[];
}

export interface ModelCatalogProvider {
	provider: string;
	name: string;
	api?: string;
	baseUrl?: string;
	auth: { configured: boolean; source?: string };
	models: ModelCatalogModel[];
}

export interface ModelCatalog {
	providers: ModelCatalogProvider[];
}
