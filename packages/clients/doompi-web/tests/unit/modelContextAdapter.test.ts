import type { ModelContext } from '@agimon-ai/doompi-web-contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { acquireModelContext, disposeModelContextAdapter } from '../../src/web/lib/modelContextAdapter.ts';

function nativeContext(): ModelContext {
  return {
    registerTool: vi.fn(),
    getTools: vi.fn(async () => []),
    executeTool: vi.fn(async () => undefined),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
}

afterEach(() => {
  disposeModelContextAdapter();
});

describe('model context adapter', () => {
  it('selects and binds a complete native document surface', async () => {
    const native = nativeContext();
    const schema = { type: 'object' };
    vi.mocked(native.getTools).mockResolvedValueOnce([
      { name: 'native', description: 'Native', inputSchema: schema, execute: async () => undefined } as never,
    ]);
    const binding = await acquireModelContext({ modelContext: native });

    expect(binding.kind).toBe('native');
    const descriptors = await binding.modelContext.getTools();
    expect(native.getTools).toHaveBeenCalledOnce();
    expect(descriptors).toEqual([{ name: 'native', description: 'Native', inputSchema: { type: 'object' } }]);
    expect(descriptors[0]).not.toHaveProperty('execute');
    expect(descriptors[0]?.inputSchema).not.toBe(schema);
  });

  it.each(['registerTool', 'getTools', 'executeTool', 'addEventListener', 'removeEventListener'] as const)(
    'uses the simulator when the native surface lacks %s',
    async (method) => {
      const incomplete = nativeContext() as unknown as Record<string, unknown>;
      delete incomplete[method];

      await expect(acquireModelContext({ modelContext: incomplete })).resolves.toMatchObject({ kind: 'simulator' });
    },
  );

  it('lazily creates and caches one simulator for the page lifetime', async () => {
    const first = acquireModelContext({});
    const second = acquireModelContext({ modelContext: nativeContext() });

    expect(first).toBe(second);
    const [firstBinding, secondBinding] = await Promise.all([first, second]);
    expect(firstBinding.kind).toBe('simulator');
    expect(secondBinding).toBe(firstBinding);
  });

  it('does not fall back after selecting a native surface that later fails', async () => {
    const native = nativeContext();
    vi.mocked(native.getTools).mockRejectedValueOnce(new Error('native unavailable'));
    const binding = await acquireModelContext({ modelContext: native });

    await expect(binding.modelContext.getTools()).rejects.toThrow('native unavailable');
    await expect(acquireModelContext({})).resolves.toBe(binding);
    expect(binding.kind).toBe('native');
  });

  it('disposes and replaces the page simulator', async () => {
    const first = await acquireModelContext({});
    disposeModelContextAdapter();
    await expect(first.modelContext.getTools()).resolves.toEqual([]);
    expect(() =>
      first.modelContext.registerTool(
        { name: 'late', description: 'Late', inputSchema: {}, execute: async () => undefined },
        { signal: new AbortController().signal },
      ),
    ).toThrow('disposed');

    const second = await acquireModelContext({});
    expect(second.modelContext).not.toBe(first.modelContext);
  });
});
