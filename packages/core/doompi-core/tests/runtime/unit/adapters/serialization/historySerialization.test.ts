import { expect, it, vi } from 'vitest';

import {
  preserveHistoryBeforeOpen,
  protectAndImportHistory,
  restoreProtectedHistory,
} from '../../../../../src/services/historyImport';
import { importV3WithPinnedUpstream } from '../../../../../src/services/jsonlSessionRepo';
import { importSqliteHistory, verifySqliteHistory } from '../../../../../src/services/sqliteHistoryImport';
import { exportV4ToV3 } from '../../../../../src/services/v3Export';

it('retains legacy entrypoints but never acquires a lease, backs up, reads, or publishes old data', async () => {
  const acquire = vi.fn();
  const owner = { acquire };
  const lease = { assertQuiescent: vi.fn(), release: vi.fn() };
  const options = {
    sourcePath: '/missing',
    destinationPath: '/missing-destination',
    originalPath: '/missing-backup',
    owner,
  };
  await expect(preserveHistoryBeforeOpen(options.sourcePath, lease)).rejects.toThrow('unsupported');
  await expect(protectAndImportHistory(options)).rejects.toThrow('unsupported');
  await expect(restoreProtectedHistory(options)).rejects.toThrow('unsupported');
  await expect(exportV4ToV3(options)).rejects.toThrow('unsupported');
  const input = {
    sourcePath: '/missing',
    stagingPath: '/missing-stage',
    originalPath: '/missing-backup',
    sourceIdentity: { path: '/missing', realPath: '/missing', device: 0, inode: 0, size: 0, mtimeMs: 0, sha256: '' },
  };
  await expect(importV3WithPinnedUpstream(input)).rejects.toThrow('unsupported');
  await expect(importSqliteHistory(input)).rejects.toThrow('unsupported');
  await expect(verifySqliteHistory('/missing', { entries: [], branches: [] })).rejects.toThrow('unsupported');
  expect(acquire).not.toHaveBeenCalled();
  expect(lease.assertQuiescent).not.toHaveBeenCalled();
});
