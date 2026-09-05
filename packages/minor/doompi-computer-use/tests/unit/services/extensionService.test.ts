import { describe, expect, it } from 'vitest';
import { DefaultComputerUseExtensionService } from '../../../src/services/extensionService.ts';

describe('DefaultComputerUseExtensionService', () => {
  it('reports when Desktop is unavailable', async () => {
    const service = new DefaultComputerUseExtensionService();

    await expect(service.execute()).resolves.toEqual({
      message: 'Computer use requires a DoomPi Desktop session.',
      level: 'error',
    });
  });

  it('reports the current Desktop-backed session phase', async () => {
    const service = new DefaultComputerUseExtensionService({
      state: async () => ({ sessionId: 'session-1', revision: 1, wake: 1, phase: 'awaiting_confirmation' }),
      observe: async () => ({}) as never,
      act: async () => ({}),
      stop: async () => ({ sessionId: 'session-1', revision: 2, wake: 2, phase: 'stopping' }),
    });

    await expect(service.execute()).resolves.toEqual({
      message: 'Computer use is awaiting confirmation.',
      level: 'info',
    });
  });
});
