/**
 * `nova memory` 命令行：查看、检索、置顶、归档事实，以及会话抽取状态。
 *
 * 只做本地读写，不调用模型（补抽仍走正常会话或启动补偿）。
 * 约定：第一个参数不是 `memory` 时返回 false，交回 main 继续解析；
 * 任何错误只打印并返回 true，绝不向调用方抛。
 */

import { type Dirent, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import chalk from "chalk";
import { APP_NAME, getAgentDir } from "./config.ts";
import { FactIndex } from "./core/memory/fact-index.ts";
import {
	type Fact,
	type FactApplicability,
	type FactKind,
	isFactApplicability,
	isFactKind,
} from "./core/memory/fact-schema.ts";
import { FactStore, type FactUpdatePatch } from "./core/memory/fact-store.ts";
import { readExtractionMarker, selectPendingEntries } from "./core/memory/memory-marker.ts";
import { resolveSuggestion } from "./core/memory/memory-review.ts";
import { type MemorySuggestion, SuggestionStore } from "./core/memory/suggestion-store.ts";
import { getDefaultSessionDir, loadEntriesFromFile, type SessionEntry } from "./core/session-manager.ts";
import { SettingsManager } from "./core/settings-manager.ts";

const MEMORY_COMMAND = "memory";
const DAY_MS = 24 * 60 * 60 * 1000;
const RECENT_FACT_DAYS = 7;
const MEMORY_COMMAND_USAGE = `${APP_NAME} memory <list|search|stat|edit|pin|unpin|archive|delete|sessions|suggestions|promote|reject> [options]`;

export interface MemoryCommandRuntimeOptions {
	agentDir?: string;
	cwd?: string;
	output?: (line: string) => void;
}

interface MemoryCommandContext {
	cwd: string;
	agentDir: string;
	write: (line: string) => void;
}

interface ParsedMemoryArgs {
	subcommand?: string;
	positionals: string[];
	json: boolean;
	help: boolean;
	applicability?: FactApplicability;
	limit?: number;
	text?: string;
	kind?: FactKind;
	importance?: number;
	topics?: string[];
	validUntil?: string;
	unknownOption?: string;
	missingOptionValue?: string;
	invalidOptionValue?: string;
}

interface SessionStatusRow {
	sessionFile: string;
	lastActivityAt: string;
	pendingMessages: number;
	lastMarkerAt?: string;
}

export async function handleMemoryCommand(args: string[], options: MemoryCommandRuntimeOptions = {}): Promise<boolean> {
	const [command, ...rest] = args;
	if (command !== MEMORY_COMMAND) return false;

	const write = options.output ?? ((line: string) => console.log(line));
	const parsed = parseMemoryArgs(rest);

	if (parsed.help) {
		printMemoryCommandHelp(write);
		return true;
	}

	const invalid = validateParsedArgs(parsed);
	if (invalid !== undefined) {
		write(`Error: ${invalid}`);
		write(`Usage: ${MEMORY_COMMAND_USAGE}`);
		return true;
	}

	const subcommand = parsed.subcommand;
	if (subcommand === undefined) {
		write("Error: Missing memory subcommand.");
		printMemoryCommandHelp(write);
		return true;
	}

	const context: MemoryCommandContext = {
		cwd: options.cwd ?? process.cwd(),
		agentDir: options.agentDir ?? getAgentDir(),
		write,
	};
	try {
		runMemorySubcommand(subcommand, parsed, context);
	} catch (error: unknown) {
		// 事实库损坏或版本不兼容时只报错，不把异常抛回 main。
		write(`Error: ${describeError(error)}`);
	}
	return true;
}

function printMemoryCommandHelp(write: (line: string) => void): void {
	write(`${chalk.bold("Usage:")}
  ${APP_NAME} memory list [--applicability <universal|transferable|project>] [--json]
  ${APP_NAME} memory search <query> [--limit <n>] [--json]
  ${APP_NAME} memory stat [--json]
  ${APP_NAME} memory edit <id> [--text <s>] [--kind <k>] [--importance <1-5>]
  ${APP_NAME} memory edit <id> [--applicability <universal|transferable|project>] [--topics <a,b>] [--valid-until <iso>]
  ${APP_NAME} memory pin <id>
  ${APP_NAME} memory unpin <id>
  ${APP_NAME} memory archive <id>
  ${APP_NAME} memory delete <id>
  ${APP_NAME} memory sessions [--json]
  ${APP_NAME} memory suggestions [--json]
  ${APP_NAME} memory promote <suggestionId>
  ${APP_NAME} memory reject <suggestionId>

List, search and curate the facts stored in <agentDir>/memory/facts.json,
inspect session extraction progress, and confirm or reject profile promotion
suggestions produced by the review step. Editing updates the fact in place,
takes effect from the next session, and never creates a second fact.
Nothing here calls a model.

Options:
  --applicability <value>  Filter list, or set applicability when editing
  --limit <n>              Maximum number of search hits (default 8, max 20)
  --text <text>            Replace the fact text (1-200 characters)
  --kind <kind>            decision|preference|constraint|project|commitment|event
  --importance <n>         Importance from 1 to 5
  --topics <a,b>           Comma-separated topics, deduplicated, at most 3
  --valid-until <iso>      ISO timestamp after which the fact expires
  --json                   Print a single line of JSON without colors
  -h, --help               Show this help

Examples:
  ${APP_NAME} memory list --applicability project
  ${APP_NAME} memory search "tabs" --limit 5
  ${APP_NAME} memory edit fact_0192f0c4 --text "Team uses pnpm" --importance 4
  ${APP_NAME} memory pin fact_0192f0c4
  ${APP_NAME} memory sessions --json
  ${APP_NAME} memory suggestions --json
  ${APP_NAME} memory promote sug_0192f0c4
`);
}

function parseMemoryArgs(args: string[]): ParsedMemoryArgs {
	const parsed: ParsedMemoryArgs = { positionals: [], json: false, help: false };

	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "-h" || arg === "--help") {
			parsed.help = true;
			continue;
		}
		if (arg === "--json") {
			parsed.json = true;
			continue;
		}
		if (
			arg === "--applicability" ||
			arg === "--limit" ||
			arg === "--text" ||
			arg === "--kind" ||
			arg === "--importance" ||
			arg === "--topics" ||
			arg === "--valid-until"
		) {
			const value = args[index + 1];
			if (value === undefined || value.startsWith("-")) {
				parsed.missingOptionValue = parsed.missingOptionValue ?? arg;
				continue;
			}
			index++;
			if (arg === "--applicability") {
				if (isFactApplicability(value)) {
					parsed.applicability = value;
				} else {
					parsed.invalidOptionValue = parsed.invalidOptionValue ?? `Invalid value ${value} for --applicability.`;
				}
			} else if (arg === "--limit") {
				const limit = Number(value);
				if (Number.isInteger(limit) && limit > 0) {
					parsed.limit = limit;
				} else {
					parsed.invalidOptionValue = parsed.invalidOptionValue ?? `Invalid value ${value} for --limit.`;
				}
			} else if (arg === "--text") {
				parsed.text = value;
			} else if (arg === "--kind") {
				if (isFactKind(value)) {
					parsed.kind = value;
				} else {
					parsed.invalidOptionValue = parsed.invalidOptionValue ?? `Invalid value ${value} for --kind.`;
				}
			} else if (arg === "--importance") {
				const importance = Number(value);
				if (Number.isInteger(importance) && importance >= 1 && importance <= 5) {
					parsed.importance = importance;
				} else {
					parsed.invalidOptionValue = parsed.invalidOptionValue ?? `Invalid value ${value} for --importance.`;
				}
			} else if (arg === "--topics") {
				parsed.topics = value
					.split(",")
					.map((topic) => topic.trim())
					.filter((topic) => topic.length > 0);
			} else if (Number.isNaN(Date.parse(value))) {
				parsed.invalidOptionValue = parsed.invalidOptionValue ?? `Invalid value ${value} for --valid-until.`;
			} else {
				parsed.validUntil = value;
			}
			continue;
		}
		if (arg.startsWith("-")) {
			parsed.unknownOption = parsed.unknownOption ?? arg;
			continue;
		}
		if (parsed.subcommand === undefined) {
			parsed.subcommand = arg;
		} else {
			parsed.positionals.push(arg);
		}
	}

	return parsed;
}

function validateParsedArgs(parsed: ParsedMemoryArgs): string | undefined {
	if (parsed.unknownOption !== undefined) return `Unknown option ${parsed.unknownOption} for "memory".`;
	if (parsed.missingOptionValue !== undefined) return `Missing value for ${parsed.missingOptionValue}.`;
	if (parsed.invalidOptionValue !== undefined) return parsed.invalidOptionValue;
	const subcommand = parsed.subcommand;
	if (subcommand !== "list" && subcommand !== "edit" && parsed.applicability !== undefined) {
		return "--applicability is only valid for list and edit.";
	}
	if (subcommand !== "search" && parsed.limit !== undefined) return "--limit is only valid for search.";
	if (subcommand !== "edit") {
		const editOption = editOnlyOption(parsed);
		if (editOption !== undefined) return `${editOption} is only valid for edit.`;
	}
	return undefined;
}

/** 只有 `edit` 接受的选项名，用于把误用挡在存储层之前。 */
function editOnlyOption(parsed: ParsedMemoryArgs): string | undefined {
	if (parsed.text !== undefined) return "--text";
	if (parsed.kind !== undefined) return "--kind";
	if (parsed.importance !== undefined) return "--importance";
	if (parsed.topics !== undefined) return "--topics";
	if (parsed.validUntil !== undefined) return "--valid-until";
	return undefined;
}

function runMemorySubcommand(subcommand: string, parsed: ParsedMemoryArgs, context: MemoryCommandContext): void {
	switch (subcommand) {
		case "list":
			runList(parsed, context);
			return;
		case "search":
			runSearch(parsed, context);
			return;
		case "stat":
			runStat(parsed, context);
			return;
		case "edit":
			runEdit(parsed, context);
			return;
		case "pin":
			runPinnedAction(parsed, context, true);
			return;
		case "unpin":
			runPinnedAction(parsed, context, false);
			return;
		case "archive":
		case "delete":
			runArchiveAction(subcommand, parsed, context);
			return;
		case "sessions":
			runSessions(parsed, context);
			return;
		case "suggestions":
			runSuggestions(parsed, context);
			return;
		case "promote":
			runSuggestionAction(parsed, context, "accept");
			return;
		case "reject":
			runSuggestionAction(parsed, context, "reject");
			return;
		default:
			context.write(`Error: Unknown memory subcommand "${subcommand}".`);
			context.write(`Usage: ${MEMORY_COMMAND_USAGE}`);
	}
}

function runList(parsed: ParsedMemoryArgs, context: MemoryCommandContext): void {
	if (rejectPositionals(parsed, context, "list")) return;

	const store = new FactStore(context.agentDir);
	const applicability = parsed.applicability;
	const facts = store.active().filter((fact) => applicability === undefined || fact.applicability === applicability);
	facts.sort(compareFacts);

	if (parsed.json) {
		context.write(
			JSON.stringify({
				facts: facts.map((fact) => ({
					id: fact.id,
					createdAt: fact.createdAt,
					applicability: fact.applicability,
					kind: fact.kind,
					importance: fact.importance,
					pinned: fact.pinned,
					text: fact.text,
				})),
			}),
		);
		return;
	}

	if (facts.length === 0) {
		context.write(chalk.dim("No facts stored."));
		return;
	}

	const lines = renderTable(
		["ID", "DATE", "APPLICABILITY", "KIND", "IMP", "TEXT"],
		facts.map((fact) => [
			fact.id,
			fact.createdAt.slice(0, 10),
			fact.applicability,
			fact.kind,
			String(fact.importance),
			fact.text,
		]),
	);
	context.write(chalk.bold(lines[0]));
	for (const line of lines.slice(1)) context.write(line);
}

function runSearch(parsed: ParsedMemoryArgs, context: MemoryCommandContext): void {
	const query = parsed.positionals[0];
	if (query === undefined) {
		context.write('Error: Missing search query for "search".');
		context.write(`Usage: ${MEMORY_COMMAND_USAGE}`);
		return;
	}
	if (parsed.positionals.length > 1) {
		context.write(`Error: Unexpected argument ${parsed.positionals[1]} for "search".`);
		context.write(`Usage: ${MEMORY_COMMAND_USAGE}`);
		return;
	}

	const store = new FactStore(context.agentDir);
	const hits = new FactIndex(store.list()).search(query, { limit: parsed.limit, includeArchived: false });

	if (parsed.json) {
		context.write(
			JSON.stringify({
				query,
				hits: hits.map((hit) => ({
					id: hit.fact.id,
					score: roundTo(hit.score, 4),
					text: hit.fact.text,
				})),
			}),
		);
		return;
	}

	if (hits.length === 0) {
		context.write(chalk.dim(`No facts matched "${query}".`));
		return;
	}

	context.write(chalk.dim(`Search results for "${query}": ${hits.length}`));
	const lines = renderTable(
		["ID", "SCORE", "TEXT"],
		hits.map((hit) => [hit.fact.id, hit.score.toFixed(3), hit.fact.text]),
	);
	context.write(chalk.bold(lines[0]));
	for (const line of lines.slice(1)) context.write(line);
}

function runStat(parsed: ParsedMemoryArgs, context: MemoryCommandContext): void {
	if (rejectPositionals(parsed, context, "stat")) return;

	const store = new FactStore(context.agentDir);
	const facts = store.list();
	const activeFacts = facts.filter(isActiveFact);
	const active = activeFacts.length;
	const archived = facts.length - active;
	const hits = facts.reduce((total, fact) => total + fact.retrievalCount, 0);
	const importanceTotal = activeFacts.reduce((total, fact) => total + fact.importance, 0);
	const averageImportance = active === 0 ? 0 : roundTo(importanceTotal / active, 2);
	const since = Date.now() - RECENT_FACT_DAYS * DAY_MS;
	const recent7Days = facts.filter((fact) => timeValue(fact.createdAt) >= since).length;
	const factsEnabled = readFactsEnabled(context.cwd, context.agentDir);

	if (parsed.json) {
		context.write(JSON.stringify({ active, archived, hits, averageImportance, recent7Days, factsEnabled }));
		return;
	}

	if (!factsEnabled) {
		context.write(chalk.yellow("Facts are disabled in memory settings; extraction and injection are off."));
	}
	context.write(`Active facts: ${active}`);
	context.write(`Archived facts: ${archived}`);
	context.write(`Retrieval hits: ${hits}`);
	context.write(`Average importance (active): ${averageImportance}`);
	context.write(`Added in last ${RECENT_FACT_DAYS} days: ${recent7Days}`);
}

/** 编辑一条事实：只改显式给出的字段，不新建、不合并。输出文案由桌面端依赖，改动需同步。 */
function runEdit(parsed: ParsedMemoryArgs, context: MemoryCommandContext): void {
	const id = requireFactId(parsed, context, "edit");
	if (id === undefined) return;
	if (editOnlyOption(parsed) === undefined && parsed.applicability === undefined) {
		context.write(
			"Error: edit requires at least one of --text, --kind, --importance, --applicability, --topics, --valid-until",
		);
		return;
	}

	const patch: FactUpdatePatch = {};
	if (parsed.text !== undefined) patch.text = parsed.text;
	if (parsed.kind !== undefined) patch.kind = parsed.kind;
	if (parsed.importance !== undefined) patch.importance = parsed.importance;
	if (parsed.applicability !== undefined) patch.applicability = parsed.applicability;
	if (parsed.topics !== undefined) patch.topics = parsed.topics;
	if (parsed.validUntil !== undefined) patch.validUntil = parsed.validUntil;

	// 未知 id、敏感内容、超长文本等由 store.update 抛错，外层统一打印 `Error: <message>`。
	const result = new FactStore(context.agentDir).update(id, patch);
	if (result.action === "duplicate") {
		context.write(`Error: fact text is already stored as ${result.fact.id}`);
		return;
	}
	if (result.action === "conflict") {
		const candidateIds = result.candidates.map((fact) => fact.id).join(", ");
		context.write(`Error: conflicts with existing facts: ${candidateIds}`);
		return;
	}
	context.write(`Updated fact ${id}: ${result.fact.text}`);
}

function runPinnedAction(parsed: ParsedMemoryArgs, context: MemoryCommandContext, pinned: boolean): void {
	const subcommand = pinned ? "pin" : "unpin";
	const id = requireFactId(parsed, context, subcommand);
	if (id === undefined) return;

	const store = new FactStore(context.agentDir);
	if (store.get(id) === undefined) {
		context.write(`Error: Fact not found: ${id}`);
		return;
	}
	store.setPinned(id, pinned);
	context.write(pinned ? `Pinned ${id}` : `Unpinned ${id}`);
}

function runArchiveAction(
	subcommand: "archive" | "delete",
	parsed: ParsedMemoryArgs,
	context: MemoryCommandContext,
): void {
	const id = requireFactId(parsed, context, subcommand);
	if (id === undefined) return;

	const store = new FactStore(context.agentDir);
	const fact = store.get(id);
	if (fact === undefined) {
		context.write(`Error: Fact not found: ${id}`);
		return;
	}
	if (fact.archivedAt !== undefined) {
		context.write(`Fact ${id} is already archived.`);
		return;
	}
	// `delete` 与 `archive` 是同一操作：软删除只标记归档原因，不物理移除。
	store.archive(id, "manual");
	context.write(`Archived ${id}`);
}

function runSessions(parsed: ParsedMemoryArgs, context: MemoryCommandContext): void {
	if (rejectPositionals(parsed, context, "sessions")) return;

	const sessionDir = getDefaultSessionDir(context.cwd, context.agentDir);
	const { rows, unreadable } = scanSessions(sessionDir);

	if (parsed.json) {
		context.write(JSON.stringify({ sessionDir, sessions: rows, unreadable }));
		return;
	}

	if (rows.length === 0) {
		context.write(chalk.dim(`No session files in ${sessionDir}.`));
		return;
	}

	context.write(chalk.dim(`Session directory: ${sessionDir}`));
	const lines = renderTable(
		["FILE", "LAST ACTIVITY", "PENDING", "LAST MARKER"],
		rows.map((row) => [row.sessionFile, row.lastActivityAt, String(row.pendingMessages), row.lastMarkerAt ?? "-"]),
	);
	context.write(chalk.bold(lines[0]));
	for (const line of lines.slice(1)) context.write(line);
	if (unreadable > 0) {
		context.write(chalk.yellow(`${unreadable} session file(s) could not be read.`));
	}
}

/** 递归收集 `.jsonl` 会话文件；`.record.json` 与 `.active.<pid>.json` 后缀不同，天然被排除。 */
function collectSessionFiles(directory: string, files: string[]): void {
	let entries: Dirent[];
	try {
		entries = readdirSync(directory, { withFileTypes: true });
	} catch {
		// 会话目录还不存在时没有可列的内容。
		return;
	}
	for (const entry of entries) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			collectSessionFiles(path, files);
			continue;
		}
		if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path);
	}
}

/** 列出目录里每个会话文件及其抽取状态，按最后活动时间倒序。 */
function scanSessions(sessionDir: string): { rows: SessionStatusRow[]; unreadable: number } {
	const files: string[] = [];
	collectSessionFiles(sessionDir, files);

	const rows: SessionStatusRow[] = [];
	let unreadable = 0;
	for (const sessionFile of files) {
		try {
			const stats = statSync(sessionFile);
			const entries: SessionEntry[] = loadEntriesFromFile(sessionFile).filter((entry) => entry.type !== "session");
			const markerState = readExtractionMarker({ getEntries: () => entries });
			const pending = selectPendingEntries(entries, markerState);
			const row: SessionStatusRow = {
				sessionFile,
				lastActivityAt: new Date(stats.mtimeMs).toISOString(),
				pendingMessages: pending.length,
			};
			if (markerState.marker !== undefined) row.lastMarkerAt = markerState.marker.at;
			rows.push(row);
		} catch {
			// 单个文件读失败不影响其余会话；最后按数量显式提示。
			unreadable += 1;
		}
	}

	rows.sort((left, right) => {
		const byActivity = timeValue(right.lastActivityAt) - timeValue(left.lastActivityAt);
		return byActivity !== 0 ? byActivity : left.sessionFile.localeCompare(right.sessionFile);
	});
	return { rows, unreadable };
}

function runSuggestions(parsed: ParsedMemoryArgs, context: MemoryCommandContext): void {
	if (rejectPositionals(parsed, context, "suggestions")) return;

	const suggestions = new SuggestionStore(context.agentDir).list("pending").sort(compareSuggestions);

	if (parsed.json) {
		context.write(
			JSON.stringify({
				suggestions: suggestions.map((suggestion) => ({
					id: suggestion.id,
					action: suggestion.action,
					targetSectionId: suggestion.targetSectionId,
					title: suggestion.title,
					factIds: suggestion.factIds,
					createdAt: suggestion.createdAt,
				})),
			}),
		);
		return;
	}

	if (suggestions.length === 0) {
		context.write(chalk.dim("No pending suggestions."));
		return;
	}

	const lines = renderTable(
		["ID", "ACTION", "TITLE", "FACTS", "CREATED"],
		suggestions.map((suggestion) => [
			suggestion.id,
			suggestion.action,
			suggestion.title,
			String(suggestion.factIds.length),
			suggestion.createdAt.slice(0, 10),
		]),
	);
	context.write(chalk.bold(lines[0]));
	for (const line of lines.slice(1)) context.write(line);
}

function runSuggestionAction(
	parsed: ParsedMemoryArgs,
	context: MemoryCommandContext,
	action: "accept" | "reject",
): void {
	const subcommand = action === "accept" ? "promote" : "reject";
	const id = requireSuggestionId(parsed, context, subcommand);
	if (id === undefined) return;

	try {
		const result = resolveSuggestion({ agentDir: context.agentDir, suggestionId: id, action });
		if (action === "reject") {
			context.write(`Rejected ${id}`);
			return;
		}
		context.write(
			result.sectionId === undefined ? `Promoted ${id}` : `Promoted ${id} into section ${result.sectionId}`,
		);
	} catch (error) {
		context.write(`Error: ${describeError(error)}`);
	}
}

function requireSuggestionId(
	parsed: ParsedMemoryArgs,
	context: MemoryCommandContext,
	subcommand: string,
): string | undefined {
	const id = parsed.positionals[0];
	if (id === undefined) {
		context.write(`Error: Missing suggestion id for "${subcommand}".`);
		context.write(`Usage: ${MEMORY_COMMAND_USAGE}`);
		return undefined;
	}
	if (parsed.positionals.length > 1) {
		context.write(`Error: Unexpected argument ${parsed.positionals[1]} for "${subcommand}".`);
		context.write(`Usage: ${MEMORY_COMMAND_USAGE}`);
		return undefined;
	}
	return id;
}

/** 新建议优先，再按 id 保证顺序稳定。 */
function compareSuggestions(left: MemorySuggestion, right: MemorySuggestion): number {
	const byCreated = timeValue(right.createdAt) - timeValue(left.createdAt);
	if (byCreated !== 0) return byCreated;
	if (left.id === right.id) return 0;
	return left.id < right.id ? -1 : 1;
}

function rejectPositionals(parsed: ParsedMemoryArgs, context: MemoryCommandContext, subcommand: string): boolean {
	const extra = parsed.positionals[0];
	if (extra === undefined) return false;
	context.write(`Error: Unexpected argument ${extra} for "${subcommand}".`);
	context.write(`Usage: ${MEMORY_COMMAND_USAGE}`);
	return true;
}

function requireFactId(
	parsed: ParsedMemoryArgs,
	context: MemoryCommandContext,
	subcommand: string,
): string | undefined {
	const id = parsed.positionals[0];
	if (id === undefined) {
		context.write(`Error: Missing fact id for "${subcommand}".`);
		context.write(`Usage: ${MEMORY_COMMAND_USAGE}`);
		return undefined;
	}
	if (parsed.positionals.length > 1) {
		context.write(`Error: Unexpected argument ${parsed.positionals[1]} for "${subcommand}".`);
		context.write(`Usage: ${MEMORY_COMMAND_USAGE}`);
		return undefined;
	}
	return id;
}

/** 读取设置只为判断 `facts.enabled`；设置损坏时按默认（开启）处理。 */
function readFactsEnabled(cwd: string, agentDir: string): boolean {
	try {
		return SettingsManager.create(cwd, agentDir).getMemorySettings().facts.enabled;
	} catch {
		return true;
	}
}

function isActiveFact(fact: Fact): boolean {
	return fact.archivedAt === undefined && fact.supersededBy === undefined;
}

/** 置顶优先，其余按创建时间倒序，再按 id 保证顺序稳定。 */
function compareFacts(left: Fact, right: Fact): number {
	if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
	const created = timeValue(right.createdAt) - timeValue(left.createdAt);
	if (created !== 0) return created;
	if (left.id === right.id) return 0;
	return left.id < right.id ? -1 : 1;
}

function timeValue(iso: string): number {
	const parsed = Date.parse(iso);
	return Number.isNaN(parsed) ? 0 : parsed;
}

function roundTo(value: number, digits: number): number {
	const factor = 10 ** digits;
	return Math.round(value * factor) / factor;
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** 左对齐的简单表格；最后一列不补空格，避免行尾空白。 */
function renderTable(headers: string[], rows: string[][]): string[] {
	const widths = headers.map((header, index) =>
		Math.max(header.length, ...rows.map((row) => (row[index] ?? "").length)),
	);
	const renderRow = (row: string[]): string =>
		row
			.map((cell, index) => (index === row.length - 1 ? cell : cell.padEnd(widths[index])))
			.join("  ")
			.trimEnd();
	return [renderRow(headers), ...rows.map((row) => renderRow(row))];
}
