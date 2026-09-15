# @agimon-ai/doompi-build

Folder-convention scanner and build presets for DoomPi extensions.

An extension declares what it contributes by where its files sit. This package reads that tree and hands the result to the generators and bundler presets, so a package keeps no parallel registry of its own contents.

See [Extension layout](../../../docs/extension-layout.md) for the convention and [Extension lifecycles](../../../docs/lifecycles.md) for what happens to a contribution once mounted.

## Scanning

```ts
import { scanExtensions } from '@agimon-ai/doompi-build';

const graph = scanExtensions({ packageDir: process.cwd() });
for (const entry of graph.entries) console.log(entry.scope, entry.side, entry.surface, entry.name);
for (const notice of graph.notices) console.warn(notice.path, notice.message);
```

The scan is filesystem in, data out. It walks directories rather than globbing, which is what keeps parenthesised group folders safe: tsdown's globber reads a bare `(name)` as an extglob group, and a walk never sees a pattern at all.

Nothing throws. A folder the convention does not recognise becomes a notice and its subtree is skipped, so one bad directory never costs a package its other contributions.

## What a path declares

```text
src/extensions/<scope>/(side)/<surface>/<name>[.<target>][.<platform>].<ext>
```

| Axis     | Read from                                                          |
| -------- | ------------------------------------------------------------------ |
| scope    | `workspaces/` and `sessions/` nesting below the root               |
| side     | the `(backend)` or `(frontend)` group folder                       |
| gate     | a `mode/<id>/` or `domain/<id>/` container folder                  |
| surface  | the folder directly holding the file, such as `tool/`              |
| route    | folders below a routed surface, with `[param]` and `[...catchAll]` |
| name     | the first filename segment                                         |
| target   | filename segments between the name and the platform                |
| platform | a trailing filename segment naming a platform for that side        |

`_private` folders are never scanned. `*.test.*`, `*.spec.*` and `*.stories.*` are excluded everywhere.

## Options

Every name in the convention is configurable, and the defaults are the documented ones.

```ts
scanExtensions({
  packageDir,
  root: 'src/extensions',
  sides: { backend: 'backend', frontend: 'frontend' },
  platforms: { backend: ['cli', 'server'], frontend: ['web', 'ios', 'android', 'desktop'] },
  generatedEntries: ['pi', 'server', 'web'],
});
```
