# @agimon-ai/doompi-author

Private DoomPi foundation for focused document review and bounded visual authoring.

## Behavior

Author is a session-scoped minor mode. Its two stable tools remain registered for the life of the extension but are active only while Author mode is active:

- `describe_author_tools` returns the current viewport capability catalog and its server-issued token.
- `use_author_tools` invokes one named capability with exactly the arguments accepted by its advertised schema.

Catalog tokens rotate whenever viewport capabilities change. Viewport document content is treated as untrusted data and never as agent instructions.

The package also declares its session API, cockpit client, and web hub entries. These foundation surfaces expose inactive state until a later viewport broker supplies live capabilities.

## Public foundation API

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
