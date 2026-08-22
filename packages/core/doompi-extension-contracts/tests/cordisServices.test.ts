import { Context } from '@deepseek-ai/cordis';
import { Check } from 'typebox/value';
import { describe, expect, it, vi } from 'vitest';
import {
  DOOM_MCP_STATUS_SERVICE,
  type DoomMcpStatusService,
  McpStatusSnapshotSchema,
  readDoomMcpStatus,
} from '../src/exports/mcpStatus.ts';
import {
  DOOM_MCP_TOOL_RESOLVER_SERVICE,
  type DoomMcpToolResolverService,
  readDoomMcpToolResolver,
  requireDoomMcpToolResolver,
} from '../src/exports/mcpToolResolver.ts';
import {
  DOOM_MINOR_MODE_CATALOG_SERVICE,
  type MinorModeActionRequest,
  type MinorModeActionResponse,
  type MinorModeCatalogSnapshot,
  type MinorModeCatalogService,
  createMinorModeCatalogClient,
  readMinorModeCatalog,
  registerMinorModeOwner,
  requireMinorModeCatalog,
} from '../src/exports/mode.ts';
import { DOOM_UI_HUB_SERVICE, type DoomUiHubService, readDoomUiHub, requireDoomUiHub } from '../src/exports/uiHub.ts';

const emptySnapshot: MinorModeCatalogSnapshot = { hostGeneration: 'mode-generation', revision: 0, modes: [] };

function modeService(): MinorModeCatalogService {
  return {
    generation: 'mode-generation',
    getSnapshot: () => structuredClone(emptySnapshot),
    list: () => [],
    subscribe: vi.fn(() => () => undefined),
    registerOwner: vi.fn(() => ({ getState: vi.fn(), publish: vi.fn(), dispose: vi.fn() })),
    invoke: vi.fn(async (request: MinorModeActionRequest): Promise<MinorModeActionResponse> => ({
      operationId: request.operationId,
      catalogRevision: 0,
      mode: {
        descriptor: { source: 'example', id: 'mode', label: 'Mode', description: 'Example', order: 0, actions: [] },
        state: { activation: 'inactive', condition: 'ready', actions: [] },
        ownerGeneration: 'owner',
        registrationId: 'registration',
        stateRevision: 0,
      },
    })),
    dispose: vi.fn(),
  };
}

describe('Cordis aggregation contracts', () => {
  it('discovers an MCP tool resolver only while its provider fiber is live', async () => {
    const root = new Context();
    const resolver: DoomMcpToolResolverService = {
      generation: 'mcp-1',
      resolve: (selectors) => selectors.map((selector) => ({ selector, name: `resolved_${selector}` })),
    };
    const fiber = root.plugin((context) => context.provide(DOOM_MCP_TOOL_RESOLVER_SERVICE, resolver));
    await fiber.await();
    expect(readDoomMcpToolResolver(root)).toBe(resolver);
    expect(requireDoomMcpToolResolver(root).resolve(['pencil/screenshot'])).toEqual([
      { selector: 'pencil/screenshot', name: 'resolved_pencil/screenshot' },
    ]);
    await fiber.dispose();
    expect(readDoomMcpToolResolver(root)).toBeUndefined();
    expect(() => requireDoomMcpToolResolver(root)).toThrow('Doom MCP tool resolver is unavailable');
    await root.fiber.dispose();
  });

  it('rejects a second MCP tool resolver provider on the same host', async () => {
    const root = new Context();
    const resolver: DoomMcpToolResolverService = { generation: 'mcp-1', resolve: () => [] };
    const first = root.plugin((context) => context.provide(DOOM_MCP_TOOL_RESOLVER_SERVICE, resolver));
    await first.await();

    const duplicate = root.plugin((context) =>
      context.provide(DOOM_MCP_TOOL_RESOLVER_SERVICE, { generation: 'mcp-2', resolve: () => [] }),
    );

    await expect(duplicate.await()).rejects.toThrow(`service "${DOOM_MCP_TOOL_RESOLVER_SERVICE}" has been registered`);
    expect(readDoomMcpToolResolver(root)).toBe(resolver);
    await duplicate.dispose();
    await root.fiber.dispose();
  });

  it('publishes and removes MCP status through the service registry', async () => {
    const root = new Context();
    const status: DoomMcpStatusService = { generation: 'mcp-1', getSnapshot: () => ({ servers: [] }) };
    const fiber = root.plugin((context) => context.provide(DOOM_MCP_STATUS_SERVICE, status));
    await fiber.await();
    expect(readDoomMcpStatus(root)).toBe(status);
    await fiber.dispose();
    expect(readDoomMcpStatus(root)).toBeUndefined();
    await root.fiber.dispose();
  });

  it('exposes a direct mode client and owner registration over one injected service', async () => {
    const root = new Context();
    const service = modeService();
    const fiber = root.plugin((context) => context.provide(DOOM_MINOR_MODE_CATALOG_SERVICE, service));
    await fiber.await();
    expect(readMinorModeCatalog(root)).toBe(service);
    expect(requireMinorModeCatalog(root)).toBe(service);
    const client = createMinorModeCatalogClient(service);
    expect(client.getSnapshot()).toEqual(emptySnapshot);
    expect(client.list()).toEqual([]);
    const listener = vi.fn();
    const unsubscribe = client.subscribe(listener);
    expect(service.subscribe).toHaveBeenCalledWith(listener);
    unsubscribe();

    const mode = {
      source: 'example',
      id: 'mode',
      ownerGeneration: 'owner',
      registrationId: 'registration',
    };
    await client.invoke(mode, 'activate');
    expect(service.invoke).toHaveBeenLastCalledWith(
      expect.objectContaining({ mode, actionId: 'activate', arguments: {} }),
      'doom/minor-mode-client',
      undefined,
    );
    const signal = new AbortController().signal;
    await client.invoke(mode, 'deactivate', { force: true }, { signal });
    expect(service.invoke).toHaveBeenLastCalledWith(
      expect.objectContaining({ mode, actionId: 'deactivate', arguments: { force: true } }),
      'doom/minor-mode-client',
      signal,
    );
    registerMinorModeOwner(service, {
      descriptor: { source: 'example', id: 'mode', label: 'Mode', description: 'Example', order: 0, actions: [] },
      initialState: { activation: 'inactive', condition: 'ready', actions: [] },
      handleAction: vi.fn(),
    });
    expect(service.registerOwner).toHaveBeenCalledOnce();
    await fiber.dispose();
    expect(readMinorModeCatalog(root)).toBeUndefined();
    expect(() => requireMinorModeCatalog(root)).toThrow('Doom minor-mode catalog is unavailable.');
    await root.fiber.dispose();
  });

  it('discovers the UI hub only while its provider fiber is live', async () => {
    const root = new Context();
    const hub = {
      registerLeader: vi.fn(),
      registerLeaderActions: vi.fn(),
      registerFooter: vi.fn(),
      registerConfig: vi.fn(),
    } as unknown as DoomUiHubService;
    const fiber = root.plugin((context) => context.provide(DOOM_UI_HUB_SERVICE, hub));
    await fiber.await();
    expect(readDoomUiHub(root)).toBe(hub);
    expect(requireDoomUiHub(root)).toBe(hub);
    await fiber.dispose();
    expect(readDoomUiHub(root)).toBeUndefined();
    expect(() => requireDoomUiHub(root)).toThrow('Doom UI hub is unavailable. Load @agimon-ai/doompi-ui.');
    await root.fiber.dispose();
  });
});

describe('McpStatusSnapshotSchema', () => {
  it('accepts attributed tools and rejects unknown server states', () => {
    expect(
      Check(McpStatusSnapshotSchema, {
        servers: [{ name: 'pencil', state: 'connected', tools: ['pencil_get_screenshot'], resourceCount: 0 }],
      }),
    ).toBe(true);
    expect(
      Check(McpStatusSnapshotSchema, {
        servers: [{ name: 'pencil', state: 'wedged', tools: [], resourceCount: 0 }],
      }),
    ).toBe(false);
  });
});
