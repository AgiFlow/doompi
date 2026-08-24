import type { PatternDefinition } from '@agimon-ai/vibe-lint';

/**
 * Design-pattern context surfaced before a DoomPi web package file is edited.
 * A web package ships a browser bundle and a server from one source tree, so
 * each folder states which of the two it belongs to and what it may reach.
 */
export const patterns: Record<string, PatternDefinition> = {
  'doom-web-types': {
    description:
      'Framework-neutral contracts both sides share: request and response payloads, domain entities, and option shapes. Imports nothing else in the package, which is what makes it the one root the browser and the server may both read.',
    includes: ['src/types/**'],
  },
  'doom-web-services': {
    description:
      'Server-side domain policy over the types layer. No HTTP framework, no filesystem, no browser API, so every rule stays testable without a running server.',
    includes: ['src/services/**'],
  },
  'doom-web-adapters': {
    description:
      'Server-side integration with the outside world: HTTP handlers, static asset serving, filesystem and process access, and third-party clients. An adapter satisfies a contract declared in src/types and delegates behavior to src/services.',
    includes: ['src/adapters/**'],
  },
  'doom-web-bin': {
    description:
      'Executable entrypoints declared in package.json bin. Reads argv and the environment, assembles the service and adapter graph, and starts the server. Behavior belongs one layer down.',
    includes: ['src/bin/**'],
  },
  'doom-web-exports': {
    description:
      "The package's only public surface. Pure re-exports, one file per package.json exports subpath, mirroring the subpath tree.",
    includes: ['src/exports/**'],
  },
  'doom-web-client-lib': {
    description:
      'Browser helpers with no React state and no server import: formatting, parsing, typed fetch wrappers, and query client setup. The lowest client layer above types.',
    includes: ['src/web/lib/**'],
  },
  'doom-web-client-stores': {
    description:
      'Client state containers, one <topic>Store.ts per store. A store owns state and the actions that change it; it renders nothing and imports no component.',
    includes: ['src/web/stores/**'],
  },
  'doom-web-client-components': {
    description:
      'Presentation shared by every feature, one PascalCase .tsx file per component. Driven by props and stores, with no feature-specific branching and no data fetching of its own.',
    includes: ['src/web/components/**'],
  },
  'doom-web-client-features': {
    description:
      'One directory per user-facing capability, holding its own components, hooks, and state. A feature is self-contained: code two features need moves down into components, lib, or stores rather than across to a sibling.',
    includes: ['src/web/features/**'],
  },
  'doom-web-client-routes': {
    description:
      'TanStack Router modules where the file tree is the URL tree, so the router owns the spelling (__root.tsx, dot and kebab segments). A route binds a URL to a feature and holds no feature logic.',
    includes: ['src/web/routes/**'],
  },
  'doom-web-client-app': {
    description:
      'The browser composition root: providers, router instantiation, global styles, and the mount call. The one client layer that may reach every other.',
    includes: ['src/web/app/**'],
  },
  'doom-web-client-entry': {
    description:
      'The bundler entry: the HTML document, the mount script, global stylesheet, and ambient client type declarations. Holds wiring only, never behavior worth testing, because nothing can import it.',
    includes: ['src/web/index.html', 'src/web/main.tsx', 'src/web/vite-env.d.ts', 'src/web/styles/**'],
  },
  'doom-web-tests': {
    description: 'Unit, integration, and package-contract verification.',
    includes: ['tests/**'],
  },
  'doom-web-metadata': {
    description: 'Publishable package, documentation, and build configuration.',
    includes: [
      'package.json',
      'project.json',
      'tsconfig.json',
      'vite.config.ts',
      'tsdown.config.ts',
      'vitest.config.ts',
      'playwright.config.ts',
      'vibe-lint.config.yaml',
      'README.md',
      'LICENSE',
      'llms.txt',
      '.oxlintrc.json',
    ],
  },
};
