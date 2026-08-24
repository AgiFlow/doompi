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

  it('uses the repository-owned canonical boundary preset, plus only the web plugin root', () => {
    expect(config.extends).toContain('doom-extension/recommended');
    // web/ hosts the cockpit plugin, a root the doom-extension vocabulary
    // does not know; it and the tests override that reaches it are the only
    // package-local boundaries allowed here.
    expect(config.boundaries?.map((boundary) => boundary.name)).toEqual(['web-plugin', 'tests']);
  });

  it('enforces deterministic boundary findings as errors', () => {
    expect(config.rules?.['boundary-import-allowlist']).toBe('error');
  });
});
