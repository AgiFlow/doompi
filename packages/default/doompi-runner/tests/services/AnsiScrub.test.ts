import { describe, expect, it } from 'vitest';
import {
  collapseCarriageReturns,
  scrubTerminalOutput,
  scrubTerminalOutputToPlainText,
  stripAnsi,
  stripAnsiKeepingColour,
} from '../../src/services/AnsiScrub/ansiScrub';

const ESC = '\u001B';
const BEL = '\u0007';
const BACKSPACE = '\u0008';

describe('stripAnsi', () => {
  it('removes colour sequences but keeps the text', () => {
    expect(stripAnsi(`${ESC}[31mfailed${ESC}[0m`)).toBe('failed');
  });

  it('removes cursor movement and erase sequences', () => {
    expect(stripAnsi(`before${ESC}[2K${ESC}[1;5Hafter`)).toBe('beforeafter');
  });

  it('removes an OSC title string terminated by a bell', () => {
    expect(stripAnsi(`${ESC}]0;build${BEL}done`)).toBe('done');
  });

  it('removes the two-byte escapes and stray bell or backspace', () => {
    expect(stripAnsi(`${ESC}=one${BEL}${BACKSPACE}two`)).toBe('onetwo');
  });

  it('leaves plain text untouched', () => {
    expect(stripAnsi('nothing to strip')).toBe('nothing to strip');
  });
});

describe('collapseCarriageReturns', () => {
  it('keeps only the final state of a redrawn line', () => {
    expect(collapseCarriageReturns('10%\r50%\r100%')).toBe('100%');
  });

  it('collapses each line independently', () => {
    expect(collapseCarriageReturns('a\rb\nc\rd')).toBe('b\nd');
  });

  it('treats CRLF as a line terminator rather than a redraw', () => {
    expect(collapseCarriageReturns('line\r\n')).toBe('line\n');
  });

  it('still collapses a redraw that ends in CRLF', () => {
    expect(collapseCarriageReturns('10%\r100%\r\n')).toBe('100%\n');
  });

  it('leaves text without carriage returns untouched', () => {
    expect(collapseCarriageReturns('one\ntwo')).toBe('one\ntwo');
  });
});

describe('scrubTerminalOutput', () => {
  it('collapses a coloured progress bar to its final frame, keeping the colour', () => {
    const raw = `${ESC}[32m 10%${ESC}[0m\r${ESC}[32m100%${ESC}[0m\ndone\n`;
    expect(scrubTerminalOutput(raw)).toBe(`${ESC}[32m100%${ESC}[0m\ndone\n`);
  });

  it('still removes cursor moves, which are not colour', () => {
    expect(scrubTerminalOutput(`${ESC}[2Astill here`)).toBe('still here');
  });
});

describe('scrubTerminalOutputToPlainText', () => {
  it('drops colour as well, for the copy the model reads', () => {
    const raw = `${ESC}[32m 10%${ESC}[0m\r${ESC}[32m100%${ESC}[0m\ndone\n`;
    expect(scrubTerminalOutputToPlainText(raw)).toBe('100%\ndone\n');
  });
});

describe('stripAnsiKeepingColour', () => {
  it('keeps SGR and removes everything else', () => {
    expect(stripAnsiKeepingColour(`${ESC}[1;31mred${ESC}[0m${ESC}[2K${ESC}[H`)).toBe(`${ESC}[1;31mred${ESC}[0m`);
  });
});
