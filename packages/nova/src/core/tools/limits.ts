/**
 * Default resource limits for tool execution.
 *
 * Kept dependency-free so both the bash tool and the settings layer can read them without
 * pulling the tool implementation (and its TUI imports) into the settings module.
 */

/** Default bash timeout in seconds when the model passes none: 10 minutes. */
export const DEFAULT_BASH_TIMEOUT_SECONDS = 600;

/** How many bash commands one agent may run at once before the rest queue. */
export const DEFAULT_MAX_CONCURRENT_BASH = 8;

/**
 * Backstop cap for tool results that did not truncate themselves (extension and SDK tools).
 *
 * Deliberately above the built-in tools' own limits (2000 lines / 50KB) because those
 * already-truncated results carry a footer line, so a cap at exactly their limit would
 * truncate them a second time and cut the footer off.
 */
export const TOOL_RESULT_BACKSTOP_MAX_LINES = 8000;
export const TOOL_RESULT_BACKSTOP_MAX_BYTES = 256 * 1024;
