import { describe, expect, it, vi } from 'vitest';

import { realtimeHostConnection, type RealtimeHost } from '../src/services/realtimeHost';

const host: RealtimeHost = {
  start: vi.fn(async () => undefined),
  poll: vi.fn(async (activationId, after) => ({
    activationId,
    state: 'active' as const,
    cursor: after,
    events: [],
  })),
  send: vi.fn(async () => undefined),
  control: vi.fn(async () => undefined),
  stop: vi.fn(async () => undefined),
};

describe('live voice host service injection', () => {
  it('uses the injected typed host directly', () => {
    expect(realtimeHostConnection(host)).toBe(host);
  });

  it('does not discover an internal socket when no host is provided', () => {
    expect(realtimeHostConnection()).toBeUndefined();
  });
});
