# @agimon-ai/doompi-edit

Snapshot-bound hashline edit tool for Pi and DoomPi.

Part of the [DoomPi distribution](https://www.npmjs.com/package/@agimon-ai/doompi).

The package replaces only Pi's `edit` registration. It consumes the exact file tags and stable
three-letter anchors produced by `@agimon-ai/doompi-read`, `@agimon-ai/doompi-grep`, or another
compatible hashline producer. Stale or ambiguous mutations fail before any file is changed.

> **Alpha:** tool and protocol contracts may change between releases.

## Requirements

- Node.js 22.19.0 or newer
- Pi 0.85.0 and Pi TUI 0.85.0

## Install

```bash
pi install npm:@agimon-ai/doompi-edit
```

Pi discovers `@agimon-ai/doompi-edit/extensions/pi` from the package manifest.

Standalone Pi also needs `@agimon-ai/doompi-read`, `@agimon-ai/doompi-grep`, or another compatible
producer for the file tags and anchors consumed by this tool.

If `@agimon-ai/doompi-ui` is also installed directly in standalone Pi, list
`@agimon-ai/doompi-edit` first when its `edit` tool should win. DoomPi's default distribution
installs `@agimon-ai/doompi-read`, `@agimon-ai/doompi-grep`, and `@agimon-ai/doompi-edit` together.

## Tool protocol

Compatible read and grep results start with a file header followed by tagged lines:

```text
@file src/example.ts#A1b2C3d4
1#abc|const value = 1;
```

The shared protocol is implemented by `@agimon-ai/doompi-hashline`. The eight-character file tag is
the base64url SHA-256 prefix of the exact file bytes. The three-letter line anchor is a
whitespace-insensitive FNV-1a64 tag.

`edit` accepts:

```json
{
  "path": "src/example.ts",
  "hash": "A1b2C3d4",
  "edits": [
    {
      "from": "1#abc",
      "to": "1#abc",
      "content": "const value = 2;"
    }
  ]
}
```

All anchors refer to the original snapshot. Ranges are inclusive. Omit `content` to delete a range.
Exact duplicate edits are applied once, but any other overlapping ranges are rejected before
mutation.

Pass exactly one anchor in each `from` and `to` value, for example `5#abc`. Anchors copied with a
`>`, `+`, or `-` display prefix are accepted, as are uppercase anchor letters, whitespace around
the separator, and the legacy `5:abc` separator. Pasted multiline blocks are rejected.

## Attribution

The hashline protocol and FNV anchor approach are adapted from
[Phi's writetool](https://github.com/pulseaiclub/phi/tree/main/internal/tools/writetool), licensed
under MIT by pulseaiclub. DoomPi uses an exact-byte SHA-256 file tag as an intentional compatibility
boundary.

## Public API

```ts
import { EditParamsSchema, executeHashlineEdit, registerHashlineEditTool } from '@agimon-ai/doompi-edit';
import type { EditParams, HashlineRange } from '@agimon-ai/doompi-edit';
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
