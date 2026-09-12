import { describe, expect, it, vi } from 'vitest';
import { createDoomKernel } from '../../src/exports/kernel';

/** Collects every list a slot receives, which is the whole observable contract. */
function recorder(): { pushes: string[][]; sink: (active: readonly string[]) => void } {
  const pushes: string[][] = [];
  return { pushes, sink: (active) => void pushes.push([...active]) };
}

describe('createDoomKernel', () => {
  it('pushes only the contributions whose layer is active', async () => {
    const kernel = createDoomKernel({ activeLayers: ['team'] });
    const tools = recorder();
    const slot = kernel.defineSlot('tools', tools.sink);

    slot.contribute({ source: 'team', layer: 'team', value: 'delegate' });
    slot.contribute({ source: 'plan', layer: 'plan', value: 'plan' });
    slot.contribute({ source: 'core', value: 'always' });
    await kernel.refresh('tools');

    expect(tools.pushes.at(-1)).toEqual(['delegate', 'always']);
  });

  it('recomposes the union when the active layers change, without re-registering', async () => {
    const kernel = createDoomKernel({ activeLayers: ['team'] });
    const tools = recorder();
    const slot = kernel.defineSlot('tools', tools.sink);
    slot.contribute({ source: 'team', layer: 'team', value: 'delegate' });
    slot.contribute({ source: 'plan', layer: 'plan', value: 'plan' });
    await kernel.refresh();

    await kernel.setActiveLayers(['plan']);

    // Removal is inherent: the sink receives the whole list, not a delta.
    expect(tools.pushes.at(-1)).toEqual(['plan']);
    expect(kernel.activeLayers).toEqual(['plan']);
  });

  it('keeps registration order stable across a recompute', async () => {
    const kernel = createDoomKernel({ activeLayers: ['a', 'b'] });
    const tools = recorder();
    const slot = kernel.defineSlot('tools', tools.sink);
    slot.contribute({ source: 'one', layer: 'a', value: 'first' });
    slot.contribute({ source: 'two', layer: 'b', value: 'second' });
    slot.contribute({ source: 'three', layer: 'a', value: 'third' });

    await kernel.refresh();
    await kernel.setActiveLayers(['b', 'a']);

    expect(tools.pushes.at(-1)).toEqual(['first', 'second', 'third']);
  });

  it('coalesces startup registrations into one push per slot', async () => {
    const kernel = createDoomKernel({ activeLayers: ['team'] });
    const sink = vi.fn();
    const slot = kernel.defineSlot<string>('tools', sink);

    for (let index = 0; index < 20; index += 1) {
      slot.contribute({ source: `package-${index}`, layer: 'team', value: `tool-${index}` });
    }
    await kernel.refresh();

    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink.mock.calls[0]?.[0]).toHaveLength(20);
  });

  it('does not push a slot whose active list is unchanged', async () => {
    const kernel = createDoomKernel({ activeLayers: ['team'] });
    const sink = vi.fn();
    const slot = kernel.defineSlot<string>('tools', sink);
    slot.contribute({ source: 'team', layer: 'team', value: 'delegate' });
    await kernel.refresh();
    sink.mockClear();

    // 'plan' owns nothing, so the union is identical and the host stays quiet.
    await kernel.setActiveLayers(['team', 'plan']);

    expect(sink).not.toHaveBeenCalled();
  });

  it('re-pushes an unchanged list when refresh is asked for it', async () => {
    const kernel = createDoomKernel({ activeLayers: ['team'] });
    const sink = vi.fn();
    const slot = kernel.defineSlot<string>('resources', sink);
    slot.contribute({ source: 'core', value: 'skills' });
    await kernel.refresh();
    sink.mockClear();

    // A domain change alters what a resource renders, not which ones apply.
    await kernel.refresh('resources');

    expect(sink).toHaveBeenCalledTimes(1);
  });

  it('drops a disposed contribution from the next union', async () => {
    const kernel = createDoomKernel({ activeLayers: ['team'] });
    const tools = recorder();
    const slot = kernel.defineSlot('tools', tools.sink);
    const registration = slot.contribute({ source: 'team', layer: 'team', value: 'delegate' });
    slot.contribute({ source: 'team', layer: 'team', value: 'fleet' });
    await kernel.refresh();

    registration.dispose();
    registration.dispose();
    await kernel.refresh();

    expect(tools.pushes.at(-1)).toEqual(['fleet']);
  });

  it('applies every other slot when one sink throws, then reports the failure', async () => {
    const kernel = createDoomKernel({ activeLayers: ['team'] });
    const healthy = recorder();
    kernel.defineSlot<string>('broken', () => {
      throw new Error('host refused');
    });
    const good = kernel.defineSlot('commands', healthy.sink);
    kernel.contribute('broken', { source: 'team', layer: 'team', value: 'boom' });
    good.contribute({ source: 'team', layer: 'team', value: 'fleet' });

    await expect(kernel.refresh()).rejects.toThrow(/broken: host refused/);
    expect(healthy.pushes.at(-1)).toEqual(['fleet']);
  });

  it('recovers the serialized queue and retries the same values after a sink failure', async () => {
    const kernel = createDoomKernel({ activeLayers: ['a'] });
    const applied: string[][] = [];
    let fail = true;
    const slot = kernel.defineSlot<string>('tools', (active) => {
      if (fail) throw new Error('host refused');
      applied.push([...active]);
    });
    slot.contribute({ source: 'one', layer: 'a', value: 'a-tool' });
    slot.contribute({ source: 'two', layer: 'b', value: 'b-tool' });

    await expect(kernel.setActiveLayers(['b'])).rejects.toThrow(/tools: host refused/);
    fail = false;
    await kernel.setActiveLayers(['b']);

    expect(applied).toEqual([['b-tool']]);
    expect(kernel.activeValues('tools')).toEqual(['b-tool']);
  });

  it('continues with a later queued switch after an earlier application rejects', async () => {
    const kernel = createDoomKernel({ activeLayers: ['a'] });
    const applied: string[][] = [];
    let calls = 0;
    const slot = kernel.defineSlot<string>('tools', (active) => {
      calls += 1;
      if (calls === 1) throw new Error('first refused');
      applied.push([...active]);
    });
    slot.contribute({ source: 'one', layer: 'a', value: 'a-tool' });
    slot.contribute({ source: 'two', layer: 'b', value: 'b-tool' });

    await expect(kernel.setActiveLayers(['a'])).rejects.toThrow(/first refused/);
    await kernel.setActiveLayers(['b']);

    expect(applied).toEqual([['b-tool']]);
  });
  it('coalesces rapid axis switches and converges on the last one', async () => {
    const kernel = createDoomKernel({ activeLayers: ['a'] });
    const seen: string[][] = [];
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let first = true;
    const slot = kernel.defineSlot<string>('tools', async (active) => {
      seen.push([...active]);
      if (first) {
        first = false;
        await gate;
      }
    });
    slot.contribute({ source: 'one', layer: 'a', value: 'a-tool' });
    slot.contribute({ source: 'two', layer: 'b', value: 'b-tool' });
    slot.contribute({ source: 'three', layer: 'c', value: 'c-tool' });

    const first_ = kernel.setActiveLayers(['a']);
    const second = kernel.setActiveLayers(['b']);
    const third = kernel.setActiveLayers(['c']);
    release?.();
    await Promise.all([first_, second, third]);

    // A user tapping through modes must not make the host apply every one of
    // them; only the state they landed on has to be true at the end.
    expect(seen.at(-1)).toEqual(['c-tool']);
    expect(seen.length).toBeLessThan(3);
    expect(kernel.activeValues('tools')).toEqual(['c-tool']);
  });

  it('applies a later switch even when an earlier sink is still awaiting', async () => {
    const kernel = createDoomKernel({ activeLayers: ['a'] });
    const applied: string[][] = [];
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slot = kernel.defineSlot<string>('tools', async (active) => {
      await gate;
      applied.push([...active]);
    });
    slot.contribute({ source: 'one', layer: 'a', value: 'a-tool' });
    slot.contribute({ source: 'two', layer: 'b', value: 'b-tool' });

    const pending = kernel.setActiveLayers(['a']);
    release?.();
    await pending;
    await kernel.setActiveLayers(['b']);

    expect(applied).toEqual([['a-tool'], ['b-tool']]);
  });

  it('rejects a contribution to a slot no host defined', () => {
    const kernel = createDoomKernel();
    expect(() => kernel.contribute('tools', { source: 'team', value: 'delegate' })).toThrow(/Unknown kernel slot/);
  });

  it('rejects a second definition of the same slot', () => {
    const kernel = createDoomKernel();
    kernel.defineSlot('tools', () => undefined);
    expect(() => kernel.defineSlot('tools', () => undefined)).toThrow(/already defined/);
  });

  it('refuses further use once disposed', () => {
    const kernel = createDoomKernel();
    kernel.defineSlot('tools', () => undefined);
    kernel.dispose();
    kernel.dispose();
    expect(() => kernel.defineSlot('more', () => undefined)).toThrow(/disposed/);
    expect(kernel.activeValues('tools')).toEqual([]);
  });

  it('stops pushing a slot once its owner disposes it', async () => {
    const kernel = createDoomKernel({ activeLayers: ['team'] });
    const sink = vi.fn();
    const slot = kernel.defineSlot<string>('tools', sink);
    slot.contribute({ source: 'team', layer: 'team', value: 'delegate' });
    await kernel.refresh();
    sink.mockClear();

    slot.dispose();
    slot.dispose();
    await kernel.setActiveLayers(['plan']);

    expect(sink).not.toHaveBeenCalled();
    expect(kernel.slots).toEqual([]);
  });
  it('reads the active values without pushing them', () => {
    const kernel = createDoomKernel({ activeLayers: ['team'] });
    const sink = vi.fn();
    const slot = kernel.defineSlot<string>('tools', sink);
    slot.contribute({ source: 'team', layer: 'team', value: 'delegate' });
    slot.contribute({ source: 'plan', layer: 'plan', value: 'plan' });

    expect(kernel.activeValues('tools')).toEqual(['delegate']);
    expect(sink).not.toHaveBeenCalled();
  });
  it('reads active and gated registrations for inventory projections', () => {
    const kernel = createDoomKernel({ activeLayers: ['team'] });
    const slot = kernel.defineSlot<string>('tools', () => undefined);
    slot.contribute({ source: 'team', layer: 'team', value: 'delegate' });
    slot.contribute({ source: 'plan', layer: 'plan', value: 'plan' });

    expect(kernel.contributions('tools')).toEqual([
      { source: 'team', layer: 'team', value: 'delegate' },
      { source: 'plan', layer: 'plan', value: 'plan' },
    ]);
  });
});
