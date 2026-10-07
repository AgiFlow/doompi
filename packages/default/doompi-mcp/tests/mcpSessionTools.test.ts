import type { DoomMcpPluginContext } from '@agimon-ai/doompi-core/mcpFacet';
import { describe, expect, it, vi } from 'vitest';

import projectSessionTools from '../src/extensions/workspaces/sessions/(backend)/tool/session_mcp.mcp';
import type { CatalogTool } from '../src/services/mcpCatalog';
import { createMcpChildTool, createMcpSessionToolsService } from '../src/services/mcpSessionTools';

describe('MCP session tools service', () => {
  it('projects metadata, preserves results, and refreshes metadata-only changes', async () => {
    const tool: CatalogTool = {
      piName: 'docs_search',
      serverName: 'docs',
      toolName: 'search',
      inputSchema: { type: 'object' },
      annotations: { readOnlyHint: true },
      outputSchema: { type: 'object' },
    };
    const result = { content: [{ type: 'text', text: 'found' }], structuredContent: { count: 1 } };
    let changed: (() => void) | undefined;
    const stop = vi.fn();
    const session = {
      toolGeneration: 1,
      activeToolDefinitions: () => [tool],
      bindToolInvocation: () => vi.fn().mockResolvedValue(result),
      onChange: (listener: () => void) => {
        changed = listener;
        return stop;
      },
    };
    const service = createMcpSessionToolsService(session as never, 'fixture');
    const refresh = vi.fn();
    const controller = new AbortController();
    const context = {
      services: { get: () => service },
      signal: controller.signal,
      refresh,
    } as unknown as DoomMcpPluginContext;
    const [remote] = projectSessionTools(context);
    expect(remote).toMatchObject({ annotations: { readOnlyHint: true }, outputSchema: { type: 'object' } });
    await expect(remote!.execute('call', {}, undefined, undefined, context.execution)).resolves.toEqual(result);
    changed!();
    expect(refresh).not.toHaveBeenCalled();
    tool.annotations = { readOnlyHint: false };
    changed!();
    expect(refresh).toHaveBeenCalledTimes(1);
    tool.outputSchema = { type: 'object', required: ['count'] };
    changed!();
    expect(refresh).toHaveBeenCalledTimes(2);
    controller.abort();
    expect(stop).not.toHaveBeenCalled();
    service.dispose();
    expect(stop).toHaveBeenCalledOnce();
  });

  it('retains unchanged definitions and rejects retired wrappers after metadata, withdrawal, and generation changes', async () => {
    let tools: CatalogTool[] = [
      {
        piName: 'work_search',
        serverName: 'work',
        toolName: 'search',
        description: 'Search work',
        inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
      },
    ];
    let changed!: () => void;
    const invoke = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'work' }] });
    const stop = vi.fn();
    const session = {
      toolGeneration: 1,
      activeToolDefinitions: () => tools,
      bindToolInvocation: () => invoke,
      resolveToolSelectors: () =>
        tools.map((tool) => ({ name: tool.piName, selector: `${tool.serverName}/${tool.toolName}` })),
      onChange: (listener: () => void) => {
        changed = listener;
        return stop;
      },
    };
    const service = createMcpSessionToolsService(session as never, 'fixture');
    const first = service.project()[0]!;
    changed();
    expect(service.project()[0]).toBe(first);
    tools = [{ ...tools[0]!, description: 'Updated work search' }];
    changed();
    const second = service.project()[0]!;
    expect(second).not.toBe(first);
    await expect(first.execute('retired', {})).rejects.toThrow('no longer available');
    tools = [];
    changed();
    await expect(second.execute('withdrawn', {})).rejects.toThrow('no longer available');
    tools = [{ piName: 'work_search', serverName: 'work', toolName: 'search', inputSchema: {} }];
    changed();
    const third = service.project()[0]!;
    session.toolGeneration++;
    changed();
    await expect(third.execute('old-generation', {})).rejects.toThrow('no longer available');
    expect(service.resolveSelectors(['work/search'])).toEqual(['work_search']);
    const fourth = service.project()[0]!;
    service.dispose();
    await expect(fourth.execute('disposed', {})).rejects.toThrow('no longer available');
    expect(service.project()).toEqual([]);
    expect(stop).toHaveBeenCalledOnce();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('forwards snapshots and calls to the existing session runtime', async () => {
    const tool = { piName: 'pencil_get_screenshot', serverName: 'pencil', toolName: 'get_screenshot', inputSchema: {} };
    const session = {
      activeToolDefinitions: vi.fn(() => [tool]),
      onChange: vi.fn(() => () => undefined),
      bindToolInvocation: vi.fn(() => vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] })),
    };
    const service = createMcpSessionToolsService(session as never, 'session:mcp-tools');

    expect(service.snapshot()).toEqual([tool]);
    await expect(service.invoke(tool.piName, { quality: 'full' })).resolves.toEqual({
      content: [{ type: 'text', text: 'ok' }],
    });
    expect(session.bindToolInvocation).toHaveBeenCalledWith(tool);
    expect(session.bindToolInvocation.mock.results[0]!.value).toHaveBeenCalledWith({ quality: 'full' }, undefined);
  });
  it('rejects invalid downstream arguments before direct or compatibility transport', async () => {
    const invoke = vi.fn().mockResolvedValue({ content: [] });
    const session = {
      activeToolDefinitions: () => [
        {
          piName: 'work_search',
          serverName: 'work',
          toolName: 'search',
          inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
        },
      ],
      onChange: () => () => undefined,
      bindToolInvocation: () => invoke,
    };
    const service = createMcpSessionToolsService(session as never, 'validation');
    const direct = service.project()[0]!;
    await expect(direct.execute('invalid', { query: 42 })).rejects.toThrow('Invalid arguments');
    await expect(service.invoke('work_search', {})).rejects.toThrow('Invalid arguments');
    const compatibility = createMcpChildTool((parameters, signal) =>
      service.invoke('work_search', parameters.arguments ?? {}, signal),
    );
    await expect(compatibility.execute('invalid', { server: 'work', tool: 'search' })).rejects.toThrow(
      'Invalid arguments',
    );
    expect(invoke).not.toHaveBeenCalled();
    await service.invoke('work_search', { query: 'valid' });
    expect(invoke).toHaveBeenCalledExactlyOnceWith({ query: 'valid' }, undefined);
    service.dispose();
  });

  it('validates file parameters as the path objects the model sends, not the server shape', async () => {
    const invoke = vi.fn().mockResolvedValue({ content: [] });
    const session = {
      activeToolDefinitions: () => [
        {
          piName: 'work_upload',
          serverName: 'work',
          toolName: 'upload',
          inputSchema: {
            type: 'object',
            properties: { file: { type: 'object', properties: { download_url: { type: 'string' } } } },
            required: ['file'],
          },
          _meta: { 'openai/fileParams': ['file'] },
        },
      ],
      onChange: () => () => undefined,
      bindToolInvocation: () => invoke,
    };
    const service = createMcpSessionToolsService(session as never, 'file-params');
    const direct = service.project()[0]!;

    expect(direct.parameters).toHaveProperty('properties.file.required', ['path']);
    await expect(direct.execute('server-shape', { file: { download_url: 'https://cdn.example/f' } })).rejects.toThrow(
      'Invalid arguments',
    );
    expect(invoke).not.toHaveBeenCalled();
    await direct.execute('path', { file: { path: 'docs/report.pdf' } });
    expect(invoke).toHaveBeenCalledExactlyOnceWith({ file: { path: 'docs/report.pdf' } }, undefined);
    service.dispose();
  });
});

describe('native child MCP dispatcher', () => {
  it('validates arguments and preserves images, errors, details, and cancellation', async () => {
    const result = {
      content: [{ type: 'image' as const, data: 'YWJj', mimeType: 'image/png' }],
      isError: true,
      details: { reason: 'denied' },
    };
    const invoke = vi.fn(async () => result);
    const tool = createMcpChildTool(invoke);
    const parameters = { server: 'docs', tool: 'search', arguments: { query: 'templates' } };
    const controller = new AbortController();
    await expect(tool.execute('call', parameters, controller.signal)).resolves.toBe(result);
    expect(invoke).toHaveBeenCalledWith(parameters, controller.signal);
    await expect(tool.execute('invalid', { server: '', tool: 'search' })).rejects.toThrow('Invalid MCP tool arguments');
    controller.abort(new Error('cancelled'));
    await expect(tool.execute('cancelled', parameters, controller.signal)).rejects.toThrow('cancelled');
    expect(invoke).toHaveBeenCalledOnce();
  });

  it('does not return an upstream result after the child has been aborted', async () => {
    const controller = new AbortController();
    const tool = createMcpChildTool(async () => {
      controller.abort(new Error('child stopped'));
      return { content: [{ type: 'text', text: 'late result' }] };
    });
    await expect(tool.execute('call', { server: 'docs', tool: 'search' }, controller.signal)).rejects.toThrow(
      'child stopped',
    );
  });
});
