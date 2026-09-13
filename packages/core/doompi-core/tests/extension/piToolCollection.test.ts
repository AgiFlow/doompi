import { Type } from 'typebox';
import { describe, expect, it, vi } from 'vitest';

import { definePiExtension, type PiToolCollection, type PiToolContribution } from '../../src/extensions/piExtension';
import { definePiTool } from '../../src/schemas/piTool';
import { defineTool } from '../../src/schemas/pluginContributions';
import { createPiTestHost } from '../../src/testing/pi/testHost';

function collection(initial: readonly PiToolContribution[] = []) {
  let tools = initial;
  const listeners = new Set<() => void>();
  const unsubscribe = vi.fn();
  const source: PiToolCollection = {
    snapshot: () => tools,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        unsubscribe();
      };
    },
  };
  return {
    source,
    unsubscribe,
    set(next: readonly PiToolContribution[]) {
      tools = next;
      for (const listener of listeners) listener();
    },
    listeners,
  };
}

function portable(name: string) {
  return defineTool({
    name,
    description: name,
    parameters: Type.Object({}),
    async execute() {
      return { content: [{ type: 'text', text: name }] };
    },
  });
}

describe('Pi live tool collections', () => {
  it('subscribes before snapshot and reconciles reentrant changes without duplicate registrations', async () => {
    const host = createPiTestHost();
    await host.cordis();
    const first = portable('first');
    const second = portable('second');
    const live = collection();
    const subscribe = live.source.subscribe.bind(live.source);
    live.source.subscribe = (listener) => {
      const stop = subscribe(listener);
      live.set([first]);
      return stop;
    };
    const register = host.pi.registerTool.bind(host.pi);
    vi.spyOn(host.pi, 'registerTool').mockImplementation((tool) => {
      register(tool);
      if (tool.name === 'first') live.set([first, second]);
    });
    await definePiExtension({ name: 'live', tools: live.source })(host.pi);
    expect(host.tools.map((tool) => tool.name)).toEqual(['first', 'second']);
    live.set([first, second]);
    expect(host.tools).toHaveLength(2);
    await host.emit('session_shutdown', { reason: 'quit' });
    await host.dispose();
    expect(live.unsubscribe).toHaveBeenCalledOnce();
    live.set([portable('late')]);
    expect(host.tools).toHaveLength(2);
  });

  it('fences removals and replaces changed declarations without duplicating names', async () => {
    const host = createPiTestHost();
    await host.cordis();
    const original = portable('tool');
    const live = collection([original]);
    await definePiExtension({ name: 'live', tools: live.source })(host.pi);
    await expect(host.callTool('tool')).resolves.toMatchObject({ content: [{ text: 'tool' }] });
    live.set([]);
    await expect(host.callTool('tool')).rejects.toThrow('unavailable');
    live.set([portable('tool')]);
    await expect(host.callTool('tool')).resolves.toMatchObject({ content: [{ text: 'tool' }] });
    expect(host.tools).toHaveLength(2);
    live.set([original]);
    await expect(host.callTool('tool')).resolves.toMatchObject({ content: [{ text: 'tool' }] });
    await host.emit('session_shutdown', { reason: 'quit' });
    await host.dispose();
    await expect(host.callTool('tool')).rejects.toThrow();
  });

  it('preserves native renderers and aborts in-flight native work on removal', async () => {
    const host = createPiTestHost();
    await host.cordis();
    let signal: AbortSignal | undefined;
    const renderCall = vi.fn(() => ({ render: () => ['native'], invalidate() {} }));
    const native = definePiTool({
      name: 'native',
      label: 'Native',
      description: 'Native',
      parameters: Type.Object({ path: Type.String() }),
      renderCall,
      async execute(_id, input, executionSignal) {
        signal = executionSignal;
        return { content: [{ type: 'text', text: input.path }], details: { native: true } };
      },
    });
    const live = collection([native]);
    await definePiExtension({ name: 'live-native', tools: live.source })(host.pi);
    expect(host.tools[0]?.renderCall).toBe(renderCall);
    await host.callTool('native', { path: '/repo' });
    expect(signal?.aborted).toBe(false);
    live.set([]);
    expect(signal?.aborted).toBe(true);
    await expect(host.callTool('native', { path: '/repo' })).rejects.toThrow('unavailable');
    await host.emit('session_shutdown', { reason: 'quit' });
    await host.dispose();
  });

  it('fails startup safely for invalid snapshots and releases the subscription', async () => {
    const host = createPiTestHost();
    await host.cordis();
    const live = collection([portable('duplicate'), portable('duplicate')]);
    await expect(definePiExtension({ name: 'invalid', tools: live.source })(host.pi)).rejects.toThrow(
      'Duplicate live tool name',
    );
    expect(host.tools).toHaveLength(0);
    expect(live.unsubscribe).toHaveBeenCalledOnce();
    await host.emit('session_shutdown', { reason: 'quit' });
    await host.dispose();
  });

  it('disables existing wrappers if a later snapshot throws', async () => {
    const host = createPiTestHost();
    await host.cordis();
    const live = collection([portable('tool')]);
    await definePiExtension({ name: 'invalid-update', tools: live.source })(host.pi);
    live.source.snapshot = () => {
      throw new Error('snapshot unavailable');
    };
    expect(() => live.set([])).not.toThrow();
    await expect(host.callTool('tool')).rejects.toThrow('unavailable');
    await host.emit('session_shutdown', { reason: 'quit' });
    await host.dispose();
  });
});

it('retires an in-flight declaration when a same-name replacement updates metadata and dispatch', async () => {
  const host = createPiTestHost();
  await host.cordis();
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const original = defineTool({
    name: 'replace',
    description: 'Old metadata',
    parameters: Type.Object({}),
    async execute(_input, execution) {
      entered();
      await new Promise<void>((_resolve, reject) =>
        execution.signal!.addEventListener('abort', () => reject(execution.signal!.reason), { once: true }),
      );
      return { content: [] };
    },
  });
  const live = collection([original]);
  await definePiExtension({ name: 'replace', tools: live.source })(host.pi);
  const retired = host.tools[0]!;
  const pending = host.callTool('replace');
  const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  await started;
  live.set([
    defineTool({
      name: 'replace',
      description: 'Updated metadata',
      parameters: Type.Object({}),
      async execute() {
        return { content: [{ type: 'text', text: 'replacement' }] };
      },
    }),
  ]);
  await rejection;
  expect(host.tools).toHaveLength(2);
  expect(host.tool('replace')?.description).toBe('Updated metadata');
  await expect(host.callTool('replace')).resolves.toMatchObject({ content: [{ text: 'replacement' }] });
  await expect(retired.execute('retired', {}, undefined, undefined, {} as never)).rejects.toThrow('unavailable');
  await host.dispose();
});
