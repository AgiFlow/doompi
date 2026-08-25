// @scaffold-generated
import { describe, expect, it } from 'vitest';
import { resolveRegistryDir, sessionRecordPath, sessionRecordsDir } from '../../../src/services/registryPaths.ts';

describe('resolveRegistryDir', () => {
  it('prefers the flag over the environment and the default', () => {
    expect(resolveRegistryDir({ flagValue: '/custom/run', envValue: '/env/run', homeDir: '/Users/dev' })).toBe(
      '/custom/run',
    );
  });

  it('falls back to the environment variable', () => {
    expect(resolveRegistryDir({ envValue: '/env/run', homeDir: '/Users/dev' })).toBe('/env/run');
  });

  it('defaults to the run directory under the home directory', () => {
    expect(resolveRegistryDir({ homeDir: '/Users/dev' })).toBe('/Users/dev/.doompi/run');
  });
});

describe('session record paths', () => {
  it('places records under the sessions directory keyed by id', () => {
    expect(sessionRecordsDir('/Users/dev/.doompi/run')).toBe('/Users/dev/.doompi/run/sessions');
    expect(sessionRecordPath('/Users/dev/.doompi/run', 'a1b2')).toBe('/Users/dev/.doompi/run/sessions/a1b2.json');
  });
});
