import { describe, expect, it, vi } from 'vitest';
import { createDoomToolSurface } from '../../src/services/toolSurface.ts';

function harness(tools: string[] = ['read', 'write', 'bash', 'task']) {
  const setActiveTools = vi.fn<(names: string[]) => void>();
  const surface = createDoomToolSurface({
    generation: 'test',
    allTools: () => tools,
    setActiveTools,
  });
  return { setActiveTools, surface, tools };
}

describe('createDoomToolSurface', () => {
  it('applies a restriction the moment it registers', () => {
    const { setActiveTools, surface } = harness();
    surface.register({ source: 'plan', restrict: (incoming) => incoming.filter((name) => name !== 'write') });
    expect(setActiveTools).toHaveBeenCalledWith(['read', 'bash', 'task']);
    expect(surface.active()).toEqual(['read', 'bash', 'task']);
  });

  it('restores the hidden tools when the restriction is disposed', () => {
    const { setActiveTools, surface } = harness();
    const handle = surface.register({ source: 'plan', restrict: (incoming) => incoming.filter((n) => n !== 'write') });
    setActiveTools.mockClear();
    handle.dispose();
    expect(setActiveTools).toHaveBeenCalledWith(['read', 'write', 'bash', 'task']);
  });

  it('composes restrictions in registration order and survives a middle disposal', () => {
    const { setActiveTools, surface } = harness();
    surface.register({ source: 'plan', restrict: (incoming) => incoming.filter((n) => n !== 'write') });
    const goal = surface.register({ source: 'goal', restrict: (incoming) => incoming.filter((n) => n !== 'bash') });
    expect(surface.active()).toEqual(['read', 'task']);
    setActiveTools.mockClear();
    goal.dispose();
    expect(setActiveTools).toHaveBeenCalledWith(['read', 'bash', 'task']);
  });

  it('never pushes an unchanged list', () => {
    const { setActiveTools, surface } = harness();
    surface.register({ source: 'noop', restrict: (incoming) => incoming });
    expect(setActiveTools).not.toHaveBeenCalled();
    surface.refresh();
    expect(setActiveTools).not.toHaveBeenCalled();
  });

  it('drops names the host does not know', () => {
    const { setActiveTools, surface } = harness();
    surface.register({ source: 'ghost', restrict: () => ['read', 'not_a_tool'] });
    expect(setActiveTools).toHaveBeenCalledWith(['read']);
  });

  it('skips a throwing restriction and keeps the rest', () => {
    const onError = vi.fn();
    const setActiveTools = vi.fn<(names: string[]) => void>();
    const surface = createDoomToolSurface({
      generation: 'test',
      allTools: () => ['read', 'write'],
      setActiveTools,
      onError,
    });
    surface.register({
      source: 'broken',
      restrict: () => {
        throw new Error('boom');
      },
    });
    surface.register({ source: 'ok', restrict: (incoming) => incoming.filter((n) => n !== 'write') });
    expect(setActiveTools).toHaveBeenLastCalledWith(['read']);
    expect(onError).toHaveBeenCalledWith('broken', expect.any(Error));
  });

  it('reapplies in place when a restriction updates', () => {
    const { setActiveTools, surface } = harness();
    const handle = surface.register({ source: 'plan', restrict: (incoming) => incoming.filter((n) => n !== 'write') });
    handle.update((incoming) => incoming.filter((name) => name !== 'bash'));
    expect(setActiveTools).toHaveBeenLastCalledWith(['read', 'write', 'task']);
  });

  it('picks up tools registered after the restriction', () => {
    const tools = ['read'];
    const setActiveTools = vi.fn<(names: string[]) => void>();
    const surface = createDoomToolSurface({ generation: 'test', allTools: () => tools, setActiveTools });
    surface.register({ source: 'plan', restrict: (incoming) => incoming.filter((n) => n !== 'write') });
    tools.push('write', 'bash');
    surface.refresh();
    expect(setActiveTools).toHaveBeenLastCalledWith(['read', 'bash']);
  });

  it('gates a restriction on its owning layer', () => {
    const setActiveTools = vi.fn<(names: string[]) => void>();
    const surface = createDoomToolSurface({
      generation: 'test',
      allTools: () => ['read', 'write'],
      setActiveTools,
      activeLayers: ['base'],
    });
    surface.register({ source: 'team', layer: 'team', restrict: (incoming) => incoming.filter((n) => n !== 'write') });
    expect(setActiveTools).not.toHaveBeenCalled();
    surface.setActiveLayers(['base', 'team']);
    expect(setActiveTools).toHaveBeenCalledWith(['read']);
  });
});

describe('createDoomToolSurface lifecycle', () => {
  it('rejects a blank source', () => {
    const { surface } = harness();
    expect(() => surface.register({ source: '  ', restrict: (incoming) => incoming })).toThrow(/needs a source/);
  });

  it('ignores repeat disposal and updates after disposal', () => {
    const { setActiveTools, surface } = harness();
    const handle = surface.register({ source: 'plan', restrict: (incoming) => incoming.filter((n) => n !== 'write') });
    handle.dispose();
    setActiveTools.mockClear();
    handle.dispose();
    handle.update(() => []);
    expect(setActiveTools).not.toHaveBeenCalled();
  });

  it('stops applying once disposed', () => {
    const { setActiveTools, surface } = harness();
    surface.dispose();
    surface.dispose();
    surface.refresh();
    surface.setActiveLayers(['base']);
    expect(setActiveTools).not.toHaveBeenCalled();
    expect(surface.active()).toEqual([]);
  });
});
