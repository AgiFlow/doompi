import { piMinorModes } from '../../src/services/piRegistration';
import { Context } from '@deepseek-ai/cordis';
import type { BeforeAgentStartEvent, ExtensionEvent } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { definePiExtension, type PiEventHandlers } from '@agimon-ai/doompi-core/pi-extension';
import { createPiTestHost } from '@agimon-ai/doompi-core/testing';
import { createDoomHelpService, DOOM_HELP_SERVICE } from '@agimon-ai/doompi-core/help';
import { DOOM_MINOR_MODE_CATALOG_SERVICE, type MinorModeCatalogService } from '../../src/schemas/mode';
import { defineMinorMode } from '../../src/services/modeDefinition';
import { defineCommand, defineTool } from '@agimon-ai/doompi-core/pi-extension';

describe('declarative Pi extension', () => {
  it('disposes the plugin when shutdown registration fails', async () => {
    const host = createPiTestHost();
    await host.cordis();
    const disposed = vi.fn();
    const extension = definePiExtension({ name: '@test/shutdown-registration', onDispose: disposed });
    const failure = new Error('shutdown registration failed');
    const on = vi.spyOn(host.pi, 'on').mockImplementation(() => {
      throw failure;
    });
    await expect(extension(host.pi)).rejects.toBe(failure);
    expect(disposed).toHaveBeenCalledOnce();
    on.mockRestore();
    await host.dispose();
    expect(disposed).toHaveBeenCalledOnce();
  });

  it('runs contributed shutdown handlers before plugin teardown', async () => {
    const host = createPiTestHost();
    await host.cordis();
    const order: string[] = [];
    const extension = definePiExtension({
      name: '@test/shutdown-order',
      events: {
        session_shutdown: async () => {
          await Promise.resolve();
          order.push('flush');
        },
      },
      onStop: () => {
        order.push('stop');
      },
      onDispose: () => {
        order.push('dispose');
      },
    });
    await extension(host.pi);
    await host.emit('session_shutdown', { reason: 'quit' });
    expect(order).toEqual(['flush', 'stop', 'dispose']);
    await host.dispose();
  });

  it('retains every native event and its specific input and result contract', async () => {
    expectTypeOf<Exclude<ExtensionEvent['type'], keyof PiEventHandlers>>().toEqualTypeOf<never>();
    const host = createPiTestHost();
    const context = new Context();
    const extension = definePiExtension({
      name: '@test/events',
      events: {
        before_agent_start(event) {
          expectTypeOf(event).toEqualTypeOf<BeforeAgentStartEvent>();
          return { systemPrompt: `${event.systemPrompt} appended` };
        },
      },
    });
    // @ts-expect-error A numeric prompt is not a native before_agent_start result.
    const invalid: PiEventHandlers = { before_agent_start: () => ({ systemPrompt: 42 }) };
    expect(invalid.before_agent_start).toBeTypeOf('function');
    await extension.install(context, host.pi);
    await expect(host.emit('before_agent_start', { systemPrompt: 'original' })).resolves.toEqual([
      { systemPrompt: 'original appended' },
    ]);
    await context.fiber.dispose();
    await host.dispose();
  });

  it('awaits startup rollback and withdraws registered resources before rejecting', async () => {
    const host = createPiTestHost();
    const context = new Context();
    const help = createDoomHelpService('startup');
    context.provide(DOOM_HELP_SERVICE, help);
    const events: string[] = [];
    const failure = new Error('start failed');
    const extension = definePiExtension({
      name: '@test/rollback',
      resources: [
        { source: '@test/rollback', moduleUrl: import.meta.url, skills: [{ name: 'test-skill', description: 'Test' }] },
      ],
      async onStart() {
        expect(help.listContributions()).toHaveLength(1);
        await Promise.resolve();
        throw failure;
      },
      async onStop() {
        expect(help.listContributions()).toHaveLength(1);
        await Promise.resolve();
        events.push('stopped');
      },
      onDispose() {
        expect(help.listContributions()).toEqual([]);
        events.push('disposed');
      },
    });
    await expect(extension.install(context, host.pi)).rejects.toBe(failure);
    expect(events).toEqual(['stopped', 'disposed']);
    await context.fiber.dispose();
    expect(events).toEqual(['stopped', 'disposed']);
    help.dispose();
    await host.dispose();
  });

  it('adapts shared tools and commands with inferred schema input and cancellation', async () => {
    const host = createPiTestHost({ cwd: '/repo' });
    const context = new Context();
    const update = vi.fn();
    let toolSignal: AbortSignal | undefined;
    const extension = definePiExtension({
      name: '@test/shared',
      tools: [
        defineTool({
          name: 'echo',
          description: 'Echo text',
          parameters: Type.Object({ text: Type.String() }),
          executionMode: 'serial',
          async execute(input, execution) {
            expectTypeOf(input.text).toEqualTypeOf<string>();
            expect(execution.cwd).toBe('/repo');
            expect(execution.toolCallId).toBe('call-1');
            toolSignal = execution.signal;
            execution.update({ content: [{ type: 'text', text: 'working' }] });
            return { content: [{ type: 'text', text: input.text }] };
          },
        }),
      ],
      commands: [
        defineCommand({
          name: 'announce',
          description: 'Announce text',
          async execute(args, execution) {
            await execution.notify({ body: args, level: 'info' });
          },
        }),
      ],
    });
    await extension.install(context, host.pi);
    expect(host.tool('echo')?.executionMode).toBe('sequential');
    await expect(
      host.callTool('echo', { text: 'hello' }, { toolCallId: 'call-1', onUpdate: update }),
    ).resolves.toMatchObject({
      content: [{ type: 'text', text: 'hello' }],
    });
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ content: [{ type: 'text', text: 'working' }] }));
    await host.runCommand('announce', 'ready');
    expect(host.notifications).toContainEqual(expect.objectContaining({ message: 'ready', level: 'info' }));
    await context.fiber.dispose();
    expect(toolSignal?.aborted).toBe(true);
    await expect(host.callTool('echo', { text: 'late' })).rejects.toMatchObject({ name: 'AbortError' });
    await expect(host.runCommand('announce', 'late')).rejects.toMatchObject({ name: 'AbortError' });
    await host.dispose();
  });

  it('creates independent factory state and calls lifecycle hooks with the same typed context', async () => {
    const host = createPiTestHost();
    const first = new Context();
    const second = new Context();
    const events: string[] = [];
    const extension = definePiExtension<{ label: string }>('@test/state', (context) => {
      const label = context.options!.label;
      return {
        async onStart(start) {
          expect(start).toBe(context);
          expect(start.signal.aborted).toBe(false);
          events.push(`start:${label}`);
          await Promise.resolve();
        },
        onStop(stop) {
          expect(stop).toBe(context);
          expect(stop.signal.aborted).toBe(true);
          events.push(`stop:${label}`);
        },
        onDispose() {
          events.push(`dispose:${label}`);
        },
      };
    });
    await extension.install(first, host.pi, { label: 'one' });
    await extension.install(second, host.pi, { label: 'two' });
    await first.fiber.dispose();
    expect(events).toEqual(['start:one', 'start:two', 'stop:one', 'dispose:one']);
    await second.fiber.dispose();
    expect(events.slice(-2)).toEqual(['stop:two', 'dispose:two']);
    await host.dispose();
  });

  it('mounts without optional providers, rebinds resources, and does not restart', async () => {
    const root = new Context();
    const host = createPiTestHost();
    const onStart = vi.fn();
    const extension = definePiExtension({
      name: '@test/resources',
      onStart,
      resources: [
        {
          source: '@test/resources',
          moduleUrl: import.meta.url,
          skills: [{ name: 'test-skill', description: 'Test' }],
        },
      ],
    });
    const plugin = root.plugin((context) => extension.install(context, host.pi));
    await plugin;
    expect(onStart).toHaveBeenCalledOnce();
    const first = createDoomHelpService('first');
    const firstProvider = root.plugin((context) => context.provide(DOOM_HELP_SERVICE, first));
    await firstProvider;
    expect(first.listContributions()).toHaveLength(1);
    await firstProvider.dispose();
    expect(first.listContributions()).toEqual([]);
    const second = createDoomHelpService('second');
    const secondProvider = root.plugin((context) => context.provide(DOOM_HELP_SERVICE, second));
    await secondProvider;
    expect(second.listContributions()).toHaveLength(1);
    expect(onStart).toHaveBeenCalledOnce();
    await plugin.dispose();
    expect(second.listContributions()).toEqual([]);
    await root.fiber.dispose();
    first.dispose();
    second.dispose();
    await host.dispose();
  });

  it('attaches a minor mode owner to replacement catalogs and detaches on shutdown', async () => {
    const host = createPiTestHost();
    const root = new Context();
    const owner = defineMinorMode({
      descriptor: { source: '@test/mode', id: 'review', label: 'Review', description: 'Review', order: 1, actions: [] },
      state: () => ({ activation: 'inactive', condition: 'ready', actions: [] }),
      handleAction() {},
    }).createOwner(undefined);
    const onStart = vi.fn();
    const extension = definePiExtension({ name: '@test/mode', services: [piMinorModes([owner])], onStart });
    const plugin = root.plugin((context) => extension.install(context, host.pi));
    await plugin;
    const catalog = (generation: string) => {
      const publish = vi.fn();
      const dispose = vi.fn();
      const registerOwner = vi.fn(() => ({ getState: () => owner.state(), publish, dispose }));
      const service: MinorModeCatalogService = {
        generation,
        registerOwner,
        getSnapshot: vi.fn(),
        list: vi.fn(),
        subscribe: vi.fn(),
        invoke: vi.fn(),
        dispose: vi.fn(),
      };
      return { service, publish, dispose, registerOwner };
    };
    const first = catalog('first');
    const firstProvider = root.plugin((context) => context.provide(DOOM_MINOR_MODE_CATALOG_SERVICE, first.service));
    await firstProvider;
    owner.publish();
    expect(first.publish).toHaveBeenCalledOnce();
    await firstProvider.dispose();
    owner.publish();
    expect(first.publish).toHaveBeenCalledOnce();
    expect(first.dispose).toHaveBeenCalledOnce();
    const second = catalog('second');
    const secondProvider = root.plugin((context) => context.provide(DOOM_MINOR_MODE_CATALOG_SERVICE, second.service));
    await secondProvider;
    owner.publish();
    expect(second.publish).toHaveBeenCalledOnce();
    expect(onStart).toHaveBeenCalledOnce();
    await plugin.dispose();
    owner.publish();
    expect(second.publish).toHaveBeenCalledOnce();
    expect(second.dispose).toHaveBeenCalledOnce();
    await root.fiber.dispose();
    await host.dispose();
  });
});

it('aborts asynchronous Pi discovery before it can publish late contributions', async () => {
  const context = new Context();
  const host = createPiTestHost();
  const entered = discoveryGate();
  const discovered = discoveryGate();
  const disposed = vi.fn();
  let signal: AbortSignal | undefined;
  const register = vi.spyOn(host.pi, 'registerCommand');
  const extension = definePiExtension('@test/async-discovery', async (instance) => {
    signal = instance.signal;
    entered.resolve();
    await discovered.promise;
    return { commands: [defineCommand({ name: 'late', description: 'late', execute() {} })], onDispose: disposed };
  });
  const mounted = extension.install(context, host.pi);
  const rejected = expect(mounted).rejects.toMatchObject({ name: 'AbortError' });
  await entered.promise;
  const disposal = context.fiber.dispose();
  await vi.waitFor(() => expect(signal?.aborted).toBe(true));
  discovered.resolve();
  await rejected;
  await disposal;
  expect(register).not.toHaveBeenCalled();
  expect(disposed).toHaveBeenCalledOnce();
  await host.dispose();
});

function discoveryGate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it('reconciles live minor modes by identity, replaces owners, and ignores changes after disposal', async () => {
  const host = createPiTestHost();
  const root = new Context();
  const makeOwner = () =>
    defineMinorMode({
      descriptor: {
        source: '@test/live-mode',
        id: 'review',
        label: 'Review',
        description: 'Review',
        order: 1,
        actions: [],
      },
      state: () => ({ activation: 'inactive', condition: 'ready', actions: [] }),
      handleAction() {},
    }).createOwner(undefined);
  const first = makeOwner();
  const second = makeOwner();
  let snapshot = [first];
  let changed: (() => void) | undefined;
  const dispose = vi.fn();
  const publish = vi.fn();
  const registerOwner = vi.fn(() => ({ getState: () => first.state(), publish, dispose }));
  root.provide(DOOM_MINOR_MODE_CATALOG_SERVICE, {
    generation: 'live',
    registerOwner,
    getSnapshot: vi.fn(),
    list: vi.fn(),
    subscribe: vi.fn(),
    invoke: vi.fn(),
    dispose: vi.fn(),
  } satisfies MinorModeCatalogService);
  const unsubscribe = vi.fn();
  const extension = definePiExtension({
    name: '@test/live-mode',
    services: [
      piMinorModes({
        snapshot: () => snapshot,
        subscribe(listener) {
          changed = listener;
          listener();
          return unsubscribe;
        },
      }),
    ],
  });
  const plugin = root.plugin((context) => extension.install(context, host.pi));
  await plugin;
  expect(registerOwner).toHaveBeenCalledOnce();
  changed?.();
  expect(registerOwner).toHaveBeenCalledOnce();
  snapshot = [second];
  changed?.();
  expect(dispose).toHaveBeenCalledOnce();
  expect(registerOwner).toHaveBeenCalledTimes(2);
  first.publish();
  expect(publish).not.toHaveBeenCalled();
  second.publish();
  expect(publish).toHaveBeenCalledOnce();
  snapshot = [];
  changed?.();
  expect(dispose).toHaveBeenCalledTimes(2);
  snapshot = [first];
  changed?.();
  expect(registerOwner).toHaveBeenCalledTimes(3);
  await plugin.dispose();
  expect(unsubscribe).toHaveBeenCalledOnce();
  expect(dispose).toHaveBeenCalledTimes(3);
  snapshot = [second];
  changed?.();
  expect(registerOwner).toHaveBeenCalledTimes(3);
  await root.fiber.dispose();
  await host.dispose();
});
