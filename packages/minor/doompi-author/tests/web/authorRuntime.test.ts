import type { ModelContext, ModelContextTool, WebPluginRuntime } from '@agimon-ai/doompi-web-contracts';
import { describe, expect, it, vi } from 'vitest';
import { AuthorClientBroker } from '../../src/web/authorBroker.ts';
import { AuthorRuntime } from '../../src/web/AuthorRuntime.ts';

function fixture() {
  const tools = new Map<string, ModelContextTool>();
  const modelContext: ModelContext = {
    registerTool(tool, options) {
      if (tools.has(tool.name)) throw new Error(`A model context tool named '${tool.name}' is already registered.`);
      tools.set(tool.name, tool);
      options.signal.addEventListener('abort', () => {
        if (tools.get(tool.name) === tool) tools.delete(tool.name);
      });
    },
    async getTools() {
      return [...tools.values()];
    },
    async executeTool(name, input, options) {
      const tool = tools.get(name);
      if (tool === undefined) throw new Error('missing tool');
      return tool.execute(input, options);
    },
    addEventListener() {},
    removeEventListener() {},
  };
  const pluginRuntime: WebPluginRuntime = {
    sendSessionFrame() {},
    sendHubFrame() {},
    onHubConnected: () => () => undefined,
    acquireModelContext: async () => ({ kind: 'simulator', modelContext }),
  };
  return { modelContext, pluginRuntime, tools };
}

const profile = (result: string) => ({
  id: 'author.viewport.test',
  tools: [
    {
      name: 'author_test',
      description: 'Test trusted registration.',
      inputSchema: { type: 'object' },
      execute: vi.fn(async () => result),
    },
  ],
});

describe('AuthorRuntime', () => {
  it('replaces a duplicate stable tool name after aborting the old simulator registration', async () => {
    const { pluginRuntime, tools } = fixture();
    const runtime = new AuthorRuntime(pluginRuntime);
    await runtime.replaceProfiles([profile('first')]);
    const stale = tools.get('author_test')!;
    await runtime.replaceProfiles([profile('second')]);

    await expect(stale.execute('{not json', { signal: new AbortController().signal })).rejects.toThrow('stale');
    await expect(runtime.execute('author_test', {}, new AbortController().signal)).resolves.toBe('second');
  });

  it('stays inactive when replacement confirmation fails after removing the old catalog', async () => {
    const { modelContext, pluginRuntime, tools } = fixture();
    const runtime = new AuthorRuntime(pluginRuntime);
    await runtime.replaceProfiles([profile('first')]);
    vi.spyOn(modelContext, 'getTools').mockResolvedValueOnce([]);

    await expect(runtime.replaceProfiles([profile('second')])).rejects.toThrow('did not confirm');
    expect(tools.size).toBe(0);
    await expect(runtime.execute('author_test', {}, new AbortController().signal)).rejects.toThrow('not registered');
  });
  it('rejects untrusted profile limits before acquisition', async () => {
    const { pluginRuntime } = fixture();
    const acquire = vi.spyOn(pluginRuntime, 'acquireModelContext');
    const runtime = new AuthorRuntime(pluginRuntime);
    await expect(
      runtime.replaceProfiles([
        {
          id: 'bad',
          tools: Array.from({ length: 16 }, (_, index) => ({
            name: `tool_${index}`,
            description: 'x',
            inputSchema: {},
            execute: async () => null,
          })),
        },
      ]),
    ).rejects.toThrow('at most 15');
    expect(acquire).not.toHaveBeenCalled();
  });
});

describe('AuthorClientBroker', () => {
  it('uses executeTool rather than a registered callback reference', async () => {
    const { modelContext } = fixture();
    const execute = vi.spyOn(modelContext, 'executeTool').mockResolvedValue('ok');
    const signal = new AbortController().signal;
    await expect(new AuthorClientBroker(modelContext).execute('author_test', { value: 1 }, signal)).resolves.toBe('ok');
    expect(execute).toHaveBeenCalledWith('author_test', '{"value":1}', { signal });
  });
});
