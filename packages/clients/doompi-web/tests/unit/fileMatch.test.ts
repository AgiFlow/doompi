import { describe, expect, it } from 'vitest';
import { rankFileMatches } from '../../src/services/fileMatch.ts';

const FILES = [
  'src/web/features/session/Composer.tsx',
  'src/adapters/httpServer.ts',
  'tests/e2e/composer.spec.ts',
  'README.md',
  'src/services/sessionPresence.ts',
];

describe('rankFileMatches', () => {
  it('ranks basename prefix over basename substring over path substring', () => {
    expect(rankFileMatches(FILES, 'comp', 10)).toEqual([
      'tests/e2e/composer.spec.ts',
      'src/web/features/session/Composer.tsx',
    ]);
    expect(rankFileMatches(FILES, 'session', 10)).toEqual([
      'src/services/sessionPresence.ts',
      'src/web/features/session/Composer.tsx',
    ]);
  });

  it('is case-insensitive, respects the limit, and lists everything for an empty query', () => {
    expect(rankFileMatches(FILES, 'READ', 10)).toEqual(['README.md']);
    expect(rankFileMatches(FILES, '', 2)).toHaveLength(2);
    expect(rankFileMatches(FILES, 'nope', 10)).toEqual([]);
  });

  it('ranks a folder by its own name, not by the empty segment after its slash', () => {
    const paths = ['src/services/sessionPresence.ts', 'src/services/', 'notes/about-services.md'];
    // 'services/' would rank last on a path substring if the trailing slash
    // were left on, because its basename would be empty.
    expect(rankFileMatches(paths, 'services', 10)).toEqual([
      'src/services/',
      'notes/about-services.md',
      'src/services/sessionPresence.ts',
    ]);
  });
});
