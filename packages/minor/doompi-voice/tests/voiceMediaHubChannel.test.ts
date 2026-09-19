import type { DoomDirectEventBus, DoomHubChannelHost, DoomHubSessionScope } from '@agimon-ai/doompi-core/hub-channel';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createVoiceMediaWakeChannel, createVoiceOwnershipChannel } from '../src/services/voiceMediaHubChannel';
import { VoiceOwnershipCoordinator } from '../src/services/voiceOwnershipCoordinator';
import { VOICE_MEDIA_WAKE_TYPE, type VoiceMediaWake } from '../src/types/clientMedia';
import {
  VOICE_OWNERSHIP_FRAME_TYPE,
  VOICE_OWNERSHIP_PROTOCOL_VERSION,
  VOICE_OWNERSHIP_ROUTES,
  type BrowserVoiceOwnershipPayload,
  type VoiceOwnershipActivationRequest,
  type VoiceOwnershipCommand,
  type VoiceOwnershipHandoffRequest,
  type VoiceOwnershipTarget,
} from '../src/types/voiceOwnership';

interface SessionState {
  leaseId: string;
  label: string;
  active: boolean;
  eligible?: boolean;
  activation?: VoiceOwnershipActivationRequest;
  handoff?: VoiceOwnershipHandoffRequest;
  catalog: VoiceOwnershipTarget[];
  catalogRevision?: string;
}

function scope(sessionId: string): DoomHubSessionScope {
  return { sessionId, cwd: `/workspace/${sessionId}` };
}

function createDirectEvents() {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const key = (frameType: string, sessionId: string): string => `${frameType}:${sessionId}`;
  const events: DoomDirectEventBus & { emit(frameType: string, sessionId: string, payload: unknown): void } = {
    publish(frameType, sessionId, payload) {
      for (const listener of listeners.get(key(frameType, sessionId)) ?? []) listener(payload);
    },
    subscribe(frameType, sessionId, listener) {
      const eventKey = key(frameType, sessionId);
      const current = listeners.get(eventKey) ?? new Set<(payload: unknown) => void>();
      current.add(listener);
      listeners.set(eventKey, current);
      return () => {
        current.delete(listener);
        if (current.size === 0) listeners.delete(eventKey);
      };
    },
    close() {
      listeners.clear();
    },
    emit(frameType, sessionId, payload) {
      this.publish(frameType, sessionId, payload);
    },
  };
  return events;
}

function ownershipHarness(initial: Record<string, Omit<SessionState, 'catalog'>>) {
  const states = new Map<string, SessionState>(
    Object.entries(initial).map(([sessionId, state]) => [sessionId, { ...state, catalog: [] }]),
  );
  const actions: string[] = [];
  const published: Array<{ sessionId: string; payload: unknown }> = [];
  const notices: string[] = [];
  const directEvents = createDirectEvents();
  const host: DoomHubChannelHost = {
    sessions: () => [...states.keys()].map(scope),
    directEvents,
    publish: (sessionId, payload) => published.push({ sessionId, payload }),
    onNotice: (message) => notices.push(message),
    async requestSessionApi(session, request) {
      const state = states.get(session.sessionId);
      if (state === undefined) return new Response(null, { status: 404 });
      if (request.path !== VOICE_OWNERSHIP_ROUTES.command || typeof request.body !== 'string')
        return new Response(null, { status: 404 });
      const command = JSON.parse(request.body) as VoiceOwnershipCommand;
      actions.push(`${session.sessionId}:${command.action}`);
      if (command.action === 'catalog') {
        state.catalog = command.targets ?? [];
        state.catalogRevision = command.catalogRevision;
      } else if (command.action === 'activate') state.active = true;
      else if (command.action === 'deactivate' || command.action === 'fence') state.active = false;
      return Response.json({
        version: VOICE_OWNERSHIP_PROTOCOL_VERSION,
        commandId: command.commandId,
        action: command.action,
        ok: true,
        active: state.active,
      });
    },
  };
  const emit = (sessionId: string): void => {
    const state = states.get(sessionId);
    if (state === undefined) return;
    directEvents.emit(VOICE_OWNERSHIP_FRAME_TYPE, sessionId, {
      registration: {
        version: VOICE_OWNERSHIP_PROTOCOL_VERSION,
        leaseId: state.leaseId,
        revision: 1,
        label: state.label,
        eligible: state.eligible ?? true,
        active: state.active,
      },
      targets: state.catalog,
      ...(state.catalogRevision === undefined ? {} : { catalogRevision: state.catalogRevision }),
      ...(state.activation === undefined ? {} : { activation: state.activation }),
      ...(state.handoff === undefined ? {} : { handoff: state.handoff }),
    });
  };
  return { states, actions, published, notices, host, emit, directEvents };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('voice media hub channels', () => {
  it('delivers media wake events through the direct session bus', () => {
    const directEvents = createDirectEvents();
    const publish = vi.fn();
    const channel = createVoiceMediaWakeChannel();
    const source = channel.start({
      sessions: () => [],
      directEvents,
      publish,
      requestSessionApi: async () => new Response(null, { status: 404 }),
      onNotice: () => undefined,
    });
    const session = scope('session-a');
    source.sessionAdded?.(session);
    const wake: VoiceMediaWake = { eventEpoch: 'event-a', sequence: 2 };
    directEvents.emit(VOICE_MEDIA_WAKE_TYPE, 'session-a', wake);

    expect(channel.frameType).toBe(VOICE_MEDIA_WAKE_TYPE);
    expect(source.payloadFor(session)).toEqual(wake);
    expect(publish).toHaveBeenCalledWith('session-a', wake);
    directEvents.emit(VOICE_MEDIA_WAKE_TYPE, 'session-a', { eventEpoch: 'event-a', sequence: 1 });
    expect(publish).toHaveBeenCalledTimes(1);
    source.sessionRemoved?.('session-a');
    expect(source.payloadFor(session)).toBeUndefined();
    source.close();
  });

  it('constructs separate wake and ownership channels', () => {
    const channels = [createVoiceMediaWakeChannel(), createVoiceOwnershipChannel()];
    expect(channels.map((channel) => channel.frameType)).toEqual([VOICE_MEDIA_WAKE_TYPE, VOICE_OWNERSHIP_FRAME_TYPE]);
    expect(channels[0]?.lifecycle).toBeUndefined();
    expect(channels[1]?.lifecycle).toBe('hub');
  });

  it('executes activation requests emitted by a session and publishes the selected id', async () => {
    const h = ownershipHarness({
      source: { leaseId: 'lease-source', label: 'Source', active: true },
      target: {
        leaseId: 'lease-target',
        label: 'Target',
        active: false,
        activation: { version: VOICE_OWNERSHIP_PROTOCOL_VERSION, requestId: 'activate-target' },
      },
    });
    const source = createVoiceOwnershipChannel().start(h.host);
    source.sessionAdded?.(scope('source'));
    source.sessionAdded?.(scope('target'));
    h.emit('source');
    h.emit('target');

    await vi.waitFor(() => expect(h.states.get('target')?.active).toBe(true));
    expect(h.actions.filter((action) => !action.endsWith(':catalog'))).toEqual([
      'source:deactivate',
      'target:activate',
    ]);
    const selections = h.published
      .map((entry) => entry.payload as Partial<BrowserVoiceOwnershipPayload>)
      .filter((payload) => payload.type === 'browser-media-session');
    expect(selections.at(-1)).toEqual({
      type: 'browser-media-session',
      version: VOICE_OWNERSHIP_PROTOCOL_VERSION,
      activeSessionId: 'target',
    });
    source.close();
  });

  it('performs direct handoff from a session event and removes departed sessions', async () => {
    const h = ownershipHarness({
      source: { leaseId: 'lease-source', label: 'Source', active: true },
      target: { leaseId: 'lease-target', label: 'Target', active: false },
    });
    const source = createVoiceOwnershipChannel().start(h.host);
    source.sessionAdded?.(scope('source'));
    source.sessionAdded?.(scope('target'));
    h.emit('source');
    h.emit('target');
    await vi.waitFor(() =>
      expect(h.states.get('source')?.catalog).toEqual([{ handle: 'lease-target:1', label: 'Target', order: 1 }]),
    );
    h.actions.length = 0;
    h.states.get('source')!.handoff = {
      version: VOICE_OWNERSHIP_PROTOCOL_VERSION,
      requestId: 'handoff-target',
      handle: 'lease-target:1',
      catalogRevision: h.states.get('source')!.catalogRevision!,
    };
    h.emit('source');
    await vi.waitFor(() => expect(h.states.get('target')?.active).toBe(true));
    expect(h.actions.filter((action) => !action.endsWith(':catalog'))).toEqual([
      'target:prepare',
      'source:deactivate',
      'target:activate',
      'target:readiness',
    ]);

    source.sessionRemoved?.('target');
    expect((source.payloadFor(scope('source')) as BrowserVoiceOwnershipPayload).activeSessionId).toBeNull();
    source.close();
  });

  it('ignores malformed direct snapshots and bounds duplicate request delivery', async () => {
    const h = ownershipHarness({
      source: {
        leaseId: 'lease-source',
        label: 'Source',
        active: false,
        activation: { version: VOICE_OWNERSHIP_PROTOCOL_VERSION, requestId: 'activate-once' },
      },
    });
    const source = createVoiceOwnershipChannel().start(h.host);
    source.sessionAdded?.(scope('source'));
    h.directEvents.emit(VOICE_OWNERSHIP_FRAME_TYPE, 'source', { invalid: true });
    expect(h.actions).toEqual([]);
    h.emit('source');
    h.emit('source');
    await vi.waitFor(() => expect(h.states.get('source')?.active).toBe(true));
    expect(h.actions.filter((action) => action === 'source:activate')).toHaveLength(1);
    source.close();
  });

  it('coalesces overlapping catalog refreshes into a single publish', async () => {
    const h = ownershipHarness({
      source: { leaseId: 'lease-source', label: 'Source', active: true },
      target: { leaseId: 'lease-target', label: 'Target', active: false },
    });
    const publishCatalogs = vi.spyOn(VoiceOwnershipCoordinator.prototype, 'publishCatalogs');
    const source = createVoiceOwnershipChannel().start(h.host);
    source.sessionAdded?.(scope('source'));
    source.sessionAdded?.(scope('target'));
    h.emit('source');
    h.emit('target');
    await vi.waitFor(() =>
      expect(h.states.get('source')?.catalog).toEqual([{ handle: 'lease-target:1', label: 'Target', order: 1 }]),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    publishCatalogs.mockClear();

    h.states.get('target')!.label = 'Renamed';
    h.emit('target');
    // An uncoalesced refresh publishes again synchronously here, because the first run has not stored its
    // signature yet.
    h.emit('target');
    await vi.waitFor(() => expect(publishCatalogs).toHaveBeenCalledTimes(1));

    await vi.waitFor(() =>
      expect(h.states.get('source')?.catalog).toEqual([{ handle: 'lease-target:1', label: 'Renamed', order: 1 }]),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(publishCatalogs).toHaveBeenCalledTimes(1);
    source.close();
  });

  it('publishes a catalog change that arrives while a refresh is in flight', async () => {
    const h = ownershipHarness({
      source: { leaseId: 'lease-source', label: 'Source', active: true },
      target: { leaseId: 'lease-target', label: 'Target', active: false },
    });
    let releaseCatalog = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      releaseCatalog = resolve;
    });
    let holdCatalogs = false;
    const source = createVoiceOwnershipChannel().start({
      ...h.host,
      async requestSessionApi(session, request) {
        const response = await h.host.requestSessionApi(session, request);
        if (holdCatalogs) await held;
        return response;
      },
    });
    source.sessionAdded?.(scope('source'));
    source.sessionAdded?.(scope('target'));
    h.emit('source');
    h.emit('target');
    await vi.waitFor(() =>
      expect(h.states.get('source')?.catalog).toEqual([{ handle: 'lease-target:1', label: 'Target', order: 1 }]),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    holdCatalogs = true;
    h.states.get('target')!.label = 'First';
    h.emit('target');
    await vi.waitFor(() =>
      expect(h.states.get('source')?.catalog).toEqual([{ handle: 'lease-target:1', label: 'First', order: 1 }]),
    );
    h.states.get('target')!.label = 'Second';
    h.emit('target');
    releaseCatalog();

    // The change landed after the in-flight run had read its targets, so the trailing re-check must republish.
    await vi.waitFor(() =>
      expect(h.states.get('source')?.catalog).toEqual([{ handle: 'lease-target:1', label: 'Second', order: 1 }]),
    );
    source.close();
  });

  it('reports direct catalog delivery failures', async () => {
    const h = ownershipHarness({ source: { leaseId: 'lease-source', label: 'Source', active: true } });
    const requestSessionApi = vi.fn(async () => new Response(null, { status: 503 }));
    const source = createVoiceOwnershipChannel().start({ ...h.host, requestSessionApi });
    source.sessionAdded?.(scope('source'));
    h.emit('source');
    await vi.waitFor(() => expect(h.notices.some((notice) => notice.includes('catalog update failed'))).toBe(true));
    source.close();
  });

  it('keeps the ownership route available for command delivery', () => {
    expect(VOICE_OWNERSHIP_ROUTES.command).toBe('/hub/ownership/command');
  });
});
