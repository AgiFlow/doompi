import { describe, expect, it } from 'vitest';
import { toolResultText, toolResultTextLines } from '../src/services/toolResult.ts';

describe('toolResultText', () => {
  it('joins the text blocks with newlines and drops everything else', () => {
    expect(
      toolResultText([
        { type: 'text', text: 'one' },
        { type: 'image', data: 'x', mimeType: 'image/png' },
        { type: 'text', text: 'two' },
        'junk',
        { type: 'text' },
      ]),
    ).toBe('one\ntwo');
    expect(toolResultText([])).toBe('');
  });
});

describe('toolResultTextLines', () => {
  it('widens tabs, folds CRLF, and drops trailing blank lines', () => {
    expect(toolResultTextLines([{ type: 'text', text: 'a\tb\r\nc\r\n\n  \n' }])).toEqual(['a  b', 'c']);
  });

  it('answers no lines for no text, and keeps a leading blank line', () => {
    expect(toolResultTextLines([{ type: 'image', data: 'x', mimeType: 'image/png' }])).toEqual([]);
    expect(toolResultTextLines([{ type: 'text', text: '\nx' }])).toEqual(['', 'x']);
  });
});
