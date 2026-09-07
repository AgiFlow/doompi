import { afterEach, describe, expect, it, vi } from 'vitest';
import { NodeProcessControl } from '../../src/adapters/ProcessControl/NodeProcessControl.ts';

describe('NodeProcessControl', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects invalid process identifiers without signaling', () => {
    const kill = vi.spyOn(process, 'kill');
    const control = new NodeProcessControl();

    expect(control.isAlive(0)).toBe(false);
    expect(control.isAlive(1.5)).toBe(false);
    expect(control.signalGroup(-1, 'SIGTERM')).toBe(false);
    expect(control.signalGroup(Number.NaN, 'SIGTERM')).toBe(false);
    expect(kill).not.toHaveBeenCalled();
  });

  it('probes a valid process and signals its process group', () => {
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
    const control = new NodeProcessControl();

    expect(control.isAlive(42)).toBe(true);
    expect(control.signalGroup(42, 'SIGTERM')).toBe(true);
    expect(kill).toHaveBeenNthCalledWith(1, 42, 0);
    expect(kill).toHaveBeenNthCalledWith(2, -42, 'SIGTERM');
  });

  it('reports failed probes and signals as unsuccessful', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('not permitted');
    });
    const control = new NodeProcessControl();

    expect(control.isAlive(42)).toBe(false);
    expect(control.signalGroup(42, 'SIGKILL')).toBe(false);
  });
});
