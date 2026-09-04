import type { HubChannelHost, HubSessionScope } from '@agimon-ai/doompi-web-contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createVoiceMediaWakeChannel,
  createVoiceOwnershipChannel,
  webHubChannels,
} from '../src/adapters/voiceMediaHubChannel.ts';
import { VOICE_MEDIA_WAKE_TYPE, type VoiceMediaWake } from '../src/types/clientMedia.ts';
import {
  VOICE_OWNERSHIP_FRAME_TYPE,
  VOICE_OWNERSHIP_PROTOCOL_VERSION,
  VOICE_OWNERSHIP_ROUTES,
  type BrowserVoiceOwnershipPayload,
  type VoiceOwnershipActivationRequest,
  type VoiceOwnershipCommand,
  type VoiceOwnershipHandoffRequest,
  type VoiceOwnershipTarget,
} from '../src/types/voiceOwnership.ts';

interface SessionState {
  leaseId: string;
  label: string;
  active: boolean;
  eligible?: boolean;
  activation?: VoiceOwnershipActivationRequest;
  handoff?: VoiceOwnershipHandoffRequest;
  catalog: VoiceOwnershipTarget[];
}

function scope(sessionId: string): HubSessionScope {
  return { sessionId, cwd: `/workspace/${sessionId}` };
}

function ownershipHarness(initial: Record<string, Omit<SessionState, 'catalog'>>) {
  const states = new Map<string, SessionState>(
    Object.entries(initial).map(([sessionId, state]) => [sessionId, { ...state, catalog: [] }]),
  );
  const actions: string[] = [];
  const published: Array<{ sessionId: string; payload: unknown }> = [];
  const notices: string[] = [];
  const host: HubChannelHost = {
    sessions: () => [...states.keys()].map(scope),
    publish: (sessionId, payload) => published.push({ sessionId, payload }),
    onNotice: (message) => notices.push(message),
    async requestSessionApi(session, request) {
      const state = states.get(session.sessionId);
      if (state === undefined) return new Response(null, { status: 404 });
      if (request.path === VOICE_OWNERSHIP_ROUTES.state) {
        return Response.json({
          registration: {
            version: VOICE_OWNERSHIP_PROTOCOL_VERSION,
            leaseId: state.leaseId,
            revision: 1,
            label: state.label,
            eligible: state.eligible ?? true,
            active: state.active,
          },
          targets: state.catalog,
          ...(state.activation === undefined ? {} : { activation: state.activation }),
          ...(state.handoff === undefined ? {} : { handoff: state.handoff }),
        });
      }
      if (request.path !== VOICE_OWNERSHIP_ROUTES.command || typeof request.body !== 'string')
        return new Response(null, { status: 404 });
      const command = JSON.parse(request.body) as VoiceOwnershipCommand;
      actions.push(`${session.sessionId}:${command.action}`);
      if (command.action === 'catalog') state.catalog = command.targets ?? [];
      else state.active = command.action === 'activate';
      return Response.json({
        version: VOICE_OWNERSHIP_PROTOCOL_VERSION,
        commandId: command.commandId,
        action: command.action,
        ok: true,
        active: state.active,
      });
    },
  };
  return { states, actions, published, notices, host };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('voice media hub channels', () => {
  it('keeps media wake delivery on its existing per-session channel', () => {
    const callbacks = new Map<string, (wake: VoiceMediaWake | undefined) => void>();
    const close = vi.fn();
    const watch = vi.fn((sessionId: string, callback: (wake: VoiceMediaWake | undefined) => void) => {
      callbacks.set(sessionId, callback);
      return { close };
    });
    const publish = vi.fn();
    const channel = createVoiceMediaWakeChannel(watch);
    const source = channel.start({
      sessions: () => [],
      publish,
      requestSessionApi: async () => new Response(null, { status: 404 }),
      onNotice: () => undefined,
    });
    const session = scope('session-a');

    source.sessionAdded?.(session);
    source.sessionAdded?.(session);
    const wake = { eventEpoch: 'event-a', sequence: 2 };
    callbacks.get('session-a')?.(wake);

    expect(channel.frameType).toBe(VOICE_MEDIA_WAKE_TYPE);
    expect(source.payloadFor(session)).toEqual(wake);
    expect(publish).toHaveBeenCalledWith('session-a', wake);
    callbacks.get('session-a')?.(undefined);
    expect(source.payloadFor(session)).toBeUndefined();
    source.sessionRemoved?.('session-a');
    expect(close).toHaveBeenCalledTimes(2);
    source.close();
  });

  it('exports separate wake and ownership WebSocket channels', () => {
    expect(webHubChannels.map((channel) => channel.frameType)).toEqual([
      VOICE_MEDIA_WAKE_TYPE,
      VOICE_OWNERSHIP_FRAME_TYPE,
    ]);
    expect(webHubChannels[0]?.lifecycle).toBeUndefined();
    expect(webHubChannels[1]?.lifecycle).toBe('hub');
  });

  it('executes a session activation request on the server and only publishes the selected session id', async () => {
    const h = ownershipHarness({
      source: { leaseId: 'lease-source', label: 'Source', active: true },
      target: {
        leaseId: 'lease-target',
        label: 'Target',
        active: false,
        activation: {
          version: VOICE_OWNERSHIP_PROTOCOL_VERSION,
          requestId: 'activate-target',
        },
      },
    });
    const channel = createVoiceOwnershipChannel({ pollMs: 5 });
    const source = channel.start(h.host);
    source.sessionAdded?.(scope('source'));
    source.sessionAdded?.(scope('target'));

    await vi.waitFor(() => expect(h.states.get('target')?.active).toBe(true));

    const stateActions = h.actions.filter((action) => !action.endsWith(':catalog'));
    expect(stateActions).toEqual(['source:deactivate', 'target:activate']);
    expect(h.states.get('source')?.active).toBe(false);
    expect(h.notices).toEqual([]);
    const selections = h.published
      .map((entry) => entry.payload as Partial<BrowserVoiceOwnershipPayload>)
      .filter((payload) => payload.type === 'browser-media-session');
    expect(selections.at(-1)).toEqual({
      type: 'browser-media-session',
      version: VOICE_OWNERSHIP_PROTOCOL_VERSION,
      activeSessionId: 'target',
    });
    expect(Object.keys(selections.at(-1)!)).toEqual(['type', 'version', 'activeSessionId']);
    expect(source.payloadFor(scope('source'))).toEqual(selections.at(-1));
    source.close();
  });

  it('performs a direct server-side handoff from the source request', async () => {
    const h = ownershipHarness({
      source: { leaseId: 'lease-source', label: 'Source', active: true },
      target: { leaseId: 'lease-target', label: 'Target', active: false },
    });
    const channel = createVoiceOwnershipChannel({ pollMs: 5 });
    const source = channel.start(h.host);
    source.sessionAdded?.(scope('source'));
    source.sessionAdded?.(scope('target'));
    await vi.waitFor(() =>
      expect(h.states.get('source')?.catalog).toEqual([{ handle: 'lease-target', label: 'Target', order: 1 }]),
    );
    h.actions.length = 0;
    h.states.get('source')!.handoff = {
      version: VOICE_OWNERSHIP_PROTOCOL_VERSION,
      requestId: 'handoff-target',
      handle: 'lease-target',
    };

    await vi.waitFor(() => expect(h.states.get('target')?.active).toBe(true));

    expect(h.actions.filter((action) => !action.endsWith(':catalog'))).toEqual([
      'source:deactivate',
      'target:activate',
    ]);
    expect(h.states.get('source')?.active).toBe(false);
    expect(h.notices).toEqual([]);
    source.close();
  });

  it('drops a removed active session from the global browser selection', async () => {
    const h = ownershipHarness({
      source: { leaseId: 'lease-source', label: 'Source', active: true },
    });
    const channel = createVoiceOwnershipChannel({ pollMs: 5 });
    const source = channel.start(h.host);
    source.sessionAdded?.(scope('source'));
    await vi.waitFor(() =>
      expect((source.payloadFor(scope('source')) as BrowserVoiceOwnershipPayload).activeSessionId).toBe('source'),
    );

    source.sessionRemoved?.('source');

    expect((source.payloadFor(scope('source')) as BrowserVoiceOwnershipPayload).activeSessionId).toBeNull();
    source.close();
  });

  it('rejects ineligible activation and unknown handoff requests without browser participation', async () => {
    const h = ownershipHarness({
      source: {
        leaseId: 'lease-source',
        label: 'Source',
        active: true,
        handoff: {
          version: VOICE_OWNERSHIP_PROTOCOL_VERSION,
          requestId: 'missing-handoff',
          handle: 'missing-target',
        },
      },
      target: {
        leaseId: 'lease-target',
        label: 'Target',
        active: false,
        eligible: false,
        activation: {
          version: VOICE_OWNERSHIP_PROTOCOL_VERSION,
          requestId: 'ineligible-activation',
        },
      },
    });
    const source = createVoiceOwnershipChannel({ pollMs: 5 }).start(h.host);
    source.sessionAdded?.(scope('source'));
    source.sessionAdded?.(scope('target'));

    await vi.waitFor(() =>
      expect(h.notices).toEqual(
        expect.arrayContaining([
          'voice handoff requested by source was rejected',
          'voice activation requested by target was rejected',
        ]),
      ),
    );

    expect(h.actions.every((action) => action.endsWith(':catalog'))).toBe(true);
    source.close();
  });

  it('reports invalid state payloads and non-Error polling failures', async () => {
    let calls = 0;
    const notices: string[] = [];
    const host: HubChannelHost = {
      sessions: () => [],
      publish: () => undefined,
      onNotice: (message) => notices.push(message),
      async requestSessionApi() {
        calls += 1;
        if (calls === 1) return new Response(null, { status: 503 });
        if (calls === 2) return Response.json(null);
        if (calls === 3) throw new Error('broken socket');
        throw 'socket unavailable';
      },
    };
    const source = createVoiceOwnershipChannel({ pollMs: 2 }).start(host);
    source.sessionAdded?.(scope('invalid'));

    await vi.waitFor(() => expect(calls).toBeGreaterThanOrEqual(4));
    expect(notices).toContain('voice ownership poll failed for invalid (broken socket)');
    expect(notices).toContain('voice ownership poll failed for invalid (socket unavailable)');
    source.close();

    const defaultSource = createVoiceOwnershipChannel().start({
      ...host,
      requestSessionApi: async () => Response.json(null),
    });
    defaultSource.close();
  });

  it('reports both HTTP and non-Error catalog delivery failures', async () => {
    const h = ownershipHarness({
      source: { leaseId: 'lease-source', label: 'Source', active: true },
    });
    const originalRequest = h.host.requestSessionApi.bind(h.host);
    let commands = 0;
    const host: HubChannelHost = {
      ...h.host,
      async requestSessionApi(session, request) {
        if (request.path !== VOICE_OWNERSHIP_ROUTES.command) return originalRequest(session, request);
        commands += 1;
        if (commands === 1) return new Response(null, { status: 503 });
        throw 'catalog unavailable';
      },
    };
    const source = createVoiceOwnershipChannel({ pollMs: 2 }).start(host);
    source.sessionAdded?.(scope('source'));

    await vi.waitFor(() =>
      expect(h.notices.filter((notice) => notice.includes('catalog update failed')).length).toBeGreaterThanOrEqual(2),
    );
    expect(h.notices.some((notice) => notice.includes('HTTP 503'))).toBe(true);
    expect(h.notices.some((notice) => notice.includes('catalog unavailable'))).toBe(true);
    source.close();
  });

  it('rejects activation if its target scope disappears after source deactivation', async () => {
    const h = ownershipHarness({
      source: { leaseId: 'lease-source', label: 'Source', active: true },
      target: {
        leaseId: 'lease-target',
        label: 'Target',
        active: false,
        activation: {
          version: VOICE_OWNERSHIP_PROTOCOL_VERSION,
          requestId: 'removed-target',
        },
      },
    });
    const originalRequest = h.host.requestSessionApi.bind(h.host);
    let removeTarget = (): void => undefined;
    const host: HubChannelHost = {
      ...h.host,
      async requestSessionApi(session, request) {
        const response = await originalRequest(session, request);
        if (request.path === VOICE_OWNERSHIP_ROUTES.command && typeof request.body === 'string') {
          const ownershipCommand = JSON.parse(request.body) as VoiceOwnershipCommand;
          if (session.sessionId === 'source' && ownershipCommand.action === 'deactivate') removeTarget();
        }
        return response;
      },
    };
    const runtime = createVoiceOwnershipChannel({ pollMs: 5 }).start(host);
    removeTarget = () => runtime.sessionRemoved?.('target');
    runtime.sessionAdded?.(scope('source'));
    runtime.sessionAdded?.(scope('target'));

    await vi.waitFor(() => expect(h.notices).toContain('voice activation requested by target was rejected'));
    expect(h.states.get('source')?.active).toBe(false);
    expect(h.states.get('target')?.active).toBe(false);
    runtime.close();
  });
});
