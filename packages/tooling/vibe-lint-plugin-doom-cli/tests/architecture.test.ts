import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from 'vitest';

import { architecture } from '../src/index';
test('rejects opaque root folders and retired package imports', () => {
  const root = mkdtempSync(join(tmpdir(), 'doom-cli-rules-'));
  try {
    mkdirSync(join(root, 'src/adapters'), { recursive: true });
    const file = join(root, 'src/adapters/example.ts');
    writeFileSync(file, "import { value } from '@agimon-ai/doompi-kernel';");
    const result = architecture.check!(file, root);
    expect(result).toContain('Unsupported source folder');
    expect(result).toContain('Removed package');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test.each([
  ['builders/server/runtime.ts', '../../cli/server/run'],
  ['composition/state.ts', '../cli/commands/sync'],
  ['compiler/index.ts', '../builders/cli'],
])('rejects reverse ownership dependencies from %s', (fileName, reference) => {
  const root = mkdtempSync(join(tmpdir(), 'doom-cli-boundary-'));
  try {
    const file = join(root, 'src', fileName);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, `export const load = () => import('${reference}');`);
    expect(architecture.check!(file, root)).toContain('cannot depend');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
