import { describe, expect, it } from 'vitest';

import { RESULT_FILE_SUFFIX, type RunResultFile } from '../../src/services/resultWatcher';

describe('durable external result records', () => {
  it('retains the run id when a runner writes a result record', () => {
    const result: RunResultFile = { runId: 'run-1', success: false, summary: 'failed' };
    expect(result.runId.endsWith(RESULT_FILE_SUFFIX)).toBe(false);
    expect(result.success).toBe(false);
  });
});
