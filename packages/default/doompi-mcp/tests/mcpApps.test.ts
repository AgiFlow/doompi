import type { DoomHeadlessHostService } from '@agimon-ai/doompi-core/headless';
import { createDoomPluginRegistry, type DoomPluginCaller } from '@agimon-ai/doompi-core/pluginProtocol';
import type { DoomServerHostService } from '@agimon-ai/doompi-core/serverFacet';
import { Type } from 'typebox';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { McpAppOpenResult } from '../src/schemas/mcpApps';
import { createMcpAppsService } from '../src/services/mcpApps';
import type { CatalogTool } from '../src/services/mcpCatalog';
import type { McpSessionToolsService } from '../src/services/mcpSessionTools';

const disposals: Array<() => void> = [];
afterEach(() => disposals.splice(0).forEach((dispose) => dispose()));

function fixture() {
  const connection = new AbortController();
  const lifetime = new AbortController();
  const caller = { connectionId: 'browser-a', signal: connection.signal };
  const original = {
    content: [{ type: 'text', text: 'public' }],
    structuredContent: false,
    _meta: { private: 'not-model-content' },
  };
  const details = {
    server: 'one',
    tool: 'view',
    app: { version: 1, resourceUri: 'ui://one/view', protocol: 'mcp', result: original },
  };
  const messages: Record<string, unknown>[] = [
    {
      type: 'message',
      message: {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'call-1', name: 'one_view', arguments: { id: 7 } }],
      },
    },
    {
      type: 'message',
      message: { role: 'toolResult', toolCallId: 'call-1', content: [{ type: 'text', text: 'guarded' }], details },
    },
  ];
  const states: Record<string, unknown>[] = [];
  const catalog: CatalogTool[] = [
    {
      piName: 'one_view',
      serverName: 'one',
      toolName: 'view',
      inputSchema: { type: 'object' },
      _meta: { ui: { resourceUri: 'ui://one/view' } },
    },
    {
      piName: 'one_data',
      serverName: 'one',
      toolName: 'data',
      inputSchema: { type: 'object' },
      _meta: { ui: { visibility: ['app'] } },
    },
    {
      piName: 'one_model',
      serverName: 'one',
      toolName: 'model',
      inputSchema: { type: 'object' },
      _meta: { ui: { visibility: ['model'] } },
    },
    { piName: 'two_other', serverName: 'two', toolName: 'other', inputSchema: { type: 'object' } },
  ];
  let revision = 1;
  const request = vi.fn(async () => true);
  const admitPrompt = vi.fn(async () => undefined);
  const appendCustomEntry = vi.fn(async (customType: string, data: unknown) => {
    states.push({ type: 'custom', customType, data });
  });
  const invokeTool = vi.fn(async (input: { authorize?: () => void | Promise<void> }) => {
    await input.authorize?.();
    return {
      content: [{ type: 'text', text: 'guarded callback' }],
      details: { app: { version: 1, result: original } },
    };
  });
  const host = {
    assertActive: vi.fn(),
    context: {
      sessionId: 'session',
      client: { request },
      session: {
        entries: vi.fn(async (query: { type: string }) => (query.type === 'custom' ? states : messages)),
        appendCustomEntry,
        admitPrompt,
      },
    },
    toolSurface: {
      readSurface: () => ({ revision, tools: catalog.map((tool) => ({ name: tool.piName })), skills: [] }),
      invokeTool,
    },
  } as unknown as DoomHeadlessHostService;
  const readAppResource = vi.fn(async () => ({
    contents: [
      {
        uri: 'ui://one/view',
        mimeType: 'text/html;profile=mcp-app',
        text: '<p>widget</p>',
        _meta: { ui: { csp: { connectDomains: [] } } },
      },
    ],
  }));
  const listeners = new Set<() => void>();
  const tools = {
    generation: 'runtime',
    runtimeRevision: () => revision,
    snapshot: () => catalog,
    readAppResource,
    onChange: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    invoke: vi.fn(),
  } as unknown as McpSessionToolsService;
  const apps = createMcpAppsService(tools, () => host, lifetime.signal);
  const registry = createDoomPluginRegistry();
  const mount = { scope: 'session', sessionId: 'session' } as const;
  for (const method of apps.methods) {
    method.register({
      registerMethod: (definition, handler) => ({ dispose: registry.register(mount, definition, handler) }),
    } as DoomServerHostService);
  }
  disposals.push(() => {
    apps.dispose();
    registry.dispose();
  });
  const rpc = (method: string, input: unknown, identity: DoomPluginCaller = caller) =>
    registry.invoke({ mount, service: 'mcp.apps', method, input }, 'client-to-server', identity);
  const open = () => rpc('open', { toolCallId: 'call-1' }) as Promise<McpAppOpenResult>;
  const activate = (leaseId: string) => rpc('activate', { leaseId });
  return {
    rpc,
    open,
    activate,
    request,
    invokeTool,
    readAppResource,
    appendCustomEntry,
    admitPrompt,
    messages,
    states,
    details,
    catalog,
    host,
    tools,
    connection,
    lifetime,
    change: () => {
      revision++;
      listeners.forEach((listener) => listener());
    },
  };
}

describe('session-bound MCP Apps', () => {
  it('opens retained private data without replaying a tool, restores state, and never restores write authority', async () => {
    const f = fixture();
    const app = await f.open();
    expect(app).toMatchObject({
      args: { id: 7 },
      readOnly: true,
      result: { structuredContent: false, _meta: { private: 'not-model-content' } },
    });
    expect(f.readAppResource).toHaveBeenCalledWith('one', 'view', 'ui://one/view', expect.any(AbortSignal));
    expect(f.invokeTool).not.toHaveBeenCalled();
    await f.rpc('setState', { leaseId: app.leaseId, state: { page: 2 } });
    await f.activate(app.leaseId);
    await f.rpc('close', { leaseId: app.leaseId });
    expect(await f.open()).toMatchObject({ state: { page: 2 }, readOnly: true });
    expect(f.admitPrompt).not.toHaveBeenCalled();
    expect(f.appendCustomEntry).toHaveBeenCalledWith(
      'mcp.app.state',
      expect.objectContaining({ state: { page: 2 }, toolCallId: 'call-1' }),
    );
  });

  it('requires authenticated ownership and a matching durable invocation', async () => {
    const f = fixture();
    await expect(f.rpc('open', { toolCallId: 'call-1' }, {})).rejects.toThrow('authenticated');
    await expect(f.rpc('open', { toolCallId: 'missing' })).rejects.toThrow('retained');
    await expect(f.rpc('open', { toolCallId: 'call-1', resourceUri: 'https://attacker' })).rejects.toThrow(
      'Invalid input',
    );
    const app = await f.open();
    await expect(
      f.rpc('setState', { leaseId: app.leaseId, state: null }, { connectionId: 'browser-b' }),
    ).rejects.toThrow('owned');
    await expect(f.rpc('close', { leaseId: app.leaseId }, { connectionId: 'browser-b' })).rejects.toThrow('owned');
    f.messages.shift();
    await expect(f.open()).rejects.toThrow('retained');
  });

  it('requires explicit activation, then approval, and routes an app-only data tool through admission', async () => {
    const f = fixture();
    const { leaseId } = await f.open();
    const input = { leaseId, name: 'data', arguments: { key: 'value' } };
    await expect(f.rpc('callTool', input)).rejects.toThrow('Enable App interactions');
    await f.activate(leaseId);
    f.request.mockResolvedValueOnce(false);
    await expect(f.rpc('callTool', input)).rejects.toThrow('not approved');
    expect(f.invokeTool).not.toHaveBeenCalled();
    const result = await f.rpc('callTool', input);
    expect(f.invokeTool).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'one_data',
        arguments: { key: 'value' },
        revision: 1,
        authorize: expect.any(Function),
        signal: expect.any(AbortSignal),
      }),
    );
    expect(f.tools.invoke).not.toHaveBeenCalled();
    expect(result).toMatchObject({ structuredContent: false, _meta: { private: 'not-model-content' } });
  });

  it('does not accept cross-server, model-only, or fabricated callback tools', async () => {
    const f = fixture();
    const { leaseId } = await f.open();
    await f.activate(leaseId);
    for (const name of ['other', 'two_other', 'model', 'missing']) {
      await expect(f.rpc('callTool', { leaseId, name, arguments: {} })).rejects.toThrow('not available');
    }
    expect(f.invokeTool).not.toHaveBeenCalled();
  });

  it('rechecks permissions after confirmation and revokes stale leases', async () => {
    const f = fixture();
    const { leaseId } = await f.open();
    await f.activate(leaseId);
    f.request.mockImplementationOnce(async () => {
      f.change();
      return true;
    });
    await expect(f.rpc('callTool', { leaseId, name: 'data', arguments: {} })).rejects.toThrow();
    expect(f.invokeTool).not.toHaveBeenCalled();
    await expect(f.rpc('setState', { leaseId, state: null })).rejects.toThrow('owned');
  });

  it.each(['connection', 'lifetime'] as const)('revokes on %s cancellation', async (owner) => {
    const f = fixture();
    const { leaseId } = await f.open();
    f[owner].abort();
    await expect(f.rpc('setState', { leaseId, state: null })).rejects.toThrow();
    expect(f.appendCustomEntry).not.toHaveBeenCalled();
  });

  it('serializes actions while consent is pending and admits only attributed environmental follow-ups', async () => {
    const f = fixture();
    const { leaseId } = await f.open();
    await f.activate(leaseId);
    let approve: (value: boolean) => void = () => undefined;
    f.request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          approve = resolve;
        }),
    );
    const followUp = f.rpc('followUp', { leaseId, prompt: 'continue' });
    await expect(f.rpc('setState', { leaseId, state: null })).rejects.toThrow('in progress');
    approve(true);
    await followUp;
    expect(f.admitPrompt).toHaveBeenCalledWith('[MCP App one/view, invocation call-1]\ncontinue', 'followUp');
    expect(f.invokeTool).not.toHaveBeenCalled();
  });

  it('rejects unbounded payloads, stale resources, and unsupported HTML before returning a lease', async () => {
    const f = fixture();
    const { leaseId } = await f.open();
    await expect(f.rpc('setState', { leaseId, state: 'x'.repeat(65537) })).rejects.toThrow('size limit');
    expect(f.appendCustomEntry).not.toHaveBeenCalled();
    f.readAppResource.mockResolvedValueOnce({
      contents: [
        {
          uri: 'ui://one/view',
          mimeType: 'text/plain',
          text: '<p>not HTML</p>',
          _meta: { ui: { csp: { connectDomains: [] } } },
        },
      ],
    });
    await expect(f.open()).rejects.toThrow('MIME');
    f.catalog[0]!._meta = { ui: { resourceUri: 'ui://one/replaced' } };
    await expect(f.open()).rejects.toThrow('no longer declared');
  });

  it('does not resurrect private snapshots after a hook replaces the result', async () => {
    const f = fixture();
    const { leaseId } = await f.open();
    await f.activate(leaseId);
    f.invokeTool.mockImplementationOnce(
      async () => ({ content: [{ type: 'text', text: 'redacted by hook' }], details: {} }) as never,
    );
    expect(await f.rpc('callTool', { leaseId, name: 'data', arguments: {} })).toEqual({
      content: [{ type: 'text', text: 'redacted by hook' }],
    });
    delete (f.details as { app?: unknown }).app;
    await expect(f.open()).rejects.toThrow('retained');
  });
  it('unwraps generic MCP invocations and sends callbacks through the admitted generic tool', async () => {
    const f = fixture();
    const surface = {
      revision: 1,
      tools: [{ name: 'mcp', label: 'MCP', description: '', parameters: Type.Object({}) }],
      skills: [],
    };
    vi.spyOn(f.host.toolSurface!, 'readSurface').mockReturnValue(surface);
    f.messages[0]!.message = {
      role: 'assistant',
      content: [
        {
          type: 'toolCall',
          id: 'call-1',
          name: 'mcp',
          arguments: { server: 'one', tool: 'view', arguments: { id: 7 } },
        },
      ],
    };
    const app = await f.open();
    expect(app.args).toEqual({ id: 7 });
    await f.activate(app.leaseId);
    f.invokeTool.mockImplementationOnce(
      async () =>
        ({
          content: [],
          structuredContent: { page: 3 },
          _meta: { private: 'callback' },
          isError: true,
        }) as never,
    );
    expect(await f.rpc('callTool', { leaseId: app.leaseId, name: 'data', arguments: {} })).toEqual({
      content: [],
      structuredContent: { page: 3 },
      _meta: { private: 'callback' },
      isError: true,
    });
    expect(f.invokeTool).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'mcp', arguments: { server: 'one', tool: 'data', arguments: {} } }),
    );
  });

  it('rejects forged identity and removed admission before reading resources or requesting consent', async () => {
    const f = fixture();
    f.messages[0]!.message = {
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'call-1', name: 'other', arguments: {} }],
    };
    await expect(f.open()).rejects.toThrow('identity');
    expect(f.readAppResource).not.toHaveBeenCalled();
    const g = fixture();
    vi.spyOn(g.host.toolSurface!, 'readSurface').mockReturnValue({ revision: 1, tools: [], skills: [] });
    await expect(g.open()).rejects.toThrow('not admitted');
    expect(g.readAppResource).not.toHaveBeenCalled();
    const h = fixture();
    const { leaseId } = await h.open();
    await h.activate(leaseId);
    vi.spyOn(h.host.toolSurface!, 'readSurface').mockReturnValue({
      revision: 1,
      tools: [{ name: 'one_view', label: 'View', description: '', parameters: Type.Object({}) }],
      skills: [],
    });
    await expect(h.rpc('callTool', { leaseId, name: 'data', arguments: {} })).rejects.toThrow('not admitted');
    expect(h.request).toHaveBeenCalledOnce();
    expect(h.invokeTool).not.toHaveBeenCalled();
  });

  it('bounds concurrent opens, releases failed reservations, and rejects actions after disposal', async () => {
    const f = fixture();
    const resource = await f.readAppResource();
    f.readAppResource.mockRejectedValueOnce(new Error('resource disconnected'));
    await expect(f.open()).rejects.toThrow('resource disconnected');
    let release: (value: typeof resource) => void = () => undefined;
    f.readAppResource.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const opening = Array.from({ length: 64 }, () => f.open());
    await expect(f.open()).rejects.toThrow('Too many');
    release(resource);
    const leases = await Promise.all(opening);
    await expect(f.open()).rejects.toThrow('Too many');
    await f.rpc('close', { leaseId: leases[0]!.leaseId });
    const replacement = await f.open();
    f.lifetime.abort();
    await expect(f.open()).rejects.toThrow('no longer available');
    await expect(f.rpc('setState', { leaseId: replacement.leaseId, state: null })).rejects.toThrow();
  });

  it('rejects malformed snapshots, missing HTML, and oversized private inputs before granting a lease', async () => {
    const f = fixture();
    f.details.app.result.content = [null] as never;
    await expect(f.open()).rejects.toThrow('retained');
    const g = fixture();
    g.readAppResource.mockResolvedValueOnce({ contents: [] });
    await expect(g.open()).rejects.toThrow('HTML');
    g.readAppResource.mockResolvedValueOnce({
      contents: [
        {
          uri: 'ui://one/view',
          mimeType: 'text/html;profile=mcp-app',
          text: 'x'.repeat(2 * 1024 * 1024 + 1),
          _meta: { ui: { csp: { connectDomains: [] } } },
        },
      ],
    });
    await expect(g.open()).rejects.toThrow('size limit');
    g.states.push({
      data: {
        version: 1,
        toolCallId: 'call-1',
        server: 'one',
        tool: 'view',
        resourceUri: 'ui://one/view',
        state: 'x'.repeat(65537),
      },
    });
    await expect(g.open()).rejects.toThrow('App state');
  });
});
