import type { SessionService } from '@agimon-ai/doompi-core/sessionProtocol';
import type { Context } from '@earendil-works/chord';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  bindSessionProtocol,
  hasSessionProtocol,
  requestSessionProtocolFrame,
  sendSessionProtocolFrame,
} from '../../src/web/lib/sessionProtocolCommands';

const releases: (() => void)[] = [];

afterEach(() => {
  releases.splice(0).forEach((release) => release());
});

function service(overrides: Record<string, unknown>): SessionService {
  return overrides as unknown as SessionService;
}

describe('session protocol command lifecycle', () => {
  it('reports readiness only while a session command binding is live', () => {
    expect(hasSessionProtocol('s1')).toBe(false);
    const release = bindSessionProtocol('s1', service({}), vi.fn());
    releases.push(release);
    expect(hasSessionProtocol('s1')).toBe(true);
    release();
    expect(hasSessionProtocol('s1')).toBe(false);
    expect(() => sendSessionProtocolFrame('s1', { type: 'prompt', message: 'test' })).toThrow('not connected');
  });
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

  it('aborts without clearing pending input or waiting for another short RPC', async () => {
    const clearQueue = vi.fn();
    const abort = vi.fn(async () => undefined);
    const release = bindSessionProtocol(
      's1',
      service({ getState: () => new Promise(() => undefined), clearQueue, abort }),
      vi.fn(),
    );
    releases.push(release);

    sendSessionProtocolFrame('s1', { type: 'get_state' });
    sendSessionProtocolFrame('s1', { type: 'abort' });
    await vi.waitFor(() => expect(abort).toHaveBeenCalledOnce());
    expect(clearQueue).not.toHaveBeenCalled();
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

  it('correlates failed steer acknowledgement and keeps a replaced binding outcome uncertain', async () => {
    const receive = vi.fn();
    const steer = vi.fn(async () => {
      throw new Error('turn ended before steering');
    });
    const release = bindSessionProtocol('s1', service({ steer }), receive);
    releases.push(release);
    const failed = await requestSessionProtocolFrame('s1', { type: 'steer', message: 'keep this' });
    expect(failed).toMatchObject({ success: false, error: 'turn ended before steering' });
    expect(receive).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'response',
        command: 'steer',
        success: false,
        error: 'turn ended before steering',
      }),
    );

    const releaseWait = bindSessionProtocol('s1', service({ steer: () => new Promise(() => undefined) }), receive);
    releases.push(releaseWait);
    const unacknowledged = requestSessionProtocolFrame('s1', { type: 'steer', message: 'do not resend' });
    releaseWait();
    await expect(unacknowledged).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining('uncertain'),
    });
  });

  it('sends stable item and target identities in a single promote command', async () => {
    const promoteQueued = vi.fn(async () => 'promoted');
    const release = bindSessionProtocol('s1', service({ promoteQueued }), vi.fn());
    releases.push(release);
    const response = await requestSessionProtocolFrame('s1', {
      type: 'promote_queued',
      id: 'item-17',
      operationId: 'operation-8',
    });
    expect(response).toEqual({ success: true, data: 'promoted' });
    expect(promoteQueued).toHaveBeenCalledWith({ id: 'item-17', operationId: 'operation-8' }, expect.anything());
  });
});
