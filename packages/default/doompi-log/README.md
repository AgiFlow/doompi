# @agimon-ai/doompi-log

Session metrics, findings, sink status, and a Log Metrics overlay for Pi.

Part of the [DoomPi distribution](https://www.npmjs.com/package/@agimon-ai/doompi).

The extension aggregates telemetry it observes in-process and can query historical data from
`@agimon-ai/log-sink-mcp`.

> **Alpha:** metric attribution and UI contracts may change between releases.

## Requirements

- Node.js 22.19.0 or newer
- Pi 0.84.2 and Pi TUI 0.84.2

## Install

DoomPi includes Log in every composition. Pi discovers its sole extension entry through
`package.json.pi.extensions`. For standalone Pi:

```bash
pi install npm:@agimon-ai/doompi-log
```

Use `SPC h l` to open the current session's Log Metrics overlay.

## What is collected

The in-process aggregator tracks operational records such as turn token totals, cache use, tool
calls and failures, operation durations, recent errors, and event counts. It derives findings from
those records without requiring an external sink.

Historical panels resolve a sink over HTTP first and then use the Log Sink CLI fallback. Without a
reachable sink, current-session headline metrics, findings, errors, and tool metrics still work;
historical top-consumer and burn-rate views are unavailable. Sink failures are reported in status
rather than failing the Pi session.

Turn cost attribution is contextual: when a turn invokes several tools, the emitted turn total can
be associated with each participating tool. The overlay uses that value for ranking, not as a
precise per-tool share.

Keys: `r` refreshes, `g` changes dimension, `p` changes period, `?` opens details, and Escape closes.

## Telemetry controls

| Variable                   | Effect                                                 |
| -------------------------- | ------------------------------------------------------ |
| `AGENT_TELEMETRY_DISABLED` | Disables the extension's telemetry export              |
| `OTEL_SDK_DISABLED`        | Disables OpenTelemetry SDK export                      |
| `AGENT_OTEL_TRACES`        | Enables/disables trace export; logs can remain enabled |

File fallback is opt-in through host options. The absence of a configured or reachable endpoint
does not prevent in-process aggregation. Exceptions and caller-supplied attributes can still be
sensitive; do not assume "metadata" is harmless.

The overlay requires a TUI. The aggregator, findings, and metrics-source APIs can be embedded in
headless hosts.

## Public API

```ts
import {
  installDoomLogRuntime,
  deriveFindings,
  LogMetricsAggregator,
  openLogMetricsOverlay,
} from '@agimon-ai/doompi-log';
```

Normal Pi activation should use the discovered `extensions/pi` entry. Host integrations can call
`installDoomLogRuntime` to install package resources into the shared runner-scoped Cordis host. The
extension entry manages its plugin lifecycle and releases the host lease when the Pi session shuts
down. Focused exports provide metrics types, the metrics source, and the overlay component.

## Development

```bash
pnpm build
pnpm typecheck
pnpm test
pnpm lint
```

Maintained by [Agimon](https://agimon.ai/about).

## License

MIT
