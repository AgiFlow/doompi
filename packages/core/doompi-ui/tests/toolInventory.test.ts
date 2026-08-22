import { fileURLToPath } from 'node:url';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { describe, expect, it } from 'vitest';
import { extensionName, extensionToolSource, withExtensionSource } from '../src/adapters/pi/extensionName.ts';
import { buildToolSources, type McpServerStatus, type ToolInfo } from '../src/services/tools/toolInventory.ts';

function tool(name: string, source: string, path = `<${source}>`): ToolInfo {
  return {
    name,
    description: `${name} description`,
    sourceInfo: { path, source, scope: 'project', origin: 'top-level' },
  } as ToolInfo;
}

const MCP_EXTENSION_PATH = '/repo/.pi/doom/mcp-extension.ts';

function mcpTool(name: string): ToolInfo {
  return tool(name, 'mcp-extension', MCP_EXTENSION_PATH);
}

function server(name: string, state: McpServerStatus['state'], tools: string[] = []): McpServerStatus {
  return { name, state, tools, resourceCount: 0 };
}

describe('buildToolSources', () => {
  it('splits pi built-ins, mcp servers and extensions into ordered groups', () => {
    const sources = buildToolSources({
      tools: [
        tool('bash', 'builtin', '<builtin:bash>'),
        tool('read', 'builtin', '<builtin:read>'),
        mcpTool('mcp__code_intel_get_diagnostics'),
        mcpTool('log_sink_search_logs'),
        tool('tasks', '@agimon-ai/doompi-task'),
      ],
      activeTools: ['read', 'tasks'],
      mcpServers: [
        server('code-intel', 'connected', ['mcp__code_intel_get_diagnostics']),
        server('log-sink', 'connected', ['log_sink_search_logs']),
      ],
    });

    expect(sources.map((source) => [source.kind, source.label])).toEqual([
      ['core', 'pi · core'],
      ['mcp', 'code-intel · mcp'],
      ['mcp', 'log-sink · mcp'],
      ['extension', '@agimon-ai/doompi-task · extension'],
    ]);
    expect(sources[0]?.tools.map((entry) => [entry.name, entry.active])).toEqual([
      ['bash', false],
      ['read', true],
    ]);
    expect(sources[2]?.tools.map((entry) => entry.name)).toEqual(['log_sink_search_logs']);
    expect(sources[3]?.detail).toBe('<@agimon-ai/doompi-task>');
  });

  // Attribution comes from the snapshot, so it holds under any naming scheme,
  // including names that carry no server prefix at all.
  it('attributes tools by the names the server declares, whatever their shape', () => {
    const sources = buildToolSources({
      tools: [
        mcpTool('project_mcp_list'),
        mcpTool('mcp__project_mcp_get'),
        mcpTool('find'),
        tool('unclaimed', 'mcp-extension', MCP_EXTENSION_PATH),
      ],
      activeTools: [],
      mcpServers: [server('project-mcp', 'connected', ['project_mcp_list', 'mcp__project_mcp_get', 'find'])],
    });

    expect(sources.find((source) => source.kind === 'mcp')?.tools.map((entry) => entry.name)).toEqual([
      'find',
      'mcp__project_mcp_get',
      'project_mcp_list',
    ]);
    // A tool no server claims stays with the extension that registered it.
    expect(sources.find((source) => source.kind === 'extension')?.tools.map((entry) => entry.name)).toEqual([
      'unclaimed',
    ]);
  });

  // Prefix matching gave this tool to whichever server had the longer prefix.
  it('does not give one server a tool that another server declared', () => {
    const sources = buildToolSources({
      tools: [mcpTool('code_intel_lsp_diagnostics')],
      activeTools: [],
      mcpServers: [server('code', 'connected', ['code_intel_lsp_diagnostics']), server('code-intel', 'connected')],
    });

    expect(sources.find((source) => source.tools.length > 0)?.label).toBe('code · mcp');
  });

  it('leaves a connected server without a status so its count shows instead', () => {
    const sources = buildToolSources({
      tools: [mcpTool('code_intel_get_diagnostics')],
      activeTools: [],
      mcpServers: [server('code-intel', 'connected', ['code_intel_get_diagnostics'])],
    });

    expect(sources.map((source) => [source.label, source.status])).toEqual([['code-intel · mcp', undefined]]);
  });

  it('lists every configured server, with the state that explains an empty one', () => {
    const sources = buildToolSources({
      tools: [],
      activeTools: [],
      mcpServers: [
        server('code-intel', 'disabled'),
        server('pencil', 'needs-auth'),
        server('rive', 'connected'),
        server('boomlink', 'not-connected'),
      ],
    });

    // Sources are ordered by label, not by the order the snapshot listed them.
    expect(sources.map((source) => [source.label, source.status])).toEqual([
      ['boomlink · mcp', 'not connected'],
      ['code-intel · mcp', 'disabled'],
      ['pencil · mcp', 'needs auth'],
      ['rive · mcp', undefined],
    ]);
  });

  it('falls back to extension groups when no mcp snapshot arrived', () => {
    const sources = buildToolSources({
      tools: [mcpTool('mcp__pencil_execute'), tool('read', 'builtin', '<builtin:read>')],
      activeTools: [],
    });

    expect(sources.map((source) => [source.kind, source.label])).toEqual([
      ['core', 'pi · core'],
      ['extension', 'mcp-extension · extension'],
    ]);
  });

  it('names cli extensions after the package that registered them', () => {
    // Pi tags every `--extension <path>` argument `cli`, so all of doom-pi's
    // extensions would otherwise share one meaningless label.
    const entry = fileURLToPath(new URL('../extensions/pi.ts', import.meta.url));
    const sources = buildToolSources({
      tools: [tool('tools', 'cli', entry), tool('intercom', 'cli', '/nowhere/team-entry.ts')],
      activeTools: [],
      resolveExtensionName: extensionName,
    });

    expect(sources.map((source) => source.label)).toEqual(['doompi-ui · extension', 'team-entry · extension']);
    expect(sources[0]?.detail).toBe(entry);
  });

  it('keeps bundled tools grouped by their original extension entries', () => {
    const bundlePath = '/repo/.pi/doom/dist/copilot.1234.mjs';
    const taskEntry = fileURLToPath(
      new URL('../../../../layers/task/doompi-task/src/exports/extensions/pi.ts', import.meta.url),
    );
    const loopEntry = fileURLToPath(
      new URL('../../../minor/doompi-loop/src/exports/extensions/pi.ts', import.meta.url),
    );
    const pi = { registerTool: () => undefined } as unknown as ExtensionAPI;
    const register = (name: string, entry: string): void => {
      const definition = { name } as Parameters<ExtensionAPI['registerTool']>[0];
      withExtensionSource(pi, entry).registerTool(definition);
    };
    register('bundled_task_tool', taskEntry);
    register('bundled_loop_tool', loopEntry);

    const sources = buildToolSources({
      tools: [tool('bundled_task_tool', 'local', bundlePath), tool('bundled_loop_tool', 'local', bundlePath)],
      activeTools: ['bundled_task_tool', 'bundled_loop_tool'],
      resolveExtensionName: extensionName,
      resolveExtensionToolSource: (toolName) => extensionToolSource(pi, toolName),
    });

    expect(sources.map((source) => [source.label, source.detail])).toEqual([
      ['doompi-loop · extension', loopEntry],
      ['doompi-task · extension', taskEntry],
    ]);
  });
});
