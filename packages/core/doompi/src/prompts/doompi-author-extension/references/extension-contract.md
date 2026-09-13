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
|-- types/       Shared types
|-- schemas/     Runtime validation
|-- models/      Mutable state
|-- services/    Logic, including filesystem, process, and network operations
|   `-- review/  index.ts implementation, type.ts service ports
|-- controllers/ Request and command handlers using services and models
|-- tools/       Typed tool declarations using services and models
|-- extensions/  Direct pi.ts, server.ts, and web.ts host composition
|-- web/         Browser presentation when needed
|-- tui/         Terminal presentation when needed
|-- prompts/     Published package-owned Help prompts
`-- exports/     Flat public forwarding files, reusable APIs only
```

Omit unused folders. There are no adapters, container, commands, or providers roots. Services may perform IO and provide Cordis services, but host bootstrapping and native registration belong to the extension helpers. Imports point from extensions to controllers/tools to services/models, then schemas/types/constants. Use extensionless source imports and omit `/index`.

## Plugin declarations and lifecycle

The helper joins the shared Cordis host and owns registration and teardown. A Pi entry composes typed declarations:

```ts
import { definePiExtension } from '@agimon-ai/doompi-core/pi-extension';
import { createReviewCommand } from '../controllers/reviewCommand';
import { createReviewService } from '../services/review';

export const reviewExtension = definePiExtension('@example/doompi-review', () => {
  const service = createReviewService();
  return {
    commands: [createReviewCommand(service)],
    resources: [
      {
        source: '@example/doompi-review',
        moduleUrl: import.meta.url,
        skills: [{ name: 'doompi-use-review', description: 'Configure and use the review extension.' }],
      },
    ],
  };
});

export default reviewExtension;
```

Controllers use `defineCommand` for portable commands; tools use `defineTool` for portable tools or `definePiTool` for native Pi capabilities. Server plugins declare a `name` and explicit `global`, `workspace`, and `session` scopes. Each scope is a contribution object or typed factory, and exposes `api`, `methods`, or `channels`; session scope also exposes agent capabilities. A `doompiServer` manifest points directly to `./src/extensions/server.ts`. Browser plugins similarly live directly in `./src/extensions/web.ts`.

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
