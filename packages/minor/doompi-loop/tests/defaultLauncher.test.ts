import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDefaultLoopLauncher } from '../src/services/defaultLoopLauncher';
import { createDoomLoopLaunchersService } from '../src/services/loopLaunchers';

function fixture(sessionId: string) {
  let idle = true;
  const editor = vi.fn<() => Promise<string | undefined>>(async () => 'Check the project status.');
  const input = vi.fn<() => Promise<string | undefined>>(async () => '60');
  const notify = vi.fn();
  const sendUserMessage = vi.fn();
  const context = {
    isIdle: () => idle,
    sessionManager: { getSessionId: () => sessionId },
    ui: { editor, input, notify },
  } as unknown as ExtensionContext;
  const pi = {
    sendUserMessage,
  } as unknown as ExtensionAPI;
  let instanceSequence = 0;
  const client = createDoomLoopLaunchersService({
    generation: `${sessionId}:loop-launchers`,
    createInstanceId: () => `${sessionId}:instance:${++instanceSequence}`,
    timestamp: () => '2026-08-20T12:34:56.000Z',
  });
  const launcher = createDefaultLoopLauncher(pi);
  const registration = launcher.register(context, client);
  return {
    client,
    context,
    editor,
    input,
    settled: launcher.onAgentSettled,
    notify,
    registration,
    registerCron: () => launcher.registerCron(context, client),
    sendUserMessage,
    setIdle(next: boolean) {
      idle = next;
    },
  };
}

describe('default loop launcher', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('is always available and repeats the user prompt at the selected interval', async () => {
    const current = fixture('default-loop-repeats');
    current.editor.mockResolvedValue('Check status.\nFix the oldest failure if needed.');
    current.input.mockResolvedValue('45');

    expect(current.client.listLaunchers()).toEqual([
      expect.objectContaining({
        id: 'doompi.default',
        source: '@agimon-ai/doompi-loop',
        label: 'Default loop',
      }),
    ]);

    const instance = await current.client.launch('doompi.default', { instanceId: 'custom' });

    expect(current.editor).toHaveBeenCalledWith('Loop prompt', '');
    expect(current.input).toHaveBeenCalledWith('Loop interval in seconds', 'Default: 300s');
    expect(current.sendUserMessage).toHaveBeenCalledWith('Check status.\nFix the oldest failure if needed.');
    expect(instance).toMatchObject({
      instanceId: 'custom',
      label: 'Default loop',
      detail: 'every 45s · Check status. Fix the oldest failure if needed.',
      state: 'running',
    });

    await vi.advanceTimersByTimeAsync(90_000);
    expect(current.sendUserMessage).toHaveBeenCalledTimes(3);

    await current.client.stop('custom');
    await vi.advanceTimersByTimeAsync(90_000);
    expect(current.sendUserMessage).toHaveBeenCalledTimes(3);
    await current.registration.dispose();
  });

  it('uses the default interval when the interval input is blank', async () => {
    const current = fixture('default-loop-interval');
    current.input.mockResolvedValue('   ');

    await current.client.launch('doompi.default', { instanceId: 'default-interval' });
    await vi.advanceTimersByTimeAsync(299_999);
    expect(current.sendUserMessage).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(current.sendUserMessage).toHaveBeenCalledTimes(2);

    await current.registration.dispose();
  });

  it.each(['29', '3601', '1.5'])('rejects invalid interval %j without starting a loop', async (interval) => {
    const current = fixture(`default-loop-invalid-${interval}`);
    current.input.mockResolvedValue(interval);

    await expect(
      current.client.launch('doompi.default', { instanceId: `invalid-${interval}` }),
    ).resolves.toBeUndefined();

    expect(current.sendUserMessage).not.toHaveBeenCalled();
    expect(current.notify).toHaveBeenCalledWith(expect.stringContaining('Interval must be'), 'warning');
    expect(current.client.listInstances()).toEqual([]);
    await current.registration.dispose();
  });

  it('cancels when prompt or interval input is dismissed', async () => {
    const promptCancelled = fixture('default-loop-prompt-cancelled');
    promptCancelled.editor.mockResolvedValue(undefined);
    await expect(promptCancelled.client.launch('doompi.default')).resolves.toBeUndefined();
    expect(promptCancelled.input).not.toHaveBeenCalled();
    await promptCancelled.registration.dispose();

    const intervalCancelled = fixture('default-loop-interval-cancelled');
    intervalCancelled.input.mockResolvedValue(undefined);
    await expect(intervalCancelled.client.launch('doompi.default')).resolves.toBeUndefined();
    expect(intervalCancelled.sendUserMessage).not.toHaveBeenCalled();
    await intervalCancelled.registration.dispose();
  });

  it('coalesces elapsed ticks while the agent is busy', async () => {
    const current = fixture('default-loop-busy');
    await current.client.launch('doompi.default', { instanceId: 'busy' });
    expect(current.sendUserMessage).toHaveBeenCalledOnce();

    current.setIdle(false);
    await vi.advanceTimersByTimeAsync(180_000);
    expect(current.sendUserMessage).toHaveBeenCalledOnce();

    current.setIdle(true);
    current.settled();
    expect(current.sendUserMessage).toHaveBeenCalledTimes(2);
    current.settled();
    expect(current.sendUserMessage).toHaveBeenCalledTimes(2);

    await current.registration.dispose();
  });

  it('resumes pending loops one at a time as the agent settles', async () => {
    const current = fixture('default-loop-multiple-pending');
    current.setIdle(false);
    await current.client.launch('doompi.default', { instanceId: 'first' });
    await current.client.launch('doompi.default', { instanceId: 'second' });
    expect(current.sendUserMessage).not.toHaveBeenCalled();

    current.setIdle(true);
    current.settled();
    expect(current.sendUserMessage).toHaveBeenCalledOnce();

    current.setIdle(false);
    current.settled();
    expect(current.sendUserMessage).toHaveBeenCalledOnce();

    current.setIdle(true);
    current.settled();
    expect(current.sendUserMessage).toHaveBeenCalledTimes(2);
    await current.registration.dispose();
  });

  it('keeps scheduling after a pass cannot be submitted', async () => {
    const current = fixture('default-loop-send-failure');
    current.sendUserMessage.mockImplementationOnce(() => {
      throw new Error('session unavailable');
    });

    const instance = await current.client.launch('doompi.default', { instanceId: 'send-failure' });

    expect(instance).toMatchObject({ state: 'running' });
    expect(current.notify).toHaveBeenCalledWith('Default loop pass could not start: session unavailable', 'warning');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(current.sendUserMessage).toHaveBeenCalledTimes(2);
    await current.registration.dispose();
  });
  it('accepts explicit interval configuration without opening dialogs', async () => {
    const current = fixture('agent-interval');
    await current.client.launch('doompi.default', {
      interactive: false,
      input: { prompt: 'Check status', intervalSeconds: 30 },
    });
    expect(current.editor).not.toHaveBeenCalled();
    expect(current.input).not.toHaveBeenCalled();
    expect(current.sendUserMessage).toHaveBeenCalledWith('Check status');
    await current.client.dispose();
  });

  it('runs cron at its scheduled minute and stops future runs on disposal', async () => {
    vi.setSystemTime(new Date('2026-09-23T10:00:00Z'));
    const current = fixture('cron');
    current.registerCron();
    await current.client.launch('doompi.cron', {
      interactive: false,
      input: { prompt: 'Check cron', cron: '*/2 * * * *', timezone: 'UTC' },
    });
    expect(current.editor).not.toHaveBeenCalled();
    expect(current.sendUserMessage).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(119999);
    expect(current.sendUserMessage).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(current.sendUserMessage).toHaveBeenCalledExactlyOnceWith('Check cron');
    await current.client.dispose();
    await vi.advanceTimersByTimeAsync(240000);
    expect(current.sendUserMessage).toHaveBeenCalledOnce();
  });

  it.each([
    { cron: 'invalid' },
    { cron: '0 0 0 * * *' },
    { cron: '90 * * * *' },
    { cron: '* * * * *', timezone: 'not/a-zone' },
  ])('rejects invalid cron input %j without leaving an instance', async (input) => {
    const current = fixture('invalid-cron');
    current.registerCron();
    await expect(
      current.client.launch('doompi.cron', { interactive: false, input: { prompt: 'Check', ...input } }),
    ).rejects.toThrow();
    expect(current.client.listInstances()).toEqual([]);
    expect(current.sendUserMessage).not.toHaveBeenCalled();
    await current.client.dispose();
  });
});
