import type { PatternDefinition } from '@agimon-ai/vibe-lint';

/**
 * Design-pattern context surfaced before a Doom package file is edited. These
 * mirror the canonical source vocabulary in ../rules/architecture.ts, so a
 * package gets the guidance without restating it in its own configuration.
 */
export const patterns: Record<string, PatternDefinition> = {
  'doom-exports': {
    description:
      "The package's only public surface. Pure re-exports, one file per package.json exports subpath, mirroring the subpath tree.",
    includes: ['src/exports/**/*.ts'],
  },
  'doom-types': {
    description: 'Host-neutral contracts and option shapes. Imports nothing outside types.',
    includes: ['src/types/**/*.ts'],
  },
  'doom-schemas': {
    description:
      'Runtime TypeBox and Zod validation contracts. Transport protocols are reserved for real process/reload boundaries; same-runner package capabilities are named Cordis services.',
    includes: ['src/schemas/**/*.ts'],
  },
  'doom-services': {
    description:
      'Host-neutral domain policy. No node builtins, no Pi host API, no container, no concrete adapters. Services stay independently testable.',
    includes: ['src/services/**/*.ts'],
  },
  'doom-prompts': {
    description:
      'Package-owned Help resources. Each direct child is a kebab-case skill directory with one SKILL.md indexed by llms.txt and shipped through the package files allowlist.',
    includes: ['src/prompts/**'],
  },
  'doom-adapters': {
    description:
      'Pi lifecycle, filesystem, process, and external runtime integration. A feature Pi adapter captures exactly one connectDoomCordisHost() lease, captures exactly one connection.root.plugin() fiber, and awaits fiber disposal before releasing the lease on session_shutdown. Required doom/* services belong in an owning ctx.inject callback; a stable Pi wrapper may close over an active binding only when that callback clears it on dependency disposal. Only doompi-extension-contracts/src/adapters/pi/cordisHost.ts constructs the runner Context or touches Pi EventBus. Live package collaboration uses injected Cordis services, never protocol runtimes or globalThis registries.',
    includes: ['src/adapters/**/*.ts'],
  },
  'doom-commands': {
    description: 'Slash command input parsing and output translation, delegating behavior to services.',
    includes: ['src/commands/**/*.ts'],
  },
  'doom-providers': {
    description:
      'Cordis Services this package publishes on the shared Context for other extensions to consume. Extend Service and call super(ctx, name) so the instance registers immediately and is removed with the owning fiber. A provider implements a contract from @agimon-ai/doompi-extension-contracts; it holds no host I/O and creates no Context of its own.',
    includes: ['src/providers/**/*.ts'],
  },
  'doom-container': {
    description:
      'Dependency wiring for the extension. Assemble collaborators through a createXContainer(overrides) factory so tests can substitute any of them. The Cordis Context is not built here: feature packages join the shared host and mount a child plugin fiber.',
    includes: ['src/container/**/*.ts'],
  },
  'doom-tui': {
    description: 'Overlay, footer, and other terminal presentation components.',
    includes: ['src/tui/**/*.ts'],
  },
  'doom-bin': {
    description: 'Executable entrypoints declared in package.json bin.',
    includes: ['src/bin/**/*.ts'],
  },
  'doom-tests': {
    description: 'Unit, integration, and package-contract verification.',
    includes: ['tests/**/*.ts'],
  },
  'doom-metadata': {
    description: 'Publishable package, documentation, and build configuration.',
    includes: [
      '.oxlintrc.json',
      'CHANGELOG.md',
      'LICENSE',
      'README.md',
      'llms.txt',
      'package.json',
      'project.json',
      'tsconfig.json',
      'tsdown.config.ts',
      'vitest.config.ts',
      'vibe-lint.config.yaml',
    ],
  },
};
