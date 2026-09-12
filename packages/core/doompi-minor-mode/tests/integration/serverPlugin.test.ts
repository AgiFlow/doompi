import { serverMinorModes } from '../../src/services/serverRegistration';
import { DOOM_MINOR_MODE_CATALOG_SERVICE } from '../../src/schemas/mode';
import { defineServerPlugin } from '@agimon-ai/doompi-core/server-facet';
import type { MinorModeOwner } from '../../src/services/modeDefinition';
import { Type } from 'typebox';
import { defineTool, defineCommand } from '@agimon-ai/doompi-core/pi-extension';
import {
  DOOM_HEADLESS_OWNER,
  DOOM_HEADLESS_HOST_SERVICE,
  type DoomHeadlessHostService,
} from '@agimon-ai/doompi-core/headless';
import { Context } from '@deepseek-ai/cordis';
import { describe, expect, it, vi } from 'vitest';
import {
  defineServerMethod,
  type DoomServerPluginDefinition,
  DOOM_SERVER_HOST_SERVICE,
  type DoomServerHostService,
} from '@agimon-ai/doompi-core/server-facet';

function fixture() {
  const events: string[] = [];
  const host: DoomServerHostService = {
    scope: 'session',
    context: { scope: 'session', sessionId: 's', cwd: '/repo', onNotice: vi.fn() },
    registerApi: () => ({
      mounted: true,
      dispose: () => {
        events.push('api');
      },
    }),
    registerChannel: () => ({
      mounted: true,
      dispose: () => {
        events.push('channel');
      },
    }),
    registerMethod: () => ({ mounted: true, dispose: vi.fn() }),
    mounted: () => [],
    mountedChannels: () => [],
  };
  const context = new Context();
  context.provide(DOOM_SERVER_HOST_SERVICE, host);
  return { context, host, events };
}
const api = { basePath: 'test', start: () => ({ fetch: () => new Response(), close() {} }) };

describe('defineServerPlugin', () => {
  it('selects only the mounted scope and disposes once in reverse order', async () => {
    const { context, events } = fixture();
    const global = vi.fn(() => ({}));
    const plugin = defineServerPlugin({
      name: 'scope',
      global,
      session: {
        api: [api],
        onDispose() {
          events.push('state');
        },
      },
    });
    expect(plugin.inject).toContain(DOOM_SERVER_HOST_SERVICE);
    const dispose = await plugin.apply(context);
    expect(global).not.toHaveBeenCalled();
    await dispose?.();
    await dispose?.();
    expect(events).toEqual(['api', 'state']);
  });

  it('rolls back earlier registrations when a later registration fails', async () => {
    const { context, host, events } = fixture();
    host.registerMethod = () => {
      throw new Error('registration failed');
    };
    const plugin = defineServerPlugin({
      name: 'rollback',
      session: {
        api: [api],
        methods: [
          defineServerMethod(
            {
              scope: 'session',
              service: 'test',
              direction: 'client-to-server',
              method: 'test/fail',
              input: Type.Object({}),
              output: Type.Object({}),
            },
            () => ({}),
          ),
        ],
      },
    });
    await expect(plugin.apply(context)).rejects.toThrow('registration failed');
    expect(events).toEqual(['api']);
  });

  it('finishes cleanup even if one disposer throws', async () => {
    const { context, events } = fixture();
    const plugin = defineServerPlugin({
      name: 'cleanup',
      session: {
        api: [api],
        onStop() {
          throw new Error('cleanup failed');
        },
        onDispose() {
          events.push('state');
        },
      },
    });
    const dispose = await plugin.apply(context);
    await expect(dispose?.()).rejects.toThrow(AggregateError);
    expect(events).toEqual(['api', 'state']);
    await expect(dispose?.()).rejects.toThrow(AggregateError);
    expect(events).toEqual(['api', 'state']);
  });

  it('waits for asynchronous disposal before releasing factory state', async () => {
    const { context, host, events } = fixture();
    host.registerApi = () => ({
      dispose: async () => {
        await Promise.resolve();
        events.push('api');
      },
    });
    const plugin = defineServerPlugin({
      name: 'async-cleanup',
      session: () => {
        const value = 'shared';
        return {
          api: [api],
          onDispose() {
            events.push(value);
          },
        };
      },
    });
    const dispose = await plugin.apply(context);
    await dispose?.();
    await dispose?.();
    expect(events).toEqual(['api', 'shared']);
  });
});

describe('named server plugin lifecycle', () => {
  it('registers before onStart and stops before automatic removal and final disposal', async () => {
    const { context, events } = fixture();
    const plugin = defineServerPlugin({
      name: 'test',
      session: ({ signal }) => ({
        api: [api],
        onStart() {
          events.push(`start:${signal.aborted}`);
        },
        onStop() {
          events.push(`stop:${signal.aborted}`);
        },
        onDispose() {
          events.push('dispose');
        },
      }),
    });
    const dispose = await plugin.apply(context);
    await dispose?.();
    await dispose?.();
    expect(events).toEqual(['start:false', 'stop:true', 'api', 'dispose']);
  });

  it('rolls back registration failure without calling start or stop', async () => {
    const { context, events, host } = fixture();
    host.registerMethod = () => {
      throw new Error('method refused');
    };
    const onStart = vi.fn();
    const onStop = vi.fn();
    const plugin = defineServerPlugin({
      name: 'test',
      session: {
        api: [api],
        methods: [
          {
            register: () => {
              throw new Error('method refused');
            },
          },
        ],
        onStart,
        onStop,
        onDispose() {
          events.push('dispose');
        },
      },
    });
    await expect(plugin.apply(context)).rejects.toThrow('method refused');
    expect(onStart).not.toHaveBeenCalled();
    expect(onStop).not.toHaveBeenCalled();
    expect(events).toEqual(['api', 'dispose']);
  });

  it('rolls back failed startup and preserves cleanup errors', async () => {
    const { context, events } = fixture();
    const plugin = defineServerPlugin({
      name: 'test',
      session: {
        api: [api],
        onStart() {
          throw new Error('start failed');
        },
        onStop() {
          events.push('stop');
          throw new Error('stop failed');
        },
        onDispose() {
          events.push('dispose');
        },
      },
    });
    const error = await Promise.resolve(plugin.apply(context)).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors.map((item: Error) => item.message)).toEqual([
      'start failed',
      'stop failed',
    ]);
    expect(events).toEqual(['stop', 'api', 'dispose']);
  });

  it('creates independent instances for each mount and only the selected scope', async () => {
    const first = fixture();
    const second = fixture();
    const signals: AbortSignal[] = [];
    const global = vi.fn(() => ({}));
    const plugin = defineServerPlugin({
      name: 'test',
      global,
      session: ({ signal }) => {
        signals.push(signal);
        return { api: [api] };
      },
    });
    const disposeFirst = await plugin.apply(first.context);
    const disposeSecond = await plugin.apply(second.context);
    expect(global).not.toHaveBeenCalled();
    expect(signals).toHaveLength(2);
    expect(signals[0]).not.toBe(signals[1]);
    await disposeFirst?.();
    expect(signals.map((signal) => signal.aborted)).toEqual([true, false]);
    await disposeSecond?.();
  });
});

describe('declarative server contributions', () => {
  it('adapts portable tools and commands to the agent execution context', async () => {
    const { context } = fixture();
    const registerTool = vi.fn((_tool: Parameters<DoomHeadlessHostService['registerTool']>[0]) => ({ dispose() {} }));
    const registerCommand = vi.fn((_command: Parameters<DoomHeadlessHostService['registerCommand']>[0]) => ({
      dispose() {},
    }));
    context.provide(DOOM_HEADLESS_HOST_SERVICE, {
      registerTool,
      registerCommand,
    } as unknown as DoomHeadlessHostService);
    const notify = vi.fn();
    const plugin = defineServerPlugin({
      name: 'portable',
      session: {
        tools: [
          defineTool({
            name: 'echo',
            description: 'Echo',
            parameters: Type.Object({ text: Type.String() }),
            async execute(input, execution) {
              await execution.notify({ body: input.text, level: 'info' });
              return { content: [{ type: 'text', text: `${execution.cwd}:${input.text}` }] };
            },
          }),
        ],
        commands: [
          defineCommand({
            name: 'hello',
            description: 'Hello',
            execute: (args, execution) => execution.notify({ body: args, level: 'info' }),
          }),
        ],
      },
    });
    const dispose = await plugin.apply(context);
    const tool = registerTool.mock.calls[0]![0] as unknown as Parameters<DoomHeadlessHostService['registerTool']>[0];
    const command = registerCommand.mock.calls[0]![0] as unknown as Parameters<
      DoomHeadlessHostService['registerCommand']
    >[0];
    const execution = { cwd: '/repo', client: { notify } } as unknown as Parameters<typeof command.execute>[1];
    expect(await tool.execute('call', { text: 'hello' }, undefined, undefined, execution)).toEqual({
      content: [{ type: 'text', text: '/repo:hello' }],
    });
    await command.execute('world', execution);
    expect(notify).toHaveBeenNthCalledWith(1, { body: 'hello', level: 'info' });
    expect(notify).toHaveBeenNthCalledWith(2, { body: 'world', level: 'info' });
    await dispose?.();
    await expect(tool.execute('late', { text: 'late' }, undefined, undefined, execution)).rejects.toThrow();
    expect(() => command.execute('late', execution)).toThrow();
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it('owns minor mode handles and detaches the owner on shutdown', async () => {
    const { context, events } = fixture();
    const handle = {
      publish: vi.fn(),
      dispose() {
        events.push('handle');
      },
    };
    const registerOwner = vi.fn(() => handle);
    context.provide(DOOM_HEADLESS_HOST_SERVICE, { assertActive: vi.fn() } as unknown as DoomHeadlessHostService);
    context.provide(DOOM_MINOR_MODE_CATALOG_SERVICE, { registerOwner } as never);
    const mode = {
      definition: {},
      attach: vi.fn(),
      detach() {
        events.push('detach');
      },
    } as unknown as MinorModeOwner;
    const ownerContext = context.extend({ [DOOM_HEADLESS_OWNER]: { packageName: 'mode' } });
    const dispose = await defineServerPlugin({ name: 'mode', session: { services: [serverMinorModes([mode])] } }).apply(
      ownerContext,
    );
    await vi.waitFor(() => expect(mode.attach).toHaveBeenCalled());
    expect(mode.attach).toHaveBeenCalledWith(handle);
    await dispose?.();
    expect(events).toEqual(['detach', 'handle']);
  });

  it('captures typed method handlers and rejects session contributions in other scopes', () => {
    const { host } = fixture();
    const registerMethod = vi.spyOn(host, 'registerMethod');
    const method = defineServerMethod(
      {
        service: 'test',
        method: 'echo',
        scope: 'session',
        direction: 'client-to-server',
        input: Type.Object({ value: Type.String() }),
        output: Type.String(),
      },
      (input) => input.value,
    );
    method.register(host);
    expect(registerMethod).toHaveBeenCalledOnce();
    const invalid: DoomServerPluginDefinition = {
      name: 'invalid',
      // @ts-expect-error Tools are session contributions.
      global: { tools: [] },
    };
    expect(invalid.name).toBe('invalid');
  });
});

describe('server service contributions', () => {
  it('awaits service readiness before registering APIs and starting the plugin', async () => {
    const { context, host, events } = fixture();
    let ready!: () => void;
    const gate = new Promise<void>((resolve) => {
      ready = resolve;
    });
    host.registerApi = () => {
      events.push('api-register');
      return {
        dispose() {
          events.push('api-dispose');
        },
      };
    };
    const plugin = defineServerPlugin({
      name: 'services',
      session: {
        services: [
          async () => {
            events.push('service-start');
            await gate;
            events.push('service-ready');
            return () => {
              events.push('service-dispose');
            };
          },
        ],
        api: [api],
        onStart() {
          events.push('start');
        },
        onStop() {
          events.push('stop');
        },
      },
    });
    const mounting = plugin.apply(context);
    await vi.waitFor(() => expect(events).toEqual(['service-start']));
    ready();
    const dispose = await mounting;
    expect(events).toEqual(['service-start', 'service-ready', 'api-register', 'start']);
    await dispose?.();
    expect(events.slice(-3)).toEqual(['stop', 'api-dispose', 'service-dispose']);
  });

  it('rolls back completed service fibers when a later service fails', async () => {
    const { context, events, host } = fixture();
    const registerApi = vi.spyOn(host, 'registerApi');
    const onStart = vi.fn();
    const plugin = defineServerPlugin({
      name: 'services',
      session: {
        services: [
          () => () => {
            events.push('service-dispose');
          },
          () => {
            throw new Error('service failed');
          },
        ],
        api: [api],
        onStart,
        onDispose() {
          events.push('dispose');
        },
      },
    });
    await expect(plugin.apply(context)).rejects.toThrow('service failed');
    expect(registerApi).not.toHaveBeenCalled();
    expect(onStart).not.toHaveBeenCalled();
    expect(events).toEqual(['service-dispose', 'dispose']);
  });

  it('keeps server contributions available without an optional headless host', async () => {
    const { context, host } = fixture();
    const registerApi = vi.spyOn(host, 'registerApi');
    const onStart = vi.fn();
    const dispose = await defineServerPlugin({
      name: 'optional-agent',
      session: {
        api: [api],
        commands: [defineCommand({ name: 'hello', description: 'Hello', execute() {} })],
        onStart,
      },
    }).apply(context);
    expect(registerApi).toHaveBeenCalledWith(api);
    expect(onStart).toHaveBeenCalledWith(expect.objectContaining({ agent: undefined }));
    await dispose?.();
  });
});

it('awaits asynchronous server discovery before registration and startup', async () => {
  const { context, host } = fixture();
  const entered = discoveryGate();
  const discovered = discoveryGate();
  const register = vi.spyOn(host, 'registerApi');
  const onStart = vi.fn(() => {
    expect(register).toHaveBeenCalledOnce();
  });
  const plugin = defineServerPlugin({
    name: '@test/async-discovery',
    session: async () => {
      entered.resolve();
      await discovered.promise;
      return { api: [api], onStart };
    },
  });
  const mounted = plugin.apply(context);
  await entered.promise;
  expect(register).not.toHaveBeenCalled();
  discovered.resolve();
  const dispose = await mounted;
  expect(onStart).toHaveBeenCalledOnce();
  await dispose?.();
  await context.fiber.dispose();
});

it('disposes a server declaration returned after discovery was aborted', async () => {
  const { context, host } = fixture();
  const entered = discoveryGate();
  const discovered = discoveryGate();
  const register = vi.spyOn(host, 'registerApi');
  const onDispose = vi.fn();
  let signal: AbortSignal | undefined;
  const plugin = defineServerPlugin({
    name: '@test/aborted-discovery',
    session: async (instance) => {
      signal = instance.signal;
      entered.resolve();
      await discovered.promise;
      return { api: [api], onDispose };
    },
  });
  const mounted = plugin.apply(context);
  const rejected = expect(mounted).rejects.toMatchObject({ name: 'AbortError' });
  await entered.promise;
  const disposal = context.fiber.dispose();
  await vi.waitFor(() => expect(signal?.aborted).toBe(true));
  discovered.resolve();
  await rejected;
  await disposal;
  expect(register).not.toHaveBeenCalled();
  expect(onDispose).toHaveBeenCalledOnce();
});

function discoveryGate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it('refreshes reactive server restrictions and drops their listener before final release', async () => {
  const { context } = fixture();
  const releases: string[] = [];
  let allowedTools = ['read'];
  let changed: (() => void) | undefined;
  const registerToolRestriction = vi.fn((restriction: { allowedTools: readonly string[] }) => ({
    dispose() {
      releases.push(restriction.allowedTools.join(','));
    },
  }));
  context.provide(DOOM_HEADLESS_HOST_SERVICE, { registerToolRestriction } as unknown as DoomHeadlessHostService);
  const plugin = defineServerPlugin({
    name: '@test/reactive-restriction',
    session: {
      toolRestrictions: [
        {
          source: '@test/reactive-restriction',
          restrict: () => ({ minorMode: 'review', allowedTools }),
          subscribe(listener) {
            changed = listener;
            return () => {
              changed = undefined;
              releases.push('unsubscribe');
            };
          },
        },
      ],
    },
  });
  const dispose = await plugin.apply(context);
  expect(registerToolRestriction).toHaveBeenLastCalledWith({ minorMode: 'review', allowedTools: ['read'] });
  allowedTools = ['edit'];
  changed?.();
  expect(registerToolRestriction).toHaveBeenLastCalledWith({ minorMode: 'review', allowedTools: ['edit'] });
  await dispose?.();
  expect(releases).toEqual(['read', 'unsubscribe', 'edit']);
  expect(changed).toBeUndefined();
  await context.fiber.dispose();
  expect(releases).toHaveLength(3);
});
