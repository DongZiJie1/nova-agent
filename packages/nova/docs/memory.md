# Long-term Memory

Nova distills durable facts from conversations (decisions, preferences, constraints, commitments) and injects the relevant ones into later sessions. Facts are independent of the hand-curated user profile in `user-memory.json`; the model never writes the profile directly.

**Source files** ([nova-agent](https://github.com/DongZiJie1/nova-agent)):
- [`packages/nova/src/core/memory/fact-store.ts`](https://github.com/DongZiJie1/nova-agent/blob/main/packages/nova/src/core/memory/fact-store.ts) - storage, dedupe, supersede, archive
- [`packages/nova/src/core/memory/fact-extraction.ts`](https://github.com/DongZiJie1/nova-agent/blob/main/packages/nova/src/core/memory/fact-extraction.ts) - extraction prompt, parsing, noise filters
- [`packages/nova/src/core/memory/memory-service.ts`](https://github.com/DongZiJie1/nova-agent/blob/main/packages/nova/src/core/memory/memory-service.ts) - extraction runner, queue, lifecycle hooks
- [`packages/nova/src/core/memory/memory-compensation.ts`](https://github.com/DongZiJie1/nova-agent/blob/main/packages/nova/src/core/memory/memory-compensation.ts) - startup compensation and review
- [`packages/nova/src/core/memory/memory-review.ts`](https://github.com/DongZiJie1/nova-agent/blob/main/packages/nova/src/core/memory/memory-review.ts) - review prompt, suggestions, accept/reject
- [`packages/nova/src/core/memory/suggestion-store.ts`](https://github.com/DongZiJie1/nova-agent/blob/main/packages/nova/src/core/memory/suggestion-store.ts) - pending suggestion storage
- [`packages/nova/src/core/memory/tools/`](https://github.com/DongZiJie1/nova-agent/tree/main/packages/nova/src/core/memory/tools) - the three model tools

## Storage

Facts are stored in `<agentDir>/memory/facts.json` (`~/.nova/agent/memory/facts.json` by default), mode `0600` in a `0700` directory. The file is created on the first write only, and every write is atomic (temp file plus rename under a `proper-lockfile` lock).

The file is `{"version": 1, "facts": [...]}`. Each fact carries `id` (`fact_<uuidv7>`), `text` (one sentence, at most 200 characters), `kind` (`decision`, `preference`, `constraint`, `project`, `commitment`, `event`), `applicability` (`universal`, `transferable`, `project`) with `projects` or `originProject` as needed, `topics`, `importance` 1-5, `confidence`, timestamps, `retrievalCount`, `pinned`, review and archive fields, and `source` (`sessionFile`, `sessionId`, `entryIds`, `extractedAt`, `model`).

Writes dedupe by normalized text hash, merge near-duplicates, report contradictions instead of overwriting them, and archive facts replaced through `supersedes`.

## Extraction

Extraction runs in the background and never blocks a turn. It fires when the agent idles for `idleMinutes`, every `checkpointTurns` turns, and before compaction. The session-end hook does not extract by itself: it waits up to `sessionEndFlushMs` for an in-flight extraction and then disposes the service. On startup, sessions that were killed mid-conversation are re-extracted once (startup compensation, maximum 20 sessions per start).

Each successful extraction appends one custom session entry of type `nova.memory_extraction` recording `throughEntryId`, `at`, `model`, and the fact ids it produced. That marker never enters the model context; it only delimits the unextracted range, so later extractions and forked sessions skip what was already processed. Failed extractions do not advance the marker.

## Review and Promotion

A successful extraction is followed by one review pass over unreviewed facts of the same session; after startup compensation one process-wide review pass covers every unreviewed fact. Candidates must be active, `universal`, have no `validUntil`, and either reach `promotion.minImportance` or be written explicitly through `remember` (`source.model` is `explicit`). The post-extraction pass ignores that explicit exemption because background extraction uses the same fallback label when no extraction model is configured; the startup pass keeps it. At most 10 candidates go into a single model call, and no candidates means no model call at all.

The review returns profile suggestions (`create`, `append`, `update`) that are stored as `pending` in `<agentDir>/memory/suggestions.json` (mode `0600`, same atomic write rules). Facts backing a suggestion move to `suggested`; unreferenced candidates move to `kept` so they are not sent again. Suggestions are not applied by default: `nova memory promote <suggestionId>` writes the profile section, marks the facts `promoted`, archives them with reason `promoted`, and records the section id; `nova memory reject <suggestionId>` only marks the suggestion rejected. Set `promotion.auto` to `true` to apply suggestions immediately. Review failures and cancellation leave facts `unreviewed` and are retried on the next run.

## Injection

`<user_facts>` is appended to the system prompt after the user profile block and before the todo block (`user_memory` → `user_facts` → `user_todos`). With an empty store the prompt is byte-identical to a build without memory.

Selection is scored by recency, importance, usage, project match, and topics. Pinned facts (up to 3) go first; the rest need at least `minScore`. The block holds at most `maxPromptFacts` facts, each truncated to `maxTextChars`, and stops before exceeding `maxPromptTokens`. `project` facts from other working directories are hidden unless `gateProjectFacts` is off.

## Tools

| Tool | Purpose |
|------|---------|
| `remember` | Store one durable fact. It takes effect from the next session, and a session may write at most 20 facts. |
| `search_memory` | BM25 search over facts plus profile sections; returns ids and snippets. Other projects' `project` facts stay hidden unless `includeOtherProjects` is set. |
| `read_memory` | Full text and source of one `fact_*` or `section_*` id, with related facts. Hits bump the usage counters. |

Facts and suggestions can also be curated from the CLI without calling a model: `nova memory list|search|stat|pin|unpin|archive|delete|sessions`, and `nova memory suggestions|promote|reject` for review output.

## Settings

All keys live under `memory` in `settings.json` (`~/.nova/agent/settings.json` or `<project>/.nova/settings.json`).

| Key | Default | Meaning |
|-----|---------|---------|
| `memory.enabled` | `true` | Master switch |
| `memory.facts.enabled` | `true` | Injection and fact writes |
| `memory.facts.maxPromptFacts` | `12` | Facts injected per session |
| `memory.facts.maxPromptTokens` | `1000` | Token budget for the block |
| `memory.facts.maxTextChars` | `160` | Per-line text cap |
| `memory.facts.minScore` | `0.35` | Relevance gate |
| `memory.facts.halfLifeDays` | `21` | Recency half-life |
| `memory.facts.crossProjectRecall` | `true` | Include other projects' transferable facts |
| `memory.facts.gateProjectFacts` | `true` | Hide other projects' `project` facts |
| `memory.facts.maxActiveFacts` | `5000` | Reserved: active fact cap, not enforced yet |
| `memory.facts.archiveAfterDays` | `90` | Days without a retrieval before a low-importance fact is archived; applied after each successful extraction |
| `memory.facts.promotion` | `{minHits: 6, minImportance: 4, minAgeDays: 14, auto: false}` | Promotion gate (`minImportance`) and auto-apply flag; `minHits` and `minAgeDays` are reserved |
| `memory.extraction.enabled` | `true` | Background extraction |
| `memory.extraction.idleMinutes` | `8` | Idle window before extracting; `0` disables it |
| `memory.extraction.checkpointTurns` | `20` | Turns between checkpoints |
| `memory.extraction.maxFactsPerBatch` | `8` | Facts kept per extraction |
| `memory.extraction.minImportance` | `2` | Facts below this are dropped |
| `memory.extraction.maxInputChars` | `24000` | Conversation tail sent to the model |
| `memory.extraction.model` | session model | Model used for extraction |
| `memory.extraction.timeoutMs` | `30000` | Per-request timeout |

## Turning It Off

Set `memory.enabled` to `false` to remove injection, background extraction, startup compensation, and review. Prefer `memory.extraction.enabled: false` when you want recall but no background model calls, and `memory.facts.enabled: false` to stop injection and `remember` writes. Existing facts stay on disk; delete `memory/facts.json` to forget everything, and `memory/suggestions.json` to drop pending suggestions.

## Privacy

Extraction sends the tail of the conversation (up to `maxInputChars` characters, including user messages) to the model provider configured for the current session. Review sends candidate facts plus the existing profile sections. Facts, suggestions, and profile content are stored unencrypted on the local disk, and the injected block is part of the system prompt sent to the provider on every request. Greetings and obvious secrets are filtered, but filtering is heuristic: review stored facts with `nova memory list` and disable extraction if conversations must not leave the machine.
