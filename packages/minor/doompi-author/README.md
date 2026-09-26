# @agimon-ai/doompi-author

Private, optional DoomPi minor mode for focused document review and bounded visual authoring.

## Behavior

Author is a session-scoped minor mode. Its three tools remain registered for the life of the extension but are active only while Author mode is active:

- `open_authoring_file({"path":"relative/file.png","alias":"review"})` validates a repository file and opens or reuses its temporary canvas without writing the file. Alias is optional. Opening the same file under another name returns the original alias; an alias cannot be reassigned to another file.
- `describe_author_tools({})` lists canvas aliases and readiness. `describe_author_tools({"alias":"review"})` returns that canvas's current capability catalog and server-issued token when ready. Opening does not wait for the tab to become ready; describe again after it opens.
- `use_author_tools({"alias":"review","catalogToken":"...","name":"...","arguments":{}})` invokes one capability with exactly the advertised arguments. Alias is optional only if one open canvas is unambiguous.

Catalog tokens rotate whenever capabilities change. Document-backed tools remain targetable from the main conversation while the canvas is open; live viewport grid operations require a visible tab. Closed canvases can be reopened by path and alias. Viewport document content is untrusted data, never agent instructions.

The package declares session API, cockpit client, and web hub entries. Each canvas has an isolated ownership lease and catalog token; stale bindings and cross-canvas tokens are rejected. Without the host session API socket and token, catalog operations fail as unavailable.

## Public API

```ts
import { activateAuthorExtension } from '@agimon-ai/doompi-author/extensions/pi';
import {
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

## Plugin lifecycle

Author uses the shared [plugin lifecycle contract](../../core/doompi-core/docs/plugins.md). Pi and server entries compose shared tool and command declarations; controllers own Author behavior, and the helpers own registration and disposal. Minor-mode entry and exit are independent of plugin mounting.
