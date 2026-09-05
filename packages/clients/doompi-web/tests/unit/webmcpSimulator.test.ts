import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWebMcpSimulator, type WebMcpSimulator } from '../../src/web/lib/webmcpSimulator.ts';

let simulator: WebMcpSimulator | undefined;

afterEach(() => {
  simulator?.dispose();
  simulator = undefined;
});

function createSimulator(): WebMcpSimulator {
  simulator = createWebMcpSimulator();
  return simulator;
}

describe('WebMCP simulator', () => {
  it('registers cloned descriptors, emits changes, and removes a tool when registration aborts', async () => {
    const context = createSimulator();
    const registration = new AbortController();
    const changed = vi.fn();
    const inputSchema = { type: 'object', properties: { value: { type: 'number' } } };
    context.addEventListener('toolchange', changed);
    void context.registerTool(
      { name: 'calculate', description: 'Calculate', inputSchema, execute: async () => 1 },
      { signal: registration.signal },
    );
    inputSchema.type = 'mutated';

    const first = await context.getTools();
    expect(first).toEqual([
      {
        name: 'calculate',
        description: 'Calculate',
        inputSchema: { type: 'object', properties: { value: { type: 'number' } } },
      },
    ]);
    const returnedDescriptor = first[0];
    expect(returnedDescriptor).toBeDefined();
    if (returnedDescriptor === undefined) return;
    (returnedDescriptor.inputSchema as { type: string }).type = 'changed again';
    expect((await context.getTools())[0]?.inputSchema).toMatchObject({ type: 'object' });
    expect(changed).toHaveBeenCalledOnce();

    registration.abort();
    expect(await context.getTools()).toEqual([]);
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it('rejects duplicate names and already-aborted registrations', () => {
    const context = createSimulator();
    const first = new AbortController();
    const aborted = new AbortController();
    aborted.abort();
    const tool = { name: 'one', description: 'One', inputSchema: {}, execute: async () => undefined };

    void context.registerTool(tool, { signal: first.signal });
    expect(() => context.registerTool(tool, { signal: new AbortController().signal })).toThrow('already registered');
    expect(() => context.registerTool({ ...tool, name: 'two' }, { signal: aborted.signal })).toThrow(/aborted/i);
  });

  it('parses execution input and aborts running execution through the callback signal', async () => {
    const context = createSimulator();
    const registration = new AbortController();
    const execution = new AbortController();
    let callbackSignal: { aborted: boolean } | undefined;
    void context.registerTool(
      {
        name: 'wait',
        description: 'Wait',
        inputSchema: {},
        execute: async (input, options) => {
          expect(JSON.parse(input)).toEqual({ duration: 10 });
          callbackSignal = options.signal;
          return await new Promise(() => undefined);
        },
      },
      { signal: registration.signal },
    );

    const result = context.executeTool('wait', '{"duration":10}', { signal: execution.signal });
    await Promise.resolve();
    execution.abort();

    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
    expect(callbackSignal?.aborted).toBe(true);
  });

  it('rejects malformed JSON and execution of unknown tools', async () => {
    const context = createSimulator();
    const signal = new AbortController().signal;
    await expect(context.executeTool('missing', '{}', { signal })).rejects.toThrow('No model context tool');
    void context.registerTool(
      { name: 'known', description: 'Known', inputSchema: {}, execute: async () => undefined },
      { signal },
    );
    await expect(context.executeTool('known', '{', { signal })).rejects.toBeInstanceOf(SyntaxError);
  });

  it('disposes registrations and aborts running executions', async () => {
    const context = createSimulator();
    const registration = new AbortController();
    void context.registerTool(
      { name: 'wait', description: 'Wait', inputSchema: {}, execute: async () => await new Promise(() => undefined) },
      { signal: registration.signal },
    );
    const result = context.executeTool('wait', '{}', { signal: new AbortController().signal });
    context.dispose();

    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
    expect(await context.getTools()).toEqual([]);
    expect(() =>
      context.registerTool(
        { name: 'later', description: 'Later', inputSchema: {}, execute: async () => undefined },
        { signal: new AbortController().signal },
      ),
    ).toThrow('disposed');
  });
});
