import { describe, expect, it } from 'vitest';
import {
  GREP_COLLAPSED_LINES,
  hashlineBody,
  parseFileHeader,
  parseTaggedLine,
  presentHashlineLines,
  READ_COLLAPSED_LINES,
  resultTextLines,
  takeTrailingNotice,
} from '../../src/exports/index.ts';

const text = (value: string) => ({ content: [{ type: 'text', text: value }] });

describe('the hashline view', () => {
  it('parses file headers and anchored lines with their markers', () => {
    expect(parseFileHeader('@file src/a.ts#AbCd_-12')).toBe('src/a.ts');
    expect(parseFileHeader('src/a.ts')).toBeUndefined();
    expect(parseTaggedLine('12#abc|const x = 1;')).toEqual({ line: 12, content: 'const x = 1;', marker: undefined });
    expect(parseTaggedLine('>> 3#zzz|hit')).toEqual({ line: 3, content: 'hit', marker: 'match' });
    expect(parseTaggedLine('   4#zzz|near')).toEqual({ line: 4, content: 'near', marker: 'context' });
    expect(parseTaggedLine('0#abc|zero')).toBeUndefined();
    expect(parseTaggedLine('plain')).toBeUndefined();
  });

  it('reads the result text, widening tabs and dropping trailing blanks', () => {
    expect(resultTextLines(text('a\tb\r\nc\n\n'), '')).toEqual(['a  b', 'c']);
    expect(resultTextLines(null, 'from output\n')).toEqual(['from output']);
    expect(resultTextLines({ content: [{ type: 'image', data: 'x' }] }, '')).toEqual(['[Image attached]']);
    expect(resultTextLines({ content: [] }, '')).toEqual([]);
  });

  it('detaches the trailing bracketed notice', () => {
    const readLines = ['1#abc|a', '', '[3 more lines in file. Use offset=2 to continue.]'];
    expect(takeTrailingNotice(readLines)).toBe('[3 more lines in file. Use offset=2 to continue.]');
    expect(readLines).toEqual(['1#abc|a']);
    expect(takeTrailingNotice(['1#abc|a'])).toBeUndefined();

    const grepLines = ['>> 1#abc|a', '', '[Truncated to 5 matches.]'];
    expect(takeTrailingNotice(grepLines)).toBe('[Truncated to 5 matches.]');
    expect(grepLines).toEqual(['>> 1#abc|a']);
  });

  it('groups matches under their file for a grep and drops the header for a read', () => {
    const lines = ['@file a.ts#12345678', '>> 1#abc|x', '   2#abc|y', 'b.ts:3:native'];
    expect(presentHashlineLines(lines, 'grep')).toEqual([
      { type: 'file', path: 'a.ts' },
      { type: 'tagged', value: { line: 1, content: 'x', marker: 'match' } },
      { type: 'tagged', value: { line: 2, content: 'y', marker: 'context' } },
      { type: 'plain', text: 'b.ts:3:native' },
    ]);
    expect(presentHashlineLines(lines, 'read')[0]).toEqual({
      type: 'tagged',
      value: { line: 1, content: 'x', marker: 'match' },
    });
  });

  it('collapses to the budget of each kind, sizing the gutter from what is shown', () => {
    const body = Array.from({ length: 30 }, (_, index) => `${index + 1}#abc|line ${index + 1}`);
    const read = hashlineBody(text(['@file a.ts#12345678', ...body, '', '[note]'].join('\n')), '', 'read', false);
    expect(read.shown).toHaveLength(READ_COLLAPSED_LINES);
    expect(read.hidden).toBe(30 - READ_COLLAPSED_LINES);
    expect(read.notice).toBe('[note]');
    expect(read.gutter).toBe(2);

    const wide = Array.from({ length: 30 }, (_, index) => `>> ${index + 100}#abc|line`);
    const grep = hashlineBody(text(['@file a.ts#12345678', ...wide].join('\n')), '', 'grep', false);
    expect(grep.shown).toHaveLength(GREP_COLLAPSED_LINES);
    expect(grep.hidden).toBe(31 - GREP_COLLAPSED_LINES);
    expect(grep.gutter).toBe(3);

    expect(hashlineBody(text(body.join('\n')), '', 'read', true)).toMatchObject({ hidden: 0, gutter: 2 });
    expect(hashlineBody(null, '', 'grep', false)).toEqual({ shown: [], hidden: 0, notice: undefined, gutter: 1 });
  });
});
