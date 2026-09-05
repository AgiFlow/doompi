# @agimon-ai/doompi-author

Private, optional DoomPi minor mode for focused document review and bounded visual authoring.

## Behavior

Author is a session-scoped minor mode. Its three tools remain registered for the life of the extension but are active only while Author mode is active:

- `open_authoring_file` validates a relative repository path and opens a focused document tab without writing the file.
- `describe_author_tools` returns the current viewport capability catalog and its server-issued token.
- `use_author_tools` invokes one named capability with exactly the arguments accepted by its advertised schema.

Catalog tokens rotate whenever viewport capabilities change. Viewport document content is treated as untrusted data and never as agent instructions.

The package declares session API, cockpit client, and web hub entries. Its bridge brokers live viewport capabilities through an ownership lease and rejects stale bindings. Without the host session API socket and token, catalog operations fail as unavailable.

## Public API

```ts
import {
  activateAuthorExtension,
  createAuthorCatalog,
  DescribeAuthorToolsInputSchema,
  UseAuthorToolInputSchema,
} from '@agimon-ai/doompi-author';
```

The Pi host entry is available at `@agimon-ai/doompi-author/extensions/pi`.

## Development

```bash
pnpm fixcode
pnpm typecheck
pnpm test
pnpm build
```
