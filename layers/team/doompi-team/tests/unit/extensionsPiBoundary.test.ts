import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import standardPiExtension from '../../src/extensions/pi';
import { activateTeamExtension } from '../../src/extensions/pi';

const extensionsDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/extensions');

describe('Team standard Pi boundary', () => {
  it('exports one canonical standard factory', () => {
    expect(standardPiExtension).toBe(activateTeamExtension);
  });

  it('does not retain an alternate Doom entry', () => {
    expect(fs.existsSync(path.join(extensionsDirectory, 'doom.ts'))).toBe(false);
  });
});
