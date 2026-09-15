# Authoring contract for DoomPi extensions

Use this reference when creating a new extension or checking an existing package against the distribution contract.

## Environment and dependencies

Inside this monorepo:

- Choose the package tier before scaffolding.
- Keep Doom-to-Doom dependencies as `workspace:*`.
- Use the repository-pinned published versions for Cordis, Pi, Vibe-Lint, and other foundation packages.
- Set `sourceTemplate` to `doom-extension` and follow the package's inherited Vibe-Lint rules.

Outside this monorepo:

- Use published npm versions for every dependency, including DoomPi packages.
- Match the Pi peer version required by the installed DoomPi release.
- Do not copy repository-only scripts or internal paths into the package.
- Verify the packed tarball in a clean consumer project before publishing.

## Minimum package shape

A standard extension is a public ESM package with an explicit publish allowlist and closed exports:

```json
{
  "name": "@example/doompi-review",
  "version": "1.0.0",
  "type": "module",
  "files": ["dist", "llms.txt", "README.md", "src/prompts"],
  "exports": {
    ".": {
      "types": "./dist/index.d.mts",
      "import": "./dist/index.mjs",
      "require": "./dist/index.cjs"
    },
    "./extensions/pi": {
      "types": "./dist/extensions/pi.d.mts",
      "import": "./dist/extensions/pi.mjs",
      "require": "./dist/extensions/pi.cjs"
    },
    "./package.json": "./package.json"
  },
  "pi": {
    "extensions": ["./dist/extensions/pi.mjs"]
  }
}
```

Help identity resolution requires the nearest `package.json` to declare an exact semantic version,
including during local development. Every relative resource linked from `llms.txt` must also be in
the publish allowlist. Keep `src/prompts` in `files` when the index links package-owned Help.

Add a root export only when consumers need a library API. Pi discovery still needs a callable default factory at the manifest entry.

Use the canonical source vocabulary and omit unused folders:

```text
src/
|-- constants/   Constant data
|-- types/       Shared browser-safe types
|-- schemas/     Runtime validation
|-- models/      Mutable state
|-- services/    Logic, including filesystem, process, and network operations
|   `-- review/  index.ts implementation, type.ts service ports
|-- controllers/ Request and command handlers using services and models
|-- tools/       Reusable typed tool declarations
|-- extensions/  Routed host contributions by scope, side, surface, and filename
|-- tui/         Shared terminal presentation when needed
|-- prompts/     Published package-owned Help prompts
`-- exports/     Flat public forwarding files, reusable APIs only
```

Browser-only implementation details should live in `_components` or `_lib` beside their routed frontend contribution. These private folders are not scanned. Use `src/types`, `src/constants`, and `src/schemas` only for code intentionally shared across sides.

Omit unused folders. There are no adapters, container, commands, or providers roots. Services may perform IO and provide Cordis services, but host bootstrapping and native registration belong to the extension helpers. Imports point from extensions to controllers/tools to services/models, then schemas/types/constants. Use extensionless source imports and omit `/index`.

## Plugin declarations and lifecycle

The routed file exports one contribution. Its path supplies the scope, host side, surface, and identity:

```ts
// src/extensions/workspaces/sessions/(backend)/command/review.ts
import { defineCommand } from '@agimon-ai/doompi-core/extension-file';

import { createReviewCommand } from '../../../../../controllers/reviewCommand';
import { createReviewService } from '../../../../../services/review';

export default defineCommand(() => createReviewCommand(createReviewService()));
```

Use `defineCommand` for portable commands, `defineTool` for portable tools, `definePiTool` for native Pi capabilities, and the matching typed helper for every other surface. The generated server facet and browser plugin group routed declarations by scope. Use an `extra.<target>.ts` escape hatch only when a legacy contribution object cannot be represented without changing behavior.

The package build is convention-driven:

```ts
import { doompiExtension } from '@agimon-ai/doompi-build/tsdown';
import { defineConfig } from 'tsdown';

export default defineConfig(doompiExtension());
```

Generated `pi.ts`, `server.ts`, and `web.ts` entries live under ignored `generated/`. The build publishes Node host entries and a browser bundle at `dist/extensions/web.mjs`, then synchronizes host metadata in `package.json`. A frontend package uses a root `tsconfig.web.json`; never publish or import a hand-written `src/extensions/web.ts`.

Factories may return a promise. The helper waits for the declaration, mounts service contributions, registers capabilities, and awaits `onStart`. Shutdown aborts the instance signal, waits for startup to settle, awaits `onStop`, releases registrations in reverse order, then awaits `onDispose`. `onStop` runs once the start stage has been reached, including when `onStart` is absent or fails. Registration failures still release acquired handles and call accepted `onDispose`. Cleanup is idempotent and all cleanup stages run even when one fails.

Hooks receive one typed context. Factories construct state; `onStart` begins external work. Use `onStop` to stop and drain it, and `onDispose` for final instance resources. Omit unused hooks and let the helper own registration cleanup. Do not manually connect the Cordis host, call another facet's `apply`, or register a second shutdown wrapper.

Use arrays for fixed tools and minor modes. Pi supports typed `PiToolCollection` and `PiMinorModeCollection` with `snapshot()` and `subscribe(listener)` when availability changes while mounted. Helpers own subscriptions, cancel withdrawn tools, detach withdrawn mode owners, and follow optional provider replacement. A new tool declaration with the same name replaces the implementation and aborts old invocations. Removed tools retain an unavailable native wrapper.

## Shared providers and Help

Place a provider's Cordis implementation in its service folder, then include the plugin in the extension's `services` array. Consume a required service inside an owning injection using its `require...` accessor. Return subscription and registration disposers from that injection so provider replacement retracts stale handles. The extension entry only composes the service plugin.

The helper already handles optional provider binding for declared `resources`, minor modes, tool restrictions, and other native contributions. Do not duplicate those registrations in a service plugin or lifecycle hook.

Help contributions use the exact nearest package name. Publish every relative resource linked from the package's H1-led `llms.txt`, and provide `moduleUrl: import.meta.url` in the resources declaration. Help resolves the local index, then an immutable exact-version cache, then a verified exact-version download. Never point the index at unpublished repository files.

## Verification

Inside the monorepo, run:

```sh
pnpm vibe-lint check --rules-only <changed-source-files>
pnpm lint:vibe --preflight-only
pnpm nx lint <project>
pnpm nx typecheck <project>
pnpm nx build <project>
pnpm nx test <project>
```

Run the packed-install system target when manifests, exports, Pi entries, or published resources change.

For an external package, run its lint, typecheck, build, and tests, then inspect `npm pack --dry-run` and install the tarball into a clean project. Verify Pi discovers the entry, repeated shutdown is safe, and a replaced Cordis provider does not retain stale registrations.
