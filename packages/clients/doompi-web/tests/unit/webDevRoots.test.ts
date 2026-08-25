import { describe, expect, it } from 'vitest';
import { devPluginRoots } from '../../src/services/webDevRoots.ts';

describe('devPluginRoots', () => {
  it('prefers the environment list, trimmed and split on the platform delimiter', () => {
    expect(devPluginRoots({ envValue: ' /a : /b :: ', rootsFileText: '["/synced"]', delimiter: ':' })).toEqual([
      '/a',
      '/b',
    ]);
    expect(devPluginRoots({ envValue: 'C:\\a;C:\\b', rootsFileText: undefined, delimiter: ';' })).toEqual([
      'C:\\a',
      'C:\\b',
    ]);
  });

  it('falls back to the roots file the last sync wrote, keeping only strings', () => {
    expect(devPluginRoots({ envValue: undefined, rootsFileText: '["/x", 1, "/y"]', delimiter: ':' })).toEqual([
      '/x',
      '/y',
    ]);
    expect(devPluginRoots({ envValue: '  ', rootsFileText: '["/x"]', delimiter: ':' })).toEqual(['/x']);
  });

  it('serves no plugins without either source or with an unreadable file', () => {
    expect(devPluginRoots({ envValue: undefined, rootsFileText: undefined, delimiter: ':' })).toEqual([]);
    expect(devPluginRoots({ envValue: undefined, rootsFileText: 'not json', delimiter: ':' })).toEqual([]);
    expect(devPluginRoots({ envValue: undefined, rootsFileText: '{"a":1}', delimiter: ':' })).toEqual([]);
  });
});
