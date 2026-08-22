# @agimon-ai/doompi-hashline

Shared snapshot-bound file tags and line anchors for DoomPi tools.

This is a foundation library, not a Pi extension. It has no `pi.extensions` entry, Cordis service,
or Pi peer dependency. Tool packages use the same protocol implementation without importing one
another.

## Protocol

The root export contains pure string and edit operations:

```ts
import { formatFileHeader, formatTaggedLine, parseFileHeader, parseTaggedLine } from '@agimon-ai/doompi-hashline';

const header = formatFileHeader('src/example.ts', 'A1b2C3d4');
const line = formatTaggedLine('const value = 1;', 1);

parseFileHeader(header);
parseTaggedLine(line);
```

File headers use an eight-character base64url SHA-256 prefix of the exact file bytes. Tagged lines
use a three-letter, whitespace-insensitive FNV-1a64 anchor. Match rows start with `>> `, and context
rows start with three spaces.

The root also exports anchor parsing, newline normalization, and pure original-snapshot range
application.

## File adapters

Node-specific helpers are isolated at the `/files` subpath:

```ts
import {
  computeFileTag,
  decodeUtf8,
  displayPath,
  isWritableFile,
  resolveInputPath,
  resolveReadInputPath,
} from '@agimon-ai/doompi-hashline/files';
```

`decodeUtf8` rejects invalid UTF-8. `isWritableFile` gates anchors to content the
agent can edit. `resolveInputPath`, `resolveReadInputPath`, and `displayPath`
preserve Pi-compatible path behavior across the read, grep, and edit tools.

## Attribution

The hashline protocol and FNV anchor approach are adapted from
[Phi's writetool](https://github.com/pulseaiclub/phi/tree/main/internal/tools/writetool), licensed
under MIT by pulseaiclub. DoomPi uses an exact-byte SHA-256 file tag as an intentional compatibility
boundary.

## Development

```bash
pnpm build
pnpm typecheck
pnpm test
pnpm lint
```

## License

MIT
