import doomExtensionPlugin, {
  migration,
  doomExtensionPlugin as namedPlugin,
  recommended,
  rules,
} from '../src/index.js';

const EXPECTED_RULE_IDS = [
  'clean-import-path',
  'compatibility-wrapper-only',
  'composition-layout',
  'cordis-context-in-pi-adapter',
  'cordis-feature-plugin',
  'cordis-host-order',
  'cordis-service-injection',
  'dispose-external-subscriptions',
  'doom-clean-architecture-boundary',
  'doom-constants',
  'doom-folder-layout',
  'doom-layer-boundary',
  'doom-package-shape',
  'doom-prompt-shape',
  'doom-server-facet-shape',
  'extension-side-boundary',
  'flat-service-layout',
  'legacy-source-root',
  'neutral-extension-contracts',
  'no-ambient-host-access',
  'no-direct-tool-activation',
  'no-forwarding-module',
  'no-internal-public-import',
  'no-legacy-cordis-access',
  'no-live-global-registry',
  'no-protocol-channel-literals',
  'no-raw-pi-events',
  'no-same-runner-protocol',
  'package-api-manifest',
  'package-layer-order',
  'pi-extension-default-factory',
  'pi-peer-version',
  'plugin-composition-wiring',
  'ports-declared-in-types',
  'prefer-cordis-container',
  'provider-owned-policy',
  'public-export-boundary',
  'routed-file-contract',
  'routed-file-position',
  'schema-placement',
  'service-boundary',
  'thin-pi-adapter',
  'web-plugin-entry',
  'web-plugin-import-allowlist',
  'web-plugin-manifest',
  'web-plugin-no-module-state',
  'web-plugin-protocol-layout',
  'web-plugin-tool-renderers',
  'web-plugin-typed-calls',
] as const;

describe('Doom extension plugin contract', () => {
  it('exposes the resolver default as the named plugin', () => {
    expect(doomExtensionPlugin).toBe(namedPlugin);
    expect(doomExtensionPlugin.name).toBe('doom-extension');
    expect(doomExtensionPlugin.rules).toBe(rules);
    expect(doomExtensionPlugin.configs).toEqual({ migration, recommended });
  });

  it('publishes the complete deterministic rule set', () => {
    expect(Object.keys(rules).sort()).toEqual(EXPECTED_RULE_IDS);
    expect(
      Object.values(rules).every(
        ({ check, preflight, rationale, rule }) =>
          typeof check === 'function' && preflight === true && rationale.length > 0 && rule.length > 0,
      ),
    ).toBe(true);
  });

  it('enforces the declared layout rules', () => {
    for (const ruleId of [
      'public-export-boundary',
      'no-internal-public-import',
      'no-ambient-host-access',
      'no-forwarding-module',
      'ports-declared-in-types',
      'flat-service-layout',
      'no-ambient-host-access',
      'doom-layer-boundary',
      'cordis-context-in-pi-adapter',
      'cordis-feature-plugin',
      'cordis-host-order',
      'cordis-service-injection',
      'no-legacy-cordis-access',
      'no-live-global-registry',
      'no-direct-tool-activation',
      'no-raw-pi-events',
      'no-same-runner-protocol',
      'prefer-cordis-container',
      'doom-clean-architecture-boundary',
      'doom-constants',
      'routed-file-contract',
      'web-plugin-import-allowlist',
    ]) {
      expect(recommended.rules[ruleId], ruleId).toBe('error');
    }
    expect(Object.keys(recommended.rules).sort()).toEqual(EXPECTED_RULE_IDS);
  });

  it('enforces clean import paths with every recommended rule', () => {
    expect(recommended.rules['clean-import-path']).toBe('error');
    expect(Object.values(recommended.rules).every((severity) => severity === 'error')).toBe(true);
  });

  it('publishes only canonical architecture guidance and boundaries', () => {
    const patterns = doomExtensionPlugin.patterns ?? {};
    for (const obsolete of ['adapters', 'commands', 'container', 'controllers', 'providers', 'tools']) {
      expect(patterns[`doom-${obsolete}`]).toBeUndefined();
      expect(recommended.boundaries?.some((boundary) => boundary.name === obsolete)).toBe(false);
      for (const boundary of recommended.boundaries ?? []) {
        expect(boundary.allowedImports ?? []).not.toContain(`src/${obsolete}/**`);
      }
    }
    for (const root of ['extensions', 'services', 'models', 'constants', 'schemas', 'types']) {
      expect(patterns[`doom-${root}`]?.includes).toContain(`src/${root}/**/*.ts`);
    }
    expect(patterns['doom-exports']?.includes).toEqual(['src/exports/*.ts']);
    expect(patterns['doom-services']?.description).toContain('src/services/{serviceName}/index.ts and type.ts');
  });

  it('keeps host entries out of public forwarding and separate executable roots', () => {
    const boundaries = recommended.boundaries ?? [];
    const exported = boundaries.find((boundary) => boundary.name === 'exports')?.allowedImports ?? [];
    for (const root of ['extensions', 'bin', 'web', 'exports']) {
      expect(exported).not.toContain(`src/${root}/**`);
    }
    for (const root of ['constants', 'models', 'schemas', 'services', 'tui', 'types']) {
      expect(exported).toContain(`src/${root}/**`);
    }
    const extensions = boundaries.find((boundary) => boundary.name === 'extensions')?.allowedImports ?? [];
    const bin = boundaries.find((boundary) => boundary.name === 'bin')?.allowedImports ?? [];
    expect(extensions).toContain('src/extensions/**');
    expect(extensions).not.toContain('src/bin/**');
    expect(bin).not.toContain('src/extensions/**');
    expect(bin).not.toContain('src/exports/**');
    const exceptions = recommended.overrides?.flatMap((override) => override.files) ?? [];
    expect(exceptions).toEqual(['src/extensions/**', 'tsdown.config.ts', 'vitest.config.ts']);
  });

  it('applies the browser boundary before the broader extension composition boundary', () => {
    const boundaries = recommended.boundaries ?? [];
    const browser = boundaries.findIndex((boundary) => boundary.name === 'web-plugin-routed');
    const extensions = boundaries.findIndex((boundary) => boundary.name === 'extensions');
    expect(browser).toBeGreaterThanOrEqual(0);
    expect(browser).toBeLessThan(extensions);
    expect(boundaries[browser]?.pattern).toBe('src/extensions/**/(frontend)/**');
    // The hand-written src/extensions/web.ts entry is retired: a routed package
    // builds generated/web.ts instead, so nothing targets that literal path.
    expect(boundaries.some((boundary) => boundary.pattern === 'src/extensions/web.ts')).toBe(false);
    expect(doomExtensionPlugin.patterns?.['doom-web-plugin-entry']).toBeUndefined();
    expect(doomExtensionPlugin.patterns?.['doom-web-plugin-store']?.includes).toEqual([
      'src/extensions/**/_lib/**/*Store.ts',
    ]);
  });

  it('provides a warning-only migration preset', () => {
    expect(migration.rules).toEqual(Object.fromEntries(EXPECTED_RULE_IDS.map((ruleId) => [ruleId, 'warn'])));
  });

  it('retires the src/web boundary and keeps the browser patterns on colocated folders', () => {
    expect(recommended.boundaries?.some((boundary) => boundary.name === 'web-plugin')).toBe(false);
    expect(recommended.boundaries?.some((boundary) => boundary.pattern === 'src/web/**')).toBe(false);
    // tests reach the browser half through the src/** entry, so no separate
    // web entry is needed here any more.
    expect(recommended.boundaries).toContainEqual({
      name: 'tests',
      pattern: 'tests/**',
      allowedImports: ['src/**', 'tests/**', 'generated/**'],
    });
    for (const id of ['doom-web-plugin-store', 'doom-web-plugin-components', 'doom-web-plugin-lib']) {
      const includes = doomExtensionPlugin.patterns?.[id]?.includes ?? [];
      expect(includes.length, id).toBeGreaterThan(0);
      expect(
        includes.every((include) => include.startsWith('src/extensions/')),
        id,
      ).toBe(true);
    }
  });

  it('publishes prompts as a resource pattern and isolated boundary', () => {
    expect(doomExtensionPlugin.patterns?.['doom-prompts']?.includes).toEqual(['src/prompts/**']);
    expect(recommended.boundaries).toContainEqual({
      name: 'prompts',
      pattern: 'src/prompts/**',
      allowedImports: ['src/prompts/**'],
    });
  });
});
