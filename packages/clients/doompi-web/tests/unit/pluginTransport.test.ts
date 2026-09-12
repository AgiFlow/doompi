import { afterEach, describe, expect, it, vi } from 'vitest';
import { bindTransport, invokeServerMethod, releaseTransport } from '../../src/web/lib/transport.ts';

afterEach(releaseTransport);

describe('plugin method transport', () => {
  it.each([
    { scope: 'global' as const },
    { scope: 'workspace' as const, workspaceId: 'workspace-a' },
    { scope: 'session' as const, sessionId: 'session-b' },
  ])('forwards the exact $scope mount and method input', async (mount) => {
    const invoke = vi.fn().mockResolvedValue({ accepted: true });
    bindTransport(vi.fn(), invoke);
    const call = { mount, service: 'documents', method: 'open', input: { path: 'README.md' } };
    await expect(invokeServerMethod(call)).resolves.toEqual({ accepted: true });
    expect(invoke).toHaveBeenCalledExactlyOnceWith(call);
  });

  it('uses the replacement invoker and rejects calls after release', async () => {
    const old = vi.fn().mockResolvedValue('old');
    const current = vi.fn().mockResolvedValue('current');
    const call = { mount: { scope: 'global' as const }, service: 'documents', method: 'list', input: {} };
    bindTransport(vi.fn(), old);
    bindTransport(vi.fn(), current);
    await expect(invokeServerMethod(call)).resolves.toBe('current');
    expect(old).not.toHaveBeenCalled();
    releaseTransport();
    await expect(invokeServerMethod(call)).rejects.toThrow('not connected');
    expect(current).toHaveBeenCalledOnce();
  });
});
