import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

type VibeLintConfig = {
  extends?: string[];
  boundaries?: Array<{ name: string }>;
  rules?: Record<string, unknown>;
};

function readConfig(): VibeLintConfig {
  const raw = fs.readFileSync(path.join(packageRoot, 'vibe-lint.config.yaml'), 'utf-8');
  const config: unknown = parseYaml(raw);
  if (typeof config !== 'object' || config === null) throw new Error('vibe-lint.config.yaml is not an object.');
  return config as VibeLintConfig;
}

describe('import boundaries', () => {
  const config = readConfig();

  it('uses the repository-owned canonical boundary preset and declares no boundaries of its own', () => {
    expect(config.extends).toContain('doom-extension/recommended');
    // src/web hosts the cockpit plugin, a root outside the src vocabulary; the
    // doom-extension preset carries its boundary (web-plugin) and the tests
    // boundary that reaches it, so a package-local block would only drift.
    expect(config.boundaries).toBeUndefined();
  });

  it('enforces deterministic boundary findings as errors', () => {
    expect(config.rules?.['boundary-import-allowlist']).toBe('error');
  });
});
