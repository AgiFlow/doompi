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
|-- types/       Domain types and ports
|-- schemas/     Runtime validation
|-- services/    Host-neutral behavior
|-- adapters/    Filesystem, process, network, and host implementations
|   `-- pi/      Pi and Cordis composition root
|-- commands/    Pi command translation when needed
|-- container/   Plain dependency construction when needed
|-- prompts/     Published package-owned Help prompts
`-- exports/     Package manifest surfaces only
```

Services must not import Pi, Cordis, concrete adapters, containers, or Node builtins. Put host interaction in adapters and keep the Pi entry thin.

## Standard Pi and Cordis lifecycle

The factory joins the runner-owned host, mounts one package fiber, and releases resources in order:

```ts
import { connectDoomCordisHost } from '@agimon-ai/doompi-extension-contracts/cordis-host';
import type { Context } from '@deepseek-ai/cordis';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

const PACKAGE_SOURCE = '@example/doompi-review';

function reviewPlugin(cordis: Context, { pi }: { readonly pi: ExtensionAPI }): void {
  cordis.effect(function* () {
    pi.registerCommand('review', {
      description: 'Review the current change',
      handler: async () => undefined,
    });
    yield () => undefined;
  }, PACKAGE_SOURCE);
}

export async function reviewExtension(pi: ExtensionAPI): Promise<void> {
  const connection = await connectDoomCordisHost(pi, PACKAGE_SOURCE);
  const fiber = connection.root.plugin(reviewPlugin, { pi });
  try {
    await fiber;
  } catch (error) {
    try {
      await fiber.dispose();
    } finally {
      await connection.dispose();
    }
    throw error;
  }

  let disposal: Promise<void> | undefined;
  pi.on(
    'session_shutdown',
    () =>
      (disposal ??= (async () => {
        try {
          await fiber.dispose();
        } finally {
          await connection.dispose();
        }
      })()),
  );
}

export default reviewExtension;
```

Do not construct a package-local Cordis `Context`. Same-runner collaboration belongs to the shared host. A separately installed extension can use the host bridge's standalone fallback.

## Consuming shared services

Use an owning injection for every required service:

```ts
cordis.inject([DOOM_UI_HUB_SERVICE], (context) => {
  const handle = requireDoomUiHub(context).registerLeader({
    source: PACKAGE_SOURCE,
    bindings: [],
  });
  return () => handle.dispose();
});
```

The injection waits for late providers, disposes the handle when a provider disappears, and registers again against a replacement. Do not read a required service outside the injection that owns it.

## Contributing activation-gated Help

Ship an H1-led `llms.txt` whose relative links remain inside the published package. Register concise skill descriptors from the package plugin:

```ts
cordis.inject([DOOM_HELP_SERVICE], (context) => {
  const handle = requireDoomHelpService(context).register({
    source: PACKAGE_SOURCE,
    moduleUrl: import.meta.url,
    skills: [
      {
        name: 'doompi-use-review',
        description: 'Configure and use the review extension.',
      },
    ],
  });
  return () => handle.dispose();
});
```

The contribution must use the exact nearest package name. Help resolves that package's local `llms.txt`, then its immutable exact-version cache, then a verified exact-version download. Do not point an index at repository files outside the package.

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
