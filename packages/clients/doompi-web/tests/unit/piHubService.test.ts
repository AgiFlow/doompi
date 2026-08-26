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
    pid: 1234,
    createdAt: '2026-08-26T00:00:00.000Z',
    ...overrides,
  };
}

function service(records: SessionRecord[], spawn = vi.fn()) {
  return { service: createPiHubService({ records: () => records, spawn }), spawn };
}

describe('hub protocol service', () => {
  it('lists what the registry knows as protocol metadata', async () => {
    const { service: subject } = service([record()]);

    await expect(subject.listSessions()).resolves.toEqual([
      {
        id: 'session-1',
        createdAt: Date.parse('2026-08-26T00:00:00.000Z'),
        sessionName: 'probe',
        cwd: '/workspace/repo',
      },
    ]);
  });

  it('reports an unparsable timestamp as zero rather than NaN, which the schema rejects', async () => {
    const { service: subject } = service([record({ createdAt: 'not a date' })]);

    const [session] = await subject.listSessions();

    expect(session?.createdAt).toBe(0);
  });

  it('offers no models of its own; a session reports its own', async () => {
    const { service: subject } = service([]);

    await expect(subject.listModels()).resolves.toEqual([]);
  });

  it('refuses a session the registry does not list', async () => {
    const { service: subject } = service([]);

    await expect(subject.openSession('ghost')).rejects.toThrow(/No session ghost/);
  });

  it('refuses a session whose server predates the protocol socket', async () => {
    const { service: subject } = service([record({ protocolSocketPath: undefined })]);

    await expect(subject.openSession('session-1')).rejects.toThrow(/predates the protocol socket/);
  });

  it('requires a working directory to create a session', async () => {
    const { service: subject, spawn } = service([]);

    await expect(subject.createSession({ id: 'new', cwd: '' })).rejects.toThrow(/working directory/);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('surfaces a refused spawn instead of waiting for a session that will never appear', async () => {
    const spawn = vi.fn().mockResolvedValue({ ok: false, code: 'invalid_request', error: 'No such directory: /nope' });
    const { service: subject } = service([], spawn);

    await expect(subject.createSession({ id: 'new', cwd: '/nope' })).rejects.toThrow(/No such directory/);
  });
});
