# Observability

[Back to DoomPi](../README.md)

DoomPi keeps the useful live view local to the Pi process. A sink is optional and adds history:

```text
Pi and browser events
        |
        v
DoomPi Log in the Pi process ------> current-session counters and findings
        |
        +-- optional OTLP export --> Log Sink or configured collector
                                          |
                                          +-- persistent metrics and trace lookup
```

The in-process view works without a collector. A Log Sink adds history. DoomPi ships neither a vendor collector nor a hosted dashboard. When no endpoint can be configured or discovered, export becomes a no-op unless file fallback is explicitly enabled.

## What each layer owns

| Layer                   | Lifetime                 | Purpose                                                             |
| ----------------------- | ------------------------ | ------------------------------------------------------------------- |
| DoomPi Log              | Current Pi process       | Aggregate session counters, usage, failures, and findings           |
| Browser telemetry route | Current web hub          | Validate and forward bounded cockpit performance and failure events |
| Log Sink                | Background local process | Retain records and answer metrics or trace queries                  |
| External OTLP endpoint  | Operator-defined         | Export records outside DoomPi's local processes                     |

Repository-local instance selection keeps development histories separate. It is a routing convention, not an access-control boundary.

## Web settings and headless capture

The historical settings panel follows this path:

```text
MetricsPanel -> generated scoped client + sealed transport -> log API
             -> metricsSource -> healthy LogSink HTTP API
                              -> installed LogSink metrics worker -> SQLite
```

The worker must remain inside the installed `@agimon-ai/log-sink-mcp` dependency graph.
Bundling its entry without its `import.meta.url` resources breaks database reads even when
telemetry export works. The compiler policy version invalidates local caches, shared caches,
and retained bootstrap/server receipts. After upgrading or rebuilding the packages, sync
and restart the web host so it loads the new generation. A worker or query failure appears
as `query-error`, not as an absent sink. An empty successful query remains `no-data`.
The API closes its worker reader when the owning server scope is disposed.

Headless sessions and remote tool invocations reach storage through a separate path:

```text
AgentHarness events -------------------> headless lifecycle hooks
MCP / UI tool invocation -> session host -> headless lifecycle hooks
                                        -> doompi-log serverTelemetry
                                        -> doompi-telemetry -> OTLP -> LogSink -> SQLite
```

The server collector records turn usage, tool starts/results, durations, and failure markers.
It awaits lifecycle records before shutdown and flushes when an agent settles. External
MCP tools also flush after their result because they have no local agent-settled event.
Operational records omit prompts, tool arguments, and tool result bodies.

A third-party agent does not provide its model token budget through an ordinary MCP tool
call. Those calls are retained as `pi.tool_call` and `pi.tool_result` records and can be
queried through LogSink MCP `search_logs`. The sink's tool ranking counts token-attributed
samples, not every raw execution. The UI labels that distinction and does not use those
sample counts as a failure-rate denominator. Native turn usage is recorded once; failure
markers do not repeat its token totals.

`tests/metricsPipeline.test.ts` in `doompi-log` exercises the real exporter, isolated HTTP
sink, SQLite worker, settings API, and stdio MCP query. Compiler regressions separately
execute the installed worker from both local and restored shared-cache bundles.

## Run a local sink

Run these commands from the repository root. The package filter matters because `log-sink-mcp` is a packaged dependency of `@agimon-ai/doompi-log`, not a root executable.

```bash
pnpm --filter @agimon-ai/doompi-log exec log-sink-mcp start
pnpm --filter @agimon-ai/doompi-log exec log-sink-mcp status
pnpm --filter @agimon-ai/doompi-log exec log-sink-mcp stop
```

The default instance is scoped to the current repository. Run lifecycle and query commands from the same repository so they resolve the same local instance. `status` prints the process, port, health URL, resolved database path, and instance. Use that reported path rather than assuming the database is under the current directory.

After the sink starts, launch DoomPi normally. `/log-metrics` and `SPC h l` open the live metrics view. Headline counters work without a sink; historical top-consumer and token-burn panels require retained records.

Query the local database:

```bash
pnpm --filter @agimon-ai/doompi-log exec log-sink-mcp logs metrics --service pi --group-by agent
pnpm --filter @agimon-ai/doompi-log exec log-sink-mcp logs trace <trace-id>
```

`logs metrics` groups workflow, token, failure, and tool consumption. `logs trace` prints one trace chronologically. Add `--global` only when both writer and reader intentionally use the shared global instance.

## Smoke-test ingestion without persistence

```bash
pnpm --filter @agimon-ai/doompi-log exec log-sink-mcp start --in-memory --port 3100
pnpm --filter @agimon-ai/doompi-log exec log-sink-mcp status
curl --fail http://127.0.0.1:3100/health
curl --fail --request POST http://127.0.0.1:3100/logs \
  --header 'content-type: application/json' \
  --data '{"logs":[{"level":"info","message":"doompi smoke","service":"doompi-smoke","traceId":"0123456789abcdef0123456789abcdef"}]}'
pnpm --filter @agimon-ai/doompi-log exec log-sink-mcp stop
```

The in-memory database belongs to the sink process and disappears when it stops. Use the persistent workflow when testing history across separate CLI processes.

## Browser telemetry

The cockpit queues operational events and posts batches of up to 10 to `POST /api/telemetry/browser`.
The queue holds at most 32 events, waits one second before sending, and backs off to at most 30 seconds
when a request is retried.

Current performance names are `web.browser.ready`, `web.browser.protocol_ready`,
`web.browser.session_socket_ready`, `web.browser.reconnect`, `web.browser.backlog`,
`web.browser.transcript_page`, `web.browser.transcript_render`, and `web.browser.telemetry_drop`.
The cockpit also emits `web.browser.error` markers. The current server stores that event name, but
not the client's source, message, stack, or session fields. All browser records use the
`doompi-server` service. Performance records also include a non-negative duration or count. Query
them with:

```bash
pnpm --filter @agimon-ai/doompi-log exec log-sink-mcp logs query --service doompi-server --limit 20
```

## Disable export

Set controls before starting Pi:

```bash
AGENT_TELEMETRY_DISABLED=1 doompi
OTEL_SDK_DISABLED=1 doompi
```

`AGENT_TELEMETRY_DISABLED` and `OTEL_SDK_DISABLED` stop telemetry export. DoomPi's in-process
aggregator still records the session events it observes, so the live metrics view can continue to show
activity while sink status reports export as disabled. `AGENT_OTEL_TRACES` controls span export
separately, so disabling traces alone does not disable logs.

## Data boundary

Operational telemetry is not harmless merely because prompts are omitted:

- DoomPi's Pi logger does not attach prompts, tool inputs, or tool results to its operational events. Other callers can still attach sensitive values through custom attributes.
- Records can still include session identifiers, working directory, model, tool names, token and cost totals, errors, workflow identity, and caller-supplied attributes.
- The resolved SQLite database outlives Pi. Protect, rotate, or remove it according to repository policy.
- A local sink is not a sandbox. Processes that can read the repository or connect to the sink can read its records.
- `LOG_SINK_PI_FILE_FALLBACK=1` explicitly allows another local retention surface when no endpoint exists.
- Standard OTLP environment variables and `LOG_SINK_ENDPOINT` can route records elsewhere. Inspect the launch environment before assuming data stays local.

See [Trust and data boundaries](trust-and-data-boundaries.md#telemetry) for the repository-wide policy.
