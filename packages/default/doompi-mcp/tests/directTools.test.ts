import { describe, expect, it } from 'vitest';
import { readDirectToolFilter } from '../src/adapters/process/directToolsEnvironment.ts';
import { DIRECT_TOOLS_ENV, NO_DIRECT_TOOLS } from '../src/schemas/directTools.ts';
import { DirectToolFilter } from '../src/services/directTools.ts';

describe('DirectToolFilter', () => {
  it('allows every tool of a server selected whole', () => {
    const filter = new DirectToolFilter(['pencil']);

    expect(filter.allows('pencil', 'get_screenshot')).toBe(true);
    expect(filter.allows('pencil', 'export_html')).toBe(true);
  });

  it('allows only the named tool when one is selected', () => {
    const filter = new DirectToolFilter(['pencil/get_screenshot']);

    expect(filter.allows('pencil', 'get_screenshot')).toBe(true);
    expect(filter.allows('pencil', 'export_html')).toBe(false);
  });

  it('refuses a server that was not selected at all', () => {
    expect(new DirectToolFilter(['pencil']).allows('boomlink', 'search')).toBe(false);
  });

  it('combines whole-server and per-tool selectors', () => {
    const filter = new DirectToolFilter(['pencil', 'boomlink/search']);

    expect(filter.allows('pencil', 'anything')).toBe(true);
    expect(filter.allows('boomlink', 'search')).toBe(true);
    expect(filter.allows('boomlink', 'admin')).toBe(false);
  });

  it('treats a trailing slash as selecting the whole server', () => {
    expect(new DirectToolFilter(['pencil/']).allows('pencil', 'get_screenshot')).toBe(true);
  });

  it('keeps a tool name that itself contains a slash with its server', () => {
    expect(new DirectToolFilter(['files/read/all']).allows('files', 'read/all')).toBe(true);
  });

  it('ignores empty selectors and surrounding whitespace', () => {
    const filter = new DirectToolFilter([' pencil ', '', '   ']);

    expect(filter.allows('pencil', 'get_screenshot')).toBe(true);
  });

  it('allows nothing when no selector was given', () => {
    expect(new DirectToolFilter([]).allows('pencil', 'get_screenshot')).toBe(false);
  });
});

describe('readDirectToolFilter', () => {
  // A normal session is not a restricted child and gets everything configured.
  it('reports no filter when the variable is unset', () => {
    expect(readDirectToolFilter({})).toBeUndefined();
    expect(readDirectToolFilter({ [DIRECT_TOOLS_ENV]: '' })).toBeUndefined();
  });

  it('reads a comma-separated selector list', () => {
    const filter = readDirectToolFilter({ [DIRECT_TOOLS_ENV]: 'pencil,boomlink/search' });

    expect(filter?.allows('pencil', 'anything')).toBe(true);
    expect(filter?.allows('boomlink', 'search')).toBe(true);
    expect(filter?.allows('boomlink', 'admin')).toBe(false);
  });

  // Distinct from unset: the launcher resolved nothing, so the child gets nothing.
  it('honours the explicit none sentinel', () => {
    const filter = readDirectToolFilter({ [DIRECT_TOOLS_ENV]: NO_DIRECT_TOOLS });

    expect(filter).toBeDefined();
    expect(filter?.allows('pencil', 'get_screenshot')).toBe(false);
  });
});
