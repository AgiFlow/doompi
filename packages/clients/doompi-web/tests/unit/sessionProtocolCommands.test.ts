import type { SessionService } from '@agimon-ai/doompi-core/session-protocol';
import type { Context } from '@earendil-works/chord';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { bindSessionProtocol, sendSessionProtocolFrame } from '../../src/web/lib/sessionProtocolCommands';

const releases: (() => void)[] = [];

afterEach(() => {
  releases.splice(0).forEach((release) => release());
});

function service(overrides: Record<string, unknown>): SessionService {
  return overrides as unknown as SessionService;
}

describe('session protocol command lifecycle', () => {
  it('cancels an in-flight short RPC and skips short commands queued behind it', async () => {
    let resolveState!: (value: never) => void;
    let stateContext: Parameters<SessionService['getState']>[0] | undefined;
    const clearQueue = vi.fn();
    const receive = vi.fn();
    const release = bindSessionProtocol(
      's1',
      service({
        getState: (context: Context) => {
          stateContext = context;
          return new Promise<never>((resolve) => {
            resolveState = resolve;
          });
        },
        clearQueue,
      }),
      receive,
    );
    releases.push(release);

    sendSessionProtocolFrame('s1', { id: 'state', type: 'get_state' });
    sendSessionProtocolFrame('s1', { id: 'clear', type: 'clear_queue' });
    await Promise.resolve();
    release();
    expect(stateContext?.abortSignal?.aborted).toBe(true);
    resolveState(undefined as never);
    await Promise.resolve();
    await Promise.resolve();

    expect(clearQueue).not.toHaveBeenCalled();
    expect(receive).not.toHaveBeenCalled();
  });

  it('keeps an accepted prompt context alive when its binding is replaced', async () => {
    let resolvePrompt!: () => void;
    let promptArgs: unknown;
    let promptContext: Parameters<SessionService['prompt']>[1] | undefined;
    const receive = vi.fn();
    const release = bindSessionProtocol(
      's1',
      service({
        prompt: (args: unknown, context: Context) => {
          promptArgs = args;
          promptContext = context;
          return new Promise<void>((resolve) => {
            resolvePrompt = resolve;
          });
        },
      }),
      receive,
    );
    releases.push(release);

    sendSessionProtocolFrame('s1', { id: 'prompt', type: 'prompt', message: 'run' });
    await Promise.resolve();
    release();
    expect(promptArgs).toEqual({ text: 'run', waitFor: 'accepted' });
    expect(promptContext?.abortSignal?.aborted).not.toBe(true);
    resolvePrompt();
    await Promise.resolve();
    await Promise.resolve();

    expect(receive).not.toHaveBeenCalled();
  });

  it('omits absent optional fields from serialized command arguments', async () => {
    const steer = vi.fn(async () => undefined);
    const followUp = vi.fn(async () => undefined);
    const compact = vi.fn(async () => undefined);
    const release = bindSessionProtocol('s1', service({ steer, followUp, compact }), vi.fn());
    releases.push(release);

    sendSessionProtocolFrame('s1', { type: 'steer', message: 'guide' });
    sendSessionProtocolFrame('s1', { type: 'follow_up', message: 'next' });
    sendSessionProtocolFrame('s1', { type: 'compact' });
    await vi.waitFor(() => expect(followUp).toHaveBeenCalledOnce());

    expect(steer).toHaveBeenCalledWith({ text: 'guide' }, expect.anything());
    expect(followUp).toHaveBeenCalledWith({ text: 'next' }, expect.anything());
    expect(compact).toHaveBeenCalledWith({}, expect.anything());
  });
});
