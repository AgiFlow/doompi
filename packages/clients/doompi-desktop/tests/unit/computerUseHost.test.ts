import { describe, expect, it, vi } from 'vitest';
import { ComputerUseHost } from '../../src/services/computerUseHost.ts';
import type { ComputerUseBackend, ComputerUseDesktopRequest } from '../../src/types/computerUse.ts';

function request(
  sessionId: string,
  operation: ComputerUseDesktopRequest['operation'],
  payload?: unknown,
): ComputerUseDesktopRequest {
  return {
    type: 'doompi:computer-use:request',
    version: 1,
    requestId: `${sessionId}-${operation}`,
    sessionId,
    operation,
    ...(payload === undefined ? {} : { payload }),
  };
}

function activation(durationSeconds = 60, requestId = 'confirmation-1') {
  return {
    requestId,
    target: {
      bundleId: 'com.example.fixture',
      applicationName: 'Fixture',
      processId: 123,
      windowId: 'window-1',
      windowTitle: 'Fixture Window',
    },
    durationSeconds,
    createdAt: 1000,
    confirmationExpiresAt: 121_000,
    caller: { locality: 'local', stepUp: 'not-required' },
  };
}
function fixture(confirmLocalActivation = vi.fn(async () => true)) {
  let now = 1000;
  let ids = 0;
  const backend: ComputerUseBackend = {
    status: vi.fn(async () => ({ ready: true })),
    targets: vi.fn(async () => ({ targets: [] })),
    activate: vi.fn(async () => ({ recording: true })),
    observe: vi.fn(async () => ({ snapshotId: 'snapshot-1' })),
    act: vi.fn(async () => ({ applied: true })),
    stop: vi.fn(async () => undefined),
  };
  const host = new ComputerUseHost({
    backend,
    hostGeneration: 'host-1',
    now: () => now,
    newId: () => `id-${String(++ids)}`,
    confirmLocalActivation,
  });
  return { backend, host, advance: (milliseconds: number) => (now += milliseconds) };
}

describe('ComputerUseHost', () => {
  it('binds one grant to the activating session and rejects a second session', async () => {
    const { host } = fixture();
    const activated = await host.handle(request('session-a', 'activate', activation()));
    expect(activated).toMatchObject({ ok: true, result: { grantId: 'id-1', runId: 'id-2' } });

    const busy = await host.handle(request('session-b', 'activate', activation(60, 'confirmation-2')));
    expect(busy).toMatchObject({ ok: false, code: 'busy_in_another_session' });
  });

  it('rejects stale and replayed activation confirmations', async () => {
    const { host } = fixture();
    const expired = { ...activation(), confirmationExpiresAt: 999 };
    expect(await host.handle(request('session-a', 'activate', expired))).toMatchObject({ ok: false });

    expect(await host.handle(request('session-a', 'activate', activation()))).toMatchObject({ ok: true });
    expect(await host.handle(request('session-a', 'stop', { grantId: 'id-1' }))).toMatchObject({ ok: true });
    expect(await host.handle(request('session-a', 'activate', activation()))).toMatchObject({
      ok: false,
      code: 'stale_request',
    });
  });

  it.each([
    ['missing payload', undefined],
    ['unsupported activation field', { ...activation(), extra: true }],
    ['zero duration', activation(0)],
    ['excessive duration', activation(1801)],
    ['future confirmation', { ...activation(), createdAt: 7000 }],
    ['inverted confirmation window', { ...activation(), confirmationExpiresAt: 1000 }],
    ['oversized confirmation window', { ...activation(), confirmationExpiresAt: 122_001 }],
    ['missing target', { ...activation(), target: undefined }],
    ['invalid process', { ...activation(), target: { ...activation().target, processId: 0 } }],
    ['unsupported target field', { ...activation(), target: { ...activation().target, x: 1 } }],
    ['missing caller', { ...activation(), caller: undefined }],
    ['invalid local caller', { ...activation(), caller: { locality: 'local', stepUp: 'verified' } }],
    ['missing remote device', { ...activation(), caller: { locality: 'remote', stepUp: 'verified' } }],
    [
      'unverified remote caller',
      { ...activation(), caller: { locality: 'remote', deviceId: 'device-1', stepUp: 'not-required' } },
    ],
  ])('rejects %s before native activation', async (_name, payload) => {
    const { backend, host } = fixture();
    expect(await host.handle(request('session-a', 'activate', payload))).toMatchObject({
      ok: false,
      code: 'invalid_request',
    });
    expect(backend.activate).not.toHaveBeenCalled();
  });

  it('accepts verified and quick-tunnel remote confirmation metadata', async () => {
    const verified = fixture();
    const unavailable = fixture();
    expect(
      await verified.host.handle(
        request('session-a', 'activate', {
          ...activation(),
          caller: { locality: 'remote', deviceId: 'device-1', stepUp: 'verified' },
        }),
      ),
    ).toMatchObject({ ok: true });
    expect(
      await unavailable.host.handle(
        request('session-a', 'activate', {
          ...activation(),
          caller: { locality: 'remote', deviceId: 'device-1', stepUp: 'unavailable' },
        }),
      ),
    ).toMatchObject({ ok: true });
  });

  it('requires and honors native Desktop confirmation for local activation', async () => {
    const deniedConfirmation = vi.fn(async () => false);
    const { backend, host } = fixture(deniedConfirmation);

    expect(await host.handle(request('session-a', 'activate', activation()))).toMatchObject({
      ok: false,
      code: 'confirmation_denied',
    });
    expect(deniedConfirmation).toHaveBeenCalledWith({
      applicationName: 'Fixture',
      windowTitle: 'Fixture Window',
      durationSeconds: 60,
    });
    expect(backend.activate).not.toHaveBeenCalled();
  });
  it('executes only validated semantic actions in sequence', async () => {
    const { backend, host } = fixture();
    await host.handle(request('session-a', 'activate', activation()));
    const actions = [
      { kind: 'press', snapshotId: 'snapshot-1', elementRef: 'button-1' },
      { kind: 'set_value', snapshotId: 'snapshot-2', elementRef: 'field-1', value: '' },
      {
        kind: 'scroll',
        snapshotId: 'snapshot-3',
        elementRef: 'list-1',
        direction: 'down',
        amount: 'page',
      },
    ];
    for (const [index, action] of actions.entries()) {
      expect(
        await host.handle(request('session-a', 'act', { grantId: 'id-1', sequence: index + 1, action })),
      ).toMatchObject({ ok: true });
    }
    expect(backend.act).toHaveBeenCalledTimes(3);
  });

  it('reports native status and target enumeration', async () => {
    const { host } = fixture();
    expect(await host.handle(request('session-a', 'status'))).toMatchObject({ ok: true, result: { busy: false } });
    expect(await host.handle(request('session-a', 'targets'))).toMatchObject({ ok: true });
  });

  it('rejects cross-session observation and stale action sequences', async () => {
    const { host } = fixture();
    await host.handle(request('session-a', 'activate', activation()));

    const foreign = await host.handle(request('session-b', 'observe', { grantId: 'id-1' }));
    expect(foreign).toMatchObject({ ok: false });

    const stale = await host.handle(request('session-a', 'act', { grantId: 'id-1', sequence: 2 }));
    expect(stale).toMatchObject({ ok: false, code: 'stale_request' });
  });

  it('rejects coordinate and unsupported action fields before reaching the backend', async () => {
    const { backend, host } = fixture();
    await host.handle(request('session-a', 'activate', activation()));

    const result = await host.handle(
      request('session-a', 'act', {
        grantId: 'id-1',
        sequence: 1,
        action: { kind: 'press', snapshotId: 'snapshot-1', elementRef: 'button-1', x: 10, y: 20 },
      }),
    );

    expect(result).toMatchObject({ ok: false, code: 'invalid_request' });
    expect(backend.act).not.toHaveBeenCalled();
  });
  it('expires and revokes the active grant before reporting status', async () => {
    const { backend, host, advance } = fixture();
    await host.handle(request('session-a', 'activate', activation(1)));
    advance(1001);

    const status = await host.handle(request('session-a', 'status'));
    expect(status).toMatchObject({ ok: true, result: { busy: false } });
    expect(backend.stop).toHaveBeenCalledWith(expect.objectContaining({ reason: 'expired' }));
  });

  it('revokes an expired grant without waiting for another request', async () => {
    vi.useFakeTimers();
    try {
      const { backend, host, advance } = fixture();
      await host.handle(request('session-a', 'activate', activation(1)));
      advance(1001);
      await vi.advanceTimersByTimeAsync(1001);

      expect(backend.stop).toHaveBeenCalledWith(expect.objectContaining({ reason: 'expired' }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not execute a request cancelled before it reaches the host queue', async () => {
    const { backend, host } = fixture();
    const controller = new AbortController();
    controller.abort();

    const result = await host.handle(request('session-a', 'targets'), controller.signal);

    expect(result).toMatchObject({ ok: false, code: 'request_cancelled' });
    expect(backend.targets).not.toHaveBeenCalled();
  });

  it('stops an activation that completes after host revocation without relying on cancellation', async () => {
    const { backend, host } = fixture();
    let finishActivation: (() => void) | undefined;
    vi.mocked(backend.activate).mockImplementation(
      async () =>
        await new Promise<{ recording: boolean }>((resolve) => {
          finishActivation = () => resolve({ recording: true });
        }),
    );
    const pending = host.handle(request('session-a', 'activate', activation()));
    await vi.waitFor(() => expect(finishActivation).toBeTypeOf('function'));

    await host.revoke('hub_disconnected');
    finishActivation?.();

    expect(await pending).toMatchObject({ ok: false, code: 'request_cancelled' });
    expect(backend.stop).toHaveBeenCalledWith(expect.objectContaining({ reason: 'request_cancelled' }));
  });

  it('supports an idempotent Desktop emergency stop without revoking the host', async () => {
    const { backend, host } = fixture();
    await host.handle(request('session-a', 'activate', activation()));

    expect(await host.stopActive()).toBe(true);
    expect(await host.stopActive()).toBe(false);
    expect(backend.stop).toHaveBeenCalledTimes(1);
    expect(backend.stop).toHaveBeenCalledWith(expect.objectContaining({ reason: 'desktop_emergency_stop' }));
    expect(await host.handle(request('session-a', 'status'))).toMatchObject({
      ok: true,
      result: { busy: false },
    });
  });

  it('keeps the host usable after emergency stop finalization fails', async () => {
    const { backend, host } = fixture();
    await host.handle(request('session-a', 'activate', activation()));
    vi.mocked(backend.stop).mockRejectedValueOnce(new Error('recorder failed'));

    await expect(host.stopActive()).rejects.toThrow('recorder failed');
    expect(await host.handle(request('session-a', 'status'))).toMatchObject({
      ok: true,
      result: { busy: false },
    });
  });

  it('revokes on host disconnect', async () => {
    const { backend, host } = fixture();
    await host.handle(request('session-a', 'activate', activation()));
    await host.revoke('hub_disconnected');

    expect(backend.stop).toHaveBeenCalledWith(expect.objectContaining({ reason: 'hub_disconnected' }));
    expect(await host.handle(request('session-a', 'status'))).toMatchObject({ ok: false, code: 'desktop_unavailable' });
  });
});
