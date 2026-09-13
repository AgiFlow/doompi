import { describe, expect, it } from 'vitest';

import { CLAIMED_RESULT_FILE_NAME, RESULT_FILE_SUFFIX, type RunResultFile } from '../../src/services/resultWatcher';

/** Result files are durable history artifacts, not a live delivery transport. */
describe('external result payload contract', () => {
  it('keeps the run id as the only required result field', () => {
    const result: RunResultFile = { runId: 'run-1', success: true, summary: 'done' };
    expect(result.runId).toBe('run-1');
    expect(RESULT_FILE_SUFFIX).toBe('.json');
    expect(CLAIMED_RESULT_FILE_NAME).toBe('claimed-result.json');
  });
});
