import { expect, it } from 'vitest';

import { createHistoryCreationFileSystem } from '../../../../../src/services/historyCreationFileSystem';

it('retains the legacy creation entrypoint as explicitly unsupported', () => {
  expect(() => createHistoryCreationFileSystem({}, async () => {})).toThrow('unsupported');
});
