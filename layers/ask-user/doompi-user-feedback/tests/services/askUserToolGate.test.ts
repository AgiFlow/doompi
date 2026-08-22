import { describe, expect, it, vi } from 'vitest';
import { AskUserToolGate } from '../../src/services/askUserToolGate.js';
import type { ActiveToolRegistry } from '../../src/types/toolActivation.js';

const TOOL = 'ask_user_question';

function createRegistry(initial: string[]): ActiveToolRegistry & { names: () => string[]; writes: () => number } {
  let names = [...initial];
  const setActiveTools = vi.fn((toolNames: string[]) => {
    names = [...toolNames];
  });
  return {
    getActiveTools: () => [...names],
    setActiveTools,
    names: () => names,
    writes: () => setActiveTools.mock.calls.length,
  };
}

describe('AskUserToolGate', () => {
  it('drops only its own tool while voice is active and puts it back afterwards', () => {
    const registry = createRegistry(['read', TOOL, 'bash']);
    const gate = new AskUserToolGate(registry, TOOL);

    gate.sync(true);
    expect(registry.names()).toEqual(['read', 'bash']);

    gate.sync(false);
    expect(registry.names()).toEqual(['read', 'bash', TOOL]);
  });

  it('writes once per transition', () => {
    const registry = createRegistry([TOOL]);
    const gate = new AskUserToolGate(registry, TOOL);

    gate.sync(true);
    gate.sync(true);
    expect(registry.writes()).toBe(1);

    gate.sync(false);
    gate.sync(false);
    expect(registry.writes()).toBe(2);
  });

  it('never enables a tool the user switched off itself', () => {
    const registry = createRegistry(['read']);
    const gate = new AskUserToolGate(registry, TOOL);

    gate.sync(true);
    gate.sync(false);

    expect(registry.names()).toEqual(['read']);
    expect(registry.writes()).toBe(0);
  });

  it('leaves the registry untouched when releasing without an owned removal', () => {
    const registry = createRegistry(['read', TOOL]);
    const gate = new AskUserToolGate(registry, TOOL);

    gate.release();

    expect(registry.writes()).toBe(0);
  });

  it('restores an owned removal on release and does not restore it twice', () => {
    const registry = createRegistry([TOOL]);
    const gate = new AskUserToolGate(registry, TOOL);

    gate.sync(true);
    gate.release();
    gate.release();

    expect(registry.names()).toEqual([TOOL]);
    expect(registry.writes()).toBe(2);
  });

  it('hides the tool again when a tool refresh puts it back while voice is active', () => {
    const registry = createRegistry([TOOL]);
    const gate = new AskUserToolGate(registry, TOOL);

    gate.sync(true);
    registry.setActiveTools(['read', TOOL]);
    gate.sync(true);

    expect(registry.names()).toEqual(['read']);
  });

  it('keeps a tool re-enabled elsewhere from being added twice', () => {
    const registry = createRegistry([TOOL]);
    const gate = new AskUserToolGate(registry, TOOL);

    gate.sync(true);
    registry.setActiveTools(['read', TOOL]);
    gate.sync(false);

    expect(registry.names()).toEqual(['read', TOOL]);
  });
});
