import { access, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import { Type } from 'typebox';
import { describe, expect, it } from 'vitest';

interface PackageManifest {
  exports?: Record<string, unknown>;
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

  it('preserves validation and lifecycle behavior in both published voice formats', async () => {
    const runtimes = await loadBuiltVoiceRuntimes();
    for (const [format, voice] of Object.entries(runtimes)) {
      expect(() => voice.createDoomVoiceToolsService('')).toThrow(/Invalid voice service generation/u);
      const service = voice.createDoomVoiceToolsService(`${format}-provider`);
      const descriptor = {
        source: `@cross-bundle/${format}`,
        id: 'tool-id',
        name: 'published_tool',
        label: 'Published tool',
        description: 'Published format behavior',
        order: 1,
        inputSchema: Type.Object({ value: Type.Integer() }, { additionalProperties: false }),
        resultSchema: Type.Object({ ok: Type.Boolean() }, { additionalProperties: false }),
      };
      const registration = service.register({ descriptor, execute: async () => ({ ok: true }) });
      const session = service.bindSession(`${format}-session`);
      const inactive = (await session.executeBatch(
        { catalogToken: 'stale', calls: [{ name: 'published_tool', input: { value: 1 } }] },
        undefined,
      )) as { status: string; errors: Array<{ code: string }> };
      expect(inactive.errors.map(({ code }) => code)).toEqual(['VOICE_TOOL_STALE_CATALOG', 'VOICE_TOOL_INACTIVE']);

      session.setActive(true);
      const catalog = session.describe();
      const missing = (await session.executeBatch(
        { catalogToken: catalog.catalogToken, calls: [{ name: 'missing', input: {} }] },
        undefined,
      )) as { status: string };
      expect(missing.status).toBe('rejected');
      await expect(
        session.executeBatch(
          { catalogToken: session.describe().catalogToken, calls: [{ name: 'published_tool', input: { value: 1 } }] },
          undefined,
        ),
      ).resolves.toMatchObject({ status: 'completed' });
      const invalid = (await session.executeBatch(
        { catalogToken: session.describe().catalogToken, calls: [{ name: 'published_tool', input: { value: 'bad' } }] },
        undefined,
      )) as { status: string };
      expect(invalid.status).toBe('rejected');

      registration.dispose();
      registration.dispose();
      session.dispose();
      const shutdown = (await session.executeBatch(
        { catalogToken: catalog.catalogToken, calls: [{ name: 'published_tool', input: { value: 1 } }] },
        undefined,
      )) as { status: string };
      expect(shutdown.status).toBe('rejected');
      service.dispose();
      service.dispose();
      expect(() => service.bindSession('late')).toThrow(/disposed/u);
    }
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
