import { describe, expect, it } from 'vitest';

import { abbreviateCwd, formatRunDuration } from '../../src/web/lib/format';

describe('the run duration the cockpit prints', () => {
  it('collapses anything under a minute rather than printing seconds', () => {
    expect(formatRunDuration(0)).toBe('<1m');
    expect(formatRunDuration(59_999)).toBe('<1m');
  });

  it('counts whole minutes up to the hour', () => {
    expect(formatRunDuration(60_000)).toBe('1m');
    expect(formatRunDuration(59 * 60_000 + 59_999)).toBe('59m');
  });

  it('pads the minute part once the run reaches an hour, so the column stays aligned', () => {
    expect(formatRunDuration(3_600_000)).toBe('1h 00m');
    expect(formatRunDuration(3_600_000 + 5 * 60_000)).toBe('1h 05m');
    expect(formatRunDuration(25 * 3_600_000 + 42 * 60_000)).toBe('25h 42m');
  });
});

describe('the working directory the cockpit prints', () => {
  it('replaces a home prefix with a tilde on both macOS and Linux layouts', () => {
    expect(abbreviateCwd('/Users/ada/src/doompi')).toBe('~/src/doompi');
    expect(abbreviateCwd('/home/ada/src/doompi')).toBe('~/src/doompi');
  });

  it('leaves the home directory itself as a bare tilde', () => {
    expect(abbreviateCwd('/Users/ada')).toBe('~');
  });

  it('leaves a path outside any home directory alone', () => {
    expect(abbreviateCwd('/var/tmp/build')).toBe('/var/tmp/build');
    expect(abbreviateCwd('relative/path')).toBe('relative/path');
  });
});
