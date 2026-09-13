# @agimon-ai/doompi-autocompact

Staged checkpoint summarization and iterative context compaction for DoomPi.

Part of the [DoomPi distribution](https://www.npmjs.com/package/@agimon-ai/doompi).

Instead of waiting for one final summary near the context limit, Autocompact creates up to three
asynchronous checkpoints and combines each checkpoint with subsequent messages.

> **Alpha:** thresholds and compaction steering may change between releases.

## Requirements

- Node.js 22.19.0 or newer
- Pi 0.85.0
- Authentication for the model selected for summarization

## Install

`doompi init` and `dpi init` include Autocompact in `default.packages` in `.doom/modes.yaml`.
Remove it or move it to a named layer to change which major modes load it. Pi discovers its sole
extension entry through `package.json.pi.extensions`. For direct Pi installation:

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

## Per-model token checkpoints

Ratios scale with the window, which is usually what you want. On a very large window they can
also mean the first checkpoint waits far longer than you would like: half of a one-million-token
window is 500,000 tokens. `modes.autocompact.overrides` pins individual passes to an absolute
token count for the models you name, and leaves every other model on the ratio ladder.

```yaml
modes:
  autocompact:
    overrides:
      - model: 'claude-opus-4-[6-9]'
        tokens:
          pass1: 75000
          pass2: 150000
          pass3: 200000
```

- Entries are tried in file order and the first match wins. A model matching nothing behaves
  exactly as it does without this key.
- `model` is a glob supporting `*` and character classes such as `[6-9]`. A pattern containing
  `/` is matched against `provider/id`, anything else against the bare model id, because the
  wildcard does not cross the separator. Matching ignores case.
- The lower of the ratio and the token count wins, so an override can only bring a checkpoint
  forward, never push one past the point Pi compacts natively.
- Counts are compared against total context usage, not against growth since the last compaction.
- A count at or below the current cycle's baseline is ignored and the pass falls back to its
  ratio. Without that, a compaction landing above the count would satisfy the pass as soon as
  the next cycle opened and re-fire it every turn.
- A pass never fires before the one before it. A list that puts a later pass lower is raised to
  match, the same way a ratio below the previous pass is.
- A repository config replaces the global list whole rather than merging entry by entry.
- These keys are not on the cockpit settings page; edit `.doom/config.yaml` directly.
  Summarization runs asynchronously in the background, on the session's own provider, so a model
  registered by a Pi provider extension summarizes through that extension. Checkpoints are
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

## Extension lifecycle and source layout

`extensions/pi.ts` declares the Autocompact runtime's optional services, typed events, and `onStop` cleanup. Shutdown cancels checkpoint generation and awaits pending work before releasing telemetry and runtime state. Session-tree changes retain their existing generation cancellation behavior. The runtime and policy live in `services/<name>/`, with constants and shared types in dedicated roots.

The direct server entry declares validated configuration resources and a native-fallback status activity from `controllers/serverAutocompact.ts`. The web entry declares settings sections. Flat `exports/` publishes reusable capabilities without forwarding extension entry points.
