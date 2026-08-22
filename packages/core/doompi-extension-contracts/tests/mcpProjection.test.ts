import { Context } from '@deepseek-ai/cordis';
import { Check } from 'typebox/value';
import { describe, expect, it } from 'vitest';
import {
  createDisabledDoomMcpProjection,
  createDoomMcpProjectionService,
  DOOM_MCP_PROJECTION_SERVICE,
  DoomMcpProjectionSchema,
  readDoomMcpProjectionService,
  requireDoomMcpProjectionService,
} from '../src/schemas/mcpProjection.ts';

const enabledProjection = {
  version: 1 as const,
  enabled: true,
  fingerprint: 'sha256:projection',
  repoRoot: '/repo',
  stagingDirectory: '/run/session',
  generatedConfigPath: '/run/session/mcp.json',
  sources: [
    {
      sourceId: 'plugin:weather',
      owner: 'plugin' as const,
      format: 'agent-plugin-v1' as const,
      configPath: '/plugins/weather/mcp.json',
      contentDigest: 'sha256:source',
      pluginId: 'weather',
      pluginRoot: '/plugins/weather',
      pluginDataDirectory: '/data/weather',
      mcpSchemaUrl: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json' as const,
    },
  ],
  allowlist: { servers: ['weather'] },
};

describe('Doom MCP projection contract', () => {
  it('validates native and Agent Plugin sources as a closed versioned document', () => {
    expect(Check(DoomMcpProjectionSchema, enabledProjection)).toBe(true);
    expect(Check(DoomMcpProjectionSchema, { ...enabledProjection, unknown: true })).toBe(false);
    expect(
      Check(DoomMcpProjectionSchema, {
        ...enabledProjection,
        sources: [{ ...enabledProjection.sources[0], mcpSchemaUrl: undefined }],
      }),
    ).toBe(false);
  });

  it('creates an explicit disabled projection without a cwd fallback source', () => {
    const projection = createDisabledDoomMcpProjection({ repoRoot: '/repo', stagingDirectory: '/run/session' });
    const rebased = createDisabledDoomMcpProjection({ repoRoot: '/repo', stagingDirectory: '/run/next-session' });

    expect(projection).toMatchObject({ version: 1, enabled: false, repoRoot: '/repo', sources: [] });
    expect(projection.fingerprint).toContain('"enabled":false');
    expect(rebased.fingerprint).toBe(projection.fingerprint);
    expect(Object.isFrozen(projection)).toBe(true);
    expect(Object.isFrozen(projection.sources)).toBe(true);
  });

  it('publishes a generation-bound immutable snapshot through Cordis', async () => {
    const root = new Context();
    const source = structuredClone(enabledProjection);
    const service = createDoomMcpProjectionService({
      sessionId: 'session-1',
      generation: 'generation-1',
      projection: source,
    });
    const unpublish = root.reflect.provide(DOOM_MCP_PROJECTION_SERVICE, service) as unknown as () => Promise<void>;

    source.sources[0].pluginRoot = '/mutated';
    const published = requireDoomMcpProjectionService(root);
    expect(published.sessionId).toBe('session-1');
    expect(published.generation).toBe('generation-1');
    const publishedSource = published.getSnapshot().sources[0];
    expect(publishedSource?.format === 'agent-plugin-v1' ? publishedSource.pluginRoot : undefined).toBe(
      '/plugins/weather',
    );
    expect(Object.isFrozen(published.getSnapshot().sources[0])).toBe(true);

    await unpublish();
    expect(readDoomMcpProjectionService(root)).toBeUndefined();
    await root.fiber.dispose();
  });

  it('rejects incomplete service identities and invalid projection values', async () => {
    expect(() =>
      createDoomMcpProjectionService({ sessionId: '', generation: 'generation-1', projection: enabledProjection }),
    ).toThrow('session id');
    expect(() =>
      createDoomMcpProjectionService({ sessionId: 'session-1', generation: '', projection: enabledProjection }),
    ).toThrow('generation');
    expect(() =>
      createDoomMcpProjectionService({
        sessionId: 'session-1',
        generation: 'generation-1',
        projection: null as never,
      }),
    ).toThrow('Invalid Doom MCP projection at /');

    const root = new Context();
    expect(() => requireDoomMcpProjectionService(root)).toThrow('Config core');
    await root.fiber.dispose();
  });
});
