import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import standardPiExtension from '../src/exports/extensions/pi';
import { planModeExtension } from '../src/exports/planMode';

const adapterPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'exports',
  'extensions',
  'pi.ts',
);

describe('Doom Plan Pi adapter boundary', () => {
  it('does not make the standard Pi entry an alias of the explicit Doom adapter', () => {
    expect(standardPiExtension).not.toBe(planModeExtension);
  });

  it('keeps the standard host adapter free of the Doom-aware composition import', () => {
    const source = fs.readFileSync(adapterPath, 'utf8');

    expect(source).not.toMatch(/from '\.\.\/services\/plan\/planMode(?:\.ts)?'/u);
    expect(source).not.toContain('planModeExtension');
  });
});
