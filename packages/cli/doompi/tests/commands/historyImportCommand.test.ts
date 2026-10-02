import { describe, expect, it } from 'vitest';

import { runHistoryImport } from '../../src/cli/commands/history-import';
import { routeCommand } from '../../src/cli/router';

describe('history-import clean cutover', () => {
  it('retains routing and help without offering legacy conversion', async () => {
    const chunks: string[] = [];
    expect(routeCommand(['history-import', '--help'])).toBe('history-import');
    await expect(
      runHistoryImport(['history-import', '--help'], {}, '/missing', { write: (chunk) => chunks.push(chunk) }),
    ).resolves.toBe(0);
    expect(chunks.join('')).toContain('Unsupported in Pi 1.0');
  });

  it.each([
    { args: [] },
    { args: ['legacy.jsonl', 'converted.jsonl'] },
    { args: ['legacy.jsonl', 'history.sqlite', '--format', 'sqlite', '--confirm-offline'] },
  ])('rejects legacy conversion before accessing paths: $args', async ({ args }) => {
    const chunks: string[] = [];
    await expect(
      runHistoryImport(['history-import', ...args], {}, '/missing', { write: (chunk) => chunks.push(chunk) }),
    ).rejects.toThrow('history-import is unsupported in Pi 1.0');
    expect(chunks).toEqual([]);
  });
});
