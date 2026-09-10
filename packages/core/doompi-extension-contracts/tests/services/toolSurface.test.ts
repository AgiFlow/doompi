import { describe, expect, it, vi } from 'vitest';
import { createDoomToolSurface } from '../../src/services/toolSurface.ts';

function harness(tools: string[] = ['read', 'write', 'bash', 'task']) {
  let activeTools = [...tools];
  const setActiveTools = vi.fn<(names: string[]) => void>((names) => {
    activeTools = [...names];
  });
  const surface = createDoomToolSurface({
    generation: 'test',
    allTools: () => tools,
    activeTools: () => activeTools,
    setActiveTools,
  });
  return {
    activeTools: () => activeTools,
    resetActiveTools: (names: string[]) => {
      activeTools = [...names];
    },
    setActiveTools,
    surface,
    tools,
  };
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
    let activeTools = ['read', 'write'];
    const surface = createDoomToolSurface({
      generation: 'test',
      allTools: () => ['read', 'write'],
      activeTools: () => activeTools,
      setActiveTools: (names) => {
        activeTools = [...names];
        setActiveTools(names);
      },
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

  it('removes a denied tool that the host auto-activates after registration', () => {
    const tools = ['read'];
    let activeTools = [...tools];
    const setActiveTools = vi.fn<(names: string[]) => void>((names) => {
      activeTools = [...names];
    });
    const surface = createDoomToolSurface({
      generation: 'test',
      allTools: () => tools,
      activeTools: () => activeTools,
      setActiveTools,
    });
    surface.register({ source: 'plan', restrict: (incoming) => incoming.filter((n) => n !== 'write') });
    tools.push('write', 'bash');
    activeTools.push('write', 'bash');
    surface.refresh();
    expect(setActiveTools).toHaveBeenLastCalledWith(['read', 'bash']);
    expect(activeTools).toEqual(['read', 'bash']);
  });

  it('repairs an external host reset even when the desired surface is unchanged', () => {
    const { resetActiveTools, setActiveTools, surface } = harness();
    surface.register({ source: 'plan', restrict: (incoming) => incoming.filter((n) => n !== 'write') });
    setActiveTools.mockClear();
    resetActiveTools(['read', 'write', 'bash', 'task']);
    surface.refresh();
    expect(setActiveTools).toHaveBeenCalledWith(['read', 'bash', 'task']);
  });

  it('does not cache a failed host application', () => {
    let activeTools = ['read', 'write'];
    let fail = true;
    const setActiveTools = vi.fn<(names: string[]) => void>((names) => {
      if (fail) throw new Error('setter failed');
      activeTools = [...names];
    });
    const surface = createDoomToolSurface({
      generation: 'test',
      allTools: () => ['read', 'write'],
      activeTools: () => activeTools,
      setActiveTools,
    });
    expect(() =>
      surface.register({ source: 'plan', restrict: (incoming) => incoming.filter((n) => n !== 'write') }),
    ).toThrow('setter failed');
    fail = false;
    surface.refresh();
    expect(setActiveTools).toHaveBeenLastCalledWith(['read']);
    expect(surface.active()).toEqual(['read']);
  });

  it('gates a restriction on its owning layer', () => {
    let activeTools = ['read', 'write'];
    const setActiveTools = vi.fn<(names: string[]) => void>((names) => {
      activeTools = [...names];
    });
    const surface = createDoomToolSurface({
      generation: 'test',
      allTools: () => ['read', 'write'],
      activeTools: () => activeTools,
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
