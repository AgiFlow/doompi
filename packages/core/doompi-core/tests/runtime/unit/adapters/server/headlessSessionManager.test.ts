import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { HeadlessSessionHost } from '../../../../../src/systems/main/types/headlessSessionHost';

const { createHeadlessSessionHost } = vi.hoisted(() => ({ createHeadlessSessionHost: vi.fn() }));

vi.mock('../../../../../src/systems/main/adapters/headlessSessionHost', () => ({ createHeadlessSessionHost }));

import { createHeadlessSessionManager } from '../../../../../src/systems/main/adapters/headlessSessionManager';

function host(): HeadlessSessionHost {
  return {
    runtime: { exited: new Promise<number>(() => undefined) } as HeadlessSessionHost['runtime'],
    host: undefined,
    prepareFacets: () => undefined,
    activateFacets: async () => undefined,
    canDispatch: () => true,
    onPresentationFrame: () => () => undefined,
    respondToExtensionUi: () => false,
    dispose: vi.fn(async () => undefined),
  };
}

const options = (sessionId: string) => ({
  cwd: '/repo',
  repoRoot: '/repo',
  sessionId,
  sessionName: sessionId,
  agentArgs: [],
  environment: {},
  selection: { majorMode: 'development', activeLayers: [], domains: [], minorModes: [] },
  candidates: [],
});

describe('createHeadlessSessionManager', () => {
  beforeEach(() => createHeadlessSessionHost.mockReset());

  it('owns multiple sessions and closes one without affecting the other', async () => {
    const first = host();
    const second = host();
    createHeadlessSessionHost.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const manager = createHeadlessSessionManager();

    await manager.create(options('one'));
    await manager.create(options('two'));
    await manager.closeSession('one');

    expect(first.dispose).toHaveBeenCalledOnce();
    expect(second.dispose).not.toHaveBeenCalled();
    expect(manager.get('one')).toBeUndefined();
    expect(manager.get('two')).toBe(second);
  });

  it('rejects duplicate identities and disposes every remaining session on close', async () => {
    const session = host();
    createHeadlessSessionHost.mockResolvedValue(session);
    const manager = createHeadlessSessionManager();

    await manager.create(options('one'));
    await expect(manager.create(options('one'))).rejects.toThrow("Session 'one' already exists");
    await manager.close();

    expect(session.dispose).toHaveBeenCalledOnce();
    await expect(manager.create(options('two'))).rejects.toThrow('manager is closed');
  });

  it('disposes a session when creation is aborted before admission', async () => {
    const session = host();
    const controller = new AbortController();
    createHeadlessSessionHost.mockImplementation(async () => {
      controller.abort(new Error('cancelled'));
      return session;
    });
    const manager = createHeadlessSessionManager();

    await expect(manager.create({ ...options('one'), signal: controller.signal })).rejects.toThrow('cancelled');
    expect(session.dispose).toHaveBeenCalledOnce();
    expect(manager.sessions()).toEqual([]);
  });

  it('rejects a request already aborted without creating a host', async () => {
    const controller = new AbortController();
    controller.abort();
    const manager = createHeadlessSessionManager();
    await expect(manager.create({ ...options('one'), signal: controller.signal })).rejects.toThrow();
    expect(createHeadlessSessionHost).not.toHaveBeenCalled();
    await manager.closeSession('missing');
  });

  it('aggregates shutdown failures and returns the same close result', async () => {
    const first = host();
    const second = host();
    vi.mocked(first.dispose).mockRejectedValueOnce(new Error('first failed'));
    vi.mocked(second.dispose).mockRejectedValueOnce(new Error('second failed'));
    createHeadlessSessionHost.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const manager = createHeadlessSessionManager();
    await manager.create(options('one'));
    await manager.create(options('two'));
    const closing = manager.close();
    expect(manager.close()).toBe(closing);
    await expect(closing).rejects.toThrow('shutdown failed');
    expect(second.dispose).toHaveBeenCalledBefore(first.dispose as ReturnType<typeof vi.fn>);
  });
});
