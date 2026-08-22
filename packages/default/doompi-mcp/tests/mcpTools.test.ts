import type { McpClientManagerService, McpToolInfo } from '@agimon-ai/mcp-proxy';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { applyActiveTools, registerMcpTool, registerNewTools } from '../src/adapters/pi/mcpTools.ts';
import { McpCatalog } from '../src/services/mcpCatalog.ts';

function mcpTool(name: string, inputSchema: Record<string, unknown> = { type: 'object' }): McpToolInfo {
  return { name, inputSchema };
}

interface RegisteredTool {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  renderShell?: 'default' | 'self';
  renderCall?: unknown;
  renderResult?: unknown;
  execute: (toolCallId: string, params: unknown) => Promise<{ content: Array<{ text?: string }>; details?: unknown }>;
}

function fakePi(activeTools: string[] = []) {
  const registered = new Map<string, RegisteredTool>();
  let active = [...activeTools];
  const pi = {
    registerTool: vi.fn((definition: RegisteredTool) => registered.set(definition.name, definition)),
    getActiveTools: vi.fn(() => [...active]),
    setActiveTools: vi.fn((names: string[]) => {
      active = [...names];
    }),
  } as unknown as ExtensionAPI;
  return { pi, registered, activeTools: () => active };
}

let callTool: ReturnType<typeof vi.fn>;
let ensureConnected: ReturnType<typeof vi.fn>;
let clientManager: McpClientManagerService;

beforeEach(() => {
  callTool = vi.fn(
    async (): Promise<CallToolResult> => ({ content: [{ type: 'text', text: 'ok' }] }) as CallToolResult,
  );
  ensureConnected = vi.fn(async () => ({ callTool }));
  clientManager = {
    ensureConnected,
    getServerRequestTimeout: vi.fn(() => 30_000),
  } as unknown as McpClientManagerService;
});

const screenshotTool = {
  piName: 'pencil_get_screenshot',
  toolName: 'get_screenshot',
  serverName: 'pencil',
  description: 'Capture the canvas',
  inputSchema: { type: 'object', properties: { scale: { type: 'number' } } },
};

describe('registerMcpTool', () => {
  it('registers under the prefixed name with the downstream description', () => {
    const { pi, registered } = fakePi();

    registerMcpTool(pi, () => clientManager, screenshotTool);

    expect(registered.get('pencil_get_screenshot')).toMatchObject({
      label: 'pencil: get_screenshot',
      description: 'Capture the canvas',
      renderShell: 'self',
      renderCall: expect.any(Function),
      renderResult: expect.any(Function),
    });
  });

  it('supplies a description for a downstream tool that has none', () => {
    const { pi, registered } = fakePi();

    registerMcpTool(pi, () => clientManager, { ...screenshotTool, description: undefined });

    expect(registered.get('pencil_get_screenshot')?.description).toContain('get_screenshot');
  });

  it('accepts any object when the downstream tool declares no schema', () => {
    const { pi, registered } = fakePi();

    registerMcpTool(pi, () => clientManager, { ...screenshotTool, inputSchema: {} });

    expect(registered.get('pencil_get_screenshot')?.parameters).toMatchObject({ type: 'object' });
  });

  describe('execution', () => {
    it('calls the downstream tool by its own name, with the server timeout', async () => {
      const { pi, registered } = fakePi();
      registerMcpTool(pi, () => clientManager, screenshotTool);

      const result = await registered.get('pencil_get_screenshot')?.execute('call-1', { scale: 2 });

      expect(ensureConnected).toHaveBeenCalledWith('pencil');
      expect(callTool).toHaveBeenCalledWith('get_screenshot', { scale: 2 }, { timeout: 30_000 });
      expect(result?.content[0]?.text).toBe('ok');
    });

    // Resolved per call, so a server that reconnected underneath still answers.
    it('resolves the connection at call time rather than at registration', async () => {
      const { pi, registered } = fakePi();
      registerMcpTool(pi, () => clientManager, screenshotTool);

      expect(ensureConnected).not.toHaveBeenCalled();
      await registered.get('pencil_get_screenshot')?.execute('call-1', {});
      expect(ensureConnected).toHaveBeenCalledOnce();
    });

    it('raises a downstream error instead of returning it as output', async () => {
      callTool.mockResolvedValue({ content: [{ type: 'text', text: 'canvas is locked' }], isError: true });
      const { pi, registered } = fakePi();
      registerMcpTool(pi, () => clientManager, screenshotTool);

      await expect(registered.get('pencil_get_screenshot')?.execute('call-1', {})).rejects.toThrow('canvas is locked');
    });

    it('fails closed when a retained wrapper is absent from the current configuration', async () => {
      const { pi, registered } = fakePi();
      registerMcpTool(
        pi,
        () => clientManager,
        screenshotTool,
        () => false,
      );

      await expect(registered.get('pencil_get_screenshot')?.execute('call-1', {})).rejects.toThrow(
        'not available in the current session configuration',
      );
      expect(ensureConnected).not.toHaveBeenCalled();
    });

    it('says so when a tool returns nothing at all', async () => {
      callTool.mockResolvedValue({ content: [] });
      const { pi, registered } = fakePi();
      registerMcpTool(pi, () => clientManager, screenshotTool);

      const result = await registered.get('pencil_get_screenshot')?.execute('call-1', {});

      expect(result?.content[0]?.text).toBe('No output.');
    });

    it('drops blocks Pi cannot render and keeps the text', async () => {
      callTool.mockResolvedValue({
        content: [
          { type: 'image', data: 'AAAA', mimeType: 'image/png' },
          { type: 'text', text: 'captured' },
        ],
      });
      const { pi, registered } = fakePi();
      registerMcpTool(pi, () => clientManager, screenshotTool);

      const result = await registered.get('pencil_get_screenshot')?.execute('call-1', {});

      expect(result?.content[0]?.text).toBe('captured');
    });

    it('names the server and tool the result came from', async () => {
      const { pi, registered } = fakePi();
      registerMcpTool(pi, () => clientManager, screenshotTool);

      const result = await registered.get('pencil_get_screenshot')?.execute('call-1', {});

      expect(result?.details).toEqual({ server: 'pencil', tool: 'get_screenshot' });
    });
  });
});

describe('registerNewTools', () => {
  // Pi permits registerTool while extensions load but throws on the active-list
  // calls until the runtime is bound, which is why the two are separate.
  it('registers cached tools without touching the active list', () => {
    const catalog = new McpCatalog();
    catalog.seed({ servers: [{ name: 'pencil', tools: [mcpTool('get_screenshot')] }] });
    const { pi, registered } = fakePi(['read']);

    registerNewTools(pi, () => clientManager, catalog.allTools());

    expect([...registered.keys()]).toEqual(['pencil_get_screenshot']);
    expect(pi.getActiveTools).not.toHaveBeenCalled();
    expect(pi.setActiveTools).not.toHaveBeenCalled();
  });
});

describe('applyActiveTools', () => {
  it('exposes cached tools before their server has reported', () => {
    const catalog = new McpCatalog();
    catalog.seed({ servers: [{ name: 'pencil', tools: [mcpTool('get_screenshot')] }] });
    const { pi, activeTools } = fakePi(['read']);
    registerNewTools(pi, () => clientManager, catalog.allTools());

    applyActiveTools(pi, catalog);

    expect(activeTools()).toEqual(['read', 'pencil_get_screenshot']);
  });

  it('withholds tools whose server is known to be unusable', () => {
    const catalog = new McpCatalog();
    catalog.seed({ servers: [{ name: 'pencil', tools: [mcpTool('get_screenshot')] }] });
    const { pi, activeTools } = fakePi(['read']);
    registerNewTools(pi, () => clientManager, catalog.allTools());
    catalog.applyStateChange({ serverName: 'pencil', state: 'needs-auth' });

    applyActiveTools(pi, catalog);

    expect(activeTools()).toEqual(['read']);
  });

  it('activates a server tools when it connects, without re-registering them', () => {
    const catalog = new McpCatalog();
    catalog.seed({ servers: [{ name: 'pencil', tools: [mcpTool('get_screenshot')] }] });
    const { pi, activeTools } = fakePi(['read']);
    registerNewTools(pi, () => clientManager, catalog.allTools());

    registerNewTools(pi, () => clientManager, catalog.applyStateChange({ serverName: 'pencil', state: 'connected' }));
    applyActiveTools(pi, catalog);

    expect(pi.registerTool).toHaveBeenCalledOnce();
    expect(activeTools()).toEqual(['read', 'pencil_get_screenshot']);
  });

  it('registers and activates a tool the cache did not know about', () => {
    const catalog = new McpCatalog();
    const { pi, registered, activeTools } = fakePi([]);

    const added = catalog.applyStateChange({ serverName: 'boomlink', state: 'connected' }, [mcpTool('search')]);
    registerNewTools(pi, () => clientManager, added);
    applyActiveTools(pi, catalog);

    expect([...registered.keys()]).toEqual(['boomlink_search']);
    expect(activeTools()).toEqual(['boomlink_search']);
  });

  it('drops a failed server tools from the active list', () => {
    const catalog = new McpCatalog();
    const { pi, activeTools } = fakePi(['read']);
    registerNewTools(
      pi,
      () => clientManager,
      catalog.applyStateChange({ serverName: 'pencil', state: 'connected' }, [mcpTool('get_screenshot')]),
    );
    applyActiveTools(pi, catalog);

    catalog.applyStateChange({ serverName: 'pencil', state: 'failed' });
    applyActiveTools(pi, catalog);

    expect(activeTools()).toEqual(['read']);
  });

  // The active list is global, so rebuilding it from MCP alone would hide Pi's own
  // tools and every other extension's.
  it('leaves tools this extension does not own alone', () => {
    const catalog = new McpCatalog();
    const { pi, activeTools } = fakePi(['read', 'bash', 'tasks']);
    catalog.applyStateChange({ serverName: 'pencil', state: 'connected' }, [mcpTool('get_screenshot')]);

    applyActiveTools(pi, catalog);

    expect(activeTools()).toEqual(['read', 'bash', 'tasks', 'pencil_get_screenshot']);
  });

  it('removes historically owned wrappers that the current catalog no longer contains', () => {
    const catalog = new McpCatalog();
    const { pi, activeTools } = fakePi(['read', 'pencil_get_screenshot']);

    applyActiveTools(pi, catalog, new Set(['pencil_get_screenshot']));

    expect(activeTools()).toEqual(['read']);
  });

  it('withholds a current tool whose retained wrapper has incompatible schema', () => {
    const catalog = new McpCatalog();
    catalog.applyStateChange({ serverName: 'pencil', state: 'connected' }, [mcpTool('get_screenshot')]);
    const { pi, activeTools } = fakePi(['read']);

    applyActiveTools(pi, catalog, new Set(['pencil_get_screenshot']), new Set(['pencil_get_screenshot']));

    expect(activeTools()).toEqual(['read']);
  });

  it('does not duplicate an MCP tool that is already active', () => {
    const catalog = new McpCatalog();
    const { pi, activeTools } = fakePi(['read']);
    catalog.applyStateChange({ serverName: 'pencil', state: 'connected' }, [mcpTool('get_screenshot')]);
    applyActiveTools(pi, catalog);

    applyActiveTools(pi, catalog);

    expect(activeTools()).toEqual(['read', 'pencil_get_screenshot']);
  });
});
