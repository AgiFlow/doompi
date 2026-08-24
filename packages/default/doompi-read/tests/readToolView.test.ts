import { describe, expect, it } from 'vitest';
import {
  GREP_COLLAPSED_LINES,
  READ_COLLAPSED_LINES,
  hashlineBody,
  parseFileHeader,
  parseTaggedLine,
  presentHashlineLines,
  resultTextLines,
  takeTrailingNotice,
} from '../web/hashlineView.ts';
import { readCallView } from '../web/readToolView.ts';

const text = (value: string) => ({ content: [{ type: 'text', text: value }], details: undefined });

describe('the read call view', () => {
  it('lists the path, offset, and limit the way the TUI heading does', () => {
    expect(readCallView({ path: 'src/a.ts', offset: 3, limit: 20 })).toEqual({
      path: 'src/a.ts',
      details: ['from 3', '20 lines'],
    });
    expect(readCallView({ path: 'src/a.ts' })).toEqual({ path: 'src/a.ts', details: [] });
    expect(readCallView({ offset: 'x' })).toEqual({ path: '', details: [] });
  });
});

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
    expect(resultTextLines({ content: [{ type: 'image', data: 'x' }], details: undefined }, '')).toEqual([
      '[Image attached]',
    ]);
    expect(resultTextLines({ content: [], details: undefined }, '')).toEqual([]);
  });

  it('detaches the trailing bracketed notice', () => {
    const lines = ['1#abc|a', '', '[3 more lines in file. Use offset=2 to continue.]'];
    expect(takeTrailingNotice(lines)).toBe('[3 more lines in file. Use offset=2 to continue.]');
    expect(lines).toEqual(['1#abc|a']);
    expect(takeTrailingNotice(['1#abc|a'])).toBeUndefined();
  });

  it('drops the file header for a read and keeps it for a grep', () => {
    const lines = ['@file a.ts#12345678', '1#abc|x', 'plain'];
    expect(presentHashlineLines(lines, 'read')).toEqual([
      { type: 'tagged', value: { line: 1, content: 'x', marker: undefined } },
      { type: 'plain', text: 'plain' },
    ]);
    expect(presentHashlineLines(lines, 'grep')[0]).toEqual({ type: 'file', path: 'a.ts' });
  });

  it('collapses to the budget of each kind, sizing the gutter from what is shown', () => {
    const body = Array.from({ length: 30 }, (_, index) => `${index + 1}#abc|line ${index + 1}`);
    const read = hashlineBody(text(['@file a.ts#12345678', ...body, '', '[note]'].join('\n')), '', 'read', false);
    expect(read.shown).toHaveLength(READ_COLLAPSED_LINES);
    expect(read.hidden).toBe(30 - READ_COLLAPSED_LINES);
    expect(read.notice).toBe('[note]');
    expect(read.gutter).toBe(2);

    const grep = hashlineBody(text(['@file a.ts#12345678', ...body].join('\n')), '', 'grep', false);
    expect(grep.shown).toHaveLength(GREP_COLLAPSED_LINES);
    expect(hashlineBody(text(body.join('\n')), '', 'read', true)).toMatchObject({ hidden: 0, gutter: 2 });
    expect(hashlineBody(null, '', 'read', false)).toEqual({ shown: [], hidden: 0, notice: undefined, gutter: 1 });
  });
});
