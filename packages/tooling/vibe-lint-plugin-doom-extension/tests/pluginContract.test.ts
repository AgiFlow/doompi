import doomExtensionPlugin, {
  migration,
  doomExtensionPlugin as namedPlugin,
  recommended,
  rules,
} from '../src/index.js';

const EXPECTED_RULE_IDS = [
  'clean-import-path',
  'compatibility-wrapper-only',
  'cordis-context-in-pi-adapter',
  'cordis-feature-plugin',
  'cordis-host-order',
  'cordis-service-injection',
  'dispose-external-subscriptions',
  'doom-clean-architecture-boundary',
  'doom-folder-layout',
  'doom-layer-boundary',
  'doom-package-shape',
  'doom-prompt-shape',
  'flat-service-layout',
  'no-ambient-host-access',
  'no-forwarding-module',
  'no-internal-public-import',
  'no-legacy-cordis-access',
  'no-live-global-registry',
  'no-protocol-channel-literals',
  'no-raw-pi-events',
  'no-same-runner-protocol',
  'package-layer-order',
  'pi-extension-default-factory',
  'pi-peer-version',
  'ports-declared-in-types',
  'prefer-cordis-container',
  'provider-owned-policy',
  'public-export-boundary',
  'schema-placement',
  'service-boundary',
  'thin-pi-adapter',
  'web-plugin-entry',
  'web-plugin-import-allowlist',
  'web-plugin-manifest',
  'web-plugin-no-module-state',
  'web-plugin-tool-renderers',
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

  it('enforces the layout rules now that every package is on src/exports', () => {
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
      'no-raw-pi-events',
      'no-same-runner-protocol',
      'prefer-cordis-container',
      'doom-clean-architecture-boundary',
    ]) {
      expect(recommended.rules[ruleId], ruleId).toBe('error');
    }
    expect(Object.keys(recommended.rules).sort()).toEqual(EXPECTED_RULE_IDS);
  });

  it('leaves only the import-spelling rule opt-in', () => {
    // Relative imports still carry a .ts extension across most of the
    // repository; this promotes with the codemod that removes them.
    const optIn = Object.entries(recommended.rules)
      .filter(([, severity]) => severity === 'off')
      .map(([ruleId]) => ruleId);

    expect(optIn).toEqual(['clean-import-path']);
  });

  it('provides a warning-only migration preset', () => {
    expect(migration.rules).toEqual(Object.fromEntries(EXPECTED_RULE_IDS.map((ruleId) => [ruleId, 'warn'])));
  });

  it('publishes the web plugin boundary and lets tests reach it', () => {
    expect(recommended.boundaries).toContainEqual({
      name: 'web-plugin',
      pattern: 'web/**',
      allowedImports: ['web/**', 'src/types', 'src/types/**'],
    });
    expect(recommended.boundaries).toContainEqual({
      name: 'tests',
      pattern: 'tests/**',
      allowedImports: ['src/**', 'tests/**', 'web/**'],
    });
    for (const id of [
      'doom-web-plugin-entry',
      'doom-web-plugin-store',
      'doom-web-plugin-components',
      'doom-web-plugin-lib',
    ]) {
      expect(doomExtensionPlugin.patterns?.[id]?.includes.length, id).toBeGreaterThan(0);
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
