# Observability

[Back to DoomPi](../README.md)

DoomPi separates live metrics from retained telemetry:

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

The in-process view works without a collector. A Log Sink adds history. DoomPi ships neither a vendor collector nor a hosted dashboard, and it drops export when no endpoint is configured unless file fallback is explicitly enabled.

## What each layer owns

| Layer                   | Lifetime                 | Purpose                                                             |
| ----------------------- | ------------------------ | ------------------------------------------------------------------- |
| DoomPi Log              | Current Pi process       | Aggregate session counters, usage, failures, and findings           |
| Browser telemetry route | Current web hub          | Validate and forward bounded cockpit performance and failure events |
| Log Sink                | Background local process | Retain records and answer metrics or trace queries                  |
| External OTLP endpoint  | Operator-defined         | Export records outside DoomPi's local processes                     |

Repository-local instance selection keeps development histories separate. It is a routing convention, not an access-control boundary.

## Run a local sink

Run these commands from the repository root. The package filter matters because `log-sink-mcp` is a packaged dependency of `@agimon-ai/doompi-log`, not a root executable.

```bash
pnpm --filter @agimon-ai/doompi-log exec log-sink-mcp start
pnpm --filter @agimon-ai/doompi-log exec log-sink-mcp status
pnpm --filter @agimon-ai/doompi-log exec log-sink-mcp stop
```

The default instance is scoped to the current repository and persists records in `./logs/session.db`. Run lifecycle and query commands from the same repository so they resolve the same instance. `status` prints the process, port, health URL, database path, and resolved instance.

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

The cockpit posts events to `POST /api/telemetry/browser`; the hub records them under the `doom-web` service. The route accepts at most 60 batches per minute and 10 events per batch. Any invalid event rejects the complete batch.

Only two shapes are accepted:

- Performance events use six fixed names: `web.browser.ready`, `web.browser.protocol_ready`, `web.browser.session_socket_ready`, `web.browser.reconnect`, `web.browser.backlog`, and `web.browser.telemetry_drop`. They carry one bounded duration or count.
- Failure events use `web.browser.error` with a fixed source, error name, bounded message, optional bounded stack, and optional session ID.

Query browser records with:

```bash
pnpm --filter @agimon-ai/doompi-log exec log-sink-mcp logs query --service doom-web --limit 20
```

## Disable collection or export

Set controls before starting Pi:

```bash
AGENT_TELEMETRY_DISABLED=1 doompi
OTEL_SDK_DISABLED=1 doompi
```

`AGENT_TELEMETRY_DISABLED` disables DoomPi's Pi telemetry extension. `OTEL_SDK_DISABLED` disables OpenTelemetry SDK export for the process. The metrics UI reports that collection is disabled rather than showing zero activity. `AGENT_OTEL_TRACES` controls span export separately, so disabling traces alone does not disable logs.

## Data boundary

Operational telemetry is not harmless merely because prompts are omitted:

- Prompts, tool inputs, and results are omitted by default. `AGENT_OTEL_REDACT=0` includes them and may expose source, commands, credentials, and model content.
- Records can still include session identifiers, working directory, model, tool names, token and cost totals, errors, workflow identity, and caller-supplied attributes.
- Browser errors carry bounded free-text message and stack fields. Stack text can contain bundle paths and function names. Session IDs are hashed for correlation.
- `./logs/session.db` outlives Pi. Protect, rotate, or remove it according to repository policy.
- A local sink is not a sandbox. Processes that can read the repository or connect to the sink can read its records.
- `LOG_SINK_PI_FILE_FALLBACK=1` creates another local retention surface when no endpoint exists.
- Standard OTLP environment variables and `LOG_SINK_ENDPOINT` can route records elsewhere. Inspect the launch environment before assuming data stays local.

See [Trust and data boundaries](trust-and-data-boundaries.md#telemetry) for the repository-wide policy.
