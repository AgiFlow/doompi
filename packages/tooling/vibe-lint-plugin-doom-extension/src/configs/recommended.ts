import type { BoundaryConfig, OverrideConfig, PluginConfigPreset, Severity } from '@agimon-ai/vibe-lint';

const rules: Record<string, Severity> = {
  'composition-layout': 'error',
  'routed-file-position': 'error',
  'routed-file-contract': 'error',
  'extension-side-boundary': 'error',
  'legacy-source-root': 'error',
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
  'web-plugin-generated-client-wiring': 'error',
  'web-plugin-import-allowlist': 'error',
  'package-api-manifest': 'error',
  'web-plugin-manifest': 'error',
  'web-plugin-no-hand-built-api-url': 'error',
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
    allowedImports: layer('constants', 'models', 'schemas', 'services', 'tui', 'types'),
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
    // The terminal half of a folder-routed package. A (frontend) file is
    // frontend code that need not run in a browser: a .cli file draws a TUI
    // view, and the overlay/ and message/ surfaces are the terminal's outright.
    // Such a file composes the package the way any presentation does, so it is
    // ranked above web-plugin-routed to keep the browser-only allowlist off it.
    // The split is spelled as globs because boundaries are matched by
    // minimatch, where a bare (frontend) is literal, and not by the build's
    // browser/terminal predicate.
    name: 'cli-routed-presentation',
    pattern: 'src/extensions/**/(frontend)/{**/*.cli.{ts,tsx},overlay/**,message/**}',
    allowedImports: [
      ...layer('constants', 'models', 'schemas', 'services', 'types'),
      'src/extensions/**/(frontend)/**',
    ],
  },
  {
    // The browser half of a folder-routed package, kept to the browser-only
    // policy before general composition. Matched by position rather than by a
    // literal path, so a (frontend) group anywhere in the tree is held to it.
    name: 'web-plugin-routed',
    pattern: 'src/extensions/**/(frontend)/**',
    allowedImports: [
      'src/types',
      'src/types/**',
      'src/constants',
      'src/constants/**',
      'src/schemas',
      'src/schemas/**',
      'src/extensions/**/(frontend)/**',
      // The build's typed API client. Kept in step with the bare-specifier
      // list in web-plugin-import-allowlist: one rule reads the AST and this
      // one reads globs, and a browser file has to satisfy both, so a target
      // added to one and not the other is allowed and rejected at once.
      'generated/client',
      'generated/client.ts',
    ],
  },
  {
    name: 'extensions',
    pattern: 'src/extensions/**',
    allowedImports: layer('constants', 'extensions', 'models', 'schemas', 'services', 'tui', 'types'),
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
    allowedImports: layer('bin', 'constants', 'models', 'schemas', 'services', 'tui', 'types'),
  },
  // generated/** is the routed package's host entries, which its contract and
  // lifecycle tests import the way they used to import src/extensions/pi.ts.
  { name: 'tests', pattern: 'tests/**', allowedImports: ['src/**', 'tests/**', 'generated/**'] },
  {
    name: 'metadata',
    pattern:
      '{.oxlintrc.json,CHANGELOG.md,LICENSE,README.md,llms.txt,package.json,project.json,tsconfig.json,tsdown.config.ts,vitest.config.ts,vibe-lint.config.yaml}',
  },
];

/**
 * Host loaders and build tools require default exports at their entries, and
 * so does the folder convention: a routed file under src/extensions declares
 * one contribution through its default export, the way a Next.js route does.
 */
const overrides: OverrideConfig[] = [
  {
    files: ['src/extensions/**', 'tsdown.config.ts', 'vitest.config.ts'],
    rules: { 'no-default-export': 'off', 'direct-export-only': 'off' },
  },
];

export const recommended: PluginConfigPreset = { rules, boundaries, overrides };

export const migration: PluginConfigPreset = {
  rules: Object.fromEntries(Object.keys(rules).map((ruleId) => [ruleId, 'warn' as const])),
  boundaries,
  overrides,
};
