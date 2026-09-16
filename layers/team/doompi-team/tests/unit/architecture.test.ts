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

  // The preset's cli-routed-presentation boundary now covers the terminal half
  // of the session routes, so the local copies of it are gone. A package
  // boundary outranks a preset one, so re-declaring one here would silently
  // shadow the shared policy.
  it('uses the repository-owned boundary preset without local overrides', () => {
    expect(config.extends).toContain('doom-extension/recommended');
    expect(config.boundaries ?? []).toEqual([]);
  });

  it('enforces deterministic boundary findings as errors', () => {
    expect(config.rules?.['boundary-import-allowlist']).toBe('error');
  });
});
