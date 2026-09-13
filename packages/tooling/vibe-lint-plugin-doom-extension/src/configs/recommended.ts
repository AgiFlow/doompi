import type { BoundaryConfig, OverrideConfig, PluginConfigPreset, Severity } from '@agimon-ai/vibe-lint';

const rules: Record<string, Severity> = {
  'composition-layout': 'error',
  'plugin-composition-wiring': 'error',
  'doom-constants': 'error',
  'neutral-extension-contracts': 'error',
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
  'clean-import-path': 'error',
  'service-boundary': 'error',
  'schema-placement': 'error',
  'doom-package-shape': 'error',
  'doom-prompt-shape': 'error',
  'doom-server-facet-shape': 'error',
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
  'no-direct-tool-activation': 'error',
  'web-plugin-entry': 'error',
  'web-plugin-import-allowlist': 'error',
  'web-plugin-layer-boundary': 'error',
  'package-api-manifest': 'error',
  'web-plugin-manifest': 'error',
  'web-plugin-no-module-state': 'error',
  'web-plugin-protocol-layout': 'error',
  'web-plugin-typed-calls': 'error',
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
  { name: 'constants', pattern: 'src/constants/**', allowedImports: layer('constants') },
  {
    name: 'exports',
    pattern: 'src/exports/**',
    allowedImports: layer('constants', 'controllers', 'models', 'schemas', 'services', 'tools', 'tui', 'types'),
  },
  { name: 'types', pattern: 'src/types/**', allowedImports: layer('constants', 'types') },
  { name: 'schemas', pattern: 'src/schemas/**', allowedImports: layer('constants', 'schemas', 'types') },
  {
    name: 'models',
    pattern: 'src/models/**',
    allowedImports: layer('constants', 'models', 'schemas', 'types'),
  },
  {
    name: 'services',
    pattern: 'src/services/**',
    allowedImports: layer('constants', 'models', 'schemas', 'services', 'types'),
  },
  {
    name: 'controllers',
    pattern: 'src/controllers/**',
    allowedImports: layer('constants', 'controllers', 'models', 'schemas', 'services', 'types'),
  },
  {
    name: 'tools',
    pattern: 'src/tools/**',
    allowedImports: layer('constants', 'models', 'schemas', 'services', 'tools', 'types'),
  },
  // Browser entries retain the browser-only policy before general composition.
  {
    name: 'web-plugin-entry',
    pattern: 'src/extensions/web.ts',
    allowedImports: ['src/web/**', 'src/types', 'src/types/**', 'src/constants', 'src/constants/**'],
  },
  {
    name: 'extensions',
    pattern: 'src/extensions/**',
    allowedImports: layer(
      'constants',
      'controllers',
      'extensions',
      'models',
      'schemas',
      'services',
      'tools',
      'tui',
      'types',
      'web',
    ),
  },
  {
    name: 'tui',
    pattern: 'src/tui/**',
    allowedImports: layer('constants', 'models', 'schemas', 'services', 'tui', 'types'),
  },
  {
    name: 'prompts',
    pattern: 'src/prompts/**',
    allowedImports: ['src/prompts/**'],
  },
  {
    name: 'bin',
    pattern: 'src/bin/**',
    allowedImports: layer(
      'bin',
      'constants',
      'controllers',
      'models',
      'schemas',
      'services',
      'tools',
      'tui',
      'types',
      'web',
    ),
  },
  // The web cockpit plugin's browser half lives in src/web. It may reach its
  // own files and the shared src/types shapes (web-plugin-import-allowlist
  // checks the bare specifiers); tests reach it through the src/** entry above
  // like any other package source.
  {
    name: 'web-plugin',
    pattern: 'src/web/**',
    allowedImports: ['src/web/**', 'src/types', 'src/types/**', 'src/constants', 'src/constants/**'],
  },
  { name: 'tests', pattern: 'tests/**', allowedImports: ['src/**', 'tests/**'] },
  {
    name: 'metadata',
    pattern:
      '{.oxlintrc.json,CHANGELOG.md,LICENSE,README.md,llms.txt,package.json,project.json,tsconfig.json,tsdown.config.ts,vitest.config.ts,vibe-lint.config.yaml}',
  },
];

/** Host loaders and build tools require default exports only at their direct entries. */
const overrides: OverrideConfig[] = [
  {
    files: ['src/extensions/pi.ts', 'src/extensions/server.ts', 'tsdown.config.ts', 'vitest.config.ts'],
    rules: { 'no-default-export': 'off', 'direct-export-only': 'off' },
  },
];

export const recommended: PluginConfigPreset = { rules, boundaries, overrides };

export const migration: PluginConfigPreset = {
  rules: Object.fromEntries(Object.keys(rules).map((ruleId) => [ruleId, 'warn' as const])),
  boundaries,
  overrides,
};
