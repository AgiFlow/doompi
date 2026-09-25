import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { BACKGROUND_CONTEXT } from '@earendil-works/pi-agent-core/harness/context';
import { sessionName, value } from '@earendil-works/pi-agent-core/harness/session';
import { SqliteSessionRepo, createNodeSqliteFactory } from '@earendil-works/pi-session-backend-sqlite-node';
import { describe, expect, it } from 'vitest';

import { listSavedSessionRecords, listSavedSessions } from '../../../../src/services/sqliteSessionHistory';

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

  it('groups an external worktree without exposing execution paths in history', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'doompi-worktree-history-'));
    try {
      const repository = new SqliteSessionRepo({ directory, databaseFactory: createNodeSqliteFactory() });
      for (const [id, execution] of [
        [
          'worktree',
          {
            cwd: '/external/worktree/subdir',
            repoRoot: '/external/worktree',
            workspaceId: 'parent',
            groupingRoot: '/parent',
            parentSessionId: 'parent-session',
            sessionProvenance: 'worktree',
          },
        ],
        [
          'foreign',
          {
            cwd: '/external/other',
            repoRoot: '/external/other',
            workspaceId: 'other',
            groupingRoot: '/other',
          },
        ],
      ] as const) {
        const session = await repository.create({ id }, BACKGROUND_CONTEXT);
        await session.setValue(value('doompi.session', 'workspaceRoot'), execution.repoRoot, BACKGROUND_CONTEXT);
        await session.setValue(value('doompi.session', 'execution'), JSON.stringify(execution), BACKGROUND_CONTEXT);
        await session.close(BACKGROUND_CONTEXT);
      }
      await repository.close(BACKGROUND_CONTEXT);
      const records = await listSavedSessionRecords(directory, '/parent', new Set(), 'parent');
      expect(records).toEqual([
        expect.objectContaining({
          summary: expect.objectContaining({ id: 'worktree' }),
          execution: expect.objectContaining({ cwd: '/external/worktree/subdir', repoRoot: '/external/worktree' }),
        }),
      ]);
      expect(await listSavedSessions(directory, '/parent', new Set(), 'parent')).toEqual([records[0]!.summary]);
      expect(JSON.stringify(records[0]!.summary)).not.toContain('/external/worktree');
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it('does not reinterpret malformed execution metadata as a legacy journal', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'doompi-history-invalid-'));
    try {
      const repository = new SqliteSessionRepo({ directory, databaseFactory: createNodeSqliteFactory() });
      const session = await repository.create({ id: 'malformed' }, BACKGROUND_CONTEXT);
      await session.setValue(value('doompi.session', 'workspaceRoot'), '/parent', BACKGROUND_CONTEXT);
      await session.setValue(value('doompi.session', 'execution'), '{ broken', BACKGROUND_CONTEXT);
      await session.close(BACKGROUND_CONTEXT);
      await repository.close(BACKGROUND_CONTEXT);
      expect(await listSavedSessionRecords(directory, '/parent', new Set(), 'parent')).toEqual([]);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});
