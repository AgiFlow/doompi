import { describe, expect, it } from 'vitest';
import { plainTailLine } from '../../src/web/runnerTail.ts';

const ESC = '\u001B[';

describe('plainTailLine', () => {
  it('takes the last line that has something on it', () => {
    expect(plainTailLine(['first', 'second'])).toBe('second');
    // A log file ends with a newline, so a naive split ends in a blank.
    expect(plainTailLine(['built in 812ms', ''])).toBe('built in 812ms');
    expect(plainTailLine(['done', '   ', '\t'])).toBe('done');
  });

  it('drops the colour a program wrote, because the row is nine faint pixels', () => {
    expect(plainTailLine([`${ESC}1m${ESC}32m\u2713 42 passed${ESC}39m${ESC}0m`])).toBe('✓ 42 passed');
  });

  it('has nothing to say about a log with no output yet', () => {
    expect(plainTailLine([])).toBeUndefined();
    expect(plainTailLine([''])).toBeUndefined();
    expect(plainTailLine([`${ESC}0m`])).toBeUndefined();
  });
});
