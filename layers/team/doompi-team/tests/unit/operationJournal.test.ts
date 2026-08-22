import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { completeOperation, startOperation } from '../../src/adapters/pi/extensions/operationJournal';

describe('operation journal', () => {
  it('replays a completed operation without allocating different runs', () => {
    const operationId = randomUUID();
    const first = startOperation<{ ok: boolean }>(operationId, { action: 'run', value: 1 }, ['run-1']);
    expect(first.kind).toBe('new');
    completeOperation(operationId, first.record, { ok: true });

    const replay = startOperation<{ ok: boolean }>(operationId, { action: 'run', value: 1 }, ['different']);
    expect(replay).toMatchObject({
      kind: 'replay',
      record: { state: 'completed', runIds: ['run-1'], result: { ok: true } },
    });
  });

  it('rejects reuse of one operation id with different arguments', () => {
    const operationId = randomUUID();
    startOperation(operationId, { action: 'stop', id: 'run-1' }, []);
    expect(() => startOperation(operationId, { action: 'stop', id: 'run-2' }, [])).toThrow(/\[operation_conflict\]/);
  });
});
