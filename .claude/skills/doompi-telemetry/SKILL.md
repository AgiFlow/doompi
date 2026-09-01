---
name: doompi-telemetry
description: Query captured DoomPi agent telemetry to diagnose the agent's own behavior. Use when asked why an agent run failed, which tools fail or burn the most tokens, whether context is being wasted, or when you need evidence before changing a prompt, a tool, or an extension. Covers failed tool calls, extension errors, token and cache totals, per-tool cost, and single-run trace lookup through the log-sink CLI.
---

# DoomPi agent telemetry

Telemetry is how the agent inspects its own runs instead of guessing. Setup, disable controls, and privacy boundaries live in `docs/observability.md`. This skill covers only the query loop.

## Check there is data before analyzing

Telemetry is dropped silently when no sink is listening. An empty result usually means nothing was captured, not that nothing went wrong.

```bash
pnpm --filter @agimon-ai/doompi-log exec log-sink-mcp status
```

Expect `HTTP Server: 🟢 Running` plus a port and a database path. If it is not running, say so and point at `docs/observability.md` rather than reporting zero issues as a clean bill of health. Records only accumulate while the sink is up, so a freshly started sink has no history.

## Running the commands

`log-sink-mcp` is a dependency of `@agimon-ai/doompi-log`, not a root executable, so every command uses the package filter and runs from the repository root.

pnpm prints platform warnings to stdout, which corrupts JSON parsing. Strip everything before the first brace:

```bash
pnpm --filter @agimon-ai/doompi-log exec log-sink-mcp logs agent-issues --limit 1 2>/dev/null | sed -n '/^{/,$p'
```

## The three questions worth asking

### What is breaking

`logs agent-issues` is the primary self-improvement command. It understands agent event semantics, so it catches returned tool errors and `success=false` results that a plain error-severity search misses.

```bash
pnpm --filter @agimon-ai/doompi-log exec log-sink-mcp logs agent-issues --limit 20
```

Read the aggregate before the samples: `totalIssues`, `uniqueIncidents`, `byCategory`, `byTool`, `byErrorType`. `occurrenceCount` on each issue separates one loud repeated failure from many distinct ones. Scope with `--session-id`, `--agent-name`, `--service`, or `--start-time` / `--end-time`.

### What is expensive

```bash
pnpm --filter @agimon-ai/doompi-log exec log-sink-mcp logs metrics --tool-sort invocations --tool-limit 10
```

`totals` carries `totalTokens`, `cachedInputTokens`, and `usageEventCount`. Per tool, `toolCallTurn` gives `avgTotalTokens` and `p90TotalTokens`. Sort with `--tool-sort p90-total-tokens` to find the tool whose worst case dominates a session, which is usually more actionable than its average.

A low ratio of `cachedInputTokens` to `totalTokens` means the prompt prefix keeps changing and cache writes are being wasted.

### What happened in one run

```bash
pnpm --filter @agimon-ai/doompi-log exec log-sink-mcp logs stats --group-by service
pnpm --filter @agimon-ai/doompi-log exec log-sink-mcp logs query --service pi --limit 20
pnpm --filter @agimon-ai/doompi-log exec log-sink-mcp logs trace <trace-id>
```

Services are per subsystem, for example `pi`, `doom-team`, `doom-task`, `doom-runner-host`, `doom-file-edit`. Use `logs search <text>` for full text, and `logs trace` to get one trace in chronological order once an issue gives you a `traceId`.

## Turning a finding into a change

Quote the number and the evidence, never a vibe. A finding is worth acting on when it repeats across sessions or concentrates in one tool. A single occurrence is an anecdote. Prefer `uniqueIncidents` over `totalIssues` when deciding whether something is systemic, and check `coveragePercent` and `truncated` before treating a window as complete.

The `SPC h l` overlay in Pi already aggregates current-session metrics and findings in process. Use it for the live session and this CLI for history across sessions.

## Guardrails

- Never run `log-sink-mcp logs clear`. It wipes the database and destroys evidence for every other consumer.
- Do not run `stop`, `start`, `http-serve`, or `mcp-serve` as part of an analysis. Live processes export to that listener and stopping it silently drops their telemetry.
- Use `--global` only when the writer and the query are both intentionally configured for the shared instance. The global instance can hold unrelated data from other repositories, so querying it by default produces confusing or empty results.
- Records can include session ids, working directory, model, tool names, and token totals. Prompts and tool inputs are omitted unless `AGENT_OTEL_REDACT=0`. Treat output as potentially sensitive when pasting it anywhere.
