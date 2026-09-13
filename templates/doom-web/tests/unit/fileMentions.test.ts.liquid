import { describe, expect, it } from 'vitest';
import { sessionFileUrl } from '../../src/types/media.ts';
import { mediaKindFor, parseFileMentions } from '../../src/web/lib/fileMentions.ts';

describe('parseFileMentions', () => {
  it('finds @ tokens at the start and after whitespace, once each', () => {
    expect(parseFileMentions('@docs/a.svg this and @docs/a.svg again\n@notes/b.md')).toEqual([
      { path: 'docs/a.svg', kind: 'image' },
      { path: 'notes/b.md', kind: 'file' },
    ]);
  });

  it('ignores an @ inside a word, such as an email address', () => {
    expect(parseFileMentions('mail me@example.com about it')).toEqual([]);
  });

  it('sheds the punctuation a sentence hangs on a path', () => {
    expect(parseFileMentions('look at @clip.mp4, then @deck.pdf.')).toEqual([
      { path: 'clip.mp4', kind: 'video' },
      { path: 'deck.pdf', kind: 'pdf' },
    ]);
  });

  it('drops a bare @ with nothing after it', () => {
    expect(parseFileMentions('ping @ someone')).toEqual([]);
  });
});

describe('mediaKindFor', () => {
  it('classifies by extension regardless of case, and falls back to a plain file', () => {
    expect(mediaKindFor('A.PNG')).toBe('image');
    expect(mediaKindFor('a.webm')).toBe('video');
    expect(mediaKindFor('Makefile')).toBe('file');
    expect(mediaKindFor('src/x.ts')).toBe('file');
  });

  it('reads a trailing slash as a directory, whatever the last segment looks like', () => {
    expect(mediaKindFor('packages/clients/doompi-web/')).toBe('directory');
    expect(mediaKindFor('assets/logo.png/')).toBe('directory');
    expect(parseFileMentions('check @packages/clients/doompi-web/ and @src/a.ts')).toEqual([
      { path: 'packages/clients/doompi-web/', kind: 'directory' },
      { path: 'src/a.ts', kind: 'file' },
    ]);
  });
});

describe('sessionFileUrl', () => {
  it('encodes both the session and the path', () => {
    expect(sessionFileUrl('s 1', 'docs/a b.svg')).toBe('/api/sessions/s%201/file?path=docs%2Fa%20b.svg');
  });
});
