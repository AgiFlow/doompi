import { describe, expect, it } from 'vitest';
import doomWebPlugin, {
  doomWebLayerBoundary,
  doomWebPlugin as namedPlugin,
  noCrossFeatureImport,
  patterns,
  recommended,
  rules,
  webFileNaming,
} from '../src/index.js';

const EXPECTED_RULE_IDS = ['doom-web-layer-boundary', 'no-cross-feature-import', 'web-file-naming'] as const;

const EXPECTED_PATTERN_IDS = [
  'doom-web-adapters',
  'doom-web-bin',
  'doom-web-client-app',
  'doom-web-client-components',
  'doom-web-client-entry',
  'doom-web-client-features',
  'doom-web-client-lib',
  'doom-web-client-routes',
  'doom-web-client-stores',
  'doom-web-exports',
  'doom-web-metadata',
  'doom-web-services',
  'doom-web-tests',
  'doom-web-types',
] as const;

describe('Doom web plugin contract', () => {
  it('exposes the resolver default as the named plugin', () => {
    expect(doomWebPlugin).toBe(namedPlugin);
    expect(doomWebPlugin.name).toBe('doom-web');
    expect(doomWebPlugin.rules).toBe(rules);
    expect(doomWebPlugin.patterns).toBe(patterns);
    expect(doomWebPlugin.configs).toEqual({ recommended });
  });

  it('publishes the complete deterministic rule set', () => {
    expect(Object.keys(rules).sort()).toEqual([...EXPECTED_RULE_IDS]);
    expect(Object.values(rules)).toEqual([doomWebLayerBoundary, noCrossFeatureImport, webFileNaming]);
    expect(
      Object.values(rules).every(
        ({ check, preflight, rationale, rule }) =>
          typeof check === 'function' && preflight === true && rationale.length > 0 && rule.length > 0,
      ),
    ).toBe(true);
  });

  it('turns every rule on in the recommended preset', () => {
    expect(recommended.rules).toEqual(Object.fromEntries(EXPECTED_RULE_IDS.map((ruleId) => [ruleId, 'error'])));
  });

  it('describes every folder of a web package', () => {
    expect(Object.keys(patterns).sort()).toEqual([...EXPECTED_PATTERN_IDS]);
    expect(patterns['doom-web-client-features']?.includes).toEqual(['src/web/features/**']);
    expect(patterns['doom-web-metadata']?.includes).toContain('playwright.config.ts');
    expect(Object.values(patterns).every(({ description }) => description.length > 0)).toBe(true);
  });
});
