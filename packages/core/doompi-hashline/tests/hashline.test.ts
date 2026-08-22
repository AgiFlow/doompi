import { describe, expect, it } from 'vitest';
import {
  applyHashlineEdits,
  formatFileHeader,
  formatTaggedLine,
  formatTaggedLines,
  hashLine,
  normalizeFileTag,
  parseFileHeader,
  parseLineAnchor,
  parseTaggedLine,
  splitLines,
} from '../src/services/hashline.ts';

function anchor(lines: readonly string[], line: number): string {
  return `${line}#${hashLine(lines[line - 1] ?? '')}`;
}

describe('hashline protocol', () => {
  it('uses whitespace-insensitive FNV-1a64 anchors with stable vectors', () => {
    expect(hashLine('')).toBe('zyb');
    expect(hashLine('hello')).toBe('avr');
    expect(hashLine('hello world')).toBe('vnd');
    expect(hashLine('hello  \tworld')).toBe('vnd');
    expect(hashLine('const value = 1;')).toBe('gzo');
  });

  it('retains final empty lines and formats anchored output', () => {
    expect(splitLines('\ufefffirst\r\nsecond\r\n')).toEqual(['first', 'second', '']);
    expect(formatTaggedLine('', 3)).toBe('3#zyb|');
    expect(formatTaggedLine('value', 4, '>> ')).toMatch(/^>> 4#[a-z]{3}\|value$/u);
    expect(formatTaggedLine('context', 5, '   ')).toMatch(/^ {3}5#[a-z]{3}\|context$/u);
    expect(formatTaggedLines(['first', 'second'])).toMatch(/^1#[a-z]{3}\|first\n2#[a-z]{3}\|second$/u);
    expect(formatTaggedLines(['first'], 5)).toMatch(/^5#[a-z]{3}\|first$/u);
    expect(() => formatTaggedLine('bad', 0)).toThrow('positive safe integer');
  });

  it('round-trips file headers and accepts a full header when normalizing tags', () => {
    const header = formatFileHeader('src/a#part.ts', 'Ab_cd-12');
    expect(header).toBe('@file src/a#part.ts#Ab_cd-12');
    expect(parseFileHeader(header)).toEqual({ path: 'src/a#part.ts', tag: 'Ab_cd-12' });
    expect(normalizeFileTag(header)).toBe('Ab_cd-12');
    expect(normalizeFileTag(' Ab_cd-12 ')).toBe('Ab_cd-12');
    expect(parseFileHeader('@file src/a.ts#short')).toBeUndefined();
    expect(parseFileHeader(' @file src/a.ts#Ab_cd-12')).toBeUndefined();
    expect(() => formatFileHeader('', 'Ab_cd-12')).toThrow('non-empty path');
    expect(() => formatFileHeader('one\ntwo', 'Ab_cd-12')).toThrow('without line breaks');
    expect(() => normalizeFileTag('short')).toThrow('Invalid file hash');
  });

  it('parses plain, match, and context tagged rows without exposing hashes', () => {
    expect(parseTaggedLine('2#abc|value')).toEqual({ content: 'value', line: 2 });
    expect(parseTaggedLine('>> 12#abc|matched')).toEqual({ content: 'matched', line: 12, marker: 'match' });
    expect(parseTaggedLine('   13#def|context')).toEqual({ content: 'context', line: 13, marker: 'context' });
    expect(parseTaggedLine('4#ghi|')).toEqual({ content: '', line: 4 });
    expect(parseTaggedLine('0#abc|invalid')).toBeUndefined();
    expect(parseTaggedLine('2#ABC|invalid')).toBeUndefined();
    expect(parseTaggedLine('+ 2#abc|diff')).toBeUndefined();
    expect(parseTaggedLine('not tagged')).toBeUndefined();
  });

  it('parses anchors copied from read, grep, or diff output', () => {
    expect(parseLineAnchor('2#abc|value')).toEqual({ line: 2, hash: 'abc' });
    expect(parseLineAnchor('>> 2#abc|value')).toEqual({ line: 2, hash: 'abc' });
    expect(parseLineAnchor('+ 2#abc|value')).toEqual({ line: 2, hash: 'abc' });
    expect(parseLineAnchor(' > 2 : ABC |value')).toEqual({ line: 2, hash: 'abc' });
    expect(parseLineAnchor(' 2 # AbC ')).toEqual({ line: 2, hash: 'abc' });
    expect(() => parseLineAnchor('2#AB1')).toThrow('Invalid line anchor');
    expect(() => parseLineAnchor('0#abc')).toThrow('positive line number');
    expect(() => parseLineAnchor('1#abc|first\n2#def|second')).toThrow('not a pasted multiline block');
  });

  it('validates one original snapshot and applies disjoint edits bottom-up', () => {
    const lines = ['one', 'two', 'three', 'four'];
    const replaceTwo = { from: anchor(lines, 2), to: anchor(lines, 2), content: 'TWO\n' };
    const result = applyHashlineEdits(lines.join('\n'), [
      replaceTwo,
      { from: anchor(lines, 4), to: anchor(lines, 4) },
      replaceTwo,
    ]);

    expect(result.content).toBe('one\nTWO\nthree');
    expect(result.edits).toHaveLength(2);
  });

  it.each(['', '\n', '\r\n', null] as const)('treats replacement %j as deletion', (content) => {
    const lines = ['one', 'two'];
    const result = applyHashlineEdits(lines.join('\n'), [{ from: anchor(lines, 1), to: anchor(lines, 1), content }]);
    expect(result.content).toBe('two');
  });

  it('rejects stale, inverted, out-of-bounds, and overlapping ranges', () => {
    const lines = ['one', 'two', 'three'];
    expect(() => applyHashlineEdits(lines.join('\n'), [{ from: '1#abc', to: '1#abc', content: 'ONE' }])).toThrow(
      'Stale line anchor',
    );
    expect(() =>
      applyHashlineEdits(lines.join('\n'), [{ from: anchor(lines, 3), to: anchor(lines, 2), content: 'bad' }]),
    ).toThrow('starting line follows');
    expect(() =>
      applyHashlineEdits(lines.join('\n'), [{ from: anchor(lines, 1), to: '4#abc', content: 'bad' }]),
    ).toThrow('file has 3 lines');
    expect(() =>
      applyHashlineEdits(lines.join('\n'), [
        { from: anchor(lines, 1), to: anchor(lines, 2), content: 'first' },
        { from: anchor(lines, 2), to: anchor(lines, 3), content: 'second' },
      ]),
    ).toThrow('Overlapping edit ranges');
  });
});
