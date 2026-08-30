import { performance } from 'node:perf_hooks';
import { parseServerMessage } from '@earendil-works/pi-protocol';
import { describe, expect, it } from 'vitest';

const TOOL_ITEM_COUNT = 80;
const VALIDATION_BUDGET_MS = 500;

function largeSnapshotMessage() {
  return {
    type: 'event',
    event: {
      type: 'session_snapshot',
      snapshot: {
        id: 'session-1',
        cwd: '/tmp/project',
        createdAt: 1,
        updatedAt: 2,
        phase: 'idle',
        model: { provider: 'provider', id: 'model' },
        thinkingLevel: 'medium',
        attached: true,
        locked: true,
        revision: 1,
        queuedSteer: [],
        queuedSteerCount: 0,
        name: 'session',
        transcript: Array.from({ length: TOOL_ITEM_COUNT }, (_, index) => ({
          id: `tool-${String(index)}`,
          role: 'tool',
          toolCallId: `call-${String(index)}`,
          toolName: 'read',
          input: {
            path: `src/file-${String(index)}.ts`,
            options: { offset: index, tags: ['one', 'two', 'three'] },
          },
          content: [{ type: 'text', text: 'result '.repeat(100) }],
          status: 'complete',
          isError: false,
          timestamp: index + 1,
          details: {
            patch: 'line '.repeat(100),
            ranges: [{ from: index, to: index + 1 }],
          },
        })),
      },
    },
  };
}

describe('protocol codec integration', () => {
  it('validates a large recursive snapshot without blocking the event loop', () => {
    const message = largeSnapshotMessage();
    const started = performance.now();

    expect(parseServerMessage(message)).toBe(message);
    expect(performance.now() - started).toBeLessThan(VALIDATION_BUDGET_MS);
  });
});
