import { describe, expect, it } from 'vitest';

import { fenceGrammarOf, fenceLanguageOf, MERMAID_LANGUAGE } from '../../src/lib/fenceGrammar';

describe('fence language', () => {
  it('reads the language out of the class react-markdown writes', () => {
    expect(fenceLanguageOf('language-TSX')).toBe('tsx');
    expect(fenceLanguageOf('hljs language-python')).toBe('python');
    expect(fenceLanguageOf(undefined)).toBeUndefined();
    expect(fenceLanguageOf('')).toBeUndefined();
  });

  it('resolves the spellings a person writes on a fence', () => {
    expect(fenceGrammarOf('ts')).toBe('typescript');
    expect(fenceGrammarOf('typescript')).toBe('typescript');
    expect(fenceGrammarOf('bash')).toBe('shell');
    expect(fenceGrammarOf('shell')).toBe('shell');
    expect(fenceGrammarOf('yml')).toBe('yaml');
    expect(fenceGrammarOf('dockerfile')).toBe('dockerfile');
  });

  it('leaves an unknown or absent language plain rather than guessing', () => {
    expect(fenceGrammarOf(undefined)).toBeUndefined();
    expect(fenceGrammarOf('')).toBeUndefined();
    expect(fenceGrammarOf('rust')).toBeUndefined();
    expect(fenceGrammarOf(MERMAID_LANGUAGE)).toBeUndefined();
  });
});
