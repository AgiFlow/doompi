# @agimon-ai/doompi-grep

Snapshot-bound hashline grep for Pi and DoomPi.

Part of the [DoomPi distribution](https://www.npmjs.com/package/@agimon-ai/doompi).

The package replaces only Pi's `grep` registration. It delegates searching to
Pi's native grep tool, preserving its ripgrep behavior, then attaches an exact
file tag and a stable three-letter anchor to matching or context lines from
writable files. Matches in non-writable files retain Pi's native output to save
model context. The matching `@agimon-ai/doompi-read` and `@agimon-ai/doompi-edit`
packages use the same hashline protocol.

> **Alpha:** tool and protocol contracts may change between releases.

## Requirements

- Node.js 22.19.0 or newer
- Pi 0.85.0 and Pi TUI 0.85.0

## Install

```bash
pi install npm:@agimon-ai/doompi-grep
```

Pi discovers `@agimon-ai/doompi-grep/extensions/pi` from the package manifest.

Install `@agimon-ai/doompi-edit` when the model should apply the anchors emitted by this package.

When `@agimon-ai/doompi-ui` is installed directly in standalone Pi, list
`@agimon-ai/doompi-grep` first so its `grep` registration owns the shared tool name. DoomPi's
composed runtime loads selectable packages after the UI package, so the hashline tool owns `grep`
there.

## Tool protocol

Writable search results group matching and context lines beneath an exact-byte
file header:

```text
@file src/example.ts#A1b2C3d4
   4#def|const previous = true;
>> 5#abc|const match = true;
```

The eight-character file tag and three-letter line anchors are model-facing protocol data. DoomPi's
human renderer hides the protocol tags and anchors while retaining file paths, line numbers, match
markers, and syntax highlighting.

## Attribution

The hashline protocol and FNV anchor approach are adapted from
[Phi's writetool](https://github.com/pulseaiclub/phi/tree/main/internal/tools/writetool), licensed
under MIT by pulseaiclub. DoomPi uses an exact-byte SHA-256 file tag as an intentional compatibility
boundary.

## Public API

```ts
import { GrepParamsSchema, registerHashlineGrepTool } from '@agimon-ai/doompi-grep';
import type { GrepParams } from '@agimon-ai/doompi-grep';
```

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
