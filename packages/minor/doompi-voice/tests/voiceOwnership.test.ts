import { describe, expect, it, vi } from 'vitest';

import { voiceOwnershipState } from '../src/models/voiceMode';
import {
  SessionVoiceOwnership,
  SessionVoiceOwnershipBridge,
  voiceOwnershipLabel,
} from '../src/services/sessionVoiceOwnership';
import { VoiceOwnershipCoordinator } from '../src/services/voiceOwnershipCoordinator';
import type { VoiceState } from '../src/types';
import {
  VOICE_OWNERSHIP_COMMAND_TIMEOUT_MS,
  VOICE_OWNERSHIP_PROTOCOL_VERSION,
  VOICE_OWNERSHIP_ROUTES,
  parseBrowserVoiceOwnershipPayload,
  parseVoiceOwnershipAcknowledgement,
  parseVoiceOwnershipActivationRequest,
  parseVoiceOwnershipCommand,
  parseVoiceOwnershipHandoffRequest,
  parseVoiceOwnershipRegistration,
  parseVoiceOwnershipTargets,
  type VoiceOwnershipAcknowledgement,
  type VoiceOwnershipCommand,
  type VoiceOwnershipRegistration,
  type VoiceOwnershipSessionSnapshot,
} from '../src/types/voiceOwnership';
import { createTestVoiceMediaApi as createVoiceMediaApi } from './support';

function registration(leaseId: string, label: string, active: boolean): VoiceOwnershipRegistration {
  return {
    version: VOICE_OWNERSHIP_PROTOCOL_VERSION,
    leaseId,
    revision: 1,
    label,
    eligible: true,
    active,
  };
}

function acknowledgement(command: VoiceOwnershipCommand, active: boolean, ok = true): VoiceOwnershipAcknowledgement {
  return {
    version: VOICE_OWNERSHIP_PROTOCOL_VERSION,
    commandId: command.commandId,
    action: command.action,
    ok,
    active,
    ...(ok ? {} : { error: 'rejected' }),
  };
}

function command(commandId: string, action: VoiceOwnershipCommand['action']): VoiceOwnershipCommand {
  return { version: VOICE_OWNERSHIP_PROTOCOL_VERSION, commandId, action };
}

describe('voice ownership protocol', () => {
  it('allows ownership commands to outlive the bounded worker startup', () => {
    expect(VOICE_OWNERSHIP_COMMAND_TIMEOUT_MS).toBeGreaterThan(21_000);
  });

  it('validates the server-owned wire shapes strictly', () => {
    expect(parseVoiceOwnershipRegistration(registration('lease-a', 'Session A', true))).toBeDefined();
    expect(
      parseVoiceOwnershipRegistration({ ...registration('lease-a', 'Session A', true), browser: true }),
    ).toBeUndefined();

    const targets = [{ handle: 'opaque-target', label: 'Session B', order: 1 }];
    expect(parseVoiceOwnershipTargets(targets)).toEqual(targets);
    expect(parseVoiceOwnershipTargets([...targets, { ...targets[0], label: 'duplicate' }])).toBeUndefined();

    expect(
      parseVoiceOwnershipCommand({
        version: VOICE_OWNERSHIP_PROTOCOL_VERSION,
        commandId: 'catalog-1',
        action: 'catalog',
        targets,
        catalogRevision: 'catalog-1',
      }),
    ).toBeDefined();
    expect(
      parseVoiceOwnershipCommand({
        version: VOICE_OWNERSHIP_PROTOCOL_VERSION,
        commandId: 'activate-1',
        action: 'activate',
        targets,
      }),
    ).toBeUndefined();

    expect(
      parseVoiceOwnershipAcknowledgement({
        version: VOICE_OWNERSHIP_PROTOCOL_VERSION,
        commandId: 'activate-1',
        action: 'activate',
        ok: true,
        active: true,
      }),
    ).toBeDefined();
    expect(
      parseVoiceOwnershipActivationRequest({
        version: VOICE_OWNERSHIP_PROTOCOL_VERSION,
        requestId: 'request-1',
      }),
    ).toBeDefined();
    expect(
      parseVoiceOwnershipHandoffRequest({
        version: VOICE_OWNERSHIP_PROTOCOL_VERSION,
        requestId: 'request-2',
        handle: 'opaque-target',
        catalogRevision: 'catalog-1',
      }),
    ).toBeDefined();

    expect(
      parseBrowserVoiceOwnershipPayload({
        type: 'browser-media-session',
        version: VOICE_OWNERSHIP_PROTOCOL_VERSION,
        activeSessionId: 'session-a',
      }),
    ).toBeDefined();
    expect(
      parseBrowserVoiceOwnershipPayload({
        type: 'browser-media-session',
        version: VOICE_OWNERSHIP_PROTOCOL_VERSION,
        activeSessionId: 'peer/work-host/voice-session',
      }),
    ).toBeDefined();
    expect(
      parseBrowserVoiceOwnershipPayload({
        type: 'browser-media-session',
        version: VOICE_OWNERSHIP_PROTOCOL_VERSION,
        activeSessionId: 'session-a',
        acknowledgement: true,
      }),
    ).toBeUndefined();
  });

  it('rejects every invalid protocol field at the boundary', () => {
    const validRegistration = registration('lease-a', 'Session A', true);
    for (const invalid of [
      null,
      [],
      { ...validRegistration, extra: true },
      { ...validRegistration, version: 1 },
      { ...validRegistration, leaseId: '' },
      { ...validRegistration, leaseId: 'bad lease' },
      { ...validRegistration, revision: -1 },
      { ...validRegistration, revision: 1.5 },
      { ...validRegistration, label: '' },
      { ...validRegistration, label: 'x'.repeat(81) },
      { ...validRegistration, eligible: 'yes' },
      { ...validRegistration, active: 1 },
    ])
      expect(parseVoiceOwnershipRegistration(invalid)).toBeUndefined();

    const validTarget = { handle: 'target-a', label: 'Target A', order: 1 };
    for (const invalid of [
      null,
      {},
      Array.from({ length: 33 }, (_, index) => ({
        handle: `target-${String(index)}`,
        label: `Target ${String(index)}`,
        order: index + 1,
      })),
      [null],
      [{ ...validTarget, extra: true }],
      [{ ...validTarget, handle: '' }],
      [{ ...validTarget, label: '' }],
      [{ ...validTarget, label: 'x'.repeat(81) }],
      [{ ...validTarget, order: 1.5 }],
      [{ ...validTarget, order: 0 }],
      [{ ...validTarget, order: 10_001 }],
      [validTarget, { handle: 'target-b', label: 'Target B', order: 1 }],
    ])
      expect(parseVoiceOwnershipTargets(invalid)).toBeUndefined();

    const validCommand = command('command-a', 'activate');
    for (const invalid of [
      null,
      [],
      { ...validCommand, extra: true },
      { ...validCommand, version: 1 },
      { ...validCommand, commandId: '' },
      { ...validCommand, commandId: 'bad command' },
      { ...validCommand, action: 'start' },
      {
        version: VOICE_OWNERSHIP_PROTOCOL_VERSION,
        commandId: 'catalog-a',
        action: 'catalog',
      },
      { ...validCommand, targets: [validTarget] },
    ])
      expect(parseVoiceOwnershipCommand(invalid)).toBeUndefined();

    const validAcknowledgement = acknowledgement(validCommand, true);
    for (const invalid of [
      null,
      [],
      { ...validAcknowledgement, extra: true },
      { ...validAcknowledgement, version: 1 },
      { ...validAcknowledgement, commandId: '' },
      { ...validAcknowledgement, action: 'start' },
      { ...validAcknowledgement, ok: 'yes' },
      { ...validAcknowledgement, active: 1 },
      { ...validAcknowledgement, error: 1 },
      { ...validAcknowledgement, error: 'x'.repeat(301) },
    ])
      expect(parseVoiceOwnershipAcknowledgement(invalid)).toBeUndefined();

    const activation = { version: VOICE_OWNERSHIP_PROTOCOL_VERSION, requestId: 'request-a' };
    for (const invalid of [
      null,
      [],
      { ...activation, extra: true },
      { ...activation, version: 1 },
      { ...activation, requestId: '' },
    ])
      expect(parseVoiceOwnershipActivationRequest(invalid)).toBeUndefined();

    const handoff = { ...activation, handle: 'target-a' };
    for (const invalid of [
      null,
      [],
      { ...handoff, extra: true },
      { ...handoff, version: 1 },
      { ...handoff, requestId: '' },
      { ...handoff, handle: '' },
    ])
      expect(parseVoiceOwnershipHandoffRequest(invalid)).toBeUndefined();

    const browser = {
      type: 'browser-media-session',
      version: VOICE_OWNERSHIP_PROTOCOL_VERSION,
      activeSessionId: null,
    };
    for (const invalid of [
      null,
      [],
      { ...browser, extra: true },
      { ...browser, type: 'browser-media-command' },
      { ...browser, version: 1 },
      { ...browser, activeSessionId: '' },
      { ...browser, activeSessionId: 'bad session' },
    ])
      expect(parseBrowserVoiceOwnershipPayload(invalid)).toBeUndefined();
  });
});

describe('SessionVoiceOwnership', () => {
  it('derives a bounded session label from a working directory', () => {
    expect(voiceOwnershipLabel('/workspace/project/')).toBe('project');
    expect(voiceOwnershipLabel('/')).toBe('Voice session');
  });

  it('publishes manual capture as the selected browser media session until transcription settles', async () => {
    let manualState: VoiceState = 'idle';
    const selections: Array<string | null> = [];
    const coordinator = new VoiceOwnershipCoordinator(
      {
        send: async () => {
          throw new Error('No ownership command was expected.');
        },
      },
      (payload) => selections.push(payload.activeSessionId),
      { now: () => 0, createId: () => 'unused-command' },
    );
    const ownership = new SessionVoiceOwnership();
    ownership.register({
      label: 'Manual session',
      eligible: true,
      controller: {
        get state() {
          return voiceOwnershipState(manualState, 'disabled');
        },
        activateVoice: async () => undefined,
        deactivateVoice: async () => undefined,
      },
    });
    const bridge = new SessionVoiceOwnershipBridge(
      ownership,
      {
        syncOwnership: async (snapshot) => {
          if (snapshot.registration !== undefined) coordinator.update('manual-session', snapshot.registration);
          return undefined;
        },
      },
      { setTimeout, clear: clearTimeout },
      250,
    );

    await bridge.synchronize();
    expect(coordinator.payload().activeSessionId).toBeNull();
    manualState = 'recording';
    await bridge.synchronize();
    expect(coordinator.payload().activeSessionId).toBe('manual-session');
    manualState = 'transcribing';
    await bridge.synchronize();
    expect(coordinator.payload().activeSessionId).toBe('manual-session');
    manualState = 'idle';
    await bridge.synchronize();

    expect(coordinator.payload().activeSessionId).toBeNull();
    expect(selections).toEqual(['manual-session', null]);
  });

  it('owns activation, catalog, and handoff state for one session', async () => {
    let state: 'disabled' | 'active' = 'disabled';
    const activateVoice = vi.fn(async () => {
      state = 'active';
    });
    const deactivateVoice = vi.fn(async () => {
      state = 'disabled';
    });
    const ownership = new SessionVoiceOwnership();
    const dispose = ownership.register({
      label: 'Owner',
      eligible: true,
      controller: {
        get state() {
          return state;
        },
        activateVoice,
        deactivateVoice,
      },
    });

    const activation = ownership.requestActivation();
    expect(activation).toBeDefined();
    const catalog: VoiceOwnershipCommand = {
      version: VOICE_OWNERSHIP_PROTOCOL_VERSION,
      commandId: 'catalog-1',
      action: 'catalog',
      targets: [{ handle: 'target-handle', label: 'Target', order: 1 }],
      catalogRevision: 'catalog-1',
    };
    await expect(ownership.command(catalog)).resolves.toMatchObject({ ok: true, active: false });
    expect(ownership.snapshot().targets).toEqual(catalog.targets);

    const activate = command('activate-1', 'activate');
    await expect(ownership.command(activate)).resolves.toMatchObject({ ok: true, active: true });
    await expect(ownership.command(activate)).resolves.toMatchObject({ ok: true, active: true });
    expect(activateVoice).toHaveBeenCalledOnce();
    expect(ownership.snapshot().activation).toBeUndefined();

    const handoff = ownership.handoff(1);
    expect(handoff).toMatchObject({ handle: 'target-handle' });
    const deactivate = command('deactivate-1', 'deactivate');
    await expect(ownership.command(deactivate)).resolves.toMatchObject({ ok: true, active: false });
    expect(deactivateVoice).toHaveBeenCalledOnce();
    expect(ownership.snapshot().handoff).toBeUndefined();

    dispose();
    expect(ownership.snapshot().registration).toBeUndefined();
  });

  it('reports controller failures without claiming the requested state', async () => {
    const ownership = new SessionVoiceOwnership();
    ownership.register({
      label: 'Owner',
      eligible: true,
      controller: {
        state: 'disabled',
        activateVoice: async () => {
          throw new Error('capture unavailable');
        },
        deactivateVoice: async () => undefined,
      },
    });

    await expect(ownership.command(command('activate-failure', 'activate'))).resolves.toMatchObject({
      ok: false,
      active: false,
      error: 'capture unavailable',
    });

    const inactive = new SessionVoiceOwnership();
    inactive.register({
      label: 'Inactive owner',
      eligible: true,
      controller: {
        state: 'disabled',
        activationError: 'Voice worker initialization failed.',
        activateVoice: async () => undefined,
        deactivateVoice: async () => undefined,
      },
    });
    await expect(inactive.command(command('inactive-failure', 'activate'))).resolves.toMatchObject({
      ok: false,
      active: false,
      error: 'Voice worker initialization failed.',
    });
  });

  it('does not acknowledge ownership until autonomous media capture is active', async () => {
    let state: 'disabled' | 'starting' | 'active' = 'disabled';
    const ownership = new SessionVoiceOwnership();
    ownership.register({
      label: 'Owner',
      eligible: true,
      controller: {
        get state() {
          return state;
        },
        activateVoice: async () => {
          state = 'starting';
        },
        deactivateVoice: async () => {
          state = 'disabled';
        },
      },
    });

    await expect(ownership.command(command('starting-activation', 'activate'))).resolves.toMatchObject({
      ok: false,
      active: false,
      error: 'Autonomous voice did not activate.',
    });
    expect(ownership.registration()).toMatchObject({ active: false });
  });

  it('reserves prepared targets by controller and fences tentative activation', async () => {
    let state: 'disabled' | 'starting' | 'active' = 'disabled';
    const deactivateVoice = vi.fn(async () => {
      state = 'disabled';
    });
    const ownership = new SessionVoiceOwnership();
    const dispose = ownership.register({
      label: 'Target',
      eligible: true,
      controller: {
        get state() {
          return state;
        },
        activateVoice: async () => {
          state = 'starting';
        },
        deactivateVoice,
      },
    });
    const registration = ownership.registration()!;
    const staged = (
      commandId: string,
      action: VoiceOwnershipCommand['action'],
      controllerId = 'controller-a',
    ): VoiceOwnershipCommand => ({
      version: VOICE_OWNERSHIP_PROTOCOL_VERSION,
      commandId,
      action,
      handoffId: 'handoff-a',
      controllerId,
      leaseId: registration.leaseId,
      revision: registration.revision,
    });

    await expect(ownership.command(staged('prepare-a', 'prepare'))).resolves.toMatchObject({ ok: true });
    await expect(ownership.command(staged('prepare-b', 'prepare', 'controller-b'))).resolves.toMatchObject({
      ok: false,
      error: 'Voice target is reserved by another controller.',
    });
    await expect(ownership.command(staged('activate-a', 'activate'))).resolves.toMatchObject({
      ok: false,
      active: false,
    });
    await expect(ownership.command(staged('fence-a', 'fence'))).resolves.toMatchObject({ ok: true, active: false });
    expect(deactivateVoice).toHaveBeenCalledOnce();
    expect(Object.keys(staged('shape-check', 'prepare'))).not.toContain('context');
    dispose();
  });

  it('releases ownership while autonomous media capture is draining', async () => {
    let state: 'active' | 'draining' = 'active';
    const ownership = new SessionVoiceOwnership();
    ownership.register({
      label: 'Owner',
      eligible: true,
      controller: {
        get state() {
          return state;
        },
        activateVoice: async () => undefined,
        deactivateVoice: async () => {
          state = 'draining';
        },
      },
    });

    await expect(ownership.command(command('draining-deactivation', 'deactivate'))).resolves.toMatchObject({
      ok: true,
      active: false,
    });
    expect(ownership.registration()).toMatchObject({ active: false });
  });

  it('synchronizes server commands until the host queue is empty', async () => {
    let state: 'disabled' | 'active' = 'disabled';
    const ownership = new SessionVoiceOwnership();
    ownership.register({
      label: 'Owner',
      eligible: true,
      controller: {
        get state() {
          return state;
        },
        activateVoice: async () => {
          state = 'active';
        },
        deactivateVoice: async () => {
          state = 'disabled';
        },
      },
    });
    const queued: VoiceOwnershipCommand[] = [
      {
        version: VOICE_OWNERSHIP_PROTOCOL_VERSION,
        commandId: 'catalog-bridge',
        action: 'catalog',
        targets: [{ handle: 'target', label: 'Target', order: 1 }],
        catalogRevision: 'catalog-bridge',
      },
      command('activate-bridge', 'activate'),
    ];
    const snapshots: VoiceOwnershipSessionSnapshot[] = [];
    const host = {
      async syncOwnership(snapshot: VoiceOwnershipSessionSnapshot) {
        snapshots.push(snapshot);
        const current = queued[0];
        if (
          current !== undefined &&
          snapshot.acknowledgement?.commandId === current.commandId &&
          snapshot.acknowledgement.action === current.action
        )
          queued.shift();
        return queued[0];
      },
    };
    const bridge = new SessionVoiceOwnershipBridge(ownership, host, { setTimeout, clear: clearTimeout }, 250);

    await bridge.synchronize();
    expect(state).toBe('active');
    expect(ownership.snapshot().targets).toHaveLength(1);
    expect(snapshots.at(-1)?.acknowledgement).toMatchObject({ commandId: 'activate-bridge', ok: true });
  });

  it('handles absent, replaced, and dynamically labelled runtime bindings', async () => {
    const ownership = new SessionVoiceOwnership();
    expect(ownership.registration()).toBeUndefined();
    expect(ownership.requestActivation()).toBeUndefined();
    expect(ownership.handoff(1)).toBeUndefined();
    await expect(ownership.command(command('missing-runtime', 'activate'))).resolves.toMatchObject({
      ok: false,
      active: false,
      error: 'Voice runtime is unavailable.',
    });

    let state: 'disabled' | 'active' = 'disabled';
    let label: 'empty' | 'throw' | 'named' = 'empty';
    const labelSource = (): string => {
      if (label === 'throw') throw new Error('name unavailable');
      return label === 'named' ? 'Named session' : '   ';
    };
    const firstDispose = ownership.register({
      label: labelSource,
      eligible: false,
      controller: {
        get state() {
          return state;
        },
        activateVoice: async () => {
          state = 'active';
        },
        deactivateVoice: async () => {
          state = 'disabled';
        },
      },
    });
    expect(ownership.registration()).toMatchObject({ label: 'Voice session', revision: 1 });
    expect(ownership.requestActivation()).toBeUndefined();
    label = 'throw';
    expect(ownership.registration()).toMatchObject({ label: 'Voice session', revision: 1 });
    label = 'named';
    state = 'active';
    expect(ownership.registration()).toMatchObject({ label: 'Named session', revision: 2, active: true });

    const secondDispose = ownership.register({
      label: 'Replacement',
      eligible: true,
      controller: {
        state: 'disabled',
        activateVoice: async () => undefined,
        deactivateVoice: async () => undefined,
      },
    });
    firstDispose();
    expect(ownership.registration()?.label).toBe('Replacement');
    secondDispose();
  });

  it('clears requests explicitly and rejects invalid state transitions', async () => {
    let state: 'disabled' | 'active' = 'disabled';
    const ownership = new SessionVoiceOwnership();
    ownership.register({
      label: 'Owner',
      eligible: true,
      controller: {
        get state() {
          return state;
        },
        activateVoice: async () => undefined,
        deactivateVoice: async () => undefined,
      },
    });
    const activation = ownership.requestActivation()!;
    ownership.clearActivationRequest('different');
    expect(ownership.snapshot().activation).toEqual(activation);
    ownership.clearActivationRequest(activation.requestId);
    expect(ownership.snapshot().activation).toBeUndefined();

    await expect(ownership.command(command('inactive-activate', 'activate'))).resolves.toMatchObject({ ok: false });
    state = 'active';
    expect(ownership.requestActivation()).toBeUndefined();
    expect(ownership.handoff(1)).toBeUndefined();
    await ownership.command({
      version: VOICE_OWNERSHIP_PROTOCOL_VERSION,
      commandId: 'catalog-requests',
      action: 'catalog',
      targets: [{ handle: 'target', label: 'Target', order: 1 }],
      catalogRevision: 'catalog-requests',
    });
    const handoff = ownership.handoff(1, 'catalog-requests')!;
    ownership.clearHandoffRequest('different');
    expect(ownership.snapshot().handoff).toEqual(handoff);
    ownership.clearHandoffRequest(handoff.requestId);
    expect(ownership.snapshot().handoff).toBeUndefined();
    expect(ownership.handoff(1, 'catalog-requests')).toBeDefined();
    state = 'disabled';
    expect(ownership.snapshot().handoff).toBeUndefined();
    state = 'active';
    expect(ownership.snapshot().handoff).toBeUndefined();
    const reused = command('reused-command', 'activate');
    await ownership.command(reused);
    await expect(ownership.command(command('reused-command', 'deactivate'))).resolves.toMatchObject({
      ok: false,
      error: 'Voice ownership command id was reused.',
    });
    await expect(ownership.command(command('stuck-deactivate', 'deactivate'))).resolves.toMatchObject({ ok: false });
    await ownership.command({
      version: VOICE_OWNERSHIP_PROTOCOL_VERSION,
      commandId: 'empty-catalog',
      action: 'catalog',
      catalogRevision: 'catalog-empty',
    });
    expect(ownership.snapshot().targets).toEqual([]);
  });

  it('invalidates a handoff synchronously across stop and reactivation without an ownership poll', async () => {
    let state: 'active' | 'disabled' = 'active';
    const ownership = new SessionVoiceOwnership();
    ownership.register({
      label: 'Owner', eligible: true,
      controller: {
        get state() { return state; },
        activateVoice: async () => { state = 'active'; },
        deactivateVoice: async () => { state = 'disabled'; },
      },
    });
    await ownership.command({
      version: VOICE_OWNERSHIP_PROTOCOL_VERSION,
      commandId: 'catalog-stop', action: 'catalog',
      targets: [{ handle: 'target', label: 'Target', order: 1 }],
      catalogRevision: 'catalog-stop',
    });
    expect(ownership.handoff(1)?.handle).toBe('target');
    ownership.cancelPending(); // Stop revokes authority before awaiting worker teardown.
    state = 'disabled';
    state = 'active'; // A new activation occurs before another snapshot is published.
    expect(ownership.snapshot().handoff).toBeUndefined();
  });

  it('normalizes non-Error controller failures', async () => {
    const ownership = new SessionVoiceOwnership();
    ownership.register({
      label: 'Owner',
      eligible: true,
      controller: {
        state: 'disabled',
        activateVoice: async () => {
          throw 'capture unavailable';
        },
        deactivateVoice: async () => undefined,
      },
    });
    await expect(ownership.command(command('non-error', 'activate'))).resolves.toMatchObject({
      ok: false,
      error: 'Voice ownership command failed.',
    });
  });

  it('starts, coalesces, stops, and bounds bridge synchronization', async () => {
    const ownership = new SessionVoiceOwnership();
    const callbacks: Array<() => void> = [];
    const clear = vi.fn();
    const setTimer = vi.fn((callback: () => void) => {
      callbacks.push(callback);
      return {} as ReturnType<typeof setTimeout>;
    });
    const bridge = new SessionVoiceOwnershipBridge(
      ownership,
      { syncOwnership: async () => undefined },
      { setTimeout: setTimer, clear },
    );
    bridge.start();
    bridge.start();
    expect(setTimer).toHaveBeenCalledOnce();
    bridge.stop();
    bridge.stop();
    expect(clear).toHaveBeenCalledOnce();

    let release!: (value: VoiceOwnershipCommand | undefined) => void;
    const pending = new Promise<VoiceOwnershipCommand | undefined>((resolve) => {
      release = resolve;
    });
    const coalescing = new SessionVoiceOwnershipBridge(
      ownership,
      { syncOwnership: () => pending },
      { setTimeout, clear: clearTimeout },
    );
    const first = coalescing.synchronize();
    expect(coalescing.synchronize()).toBe(first);
    release(undefined);
    await first;

    const repeating = command('repeat-catalog', 'catalog');
    const bounded = new SessionVoiceOwnershipBridge(
      ownership,
      { syncOwnership: async () => repeating },
      { setTimeout, clear: clearTimeout },
    );
    await expect(bounded.synchronize()).rejects.toThrow('synchronization limit exceeded');
  });
  it('keeps the source selected until its response finishes speaking, then hands off', async () => {
    const source = new SessionVoiceOwnership();
    const target = new SessionVoiceOwnership();
    let sourceState: 'active' | 'disabled' = 'active';
    let targetState: 'active' | 'disabled' = 'disabled';
    source.register({
      label: 'Source',
      eligible: true,
      controller: {
        get state() {
          return sourceState;
        },
        activateVoice: async () => {
          sourceState = 'active';
        },
        deactivateVoice: async () => {
          sourceState = 'disabled';
        },
      },
    });
    target.register({
      label: 'Target',
      eligible: true,
      controller: {
        get state() {
          return targetState;
        },
        activateVoice: async () => {
          targetState = 'active';
        },
        deactivateVoice: async () => {
          targetState = 'disabled';
        },
      },
    });
    const coordinator = new VoiceOwnershipCoordinator(
      { send: (sessionId, value) => (sessionId === 'source' ? source : target).command(value) },
      vi.fn(),
      { now: () => 0, createId: () => globalThis.crypto.randomUUID() },
    );
    coordinator.update('source', source.registration()!);
    coordinator.update('target', target.registration()!);
    await coordinator.publishCatalogs();
    expect(source.handoff(1, source.snapshot().catalogRevision)).toBeDefined();

    let speaking = true;
    const bridge = new SessionVoiceOwnershipBridge(
      source,
      {
        syncOwnership: async (snapshot) => {
          coordinator.update('source', snapshot.registration!);
          if (snapshot.handoff)
            await coordinator.handoff('source', snapshot.handoff.handle, snapshot.handoff.catalogRevision);
          return undefined;
        },
      },
      { setTimeout, clear: clearTimeout },
      250,
      () => undefined,
      () => speaking,
    );
    await bridge.synchronize();
    expect(sourceState).toBe('active');
    expect(targetState).toBe('disabled');
    expect(coordinator.payload().activeSessionId).toBe('source');

    speaking = false;
    await bridge.synchronize();
    expect(sourceState).toBe('disabled');
    expect(targetState).toBe('active');
    expect(coordinator.payload().activeSessionId).toBe('target');
  });
});

describe('VoiceOwnershipCoordinator', () => {
  function harness(fail?: (sessionId: string, command: VoiceOwnershipCommand) => boolean) {
    const states = new Map<string, boolean>();
    const deliveries: string[] = [];
    const selections: Array<string | null> = [];
    const publications: Array<{ activeSessionId: string | null; handoff?: { phase: string } }> = [];
    let nextId = 0;
    const coordinator = new VoiceOwnershipCoordinator(
      {
        async send(sessionId, value) {
          deliveries.push(`${sessionId}:${value.action}`);
          if (value.action === 'catalog') return acknowledgement(value, states.get(sessionId) === true);
          const current = states.get(sessionId) === true;
          const nextActive =
            value.action === 'activate'
              ? true
              : value.action === 'deactivate' || value.action === 'fence'
                ? false
                : current;
          if (fail?.(sessionId, value)) return acknowledgement(value, current, false);
          states.set(sessionId, nextActive);
          return acknowledgement(value, nextActive);
        },
      },
      (payload) => {
        selections.push(payload.activeSessionId);
        publications.push(payload);
      },
      { now: () => 0, createId: () => `command-${++nextId}` },
    );
    const update = (sessionId: string, leaseId: string, label: string, active: boolean) => {
      states.set(sessionId, active);
      coordinator.update(sessionId, registration(leaseId, label, active));
    };
    return { coordinator, deliveries, selections, publications, states, update };
  }

  it('deactivates every other active session sequentially before activation', async () => {
    const h = harness();
    h.update('source', 'lease-source', 'Source', true);
    h.update('other', 'lease-other', 'Other', true);
    h.update('target', 'lease-target', 'Target', false);
    h.deliveries.length = 0;
    h.selections.length = 0;

    await expect(h.coordinator.activate('target')).resolves.toBe(true);

    expect(h.deliveries).toEqual(['other:deactivate', 'source:deactivate', 'target:activate']);
    expect(h.selections).toEqual(['target']);
    expect(h.states).toEqual(
      new Map([
        ['source', false],
        ['other', false],
        ['target', true],
      ]),
    );
  });

  it('hands off by turning off the source, selecting the target, then turning on the target', async () => {
    const h = harness();
    h.update('source-private-id', 'source-lease', 'Source', true);
    h.update('target-private-id', 'target-lease', 'Target', false);
    const catalog = h.coordinator.catalog('source-private-id');
    expect(catalog).toEqual([{ handle: 'target-lease:1', label: 'Target', order: 1 }]);
    expect(JSON.stringify(catalog)).not.toContain('target-private-id');
    h.deliveries.length = 0;
    h.selections.length = 0;
    h.publications.length = 0;

    await expect(h.coordinator.handoff('source-private-id', catalog[0]!.handle)).resolves.toBe(true);

    expect(h.deliveries).toEqual([
      'target-private-id:prepare',
      'source-private-id:deactivate',
      'target-private-id:activate',
      'target-private-id:readiness',
    ]);
    expect(h.selections).toEqual([
      'source-private-id', 'source-private-id', 'target-private-id', 'target-private-id',
    ]);
    expect(h.publications.map((payload) => payload.handoff?.phase)).toEqual([
      'preparing', 'rebinding', 'rebinding', undefined,
    ]);
    expect(h.states.get('source-private-id')).toBe(false);
    expect(h.states.get('target-private-id')).toBe(true);
  });

  it('fences a prepared target replaced during handoff without releasing the source', async () => {
    let resolvePrepare!: (value: VoiceOwnershipAcknowledgement) => void;
    let prepareCommand: VoiceOwnershipCommand | undefined;
    const deliveries: string[] = [];
    const coordinator = new VoiceOwnershipCoordinator(
      {
        async send(sessionId, value) {
          deliveries.push(`${sessionId}:${value.action}`);
          if (value.action === 'prepare') {
            prepareCommand = value;
            return new Promise<VoiceOwnershipAcknowledgement>((resolve) => {
              resolvePrepare = resolve;
            });
          }
          return acknowledgement(value, false);
        },
      },
      () => undefined,
      { now: () => 0, createId: () => globalThis.crypto.randomUUID() },
    );
    coordinator.update('source', registration('source-lease', 'Source', true));
    coordinator.update('target', registration('target-lease', 'Target', false));
    const handoff = coordinator.handoff('source', 'target-lease:1');
    await vi.waitFor(() => expect(prepareCommand).toBeDefined());
    coordinator.update('target', { ...registration('replacement-lease', 'Replacement', false), revision: 2 });
    resolvePrepare(acknowledgement(prepareCommand!, false));

    await expect(handoff).resolves.toBe(false);
    expect(deliveries).toEqual(['target:prepare', 'target:fence']);
    expect(coordinator.payload().activeSessionId).toBe('source');
  });

  it('restores source ownership if target activation fails and reports staged failure', async () => {
    const h = harness((sessionId, value) => sessionId === 'target' && value.action === 'activate');
    h.update('source', 'source-lease', 'Source', true);
    h.update('target', 'target-lease', 'Target', false);
    h.selections.length = 0;

    await expect(h.coordinator.handoff('source', 'target-lease:1')).resolves.toBe(false);

    expect(h.states.get('source')).toBe(true);
    expect(h.states.get('target')).toBe(false);
    expect(h.selections.at(-1)).toBe('source');
    expect(h.publications.at(-1)?.handoff?.phase).toBe('failed');
  });

  it('expires inactive leases and publishes no selected browser session', () => {
    let now = 0;
    const selections: Array<string | null> = [];
    const coordinator = new VoiceOwnershipCoordinator(
      { send: async (_sessionId, value) => acknowledgement(value, false) },
      (payload) => selections.push(payload.activeSessionId),
      { now: () => now, createId: () => 'command', leaseMs: 100 },
    );
    coordinator.update('source', registration('source-lease', 'Source', true));
    expect(coordinator.payload().activeSessionId).toBe('source');
    now = 101;
    expect(coordinator.payload().activeSessionId).toBeNull();
    expect(selections).toEqual(['source', null]);
  });

  it('rejects missing, inactive, stale, and ineligible participants', async () => {
    const h = harness();
    h.update('source', 'source-lease', 'Same', false);
    h.update('target', 'target-lease', 'Same', false);
    h.update('another', 'another-lease', 'Same', false);
    expect(h.coordinator.catalog('source').map((target) => target.handle)).toEqual([
      'another-lease:1',
      'target-lease:1',
    ]);
    expect(await h.coordinator.handoff('missing', 'target-lease')).toBe(false);
    expect(await h.coordinator.handoff('source', 'target-lease:1')).toBe(false);
    expect(await h.coordinator.activate('missing')).toBe(false);
    h.coordinator.update('target', {
      ...registration('target-lease', 'Updated', false),
      revision: 2,
      eligible: false,
    });
    h.coordinator.update('target', registration('target-lease', 'Stale', false));
    expect(h.coordinator.catalog('source').map((target) => target.handle)).toEqual(['another-lease:1']);
    expect(await h.coordinator.activate('target')).toBe(false);

    h.update('source', 'source-lease', 'Source', true);
    expect(await h.coordinator.handoff('source', 'missing-handle')).toBe(false);
    h.update('another', 'another-lease', 'Same', true);
    expect(await h.coordinator.activate('another')).toBe(true);
  });

  it('cancels target activation when another active session cannot deactivate', async () => {
    const h = harness((sessionId, value) => sessionId === 'source' && value.action === 'deactivate');
    h.update('source', 'source-lease', 'Source', true);
    h.update('target', 'target-lease', 'Target', false);
    h.deliveries.length = 0;

    await expect(h.coordinator.activate('target')).resolves.toBe(false);

    expect(h.deliveries).toEqual(['source:deactivate', 'target:deactivate']);
    expect(h.states.get('source')).toBe(true);

    const handoff = harness((sessionId, value) => sessionId === 'source' && value.action === 'deactivate');
    handoff.update('source', 'source-lease', 'Source', true);
    handoff.update('target', 'target-lease', 'Target', false);
    handoff.deliveries.length = 0;
    await expect(handoff.coordinator.handoff('source', 'target-lease:1')).resolves.toBe(false);
    expect(handoff.deliveries).toEqual(['target:prepare', 'source:deactivate', 'target:fence']);
  });

  it('rejects malformed or failed deliveries and tolerates participant removal during a catalog', async () => {
    const malformed = new VoiceOwnershipCoordinator(
      {
        send: async (_sessionId, value) => ({
          ...acknowledgement(value, false),
          commandId: 'different-command',
        }),
      },
      () => undefined,
      { now: () => 0, createId: () => 'malformed-command' },
    );
    malformed.update('target', registration('target-lease', 'Target', false));
    expect(await malformed.activate('target')).toBe(false);

    const throwing = new VoiceOwnershipCoordinator(
      { send: async () => Promise.reject(new Error('unreachable')) },
      () => undefined,
      { now: () => 0, createId: () => 'throwing-command' },
    );
    throwing.update('target', registration('target-lease', 'Target', false));
    expect(await throwing.activate('target')).toBe(false);

    let resolve!: (ack: VoiceOwnershipAcknowledgement) => void;
    let delivered: VoiceOwnershipCommand | undefined;
    const pending = new Promise<VoiceOwnershipAcknowledgement>((accept) => {
      resolve = accept;
    });
    const removed = new VoiceOwnershipCoordinator(
      {
        send: async (_sessionId, value) => {
          delivered = value;
          return pending;
        },
      },
      () => undefined,
      { now: () => 0, createId: () => 'catalog-command' },
    );
    removed.update('target', registration('target-lease', 'Target', true));
    const publishing = removed.publishCatalogs();
    await vi.waitFor(() => expect(delivered).toBeDefined());
    removed.remove('target');
    resolve(acknowledgement(delivered!, true));
    await expect(publishing).resolves.toBeUndefined();
  });
});

describe('voice ownership package API bridge', () => {
  it('holds a hub command until the owning session acknowledges it', async () => {
    let state: 'disabled' | 'active' = 'disabled';
    const ownership = new SessionVoiceOwnership();
    ownership.register({
      label: 'Session',
      eligible: true,
      controller: {
        get state() {
          return state;
        },
        activateVoice: async () => {
          state = 'active';
        },
        deactivateVoice: async () => {
          state = 'disabled';
        },
      },
    });
    const api = createVoiceMediaApi({ internalToken: 'internal', hubToken: 'hub', ownershipCommandTimeoutMs: 1_000 });
    const fetch = (request: Request) => Promise.resolve(api.fetch(request));
    const sync = (snapshot: VoiceOwnershipSessionSnapshot) =>
      fetch(
        new Request(`http://voice.test${VOICE_OWNERSHIP_ROUTES.sync}`, {
          method: 'POST',
          headers: { authorization: 'Bearer internal', 'content-type': 'application/json' },
          body: JSON.stringify(snapshot),
        }),
      );

    expect((await sync(ownership.snapshot())).status).toBe(200);
    const activate = command('api-activate', 'activate');
    const pending = fetch(
      new Request(`http://voice.test${VOICE_OWNERSHIP_ROUTES.command}`, {
        method: 'POST',
        headers: { authorization: 'Bearer hub', 'content-type': 'application/json' },
        body: JSON.stringify(activate),
      }),
    );

    let delivered: VoiceOwnershipCommand | undefined;
    await vi.waitFor(async () => {
      const response = await sync(ownership.snapshot());
      const body = (await response.json()) as { command?: unknown };
      delivered = parseVoiceOwnershipCommand(body.command);
      expect(delivered).toEqual(activate);
    });
    await ownership.command(delivered!);
    expect((await sync(ownership.snapshot())).status).toBe(200);

    const response = await pending;
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ commandId: 'api-activate', ok: true, active: true });

    const stateResponse = await fetch(
      new Request(`http://voice.test${VOICE_OWNERSHIP_ROUTES.state}`, {
        headers: { authorization: 'Bearer hub' },
      }),
    );
    await expect(stateResponse.json()).resolves.toMatchObject({ registration: { active: true }, targets: [] });
  });
});
