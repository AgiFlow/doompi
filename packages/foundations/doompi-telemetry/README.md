# @agimon-ai/doompi-telemetry

Host-neutral telemetry helpers and Log Sink adapters shared by DoomPi packages.

Part of the [DoomPi distribution](https://www.npmjs.com/package/@agimon-ai/doompi).

This is a library, not a Pi extension. It has no Pi manifest or Pi peer dependency and should not
be added to a DoomPi layer.

> **Alpha:** telemetry attributes and sink contracts may change between releases.

## Requirements

- Node.js 22.19.0 or newer

## Install

```bash
npm install @agimon-ai/doompi-telemetry
```

## Use

```ts
import { createDoomTelemetry } from '@agimon-ai/doompi-telemetry';

const telemetry = createDoomTelemetry({
  serviceName: 'review-extension',
  packageName: '@example/review-extension',
  cwd: process.cwd(),
  env: process.env,
  enableLogs: true,
  enableTraces: true,
});

await telemetry.recordEvent('review.started', { 'review.file_count': 3 });
await telemetry.flush();
await telemetry.shutdown();
```

The root and `/telemetry` subpath expose `createDoomTelemetry`, attribute sanitization, header
creation, record subscriptions, and related types.

## Data and failure behavior

The adapter sanitizes attribute shapes and hashes selected identifiers before export. It is designed
for operational metadata, but callers remain responsible for the values they pass. Do not attach
prompt text, file contents, credentials, or unreviewed user data.

Exception export is optional and can include error names, messages, and stack context. Those fields
may disclose code paths or values even when ordinary attributes are metadata-only.

When no endpoint is configured, telemetry export becomes a no-op rather than breaking the host.
Explicit file fallback must be enabled by the caller; it is not silently selected. Status and
diagnostic callbacks surface sink initialization, recording, flushing, and shutdown behavior.

Common controls used by DoomPi hosts include `AGENT_TELEMETRY_DISABLED`, `OTEL_SDK_DISABLED`, and
`AGENT_OTEL_TRACES`. Hosts must decide whether these variables, endpoint configuration, or explicit
options have precedence in their integration.

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
