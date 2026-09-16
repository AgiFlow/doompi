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
  platforms: { backend: ['cli', 'server'], frontend: ['cli', 'web', 'ios', 'android', 'desktop'] },
  generatedEntries: ['pi', 'server', 'web'],
});
```

## Generating

`generateExtension` scans the authored tree, renders an entry for each host it contributes to, and writes build inputs beneath ignored `generated/`. A target with no contributions produces no entry, and removing a target deletes its obsolete generated entry.

```ts
import { generateExtension } from '@agimon-ai/doompi-build';

const { targets, changed, notices } = generateExtension({ packageDir });
```

Normal builds generate missing or stale entries, including in CI. Pass `check: true` only for an explicit write-free freshness check. Generated files are disposable build output and are not committed.

## The tsdown preset

```ts
// tsdown.config.ts, the whole file
import { doompiExtension } from '@agimon-ai/doompi-build/tsdown';
import { defineConfig } from 'tsdown';

export default defineConfig(doompiExtension());
```

The preset generates entries while the config loads because tsdown needs its entry map before building. It builds Node host entries and public `src/exports` modules, then bundles routed frontend contributions separately to `dist/extensions/web.mjs`. The browser bundle keeps bare package imports external so the cockpit supplies shared React and store singletons. It also emits local `?url` assets and `?worker&url` worker chunks.

The build synchronizes `pi`, `doompiServer`, `doompiWeb`, and generated host exports in `package.json`. Keep package-specific public entries with the preset `entry` option, use `exportsDir` for a nonstandard public-export root, and set `pluginId` when the historical cockpit id differs from the package-derived default.

Packages with a frontend target typecheck it through a root `tsconfig.web.json`. Include `generated` in the Node project, exclude routed `(frontend)` files from it, and include those files plus `generated/web.ts` in the browser project.
