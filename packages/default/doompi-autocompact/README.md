# @agimon-ai/doompi-autocompact

Staged checkpoint summarization and iterative context compaction for DoomPi.

Part of the [DoomPi distribution](https://www.npmjs.com/package/@agimon-ai/doompi).

Instead of waiting for one final summary near the context limit, Autocompact creates up to three
asynchronous checkpoints and combines each checkpoint with subsequent messages.

> **Alpha:** thresholds and compaction steering may change between releases.

## Requirements

- Node.js 22.19.0 or newer
- Pi 0.84.2
- Authentication for the model selected for summarization

## Install

DoomPi includes Autocompact in every composition. Pi discovers its sole extension entry through
`package.json.pi.extensions`. For direct Pi installation:

```bash
pi install npm:@agimon-ai/doompi-autocompact
```

The extension entry is `@agimon-ai/doompi-autocompact/extensions/pi`.

## Checkpoint ladder

The standard adapter uses thresholds around 50%, 75%, and 95% of the usable context window,
subject to token caps and Pi's native-compaction clamp:

1. create an initial compact summary;
2. combine it with later messages and allow the model to decide whether compaction is ready;
3. combine again and force compaction on the final pass.

Summarization runs in a worker thread so the foreground session can continue. Checkpoints are
persisted as hidden session entries and used for later steering.

DoomPi uses the configured planning subagent model and thinking level when available, then falls
back to the active Pi model. Standalone Pi without DoomPi planning configuration uses the active
model. Each checkpoint can therefore make another provider request, consume quota, and require the
credentials for the selected model. Provider errors or missing authentication affect checkpoint
generation rather than granting a free local summary.

## Coordination state

Autocompact does not own `@agimon-ai/doompi-task` or `@agimon-ai/doompi-team` persistence. The
standard adapter reads best-effort snapshots from those packages when available, while Task's
`tasks.json` and Team's run and intercom state remain owned by their respective packages. Missing
snapshot data is reported as unavailable and must not be inferred from an Autocompact summary.

## Public API

```ts
import { installAutocompactRuntime, thresholdTokens } from '@agimon-ai/doompi-autocompact';
import type { AutocompactPass } from '@agimon-ai/doompi-autocompact';
```

Normal Pi activation should use the discovered `extensions/pi` entry. Host integrations can call
`installAutocompactRuntime` to install package resources into the shared runner-scoped Cordis host.
The extension entry manages its plugin lifecycle and releases the host lease when the Pi session
shuts down. `thresholdTokens` exposes the threshold policy for hosts that need to preview or test
checkpoint boundaries.

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
