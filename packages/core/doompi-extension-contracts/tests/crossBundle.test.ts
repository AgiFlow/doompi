import { access, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import { type TSchema, Type } from 'typebox';
import { describe, expect, it, vi } from 'vitest';
import type { EventBusLike } from '../src/schemas/protocol.ts';

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

interface VoiceToolSession {
  readonly sessionId: string;
  readonly hostGeneration: string;
  readonly active: boolean;
  setActive(active: boolean): void;
  describe(): { catalogToken: string; tools: Array<{ name: string }> };
  executeBatch(input: unknown, context: unknown): Promise<{ status: string }>;
  dispose(): void;
}

interface VoiceToolsService {
  register(definition: unknown): { dispose(): void };
  bindSession(sessionId: string, context?: unknown): VoiceToolSession;
  dispose(): void;
}

interface VoiceRuntimeModule {
  readonly DOOM_VOICE_TOOLS_SERVICE: 'doom/voice-tools';
  createDoomVoiceToolsService(generation: string): VoiceToolsService;
  readDoomVoiceToolsService(context: Context): VoiceToolsService | undefined;
  requireDoomVoiceToolsService(context: Context): VoiceToolsService;
}

interface VoiceReloadHandoffModule {
  createVoiceReloadHandoffStore(runtime: { now(): number; createToken(): string }): {
    prepare(
      session: Pick<VoiceToolSession, 'active' | 'hostGeneration' | 'sessionId'>,
      request: { operationId: string; domains?: readonly string[] },
    ): { readonly token: string; commit(): boolean };
    consume(
      sessionId: string,
      token?: string,
    ): { readonly hostGeneration: string; readonly domains: readonly string[] } | undefined;
  };
}

interface CordisHostModule {
  installDoomCordisHost(
    pi: unknown,
    options: { mode: 'composed' | 'standalone' },
  ): Promise<{ root: unknown; shutdown(): Promise<void> }>;
  connectDoomCordisHost(
    pi: unknown,
    source: string,
    options?: { allowStandalone?: boolean },
  ): Promise<{ root: unknown; dispose(): Promise<void> }>;
}

const packageDirectory = fileURLToPath(new URL('..', import.meta.url));
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

async function loadBuiltVoiceRuntimes(): Promise<{ esm: VoiceRuntimeModule; cjs: VoiceRuntimeModule }> {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as PackageManifest;
  const exportsMap = manifest.exports ?? {};
  const esmPath = conditionPath(exportsMap, './voice-tools', 'import');
  const cjsPath = conditionPath(exportsMap, './voice-tools', 'require');
  await access(esmPath);
  await access(cjsPath);
  const esm = (await import(pathToFileURL(esmPath).href)) as unknown as VoiceRuntimeModule;
  const cjs = requireFromTest(cjsPath) as VoiceRuntimeModule;
  return { esm, cjs };
}

async function loadBuiltVoiceReloadHandoffRuntimes(): Promise<{
  esm: VoiceReloadHandoffModule;
  cjs: VoiceReloadHandoffModule;
}> {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as PackageManifest;
  const exportsMap = manifest.exports ?? {};
  const esmPath = conditionPath(exportsMap, './voice-reload-handoff', 'import');
  const cjsPath = conditionPath(exportsMap, './voice-reload-handoff', 'require');
  await access(esmPath);
  await access(cjsPath);
  const esm = (await import(pathToFileURL(esmPath).href)) as unknown as VoiceReloadHandoffModule;
  const cjs = requireFromTest(cjsPath) as VoiceReloadHandoffModule;
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
    const connection = await cjs.connectDoomCordisHost(pi(), '@cross-bundle/consumer', {
      allowStandalone: false,
    });

    expect(connection.root).toBe(controller.root);
    await connection.dispose();
    await controller.shutdown();
  });
});

describe('separately built voice contract bundles', () => {
  it('keeps service factories bundle-local and shares the provided instance through Cordis', async () => {
    const { esm, cjs } = await loadBuiltVoiceRuntimes();
    const descriptor = {
      source: '@cross-bundle/voice',
      id: 'cross-bundle-id',
      name: 'cross_bundle_tool',
      label: 'Cross bundle',
      description: 'Cross bundle callback',
      order: 1,
      inputSchema: Type.Object({}, { additionalProperties: false }),
      resultSchema: Type.Object({ ok: Type.Boolean() }, { additionalProperties: false }),
    };
    const provider = esm.createDoomVoiceToolsService('esm-provider');
    const isolated = cjs.createDoomVoiceToolsService('cjs-isolated');
    provider.register({ descriptor, execute: async () => ({ ok: true }) });
    const isolatedSession = isolated.bindSession('isolated-session');
    expect(isolatedSession.describe().tools).toEqual([]);

    const root = new Context();
    const fiber = root.plugin((context) => context.provide(esm.DOOM_VOICE_TOOLS_SERVICE, provider));
    await fiber.await();
    expect(cjs.readDoomVoiceToolsService(root)).toBe(provider);
    const shared = cjs.requireDoomVoiceToolsService(root);
    const session = shared.bindSession('cross-bundle-voice', { source: 'host' });
    session.setActive(true);
    const catalog = session.describe();
    expect(catalog.tools.map(({ name }) => name)).toEqual(['cross_bundle_tool']);
    await expect(
      session.executeBatch(
        { catalogToken: catalog.catalogToken, calls: [{ name: 'cross_bundle_tool', input: {} }] },
        { source: 'host' },
      ),
    ).resolves.toMatchObject({ status: 'completed' });
    session.dispose();
    isolated.dispose();
    provider.dispose();
    await fiber.dispose();
    await root.fiber.dispose();
  });

  it('shares only the explicit reload handoff across ESM and CJS copies', async () => {
    const voice = await loadBuiltVoiceRuntimes();
    const handoff = await loadBuiltVoiceReloadHandoffRuntimes();
    const service = voice.esm.createDoomVoiceToolsService('reload-provider');
    const session = service.bindSession('cross-bundle-reload');
    session.setActive(true);
    const clock = { now: 10_000 };
    const producer = handoff.esm.createVoiceReloadHandoffStore({
      now: () => clock.now,
      createToken: () => 'cross-bundle-handoff',
    });
    const consumer = handoff.cjs.createVoiceReloadHandoffStore({
      now: () => clock.now,
      createToken: () => 'unused',
    });
    const pending = producer.prepare(session, { operationId: 'reload-operation', domains: ['development'] });

    expect(pending.commit()).toBe(true);
    expect(consumer.consume(session.sessionId, pending.token)).toMatchObject({
      hostGeneration: session.hostGeneration,
      domains: ['development'],
    });
    expect(consumer.consume(session.sessionId, pending.token)).toBeUndefined();
    session.dispose();
    service.dispose();
  });
});
