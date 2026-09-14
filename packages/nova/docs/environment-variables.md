# Environment Variables

Nova uses environment variables in three ways:

- Variables such as `NOVA_OFFLINE` configure the Nova process.
- Nova sets `NOVA_CODING_AGENT` so child processes can detect that they run inside Nova.
- Commands run by the LLM-callable bash tool receive `NOVA_*` variables describing the current session.

The pre-rebrand `PI_<NAME>` spelling of each variable is still accepted as a fallback for reads; when both are set, `NOVA_<NAME>` wins.

Provider API-key variables are documented separately in [Providers](providers.md#environment-variables-or-auth-file).

## Process Marker

The CLI and RPC entry points set `NOVA_CODING_AGENT=true`. Child processes inherit it and can use it to detect that they run inside Nova. The legacy `PI_CODING_AGENT=true` is also set for older child processes. It is not session-specific and is not set automatically when Nova is embedded through the SDK.

## Bash Tool Session Environment

Commands run by the bash tool receive the current Nova session state:

| Variable | Description |
|----------|-------------|
| `NOVA_SESSION_ID` | Current session ID |
| `NOVA_SESSION_FILE` | Absolute path to the current session JSONL file; unset for ephemeral sessions |
| `NOVA_PROVIDER` | Currently selected model provider |
| `NOVA_MODEL` | Currently selected model ID |
| `NOVA_REASONING_LEVEL` | Current effective reasoning level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max` |

The values are resolved when each command starts. Switching models or changing the reasoning level therefore affects the next bash command without restarting Nova. `NOVA_PROVIDER` and `NOVA_MODEL` identify the selected Nova model, not a different upstream model that a router may choose internally.

When asked which model or provider is running, inspect these variables instead of inferring the answer from the system prompt:

```bash
printf '%s/%s\n' "$NOVA_PROVIDER" "$NOVA_MODEL"
printf 'reasoning=%s session=%s\n' "$NOVA_REASONING_LEVEL" "$NOVA_SESSION_ID"
```

The session file can be inspected directly when the session is persistent:

```bash
if [ -n "$NOVA_SESSION_FILE" ]; then
  tail -n 1 "$NOVA_SESSION_FILE"
fi
```

These variables are injected into the LLM-callable bash tool. They are not injected into user-entered `!` or `!!` commands.

### Custom Bash Tools

Bash tools created with `createBashTool()` expose the session environment by default when registered with Nova. Injection happens before `spawnHook`, so a hook receives the variables in `ctx.env`:

```typescript
const bashTool = createBashTool(cwd, {
  spawnHook: (ctx) => ({
    ...ctx,
    env: { ...ctx.env, CI: "1" },
  }),
});
```

Disable session metadata independently of the spawn hook:

```typescript
const bashTool = createBashTool(cwd, {
  exposeSessionEnvironment: false,
  spawnHook: (ctx) => ctx,
});
```

When disabled, Nova removes inherited values for these variables so nested Nova processes do not expose stale parent-session metadata.

## Nova Process Configuration

These variables are read by Nova itself:

| Variable | Description |
|----------|-------------|
| `NOVA_CODING_AGENT_DIR` | Override the config directory; default is `~/.nova/agent` |
| `NOVA_CODING_AGENT_SESSION_DIR` | Override session storage; overridden by `--session-dir` |
| `NOVA_PACKAGE_DIR` | Override the package directory, useful for Nix/Guix store paths |
| `NOVA_OFFLINE` | Disable startup network operations, including update checks, package updates, and install/update telemetry |
| `NOVA_SKIP_VERSION_CHECK` | Disable the npm registry latest-version request |
| `NOVA_TELEMETRY` | Override install/update telemetry and provider attribution headers: `1`/`true`/`yes` or `0`/`false`/`no` |
| `NOVA_CACHE_RETENTION` | Set to `long` for extended provider prompt caching where supported |
| `NOVA_SHARE_VIEWER_URL` | Override the base URL used by `/share` |
| `NOVA_HARDWARE_CURSOR` | Set to `1` to show the hardware cursor; see [Terminal setup](terminal-setup.md) |
| `VISUAL`, `EDITOR` | External editor fallback when `externalEditor` is unset |
| `HTTP_PROXY`, `HTTPS_PROXY` | Proxy outbound HTTP requests |

The pre-rebrand `PI_<NAME>` form (for example `PI_OFFLINE`, `PI_CODING_AGENT_DIR`) is still read as a fallback whenever the corresponding `NOVA_` variable is unset.

Provider credentials such as `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, and cloud-provider configuration are listed in [Providers](providers.md#environment-variables-or-auth-file).
