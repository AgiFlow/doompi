import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { DoomHeadlessHostService, DoomHeadlessTool } from '@agimon-ai/doompi-core/headless';
import type { DoomServerSessionPlugin } from '@agimon-ai/doompi-core/serverFacet';
import { describe, expect, it, vi } from 'vitest';

import { VoiceMediaBroker } from '../../../src/services/clientMediaApi';
import { createVoiceServer } from '../../../src/services/voiceServer';

// A facet may contribute headless tools or portable plugin tools, and the two
// call shapes differ. Voice contributes headless ones, so narrow on the `kind`
// discriminant the plugin shape carries rather than calling through the union.
function headlessTool(tools: DoomServerSessionPlugin['tools'], name: string): DoomHeadlessTool {
  const tool = tools?.find((candidate) => candidate.name === name);
  if (!tool || 'kind' in tool) throw new Error(`Expected a headless ${name} tool.`);
  return tool;
}

describe('native Voice session', () => {
  it('exposes status and controls without terminal adapters or false active tools', async () => {
    const home = await mkdtemp(join(tmpdir(), 'voice-native-'));
    const host = {
      context: {
        cwd: home,
        repoRoot: home,
        sessionId: 'native',
        environment: {},
        selection: { majorMode: 'copilot', activeLayers: [], domains: [] },
        client: { notify: vi.fn(), setStatus: vi.fn(), request: vi.fn(), appendComposerText: vi.fn() },
        session: { activity: async () => ({ isIdle: true }), admitPrompt: vi.fn() },
      },
      assertActive: vi.fn(),
      changeSelection: vi.fn(),
      registerTool: vi.fn(() => ({ dispose: vi.fn() })),
    } as unknown as DoomHeadlessHostService;
    const broker = new VoiceMediaBroker({
      directEvents: { publish: vi.fn(), subscribe: () => () => undefined, close() {} },
      sessionId: 'native',
      clientConnectWaitMs: 0,
    });
    const facet = createVoiceServer(host, broker, home);
    expect(facet.tools?.map(({ name }) => name)).toEqual([
      'describe_voice_tools',
      'use_voice_tools',
      'narrate',
      'transfer_voice',
    ]);
    const api = facet.api![0]!.start({} as never);
    try {
      const response = await api.fetch(new Request('http://voice/status'));
      expect(await response.json()).toMatchObject({
        state: 'disabled',
        manual: 'idle',
        media: { capture: false, playback: false },
      });
      expect(host.registerTool).not.toHaveBeenCalled();
      const activate = await api.fetch(
        new Request('http://voice/control', { method: 'POST', body: JSON.stringify({ action: 'activate' }) }),
      );
      expect(activate.status).toBe(409);
      expect(await activate.json()).toMatchObject({ error: expect.stringContaining('Configure Voice') });
      const stop = await api.fetch(
        new Request('http://voice/control', { method: 'POST', body: JSON.stringify({ action: 'deactivate' }) }),
      );
      expect(stop.status).toBe(200);
    } finally {
      await facet.onDispose?.({} as never);
      await rm(home, { recursive: true, force: true });
    }
    expect(broker.readiness().closed).toBe(true);
    expect(host.context.client.setStatus).toHaveBeenLastCalledWith('doom-voice', undefined);
  });

  // The tools are registered for the whole session and their condition tracks
  // the minor-mode selection, not the controller, so a call can arrive while
  // voice is off. Hiding a tool is not the same as refusing it.
  it('refuses narrate and transfer_voice while the voice controller is not active', async () => {
    const home = await mkdtemp(join(tmpdir(), 'voice-inactive-'));
    const host = {
      context: {
        cwd: home,
        repoRoot: home,
        sessionId: 'native',
        environment: {},
        selection: { majorMode: 'copilot', activeLayers: [], domains: [] },
        client: { notify: vi.fn(), setStatus: vi.fn(), request: vi.fn(), appendComposerText: vi.fn() },
        session: { activity: async () => ({ isIdle: true }), admitPrompt: vi.fn() },
      },
      assertActive: vi.fn(),
      changeSelection: vi.fn(),
      registerTool: vi.fn(() => ({ dispose: vi.fn() })),
    } as unknown as DoomHeadlessHostService;
    const broker = new VoiceMediaBroker({
      directEvents: { publish: vi.fn(), subscribe: () => () => undefined, close() {} },
      sessionId: 'native',
      clientConnectWaitMs: 0,
    });
    const facet = createVoiceServer(host, broker, home);
    try {
      const narrate = headlessTool(facet.tools, 'narrate');
      const refused = await narrate.execute('call-1', { text: 'should not speak' }, undefined, undefined, host.context);
      expect(refused.isError).toBe(true);
      expect(refused.details).toMatchObject({
        outcome: 'failed',
        error: { code: 'VOICE_TOOL_INACTIVE' },
      });

      const transfer = headlessTool(facet.tools, 'transfer_voice');
      const refusedTransfer = await transfer.execute('call-2', { target: 1 }, undefined, undefined, host.context);
      expect(refusedTransfer.isError).toBe(true);
      expect(refusedTransfer.details).toMatchObject({ error: { code: 'VOICE_TOOL_INACTIVE' } });
    } finally {
      await facet.onDispose?.({} as never);
      await rm(home, { recursive: true, force: true });
    }
  });
});

it('activates live voice through the native ownership broker and exposes tools only after browser readiness', async () => {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const { VOICE_MEDIA_PROTOCOL_VERSION, VOICE_MEDIA_ROUTES, VOICE_MEDIA_EVENT_WAIT_NONE } =
    await import('../../../src/types/clientMedia');
  const { VOICE_OWNERSHIP_ROUTES, VOICE_OWNERSHIP_PROTOCOL_VERSION } =
    await import('../../../src/types/voiceOwnership');
  const { REALTIME_ROUTES } = await import('../../../src/types/realtime');
  const home = await mkdtemp(join(tmpdir(), 'voice-native-live-'));
  await mkdir(join(home, '.pi', '.doom'), { recursive: true });
  await writeFile(join(home, '.pi', '.doom', 'config.yaml'), 'voice:\n  mode: live\n');
  let selection: string[] = [];
  const registerTool = vi.fn(() => ({ dispose: vi.fn() }));
  const host = {
    context: {
      cwd: home,
      repoRoot: home,
      sessionId: 'native-live',
      environment: {},
      get selection() {
        return { majorMode: 'copilot', activeLayers: [], domains: [], state: { 'minor-mode': selection } };
      },
      client: { notify: vi.fn(), setStatus: vi.fn() },
      session: { activity: async () => ({ isIdle: true }), admitPrompt: vi.fn() },
    },
    assertActive: vi.fn(),
    registerTool,
    changeSelection: async (change: { values: string[] }) => {
      selection = change.values;
    },
  } as unknown as DoomHeadlessHostService;
  const broker = new VoiceMediaBroker({
    directEvents: { publish: vi.fn(), subscribe: () => () => undefined, close() {} },
    sessionId: 'native-live',
    clientConnectWaitMs: 0,
    hubToken: 'hub',
    realtimeProvider: { createCall: async () => ({ sdp: 'answer', callId: 'fixture' }) },
  });
  const post = (path: string, body: object) =>
    broker.fetch(
      new Request(`http://voice${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer hub' },
        body: JSON.stringify(body),
      }),
    );
  const facet = createVoiceServer(host, broker, home);
  const api = facet.api![0]!.start({} as never);
  try {
    await facet.onStart?.({} as never);
    await vi.waitFor(async () => {
      const response = await broker.fetch(
        new Request(`http://voice${VOICE_OWNERSHIP_ROUTES.state}`, { headers: { authorization: 'Bearer hub' } }),
      );
      expect(await response.json()).toMatchObject({ registration: { eligible: true } });
    });
    const lease = { clientId: 'browser', connectionId: 'live-tab' };
    expect(
      (
        await post(VOICE_MEDIA_ROUTES.clientConnect, {
          ...lease,
          version: VOICE_MEDIA_PROTOCOL_VERSION,
          clientKind: 'browser',
          controlLocation: 'local',
          capabilities: {
            capture: true,
            playback: true,
            captureActivity: false,
            autonomousOrchestration: false,
            realtime: true,
          },
        })
      ).status,
    ).toBe(200);
    const activating = post(VOICE_OWNERSHIP_ROUTES.command, {
      version: VOICE_OWNERSHIP_PROTOCOL_VERSION,
      commandId: 'activate',
      action: 'activate',
    });
    expect(registerTool).not.toHaveBeenCalled();
    const event = await vi.waitFor(async () => {
      const response = await broker.fetch(
        new Request(
          `http://voice${VOICE_MEDIA_ROUTES.clientEvents}?clientId=browser&connectionId=live-tab&after=0&wait=${VOICE_MEDIA_EVENT_WAIT_NONE}`,
        ),
      );
      expect(response.status).toBe(200);
      return (await response.json()) as { activationId: string };
    });
    const browser = { ...lease, activationId: event.activationId };
    expect((await post(REALTIME_ROUTES.clientNegotiate, { ...browser, sdp: 'offer' })).status).toBe(200);
    await post(REALTIME_ROUTES.clientState, {
      ...browser,
      state: { connection: 'connected', listening: true, speaking: false, muted: false },
    });
    await post(REALTIME_ROUTES.clientEvent, {
      ...browser,
      event: JSON.stringify({ type: 'session.started', session: { id: 'provider' } }),
    });
    const acknowledgement = await activating;
    expect(acknowledgement.status).toBe(200);
    expect(await acknowledgement.json()).toMatchObject({ ok: true, active: true });
    await vi.waitFor(() => expect(registerTool).toHaveBeenCalledTimes(4));
    expect(await (await api.fetch(new Request('http://voice/status'))).json()).toMatchObject({
      state: 'active',
      mode: 'live',
    });
    const stopped = await api.fetch(
      new Request('http://voice/control', { method: 'POST', body: JSON.stringify({ action: 'deactivate' }) }),
    );
    expect(await stopped.json()).toMatchObject({ state: 'disabled' });
    for (const registration of registerTool.mock.results) expect(registration.value.dispose).toHaveBeenCalledOnce();
  } finally {
    await facet.onDispose?.({} as never);
    await rm(home, { recursive: true, force: true });
  }
});
