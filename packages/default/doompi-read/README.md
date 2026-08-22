# @agimon-ai/doompi-read

Snapshot-bound hashline `read` tool for Pi and DoomPi.

Part of the [DoomPi distribution](https://www.npmjs.com/package/@agimon-ai/doompi).

The package replaces only Pi's `read` registration. Writable text reads attach an exact file tag and
a stable three-letter anchor to every returned line. Non-writable files retain Pi's native output,
which avoids spending model context on anchors that cannot be edited. The full hashline protocol
remains available to the model, while DoomPi's renderer hides the protocol tags and anchors from
people and preserves syntax highlighting. Image reads retain Pi's native attachment behavior.

> **Alpha:** tool and protocol contracts may change between releases.

## Requirements

- Node.js 22.19.0 or newer
- Pi 0.84.2 and Pi TUI 0.84.2

## Install

```bash
pi install npm:@agimon-ai/doompi-read
```

Pi discovers `@agimon-ai/doompi-read/extensions/pi` from the package manifest. Install
`@agimon-ai/doompi-edit` when the model should apply the anchors emitted by this package.

When `@agimon-ai/doompi-ui` is installed directly in standalone Pi, list
`@agimon-ai/doompi-read` first so its `read` registration owns the shared tool name. DoomPi's composed
runtime loads selectable packages after the UI package, so the hashline tool owns `read` there.

## Tool protocol

A writable text result starts with one file header, followed by tagged lines:

```text
@file src/example.ts#A1b2C3d4
1#abc|const value = 1;
```

The eight-character file tag is the base64url SHA-256 prefix of the exact file bytes. The
three-letter line anchor is a whitespace-insensitive FNV-1a64 tag. Large reads retain Pi's output
limits and include an offset hint when more lines are available.

## Attribution

The hashline protocol and FNV anchor approach are adapted from
[Phi's writetool](https://github.com/pulseaiclub/phi/tree/main/internal/tools/writetool), licensed
under MIT by pulseaiclub. DoomPi uses an exact-byte SHA-256 file tag as an intentional compatibility
boundary.

## Public API

```ts
import { ReadParamsSchema, registerHashlineReadTool } from '@agimon-ai/doompi-read';
import type { ReadParams } from '@agimon-ai/doompi-read';
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
