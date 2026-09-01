import type { BoundaryConfig, OverrideConfig, PluginConfigPreset, Severity } from '@agimon-ai/vibe-lint';

const rules: Record<string, Severity> = {
  'doom-folder-layout': 'error',
  'compatibility-wrapper-only': 'error',
  'doom-clean-architecture-boundary': 'error',
  'public-export-boundary': 'error',
  'no-internal-public-import': 'error',
  'no-forwarding-module': 'error',
  'ports-declared-in-types': 'error',
  'flat-service-layout': 'error',
  'no-ambient-host-access': 'error',
  'package-layer-order': 'error',
  'doom-layer-boundary': 'error',
  // Relative imports still carry a .ts extension across most of the repository.
  // Promoted with the codemod that removes them, not before.
  'clean-import-path': 'off',
  'service-boundary': 'error',
  'schema-placement': 'error',
  'doom-package-shape': 'error',
  'doom-prompt-shape': 'error',
  'pi-peer-version': 'error',
  'prefer-cordis-container': 'error',
  'cordis-context-in-pi-adapter': 'error',
  'cordis-feature-plugin': 'error',
  'cordis-host-order': 'error',
  'cordis-service-injection': 'error',
  'no-legacy-cordis-access': 'error',
  'no-live-global-registry': 'error',
  'pi-extension-default-factory': 'error',
  'thin-pi-adapter': 'error',
  'no-raw-pi-events': 'error',
  'no-same-runner-protocol': 'error',
  'no-protocol-channel-literals': 'error',
  'dispose-external-subscriptions': 'error',
  'provider-owned-policy': 'error',
  'web-plugin-entry': 'error',
  'web-plugin-import-allowlist': 'error',
  'package-api-entry': 'error',
  'package-api-manifest': 'error',
  'web-plugin-manifest': 'error',
  'web-plugin-no-module-state': 'error',
  'web-plugin-tool-renderers': 'error',
};

/**
 * A layer is reachable both as a directory and as files within it. Barrel
 * imports are written without the /index suffix, so `../types` resolves to the
 * directory itself and a `src/types/**` glob alone would not match it.
 */
function layer(...roots: string[]): string[] {
  return roots.flatMap((root) => [`src/${root}`, `src/${root}/**`]);
}

/**
 * The canonical layer graph, kept in step with ALLOWED_ROOT_DEPENDENCIES in
 * ../rules/architecture.ts. doom-layer-boundary enforces this direction from
 * TypeScript and boundary-import-allowlist enforces it from these globs, so the
 * two have to agree.
 *
 * Boundaries match first-wins and a preset's are ranked below any a package
 * declares, so a package can still replace one of these outright.
 */
const boundaries: BoundaryConfig[] = [
  {
    name: 'exports',
    pattern: 'src/exports/**',
    // Mirrors ALLOWED_ROOT_DEPENDENCIES.exports, which is the full canonical set:
    // the root barrel aggregates the other published subpaths.
    // bin and extensions are transitional roots: a published subpath may still
    // forward to one until TRANSITIONAL_ROOTS is emptied.
    allowedImports: layer(
      'adapters',
      'bin',
      'commands',
      'container',
      'exports',
      'extensions',
      'providers',
      'schemas',
      'services',
      'tui',
      'types',
      // The cockpit client entry is published from src/exports as a source
      // re-export, so exports reaches the browser half too.
      'web',
    ),
  },
  { name: 'types', pattern: 'src/types/**', allowedImports: layer('types') },
  { name: 'schemas', pattern: 'src/schemas/**', allowedImports: layer('schemas', 'types') },
  {
    name: 'services',
    pattern: 'src/services/**',
    allowedImports: layer('schemas', 'services', 'types'),
  },
  // The Pi adapter subtree is the host entry, so it is listed before the general
  // adapters boundary and may reach commands and TUI to wire them up.
  // isCompositionAdapter in ../rules/architecture.ts exempts the same subtree.
  {
    name: 'pi-adapter',
    pattern: 'src/adapters/pi/**',
    allowedImports: layer('adapters', 'commands', 'container', 'providers', 'schemas', 'services', 'tui', 'types'),
  },
  {
    name: 'adapters',
    pattern: 'src/adapters/**',
    allowedImports: layer('adapters', 'schemas', 'services', 'types'),
  },
  {
    name: 'commands',
    pattern: 'src/commands/**',
    allowedImports: layer('commands', 'schemas', 'services', 'types'),
  },
  {
    name: 'providers',
    pattern: 'src/providers/**',
    allowedImports: layer('providers', 'schemas', 'services', 'types'),
  },
  {
    name: 'container',
    pattern: 'src/container/**',
    allowedImports: layer('adapters', 'commands', 'container', 'providers', 'schemas', 'services', 'tui', 'types'),
  },
  {
    name: 'tui',
    pattern: 'src/tui/**',
    allowedImports: layer('schemas', 'services', 'tui', 'types'),
  },
  {
    name: 'prompts',
    pattern: 'src/prompts/**',
    allowedImports: ['src/prompts/**'],
  },
  {
    name: 'bin',
    pattern: 'src/bin/**',
    // An executable is a composition root of its own: it assembles the graph
    // and runs it, so it reaches the same layers the container does.
    allowedImports: layer(
      'adapters',
      'bin',
      'commands',
      'container',
      'providers',
      'schemas',
      'services',
      'tui',
      'types',
    ),
  },
  // The web cockpit plugin's browser half lives in src/web. It may reach its
  // own files and the shared src/types shapes (web-plugin-import-allowlist
  // checks the bare specifiers); tests reach it through the src/** entry above
  // like any other package source.
  { name: 'web-plugin', pattern: 'src/web/**', allowedImports: ['src/web/**', 'src/types', 'src/types/**'] },
  { name: 'tests', pattern: 'tests/**', allowedImports: ['src/**', 'tests/**'] },
  {
    name: 'metadata',
    pattern:
      '{.oxlintrc.json,CHANGELOG.md,LICENSE,README.md,llms.txt,package.json,project.json,tsconfig.json,tsdown.config.ts,vitest.config.ts,vibe-lint.config.yaml}',
  },
];

/**
 * Pi loads a module's default export as its host entry contract, and satisfies
 * it by aliasing an already named export, which is a deferred named export, so
 * both rules have to stand down on the entry itself.
 *
 * src/extensions/** is the pre-src/exports entry location and comes off this
 * list once `extensions` leaves TRANSITIONAL_ROOTS.
 */
const overrides: OverrideConfig[] = [
  {
    files: [
      'src/exports/extensions/*.ts',
      'src/exports/pi.ts',
      'src/extensions/**/*.ts',
      'tsdown.config.ts',
      'vitest.config.ts',
    ],
    rules: { 'no-default-export': 'off', 'direct-export-only': 'off' },
  },
];

export const recommended: PluginConfigPreset = { rules, boundaries, overrides };

export const migration: PluginConfigPreset = {
  rules: Object.fromEntries(Object.keys(rules).map((ruleId) => [ruleId, 'warn' as const])),
  boundaries,
  overrides,
};
