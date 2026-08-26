import { describe, expect, it } from 'vitest';
import { parseRunnersCommand } from '../../src/services/runs/runnersCommand.ts';

describe('parseRunnersCommand', () => {
  it('opens Runner Space for anything but the stop verb', () => {
    expect(parseRunnersCommand('')).toEqual({ kind: 'space' });
    expect(parseRunnersCommand('  ')).toEqual({ kind: 'space' });
    expect(parseRunnersCommand('list')).toEqual({ kind: 'space' });
  });

  it('reads the stop verb with its id and optional reason', () => {
    expect(parseRunnersCommand('stop runner-a')).toEqual({ kind: 'stop', id: 'runner-a' });
    expect(parseRunnersCommand('  stop   runner-a  no longer needed ')).toEqual({
      kind: 'stop',
      id: 'runner-a',
      reason: 'no longer needed',
    });
    expect(parseRunnersCommand('stop')).toEqual({ kind: 'stop', id: '' });
  });
});
