import type { DoomHeadlessExecutionContext, DoomHeadlessTool } from '@agimon-ai/doompi-core/headless';
import type { DoomMcpPluginContext } from '@agimon-ai/doompi-core/mcp-facet';
import type { DoomServerPluginContext } from '@agimon-ai/doompi-core/server-facet';
import type { Context } from '@deepseek-ai/cordis';
import { describe, expect, it, vi } from 'vitest';

import root from '../../src/extensions/workspaces/sessions/(backend)/_lib/root.server';
import {
  bindMcpHeadlessTool,
  type McpHeadlessToolCatalog,
  USER_FEEDBACK_MCP_HEADLESS_TOOLS_SERVICE,
} from '../../src/services/mcpHeadlessTools';

function contextFor(tool: DoomHeadlessTool, lifecycle: AbortController) {
  const get = vi.fn(<T>(name: string): T | undefined => {
    if (name !== USER_FEEDBACK_MCP_HEADLESS_TOOLS_SERVICE) return undefined;
    return { get: (toolName: string) => (toolName === tool.name ? tool : undefined) } as T;
  });
  const context = {
    execution: {} as DoomHeadlessExecutionContext,
    services: { get },
    selection: { read: vi.fn(), change: vi.fn() },
    signal: lifecycle.signal,
  } as unknown as DoomMcpPluginContext;
  return { context, get };
}

describe('User Feedback MCP headless tools', () => {
  it('mounts the root-owned questionnaire tool rather than a per-call coordinator', async () => {
    const scope = await root({} as DoomServerPluginContext);
    const service = scope.services?.[0] as ((context: Context) => void) | undefined;
    if (!service) throw new Error('Questionnaire MCP service was not mounted');
    let catalog: McpHeadlessToolCatalog | undefined;
    service({
      plugin: (plugin: (context: { provide(name: string, value: McpHeadlessToolCatalog): void }) => void) => {
        plugin({ provide: (_name, value) => (catalog = value) });
      },
    } as never);

    const enqueue = vi.spyOn(scope.value.coordinator, 'enqueue').mockResolvedValue({ answers: [], cancelled: true });
    const tool = catalog?.get('ask_user_question');
    if (!tool) throw new Error('Questionnaire tool was not mounted');
    await tool.execute(
      'call',
      {
        questions: [
          {
            question: 'Continue?',
            header: 'CONFIRM',
            options: [
              { label: 'Yes', description: 'Continue.' },
              { label: 'No', description: 'Stop.' },
            ],
          },
        ],
      },
      undefined,
      undefined,
      {} as DoomHeadlessExecutionContext,
    );

    expect(enqueue).toHaveBeenCalledOnce();
    scope.value.coordinator.shutdown();
  });

  it('binds the root-owned questionnaire tool through the session service and lifecycle', async () => {
    let receivedSignal: AbortSignal | undefined;
    const execute = vi.fn((_id, _parameters, signal) => {
      receivedSignal = signal;
      return Promise.resolve({ content: [{ type: 'text' as const, text: 'ok' }] });
    });
    const tool = {
      name: 'ask_user_question',
      label: 'Ask User Question',
      description: 'test',
      parameters: {},
      execute,
    } as DoomHeadlessTool;
    const lifecycle = new AbortController();
    const { context, get } = contextFor(tool, lifecycle);

    const bound = bindMcpHeadlessTool(context, 'ask_user_question');
    await bound.execute('call', {}, undefined, undefined, context.execution);

    expect(get).toHaveBeenCalledWith(USER_FEEDBACK_MCP_HEADLESS_TOOLS_SERVICE);
    expect(receivedSignal?.aborted).toBe(false);
    lifecycle.abort();
    expect(receivedSignal?.aborted).toBe(true);
  });

  it('rejects a tool that is not mounted in the session catalog', () => {
    const lifecycle = new AbortController();
    const context = {
      services: { get: () => ({ get: () => undefined }) as McpHeadlessToolCatalog },
      signal: lifecycle.signal,
    } as unknown as DoomMcpPluginContext;

    expect(() => bindMcpHeadlessTool(context, 'ask_user_question')).toThrow(
      'User Feedback tool is unavailable: ask_user_question',
    );
  });
});
