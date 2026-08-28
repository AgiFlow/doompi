# Observability

[Back to DoomPi](../README.md)

DoomPi Log keeps current-session metrics in the Pi process. A local Log Sink is optional and adds persistent history and trace lookup. DoomPi does not ship a collector, dashboard, or remote telemetry endpoint.

Run the commands below from the repository root. The package filter is intentional: `log-sink-mcp` is a packaged dependency of `@agimon-ai/doompi-log`, not a root executable.

## Start, inspect, and stop a local sink

```bash
pnpm --filter @agimon-ai/doompi-log exec log-sink-mcp start
pnpm --filter @agimon-ai/doompi-log exec log-sink-mcp status
pnpm --filter @agimon-ai/doompi-log exec log-sink-mcp stop
```

The default instance is scoped to the current repository. Run all lifecycle and query commands from the same repository so they resolve the same instance. By default, records persist in `./logs/session.db`. `status` prints the resolved instance, process, port, health URL, and database path.

After the sink starts, launch DoomPi normally. In Pi, `/log-metrics` and `SPC h l` both open Log Metrics. Headline counters and findings are aggregated in-process even without a sink. Historical top-consumer and token-burn panels require sink data.

Query the repository-local database directly:

```bash
pnpm --filter @agimon-ai/doompi-log exec log-sink-mcp logs metrics --service pi --group-by agent
pnpm --filter @agimon-ai/doompi-log exec log-sink-mcp logs trace <trace-id>
```

`logs metrics` reports workflow, token, failure, and per-tool consumption metrics. `logs trace` prints the chronological records for one trace ID. Add `--global` only when the writer and query are intentionally configured to use the shared global instance.

## Disposable smoke workflow

Use an in-memory sink when checking startup and ingestion without creating `./logs/session.db`:

```bash
pnpm --filter @agimon-ai/doompi-log exec log-sink-mcp start --in-memory --port 3100
pnpm --filter @agimon-ai/doompi-log exec log-sink-mcp status
curl --fail http://127.0.0.1:3100/health
curl --fail --request POST http://127.0.0.1:3100/logs \
  --header 'content-type: application/json' \
  --data '{"logs":[{"level":"info","message":"doompi smoke","service":"doompi-smoke","traceId":"0123456789abcdef0123456789abcdef"}]}'
pnpm --filter @agimon-ai/doompi-log exec log-sink-mcp stop
```

The in-memory database belongs to the background sink process and disappears when it stops. Use the persistent default workflow when testing `logs metrics`, `logs trace`, or historical Pi panels across separate CLI processes.

## Disable controls

Set either control before starting Pi:

```bash
AGENT_TELEMETRY_DISABLED=1 doompi
OTEL_SDK_DISABLED=1 doompi
```

`AGENT_TELEMETRY_DISABLED` disables DoomPi's Pi telemetry extension for that process. `OTEL_SDK_DISABLED` disables OpenTelemetry SDK export globally for that process. When metrics collection is disabled, `/log-metrics` and `SPC h l` show the disabled state rather than zero activity. `AGENT_OTEL_TRACES` controls span export separately, so disabling traces alone does not disable logs.

## Privacy and data boundaries

- Prompts, tool inputs, and tool results are omitted by default. `AGENT_OTEL_REDACT=0` includes them and can expose source, commands, credentials, or model content.
- Operational metadata can still be sensitive. Records can include session and parent-session IDs, working directory, model, tool names, token and cost totals, errors, workflow identity, and caller-supplied attributes.
- A default local sink writes to `./logs/session.db` and retains data after Pi exits. Protect, rotate, or remove that file according to the repository's data policy. `--in-memory` avoids this persistence.
- Local scope is an instance-selection rule, not a security sandbox. Processes with access to the repository or local sink can read its records.
- Without a configured or discovered endpoint, export is dropped by default. `LOG_SINK_PI_FILE_FALLBACK=1` opts into file fallback and therefore creates another local retention surface.
- DoomPi configures no vendor collector. Standard OTLP endpoint environment variables or `LOG_SINK_ENDPOINT` can route data elsewhere, so inspect the launch environment before assuming records stay local.

See [Trust and data boundaries](trust-and-data-boundaries.md#telemetry) for the repository-wide telemetry boundary.
