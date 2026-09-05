import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { describe, expect, it, vi } from 'vitest';
import { createPiHubService } from '../../src/adapters/piHubService.ts';
import type { SessionRecord } from '../../src/types/registry.ts';

function record(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    version: 1,
    id: 'session-1',
    name: 'probe',
    cwd: '/workspace/repo',
    socketPath: '/run/s.sock',
    tokenFile: '/run/token',
    protocolSocketPath: '/run/s.sock.pi',
    protocolServerId: '00000000-0000-4000-8000-000000000001',
    pid: 1234,
    createdAt: '2026-08-26T00:00:00.000Z',
    ...overrides,
  };
}

function service(records: SessionRecord[]) {
  return createPiHubService({ records: () => records, spawn: vi.fn() });
}

describe('hub protocol service', () => {
  it('resolves registry records as routed session metadata', async () => {
    const subject = service([record()]);

    await expect(subject.resolveSession('session-1', BACKGROUND_CONTEXT)).resolves.toEqual({
      id: 'session-1',
      createdAt: Date.parse('2026-08-26T00:00:00.000Z'),
      storageVersion: 1,
      cwd: '/workspace/repo',
    });
  });

  it('reports an unparsable timestamp as zero rather than publishing NaN', async () => {
    const subject = service([record({ createdAt: 'not a date' })]);

    const metadata = await subject.resolveSession('session-1', BACKGROUND_CONTEXT);

    expect(metadata.createdAt).toBe(0);
  });

  it('refuses a session the registry does not list', async () => {
    const subject = service([]);

    await expect(subject.resolveSession('ghost', BACKGROUND_CONTEXT)).rejects.toThrow(/No session ghost/);
  });

  it('refuses a session whose server does not publish the 0.85 endpoint identity', async () => {
    const subject = service([record({ protocolServerId: undefined })]);
    const metadata = await subject.resolveSession('session-1', BACKGROUND_CONTEXT);

    await expect(subject.openSession(metadata, BACKGROUND_CONTEXT)).rejects.toThrow(/does not publish/);
  });
});
