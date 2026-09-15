import type { PatternDefinition } from '@agimon-ai/vibe-lint';

/**
 * Design-pattern context surfaced before a Doom package file is edited. These
 * mirror the canonical source vocabulary in ../rules/architecture.ts, so a
 * package gets the guidance without restating it in its own configuration.
 */
export const patterns: Record<string, PatternDefinition> = {
  'doom-exports': {
    description:
      'Flat public consumption modules exposing selected services, constants, types, schemas, and other reusable capabilities. Pure re-exports only. Host entries live directly in src/extensions; never re-export them here.',
    includes: ['src/exports/*.ts'],
  },
  'doom-constants': {
    description:
      'Shared literal data, command metadata, and guidance. Constants import only constants and contain no implementations. Every layer, including browser code, may import constants.',
    includes: ['src/constants/**/*.ts'],
  },
  'doom-types': {
    description: 'Host-neutral contracts and option shapes. Imports only types and constants.',
    includes: ['src/types/**/*.ts'],
  },
  'doom-schemas': {
    description:
      'Runtime TypeBox and Zod validation contracts. Transport protocols are reserved for real process/reload boundaries; same-runner package capabilities are named Cordis services.',
    includes: ['src/schemas/**/*.ts'],
  },
  'doom-services': {
    description:
      'Package logic, including filesystem, network, process integration, and Cordis service implementations. Each service has src/services/{serviceName}/index.ts and type.ts for local contracts. Services never import extension entries. Keep dependencies explicit so behavior can be tested independently.',
    includes: ['src/services/**/*.ts'],
  },
  'doom-prompts': {
    description:
      'Package-owned Help resources. Each direct child is a kebab-case skill directory with one SKILL.md indexed by llms.txt and shipped through the package files allowlist.',
    includes: ['src/prompts/**'],
  },
  'doom-models': {
    description:
      'Package state and state transitions. Models import constants, models, schemas, and types; services and routed declarations consume them.',
    includes: ['src/models/**/*.ts'],
  },
  'doom-extensions': {
    description:
      'Folder-routed files default-export exactly one typed define declaration. Their path states scope, side, surface, and identity. Use root files for shared mount state and lifecycle, services for implementation, and private colocated _lib or _components for surface-private code. Named exports never live in scanned route files. Cardinality is declared through defineRoutedContribution options rather than pseudo-surface names or catch-all files.',
    includes: ['src/extensions/**/*.ts'],
  },
  'doom-tui': {
    description: 'Overlay, footer, and other terminal presentation components.',
    includes: ['src/tui/**/*.ts'],
  },
  'doom-bin': {
    description:
      'Executable composition entrypoints declared in package.json bin. Assemble services directly without importing public export wrappers or extension entries.',
    includes: ['src/bin/**/*.ts'],
  },
  'doom-web-plugin-entry': {
    description:
      'The direct browser entry is src/extensions/web.ts and exports webPlugin through defineWebPlugin. Declare global/session contributions from src/web modules; publish the source entry through doompiWeb.client and keep it out of the node build. No exports wrapper. Browser imports remain limited to the approved web dependencies, own web modules, types, and constants. Components act through their typed props.',
    includes: ['src/extensions/web.ts'],
  },
  'doom-web-plugin-store': {
    description:
      "Per-session plugin state: one `defineSessionStore<T>(empty)` per topic, where T is the whole record for a session (the hub's last payload plus this page's own ephemeral state such as dismissed ids or the open run). The channel is `store.channel({ channel, parse, reduce })`: parse gates the wire, reduce folds one payload and reconciles the ephemeral fields; drop and reset belong to the helper. Actions are plain functions calling `store.update`, and one that sends takes a `SessionFrameSender` first. No top-level let.",
    includes: ['src/web/stores/**/*.ts'],
  },
  'doom-web-plugin-components': {
    description:
      'Panels, activity sections, overlays, and tool messages. A tool message is a `message` renderer, one component per claimed tool receiving ToolMessageRenderProps, composed from MessageItem, MessageItemHeader, MessageItemBody, MessageItemStatus, and MessageLines from @agimon-ai/doompi-web-components: the shell owns the frame, the outcome tone, the status badge, and the expand toggle (`expandable` when the card hides lines), the card supplies the header summary and the body. Every Pi tool the package registers is listed in a toolRenderers entry (web-plugin-tool-renderers). Read with `useStore(x.store, (state) => x.select(state, sessionId))`, act with `props.sendSessionFrame`, navigate with `props.openTab`, render own slots with `props.renderSlot`. Tailwind classes as complete literals; imports limited to react, the two TanStack packages, the web contract, the shared components, own src/web/**, src/types/**, and src/constants/**; plugins never import each other.',
    includes: ['src/web/**/*.tsx'],
  },
  'doom-web-plugin-lib': {
    description:
      'Pure view logic the components share: formatting, matching, folding. Host-neutral, no React state, no module-level mutable state, tested from tests/ directly.',
    includes: ['src/web/lib/**/*.ts'],
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
