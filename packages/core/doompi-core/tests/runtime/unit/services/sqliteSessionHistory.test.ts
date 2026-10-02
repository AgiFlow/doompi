import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { createHistoryOwnership } from '../../../../src/services/historyOwnership';
import {
  DURABLE_BACKGROUND_CONTEXT as context,
  openSqliteSessionStorage,
  SessionMetadataDoc,
} from '../../../../src/services/sqliteSessionStorage';

async function save(root: string, id: string, owner: string, execution: string, name = '') {
  const opened = await openSqliteSessionStorage(
    { sessionsRoot: root, sessionId: id, historyOwnership: createHistoryOwnership({ sourceFormat: 'sqlite' }) },
    context,
  );
  try {
    await opened.session.commit(async (tx) => {
      const doc = await tx.doc(SessionMetadataDoc);
      doc.workspaceRoot = owner;
      doc.execution = execution;
      doc.name = name;
    }, context);
  } finally {
    await opened.repository.close(context);
    await opened.historyLease.release();
  }
}

import { listSavedSessionRecords, listSavedSessions } from '../../../../src/services/sqliteSessionHistory';

describe('listSavedSessions', () => {
  it('returns only inactive journals from the requested workspace', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'doompi-history-'));
    try {
      for (const [id, owner] of [
        ['saved', '/repo'],
        ['foreign', '/other'],
        ['active', '/repo'],
      ]) {
        await save(
          directory,
          id!,
          owner!,
          JSON.stringify({ cwd: owner, repoRoot: owner, groupingRoot: owner, workspaceId: 'workspace' }),
          id,
        );
      }
      await fs.writeFile(path.join(directory, 'legacy.sqlite'), 'legacy bytes');
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
        await save(directory, id, execution.repoRoot, JSON.stringify(execution));
      }
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
      await save(directory, 'malformed', '/parent', '{ broken');
      expect(await listSavedSessionRecords(directory, '/parent', new Set(), 'parent')).toEqual([]);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});
