import { DOOM_HEADLESS_HOST_SERVICE, type DoomHeadlessHostService } from '@agimon-ai/doompi-core/headless';
import { DOOM_SERVER_HOST_SERVICE, type DoomServerHostService } from '@agimon-ai/doompi-core/server-facet';
import { Context } from '@deepseek-ai/cordis';
import { describe, expect, it, vi } from 'vitest';
import { createDoomPluginRegistry } from '@agimon-ai/doompi-core/plugin-protocol';
import { createDoomServerHost } from '@agimon-ai/doompi-core/server-facet';
import { api } from '../../../src/controllers/authorApi';
import { readAuthorPrompt } from '../../../src/services/authorPrompt';
import authorServerFacetDefault, { authorServerFacet } from '../../../src/extensions/server';

type MountedApi = Parameters<DoomServerHostService['registerApi']>[0];

function hostContext(scope: DoomServerHostService['scope']) {
  const registered: MountedApi[] = [];
  const state = { disposed: 0 };
  const host: DoomServerHostService = {
    scope,
    context: { locality: 'local' } as unknown as DoomServerHostService['context'],
    registerApi(candidate) {
      registered.push(candidate);
      return { dispose: () => void (state.disposed += 1) };
    },
    registerChannel() {
      return { dispose: () => undefined };
    },
    registerMethod() {
      return { dispose: () => undefined };
    },
    mounted: () => registered.map((candidate) => candidate.basePath),
    mountedChannels: () => [],
  };
  const context = {
    get: (name: string) => (name === DOOM_SERVER_HOST_SERVICE ? host : undefined),
    effect: () => undefined,
  } as unknown as Context;
  return { context, registered, state };
}

describe('authorServerFacet', () => {
  it('exports the server facet as the host-loaded default', () => {
    expect(authorServerFacetDefault).toBe(authorServerFacet);
  });
  it('declares its host dependency', () => {
    expect(authorServerFacet.inject).toEqual([DOOM_SERVER_HOST_SERVICE]);
  });

  it('registers the exact Author API in session scope', async () => {
    const harness = hostContext('session');
    expect(typeof (await authorServerFacet.apply(harness.context))).toBe('function');
    expect(harness.registered).toEqual([api]);
  });

  it('unregisters the API on disposal', async () => {
    const harness = hostContext('session');
    const dispose = await authorServerFacet.apply(harness.context);
    await dispose?.();
    expect(harness.state.disposed).toBe(1);
  });

  it('mounts its channel without the session document API globally', async () => {
    const harness = hostContext('global');
    expect(typeof (await authorServerFacet.apply(harness.context))).toBe('function');
    expect(harness.registered).toEqual([]);
  });

  it('normalizes shared tool errors through the server host', async () => {
    const harness = hostContext('session');
    const tools: Parameters<DoomHeadlessHostService['registerTool']>[0][] = [];
    const registration = () => ({ dispose() {} });
    const agent = {
      context: { selection: { minorModes: [] } },
      registerMinorMode: () => ({ ...registration(), publish() {} }),
      registerToolRestriction: registration,
      registerResource: registration,
      registerCommand: registration,
      registerHook: registration,
      registerTool(tool: Parameters<DoomHeadlessHostService['registerTool']>[0]) {
        tools.push(tool);
        return registration();
      },
    };
    const context = new Context();
    context.provide(DOOM_SERVER_HOST_SERVICE, harness.context.get(DOOM_SERVER_HOST_SERVICE));
    context.provide(DOOM_HEADLESS_HOST_SERVICE, agent as unknown as DoomHeadlessHostService);
    const dispose = await authorServerFacet.apply(context);
    const tool = tools.find((tool) => tool.name === 'open_authoring_file')!;
    await expect(
      tool.execute('call', {}, new AbortController().signal, undefined, {
        cwd: '/repo',
        client: { notify() {} },
      } as never),
    ).resolves.toMatchObject({ isError: true });
    await dispose?.();
    await context.fiber.dispose();
  });

  it('routes a validated workspace call with its authenticated connection ID', async () => {
    const received = vi.fn(() => true);
    const registry = createDoomPluginRegistry();
    const host = createDoomServerHost({
      scope: 'workspace',
      context: {
        scope: 'workspace',
        workspaceId: 'work-1',
        workspaceRoot: '/repo',
        receiveChannel: received,
        onNotice: vi.fn(),
      },
      pluginRegistry: registry,
      channelHost: {
        sessions: () => [],
        directEvents: { publish: vi.fn(), subscribe: () => () => undefined, close: vi.fn() },
        publish: vi.fn(),
        requestSessionApi: async () => new Response(null, { status: 204 }),
        onNotice: vi.fn(),
      },
    });
    const context = {
      get: (name: string) => (name === DOOM_SERVER_HOST_SERVICE ? host : undefined),
      effect: () => undefined,
    } as unknown as Context;
    const dispose = await authorServerFacet.apply(context);
    const call = {
      mount: { scope: 'workspace', workspaceId: 'work-1' },
      service: 'author.bridge',
      method: 'send',
      input: { sessionId: 'session-1', message: { kind: 'register', generation: 1 } },
    };
    await expect(registry.invoke(call, 'client-to-server', { connectionId: 'client-1' })).resolves.toEqual({});
    expect(received).toHaveBeenCalledWith('session-1', 'author_webmcp', call.input.message, 'client-1');
    await expect(registry.invoke(call, 'client-to-server')).rejects.toThrow('authenticated browser connection');
    await expect(
      registry.invoke(
        { ...call, input: { sessionId: 'session-1', message: { kind: 'register' } } },
        'client-to-server',
        { connectionId: 'client-1' },
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await dispose?.();
    host.dispose();
    registry.dispose();
  });
});

describe('Author prompt resource', () => {
  it('reads the published prompt from source and nested compiled module locations', async () => {
    const source = new URL('../../../src/extensions/server.ts', import.meta.url);
    const compiled = new URL('../../../dist/packages/minor/doompi-author/src/extensions/server.mjs', import.meta.url);
    const expected = await readAuthorPrompt(source);

    expect(expected).toContain('name: doompi-use-author');
    await expect(readAuthorPrompt(compiled)).resolves.toBe(expected);
  });
});
