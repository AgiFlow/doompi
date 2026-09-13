import { access, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { Context } from '@deepseek-ai/cordis';
import { type TSchema, Type } from 'typebox';
import { describe, expect, it, vi } from 'vitest';

import type { EventBusLike } from '../../src/schemas/protocol';

interface PackageManifest {
  exports?: Record<string, unknown>;
}

interface NotificationDefinition {
  channel: string;
  kind: string;
  payload: TSchema;
}

interface ProtocolRuntime {
  notify(definition: NotificationDefinition, payload: unknown): void;
  onNotification(
    definition: NotificationDefinition,
    handler: (payload: unknown, identity: unknown) => void | Promise<void>,
  ): () => void;
}

interface RuntimeModule {
  createProtocolRuntime(options: { bus: EventBusLike; source: string; sessionId: string }): ProtocolRuntime;
  defineNotification(definition: NotificationDefinition): NotificationDefinition;
}

interface DoomNotificationService {
  readonly generation: string;
  request(request: { body: string; level?: 'info' | 'warning' | 'error' }): void | Promise<void>;
}

interface NotificationRuntimeModule {
  readonly DOOM_NOTIFICATION_SERVICE: 'doom/notification';
  readDoomNotificationService(context: Context): DoomNotificationService | undefined;
  requireDoomNotificationService(context: Context): DoomNotificationService;
}

interface CordisHostModule {
  installDoomCordisHost(
    pi: unknown,
    options: { mode: 'composed' | 'standalone' },
  ): Promise<{ root: unknown; shutdown(): Promise<void> }>;
  connectDoomCordisHost(pi: unknown, source: string): Promise<{ root: unknown; dispose(): Promise<void> }>;
}

const packageDirectory = fileURLToPath(new URL('../..', import.meta.url));
const manifestPath = path.join(packageDirectory, 'package.json');
const requireFromTest = createRequire(import.meta.url);

function targetPaths(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.values(value).flatMap(targetPaths);
}

function conditionPath(exportsMap: Record<string, unknown>, subpath: string, condition: string): string {
  const target = exportsMap[subpath];
  if (target === null || typeof target !== 'object' || Array.isArray(target)) {
    throw new Error(`Expected conditional exports for ${subpath}.`);
  }
  const conditionTarget = (target as Record<string, unknown>)[condition];
  const [resolved] = targetPaths(conditionTarget);
  if (!resolved) throw new Error(`Missing ${condition} export for ${subpath}.`);
  return path.resolve(packageDirectory, resolved);
}

async function loadBuiltRuntimes(): Promise<{ esm: RuntimeModule; cjs: RuntimeModule }> {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as PackageManifest;
  const exportsMap = manifest.exports ?? {};
  const esmPath = conditionPath(exportsMap, './protocol', 'import');
  const cjsPath = conditionPath(exportsMap, './protocol', 'require');
  await access(esmPath);
  await access(cjsPath);
  const esm = (await import(pathToFileURL(esmPath).href)) as unknown as RuntimeModule;
  const cjs = requireFromTest(cjsPath) as RuntimeModule;
  return { esm, cjs };
}

async function loadBuiltNotificationRuntimes(): Promise<{
  esm: NotificationRuntimeModule;
  cjs: NotificationRuntimeModule;
}> {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as PackageManifest;
  const exportsMap = manifest.exports ?? {};
  const esmPath = conditionPath(exportsMap, './notification', 'import');
  const cjsPath = conditionPath(exportsMap, './notification', 'require');
  await access(esmPath);
  await access(cjsPath);
  const esm = (await import(pathToFileURL(esmPath).href)) as unknown as NotificationRuntimeModule;
  const cjs = requireFromTest(cjsPath) as NotificationRuntimeModule;
  return { esm, cjs };
}

async function loadBuiltCordisHosts(): Promise<{ esm: CordisHostModule; cjs: CordisHostModule }> {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as PackageManifest;
  const exportsMap = manifest.exports ?? {};
  const esmPath = conditionPath(exportsMap, './cordis-host', 'import');
  const cjsPath = conditionPath(exportsMap, './cordis-host', 'require');
  await access(esmPath);
  await access(cjsPath);
  const esm = (await import(pathToFileURL(esmPath).href)) as unknown as CordisHostModule;
  const cjs = requireFromTest(cjsPath) as CordisHostModule;
  return { esm, cjs };
}

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
}

describe('separately built contract bundles', () => {
  it('exchange a typed notification between ESM producer and CJS consumer', async () => {
    const { esm, cjs } = await loadBuiltRuntimes();
    const bus = new TestBus();
    const producerDefinition = esm.defineNotification({
      channel: 'doom:cross-bundle:v1:changed',
      kind: 'cross-bundle.changed',
      payload: Type.Object({ value: Type.String() }, { additionalProperties: false }),
    });
    const consumerDefinition = cjs.defineNotification({
      channel: producerDefinition.channel as `doom:${string}:${string}:v1:${string}`,
      kind: producerDefinition.kind,
      payload: Type.Object({ value: Type.String() }, { additionalProperties: false }),
    });
    const received = vi.fn();
    const consumer = cjs.createProtocolRuntime({ bus, source: 'consumer', sessionId: 'session-1' });
    const producer = esm.createProtocolRuntime({ bus, source: 'producer', sessionId: 'session-1' });
    consumer.onNotification(consumerDefinition, received);

    producer.notify(producerDefinition, { value: 'typed payload' });
    await Promise.resolve();

    expect(received).toHaveBeenCalledWith({ value: 'typed payload' }, expect.objectContaining({ source: 'producer' }));
  });

  it('keeps schema validation active across the bundle boundary', async () => {
    const { esm } = await loadBuiltRuntimes();
    const definition = esm.defineNotification({
      channel: 'doom:cross-bundle:v1:validated',
      kind: 'cross-bundle.validated',
      payload: Type.Object({ value: Type.String() }, { additionalProperties: false }),
    });
    const runtime = esm.createProtocolRuntime({ bus: new TestBus(), source: 'producer', sessionId: 'session-1' });

    expect(() => runtime.notify(definition, { value: 42 })).toThrow(/Invalid message/u);
  });

  it('discovers and validates one Cordis host across ESM and CJS copies', async () => {
    const { esm, cjs } = await loadBuiltCordisHosts();
    const bus = new TestBus();
    const lifecycle = new Map<string, Array<(event: unknown, context: unknown) => unknown>>();
    const pi = () => ({
      events: { emit: bus.emit.bind(bus), on: bus.on.bind(bus) },
      on(name: string, handler: (event: unknown, context: unknown) => unknown) {
        lifecycle.set(name, [...(lifecycle.get(name) ?? []), handler]);
      },
    });
    const controller = await esm.installDoomCordisHost(pi(), { mode: 'composed' });
    const connection = await cjs.connectDoomCordisHost(pi(), '@cross-bundle/consumer');

    expect(connection.root).toBe(controller.root);
    await connection.dispose();
    await controller.shutdown();
  });

  it('shares a notification service across ESM and CJS copies through Cordis', async () => {
    const { esm, cjs } = await loadBuiltNotificationRuntimes();
    const root = new Context();
    const request = vi.fn();
    const service: DoomNotificationService = { generation: 'esm-notification-provider', request };
    const fiber = root.plugin((context) => context.provide(esm.DOOM_NOTIFICATION_SERVICE, service));
    await fiber.await();

    expect(cjs.readDoomNotificationService(root)).toBe(service);
    await cjs.requireDoomNotificationService(root).request({ body: 'Cross bundle ready.', level: 'info' });
    expect(request).toHaveBeenCalledWith({ body: 'Cross bundle ready.', level: 'info' });

    await fiber.dispose();
    expect(cjs.readDoomNotificationService(root)).toBeUndefined();
    await root.fiber.dispose();
  });
});
