import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { completeOperation, startOperation } from '../../src/services/operationJournal';
import { TEST_SESSION_SCOPE } from '../support/sessionScope';
describe('operation journal', () => {
  it('replays a completed operation without allocating different runs', () => {
    const operationId = randomUUID();
    const first = startOperation<{ ok: boolean }>(TEST_SESSION_SCOPE, operationId, { action: 'run', value: 1 }, [
      'run-1',
    ]);
    expect(first.kind).toBe('new');
    completeOperation(TEST_SESSION_SCOPE, operationId, first.record, { ok: true });

    const replay = startOperation<{ ok: boolean }>(TEST_SESSION_SCOPE, operationId, { action: 'run', value: 1 }, [
      'different',
    ]);
    expect(replay).toMatchObject({
      kind: 'replay',
      record: { state: 'completed', runIds: ['run-1'], result: { ok: true } },
    });
  });

  it('rejects reuse of one operation id with different arguments', () => {
    const operationId = randomUUID();
    startOperation(TEST_SESSION_SCOPE, operationId, { action: 'stop', id: 'run-1' }, []);
    expect(() => startOperation(TEST_SESSION_SCOPE, operationId, { action: 'stop', id: 'run-2' }, [])).toThrow(
      /\[operation_conflict\]/,
    );
  });
});
