import { describe, expect, it } from 'vitest';
import { detectGrammar, highlightToLines, type SyntaxSpan, syntaxStyleOf } from '../../src/lib/syntaxHighlight.ts';

/** The text of a highlighted line, so a case can assert the split without the styles. */
function textOf(spans: readonly SyntaxSpan[]): string {
  return spans.map((span) => span.text).join('');
}

function tokensOf(spans: readonly SyntaxSpan[]): string[] {
  return spans.filter((span) => span.token !== undefined).map((span) => `${String(span.token)}:${span.text}`);
}

describe('detectGrammar', () => {
  it('prefers the path, because a name is evidence and a body is a guess', () => {
    expect(detectGrammar({ path: 'src/a.ts', text: '{"a":1}' })).toBe('typescript');
    expect(detectGrammar({ path: 'Dockerfile' })).toBe('dockerfile');
  });

  it('sniffs a shebang when the path settles nothing', () => {
    expect(detectGrammar({ text: '#!/usr/bin/env bash\necho hi\n' })).toBe('shell');
    expect(detectGrammar({ text: '#!/usr/bin/python3\nprint(1)\n' })).toBe('python');
    expect(detectGrammar({ text: '#!/usr/bin/env node\nconsole.log(1)\n' })).toBe('javascript');
    // A shebang naming something with no grammar here is still a script.
    expect(detectGrammar({ text: '#!/usr/bin/env perl\nprint 1;\n' })).toBe('shell');
  });

  it('sniffs a JSON document by its shape', () => {
    expect(detectGrammar({ text: '{\n  "a": 1\n}\n' })).toBe('json');
    expect(detectGrammar({ text: '[1, 2, 3]' })).toBe('json');
  });

  it('leaves anything it cannot name plain rather than guessing wrong', () => {
    expect(detectGrammar({})).toBeUndefined();
    expect(detectGrammar({ text: '' })).toBeUndefined();
    expect(detectGrammar({ path: 'notes.unknownext', text: 'plain prose' })).toBeUndefined();
    expect(detectGrammar({ text: 'Tests 11 passed (11)' })).toBeUndefined();
  });
});

describe('highlightToLines', () => {
  it('splits a parsed file into lines of spans that rebuild the source', async () => {
    const source = 'const x = 1;\n// note\nexport { x };\n';
    const lines = await highlightToLines(source, 'typescript');
    expect(lines).toBeDefined();
    expect((lines ?? []).map(textOf).join('\n')).toBe(source);
  });

  it('names tokens from the editor palette', async () => {
    const lines = (await highlightToLines('const x = 1;\n// note\n', 'typescript')) ?? [];
    expect(tokensOf(lines[0] ?? [])).toContain('keyword:const');
    expect(tokensOf(lines[0] ?? [])).toContain('literal:1');
    expect(tokensOf(lines[1] ?? [])).toContain('comment:// note');
  });

  it('highlights a legacy stream grammar the same way', async () => {
    const lines = (await highlightToLines('# comment\necho "hi"\n', 'shell')) ?? [];
    expect(tokensOf(lines[0] ?? [])).toContain('comment:# comment');
    expect(tokensOf(lines[1] ?? []).join(' ')).toContain('string:"hi"');
  });

  it('returns nothing for empty text, so the caller keeps its plain render', async () => {
    await expect(highlightToLines('', 'json')).resolves.toBeUndefined();
  });

  it('returns nothing past the size cap rather than blocking the frame', async () => {
    await expect(highlightToLines('a'.repeat(200_001), 'json')).resolves.toBeUndefined();
  });
});

describe('syntaxStyleOf', () => {
  it('answers with the editor palette, and with nothing for an unstyled span', () => {
    expect(syntaxStyleOf('keyword')).toEqual({ color: 'var(--doom-magenta)' });
    expect(syntaxStyleOf(undefined)).toBeUndefined();
  });
});
