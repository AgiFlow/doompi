import type { HubSessionScope } from '@agimon-ai/doompi-web-contracts';
import { describe, expect, it, vi } from 'vitest';
import { createVoiceMediaApi } from '../src/adapters/clientMediaApi.ts';
import {
  createTransferVoiceToolLifecycle,
  reconcileTransferVoiceTool,
  registerTransferVoiceTool,
} from '../src/adapters/pi/transferVoiceTool.ts';
import {
  registerSessionVoiceOwnership,
  SessionVoiceOwnership,
  sessionVoiceOwnership,
} from '../src/services/sessionVoiceOwnership.ts';
import { VoiceOwnershipCoordinator } from '../src/services/voiceOwnershipCoordinator.ts';
import {
  VOICE_OWNERSHIP_PROTOCOL_VERSION,
  parseBrowserVoiceOwnershipPayload,
  parseVoiceOwnershipAcknowledgement,
  parseVoiceOwnershipCommand,
  parseVoiceOwnershipRegistration,
  parseVoiceOwnershipTransferRequest,
  parseVoiceOwnershipView,
  type VoiceOwnershipAcknowledgement,
  type VoiceOwnershipCommand,
  type VoiceOwnershipRegistration,
} from '../src/types/voiceOwnership.ts';

const source: HubSessionScope = { sessionId: 'raw-source-id', cwd: '/private/source/path' };
const target: HubSessionScope = { sessionId: 'raw-target-id', cwd: '/private/target/path' };
const EPOCH = 'epoch-a';
const ownershipClock = {
  setTimeout: (callback: () => void, milliseconds: number) => setTimeout(callback, milliseconds),
  clear: (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle),
};
function registration(leaseId: string, label: string, active: boolean): VoiceOwnershipRegistration {
  return { version: 1, leaseId, revision: 1, label, eligible: true, active, requiresBrowserBind: true };
}
function acknowledgement(command: VoiceOwnershipCommand, ok = true): VoiceOwnershipAcknowledgement {
  return {
    version: 1,
    epoch: command.epoch,
    generation: command.generation,
    revision: command.revision,
    phase: command.phase,
    ok,
    ...((command.phase === 'activate' || command.phase === 'resume') && ok ? { listening: true } : {}),
  };
}

describe('voice ownership protocol', () => {
  it('accepts only strict bounded versioned declarations and catalogs', () => {
    expect(parseVoiceOwnershipRegistration(registration('lease-a', 'Project A', true))).toBeDefined();
    expect(
      parseVoiceOwnershipRegistration({ ...registration('lease-a', 'Project A', true), sessionId: 'secret' }),
    ).toBeUndefined();
    expect(parseVoiceOwnershipRegistration({ ...registration('lease-a', 'x'.repeat(81), true) })).toBeUndefined();
    expect(
      parseVoiceOwnershipCommand({
        version: 2,
        epoch: EPOCH,
        generation: 1,
        revision: 1,
        phase: 'prepare',
        source: true,
      }),
    ).toBeUndefined();
    expect(
      parseVoiceOwnershipView({
        version: 1,
        epoch: EPOCH,
        generation: 1,
        revision: 1,
        owner: true,
        transaction: false,
        targets: [{ handle: 'opaque', label: 'Target' }],
      }),
    ).toBeDefined();
    expect(parseBrowserVoiceOwnershipPayload({ type: 'browser-media-runtime', version: 1 })).toBeDefined();
    expect(
      parseBrowserVoiceOwnershipPayload({ type: 'browser-media-runtime', version: 1, extra: true }),
    ).toBeUndefined();
    const browserCommand = {
      type: 'browser-media-command',
      version: 1,
      epoch: EPOCH,
      generation: 1,
      revision: 2,
      action: 'attach',
    };
    expect(parseBrowserVoiceOwnershipPayload(browserCommand)).toEqual(browserCommand);
    for (const invalid of [
      null,
      { ...browserCommand, version: 2 },
      { ...browserCommand, type: 4 },
      { ...browserCommand, type: 'unknown' },
      { ...browserCommand, generation: -1 },
      { ...browserCommand, revision: 1.5 },
      { ...browserCommand, action: 'start' },
      { ...browserCommand, extra: true },
      { ...browserCommand, type: 'browser-media-ack', ok: 'yes' },
      { ...browserCommand, type: 'browser-media-ack', ok: true, listening: 'yes' },
      { ...browserCommand, type: 'browser-media-ack', ok: false, error: 'x'.repeat(301) },
    ])
      expect(parseBrowserVoiceOwnershipPayload(invalid)).toBeUndefined();
  });
});

describe('voice ownership coordinator', () => {
  it('uses opaque source-bound handles and commits only after listening acknowledgement', async () => {
    const commands: Array<{ sessionId: string; phase: string }> = [];
    const coordinator = new VoiceOwnershipCoordinator({
      clock: ownershipClock,
      now: () => 0,
      send: async (scope, command) => {
        commands.push({ sessionId: scope.sessionId, phase: command.phase });
        return acknowledgement(command);
      },
    });
    coordinator.update(source, registration('lease-source', 'Source project', true));
    coordinator.update(target, registration('lease-target', 'Target project', false));
    await Promise.resolve();
    const catalog = coordinator.view(source.sessionId);
    expect(catalog.owner).toBe(true);
    expect(catalog.targets).toHaveLength(1);
    expect(JSON.stringify(catalog.targets)).not.toContain(source.sessionId);
    expect(JSON.stringify(catalog.targets)).not.toContain(target.sessionId);
    expect(JSON.stringify(catalog.targets)).not.toContain(target.cwd);
    await expect(coordinator.transfer(source.sessionId, catalog.targets[0]!.handle)).resolves.toBe(true);
    expect(coordinator.view(target.sessionId).owner).toBe(true);
    expect(commands.map((entry) => entry.phase)).toEqual(
      expect.arrayContaining(['prepare', 'quiesce', 'activate', 'commit']),
    );
  });

  it('rolls back and resumes the source when activation is not safely acknowledged', async () => {
    const phases: string[] = [];
    const coordinator = new VoiceOwnershipCoordinator({
      clock: ownershipClock,
      now: () => 0,
      send: async (_scope, command) => {
        phases.push(command.phase);
        return acknowledgement(command, command.phase !== 'activate');
      },
    });
    coordinator.update(source, registration('lease-source', 'Source', true));
    coordinator.update(target, registration('lease-target', 'Target', false));
    await Promise.resolve();
    const handle = coordinator.view(source.sessionId).targets[0]!.handle;
    await expect(coordinator.transfer(source.sessionId, handle)).resolves.toBe(false);
    expect(coordinator.view(source.sessionId).owner).toBe(true);
    expect(phases).toContain('abort');
    expect(phases).toContain('resume');
    expect(phases.filter((phase) => phase === 'commit')).toHaveLength(0);
  });

  it.each(['rejected', 'timed out'] as const)('leaves ownership unset when source resume is %s', async (outcome) => {
    const coordinator = new VoiceOwnershipCoordinator({
      clock: ownershipClock,
      now: () => 0,
      stepTimeoutMs: 10,
      send: async (_scope, command) => {
        if (command.phase === 'activate') return acknowledgement(command, false);
        if (command.phase === 'resume') {
          if (outcome === 'rejected') return acknowledgement(command, false);
          return await new Promise<never>(() => undefined);
        }
        return acknowledgement(command);
      },
    });
    coordinator.update(source, registration('lease-source', 'Source', true));
    coordinator.update(target, registration('lease-target', 'Target', false));
    await Promise.resolve();

    await expect(
      coordinator.transfer(source.sessionId, coordinator.view(source.sessionId).targets[0]!.handle),
    ).resolves.toBe(false);
    expect(coordinator.view(source.sessionId).owner).toBe(false);
  });

  it('does not reverse browser media when target preparation fails before rebinding', async () => {
    const rebindMedia = vi.fn(async () => undefined);
    const coordinator = new VoiceOwnershipCoordinator({
      clock: ownershipClock,
      now: () => 0,
      rebindMedia,
      send: async (scope, command) =>
        acknowledgement(command, !(scope.sessionId === target.sessionId && command.phase === 'prepare')),
    });
    coordinator.update(source, registration('lease-source', 'Source', true));
    coordinator.update(target, registration('lease-target', 'Target', false));
    await Promise.resolve();

    await expect(
      coordinator.transfer(source.sessionId, coordinator.view(source.sessionId).targets[0]!.handle),
    ).resolves.toBe(false);
    expect(rebindMedia).not.toHaveBeenCalled();
  });

  it('restores media after a partial rebind attempt fails', async () => {
    const rebindMedia = vi
      .fn<NonNullable<ConstructorParameters<typeof VoiceOwnershipCoordinator>[0]['rebindMedia']>>()
      .mockRejectedValueOnce(new Error('attach failed'))
      .mockResolvedValue(undefined);
    const coordinator = new VoiceOwnershipCoordinator({
      clock: ownershipClock,
      now: () => 0,
      rebindMedia,
      send: async (_scope, command) => acknowledgement(command),
    });
    coordinator.update(source, registration('lease-source', 'Source', true));
    coordinator.update(target, registration('lease-target', 'Target', false));
    await Promise.resolve();

    await expect(
      coordinator.transfer(source.sessionId, coordinator.view(source.sessionId).targets[0]!.handle),
    ).resolves.toBe(false);
    expect(rebindMedia).toHaveBeenNthCalledWith(
      1,
      source,
      target,
      expect.any(String),
      expect.any(Number),
      expect.anything(),
    );
    expect(rebindMedia).toHaveBeenNthCalledWith(
      2,
      target,
      source,
      expect.any(String),
      expect.any(Number),
      expect.anything(),
    );
  });

  it('cancels a pending forward media rebind before reversing it after removal', async () => {
    let forwardAborted = false;
    const rebindMedia = vi.fn(
      async (
        _source: HubSessionScope,
        _target: HubSessionScope,
        _epoch: string,
        _generation: number,
        signal?: AbortSignal,
      ) => {
        if (rebindMedia.mock.calls.length !== 1) return;
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener(
            'abort',
            () => {
              forwardAborted = true;
              reject(new Error('forward rebind aborted'));
            },
            { once: true },
          );
        });
      },
    );
    const coordinator = new VoiceOwnershipCoordinator({
      clock: ownershipClock,
      now: () => 0,
      rebindMedia,
      send: async (_scope, command) => acknowledgement(command),
    });
    coordinator.update(source, registration('lease-source', 'Source', true));
    coordinator.update(target, registration('lease-target', 'Target', false));
    await Promise.resolve();

    const transfer = coordinator.transfer(source.sessionId, coordinator.view(source.sessionId).targets[0]!.handle);
    await vi.waitFor(() => expect(rebindMedia).toHaveBeenCalledTimes(1));
    coordinator.remove(source.sessionId);
    await expect(transfer).resolves.toBe(false);
    expect(forwardAborted).toBe(true);
    expect(rebindMedia).toHaveBeenNthCalledWith(
      2,
      target,
      source,
      expect.any(String),
      expect.any(Number),
      expect.anything(),
    );
  });

  it('bounds rollback when removal interrupts a phase that never resolves', async () => {
    let activationStarted = false;
    const coordinator = new VoiceOwnershipCoordinator({
      clock: ownershipClock,
      now: () => 0,
      stepTimeoutMs: 25,
      send: async (scope, command) => {
        if (scope.sessionId === target.sessionId && command.phase === 'activate') {
          activationStarted = true;
          return await new Promise<never>(() => undefined);
        }
        return acknowledgement(command);
      },
    });
    coordinator.update(source, registration('lease-source', 'Source', true));
    coordinator.update(target, registration('lease-target', 'Target', false));
    await Promise.resolve();

    const transfer = coordinator.transfer(source.sessionId, coordinator.view(source.sessionId).targets[0]!.handle);
    await vi.waitFor(() => expect(activationStarted).toBe(true));
    coordinator.remove(target.sessionId);

    await expect(transfer).resolves.toBe(false);
    expect(coordinator.view(source.sessionId).owner).toBe(true);
  });
  it('aborts the target and restores media when the source disappears after activation', async () => {
    const phases: Array<{ sessionId: string; phase: string }> = [];
    const rebindMedia = vi.fn(async () => undefined);
    let coordinator: VoiceOwnershipCoordinator;
    coordinator = new VoiceOwnershipCoordinator({
      clock: ownershipClock,
      now: () => 0,
      rebindMedia,
      send: async (scope, command) => {
        phases.push({ sessionId: scope.sessionId, phase: command.phase });
        if (scope.sessionId === target.sessionId && command.phase === 'activate') coordinator.remove(source.sessionId);
        return acknowledgement(command);
      },
    });
    coordinator.update(source, registration('lease-source', 'Source', true));
    coordinator.update(target, registration('lease-target', 'Target', false));
    await Promise.resolve();

    await expect(
      coordinator.transfer(source.sessionId, coordinator.view(source.sessionId).targets[0]!.handle),
    ).resolves.toBe(false);
    await vi.waitFor(() => expect(phases).toContainEqual({ sessionId: target.sessionId, phase: 'abort' }));
    expect(rebindMedia).toHaveBeenNthCalledWith(
      1,
      source,
      target,
      expect.any(String),
      expect.any(Number),
      expect.anything(),
    );
    expect(rebindMedia).toHaveBeenNthCalledWith(
      2,
      target,
      source,
      expect.any(String),
      expect.any(Number),
      expect.anything(),
    );
    expect(coordinator.view(source.sessionId).owner).toBe(false);
    expect(coordinator.view(target.sessionId).owner).toBe(false);
  });
  it('rejects stale acknowledgements and rolls back', async () => {
    const coordinator = new VoiceOwnershipCoordinator({
      clock: ownershipClock,
      now: () => 0,
      send: async (_scope, command) => ({ ...acknowledgement(command), revision: Math.max(0, command.revision - 1) }),
    });
    coordinator.update(source, registration('lease-source', 'Source', true));
    coordinator.update(target, registration('lease-target', 'Target', false));
    await Promise.resolve();
    await expect(
      coordinator.transfer(source.sessionId, coordinator.view(source.sessionId).targets[0]!.handle),
    ).resolves.toBe(false);
    expect(coordinator.view(source.sessionId).owner).toBe(false);
  });

  it('expires leases, removes owners, and rejects unknown or cross-source handles', async () => {
    let now = 0;
    const sent: string[] = [];
    const coordinator = new VoiceOwnershipCoordinator({
      clock: ownershipClock,
      now: () => now,
      leaseMs: 10,
      send: async (scope, command) => {
        sent.push(scope.sessionId);
        return acknowledgement(command);
      },
    });
    expect(await coordinator.transfer(source.sessionId, 'missing')).toBe(false);
    coordinator.update(source, registration('lease-source', 'Source', true));
    coordinator.update(target, registration('lease-target', 'Target', false));
    const handle = coordinator.view(source.sessionId).targets[0]!.handle;
    expect(await coordinator.transfer(target.sessionId, handle)).toBe(false);
    coordinator.remove(target.sessionId);
    expect(coordinator.view(source.sessionId).targets).toHaveLength(0);
    coordinator.update(target, registration('lease-target-2', 'Target', false));
    now = 11;
    expect(coordinator.view(source.sessionId).owner).toBe(false);
    coordinator.remove(source.sessionId);
    expect(sent.length).toBeGreaterThan(0);
  });
});

describe('voice ownership session API and tool', () => {
  it('keeps hub ownership routes hidden from other callers', async () => {
    const api = createVoiceMediaApi({ internalToken: 'internal', hubToken: 'hub' });
    const url = `http://voice.test/hub/ownership/state`;
    expect((await api.fetch(new Request(url))).status).toBe(404);
    expect((await api.fetch(new Request(url, { headers: { authorization: 'Bearer internal' } }))).status).toBe(404);
    expect((await api.fetch(new Request(url, { headers: { authorization: 'Bearer hub' } }))).status).toBe(200);
    api.close();
  });

  it('shows transfer_voice only to an unblocked owner with an eligible opaque target', async () => {
    const controller = {
      state: 'active' as const,
      prepareVoiceTransfer: vi.fn(async () => undefined),
      quiesceVoiceTransfer: vi.fn(async () => undefined),
      activateVoiceTransfer: vi.fn(async () => undefined),
      abortVoiceTransfer: vi.fn(async () => undefined),
      resumeVoiceTransfer: vi.fn(async () => undefined),
    };
    const dispose = registerSessionVoiceOwnership({
      label: 'Source',
      eligible: true,
      requiresBrowserBind: true,
      controller,
    });
    await sessionVoiceOwnership.command({
      version: VOICE_OWNERSHIP_PROTOCOL_VERSION,
      epoch: EPOCH,
      generation: 8,
      revision: 2,
      phase: 'prepare',
      source: true,
      catalog: {
        version: 1,
        epoch: EPOCH,
        generation: 8,
        revision: 2,
        owner: true,
        transaction: false,
        targets: [{ handle: 'opaque-target', label: 'Target project' }],
      },
    });
    const registered = new Map<
      string,
      { description?: string; execute?: (...args: unknown[]) => Promise<{ details?: unknown } | undefined> }
    >();
    let active: string[] = [];
    const pi = {
      registerTool: (tool: unknown) => {
        const candidate = tool as {
          name: string;
          description?: string;
          execute?: (...args: unknown[]) => Promise<{ details?: unknown } | undefined>;
        };
        registered.set(candidate.name, candidate);
      },
      getActiveTools: () => active,
      setActiveTools: (next: string[]) => {
        active = next;
      },
    };
    registerTransferVoiceTool(pi as never);
    reconcileTransferVoiceTool(pi as never);
    expect(active).toContain('transfer_voice');
    expect(registered.get('transfer_voice')?.description).toContain('opaque-target');
    expect(registered.get('transfer_voice')?.description).not.toContain('/private/');
    const execute = registered.get('transfer_voice')?.execute;
    await expect(execute?.('call', { target: 1 }, undefined, undefined, {})).resolves.toMatchObject({
      details: { accepted: false },
    });
    await expect(execute?.('call', { target: 'opaque-target' }, undefined, undefined, {})).resolves.toMatchObject({
      details: { accepted: true },
    });
    await sessionVoiceOwnership.command({
      version: 1,
      epoch: EPOCH,
      generation: 9,
      revision: 1,
      phase: 'prepare',
      source: true,
      catalog: { version: 1, epoch: EPOCH, generation: 9, revision: 1, owner: true, transaction: true, targets: [] },
    });
    reconcileTransferVoiceTool(pi as never);
    expect(active).not.toContain('transfer_voice');
    dispose();
  });

  it('defers active-tool APIs until session start and disposes its refresh timer', () => {
    vi.useFakeTimers();
    try {
      let initialized = false;
      const getActiveTools = vi.fn(() => {
        if (!initialized) throw new Error('Extension runtime not initialized');
        return [];
      });
      const lifecycle = createTransferVoiceToolLifecycle({
        registerTool: vi.fn(),
        getActiveTools,
        setActiveTools: vi.fn(),
      } as never);

      expect(getActiveTools).not.toHaveBeenCalled();
      initialized = true;
      lifecycle.sessionStarted();
      expect(getActiveTools).toHaveBeenCalledOnce();
      vi.advanceTimersByTime(2_000);
      expect(getActiveTools).toHaveBeenCalledTimes(3);
      lifecycle.dispose();
      vi.advanceTimersByTime(2_000);
      expect(getActiveTools).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('voice ownership guards and session command lifecycle', () => {
  it('rejects malformed values at every bounded protocol boundary', () => {
    const validRegistration = registration('lease', 'Label', false);
    for (const value of [
      null,
      [],
      'x',
      { ...validRegistration, version: 2 },
      { ...validRegistration, leaseId: '' },
      { ...validRegistration, leaseId: 'bad id' },
      { ...validRegistration, revision: -1 },
      { ...validRegistration, label: 1 },
      { ...validRegistration, label: '' },
      { ...validRegistration, eligible: 'yes' },
      { ...validRegistration, active: 1 },
      { ...validRegistration, requiresBrowserBind: 1 },
    ])
      expect(parseVoiceOwnershipRegistration(value)).toBeUndefined();
    const validView = {
      version: 1,
      epoch: EPOCH,
      generation: 1,
      revision: 1,
      owner: true,
      transaction: false,
      targets: [{ handle: 'opaque', label: 'Target' }],
    };
    for (const value of [
      null,
      { ...validView, extra: true },
      { ...validView, generation: -1 },
      { ...validView, revision: 1.5 },
      { ...validView, owner: 1 },
      { ...validView, transaction: 1 },
      { ...validView, targets: {} },
      { ...validView, targets: [{ handle: '', label: 'Target' }] },
      { ...validView, targets: [{ handle: 'opaque', label: '' }] },
      { ...validView, targets: [{ handle: 'opaque', label: 'Target', id: 'secret' }] },
    ])
      expect(parseVoiceOwnershipView(value)).toBeUndefined();
    const validCommand = { version: 1, epoch: EPOCH, generation: 1, revision: 1, phase: 'prepare', source: true };
    for (const value of [
      null,
      { ...validCommand, extra: true },
      { ...validCommand, generation: -1 },
      { ...validCommand, revision: -1 },
      { ...validCommand, phase: 'unsafe' },
      { ...validCommand, source: 1 },
      { ...validCommand, catalog: {} },
    ])
      expect(parseVoiceOwnershipCommand(value)).toBeUndefined();
    const validAck = { version: 1, epoch: EPOCH, generation: 1, revision: 1, phase: 'prepare', ok: true };
    expect(parseVoiceOwnershipAcknowledgement(validAck)).toEqual(validAck);
    for (const value of [
      null,
      { ...validAck, extra: true },
      { ...validAck, generation: -1 },
      { ...validAck, revision: -1 },
      { ...validAck, phase: 'unsafe' },
      { ...validAck, ok: 1 },
      { ...validAck, listening: 1 },
      { ...validAck, error: 'x'.repeat(301) },
    ])
      expect(parseVoiceOwnershipAcknowledgement(value)).toBeUndefined();
    expect(parseVoiceOwnershipTransferRequest({ version: 1, requestId: 'request', handle: 'handle' })).toBeDefined();
    for (const value of [
      null,
      { version: 2, requestId: 'request', handle: 'handle' },
      { version: 1, requestId: '', handle: 'handle' },
      { version: 1, requestId: 'request', handle: '' },
      { version: 1, requestId: 'request', handle: 'handle', sessionId: 'secret' },
    ])
      expect(parseVoiceOwnershipTransferRequest(value)).toBeUndefined();
  });

  it('guards generations, is idempotent, drains requests, and dispatches every rollback command', async () => {
    const ownership = new SessionVoiceOwnership();
    let state: 'active' | 'disabled' = 'active';
    const controller = {
      get state() {
        return state;
      },
      prepareVoiceTransfer: vi.fn(async () => undefined),
      quiesceVoiceTransfer: vi.fn(async () => {
        state = 'disabled';
      }),
      activateVoiceTransfer: vi.fn(async () => {
        state = 'active';
      }),
      abortVoiceTransfer: vi.fn(async () => {
        state = 'disabled';
      }),
      resumeVoiceTransfer: vi.fn(async () => {
        state = 'active';
      }),
    };
    const dispose = ownership.register({ label: 'Owner', eligible: true, requiresBrowserBind: true, controller });
    const catalog = {
      version: 1 as const,
      epoch: EPOCH,
      generation: 2,
      revision: 1,
      owner: true,
      transaction: false,
      targets: [{ handle: 'target', label: 'Target' }],
    };
    const prepared = {
      version: 1 as const,
      epoch: EPOCH,
      generation: 2,
      revision: 1,
      phase: 'prepare' as const,
      source: true,
      catalog,
    };
    expect((await ownership.command(prepared)).ok).toBe(true);
    expect((await ownership.command(prepared)).ok).toBe(true);
    expect(controller.prepareVoiceTransfer).toHaveBeenCalledOnce();
    expect(ownership.transfer('missing')).toBeUndefined();
    const request = ownership.transfer('target');
    expect(request).toBeDefined();
    ownership.clearRequest('other-request');
    expect(ownership.snapshot().request).toBeDefined();
    ownership.clearRequest(request!.requestId);
    expect(ownership.snapshot().request).toBeUndefined();
    expect(ownership.transfer('target')).toBeDefined();
    await ownership.command({
      ...prepared,
      revision: 2,
      phase: 'quiesce',
      catalog: { ...catalog, revision: 2, transaction: true },
    });
    expect(ownership.snapshot().request).toBeUndefined();
    await ownership.command({
      ...prepared,
      revision: 3,
      phase: 'activate',
      source: false,
      catalog: { ...catalog, revision: 3, transaction: true },
    });
    await ownership.command({
      ...prepared,
      revision: 4,
      phase: 'commit',
      source: false,
      catalog: { ...catalog, revision: 4, transaction: true },
    });
    await ownership.command({
      ...prepared,
      revision: 5,
      phase: 'abort',
      source: false,
      catalog: { ...catalog, revision: 5, transaction: true },
    });
    const resumed = await ownership.command({
      ...prepared,
      revision: 6,
      phase: 'resume',
      catalog: { ...catalog, revision: 6, transaction: true },
    });
    expect(resumed).toMatchObject({ ok: true, listening: true });
    expect(controller.quiesceVoiceTransfer).toHaveBeenCalledOnce();
    expect(controller.activateVoiceTransfer).toHaveBeenCalledOnce();
    expect(controller.abortVoiceTransfer).toHaveBeenCalledOnce();
    expect(controller.resumeVoiceTransfer).toHaveBeenCalledOnce();
    expect((await ownership.command({ ...prepared, generation: 1, revision: 99 })).ok).toBe(false);
    dispose();
    expect((await ownership.command({ ...prepared, generation: 3, revision: 1 })).ok).toBe(false);
  });

  it('accepts a fresh coordinator epoch at a lower generation and rejects the retired epoch', async () => {
    const prepareVoiceTransfer = vi.fn(async () => undefined);
    const ownership = new SessionVoiceOwnership();
    ownership.register({
      label: 'Owner',
      eligible: true,
      requiresBrowserBind: true,
      controller: {
        state: 'active',
        prepareVoiceTransfer,
        quiesceVoiceTransfer: async () => undefined,
        activateVoiceTransfer: async () => undefined,
        abortVoiceTransfer: async () => undefined,
        resumeVoiceTransfer: async () => undefined,
      },
    });
    const command = (epoch: string, generation: number): VoiceOwnershipCommand => ({
      version: 1,
      epoch,
      generation,
      revision: 1,
      phase: 'prepare',
      source: true,
      catalog: { version: 1, epoch, generation, revision: 1, owner: true, transaction: false, targets: [] },
    });

    expect((await ownership.command(command('old-epoch', 20))).ok).toBe(true);
    for (let index = 1; index <= 12; index += 1)
      expect((await ownership.command(command(`new-epoch-${String(index)}`, 1))).ok).toBe(true);
    expect((await ownership.command(command('old-epoch', 21))).ok).toBe(false);
    expect(prepareVoiceTransfer).toHaveBeenCalledTimes(13);
    expect(ownership.snapshot().view.epoch).toBe('new-epoch-12');
  });
});
describe('voice ownership failure containment', () => {
  it('forces a second active registration inactive and ignores an older lease revision', async () => {
    const sent: Array<{ session: string; phase: string }> = [];
    const coordinator = new VoiceOwnershipCoordinator({
      clock: ownershipClock,
      now: () => 0,
      send: async (scope, command) => {
        sent.push({ session: scope.sessionId, phase: command.phase });
        return acknowledgement(command);
      },
    });
    coordinator.update(source, registration('lease-source', 'Source', true));
    coordinator.update(target, { ...registration('lease-target', 'Target', true), revision: 2 });
    coordinator.update(target, { ...registration('lease-target', 'Older target', false), revision: 1 });
    await Promise.resolve();
    expect(sent).toContainEqual({ session: target.sessionId, phase: 'abort' });
    coordinator.remove(source.sessionId);
    expect(coordinator.view(source.sessionId).owner).toBe(false);
  });

  it('returns bounded failed acknowledgements when controllers throw or never listen', async () => {
    const throwing = new SessionVoiceOwnership();
    throwing.register({
      label: 'Throwing',
      eligible: true,
      requiresBrowserBind: true,
      controller: {
        state: 'active',
        prepareVoiceTransfer: async () => {
          throw new Error('unsafe'.repeat(100));
        },
        quiesceVoiceTransfer: async () => undefined,
        activateVoiceTransfer: async () => undefined,
        abortVoiceTransfer: async () => undefined,
        resumeVoiceTransfer: async () => undefined,
      },
    });
    const failed = await throwing.command({
      version: 1,
      epoch: EPOCH,
      generation: 1,
      revision: 1,
      phase: 'prepare',
      source: true,
    });
    expect(failed.ok).toBe(false);
    expect(failed.error?.length).toBeLessThanOrEqual(300);
    const silent = new SessionVoiceOwnership();
    silent.register({
      label: 'Silent',
      eligible: true,
      requiresBrowserBind: true,
      controller: {
        state: 'disabled',
        prepareVoiceTransfer: async () => undefined,
        quiesceVoiceTransfer: async () => undefined,
        activateVoiceTransfer: async () => undefined,
        abortVoiceTransfer: async () => undefined,
        resumeVoiceTransfer: async () => undefined,
      },
    });
    expect(
      (
        await silent.command({
          version: 1,
          epoch: EPOCH,
          generation: 1,
          revision: 1,
          phase: 'activate',
          source: false,
        })
      ).ok,
    ).toBe(false);
  });
});
