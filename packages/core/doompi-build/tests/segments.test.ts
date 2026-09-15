import { describe, expect, it } from 'vitest';

import { classifySegment } from '../src/services/segments';

describe('classifySegment', () => {
  it('reads a parenthesised name as a group', () => {
    expect(classifySegment('(backend)')).toEqual({ kind: 'group', name: 'backend' });
    expect(classifySegment('(admin)')).toEqual({ kind: 'group', name: 'admin' });
  });

  it('reads an underscored name as private', () => {
    expect(classifySegment('_components')).toEqual({ kind: 'private', name: 'components' });
  });

  it('reads a bracketed name as a dynamic segment', () => {
    expect(classifySegment('[runId]')).toEqual({ kind: 'dynamic', param: { name: 'runId', catchAll: false } });
  });

  it('reads a spread-bracketed name as catch-all', () => {
    expect(classifySegment('[...path]')).toEqual({ kind: 'dynamic', param: { name: 'path', catchAll: true } });
  });

  it('reads anything else as plain', () => {
    for (const name of ['tool', 'workspaces', 'sessions', 'api']) {
      expect(classifySegment(name)).toEqual({ kind: 'plain', name });
    }
  });

  it('does not mistake empty delimiters for a group or a segment', () => {
    expect(classifySegment('()')).toEqual({ kind: 'plain', name: '()' });
    expect(classifySegment('[]')).toEqual({ kind: 'plain', name: '[]' });
  });

  it('prefers private over any other reading, so a private folder is never scanned', () => {
    expect(classifySegment('_(backend)')).toEqual({ kind: 'private', name: '(backend)' });
  });
});
