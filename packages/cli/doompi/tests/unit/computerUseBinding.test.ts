import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import { createComputerUseBinding } from '../../src/builders/server/computerUseBinding';

interface WireMessage {
  type: string;
  requestId?: string;
  version: number;
  operation?: string;
  sessionId?: string;
}

class DesktopPeer extends EventEmitter {
  connected = true;
  token = 'a'.repeat(64);
  generation = 'desktop-a';
  respond = true;
  readonly sent: WireMessage[] = [];

  send(message: WireMessage, callback?: (error: Error | null) => void): boolean {
    this.sent.push(message);
    queueMicrotask(() => {
      if (message.type === 'doompi:computer-use:hello') {
        this.emit('message', { ...message, type: 'doompi:computer-use:ready', token: this.token });
      } else if (this.respond && message.type === 'doompi:computer-use:request') {
        this.emit('message', {
          ...message,
          type: 'doompi:computer-use:response',
          hostGeneration: this.generation,
          ok: true,
          result: { operation: message.operation, sessionId: message.sessionId },
        });
      }
      callback?.(null);
    });
    return true;
  }
}

const scope = { sessionId: 'session-a', cwd: '/fixture' };

describe('Desktop computer-use IPC binding', () => {
  it('does not discover a capability from an ordinary process or malformed handshake', async () => {
    expect(await createComputerUseBinding({ connected: false } as never)).toBeUndefined();
    const peer = new DesktopPeer();
    peer.token = 'not-a-desktop-proof';
    expect(await createComputerUseBinding(peer as never)).toBeUndefined();
    expect(peer.listenerCount('message')).toBe(0);
  });

  it('requires the native proof and a pinned session before forwarding control', async () => {
    const peer = new DesktopPeer();
    const binding = (await createComputerUseBinding(peer as never))!;
    try {
      expect(binding.available).toBe(true);
      expect(binding.authorize?.(new Headers())).toBe(false);
      expect(binding.authorize?.(new Headers({ 'x-doompi-desktop': 'é'.repeat(64) }))).toBe(false);
      expect(binding.authorize?.(new Headers({ 'x-doompi-desktop': peer.token }))).toBe(true);
      await expect(binding.request(scope, { operation: 'observe' })).rejects.toThrow(/not been authorized/u);
      binding.claimSession?.(scope.sessionId);
      expect(await binding.request(scope, { operation: 'observe', payload: { grantId: 'grant' } })).toEqual({
        operation: 'observe',
        sessionId: scope.sessionId,
      });
      await expect(binding.request({ ...scope, sessionId: 'other' }, { operation: 'act' })).rejects.toThrow(
        /not been authorized/u,
      );
    } finally {
      binding.close?.();
    }
  });

  it('forwards cancellation and rejects in-flight work without leaving transport listeners', async () => {
    const peer = new DesktopPeer();
    const binding = (await createComputerUseBinding(peer as never))!;
    binding.claimSession?.(scope.sessionId);
    peer.respond = false;
    const controller = new AbortController();
    const pending = binding
      .request(scope, { operation: 'observe', signal: controller.signal })
      .catch((error: unknown) => error);
    controller.abort();
    expect(await pending).toMatchObject({ message: 'Desktop computer-use request was cancelled.' });
    expect(peer.sent.some((message) => message.type === 'doompi:computer-use:cancel')).toBe(true);
    binding.close?.();
    binding.close?.();
    expect(peer.listenerCount('message')).toBe(0);
  });

  it('revokes availability on disconnect while keeping the old session closed to browser callers', async () => {
    const peer = new DesktopPeer();
    const binding = (await createComputerUseBinding(peer as never))!;
    const changed = vi.fn();
    binding.subscribe?.(changed);
    binding.claimSession?.(scope.sessionId);
    peer.respond = false;
    const pending = binding.request(scope, { operation: 'observe' }).catch((error: unknown) => error);
    peer.connected = false;
    peer.emit('disconnect');
    expect(await pending).toMatchObject({ message: 'Desktop computer use is disconnected.' });
    expect(binding.available).toBe(false);
    expect(binding.ownsSession?.(scope.sessionId)).toBe(true);
    expect(binding.authorize?.(new Headers({ 'x-doompi-desktop': peer.token }))).toBe(false);
    expect(changed).toHaveBeenCalledOnce();
    binding.close?.();
  });

  it('does not accept responses from a replacement Desktop generation', async () => {
    const peer = new DesktopPeer();
    const binding = (await createComputerUseBinding(peer as never))!;
    await binding.request(scope, { operation: 'status' });
    peer.generation = 'desktop-b';
    await expect(binding.request(scope, { operation: 'status' })).rejects.toThrow(/generation changed/u);
    expect(binding.available).toBe(false);
    binding.close?.();
  });
});
