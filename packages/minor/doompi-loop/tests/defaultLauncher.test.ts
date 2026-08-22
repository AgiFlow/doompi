import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultLoopLauncher } from '../src/adapters/pi/defaultLoopLauncher.ts';
import { createDoomLoopLaunchersService } from '../src/services/loopLaunchers.ts';

type EventListener = (event: unknown, ctx: ExtensionContext) => void | Promise<void>;

function fixture(sessionId: string) {
  let idle = true;
  const listeners = new Map<string, EventListener>();
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
    on: vi.fn((event: string, listener: EventListener) => listeners.set(event, listener)),
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
    listeners,
    notify,
    registration,
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
    await current.listeners.get('agent_settled')?.({}, current.context);
    expect(current.sendUserMessage).toHaveBeenCalledTimes(2);
    await current.listeners.get('agent_settled')?.({}, current.context);
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
    await current.listeners.get('agent_settled')?.({}, current.context);
    expect(current.sendUserMessage).toHaveBeenCalledOnce();

    current.setIdle(false);
    await current.listeners.get('agent_settled')?.({}, current.context);
    expect(current.sendUserMessage).toHaveBeenCalledOnce();

    current.setIdle(true);
    await current.listeners.get('agent_settled')?.({}, current.context);
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
});
