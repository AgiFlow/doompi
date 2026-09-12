import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { architecture } from '../src/index';
test('rejects opaque root folders and retired package imports', () => {
  const root = mkdtempSync(join(tmpdir(), 'doom-core-rules-'));
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
