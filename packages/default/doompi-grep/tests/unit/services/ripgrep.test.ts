import { describe, expect, it } from 'vitest';

import { argumentsFor, limitMatches } from '../../../src/services/ripgrep';

describe('argumentsFor', () => {
  it('always asks ripgrep for parseable output', () => {
    expect(argumentsFor({ pattern: 'needle' }, '/repo')).toEqual([
      '--color',
      'never',
      '--no-heading',
      '--with-filename',
      '--line-number',
      '--',
      'needle',
      '.',
    ]);
  });

  it('adds a flag only for the options the caller set', () => {
    const args = argumentsFor(
      { pattern: 'needle', ignoreCase: true, literal: true, context: 2, glob: '*.ts', path: 'src' },
      '/repo',
    );
    expect(args).toContain('--ignore-case');
    expect(args).toContain('--fixed-strings');
    expect(args.slice(args.indexOf('--context'), args.indexOf('--context') + 2)).toEqual(['--context', '2']);
    expect(args.slice(args.indexOf('--glob'), args.indexOf('--glob') + 2)).toEqual(['--glob', '*.ts']);
    // The pattern is last but one so a leading dash cannot be read as a flag.
    expect(args.slice(-3)).toEqual(['--', 'needle', 'src']);
  });

  it('never leaves the target empty, which ripgrep would read as stdin', () => {
    expect(argumentsFor({ pattern: 'needle', path: '.' }, '/repo').at(-1)).toBe('.');
  });
});

describe('limitMatches', () => {
  const output = ['a.ts:1:one', 'a.ts-2-context', 'b.ts:3:two', 'c.ts:4:three'].join('\n');

  it('returns everything when no limit is asked for', () => {
    expect(limitMatches(output, undefined)).toBe(output);
  });

  it('counts matches, not lines, and keeps the context around the ones it kept', () => {
    // The context line carries no :<line>: marker, so it is not a match and
    // must survive a limit that the match after it does not.
    expect(limitMatches(output, 2)).toBe(['a.ts:1:one', 'a.ts-2-context', 'b.ts:3:two'].join('\n'));
  });

  it('drops every match at a limit of zero but still returns context', () => {
    expect(limitMatches(output, 0)).toBe('a.ts-2-context');
  });

  it('trims the trailing newline ripgrep leaves behind', () => {
    expect(limitMatches('a.ts:1:one\n', 5)).toBe('a.ts:1:one');
  });
});
