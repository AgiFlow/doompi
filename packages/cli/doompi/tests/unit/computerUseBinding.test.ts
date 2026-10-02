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
        this.emit('message', { ...message, type: 'doompi:computer-use:ready', token: this.token, enabled: true });
      } else if (this.respond && message.type === 'doompi:computer-use:request') {
        this.emit('message', {
          ...message,
          type: 'doompi:computer-use:response',
          hostGeneration: this.generation,
          ok: true,
          result: {
            operation: message.operation,
            sessionId: message.sessionId,
            ...(message.operation === 'activate' ? { expiresAt: Date.now() + 60000 } : {}),
          },
        });
      }
      callback?.(null);
    });
    return true;
  }
}

const scope = { sessionId: 'session-a', cwd: '/fixture' };

const remoteHeaders = (deviceId = 'device-a', stepUp = 'not-required') =>
  new Headers({
    'x-doompi-api-caller-locality': 'remote',
    'x-doompi-api-caller-device-id': deviceId,
    'x-doompi-api-caller-step-up': stepUp,
  });

describe('Desktop computer-use IPC binding', () => {
  it('requires native approval and isolates paired sessions with revocation', async () => {
    const peer = new DesktopPeer();
    const binding = (await createComputerUseBinding(peer as never, { isDeviceAuthorized: () => true }))!;
    const headers = remoteHeaders();
    try {
      expect(binding.authorizeActivation?.(headers)).toBe(true);
      expect(binding.authorize?.(headers)).toBe(false);
      binding.claimSession?.(scope.sessionId, headers);
      expect(binding.authorizeSession?.(scope.sessionId, headers)).toBe(false);
      await binding.request(scope, { operation: 'activate' });
      expect(binding.authorizeSession?.(scope.sessionId, headers)).toBe(true);
      expect(binding.authorizeSession?.(scope.sessionId, remoteHeaders('device-b'))).toBe(false);
      expect(() => binding.claimSession?.(scope.sessionId, remoteHeaders('device-b'))).toThrow(/another paired/u);
      binding.revokeDevice?.('device-a');
      expect(binding.authorizeSession?.(scope.sessionId, headers)).toBe(false);
      await expect(binding.request(scope, { operation: 'observe' })).rejects.toThrow(/revoked/u);
    } finally {
      binding.close?.();
    }
  });

  it('requires fresh verified step-up for named tunnels and cancels pending approval on revocation', async () => {
    const peer = new DesktopPeer();
    const binding = (await createComputerUseBinding(peer as never, {
      isDeviceAuthorized: () => true,
      stepUpRequired: () => true,
    }))!;
    try {
      expect(binding.authorizeActivation?.(remoteHeaders())).toBe(false);
      const headers = remoteHeaders('device-a', 'verified');
      expect(binding.authorizeActivation?.(headers)).toBe(true);
      binding.claimSession?.(scope.sessionId, headers);
      peer.respond = false;
      const pending = binding.request(scope, { operation: 'activate' });
      binding.revokeDevice?.('device-a');
      await expect(pending).rejects.toThrow(/cancelled/u);
      expect(binding.authorizeSession?.(scope.sessionId, headers)).toBe(false);
      expect(peer.sent.some((message) => message.type === 'doompi:computer-use:cancel')).toBe(true);
    } finally {
      binding.close?.();
    }
  });
  it('allows only the matching pending requester without granting session or recording access', async () => {
    const peer = new DesktopPeer();
    let deviceLive = true;
    const binding = (await createComputerUseBinding(peer as never, { isDeviceAuthorized: () => deviceLive }))!;
    try {
      const headers = remoteHeaders();
      binding.claimSession?.(scope.sessionId, headers);
      expect(binding.authorizePending?.(scope.sessionId, headers)).toBe(true);
      expect(binding.authorizePending?.(scope.sessionId, remoteHeaders('device-b'))).toBe(false);
      expect(binding.authorizePending?.('other', headers)).toBe(false);
      expect(binding.authorizeSession?.(scope.sessionId, headers)).toBe(false);
      expect(binding.authorizeRecording?.(scope.sessionId, headers)).toBe(false);
      deviceLive = false;
      expect(binding.authorizePending?.(scope.sessionId, headers)).toBe(false);
    } finally {
      binding.close?.();
    }
  });

  it('expires action access separately from completed-recording access', async () => {
    const peer = new DesktopPeer();
    const binding = (await createComputerUseBinding(peer as never, { isDeviceAuthorized: () => true }))!;
    const headers = remoteHeaders();
    try {
      binding.claimSession?.(scope.sessionId, headers);
      await binding.request(scope, { operation: 'activate' });
      expect(binding.authorizePending?.(scope.sessionId, headers)).toBe(false);
      const now = Date.now();
      const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 120000);
      expect(binding.authorizeSession?.(scope.sessionId, headers)).toBe(false);
      expect(binding.authorizeRecording?.(scope.sessionId, headers)).toBe(true);
      clock.mockRestore();
      peer.emit('message', { type: 'doompi:computer-use:availability', version: 1, enabled: true });
      expect(binding.enabled).toBe(true);
      expect(binding.authorizeSession?.(scope.sessionId, headers)).toBe(false);
      expect(binding.authorizePending?.(scope.sessionId, headers)).toBe(false);
      expect(binding.authorizeRecording?.(scope.sessionId, headers)).toBe(true);
      peer.emit('message', { type: 'doompi:computer-use:availability', version: 1, enabled: false });
      expect(binding.authorizeRecording?.(scope.sessionId, headers)).toBe(true);
      binding.forgetSession?.(scope.sessionId);
      expect(binding.authorizeRecording?.(scope.sessionId, headers)).toBe(false);
    } finally {
      vi.restoreAllMocks();
      binding.close?.();
    }
  });

  it('ends control immediately when finalization starts without losing recording reads', async () => {
    const peer = new DesktopPeer();
    const binding = (await createComputerUseBinding(peer as never, { isDeviceAuthorized: () => true }))!;
    const headers = remoteHeaders();
    try {
      binding.claimSession?.(scope.sessionId, headers);
      await binding.request(scope, { operation: 'activate' });
      peer.respond = false;
      const controller = new AbortController();
      const stopped = binding.request(scope, {
        operation: 'stop',
        payload: { grantId: 'grant' },
        signal: controller.signal,
      });
      expect(binding.authorizeSession?.(scope.sessionId, headers)).toBe(false);
      expect(binding.authorizePending?.(scope.sessionId, headers)).toBe(false);
      expect(binding.authorizeRecording?.(scope.sessionId, headers)).toBe(true);
      controller.abort();
      await expect(stopped).rejects.toThrow(/cancelled/u);
    } finally {
      binding.close?.();
    }
  });

  it('revokes recording reads on device loss and Desktop disconnect', async () => {
    const peer = new DesktopPeer();
    let live = true;
    const binding = (await createComputerUseBinding(peer as never, { isDeviceAuthorized: () => live }))!;
    const headers = remoteHeaders();
    try {
      binding.claimSession?.(scope.sessionId, headers);
      await binding.request(scope, { operation: 'activate' });
      expect(binding.authorizeRecording?.(scope.sessionId, headers)).toBe(true);
      live = false;
      expect(binding.authorizeRecording?.(scope.sessionId, headers)).toBe(false);
      live = true;
      binding.revokeDevice?.('device-a');
      expect(binding.authorizeRecording?.(scope.sessionId, headers)).toBe(false);
      binding.claimSession?.(scope.sessionId, headers);
      await binding.request(scope, { operation: 'activate' });
      peer.connected = false;
      peer.emit('disconnect');
      expect(binding.authorizeRecording?.(scope.sessionId, headers)).toBe(false);
    } finally {
      binding.close?.();
    }
  });

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
