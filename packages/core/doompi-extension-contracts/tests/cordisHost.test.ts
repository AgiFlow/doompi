import {
  connectDoomCordisHost,
  DOOM_CORDIS_HOST_QUERY_CHANNEL,
  DOOM_CORDIS_RUNTIME_SERVICE,
  DOOM_CORDIS_SESSION_SERVICE,
  finalizeDoomCordisHost,
  installDoomCordisHost,
} from '../src/controllers/cordisHost';
import { DOOM_CONTEXT_CONTRIBUTIONS_SERVICE } from '../src/schemas/contextContributions';
import { DOOM_TOOL_OVERRIDES_SERVICE } from '../src/schemas/toolOverrides';
import { Context } from '@deepseek-ai/cordis';
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionShutdownEvent,
  SessionStartEvent,
} from '@earendil-works/pi-coding-agent';
import { describe, expect, it } from 'vitest';
import type { EventBusLike } from '../src/schemas/protocol';

type LifecycleHandler = (event: never, context: ExtensionContext) => unknown;

class TestBus implements EventBusLike {
  private readonly handlers = new Map<string, Set<(data: unknown) => void>>();

  emit(event: string, data: unknown): void {
    for (const handler of this.handlers.get(event) ?? []) handler(data);
  }

  on(event: string, handler: (data: unknown) => void): () => void {
    const handlers = this.handlers.get(event) ?? new Set();
    handlers.add(handler);
    this.handlers.set(event, handlers);
    return () => handlers.delete(handler);
  }

  listenerCount(event: string): number {
    return this.handlers.get(event)?.size ?? 0;
  }
}

function testPi(bus: TestBus): {
  readonly pi: ExtensionAPI;
  dispatch(event: SessionStartEvent | SessionShutdownEvent, context?: ExtensionContext): Promise<void>;
} {
  const handlers = new Map<string, LifecycleHandler[]>();
  const events = {
    emit: bus.emit.bind(bus),
    on: bus.on.bind(bus),
  };
  const pi = {
    events,
    on(name: string, handler: LifecycleHandler) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
  } as unknown as ExtensionAPI;
  const defaultContext = testContext();
  return {
    pi,
    async dispatch(event, context = defaultContext) {
      for (const handler of handlers.get(event.type) ?? []) await handler(event as never, context);
    },
  };
}

function testContext(
  sessionManager: { readonly getSessionId: () => string } = { getSessionId: () => 'session-1' },
): ExtensionContext {
  return { sessionManager } as unknown as ExtensionContext;
}

describe('Doom Cordis host contract', () => {
  it('discovers one host across distinct ExtensionAPI event wrappers', async () => {
    const bus = new TestBus();
    const host = testPi(bus);
    const consumer = testPi(bus);
    const controller = await installDoomCordisHost(host.pi, { mode: 'composed' });
    const connection = await connectDoomCordisHost(consumer.pi, '@test/consumer');

    expect(connection.root).toBe(controller.root);
    expect(Context.is(connection.root)).toBe(true);
    expect(connection.root.reflect.get(DOOM_CORDIS_RUNTIME_SERVICE)).toEqual(connection.runtime);
    expect(connection.root.get(DOOM_TOOL_OVERRIDES_SERVICE)).toMatchObject({
      generation: connection.runtime.generation,
    });

    await connection.dispose();
    await connection.dispose();
    expect(connection.root.reflect.get(DOOM_CORDIS_RUNTIME_SERVICE)).toEqual(connection.runtime);
    await controller.shutdown();
    expect(connection.root.get(DOOM_TOOL_OVERRIDES_SERVICE)).toBeUndefined();
    expect(bus.listenerCount(DOOM_CORDIS_HOST_QUERY_CHANNEL)).toBe(0);
  });

  it('replaces the provider-owned session service by generation', async () => {
    const bus = new TestBus();
    const host = testPi(bus);
    const controller = await installDoomCordisHost(host.pi, { mode: 'composed' });
    const sessionManager = { getSessionId: () => 'session-1' };
    const firstContext = testContext(sessionManager);

    await host.dispatch({ type: 'session_start', reason: 'startup' }, firstContext);
    const first = controller.root.get(DOOM_CORDIS_SESSION_SERVICE);
    const firstContributions = controller.root.get(DOOM_CONTEXT_CONTRIBUTIONS_SERVICE);
    expect(first).toMatchObject({ sessionId: 'session-1', reason: 'startup', context: firstContext });
    expect(firstContributions).toMatchObject({ generation: (first as { generation: string }).generation });

    const reloadedContext = testContext(sessionManager);
    await host.dispatch({ type: 'session_start', reason: 'reload' }, reloadedContext);
    const second = controller.root.get(DOOM_CORDIS_SESSION_SERVICE);
    const secondContributions = controller.root.get(DOOM_CONTEXT_CONTRIBUTIONS_SERVICE);
    expect(second).toMatchObject({ sessionId: 'session-1', reason: 'reload', context: reloadedContext });
    expect(second === first).toBe(false);
    expect((second as { generation: string }).generation).not.toBe((first as { generation: string }).generation);
    expect(secondContributions).not.toBe(firstContributions);
    expect(secondContributions).toMatchObject({ generation: (second as { generation: string }).generation });

    await controller.shutdown();
    expect(controller.root.get(DOOM_CORDIS_SESSION_SERVICE)).toBeUndefined();
    expect(controller.root.get(DOOM_CONTEXT_CONTRIBUTIONS_SERVICE)).toBeUndefined();
  });

  it('rejects duplicate hosts and invalid cross-bundle Context responses', async () => {
    const bus = new TestBus();
    const first = testPi(bus);
    const second = testPi(bus);
    const controller = await installDoomCordisHost(first.pi, { mode: 'composed' });

    await expect(installDoomCordisHost(second.pi, { mode: 'composed' })).rejects.toThrow(
      'A Doom Cordis host is already installed',
    );
    const duplicateRoot = new Context();
    const duplicateResponse = {
      protocol: 'doom.cordis.host',
      abiVersion: 1,
      hostId: 'duplicate-host',
      root: duplicateRoot,
      runtime: { abiVersion: 1, hostId: 'duplicate-host', generation: 'duplicate-generation', mode: 'composed' },
      ready: Promise.resolve(),
      acquire: () => ({ root: duplicateRoot, runtime: {}, dispose: async () => undefined }),
      shutdown: async () => undefined,
    };
    const releaseDuplicate = bus.on(DOOM_CORDIS_HOST_QUERY_CHANNEL, (value) => {
      (value as { accept?: (response: unknown) => void }).accept?.(duplicateResponse);
    });
    await expect(connectDoomCordisHost(second.pi, '@test/duplicate')).rejects.toThrow(
      'Multiple Doom Cordis hosts answered',
    );
    releaseDuplicate();
    await duplicateRoot.fiber.dispose();
    await controller.shutdown();

    const release = bus.on(DOOM_CORDIS_HOST_QUERY_CHANNEL, (value) => {
      const query = value as { accept?: (response: unknown) => void };
      query.accept?.({
        protocol: 'doom.cordis.host',
        abiVersion: 1,
        hostId: 'invalid-host',
        root: {},
      });
    });
    await expect(connectDoomCordisHost(second.pi, '@test/invalid')).rejects.toThrow('not a Cordis Context');
    release();
  });

  it('ignores malformed discovery queries without disturbing the installed host', async () => {
    const bus = new TestBus();
    const host = testPi(bus);
    const controller = await installDoomCordisHost(host.pi, { mode: 'composed' });
    const accept = () => undefined;
    for (const query of [
      undefined,
      null,
      'query',
      {},
      { protocol: 'wrong', abiVersion: 1, kind: 'query', requestId: 'id', source: 'test', accept },
      { protocol: 'doom.cordis.host', abiVersion: 2, kind: 'query', requestId: 'id', source: 'test', accept },
      { protocol: 'doom.cordis.host', abiVersion: 1, kind: 'reply', requestId: 'id', source: 'test', accept },
      { protocol: 'doom.cordis.host', abiVersion: 1, kind: 'query', requestId: 1, source: 'test', accept },
      { protocol: 'doom.cordis.host', abiVersion: 1, kind: 'query', requestId: '', source: 'test', accept },
      { protocol: 'doom.cordis.host', abiVersion: 1, kind: 'query', requestId: 'id', source: 1, accept },
      { protocol: 'doom.cordis.host', abiVersion: 1, kind: 'query', requestId: 'id', source: '', accept },
      { protocol: 'doom.cordis.host', abiVersion: 1, kind: 'query', requestId: 'id', source: 'test', accept: true },
    ]) {
      expect(() => bus.emit(DOOM_CORDIS_HOST_QUERY_CHANNEL, query)).not.toThrow();
    }
    const connection = await connectDoomCordisHost(testPi(bus).pi, '@test/valid');
    expect(connection.root).toBe(controller.root);
    await connection.dispose();
    await controller.shutdown();
  });

  it('rejects each malformed host response with a specific discovery error', async () => {
    const root = new Context();
    const runtime = { abiVersion: 1, hostId: 'host', generation: 'generation', mode: 'composed' };
    const valid = {
      protocol: 'doom.cordis.host',
      abiVersion: 1,
      hostId: 'host',
      root,
      runtime,
      ready: Promise.resolve(),
      acquire: () => ({ root, runtime, dispose: async () => undefined }),
      shutdown: async () => undefined,
    };
    const cases: Array<[unknown, RegExp]> = [
      [null, /invalid discovery response/u],
      [{ ...valid, protocol: 'wrong' }, /invalid protocol identifier/u],
      [{ ...valid, abiVersion: 2 }, /ABI is incompatible/u],
      [{ ...valid, hostId: 1 }, /invalid host identifier/u],
      [{ ...valid, hostId: '' }, /invalid host identifier/u],
      [{ ...valid, root: {} }, /not a Cordis Context/u],
      [{ ...valid, runtime: null }, /incomplete runtime metadata/u],
      [{ ...valid, runtime: { ...runtime, abiVersion: 2 } }, /incomplete runtime metadata/u],
      [{ ...valid, runtime: { ...runtime, hostId: 'other' } }, /incomplete runtime metadata/u],
      [{ ...valid, acquire: true }, /incomplete runtime metadata/u],
      [{ ...valid, shutdown: true }, /incomplete runtime metadata/u],
      [{ ...valid, ready: null }, /incomplete runtime metadata/u],
      [{ ...valid, ready: {} }, /incomplete runtime metadata/u],
    ];
    for (const [response, message] of cases) {
      const bus = new TestBus();
      const release = bus.on(DOOM_CORDIS_HOST_QUERY_CHANNEL, (value) => {
        (value as { accept: (candidate: unknown) => void }).accept(response);
      });
      await expect(connectDoomCordisHost(testPi(bus).pi, '@test/invalid')).rejects.toThrow(message);
      release();
    }
    await root.fiber.dispose();
  });

  it('rejects new leases after shutdown begins', async () => {
    const bus = new TestBus();
    const host = testPi(bus);
    const controller = await installDoomCordisHost(host.pi, { mode: 'composed', source: '@test/host' });
    let responder: unknown;
    bus.emit(DOOM_CORDIS_HOST_QUERY_CHANNEL, {
      protocol: 'doom.cordis.host',
      abiVersion: 1,
      kind: 'query',
      requestId: 'manual-query',
      source: '@test/manual',
      accept(value: unknown) {
        responder = value;
      },
    });
    await controller.shutdown();
    expect(() => (responder as { acquire(): unknown }).acquire()).toThrow('host is shutting down');
    await controller.shutdown();
  });

  it('recovers the serialized session queue after a failed session start', async () => {
    const bus = new TestBus();
    const host = testPi(bus);
    const controller = await installDoomCordisHost(host.pi, { mode: 'composed' });
    await expect(
      host.dispatch(
        { type: 'session_start', reason: 'startup' },
        testContext({
          getSessionId: () => {
            throw new Error('session unavailable');
          },
        }),
      ),
    ).rejects.toThrow('session unavailable');
    await expect(host.dispatch({ type: 'session_start', reason: 'reload' }, testContext())).resolves.toBeUndefined();
    expect(controller.root.get(DOOM_CORDIS_SESSION_SERVICE)).toMatchObject({
      sessionId: 'session-1',
      reason: 'reload',
    });
    await controller.shutdown();
  });

  it('removes standalone discovery during Pi session shutdown', async () => {
    const bus = new TestBus();
    const host = testPi(bus);
    const controller = await installDoomCordisHost(host.pi, { mode: 'standalone' });
    expect(bus.listenerCount(DOOM_CORDIS_HOST_QUERY_CHANNEL)).toBe(1);
    await host.dispatch({ type: 'session_shutdown', reason: 'quit' });
    expect(bus.listenerCount(DOOM_CORDIS_HOST_QUERY_CHANNEL)).toBe(0);
    await controller.shutdown();
  });

  it('fails closed when the composed host is unavailable', async () => {
    const { pi } = testPi(new TestBus());
    await expect(connectDoomCordisHost(pi, '@test/required')).rejects.toThrow(
      'composed Doom Cordis host is unavailable',
    );
  });

  it('rolls back host discovery when Pi lifecycle registration fails', async () => {
    const bus = new TestBus();
    const pi = {
      events: {
        emit: bus.emit.bind(bus),
        on: bus.on.bind(bus),
      },
      on() {
        throw new Error('lifecycle registration failed');
      },
    } as unknown as ExtensionAPI;

    await expect(installDoomCordisHost(pi, { mode: 'composed' })).rejects.toThrow('lifecycle registration failed');
    expect(bus.listenerCount(DOOM_CORDIS_HOST_QUERY_CHANNEL)).toBe(0);
  });

  it('finalizes idempotently after all feature connections release', async () => {
    const bus = new TestBus();
    const host = testPi(bus);
    const controller = await installDoomCordisHost(host.pi, { mode: 'composed' });
    const connection = await connectDoomCordisHost(host.pi, '@test/feature');

    await connection.dispose();
    await finalizeDoomCordisHost(host.pi, '@test/finalizer');
    await finalizeDoomCordisHost(host.pi, '@test/finalizer');
    await expect(host.dispatch({ type: 'session_start', reason: 'reload' })).resolves.toBeUndefined();

    expect(controller.root.reflect.get(DOOM_CORDIS_RUNTIME_SERVICE)).toBeUndefined();
    expect(controller.root.reflect.get(DOOM_CORDIS_SESSION_SERVICE)).toBeUndefined();
  });
});
