import { expect, it } from 'vitest';

import { runHistoryImport } from '../../../../src/cli/commands/history-import';

it('rejects the removed SQLite import without consulting an ownership reader', async () => {
  const owner = new Proxy(
    {},
    {
      get() {
        throw new Error('Legacy ownership must not be read');
      },
    },
  );
  await expect(
    runHistoryImport(
      ['history-import', 'legacy.jsonl', 'history.sqlite', '--format', 'sqlite', '--confirm-offline'],
      {},
      '/missing',
      {
        write() {
          throw new Error('No conversion output expected');
        },
      },
      owner,
    ),
  ).rejects.toThrow('history-import is unsupported in Pi 1.0');
});
