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
  'doom-web-plugin-entry': {
    description:
      "The cockpit plugin's client entry: `export const webPlugin = defineWebPlugin({...})`, the one module the host's generated registry imports, published through a src/exports re-export. It declares tabs, channels, tool renderers, activity groups and sections, leader bindings, and the slots this plugin opens (`slots`, named '<pluginId>.<name>') or fills (`fills`) from sibling src/web modules. `start` is for page-lifetime needs such as hub frames only; components act through their props.",
    includes: ['src/web/index.ts'],
  },
  'doom-web-plugin-store': {
    description:
      "Per-session plugin state: one `defineSessionStore<T>(empty)` per topic, where T is the whole record for a session (the hub's last payload plus this page's own ephemeral state such as dismissed ids or the open run). The channel is `store.channel({ channel, parse, reduce })`: parse gates the wire, reduce folds one payload and reconciles the ephemeral fields; drop and reset belong to the helper. Actions are plain functions calling `store.update`, and one that sends takes a `SessionFrameSender` first. No top-level let.",
    includes: ['src/web/*Store.ts'],
  },
  'doom-web-plugin-components': {
    description:
      'Panels, activity sections, overlays, and tool messages. A tool message is a `message` renderer, one component per claimed tool receiving ToolMessageRenderProps, composed from MessageItem, MessageItemHeader, MessageItemBody, MessageItemStatus, and MessageLines from @agimon-ai/doompi-web-components: the shell owns the frame, the outcome tone, the status badge, and the expand toggle (`expandable` when the card hides lines), the card supplies the header summary and the body. Every Pi tool the package registers is listed in a toolRenderers entry (web-plugin-tool-renderers). Read with `useStore(x.store, (state) => x.select(state, sessionId))`, act with `props.sendSessionFrame`, navigate with `props.openTab`, render own slots with `props.renderSlot`. Tailwind classes as complete literals; imports limited to react, the two TanStack packages, the web contract, the shared components, own src/web/** and src/types/**; plugins never import each other.',
    includes: ['src/web/**/*.tsx'],
  },
  'doom-web-plugin-lib': {
    description:
      'Pure view logic the components share: formatting, matching, folding. Host-neutral, no React state, no module-level mutable state, tested from tests/ directly.',
    includes: ['src/web/**/*.ts'],
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
