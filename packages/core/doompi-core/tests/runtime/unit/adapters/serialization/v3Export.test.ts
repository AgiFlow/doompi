import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { expect, it, vi } from 'vitest';

import { exportV4ToV3 } from '../../../../../src/services/v3Export';

it('rejects legacy exports without reading or modifying source or destination', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'doompi-export-'));
  try {
    const sourcePath = path.join(root, 'source.jsonl');
    const destinationPath = path.join(root, 'destination.jsonl');
    await fs.writeFile(sourcePath, 'original bytes');
    const acquire = vi.fn();
    await expect(exportV4ToV3({ sourcePath, destinationPath, owner: { acquire } })).rejects.toThrow('unsupported');
    expect(acquire).not.toHaveBeenCalled();
    expect(await fs.readFile(sourcePath, 'utf8')).toBe('original bytes');
    expect(await fs.readdir(root)).toEqual(['source.jsonl']);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
