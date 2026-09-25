import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { DoomHeadlessHostService, DoomHeadlessTool } from '@agimon-ai/doompi-core/headless';
import type { DoomServerSessionPlugin } from '@agimon-ai/doompi-core/serverFacet';
import { describe, expect, it, vi } from 'vitest';

import { VoiceMediaBroker } from '../../../src/services/clientMediaApi';
import { VoiceModeController } from '../../../src/services/voiceModeController';
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

it('routes native Live controls to the host-global companion without activating session media', async () => {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const { VOICE_OWNERSHIP_ROUTES, VOICE_OWNERSHIP_PROTOCOL_VERSION } =
    await import('../../../src/types/voiceOwnership');
  const home = await mkdtemp(join(tmpdir(), 'voice-native-live-'));
  await mkdir(join(home, '.pi', '.doom'), { recursive: true });
  await writeFile(join(home, '.pi', '.doom', 'config.yaml'), 'voice:\n  mode: live\n');
  const selection = {
    majorMode: 'copilot',
    activeLayers: [],
    domains: [],
    state: { 'minor-mode': [] as string[] },
  };
  const host = {
    context: {
      cwd: home,
      repoRoot: home,
      sessionId: 'native-live',
      environment: {},
      selection,
      client: { notify: vi.fn(), setStatus: vi.fn() },
      session: { activity: async () => ({ isIdle: true }), admitPrompt: vi.fn() },
    },
    assertActive: vi.fn(),
    registerTool: vi.fn(() => ({ dispose: vi.fn() })),
    changeSelection: vi.fn(async ({ values }: { values: string[] }) => {
      selection.state['minor-mode'] = values;
    }),
  } as unknown as DoomHeadlessHostService;
  const broker = new VoiceMediaBroker({
    directEvents: { publish: vi.fn(), subscribe: () => () => undefined, close() {} },
    sessionId: 'native-live',
    clientConnectWaitMs: 0,
    hubToken: 'hub',
    realtimeProvider: { createCall: async () => ({ sdp: 'answer', callId: 'fixture' }) },
  });
  let activeSessionId: string | null = null;
  let muted = false;
  const status = () => ({
    version: 1,
    state: activeSessionId === null ? 'disabled' : 'active',
    activeSessionId,
    muted,
    media: { client: true, realtime: activeSessionId !== null },
  });
  const requestApi = vi.fn(async (mount: unknown, basePath: string, request: Request) => {
    expect(mount).toEqual({ scope: 'global' });
    expect(basePath).toBe('voice');
    if (request.method === 'GET') return Response.json(status());
    if (new URL(request.url).pathname === '/live/native-transfer') {
      const { ordinal } = (await request.clone().json()) as { ordinal: number };
      if (ordinal === 2) return Response.json({ error: 'Catalog changed on the host.' }, { status: 409 });
      if (ordinal === 3) throw new Error('Host transfer status is unknown.');
      return Response.json({ requested: true });
    }
    const body = (await request.json()) as {
      action: string;
      sessionId?: string;
      expectedSourceSessionId?: string;
    };
    if (body.action !== 'activate' && body.expectedSourceSessionId !== activeSessionId)
      return Response.json({ error: 'The native session no longer owns the live Voice route.' }, { status: 409 });
    if (body.action === 'activate') activeSessionId = body.sessionId ?? null;
    if (body.action === 'end') activeSessionId = null;
    if (body.action === 'mute' || body.action === 'unmute') muted = body.action === 'mute';
    return Response.json(status());
  });
  const facet = createVoiceServer(host, broker, home, 'hub', undefined, requestApi);
  const api = facet.api![0]!.start({} as never);
  const control = (action: string) =>
    api.fetch(new Request('http://voice/control', { method: 'POST', body: JSON.stringify({ action }) }));
  try {
    await facet.onStart?.({} as never);
    expect(await (await api.fetch(new Request('http://voice/status'))).json()).toMatchObject({
      state: 'disabled',
      mode: 'live',
    });
    expect(await (await control('activate')).json()).toMatchObject({ state: 'active', mode: 'live' });
    expect(activeSessionId).toBe('native-live');
    expect(broker.realtimeActive).toBe(false);
    expect(host.registerTool).not.toHaveBeenCalled();
    const route = { activationId: 'activation-live', routeGeneration: 1, transactionId: 'transaction-live' };
    const agent = (path: string, body: unknown) =>
      api.fetch(
        new Request(`http://voice${path}`, {
          method: 'POST',
          headers: { authorization: 'Bearer hub' },
          body: JSON.stringify(body),
        }),
      );
    const prepared = (await (await agent('/live/agent/prepare', route)).json()) as { sessionIncarnation: string };
    const binding = { ...route, sessionIncarnation: prepared.sessionIncarnation };
    expect(
      (
        await agent('/live/agent/select', {
          ...binding,
          nativeTransferAllowed: true,
          catalog: {
            revision: 'catalog-live-1',
            targets: [
              { order: 1, label: 'The other agent' },
              { order: 2, label: 'Stale host target' },
              { order: 3, label: 'Unavailable host target' },
            ],
          },
        })
      ).status,
    ).toBe(200);
    expect(selection.state['minor-mode']).toEqual(['voice-auto']);
    expect(vi.mocked(host.registerTool).mock.calls.map(([tool]) => tool.name)).toEqual(['transfer_voice']);
    const transfer = headlessTool(facet.tools, 'transfer_voice');
    expect(transfer.description).toContain('catalog-live-1');
    expect(
      (await transfer.execute('stale', { target: 1, revision: 'old' }, undefined, undefined, host.context)).details,
    ).toMatchObject({ error: { code: 'VOICE_TOOL_STALE_CATALOG' } });
    expect(
      (await transfer.execute('missing', { target: 4, revision: 'catalog-live-1' }, undefined, undefined, host.context))
        .details,
    ).toMatchObject({ error: { code: 'VOICE_TOOL_STALE_CATALOG' } });
    expect(
      (await transfer.execute('current', { target: 1, revision: 'catalog-live-1' }, undefined, undefined, host.context))
        .content,
    ).toEqual([{ type: 'text', text: expect.stringContaining('requested') }]);
    const native = vi
      .mocked(requestApi)
      .mock.calls.find(([, , request]) => new URL(request.url).pathname === '/live/native-transfer');
    expect(native?.[0]).toEqual({ scope: 'global' });
    expect(native?.[2].headers.get('authorization')).toBe('Bearer hub');
    expect(await native?.[2].clone().json()).toMatchObject({
      sourceSessionId: 'native-live',
      activationId: route.activationId,
      routeGeneration: route.routeGeneration,
      sessionIncarnation: prepared.sessionIncarnation,
      ordinal: 1,
      catalogRevision: 'catalog-live-1',
    });
    expect(
      (
        await transfer.execute(
          'host-stale',
          { target: 2, revision: 'catalog-live-1' },
          undefined,
          undefined,
          host.context,
        )
      ).details,
    ).toMatchObject({ error: { code: 'VOICE_TOOL_STALE_CATALOG', message: 'Catalog changed on the host.' } });
    expect(
      (
        await transfer.execute(
          'host-unknown',
          { target: 3, revision: 'catalog-live-1' },
          undefined,
          undefined,
          host.context,
        )
      ).details,
    ).toMatchObject({ error: { code: 'VOICE_TOOL_HOST_UNAVAILABLE', message: expect.stringContaining('uncertain') } });
    expect((await agent('/live/agent/fence', binding)).status).toBe(204);
    expect(selection.state['minor-mode']).toEqual([]);
    expect(vi.mocked(host.registerTool).mock.results[0]?.value.dispose).toHaveBeenCalled();
    expect(
      (await transfer.execute('fenced', { target: 1, revision: 'catalog-live-1' }, undefined, undefined, host.context))
        .details,
    ).toMatchObject({ error: { code: 'VOICE_TOOL_INACTIVE' } });
    const paired = { ...route, routeGeneration: 2, transactionId: 'paired-source' };
    expect((await agent('/live/agent/prepare', paired)).status).toBe(200);
    expect(
      (
        await agent('/live/agent/select', {
          ...paired,
          sessionIncarnation: prepared.sessionIncarnation,
          nativeTransferAllowed: false,
          catalog: { revision: 'paired-catalog', targets: [{ order: 1, label: 'Local agent' }] },
        })
      ).status,
    ).toBe(200);
    expect(selection.state['minor-mode']).toEqual(['voice-auto']);
    expect(vi.mocked(host.registerTool).mock.calls.map(([tool]) => tool.name)).toEqual(['transfer_voice']);
    expect(
      (await transfer.execute('paired', { target: 1, revision: 'paired-catalog' }, undefined, undefined, host.context))
        .details,
    ).toMatchObject({ error: { code: 'VOICE_TOOL_INACTIVE', message: expect.stringContaining('browser controls') } });
    activeSessionId = null;
    expect(await (await api.fetch(new Request('http://voice/status'))).json()).toMatchObject({
      state: 'active',
      mode: 'live',
    });
    const blocked = await control('deactivate');
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({ error: expect.stringContaining('owner browser controls') });
    expect(activeSessionId).toBeNull();
    activeSessionId = 'native-live';
    expect(
      (await agent('/live/agent/revoke', { ...paired, sessionIncarnation: prepared.sessionIncarnation })).status,
    ).toBe(204);
    expect(selection.state['minor-mode']).toEqual([]);
    await vi.waitFor(async () => {
      const response = await broker.fetch(
        new Request(`http://voice${VOICE_OWNERSHIP_ROUTES.state}`, { headers: { authorization: 'Bearer hub' } }),
      );
      expect(await response.json()).toMatchObject({ registration: { eligible: true, active: false } });
    });

    const nativeMedia = await broker.fetch(
      new Request(`http://voice${VOICE_OWNERSHIP_ROUTES.command}`, {
        method: 'POST',
        headers: { authorization: 'Bearer hub' },
        body: JSON.stringify({
          version: VOICE_OWNERSHIP_PROTOCOL_VERSION,
          commandId: 'local-live',
          action: 'activate',
        }),
      }),
    );
    expect(await nativeMedia.json()).toMatchObject({ ok: false });
    expect(broker.realtimeActive).toBe(false);

    expect(await (await control('mute')).json()).toMatchObject({ state: 'active', muted: true });
    activeSessionId = 'other-session';
    const stale = await control('deactivate');
    expect(stale.status).toBe(409);
    expect(activeSessionId).toBe('other-session');
    activeSessionId = 'native-live';
    expect(await (await control('deactivate')).json()).toMatchObject({ state: 'disabled' });
    expect(requestApi).toHaveBeenCalled();
  } finally {
    await facet.onDispose?.({} as never);
    await rm(home, { recursive: true, force: true });
  }
});

it('settles native legacy turns after fallback narration without blocking the native hook', async () => {
  const home = await mkdtemp(join(tmpdir(), 'voice-native-drain-'));
  const state = vi.spyOn(VoiceModeController.prototype, 'state', 'get').mockReturnValue('active');
  const fallback = vi.spyOn(VoiceModeController.prototype, 'narrateFallback').mockResolvedValue('completed');
  const speak = vi.spyOn(VoiceModeController.prototype, 'narrateAgent').mockResolvedValue('completed');
  const host = {
    context: {
      cwd: home,
      repoRoot: home,
      sessionId: 'legacy-run',
      environment: {},
      selection: { majorMode: 'copilot', activeLayers: [], domains: [] },
      client: { notify: vi.fn(), setStatus: vi.fn() },
      session: { activity: async () => ({ isIdle: true }), admitPrompt: vi.fn() },
    },
    assertActive: vi.fn(),
    changeSelection: vi.fn(),
    registerTool: vi.fn(() => ({ dispose: vi.fn() })),
  } as unknown as DoomHeadlessHostService;
  const broker = new VoiceMediaBroker({
    directEvents: { publish: vi.fn(), subscribe: () => () => undefined, close() {} },
    sessionId: 'legacy-run',
    clientConnectWaitMs: 0,
  });
  const facet = createVoiceServer(host, broker, home);
  const emit = (name: string, event: unknown) => {
    const hook = facet.hooks?.find((candidate) => candidate.event === name);
    if (!hook) throw new Error(`Missing ${name} hook.`);
    return hook.handle(event as never, host.context);
  };
  try {
    emit('agent_start', { runId: 'run-1' });
    emit('agent_start', { runId: 'run-1' });
    emit('turn_end', { runId: 'run-1', turnId: 'tool-turn', message: { role: 'assistant', stopReason: 'toolUse' } });
    emit('turn_end', { runId: 'run-1', turnId: 'user-turn', message: { role: 'user' } });
    emit('turn_end', {
      runId: 'run-1',
      turnId: 'answer',
      message: {
        role: 'assistant',
        stopReason: 'stop',
        content: [{ type: 'text', text: 'Hello' }, { type: 'image' }, { type: 'text', text: ' again.' }],
      },
    });
    emit('agent_settled', { runId: 'run-1' });
    await vi.waitFor(() => expect(fallback).toHaveBeenCalledWith('Hello again.'));
    expect(fallback).toHaveBeenCalledTimes(1);

    emit('agent_start', { runId: 'run-2' });
    emit('tool_execution_start', { runId: 'run-2', toolCallId: 'narration-2', toolName: 'narrate' });
    const narrated = await headlessTool(facet.tools, 'narrate').execute(
      'narration-2',
      { text: 'Spoken.' },
      undefined,
      undefined,
      host.context,
    );
    expect(narrated.isError).not.toBe(true);
    emit('turn_end', {
      runId: 'run-2',
      turnId: 'answer',
      message: {
        role: 'assistant',
        stopReason: 'stop',
        content: [{ type: 'text', text: 'Spoken.' }],
      },
    });
    emit('agent_settled', { runId: 'run-2' });
    expect(speak).toHaveBeenCalledWith('Spoken.', undefined);
    expect(fallback).toHaveBeenCalledTimes(1);

    fallback.mockRejectedValueOnce(new Error('playback failed'));
    emit('agent_start', { runId: 'run-3' });
    emit('turn_end', {
      runId: 'run-3',
      turnId: 'answer',
      message: {
        role: 'assistant',
        stopReason: 'stop',
        content: [{ type: 'text', text: 'Last turn.' }],
      },
    });
    emit('agent_settled', { runId: 'run-3' });
    await vi.waitFor(() =>
      expect(host.context.client.notify).toHaveBeenCalledWith({ body: 'playback failed', level: 'error' }),
    );
    expect(fallback).toHaveBeenCalledTimes(2);
  } finally {
    await facet.onDispose?.({} as never);
    state.mockRestore();
    fallback.mockRestore();
    speak.mockRestore();
    await rm(home, { recursive: true, force: true });
  }
});
