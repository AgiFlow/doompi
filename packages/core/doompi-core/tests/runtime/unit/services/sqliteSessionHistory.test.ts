import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { BACKGROUND_CONTEXT } from '@earendil-works/pi-agent-core/harness/context';
import { sessionName, value } from '@earendil-works/pi-agent-core/harness/session';
import { SqliteSessionRepo, createNodeSqliteFactory } from '@earendil-works/pi-session-backend-sqlite-node';
import { describe, expect, it } from 'vitest';

import { listSavedSessions } from '../../../../src/services/sqliteSessionHistory';

describe('listSavedSessions', () => {
  it('returns only inactive journals from the requested workspace', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'doompi-history-'));
    try {
      const repository = new SqliteSessionRepo({ directory, databaseFactory: createNodeSqliteFactory() });
      for (const [id, owner] of [
        ['saved', '/repo'],
        ['foreign', '/other'],
        ['active', '/repo'],
      ]) {
        const session = await repository.create({ id }, BACKGROUND_CONTEXT);
        await session.setValue(value('doompi.session', 'workspaceRoot'), owner, BACKGROUND_CONTEXT);
        await session.setValue(sessionName, id, BACKGROUND_CONTEXT);
        await session.close(BACKGROUND_CONTEXT);
      }
      await repository.close(BACKGROUND_CONTEXT);
      expect(await listSavedSessions(directory, '/repo', new Set(['active']))).toEqual([
        expect.objectContaining({ id: 'saved', name: 'saved', firstMessage: '', messageCount: 0 }),
      ]);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});
