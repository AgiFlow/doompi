import { describe, expect, it } from 'vitest';
import { redactComputerUseTrace } from '../../../src/services/traceRedaction.ts';

function serializedRecord(value: string) {
  return JSON.stringify(
    redactComputerUseTrace({
      sequence: 1,
      timestamp: 2,
      runId: 'run-1',
      bundleId: 'com.example.fixture',
      action: { kind: 'set_value', snapshotId: 'snapshot-1', elementRef: 'element-1', value },
      role: 'AXTextField',
      durationMs: 3,
      outcome: 'succeeded',
    }),
  );
}

describe('computer-use trace redaction', () => {
  it('records text length without recording text or element identity', () => {
    const trace = serializedRecord('private value');

    expect(JSON.parse(trace)).toEqual({
      sequence: 1,
      timestamp: 2,
      runId: 'run-1',
      bundleId: 'com.example.fixture',
      actionKind: 'set_value',
      role: 'AXTextField',
      textLength: 13,
      durationMs: 3,
      outcome: 'succeeded',
    });
    expect(trace).not.toContain('private value');
    expect(trace).not.toContain('snapshot-1');
    expect(trace).not.toContain('element-1');
  });
});
