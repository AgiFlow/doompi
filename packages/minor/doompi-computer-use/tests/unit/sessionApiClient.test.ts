import { describe, expect, it, vi } from 'vitest';
import {
  createComputerUseSessionClient,
  type ComputerUseSessionClient,
} from '../../src/adapters/pi/sessionApiClient.ts';

const host: ComputerUseSessionClient = {
  state: vi.fn(async () => ({ sessionId: 'session', revision: 0, wake: 0, phase: 'inactive' as const })),
  observe: vi.fn(async () => ({
    runId: 'run',
    snapshotId: 'snapshot',
    targetGeneration: 'target',
    applicationName: 'Test App',
    bundleId: 'com.example.test',
    windowTitle: 'Test Window',
    elements: [],
    screenshot: { mimeType: 'image/png' as const, data: '' },
  })),
  act: vi.fn(async () => ({ applied: true })),
  stop: vi.fn(async () => ({ sessionId: 'session', revision: 1, wake: 1, phase: 'inactive' as const })),
};

describe('computer-use session service injection', () => {
  it('uses the injected typed service without discovering a socket or token', () => {
    expect(createComputerUseSessionClient(host)).toBe(host);
  });

  it('does not invent an unavailable transport when no host is provided', () => {
    expect(createComputerUseSessionClient()).toBeUndefined();
  });
});
