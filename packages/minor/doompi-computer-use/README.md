# @agimon-ai/doompi-computer-use

Session-scoped semantic computer control through the DoomPi Desktop capability.

## Requirements

- Node.js 22.19.0 or newer
- A supported packaged macOS DoomPi Desktop with native Computer Use permissions
- The Pi version declared by this package's peer dependencies

## Install

```bash
pi install npm:@agimon-ai/doompi-computer-use
```

## Use

In Desktop, enable Computer Use in global settings, then select the default-off **Computer Use** minor mode. Its Activity section lists eligible application windows and starts native confirmation. Only one session can hold a live Desktop run. The setting, minor-mode row, and Activity group are hidden in a normal browser, including a browser opened against the Desktop server.

The `computer-use` minor mode exposes Activate, Deactivate, and Doctor actions. `/computer-use` reports the current state.

While active, the package exposes three tools:

- `computer_state` observes the authorized window and returns a semantic snapshot.
- `computer_action` performs one semantic press, focus change, value change, or scroll against a current snapshot.
- `computer_exec` executes a reusable JavaScript or erasable TypeScript function and its relative helpers in a restricted runtime, then returns a fresh semantic observation.

Generated functions receive the authorized program API, JSON input, bounded logging, and cancellation. They do not receive Node or filesystem access. Script-internal observations omit screenshots by default, and `includeScreenshot: true` requests an image explicitly. Full Node execution requires both `trusted: true` and an exact host-configured `DOOMPI_COMPUTER_USE_SCRIPT_PATHS` allowlist. Trusted scripts remain unsandboxed, including their imported dependencies. See [Author computer functions](./docs/computer-scripts.md) for the contract, limits, trust boundary, and examples.

All three tools remain unavailable during setup and are admitted only after the native grant becomes active. Disabling the mode or global opt-in, stopping control, expiry, or Desktop disconnection stops further actions. Once Desktop claims a session, browser and remote MCP clients cannot drive it, including previously attached clients. This ownership stays pinned for the server lifetime and is not restored from saved session data.

## Public API

```ts
import { ComputerScriptRunner, createComputerUseSessionClient } from '@agimon-ai/doompi-computer-use';
import type { ComputerScriptRun } from '@agimon-ai/doompi-computer-use';
```

The session-scoped server facet owns the agent and hub routes. Their host-issued context tokens remain opaque and session-bound inside the request broker.

## Development

```bash
pnpm fixcode
pnpm typecheck
pnpm test
pnpm build
```

## License

MIT

Direct plugin routes live in `src/extensions`. The session root constructs one broker shared by the typed agent client and activation API. The host owns the Desktop IPC connection, native renderer authentication, session identity, and grant lifetime. The hub channel uses lifecycle events rather than polling to forward operations. The CLI compatibility runtime keeps its existing polling lifecycle. Public exports remain under `src/exports`.
