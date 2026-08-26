import { describe, expect, it } from 'vitest';
import { grepCallView } from '../web/grepToolView.ts';
import {
  GREP_COLLAPSED_LINES,
  hashlineBody,
  parseFileHeader,
  parseTaggedLine,
  presentHashlineLines,
  resultTextLines,
  takeTrailingNotice,
} from '../web/hashlineView.ts';

const text = (value: string) => ({ content: [{ type: 'text', text: value }], details: undefined });

describe('the grep call view', () => {
  it('lists the pattern, search path, glob, case flag, and limit the way the TUI heading does', () => {
    expect(grepCallView({ pattern: 'TODO', path: 'src', glob: '*.ts', ignoreCase: true, limit: 5 })).toEqual({
      pattern: 'TODO',
      details: ['src', '*.ts', 'ignore case', '5 matches'],
    });
    expect(grepCallView({ pattern: 'x' })).toEqual({ pattern: 'x', details: ['.'] });
    expect(grepCallView({})).toEqual({ pattern: '', details: ['.'] });
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
    const lines = ['>> 1#abc|a', '', '[Truncated to 5 matches.]'];
    expect(takeTrailingNotice(lines)).toBe('[Truncated to 5 matches.]');
    expect(lines).toEqual(['>> 1#abc|a']);
    expect(takeTrailingNotice(['>> 1#abc|a'])).toBeUndefined();
  });

  it('groups matches under their file and keeps native rows as plain lines', () => {
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

  it('collapses to fifteen lines until expanded, sizing the gutter from what is shown', () => {
    const body = Array.from({ length: 30 }, (_, index) => `>> ${index + 100}#abc|line`);
    const collapsed = hashlineBody(text(['@file a.ts#12345678', ...body].join('\n')), '', 'grep', false);
    expect(collapsed.shown).toHaveLength(GREP_COLLAPSED_LINES);
    expect(collapsed.hidden).toBe(31 - GREP_COLLAPSED_LINES);
    expect(collapsed.gutter).toBe(3);
    expect(hashlineBody(text(body.join('\n')), '', 'grep', true)).toMatchObject({ hidden: 0 });
    expect(hashlineBody(text(body.join('\n')), '', 'read', false).shown).toHaveLength(10);
    expect(hashlineBody(null, '', 'grep', false)).toEqual({ shown: [], hidden: 0, notice: undefined, gutter: 1 });
  });
});
