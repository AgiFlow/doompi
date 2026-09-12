import { describe, expect, it, vi } from 'vitest';
import type { DoomHeadlessExecutionContext } from '@agimon-ai/doompi-core/headless';
import { createHeadlessBashTool } from '../../../src/controllers/headless';
import type { BashRunRequest, BashRunResult } from '../../../src/types/bashRunService';

function execution(): DoomHeadlessExecutionContext {
  return {
    cwd: '/repo/nested',
    repoRoot: '/repo',
    sessionId: 'owned-session',
    environment: {},
    selection: { majorMode: 'copilot', activeLayers: ['runner'], domains: [], state: {} },
    client: { notify: vi.fn(), request: vi.fn(), setStatus: vi.fn() },
    session: {
      entries: () => [],
      appendCustomEntry: vi.fn(),
      prompt: vi.fn(),
      abort: vi.fn(),
      compact: vi.fn(),
      activity: vi.fn(async () => ({ hasPendingMessages: false, isIdle: true })),
    },
    shutdown: vi.fn(),
  };
}
const completed: BashRunResult = {
  kind: 'completed',
  id: 'run-1',
  name: 'example',
  output: 'finished',
  exitCode: 0,
  signal: null,
  logPath: '/unused/log',
  backend: 'native',
};

describe('headless bash adapter', () => {
  it.each([
    { background: false, interactive: false, mode: 'command', streams: true },
    { background: true, interactive: false, mode: 'background runner', streams: false },
    { background: false, interactive: true, mode: 'interactive runner', streams: false },
  ])('preserves ownership and update behavior for $mode', async ({ background, interactive, mode, streams }) => {
    const run = vi.fn(async (request: BashRunRequest) => {
      request.onOutput?.('streamed output');
      return completed;
    });
    const update = vi.fn();
    const tool = createHeadlessBashTool({ run });
    const result = await tool.execute(
      'call',
      { command: 'echo finished', timeout: 2, background, interactive, name: 'example' },
      undefined,
      update,
      execution(),
    );
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'echo finished',
        cwd: '/repo/nested',
        sessionId: 'owned-session',
        timeoutMs: 2000,
        background,
        interactive,
        name: 'example',
      }),
    );
    expect(typeof run.mock.calls[0]?.[0].onOutput === 'function').toBe(streams);
    expect(update.mock.calls[0]?.[0].content).toEqual([{ type: 'text', text: `Starting ${mode}...` }]);
    expect(update).toHaveBeenCalledTimes(streams ? 2 : 1);
    expect(JSON.stringify(result.content)).toContain('finished');
  });

  it('allows a caller without an update channel or timeout', async () => {
    const run = vi.fn(async (_request: BashRunRequest) => completed);
    await createHeadlessBashTool({ run }).execute('call', { command: 'true' }, undefined, undefined, execution());
    expect(run.mock.calls[0]?.[0].onOutput).toBeUndefined();
    expect(run.mock.calls[0]?.[0].timeoutMs).toBeUndefined();
  });

  it('rejects an already aborted call before starting a process', async () => {
    const run = vi.fn(async (_request: BashRunRequest) => completed);
    await expect(
      createHeadlessBashTool({ run }).execute('call', { command: 'true' }, AbortSignal.abort(), undefined, execution()),
    ).rejects.toThrow('Operation aborted');
    expect(run).not.toHaveBeenCalled();
  });
});
