import type { McpClientManagerService, McpToolInfo } from '@agimon-ai/mcp-proxy';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { McpCatalog } from '../src/services/mcpCatalog';
import { mcpToolRestriction } from '../src/services/toolVisibility';
import { createMcpTool } from '../src/tools/mcpTools';
import { renderMcpCall, renderMcpResult } from '../src/tui/mcpToolRender';

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
  execute: (
    toolCallId: string,
    params: unknown,
  ) => Promise<{
    content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
    details?: unknown;
  }>;
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

describe('createMcpTool', () => {
  it('registers under the prefixed name with the downstream description', () => {
    const { pi, registered } = fakePi();

    createMcpTool(
      () => clientManager,
      screenshotTool,
      () => true,
      {
        renderCall: (params, theme) => renderMcpCall(screenshotTool, params as Record<string, unknown>, theme),
        renderResult: (result, options, theme, context) =>
          renderMcpResult(result, { ...options, isError: context.isError }, theme),
      },
    ).register(pi);

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

    createMcpTool(() => clientManager, { ...screenshotTool, description: undefined }).register(pi);

    expect(registered.get('pencil_get_screenshot')?.description).toContain('get_screenshot');
  });

  it('accepts any object when the downstream tool declares no schema', () => {
    const { pi, registered } = fakePi();

    createMcpTool(() => clientManager, { ...screenshotTool, inputSchema: {} }).register(pi);

    expect(registered.get('pencil_get_screenshot')?.parameters).toMatchObject({ type: 'object' });
  });

  describe('execution', () => {
    it('rejects cached tools until a runtime is available', async () => {
      const { pi, registered } = fakePi();
      createMcpTool(() => undefined, screenshotTool).register(pi);

      await expect(registered.get('pencil_get_screenshot')?.execute('call-1', {})).rejects.toThrow(
        'The MCP runtime is not ready',
      );
      expect(ensureConnected).not.toHaveBeenCalled();
    });

    it('uses the downstream default timeout and an empty argument object when omitted', async () => {
      vi.mocked(clientManager.getServerRequestTimeout).mockReturnValue(undefined);
      const { pi, registered } = fakePi();
      createMcpTool(() => clientManager, screenshotTool).register(pi);

      await registered.get('pencil_get_screenshot')?.execute('call-1', undefined);

      expect(callTool).toHaveBeenCalledWith('get_screenshot', {}, undefined);
    });

    it('calls the downstream tool by its own name, with the server timeout', async () => {
      const { pi, registered } = fakePi();
      createMcpTool(() => clientManager, screenshotTool).register(pi);

      const result = await registered.get('pencil_get_screenshot')?.execute('call-1', { scale: 2 });

      expect(ensureConnected).toHaveBeenCalledWith('pencil');
      expect(callTool).toHaveBeenCalledWith('get_screenshot', { scale: 2 }, { timeout: 30_000 });
      expect(result?.content[0]?.text).toBe('ok');
    });

    // Resolved per call, so a server that reconnected underneath still answers.
    it('resolves the connection at call time rather than at registration', async () => {
      const { pi, registered } = fakePi();
      createMcpTool(() => clientManager, screenshotTool).register(pi);

      expect(ensureConnected).not.toHaveBeenCalled();
      await registered.get('pencil_get_screenshot')?.execute('call-1', {});
      expect(ensureConnected).toHaveBeenCalledOnce();
    });

    it('raises a downstream error instead of returning it as output', async () => {
      callTool.mockResolvedValue({ content: [{ type: 'text', text: 'canvas is locked' }], isError: true });
      const { pi, registered } = fakePi();
      createMcpTool(() => clientManager, screenshotTool).register(pi);

      await expect(registered.get('pencil_get_screenshot')?.execute('call-1', {})).rejects.toThrow('canvas is locked');
    });

    it('fails closed when a retained wrapper is absent from the current configuration', async () => {
      const { pi, registered } = fakePi();
      createMcpTool(
        () => clientManager,
        screenshotTool,
        () => false,
      ).register(pi);

      await expect(registered.get('pencil_get_screenshot')?.execute('call-1', {})).rejects.toThrow(
        'not available in the current session configuration',
      );
      expect(ensureConnected).not.toHaveBeenCalled();
    });

    it('says so when a tool returns nothing at all', async () => {
      callTool.mockResolvedValue({ content: [] });
      const { pi, registered } = fakePi();
      createMcpTool(() => clientManager, screenshotTool).register(pi);

      const result = await registered.get('pencil_get_screenshot')?.execute('call-1', {});

      expect(result?.content[0]?.text).toBe('No output.');
    });

    it('keeps the text first and carries images as Pi image content', async () => {
      callTool.mockResolvedValue({
        content: [
          { type: 'image', data: 'AAAA', mimeType: 'image/png' },
          { type: 'text', text: 'captured' },
        ],
      });
      const { pi, registered } = fakePi();
      createMcpTool(() => clientManager, screenshotTool).register(pi);

      const result = await registered.get('pencil_get_screenshot')?.execute('call-1', {});

      expect(result?.content).toEqual([
        { type: 'text', text: 'captured' },
        { type: 'image', data: 'AAAA', mimeType: 'image/png' },
      ]);
      // An image rides Pi's content, so it is not repeated in the details.
      expect(result?.details).toEqual({ server: 'pencil', tool: 'get_screenshot' });
    });

    it('carries every block beyond text and images in the details for the cockpit', async () => {
      callTool.mockResolvedValue({
        content: [
          { type: 'text', text: 'see the links' },
          { type: 'audio', data: 'QUJD', mimeType: 'audio/wav' },
          { type: 'resource_link', uri: 'file:///a.md', name: 'a.md', title: 'A', mimeType: 'text/markdown' },
          { type: 'resource', resource: { uri: 'file:///b.txt', mimeType: 'text/plain', text: 'hello' } },
          { type: 'resource', resource: { uri: 'file:///c.bin', blob: 'AAAA' } },
          { type: 'mystery', data: 'x' },
        ],
        structuredContent: { count: 2 },
      });
      const { pi, registered } = fakePi();
      createMcpTool(() => clientManager, screenshotTool).register(pi);

      const result = await registered.get('pencil_get_screenshot')?.execute('call-1', {});

      expect(result?.content).toEqual([{ type: 'text', text: 'see the links' }]);
      expect(result?.details).toEqual({
        server: 'pencil',
        tool: 'get_screenshot',
        blocks: [
          { type: 'audio', data: 'QUJD', mimeType: 'audio/wav' },
          { type: 'resource_link', uri: 'file:///a.md', name: 'a.md', title: 'A', mimeType: 'text/markdown' },
          { type: 'resource', uri: 'file:///b.txt', mimeType: 'text/plain', text: 'hello' },
          { type: 'resource', uri: 'file:///c.bin', blob: 'AAAA' },
          { type: 'structured', value: { count: 2 } },
        ],
      });
    });

    it('preserves resource link descriptions when optional rendering metadata is absent', async () => {
      callTool.mockResolvedValue({
        content: [{ type: 'resource_link', uri: 'file:///a', name: 'a', description: 'Reference document' }],
      });
      const { pi, registered } = fakePi();
      createMcpTool(() => clientManager, screenshotTool).register(pi);
      const result = await registered.get('pencil_get_screenshot')?.execute('call-1', {});
      expect(result?.details).toEqual({
        server: 'pencil',
        tool: 'get_screenshot',
        blocks: [{ type: 'resource_link', uri: 'file:///a', name: 'a', description: 'Reference document' }],
      });
    });

    it('names the server and tool the result came from', async () => {
      const { pi, registered } = fakePi();
      createMcpTool(() => clientManager, screenshotTool).register(pi);

      const result = await registered.get('pencil_get_screenshot')?.execute('call-1', {});

      expect(result?.details).toEqual({ server: 'pencil', tool: 'get_screenshot' });
    });
  });
});

describe('cached tool declarations', () => {
  // Pi permits registerTool while extensions load but throws on the active-list
  // calls until the runtime is bound, which is why the two are separate.
  it('registers cached tools without touching the active list', () => {
    const catalog = new McpCatalog();
    catalog.seed({ servers: [{ name: 'pencil', tools: [mcpTool('get_screenshot')] }] });
    const { pi, registered } = fakePi(['read']);

    for (const tool of catalog.allTools()) createMcpTool(() => clientManager, tool).register(pi);

    expect([...registered.keys()]).toEqual(['pencil_get_screenshot']);
    expect(pi.getActiveTools).not.toHaveBeenCalled();
    expect(pi.setActiveTools).not.toHaveBeenCalled();
  });
});

describe('mcpToolRestriction', () => {
  // The surface starts from Pi's whole inventory, so a restriction is handed every
  // registered name and answers with the ones that stay.
  const HOST_TOOLS = ['read', 'bash', 'tasks'];
  const surviving = (restrict: ReturnType<typeof mcpToolRestriction>, ...owned: string[]): readonly string[] =>
    restrict([...HOST_TOOLS, ...owned], [...HOST_TOOLS, ...owned]);

  it('keeps cached tools visible before their server has reported', () => {
    const catalog = new McpCatalog();
    catalog.seed({ servers: [{ name: 'pencil', tools: [mcpTool('get_screenshot')] }] });

    expect(surviving(mcpToolRestriction(catalog), 'pencil_get_screenshot')).toEqual([
      ...HOST_TOOLS,
      'pencil_get_screenshot',
    ]);
  });

  it('withholds tools whose server is known to be unusable', () => {
    const catalog = new McpCatalog();
    catalog.seed({ servers: [{ name: 'pencil', tools: [mcpTool('get_screenshot')] }] });
    catalog.applyStateChange({ serverName: 'pencil', state: 'needs-auth' });

    expect(surviving(mcpToolRestriction(catalog), 'pencil_get_screenshot')).toEqual(HOST_TOOLS);
  });

  it('drops a failed server tools and restores them when it reconnects', () => {
    const catalog = new McpCatalog();
    catalog.applyStateChange({ serverName: 'pencil', state: 'connected' }, [mcpTool('get_screenshot')]);
    const owned = new Set(['pencil_get_screenshot']);

    catalog.applyStateChange({ serverName: 'pencil', state: 'failed' });
    expect(surviving(mcpToolRestriction(catalog, owned), 'pencil_get_screenshot')).toEqual(HOST_TOOLS);

    catalog.applyStateChange({ serverName: 'pencil', state: 'connected' }, [mcpTool('get_screenshot')]);
    expect(surviving(mcpToolRestriction(catalog, owned), 'pencil_get_screenshot')).toEqual([
      ...HOST_TOOLS,
      'pencil_get_screenshot',
    ]);
  });

  // The surface hands over every owner's list, so a restriction that added a name
  // back would resurrect a tool another owner had deliberately hidden.
  it('leaves tools this extension does not own alone, and never adds one', () => {
    const catalog = new McpCatalog();
    catalog.applyStateChange({ serverName: 'pencil', state: 'connected' }, [mcpTool('get_screenshot')]);

    expect(mcpToolRestriction(catalog)(['read', 'bash'], ['read', 'bash', 'pencil_get_screenshot'])).toEqual([
      'read',
      'bash',
    ]);
  });

  it('removes historically owned wrappers that the current catalog no longer contains', () => {
    const catalog = new McpCatalog();

    const restrict = mcpToolRestriction(catalog, new Set(['pencil_get_screenshot']));

    expect(surviving(restrict, 'pencil_get_screenshot')).toEqual(HOST_TOOLS);
  });

  it('withholds a current tool whose retained wrapper has incompatible schema', () => {
    const catalog = new McpCatalog();
    catalog.applyStateChange({ serverName: 'pencil', state: 'connected' }, [mcpTool('get_screenshot')]);

    const restrict = mcpToolRestriction(
      catalog,
      new Set(['pencil_get_screenshot']),
      new Set(['pencil_get_screenshot']),
    );

    expect(surviving(restrict, 'pencil_get_screenshot')).toEqual(HOST_TOOLS);
  });
});
