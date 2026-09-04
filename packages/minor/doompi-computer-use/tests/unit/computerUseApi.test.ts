import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DOOM_API_CALLER_DEVICE_ID_HEADER,
  DOOM_API_CALLER_LOCALITY_HEADER,
  DOOM_API_CALLER_STEP_UP_HEADER,
} from '@agimon-ai/doompi-extension-contracts/package-api';
import { assertDeclaredApi } from '@agimon-ai/doompi-extension-contracts/testing';
import { describe, expect, it } from 'vitest';
import { api, createComputerUseApi } from '../../src/adapters/computerUseApi.ts';
import { API_BASE_PATH, COMPUTER_USE_ROUTES } from '../../src/types/computerUseApi.ts';

const PACKAGE_ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const internal = { authorization: 'Bearer internal' };
const hub = { authorization: 'Bearer hub' };
const local = { [DOOM_API_CALLER_LOCALITY_HEADER]: 'local', [DOOM_API_CALLER_STEP_UP_HEADER]: 'not-required' };
const request = (route: string, method: 'GET' | 'POST', headers: Record<string, string>, value?: unknown) =>
  new Request(`http://host${route}`, {
    method,
    headers,
    ...(value === undefined ? {} : { body: JSON.stringify(value) }),
  });

describe('computer-use request broker', () => {
  it('separates agent and hub routes with context tokens', async () => {
    const broker = createComputerUseApi({ sessionId: 's1', internalToken: 'internal', hubToken: 'hub' });
    expect((await broker.fetch(request(COMPUTER_USE_ROUTES.agentState, 'GET', hub))).status).toBe(404);
    expect((await broker.fetch(request(COMPUTER_USE_ROUTES.hubState, 'GET', internal))).status).toBe(404);
  });

  it('admits activation only through trusted caller metadata and keeps grantId opaque', async () => {
    const broker = createComputerUseApi({ sessionId: 's1', internalToken: 'internal', hubToken: 'hub' });
    const value = { target: { windowId: 'w1', bundleId: 'app.fixture' }, durationMs: 60_000 };
    expect((await broker.fetch(request(COMPUTER_USE_ROUTES.activate, 'POST', {}, value))).status).toBe(404);
    const accepted = await broker.fetch(request(COMPUTER_USE_ROUTES.activate, 'POST', local, value));
    expect(await accepted.json()).toMatchObject({
      phase: 'awaiting_confirmation',
      target: value.target,
      durationMs: 60_000,
    });

    const activation = await (await broker.fetch(request(COMPUTER_USE_ROUTES.hubActivation, 'GET', hub))).json();
    expect(activation).toMatchObject({ target: value.target, caller: { locality: 'local' } });
    await broker.fetch(
      request(COMPUTER_USE_ROUTES.hubStop, 'POST', hub, {
        host: { grantId: 'secret-grant', expiresAt: Date.now() + 60_000 },
      }),
    );
    expect(JSON.stringify(broker.state())).not.toContain('secret-grant');
  });

  it('enforces one live request and monotonic act sequences starting at one', async () => {
    const broker = createComputerUseApi({ sessionId: 's1', internalToken: 'internal', hubToken: 'hub' });
    const value = { target: { windowId: 'w1', bundleId: 'app.fixture' }, durationMs: 60_000 };
    await broker.fetch(request(COMPUTER_USE_ROUTES.activate, 'POST', local, value));
    await broker.fetch(request(COMPUTER_USE_ROUTES.hubActivation, 'GET', hub));
    await broker.fetch(
      request(COMPUTER_USE_ROUTES.hubStop, 'POST', hub, {
        host: { grantId: 'grant-1', expiresAt: Date.now() + 60_000 },
      }),
    );

    expect(
      (
        await broker.fetch(
          request(COMPUTER_USE_ROUTES.agentAction, 'POST', internal, {
            kind: 'press',
            snapshotId: 'snapshot-1',
            elementRef: 'button-1',
            x: 10,
          }),
        )
      ).status,
    ).toBe(400);
    const action = broker.fetch(
      request(COMPUTER_USE_ROUTES.agentAction, 'POST', internal, {
        kind: 'press',
        snapshotId: 'snapshot-1',
        elementRef: 'button-1',
      }),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect((await broker.fetch(request(COMPUTER_USE_ROUTES.agentObserve, 'POST', internal, {}))).status).toBe(409);
    const pending = (await (await broker.fetch(request(COMPUTER_USE_ROUTES.hubNext, 'GET', hub))).json()) as {
      id: string;
      grantId: string;
      sequence: number;
    };
    expect(pending).toMatchObject({ grantId: 'grant-1', sequence: 1 });
    await broker.fetch(request(COMPUTER_USE_ROUTES.hubComplete, 'POST', hub, { id: pending.id, result: { ok: true } }));
    expect(await (await action).json()).toEqual({ ok: true });

    for (const [sequence, semantic] of [
      [2, { kind: 'set_value', snapshotId: 'snapshot-2', elementRef: 'field-1', value: 'value' }],
      [
        3,
        {
          kind: 'scroll',
          snapshotId: 'snapshot-3',
          elementRef: 'list-1',
          direction: 'down',
          amount: 'page',
        },
      ],
    ] as const) {
      const pendingAction = broker.fetch(request(COMPUTER_USE_ROUTES.agentAction, 'POST', internal, semantic));
      await new Promise<void>((resolve) => setImmediate(resolve));
      const next = (await (await broker.fetch(request(COMPUTER_USE_ROUTES.hubNext, 'GET', hub))).json()) as {
        id: string;
        sequence: number;
      };
      expect(next.sequence).toBe(sequence);
      await broker.fetch(request(COMPUTER_USE_ROUTES.hubComplete, 'POST', hub, { id: next.id, result: {} }));
      expect((await pendingAction).status).toBe(200);
    }
  });

  it('accepts the paired quick-tunnel fallback but rejects unstamped remote activation', async () => {
    const value = { target: { windowId: 'w1', bundleId: 'app.fixture' }, durationMs: 60_000 };
    const unavailable = {
      [DOOM_API_CALLER_LOCALITY_HEADER]: 'remote',
      [DOOM_API_CALLER_DEVICE_ID_HEADER]: 'device-1',
      [DOOM_API_CALLER_STEP_UP_HEADER]: 'unavailable',
    };
    const unstamped = { ...unavailable, [DOOM_API_CALLER_STEP_UP_HEADER]: 'not-required' };
    const accepted = createComputerUseApi();
    const rejected = createComputerUseApi();

    expect((await accepted.fetch(request(COMPUTER_USE_ROUTES.activate, 'POST', unavailable, value))).status).toBe(202);
    expect((await rejected.fetch(request(COMPUTER_USE_ROUTES.activate, 'POST', unstamped, value))).status).toBe(404);
  });

  it('validates activation bounds and records Desktop activation failure', async () => {
    const broker = createComputerUseApi({ hubToken: 'hub' });
    expect(
      (await broker.fetch(request(COMPUTER_USE_ROUTES.activate, 'POST', local, { target: {}, durationMs: 60_000 })))
        .status,
    ).toBe(400);
    expect(
      (
        await broker.fetch(
          request(COMPUTER_USE_ROUTES.activate, 'POST', local, {
            target: { windowId: 'w1', bundleId: 'app.fixture' },
            durationMs: 1_800_001,
          }),
        )
      ).status,
    ).toBe(400);

    const value = { target: { windowId: 'w1', bundleId: 'app.fixture' }, durationMs: 60_000 };
    await broker.fetch(request(COMPUTER_USE_ROUTES.activate, 'POST', local, value));
    expect((await broker.fetch(request(COMPUTER_USE_ROUTES.activate, 'POST', local, value))).status).toBe(409);
    await broker.fetch(request(COMPUTER_USE_ROUTES.hubActivation, 'GET', hub));
    await broker.fetch(request(COMPUTER_USE_ROUTES.hubStop, 'POST', hub, { error: 'Desktop unavailable' }));
    expect(broker.state()).toMatchObject({
      phase: 'failed',
      failure: { code: 'desktop_unavailable', message: 'Desktop unavailable' },
    });
  });

  it('sanitizes completed artifacts and closes pending agent requests', async () => {
    const broker = createComputerUseApi({ internalToken: 'internal', hubToken: 'hub' });
    const value = { target: { windowId: 'w1', bundleId: 'app.fixture' }, durationMs: 60_000 };
    await broker.fetch(request(COMPUTER_USE_ROUTES.activate, 'POST', local, value));
    await broker.fetch(request(COMPUTER_USE_ROUTES.hubActivation, 'GET', hub));
    await broker.fetch(
      request(COMPUTER_USE_ROUTES.hubStop, 'POST', hub, {
        host: { grantId: 'grant-1', expiresAt: Date.now() + 60_000 },
      }),
    );
    expect((await broker.fetch(request(COMPUTER_USE_ROUTES.agentStop, 'POST', internal))).status).toBe(202);
    await broker.fetch(
      request(COMPUTER_USE_ROUTES.hubStop, 'POST', hub, {
        artifact: {
          artifactId: 'artifact-1',
          status: 'ready',
          downloadUrl: 'file:///private/recording.mov',
          previewUrl: '/api/plugin/computer-use/artifacts/artifact-1',
          actionCount: 2,
        },
      }),
    );
    expect(broker.state()).toMatchObject({
      phase: 'inactive',
      artifact: { artifactId: 'artifact-1', previewUrl: '/api/plugin/computer-use/artifacts/artifact-1' },
    });
    expect(JSON.stringify(broker.state())).not.toContain('file:///');

    expect((await broker.fetch(request('/unknown', 'GET', {}))).status).toBe(404);
    broker.close();
    expect((await broker.fetch(request(COMPUTER_USE_ROUTES.hubState, 'GET', hub))).status).toBe(503);
  });

  it('rejects stale hub completions and propagates one host error to the agent', async () => {
    const broker = createComputerUseApi({ internalToken: 'internal', hubToken: 'hub' });
    const value = { target: { windowId: 'w1', bundleId: 'app.fixture' }, durationMs: 60_000 };
    expect(await (await broker.fetch(request(COMPUTER_USE_ROUTES.hubActivation, 'GET', hub))).json()).toBeNull();
    expect(await (await broker.fetch(request(COMPUTER_USE_ROUTES.hubAuthorization, 'GET', hub))).json()).toBeNull();
    await broker.fetch(request(COMPUTER_USE_ROUTES.activate, 'POST', local, value));
    await broker.fetch(request(COMPUTER_USE_ROUTES.hubActivation, 'GET', hub));
    expect((await broker.fetch(request(COMPUTER_USE_ROUTES.hubStop, 'POST', hub, { host: {} }))).status).toBe(502);
    await broker.fetch(
      request(COMPUTER_USE_ROUTES.hubStop, 'POST', hub, {
        host: { grantId: 'grant-1', expiresAt: Date.now() + 60_000 },
      }),
    );

    const action = broker.fetch(
      request(COMPUTER_USE_ROUTES.agentAction, 'POST', internal, {
        kind: 'press',
        snapshotId: 'snapshot-1',
        elementRef: 'button-1',
      }),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    const pending = (await (await broker.fetch(request(COMPUTER_USE_ROUTES.hubNext, 'GET', hub))).json()) as {
      id: string;
    };
    expect((await broker.fetch(request(COMPUTER_USE_ROUTES.hubComplete, 'POST', hub, { id: 'wrong' }))).status).toBe(
      409,
    );
    await broker.fetch(request(COMPUTER_USE_ROUTES.hubComplete, 'POST', hub, { id: pending.id, error: 'failed' }));
    expect((await action).status).toBe(502);
  });

  it('treats malformed JSON and invalid artifact metadata as untrusted input', async () => {
    const broker = createComputerUseApi({ hubToken: 'hub' });
    const malformed = new Request(`http://host${COMPUTER_USE_ROUTES.activate}`, {
      method: 'POST',
      headers: local,
      body: '{',
    });
    expect((await broker.fetch(malformed)).status).toBe(400);

    const value = { target: { windowId: 'w1', bundleId: 'app.fixture' }, durationMs: 60_000 };
    await broker.fetch(request(COMPUTER_USE_ROUTES.activate, 'POST', local, value));
    await broker.fetch(request(COMPUTER_USE_ROUTES.hubActivation, 'GET', hub));
    await broker.fetch(request(COMPUTER_USE_ROUTES.hubStop, 'POST', hub, { error: 'unavailable' }));
    await broker.fetch(request(COMPUTER_USE_ROUTES.hubStop, 'POST', hub, { artifact: { artifactId: 'bad' } }));
    expect(broker.state().artifact).toBeUndefined();
  });
});
describe('computer-use package API declaration', () => {
  it('declares the exact session mount used by the remote gate', () => {
    expect(assertDeclaredApi({ packageRoot: PACKAGE_ROOT, api, scope: 'session' })).toMatchObject({
      basePath: API_BASE_PATH,
    });
  });
});
