import { describe, expect, it } from 'vitest';

import { NodeSpawner } from '../../src/services/spawner';

describe('NodeSpawner', () => {
  it('finishes a piped command when a descendant keeps its output pipes open', async () => {
    const spawner = new NodeSpawner();
    const startedAt = Date.now();
    const child = spawner.spawn({
      command: "sleep 2 & printf 'batch-complete\\n' | tail -n 1",
      cwd: process.cwd(),
      env: process.env,
      detached: true,
    });
    let output = '';
    child.onOutput((chunk) => {
      output += chunk;
    });
    const outcome = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.onExit(resolve);
      child.onError(reject);
    });

    await expect(outcome).resolves.toEqual({ code: 0, signal: null });
    expect(output).toContain('batch-complete');
    expect(Date.now() - startedAt).toBeLessThan(1_500);
  }, 10_000);
});
